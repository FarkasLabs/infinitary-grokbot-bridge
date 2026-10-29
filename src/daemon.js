import { readFileSync, rmSync } from "node:fs";
import { HomeLink } from "./home.js";
import { Relay } from "./relay.js";
import { grantPath, isEnabled, pidPath, readJson, switchEpoch, writePrivate } from "./state.js";
import { defaultWebhookEnv, makeSender } from "./webhook.js";

export const statusPath = (dir) => `${dir}/status.json`;

export function daemonAlive(dir) {
  try {
    const pid = Number(readFileSync(pidPath(dir), "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

/**
 * The long-running part. While the switch is on it holds one read-only connection to the home
 * and relays cards; while off it holds nothing open and sends nothing.
 */
export async function runDaemon(dir, { send, openLink = (g) => new HomeLink(g), pollMs = 1000, settlePollMs = 250, tickMs = 30000, log = console.error } = {}) {
  if (daemonAlive(dir) && daemonAlive(dir) !== process.pid) throw new Error("The bridge is already running.");
  writePrivate(pidPath(dir), String(process.pid));
  const relay = new Relay({
    epoch: () => switchEpoch(dir),
    dir,
    send: send ?? makeSender(defaultWebhookEnv()),
    enabled: () => isEnabled(dir),
    maxChars: Number(process.env.GROKBOT_BRIDGE_MAX_CHARS) || 3500,
    log,
    pollMs: settlePollMs,
  });
  let link = null;
  let connecting = false;
  let retryAt = 0;
  let backoff = 5000;
  let stopped = false;
  const setStatus = (extra) => writePrivate(statusPath(dir), JSON.stringify({ at: Date.now(), enabled: isEnabled(dir), ...extra }));

  let homeName = null;

  async function connect() {
    connecting = true;
    try {
      const grant = readJson(grantPath(dir), null);
      if (!grant) throw new Error("not paired");
      const l = openLink(grant);
      const welcome = await l.open();
      homeName = welcome.name ?? null;
      l.on("push", (channel, payload) => {
        if (link !== l) return;
        if (channel === "inf:cards" && Array.isArray(payload)) {
          setStatus({ connected: true, home: homeName, cards: payload.length });
          relay.onCards(payload).catch((e) => log(e.message));
        }
        else if (channel === "inf:cards:thread") relay.onThread(payload);
        else if (channel === "inf:event") relay.onEvent(payload);
      });
      l.once("close", () => {
        if (link !== l) return;
        link = null;
        relay.onDown();
        setStatus({ connected: false });
      });
      link = l;
      backoff = 5000;
      // The session exists from the moment the connection does, so nothing said while the list is read is lost.
      const up = relay.onUp({
        thread: (id) => l.invoke("inf:cards:thread", [id]),
        past: (id) => l.invoke("inf:cards:past", [id]),
        task: (id) => l.invoke("inf:tasks:detail", [id]),
      });
      const cards = await l.invoke("inf:cards:list", []);
      setStatus({ connected: true, home: homeName, cards: cards.length });
      const shown = relay.onCards(cards);
      await up;
      await shown;
    } catch (e) {
      relay.onDown();
      log(`connect: ${e.message}`);
      setStatus({ connected: false, problem: e.message });
      retryAt = Date.now() + backoff;
      backoff = Math.min(backoff * 2, 60000);
    } finally {
      connecting = false;
    }
  }

  const poll = setInterval(() => {
    if (stopped) return;
    const on = isEnabled(dir);
    if (!on) relay.onOff();
    if (!on && link) {
      const l = link;
      link = null;
      l.removeAllListeners("close");
      l.close();
      setStatus({ connected: false });
    } else if (!on) {
      if (!connecting) setStatus({ connected: false });
    } else if (on && !link && !connecting && Date.now() >= retryAt) connect();
  }, pollMs);
  const tick = setInterval(() => relay.tick().catch((e) => log(e.message)), tickMs);

  const stop = () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(tick);
    link?.close();
    rmSync(pidPath(dir), { force: true });
  };
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  return { stop, relay, get link() { return link; } };
}
