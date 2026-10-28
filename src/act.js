import { checkAnswers } from "./questions.js";
import { answersPrint, claim, finish, fingerprint, mark, textPrint } from "./requests.js";

const CARD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const IDENT = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_REPLY = 4000;
export const MAX_SAY = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long one request may take on the link (HomeLink's own timeout), for sizing a command's deadline. */
const REQUEST_MS = 20000;
/** Kept between a command's last step and its deadline, to write the outcome. */
const GRACE_MS = 2000;
/** The hold a command claims: `steps` requests on the link after the claim, its wait, and the grace. */
const holdFor = (steps, waitMs = 0) => steps * REQUEST_MS + waitMs + GRACE_MS;

/**
 * Requests after a claim, cut off before the record's deadline (`until`). The relay waits for a running command exactly
 * until then and then decides on what the record says, so a command never learns, confirms or prints anything later.
 */
function bounded(link, until) {
  const stop = until - GRACE_MS;
  const call = (channel, args) => {
    let timer;
    const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${channel} timed out.`)), Math.max(0, stop - Date.now()))));
    return Promise.race([link.invoke(channel, args), late]).finally(() => clearTimeout(timer));
  };
  return { stop, call };
}

/** What pressing a button does, in words, and whether it needs --confirm. */
export function effectOf(action) {
  const e = action.effect;
  if (!e) return { kind: "plain", needsConfirm: false };
  if (e.kind === "settle") return { kind: e.mode, needsConfirm: true };
  if (e.kind === "request_merge") return { kind: "merge", needsConfirm: true };
  if (e.kind === "request_write") return { kind: "write", needsConfirm: true };
  if (e.kind === "open") return { kind: "open", needsConfirm: false, impossible: true };
  return { kind: e.kind, needsConfirm: action.variant === "danger" || action.danger === true };
}

function currentCard(cards, { cardId, offerId, lifecycleId }) {
  if (!CARD_ID.test(cardId ?? "")) throw new Error("Give a card id, as 'cards' lists them.");
  if (!IDENT.test(offerId ?? "") || !IDENT.test(lifecycleId ?? "")) {
    throw new Error("Name the card's current offer and lifecycle: --offer and --lifecycle, as 'show' prints them.");
  }
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Card ${cardId} is no longer showing.`);
  if (card.lifecycleId !== lifecycleId || card.offerId !== offerId) {
    throw new Error(`Card ${cardId} has changed since you read it (now offer ${card.offerId}). Read it again with 'show' before answering.`);
  }
  if (card.status !== "ready") throw new Error(`Card ${cardId} is not ready to be answered (${card.status}).`);
  return card;
}

/** Presses one button of the card's current offer, with the answers to its questions. */
export async function answerCard(link, dir, opts) {
  const { cardId, actionId, offerId, lifecycleId, requestId, answers, confirm } = opts;
  if (!IDENT.test(actionId ?? "")) throw new Error("Give a button id, as 'show' lists them in brackets.");
  const print = fingerprint(["answer", cardId, actionId, offerId, lifecycleId, answers ?? [], Boolean(confirm)]);
  const prior = claim(dir, requestId, print, { create: false });
  if (!prior.fresh) return { ...prior.result, replayed: true };

  const card = currentCard(await link.invoke("inf:cards:list", []), opts);
  const action = card.actions?.find((a) => a.id === actionId);
  if (!action) throw new Error(`Card ${cardId} has no button ${actionId}.`);
  const effect = effectOf(action);
  if (effect.impossible) throw new Error(`"${action.label}" opens a page in Infinitary itself (settings, a sign-in or the browser). That needs your computer.`);
  if (effect.needsConfirm && !confirm) {
    throw new Error(`"${action.label}" will ${effect.kind === "write" ? "send a kept write" : effect.kind}. Say so explicitly by adding --confirm.`);
  }
  const checked = checkAnswers(card, answers);

  // The press, then the list and the ending that confirm it.
  const acquired = claim(dir, requestId, print, { subject: { kind: "answer", cardId, lifecycleId, offerId, actionId, answersFp: answersPrint(checked) }, holdMs: holdFor(3) });
  if (!acquired.fresh) return { ...acquired.result, replayed: true };
  const { path } = acquired;
  const { call } = bounded(link, acquired.until);
  const submission = { id: requestId, lifecycleId, offerId, reading: "none" };
  let reply;
  try {
    reply = await call("inf:cards:act", [cardId, actionId, "chrome", checked.length ? { answers: checked } : null, submission]);
  } catch (e) {
    mark(path, { outcome: "unknown" });
    throw e;
  }
  let result;
  if (reply?.refusal) result = { ok: false, refusal: String(reply.refusal), label: action.label };
  else {
    // Infinitary answers {} to a press on a card it no longer shows, so the press is confirmed by how the card ended.
    result = await confirmPress(call, card, action, checked);
    result.label = action.label;
    result.kind = effect.kind;
  }
  finish(path, result, { outcome: result.ok ? "accepted" : result.unclear ? "unknown" : "refused" });
  return result;
}

async function confirmPress(call, card, action, checked) {
  const still = (await call("inf:cards:list", [])).find((c) => c.id === card.id && c.lifecycleId === card.lifecycleId);
  if (still) return { ok: false, refusal: "Infinitary still shows the card, so it did not take the press." };
  let past;
  try {
    past = await call("inf:cards:past", [card.id]);
  } catch {}
  const end = past?.ending;
  if (!end) return { ok: false, unclear: true, refusal: "Infinitary did not confirm how the card ended. The press may or may not have counted; read the card before deciding what to do next." };
  if (end.how === "chose" && end.actionId === action.id && answersPrint(past.answers) === answersPrint(checked)) return { ok: true };
  const how = end.how === "chose" ? `"${end.label ?? end.actionId}" was chosen` : `it ended (${end.how})`;
  return { ok: false, refusal: `The card had already ended in Infinitary before this press: ${how}. Your press changed nothing.` };
}

/** Whether the captain's own stage shows the card (Infinitary's onStage, src/shared/cards.ts). */
const onStage = (card) => card.awaiting === undefined || card.sentBackAt !== undefined;

/**
 * Acknowledges one note: Infinitary's own close (the captain's ×) on the exact version read.
 * Only a note - no buttons, no required actions - that is ready and on the stage.
 * The home records the offer and lifecycle on a close but does not enforce them, so the read
 * just before the close is the only guard: a note revised in between would still be closed.
 */
export async function ackNote(link, dir, opts) {
  const { cardId, offerId, lifecycleId, requestId } = opts;
  const print = fingerprint(["ack", cardId, offerId, lifecycleId]);
  const prior = claim(dir, requestId, print, { create: false });
  if (!prior.fresh) return { ...prior.result, replayed: true };

  const card = currentCard(await link.invoke("inf:cards:list", []), opts);
  if (card.actions?.length) throw new Error(`Card ${cardId} has buttons, so it is not a note. Answer it with 'answer' instead.`);
  if (card.requiredActions?.length) throw new Error(`Note ${cardId} lists required actions. Close it in Infinitary itself.`);
  if (!onStage(card)) throw new Error(`Note ${cardId} is still with its author (${card.awaiting}). Acknowledge it once Infinitary shows it.`);

  // The close, then the list that confirms it.
  const acquired = claim(dir, requestId, print, { subject: { kind: "ack", cardId, lifecycleId, offerId }, holdMs: holdFor(2) });
  if (!acquired.fresh) return { ...acquired.result, replayed: true };
  const { path } = acquired;
  const { call } = bounded(link, acquired.until);
  let result;
  try {
    await call("inf:cards:close", [cardId, { id: requestId, lifecycleId, offerId }]);
    const after = (await call("inf:cards:list", [])).find((c) => c.id === cardId && c.lifecycleId === lifecycleId);
    result = after ? { ok: false, refusal: "Infinitary still shows the note." } : { ok: true, title: card.title };
  } catch (e) {
    mark(path, { outcome: "unknown" });
    throw e;
  }
  finish(path, result, { outcome: result.ok ? "accepted" : "refused" });
  return result;
}

/** The newest message id in a thread, so only later ones are news. */
const newest = (messages) => messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);

