import { createHash } from "node:crypto";
import { readJson, receiptsPath, writePrivate } from "./state.js";
import { cardMessage, chunk } from "./text.js";

export const CATCH_UP_MAX = 5;
export const OFFLINE_AFTER_MS = 10 * 60 * 1000;

/** The card's current version: the home's offerId, or a hash of what a person reads. */
export const versionOf = (card) =>
  card.offerId ?? createHash("sha256").update(JSON.stringify([card.title, card.body, card.actions])).digest("hex").slice(0, 16);

/**
 * Decides what goes to Grok bot and when. It sends nothing while `enabled()` is false,
 * sends each card version at most once, and never acts on a card.
 */
export class Relay {
  constructor({ dir, send, enabled, maxChars = 3500, now = () => Date.now(), log = () => {} }) {
    this.dir = dir;
    this.rawSend = send;
    this.enabled = enabled;
    this.maxChars = maxChars;
    this.now = now;
    this.log = log;
    const saved = readJson(receiptsPath(dir), {});
    this.sent = saved.sent ?? {};
    this.noticeSent = saved.noticeSent ?? false;
    this.downSince = null;
    this.queue = Promise.resolve();
  }

  #save() {
    writePrivate(receiptsPath(this.dir), JSON.stringify({ sent: this.sent, noticeSent: this.noticeSent }));
  }

  /** One message, in chunks, in order; false if the first chunk was not accepted. */
  async #emit(text) {
    if (!this.enabled()) return false;
    const run = this.queue.then(async () => {
      let first = true;
      for (const part of chunk(text, this.maxChars)) {
        if (!this.enabled()) return !first;
        const r = await this.rawSend(part);
        if (!r.ok) {
          this.log(`webhook send failed: ${r.status ?? r.reason}`);
          return !first;
        }
        first = false;
      }
      return true;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** The cards the home shows now: on connect, on switch-on, and with every change. */
  async onCards(cards) {
    if (!this.enabled()) return;
    const ready = cards.filter((c) => c.status !== "streaming");
    const live = new Set(cards.map((c) => c.id));
    for (const id of Object.keys(this.sent)) if (!live.has(id)) delete this.sent[id];
    const due = ready
      .filter((c) => this.sent[c.id] !== versionOf(c))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const shown = due.slice(-CATCH_UP_MAX);
    const rest = due.slice(0, due.length - shown.length);
    for (const card of shown) {
      const updated = card.id in this.sent;
      if (await this.#emit(cardMessage(card, { updated }))) this.sent[card.id] = versionOf(card);
    }
    if (rest.length) {
      const lines = rest.map((c) => `- ${c.title} (card ${c.id})`);
      const ok = await this.#emit(`${rest.length} more card${rest.length === 1 ? "" : "s"} not sent in full:\n${lines.join("\n")}\nAsk for any of them by id.`);
      if (ok) for (const c of rest) this.sent[c.id] = versionOf(c);
    }
    this.#save();
  }

  /** The home was reached. Says it is back only if it said it went away. */
  async onUp() {
    this.downSince = null;
    if (this.noticeSent) {
      if (await this.#emit("Infinitary is back.")) {
        this.noticeSent = false;
        this.#save();
      }
    }
  }

  /** The home is not reachable now (closed, asleep, refused). */
  onDown() {
    this.downSince ??= this.now();
  }

  /** Called every so often: says once when the home has been away ten minutes. */
  async tick() {
    if (!this.enabled()) {
      this.downSince = null;
      return;
    }
    if (this.downSince !== null && !this.noticeSent && this.now() - this.downSince >= OFFLINE_AFTER_MS) {
      if (await this.#emit("Infinitary has been closed or unreachable for ten minutes. I will say when it is back.")) {
        this.noticeSent = true;
        this.#save();
      }
    }
  }
}
