import { createHash } from "node:crypto";
import { readJson, receiptsPath, writePrivate } from "./state.js";
import { effectOf } from "./act.js";
import { commentNotice, endingNotice, endingWhat, mergeResultNotice, mergeUpdateNotice, replyNotice, threadAnswerNotice, turnNotice, unclearNotice } from "./notices.js";
import { answersPrint, claimMarker, hasMarker, readRequests, textPrint } from "./requests.js";
import { cardMessage, chunk } from "./text.js";

export const CATCH_UP_MAX = 5;
export const OFFLINE_AFTER_MS = 10 * 60 * 1000;
const OUTBOX_MAX = 100;
const OUTBOX_MAX_AGE = 60 * 60 * 1000;

/** The card's current version: the home's offerId, or a hash of what a person reads. */
export const versionOf = (card) =>
  card.offerId ?? createHash("sha256").update(JSON.stringify([card.title, card.body, card.actions])).digest("hex").slice(0, 16);

/**
 * Decides what goes to Grok bot and when. It sends nothing while `enabled()` is false,
 * sends each card version at most once, and never acts on a card.
 */
export class Relay {
  constructor({ dir, send, enabled, maxChars = 3500, now = () => Date.now(), log = () => {}, reads = {}, pollMs = 250 }) {
    this.dir = dir;
    this.rawSend = send;
    this.enabled = enabled;
    this.maxChars = maxChars;
    this.now = now;
    this.log = log;
    const saved = readJson(receiptsPath(dir), {});
    this.sent = saved.sent ?? {};
    this.noticeSent = saved.noticeSent ?? false;
    this.ended = saved.ended ?? [];
    this.reads = reads;
    this.pollMs = pollMs;
    this.downSince = null;
    this.queue = Promise.resolve();
    this.work = Promise.resolve();
    this.outbox = [];
    this.flushing = Promise.resolve();
    this.seq = 0;
    this.#liveReset();
  }