/** A reply in a card's thread, then (for a while) what the first mate or the crewmate answers. */
export async function replyToCard(link, dir, opts) {
  const { cardId, offerId, lifecycleId, requestId, text, waitMs = 60000, pollMs = 2000 } = opts;
  if (typeof text !== "string" || !text.trim()) throw new Error("Give the reply on stdin.");
  if (text.length > MAX_REPLY) throw new Error(`A reply is at most ${MAX_REPLY} characters.`);
  const print = fingerprint(["reply", cardId, offerId, lifecycleId, text]);
  const prior = claim(dir, requestId, print, { create: false });
  if (!prior.fresh) return { ...prior.result, replayed: true };

  currentCard(await link.invoke("inf:cards:list", []), opts);
  const before = (await link.invoke("inf:cards:thread", [cardId]))?.messages ?? [];
  const baseline = newest(before);
  // The reply, the wait, and the last read of the thread that may start as the wait ends.
  const acquired = claim(dir, requestId, print, { subject: { kind: "reply", cardId, lifecycleId, offerId, textFp: textPrint(text) }, holdMs: holdFor(2, waitMs) });
  if (!acquired.fresh) return { ...acquired.result, replayed: true };
  const { path } = acquired;
  const { stop, call } = bounded(link, acquired.until);
  const submission = { id: requestId, lifecycleId, offerId, reading: "none" };
  let thread;
  try {
    thread = await call("inf:cards:reply", [cardId, { text }, submission]);
  } catch (e) {
    mark(path, { outcome: "unknown" });
    throw e;
  }
  // Infinitary returns the thread with the written line in it, so the bridge's own line has an id.
  const own = (thread?.messages ?? []).filter((m) => m.who === "captain" && m.text === text && Number(m.id) > baseline).at(-1);
  mark(path, own ? { outcome: "accepted", lineId: Number(own.id) } : { outcome: "unknown" });
  const answers = [];
  const seenIds = new Set();
  const collect = (messages) => {
    for (const m of messages) {
      const id = Number(m.id) || 0;
      if (id > baseline && m.who !== "captain" && m.text && !seenIds.has(id)) {
        seenIds.add(id);
        answers.push({ id, who: m.who, text: m.text });
      }
    }
  };
  collect(thread?.messages ?? []);
  const end = Math.min(Date.now() + waitMs, stop);
  while (Date.now() < end && !answers.length) {
    await sleep(Math.min(pollMs, Math.max(0, end - Date.now())));
    const now = (await call("inf:cards:thread", [cardId]))?.messages ?? [];
    collect(now);
  }
  const result = { ok: true, answers };
  finish(path, result, { printed: answers.map((a) => a.id) });
  return result;
}

