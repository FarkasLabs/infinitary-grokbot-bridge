import { spawn, execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { ackNote, answerCard, replyToCard, sayToFirstMate } from "./act.js";
import { daemonAlive, runDaemon, statusPath } from "./daemon.js";
import { HomeLink, openActLink } from "./home.js";
import { cardPage } from "./page.js";
import { pair } from "./pair.js";
import { grantPath, hasGrant, isEnabled, readJson, setEnabled, stateDir } from "./state.js";
import { cardMessage, chunk, kindOf } from "./text.js";

const run = promisify(execFile);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const USAGE = `grokbot-bridge <command>
  on | off | status       the switch (persistent); off holds no connection and sends nothing
  cards                   list the cards Infinitary shows now, with each task's key and read / put-aside marks
  show <card-id>          one card whole, as text, with its thread
  page <card-id> [--out file]   one card as a self-contained page in Infinitary's look
  answer <card-id> <button-id> --offer O --lifecycle L --request R [--confirm]
                          press a button of the card's current offer; JSON {"answers":[{name,values,written}]} on stdin
  reply <card-id> --offer O --lifecycle L --request R [--wait s]
                          reply in the card's thread (text on stdin); prints any answer that arrives
  ack <card-id> --offer O --lifecycle L --request R
                          acknowledge (close) a note that needs no answer; only when the user picked Acknowledge for that note
  say --request R [--wait s]       message the first mate (text on stdin); prints its answer
  last                    the first mate's latest answer
  pair                    pair once with this computer's Infinitary (reads a link from stdin,
                          or runs 'infinitary link --json' with --from-infinitary)
  unpair                  forget the local key (also remove the device in Settings -> Devices)
  run                     the background part (started by 'on' when it is not running)
answer, reply, ack and say act as you and need the switch on. --request is a fresh id (8-64 of A-Za-z0-9_-);
the same id sent again does nothing twice. A merge, discard or kept write also needs --confirm.`;

const FLAGS = {
  offer: { type: "string" }, lifecycle: { type: "string" }, request: { type: "string" },
  confirm: { type: "boolean" }, wait: { type: "string" },
};

async function readAll(stream) {
  if (stream.isTTY) return "";
  let text = "";
  for await (const piece of stream) text += piece;
  return text;
}

async function withActHome(dir, fn) {
  if (!hasGrant(dir)) throw new Error("Not paired. Run: grokbot-bridge pair");
  if (!isEnabled(dir)) throw new Error("The bridge is off. Run: grokbot-bridge on");
  const link = await openActLink(readJson(grantPath(dir), null));
  try {
    return await fn(link);
  } finally {
    link.close();
  }
}

const waitMs = (v, fallback) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 300) throw new Error("--wait is seconds, 0 to 300.");
  return n * 1000;
};
const pollMs = (env) => Number(env.GROKBOT_BRIDGE_POLL_MS) || 2000;

async function withHome(dir, fn) {
  if (!hasGrant(dir)) throw new Error("Not paired. Run: grokbot-bridge pair");
  if (!isEnabled(dir)) throw new Error("The bridge is off. Run: grokbot-bridge on");
  const link = new HomeLink(readJson(grantPath(dir), null));
  try {
    await link.open();
    return await fn(link);
  } finally {
    link.close();
  }
}

/** Each card's task key, read once per task; a task that cannot be read simply has no key shown. */
async function taskKeys(link, cards) {
  const ids = [...new Set(cards.map((c) => c.taskId).filter((id) => typeof id === "string" && ID.test(id)))];
  const keys = new Map();
  await Promise.all(ids.map(async (id) => {
    try {
      const key = (await link.invoke("inf:tasks:detail", [id]))?.key;
      if (typeof key === "string" && key) keys.set(id, key);
    } catch {}
  }));
  return keys;
}

async function cardById(link, id) {
  if (!ID.test(id ?? "")) throw new Error("Give a card id, as 'cards' lists them.");
  const card = (await link.invoke("inf:cards:list", [])).find((c) => c.id === id);
  if (!card) throw new Error(`No card ${id} is showing.`);
  return card;
}

const threadOf = async (link, id) => {
  try {
    return (await link.invoke("inf:cards:thread", [id])).messages ?? [];
  } catch {
    return [];
  }
};

/**
 * A reused request id prints its saved result and sends nothing, so a saved refusal must not read as a new one
 * that waiting could cure. An unclear saved outcome is not called a refusal.
 */