  /** What one connection knows: the cards shown, each thread's newest line, merges waiting for a result. Nothing carries over. */
  #liveReset() {
    this.known = new Map();
    this.lastLine = new Map();
    this.merges = new Map();
    this.merged = new Set();
    this.baselined = false;
    this.connectedAt = Infinity;
  }

  /** Handled one at a time, in arrival order. */
  #serial(fn) {
    const run = this.work.then(fn);
    this.work = run.catch((e) => this.log(e.message));
    return run;
  }

  /** Resolves when everything received so far is handled. */
  idle() {
    return this.work;
  }

  #save() {
    writePrivate(receiptsPath(this.dir), JSON.stringify({ sent: this.sent, noticeSent: this.noticeSent, ended: this.ended.slice(-200) }));
  }

  /**
   * One message, in chunks, in order. "sent": accepted. "rejected": the first chunk was definitely refused (settings
   * problem or a 4xx answer), so nothing reached Grok bot and it can be tried again. "unknown": the first chunk failed
   * in a way that may still have been delivered. "off": the switch is off.
   */
  async #deliver(text) {
    if (!this.enabled()) return "off";
    const run = this.queue.then(async () => {
      let first = true;
      for (const part of chunk(text, this.maxChars)) {
        if (!this.enabled()) return first ? "off" : "sent";
        const r = await this.rawSend(part);
        if (!r.ok) {
          this.log(`webhook send failed: ${r.status ?? r.reason}`);
          if (!first) return "sent";
          return r.rejected === true || (r.status >= 400 && r.status < 500) ? "rejected" : "unknown";
        }
        first = false;
      }
      return "sent";
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** One message; false if the first chunk was not accepted. */
  async #emit(text) {
    return (await this.#deliver(text)) === "sent";
  }

  /**
   * A notice about what happened in Infinitary. It leaves the outbox only when the webhook accepted it, so a definite
   * rejection is tried again, in order, at the next notice, tick or reconnect. A failure that may have been delivered
   * is not sent again. `id` is its stable identity: the same notice is never queued twice. `onSent` records its receipt.
   * The outbox lives in memory: a restart or the switch going off drops it, like every other live-only fact.
   */
  #notify(id, text, onSent) {
    if (!this.outbox.some((n) => n.id === id)) {
      this.outbox.push({ id, text, onSent, at: Date.now() });
      if (this.outbox.length > OUTBOX_MAX) this.log(`dropped an unsent notice: ${this.outbox.shift().id}`);
    }
    return this.#flush();
  }

  #flush() {
    const run = this.flushing.then(async () => {
      while (this.outbox.length) {
        const n = this.outbox[0];
        if (!this.enabled() || Date.now() - n.at > OUTBOX_MAX_AGE) {
          this.outbox.shift();
          continue;
        }
        const result = await this.#deliver(n.text);
        if (result === "rejected") return;
        this.outbox.shift();
        if (result === "sent") n.onSent?.();
        else this.log(`not sure ${n.id} was delivered; not sent again`);
      }
    });
    this.flushing = run.catch((e) => this.log(e.message));
    return run;
  }

  /** The cards the home shows now: on connect, on switch-on, and with every change. */
  onCards(cards) {
    const run = this.#cards(cards);
    this.cardsRun = run.catch(() => {});
    return run;
  }

  async #cards(cards) {
    if (!this.enabled()) return;
    const ready = cards.filter((c) => c.status !== "streaming");
    const live = new Set(cards.map((c) => c.id));
    // Card state changes in the same order as thread and event handling, so a queued update still finds its card.
    this.#serial(async () => {
      const first = !this.baselined;
      this.baselined = true;
      for (const [id, gone] of this.known) {
        if (live.has(id)) continue;
        this.known.delete(id);
        if (id in this.sent) await this.#ending(gone);
        this.lastLine.delete(id);
      }
      const introduced = cards.filter((c) => !this.known.has(c.id));
      for (const c of cards) this.known.set(c.id, c);
      await this.#baseline(introduced, first ? undefined : 0);
      for (const id of Object.keys(this.sent)) if (!live.has(id)) delete this.sent[id];
      this.#save();
    });
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
    this.#liveReset();
    this.connectedAt = Date.now();
    await this.#flush();
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
    this.#liveReset();
  }

  /** Called every so often: says once when the home has been away ten minutes. */
  async tick() {
    if (!this.enabled()) {
      this.downSince = null;
      this.outbox.length = 0;
      return;
    }
    await this.#flush();
    if (this.downSince !== null && !this.noticeSent && this.now() - this.downSince >= OFFLINE_AFTER_MS) {
      if (await this.#emit("Infinitary has been closed or unreachable for ten minutes. I will say when it is back.")) {
        this.noticeSent = true;
        this.#save();
      }
    }
  }

  // --- What happened in Infinitary itself, while connected. ---

  /** Where each thread stands now. A card that appeared after connecting starts at 0 if its thread cannot be read, so its first line is news. */
  async #baseline(cards, fallback) {
    for (const c of cards) {
      try {
        const thread = await this.reads.thread?.(c.id);
        this.lastLine.set(c.id, (thread?.messages ?? []).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0));
      } catch (e) {
        this.log(`thread read: ${e.message}`);
        if (fallback !== undefined) this.lastLine.set(c.id, fallback);
      }
    }
  }

  /** Request records that match, once none of them is still running (up to the time each one allows). */
  async #records(pick, running) {
    for (;;) {
      const recs = readRequests(this.dir).filter((r) => r.subject && pick(r));
      const left = Math.max(0, ...recs.filter(running).map((r) => r.until - Date.now()));
      if (!left) return recs;
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, left)));
    }
  }

  /** A card Grok bot knew has left: say how it ended, unless an accepted Grok bot command did exactly that. */
  async #ending(card) {
    if (!this.enabled()) return;
    const key = `${card.id}:${card.lifecycleId}`;
    if (this.ended.includes(key) || this.outbox.some((n) => n.id === `end:${key}`)) return;
    const past = await this.reads.past?.(card.id).catch((e) => (this.log(`past read: ${e.message}`), null));
    const e = past?.ending;
    if (!e || !["chose", "dismissed"].includes(e.how) || (e.by && e.by !== "captain")) return;
    const ours = (r) => r.subject.cardId === card.id && r.subject.lifecycleId === card.lifecycleId && r.subject.offerId === card.offerId;
    let silent = false;
    let unclear;
    if (e.how === "chose") {
      const recs = await this.#records((r) => r.subject.kind === "answer" && ours(r), (r) => r.state === "started" && r.outcome === undefined && r.until > Date.now());
      const same = recs.filter((r) => r.subject.actionId === e.actionId && r.subject.answersFp === answersPrint(past.answers));
      silent = same.some((r) => r.outcome === "accepted");
      unclear = same.find((r) => r.outcome !== "accepted" && r.outcome !== "refused");
    } else {
      const recs = await this.#records((r) => r.subject.kind === "ack" && ours(r), (r) => r.state === "started" && r.outcome === undefined && r.until > Date.now());
      silent = recs.some((r) => r.outcome === "accepted");
      unclear = recs.find((r) => r.outcome !== "accepted" && r.outcome !== "refused");
    }
    const action = card.actions?.find((a) => a.id === e.actionId);
    const merge = e.how === "chose" && action && effectOf(action).kind === "merge";
    const done = () => {
      this.ended.push(key);
      this.#save();
    };
    if (silent) done();
    else await this.#notify(`end:${key}`, unclear ? unclearNotice(unclear, endingWhat(card, past)) : endingNotice(card, past, { merge }), done);
    // Infinitary may publish a fast result before it publishes the card's removal.
    if (merge && card.taskId) {
      if (this.merged.has(card.taskId)) await this.#notify(`merge:${card.taskId}:result`, mergeResultNotice(card.title, true));
      else this.merges.set(card.taskId, { title: card.title, at: Date.now(), updated: false });
    }
  }

  /** A card's thread changed (inf:cards:thread). */
  onThread(thread) {
    return this.#serial(async () => {
      await this.cardsRun;
      const card = this.known.get(thread?.cardId);
      if (!this.enabled() || !card || !(card.id in this.sent)) return;
      const messages = [...(thread.messages ?? [])].sort((a, b) => Number(a.id) - Number(b.id));
      const newest = messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
      const last = this.lastLine.get(card.id);
      this.lastLine.set(card.id, newest);
      if (last === undefined) return;
      for (const m of messages.filter((x) => Number(x.id) > last && x.text && ["captain", "crewmate", "firstmate"].includes(x.who))) {
        await this.#line(card, m);
      }
    });
  }

  async #line(card, m) {
    const replies = (r) => r.subject.kind === "reply" && r.subject.cardId === card.id && r.subject.lifecycleId === card.lifecycleId;
    const id = Number(m.id);
    if (m.who === "captain") {
      const recs = await this.#records(replies, (r) => r.state === "started" && r.outcome === undefined && r.until > Date.now());
      if (recs.some((r) => r.outcome === "accepted" && r.lineId === id)) return;
      const unclear = recs.find((r) => r.outcome !== "accepted" && r.outcome !== "refused" && r.subject.textFp === textPrint(m.text) && !hasMarker(r.path, "line") && claimMarker(r.path, "line"));
      return void (await this.#notify(`line:${card.id}:${id}`, unclear ? unclearNotice(unclear, `A comment under ${JSON.stringify(card.title)} (card ${card.id}) reads: ${m.text}\n`) : commentNotice(card, m)));
    }
    const recs = await this.#records(replies, (r) => r.state === "started" && r.until > Date.now());
    if (recs.some((r) => (r.printed ?? []).includes(id))) return;
    await this.#notify(`line:${card.id}:${id}`, threadAnswerNotice(card, m));
  }

  /** inf:event: the conversation with the first mate, and what happens to a task whose merge was requested. */
  onEvent(payload) {
    const event = payload?.type ? payload : payload?.event;
    if (!event) return Promise.resolve();
    return this.#serial(async () => {
      if (!this.enabled()) return;
      if (event.type === "user_turn") return this.#turn(event.text);
      if (event.type === "firstmate_reply") return this.#firstMateReply(event.text);
      const closed = (event.type === "task_event" && ["merged", "landed"].includes(event.kind)) ||
        (event.type === "task_changed" && event.status === "done" && ["merged", "landed"].includes(event.closedReason));
      if (closed) this.merged.add(event.taskId);
      const taskId = event.type === "firstmate_note" && !event.taskId
        ? [...this.merges].find(([, p]) => String(event.text).includes(`"${p.title}"`))?.[0]
        : event.taskId;
      const pending = this.merges.get(taskId);
      if (!pending) return;
      if (closed) {
        this.merges.delete(taskId);
        return void (await this.#notify(`merge:${taskId}:result`, mergeResultNotice(pending.title, true)));
      }
      // A task failure is not a merge failure: Infinitary reports a refusal or a merged reference as a note, so its own words are passed on.
      const ACK = /result will appear here|is queued and will run/;
      const note = (event.type === "task_event" && event.kind === "note" && event.feed) || event.type === "firstmate_note";
      if (note && !pending.updated && event.text && !ACK.test(event.text)) {
        pending.updated = true;
        await this.#notify(`merge:${taskId}:update`, mergeUpdateNotice(pending.title, event.text));
      }
    });
  }

  /** Only a say the daemon was connected for can have echoed here: one that ran before this connection began cannot. */
  #live = (r) => r.at >= this.connectedAt && Date.now() - r.at < 15 * 60 * 1000;

  async #turn(text) {
    const say = (r) => r.subject.kind === "say" && r.subject.textFp === textPrint(text) && this.#live(r) && !hasMarker(r.path, "turn");
    const recs = await this.#records(say, (r) => r.state === "started" && r.outcome === undefined && r.until > Date.now());
    const own = recs.find((r) => r.outcome === "accepted") ?? recs.find((r) => r.outcome === "unknown" || (r.state === "started" && r.outcome === undefined));
    if (own && !claimMarker(own.path, "turn")) return this.#turn(text);
    if (own?.outcome === "accepted") return;
    await this.#notify(`turn:${this.seq++}`, own ? unclearNotice(own, `The first mate was told: ${text}\n`) : turnNotice(text));
  }

  async #firstMateReply(text) {
    const say = (r) => r.subject.kind === "say" && this.#live(r);
    const recs = await this.#records(say, (r) => r.state === "started" && r.until > Date.now());
    const own = recs.find((r) => r.outcome === "accepted" && r.replyFp === textPrint(text) && !hasMarker(r.path, "reply"));
    if (own && claimMarker(own.path, "reply")) return;
    await this.#notify(`reply:${this.seq++}`, replyNotice(text));
  }
}