/**
 * Infinitary protocol 12 has no turn id on converse, last-turn, or its pushes.
 * Correlate conservatively by push order and refuse any overlap or timeout.
 */
export async function sayToFirstMate(link, dir, opts) {
  const { requestId, text, waitMs = 90000, pollMs = 2000 } = opts;
  if (typeof text !== "string" || !text.trim()) throw new Error("Give the message on stdin.");
  if (text.length > MAX_SAY) throw new Error(`A message is at most ${MAX_SAY} characters.`);
  const print = fingerprint(["say", text]);
  const prior = claim(dir, requestId, print, { create: false });
  if (!prior.fresh) return { ...prior.result, replayed: true };

  const seen = [];
  const onPush = (_channel, payload) => {
    const event = payload?.type ? payload : payload?.event;
    if (event && ["user_turn", "firstmate_reply"].includes(event.type)) seen.push(event);
  };
  link.on("push", onPush);
  let open = null;
  try {
    const initialState = await link.invoke("inf:conversation:state", []);
    if (initialState?.busy !== false) throw new Error("The first mate is working or its idle state could not be confirmed. Nothing was sent; retry when the conversation is idle.");
    if (seen.some((event) => event.type === "user_turn")) {
      throw new Error("A conversation message arrived while checking the first mate. Nothing was sent; retry when the conversation is idle.");
    }

    // The message, the wait, and the confirming reads that may start as the wait ends.
    const acquired = claim(dir, requestId, print, { subject: { kind: "say", textFp: textPrint(text) }, holdMs: holdFor(2, waitMs) });
    if (!acquired.fresh) return { ...acquired.result, replayed: true };
    const { path } = acquired;
    const { stop, call } = bounded(link, acquired.until);
    open = path;
    try {
      await call("inf:converse", [{ text }]);
    } catch {
      mark(path, { outcome: "unknown" });
      throw new Error("The first mate's acceptance was not confirmed. The message may have been sent; read 'last' before deciding what to do next.");
    }

    const end = Math.min(Date.now() + waitMs, stop);
    let ownTurnIndex = -1;
    while (Date.now() < end) {
      const userTurns = seen.map((event, index) => ({ event, index })).filter(({ event }) => event.type === "user_turn");
      if (userTurns.length > 1 || userTurns.some(({ event }) => event.text !== text)) {
        throw new Error("Another conversation message overlapped this request. Its answer is ambiguous; read 'last' before sending anything else.");
      }
      if (userTurns.length === 1) ownTurnIndex = userTurns[0].index;
      if (ownTurnIndex >= 0) {
        const replyEvent = seen.find((event, index) => index > ownTurnIndex && event.type === "firstmate_reply");
        if (replyEvent) {
          const [turn, state] = await Promise.all([
            call("inf:conversation:last-turn", []),
            call("inf:conversation:state", []),
          ]);
          if (seen.filter((event) => event.type === "user_turn").length !== 1) {
            throw new Error("Another conversation message overlapped this request. Its answer is ambiguous; read 'last' before sending anything else.");
          }
          if (state?.busy === false && turn?.you === text && turn?.reply?.text === replyEvent.text) {
            const result = { ok: true, reply: turn.reply };
            finish(path, result, { outcome: "accepted", replyFp: textPrint(turn.reply.text) });
            open = null;
            return result;
          }
        }
      }
      await sleep(Math.min(pollMs, Math.max(0, end - Date.now())));
    }
    throw new Error("No safely correlated first-mate reply arrived before the wait ended. The message was sent; read 'last' before deciding what to do next.");
  } finally {
    if (open) mark(open, { outcome: "unknown" });
    link.off("push", onPush);
  }
}
