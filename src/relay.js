import { createHash } from "node:crypto";
import { readJson, receiptsPath, writePrivate } from "./state.js";
import { effectOf } from "./act.js";
import { commentNotice, endingNotice, endingWhat, mergeRefusedNotice, mergeResultNotice, replyNotice, threadAnswerNotice, turnNotice, unclearNotice } from "./notices.js";
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
  constructor({ dir, send, enabled, epoch = () => 0, maxChars = 3500, now = () => Date.now(), log = () => {}, reads = {}, pollMs = 250 }) {
    this.dir = dir;
    this.rawSend = send;
    this.isEnabled = enabled;
    this.epoch = epoch;
    this.seenEpoch = epoch();
    this.maxChars = maxChars;
    this.now = now;
    this.log = log;
    const saved = readJson(receiptsPath(dir), {});
    this.sent = saved.sent ?? {};
    this.meta = saved.meta ?? {};
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
    this.cardsRun = Promise.resolve();
    this.s = this.#fresh();
  }

  /**
   * The switch. Any write to it (off, or off and on again between two looks) is a transition that drops the
   * notices waiting for a retry: they belong to the time it was on before. The connection and its session stay.
   */
  enabled() {
    const epoch = this.epoch();
    if (epoch !== this.seenEpoch) {
      this.seenEpoch = epoch;
      this.outbox = this.outbox.filter((n) => n.inflight);
    }
    return this.isEnabled();
  }

  /**
   * What one connection knows: the cards shown, each thread's newest line, merges waiting for a result. Queued work holds
   * the session it was received in and does nothing once another has replaced it, so nothing carries over a reset.
   */
  #fresh(up = false, reads = this.reads) {
    return { up, reads, known: new Map(), lastLine: new Map(), seen: new Set(), introduced: new Map(), baseline: new Map(), merges: new Map(), baselined: false, early: new Map(), connectedAt: up ? Date.now() : Infinity };
  }

  #alive = (s) => this.s === s && s.up;

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

  /**
   * What an ending needs to know about a card (title, lifecycle, offer, task, buttons), so a reconnect or restart still
   * recognises one Grok bot was told of. It is what the newest list shows, taken and saved the moment the list arrives:
   * Grok bot's commands act on the offer the list shows, so this is a fact about Infinitary, not about delivery, and no
   * refused delivery, queued work or dropped connection can leave an older offer behind. A card no list shows any more is
   * kept only while its receipt is, for the ending a first list may still report.
   */
  #learn(cards) {
    const shown = new Set(cards.map((c) => c.id));
    for (const id of Object.keys(this.meta)) if (!shown.has(id) && !(id in this.sent)) delete this.meta[id];
    for (const c of cards) this.meta[c.id] = { id: c.id, title: c.title, lifecycleId: c.lifecycleId, offerId: c.offerId, taskId: c.taskId, actions: c.actions };
    this.#save();
  }

  #save() {
    writePrivate(receiptsPath(this.dir), JSON.stringify({ sent: this.sent, meta: this.meta, noticeSent: this.noticeSent, ended: this.ended.slice(-200) }));
  }

  /** One chunk. "sent", "rejected" (definitely refused: a settings problem or a 4xx answer), "unknown" (may have been delivered) or "off". */
  #post(part) {
    const run = this.queue.then(async () => {
      if (!this.enabled()) return "off";
      const r = await this.rawSend(part);
      if (r.ok) return "sent";
      this.log(`webhook send failed: ${r.status ?? r.reason}`);
      return r.rejected === true || (r.status >= 400 && r.status < 500) ? "rejected" : "unknown";
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** One message, in chunks, in order; false if the first chunk was not accepted. */
  async #emit(text) {
    let first = true;
    for (const part of chunk(text, this.maxChars)) {
      if ((await this.#post(part)) !== "sent") return !first;
      first = false;
    }
    return true;
  }

  /**
   * A notice about what happened in Infinitary. It leaves the outbox only when the webhook accepted every chunk, and its
   * receipt (`onSent`) is written only then. A chunk that was definitely rejected is tried again, in order, at the next
   * notice, tick or reconnect, and chunks already accepted are not sent again. A failure that may have been delivered is
   * not sent again. `id` is its stable identity: the same notice is never queued twice. The outbox lives in memory: a
   * restart or the switch changing drops it, like every other live-only fact.
   */
  #notify(id, text, onSent) {
    if (!this.outbox.some((n) => n.id === id)) {
      this.outbox.push({ id, parts: chunk(text, this.maxChars), next: 0, onSent, at: Date.now(), inflight: false });
      if (this.outbox.length > OUTBOX_MAX) {
        const evict = this.outbox.find((n) => !n.inflight);
        if (evict) {
          this.outbox.splice(this.outbox.indexOf(evict), 1);
          this.log(`dropped an unsent notice: ${evict.id}`);
        }
      }
    }
    return this.#flush();
  }

  #flush() {
    const run = this.flushing.then(async () => {
      for (;;) {
        const n = this.outbox[0];
        if (!n) return;
        const drop = () => {
          const i = this.outbox.indexOf(n);
          if (i >= 0) this.outbox.splice(i, 1);
        };
        if (!this.enabled() || Date.now() - n.at > OUTBOX_MAX_AGE) {
          drop();
          continue;
        }
        if (!this.outbox.includes(n)) continue; // the switch check itself discarded it: it is not sent
        n.inflight = true;
        let result = "sent";
        while (n.next < n.parts.length && result === "sent") {
          result = await this.#post(n.parts[n.next]);
          if (result === "sent") n.next += 1;
        }
        n.inflight = false;
        if (result === "rejected") return;
        drop();
        if (result === "sent") n.onSent?.();
        else this.log(`not sure ${n.id} was delivered; not sent again`);
      }
    });
    this.flushing = run.catch((e) => this.log(e.message));
    return run;
  }

  /** The cards the home shows now: on connect, on switch-on, and with every change. */
  onCards(cards) {
    const s = this.s;
    // What the snapshot says is taken in the moment it arrives, however long earlier messages take to deliver.
    this.#learn(cards);
    const prior = this.cardsRun;
    this.#note(s, cards, Date.now(), prior);
    const run = prior.then(() => this.#cards(s, cards));
    this.cardsRun = run.catch((e) => this.log(e.message));
    return run;
  }

  #note(s, cards, arrivedAt, prior) {
    if (!s.up || !this.enabled()) return;
    const live = new Set(cards.map((c) => c.id));
    const first = !s.baselined;
    s.baselined = true;
    for (const id of s.seen) if (!live.has(id)) (s.seen.delete(id), s.introduced.delete(id));
    for (const c of cards) {
      if (s.seen.has(c.id)) continue;
      s.seen.add(c.id);
      // On a connection's first snapshot, what was said since the connection began is news; later, since the card appeared.
      s.introduced.set(c.id, first ? Math.min(arrivedAt, s.connectedAt) : arrivedAt);
      s.baseline.set(c.id, this.#baseline(s, c.id, first ? undefined : 0));
    }
    // Cards told of before this connection and not in its first list may have ended since it began: known again, but only
    // an ending after the connection began is reported (the earlier ones are not caught up).
    if (first) for (const id of Object.keys(this.sent)) if (!live.has(id) && !s.known.has(id) && this.meta[id]) s.known.set(id, { ...this.meta[id], restored: true });
    // Card state changes in the same order as thread and event handling, so a queued update still finds its card.
    this.#serial(async () => {
      if (!this.#alive(s)) return;
      const gone = [...s.known.keys()].filter((id) => !live.has(id));
      // An ending is decided on what was delivered, so it waits for the deliveries before this snapshot.
      if (gone.length || Object.keys(this.sent).some((id) => !live.has(id))) await prior.catch(() => {});
      if (!this.#alive(s)) return;
      for (const id of gone) {
        const was = s.known.get(id);
        s.known.delete(id);
        if (id in this.sent) await this.#ending(s, was);
        if (!this.#alive(s)) return;
        s.lastLine.delete(id);
        s.early.delete(id);
      }
      if (!this.#alive(s)) return;
      for (const c of cards) s.known.set(c.id, c);
      for (const id of Object.keys(this.sent)) if (!live.has(id)) delete this.sent[id];
      this.#save();
      for (const c of cards) {
        const early = s.early.get(c.id);
        if (!early) continue;
        s.early.delete(c.id);
        await this.#threadLines(s, early);
      }
    });
  }

  async #cards(s, cards) {
    if (!this.enabled()) return;
    const ready = cards.filter((c) => c.status !== "streaming");
    const live = new Set(cards.map((c) => c.id));
    if (!s.up) for (const id of Object.keys(this.sent)) if (!live.has(id)) delete this.sent[id];
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

  /** The home was reached; `reads` are the reads of that very connection. Says it is back only if it said it went away. */
  async onUp(reads = this.reads) {
    this.enabled(); // a switch write seen now belongs to the time before this connection
    this.downSince = null;
    this.s = this.#fresh(true, reads);
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
    this.s = this.#fresh();
  }

  /** The switch was seen going off: nothing waiting is sent when it comes back on. */
  onOff() {
    this.seenEpoch = this.epoch();
    this.outbox = this.outbox.filter((n) => n.inflight);
    this.s = this.#fresh();
    this.downSince = null;
  }

  /** Called every so often: says once when the home has been away ten minutes. */
  async tick() {
    if (!this.enabled()) {
      this.downSince = null;
      this.outbox = this.outbox.filter((n) => n.inflight);
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

  /**
   * Where a new card's thread stands, read the moment the card is seen: lines written before then, or at that very instant (the
   * captain's choice: an equal timestamp is skipped), are history, however often Infinitary publishes them again; a line written after is news. Message ids ascend with their time.
   */
  async #baseline(s, id, fallback) {
    const since = s.introduced.get(id) ?? Date.now();
    let at;
    try {
      const thread = await s.reads.thread?.(id);
      at = (thread?.messages ?? []).filter((m) => (m.at ?? 0) <= since).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
    } catch (e) {
      this.log(`thread read: ${e.message}`);
      at = fallback;
    }
    if (this.#alive(s) && at !== undefined) s.lastLine.set(id, at);
  }

  /** Request records that match, once none of them is still running (up to the time each one allows). Null if the connection ended meanwhile. */
  async #records(s, pick, running) {
    for (;;) {
      if (!this.#alive(s)) return null;
      const recs = readRequests(this.dir).filter((r) => r.subject && pick(r));
      const left = Math.max(0, ...recs.filter(running).map((r) => r.until - Date.now()));
      if (!left) return recs;
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, left)));
    }
  }

  /** A card Grok bot knew has left: say how it ended, unless an accepted Grok bot command did exactly that. */
  async #ending(s, card) {
    if (!this.enabled() || !this.#alive(s)) return;
    const key = `${card.id}:${card.lifecycleId}`;
    if (this.ended.includes(key) || this.outbox.some((n) => n.id === `end:${key}`)) return;
    const past = await s.reads.past?.(card.id).catch((e) => (this.log(`past read: ${e.message}`), null));
    const e = past?.ending;
    if (!this.#alive(s) || !e || !["chose", "dismissed"].includes(e.how) || (e.by && e.by !== "captain")) return;
    if (card.restored && !((e.at ?? 0) > s.connectedAt)) return; // it ended before this connection began, or at that instant: not caught up
    const ours = (r) => r.subject.cardId === card.id && r.subject.lifecycleId === card.lifecycleId && r.subject.offerId === card.offerId;
    const open = (r) => r.state === "started" && r.outcome === undefined && r.until > Date.now();
    let silent = false;
    let unclear;
    if (e.how === "chose") {
      const recs = await this.#records(s, (r) => r.subject.kind === "answer" && ours(r), open);
      if (!recs) return;
      const same = recs.filter((r) => r.subject.actionId === e.actionId && r.subject.answersFp === answersPrint(past.answers));
      silent = same.some((r) => r.outcome === "accepted");
      unclear = same.find((r) => r.outcome !== "accepted" && r.outcome !== "refused");
    } else {
      const recs = await this.#records(s, (r) => r.subject.kind === "ack" && ours(r), open);
      if (!recs) return;
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
    // Infinitary may publish a fast result before it publishes the card's removal, so the task is read once tracking starts.
    if (merge && card.taskId && this.#alive(s)) {
      s.merges.set(card.taskId, { title: card.title, clickedAt: e.at ?? Date.now(), reported: new Set(), finished: false });
      await this.#merge(s, card.taskId);
    }
  }

  /**
   * What became of a requested merge, read from the task itself (by its identity) and only from records Infinitary
   * labels as the merge's: the task closed as merged or landed (or its merged/landed timeline event), and the
   * host's refusal note marked `refused: merge-pr` or `land` since the click. Approval bookkeeping, other host notes,
   * a task failure and anyone else's notes are not merge outcomes. Infinitary labels no merged reference to a pull
   * request as the merge's, so that case is not reported (see the README).
   */
  async #merge(s, taskId) {
    const m = s.merges.get(taskId);
    if (!m || m.finished || !this.#alive(s)) return;
    let task;
    try {
      task = await s.reads.task?.(taskId);
    } catch (e) {
      return void this.log(`task read: ${e.message}`);
    }
    if (!this.#alive(s) || !task || m.finished) return;
    const events = [...(task.events ?? [])].sort((a, b) => a.id - b.id);
    if ((task.status === "done" && ["merged", "landed"].includes(task.closedReason)) || events.some((ev) => ["merged", "landed"].includes(ev.kind))) {
      m.finished = true;
      return void (await this.#notify(`merge:${taskId}:result`, mergeResultNotice(m.title)));
    }
    for (const ev of events) {
      if (ev.actor !== "host" || ev.kind !== "note" || ev.at < m.clickedAt || m.reported.has(ev.id) || !ev.text) continue;
      if (!["merge-pr", "land"].includes(ev.data?.refused)) continue;
      m.reported.add(ev.id);
      await this.#notify(`merge:${taskId}:refused:${ev.id}`, mergeRefusedNotice(m.title, ev.text));
    }
  }

  /** A card's thread changed (inf:cards:thread). */
  onThread(thread) {
    const s = this.s;
    return this.#serial(async () => {
      if (!this.#alive(s)) return;
      // A card this connection has not been told of yet: kept, and read when the card arrives.
      if (s.up && !s.known.has(thread?.cardId) && thread?.cardId !== undefined) return void s.early.set(thread.cardId, thread);
      await this.#threadLines(s, thread);
    });
  }

  async #threadLines(s, thread) {
    await this.cardsRun;
    await s.baseline.get(thread?.cardId);
    if (!this.enabled() || !this.#alive(s)) return;
    const card = s.known.get(thread?.cardId);
    if (!card || !(card.id in this.sent)) return;
    const messages = [...(thread.messages ?? [])].sort((a, b) => Number(a.id) - Number(b.id));
    const newest = messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
    const last = s.lastLine.get(card.id);
    s.lastLine.set(card.id, Math.max(newest, last ?? 0));
    if (last === undefined) return;
    const since = s.introduced.get(card.id) ?? 0;
    // A line stamped at or before the moment the card was first seen is history, however late it is pushed (equal: skipped).
    for (const m of messages.filter((x) => Number(x.id) > last && x.text && (x.at === undefined || x.at > since) && ["captain", "crewmate", "firstmate"].includes(x.who))) {
      await this.#line(s, card, m);
    }
  }

  async #line(s, card, m) {
    const replies = (r) => r.subject.kind === "reply" && r.subject.cardId === card.id && r.subject.lifecycleId === card.lifecycleId;
    const id = Number(m.id);
    if (m.who === "captain") {
      const recs = await this.#records(s, replies, (r) => r.state === "started" && r.outcome === undefined && r.until > Date.now());
      if (!recs || recs.some((r) => r.outcome === "accepted" && r.lineId === id)) return;
      const unclear = recs.find((r) => r.outcome !== "accepted" && r.outcome !== "refused" && r.subject.textFp === textPrint(m.text) && !hasMarker(r.path, "line") && claimMarker(r.path, "line"));
      return void (await this.#notify(`line:${card.id}:${id}`, unclear ? unclearNotice(unclear, `A comment under ${JSON.stringify(card.title)} (card ${card.id}) reads: ${m.text}\n`) : commentNotice(card, m)));
    }
    const recs = await this.#records(s, replies, (r) => r.state === "started" && r.until > Date.now());
    if (!recs || recs.some((r) => (r.printed ?? []).includes(id))) return;
    await this.#notify(`line:${card.id}:${id}`, threadAnswerNotice(card, m));
  }

  /** inf:event: the conversation with the first mate, and what happens to a task whose merge was requested. */
  onEvent(payload) {
    const event = payload?.type ? payload : payload?.event;
    if (!event) return Promise.resolve();
    const s = this.s;
    return this.#serial(async () => {
      if (!this.enabled() || !this.#alive(s)) return;
      if (event.type === "user_turn") return this.#turn(s, event.text);
      if (event.type === "firstmate_reply") return this.#firstMateReply(s, event.text);
      if (["task_changed", "task_event"].includes(event.type) && s.merges.has(event.taskId)) await this.#merge(s, event.taskId);
    });
  }

  /** A say's own turn can echo only if it began while this connection was up. */
  #liveTurn = (s) => (r) => r.at >= s.connectedAt && Date.now() - r.at < 15 * 60 * 1000;
  /** Its reply can echo if the say began on this connection, or was still running when it began, or finished since. */
  #liveReply = (s) => (r) => (r.at >= s.connectedAt || r.doneAt >= s.connectedAt || (r.state === "started" && r.until > Date.now())) && Date.now() - r.at < 15 * 60 * 1000;

  async #turn(s, text) {
    const live = this.#liveTurn(s);
    const say = (r) => r.subject.kind === "say" && r.subject.textFp === textPrint(text) && live(r) && !hasMarker(r.path, "turn");
    const recs = await this.#records(s, say, (r) => r.state === "started" && r.outcome === undefined && r.until > Date.now());
    if (!recs) return;
    const own = recs.find((r) => r.outcome === "accepted") ?? recs.find((r) => r.outcome === "unknown" || (r.state === "started" && r.outcome === undefined));
    if (own && !claimMarker(own.path, "turn")) return this.#turn(s, text);
    if (own?.outcome === "accepted") return;
    await this.#notify(`turn:${this.seq++}`, own ? unclearNotice(own, `The first mate was told: ${text}\n`) : turnNotice(text));
  }

  async #firstMateReply(s, text) {
    const live = this.#liveReply(s);
    const say = (r) => r.subject.kind === "say" && live(r);
    const recs = await this.#records(s, say, (r) => r.state === "started" && r.until > Date.now());
    if (!recs) return;
    const own = recs.find((r) => r.outcome === "accepted" && r.replyFp === textPrint(text) && !hasMarker(r.path, "reply"));
    if (own && claimMarker(own.path, "reply")) return;
    await this.#notify(`reply:${this.seq++}`, replyNotice(text));
  }
}