const replayNote = (r, id) =>
  r.replayed ? ` (request ${id} was already ${r.unclear ? "sent and its outcome is unclear" : "refused"}; nothing was sent again)` : "";

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), env = process.env, stdin = process.stdin } = {}) {
  const dir = stateDir(env);
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "on": {
      if (!hasGrant(dir)) throw new Error("Not paired yet. Run: grokbot-bridge pair");
      setEnabled(dir, true);
      if (!daemonAlive(dir)) {
        const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/grokbot-bridge.js", import.meta.url)), "run"],
          { detached: true, stdio: "ignore", env });
        child.unref();
      }
      return out("Grok bot bridge is on.");
    }
    case "off":
      setEnabled(dir, false);
      return out("Grok bot bridge is off. It holds no connection to Infinitary and sends nothing.");
    case "status": {
      const s = readJson(statusPath(dir), {});
      const alive = daemonAlive(dir);
      return out(JSON.stringify({ enabled: isEnabled(dir), paired: hasGrant(dir), running: Boolean(alive), connected: Boolean(s.connected) && Boolean(alive), cards: s.cards ?? null }));
    }
    case "cards":
      return withHome(dir, async (link) => {
        const cards = await link.invoke("inf:cards:list", []);
        if (!cards.length) return out("No cards are showing.");
        const keys = await taskKeys(link, cards);
        for (const c of cards) {
          const marks = [c.actions?.length ? "" : "no answer needed", c.seen ? "read" : "", c.minimized ? "put aside" : ""].filter(Boolean);
          const key = keys.get(c.taskId);
          out(`${c.id}${key ? `\t${key}` : ""}\t${kindOf(c)}${marks.length ? ` (${marks.join(", ")})` : ""}\t${c.title}`);
        }
      });
    case "show":
      return withHome(dir, async (link) => {
        const card = await cardById(link, rest[0]);
        out(cardMessage(card, { replies: await threadOf(link, card.id) }));
      });
    case "page":
      return withHome(dir, async (link) => {
        const card = await cardById(link, rest[0]);
        const pictures = {};
        for (const p of card.pictures ?? []) {
          try {
            const r = await link.invoke("inf:cards:picture", [p.id]);
            pictures[p.id] = `data:${r.contentType};base64,${r.data}`;
          } catch {}
        }
        const html = cardPage(card, { thread: await threadOf(link, card.id), pictures });
        const at = rest.indexOf("--out");
        if (at > 0 && rest[at + 1]) {
          writeFileSync(rest[at + 1], html);
          return out(`Wrote ${rest[at + 1]}`);
        }
        out(html);
      });
    case "answer": {
      const { values, positionals } = parseArgs({ args: rest, options: FLAGS, allowPositionals: true });
      const raw = (await readAll(stdin)).trim();
      let answers;
      if (raw) {
        try {
          answers = JSON.parse(raw).answers;
        } catch {
          throw new Error('stdin must be JSON like {"answers":[{"name":"q","values":["a"]}]}.');
        }
        if (answers === undefined) throw new Error('stdin JSON needs an "answers" list.');
      }
      return withActHome(dir, async (link) => {
        const r = await answerCard(link, dir, {
          cardId: positionals[0], actionId: positionals[1], offerId: values.offer, lifecycleId: values.lifecycle,
          requestId: values.request, answers, confirm: values.confirm,
        });
        if (!r.ok) {
          const again = r.replayed && !r.unclear ? " To press again, use a new --request id." : "";
          return out(`Infinitary did not take it${replayNote(r, values.request)}: ${r.refusal}${again}`);
        }
        out(`${r.replayed ? "Already done: " : ""}Pressed "${r.label}" on card ${positionals[0]}.`);
      });
    }
    case "reply": {
      const { values, positionals } = parseArgs({ args: rest, options: FLAGS, allowPositionals: true });
      const text = (await readAll(stdin)).trim();
      return withActHome(dir, async (link) => {
        const r = await replyToCard(link, dir, {
          cardId: positionals[0], offerId: values.offer, lifecycleId: values.lifecycle, requestId: values.request,
          text, waitMs: waitMs(values.wait, 60000), pollMs: pollMs(env),
        });
        out(`${r.replayed ? "Already sent. " : "Reply sent. "}${r.answers.length ? "" : "No answer yet; 'show' reads the thread."}`.trim());
        for (const a of r.answers) out(`${a.who}: ${a.text}`);
      });
    }
    case "ack": {
      const { values, positionals } = parseArgs({ args: rest, options: FLAGS, allowPositionals: true });
      return withActHome(dir, async (link) => {
        const r = await ackNote(link, dir, { cardId: positionals[0], offerId: values.offer, lifecycleId: values.lifecycle, requestId: values.request });
        if (!r.ok) return out(`Not acknowledged${replayNote(r, values.request)}: ${r.refusal}`);
        out(`${r.replayed ? "Already done: " : ""}Acknowledged note ${positionals[0]}; Infinitary closed it.`);
      });
    }
    case "say": {
      const { values } = parseArgs({ args: rest, options: FLAGS });
      const text = (await readAll(stdin)).trim();
      return withActHome(dir, async (link) => {
        const r = await sayToFirstMate(link, dir, { requestId: values.request, text, waitMs: waitMs(values.wait, 90000), pollMs: pollMs(env) });
        out(`${r.replayed ? "Already sent. " : "Sent. "}${r.reply ? "" : "No answer yet; 'last' reads it later."}`.trim());
        if (r.reply) out(`First mate: ${r.reply.text}`);
      });
    }
    case "last":
      return withHome(dir, async (link) => {
        const turn = await link.invoke("inf:conversation:last-turn", []);
        out(turn?.reply ? `You: ${turn.you}\nFirst mate: ${turn.reply.text}` : turn ? `You: ${turn.you}\nNo answer yet.` : "No conversation yet.");
      });
    case "pair": {
      let text = "";
      if (rest.includes("--from-infinitary")) {
        const { stdout } = await run("infinitary", ["link", "--json"]);
        text = JSON.parse(stdout).link;
      } else for await (const chunk of process.stdin) text += chunk;
      const r = await pair(text, dir);
      return out(`Paired as ${r.kind} (${r.deviceId}). Run: grokbot-bridge on`);
    }
    case "unpair":
      setEnabled(dir, false);
      rmSync(grantPath(dir), { force: true });
      return out("Local key removed. Also remove the device in Infinitary: Settings -> Devices.");
    case "run": {
      await runDaemon(dir);
      return new Promise(() => {});
    }
    default:
      out(USAGE);
      return cmd ? Promise.reject(Object.assign(new Error(`Unknown command: ${cmd}`), { quiet: true })) : undefined;
  }
}

export { chunk };
