// Intent (GRBP-26 re-review): the relay's own invariants, driven directly with deferred reads and a controllable webhook:
// a new card's first line stays news, a say running across a reconnect is correlated, a multipart notice keeps its
// progress, the switch changing drops waiting notices, work from a replaced connection is dropped, and the outbox
// evicts by identity.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replyToCard, sayToFirstMate } from "../src/act.js";
import { claim, finish, mark, textPrint, answersPrint } from "../src/requests.js";
import { Relay } from "../src/relay.js";
import { readJson, receiptsPath } from "../src/state.js";
import { makeSender } from "../src/webhook.js";
import { card } from "./standin.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (await f()) return;
  assert.fail("timed out waiting");
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function rig({ maxChars = 3500, reads = {}, epoch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gb-relay2-"));
  const r = { dir, sent: [], mode: "ok", gate: null, on: true, epochValue: 0 };
  r.send = async (m) => {
    if (r.gate) await r.gate.promise;
    if (typeof r.mode === "function") return r.mode(m);
    if (r.mode === "refuse") return { ok: false, status: 403, rejected: true };
    return r.sent.push(m), { ok: true, status: 200 };
  };
  r.relay = new Relay({ dir, send: r.send, enabled: () => r.on, epoch: epoch ?? (() => r.epochValue), maxChars, pollMs: 5, reads });
  r.reads = { thread: async () => ({ messages: [] }), past: async () => null, task: async () => null, ...reads };
  return r;
}
const thread = (cardId, ...lines) => ({ cardId, messages: lines.map(([id, who, text]) => ({ id, who, text, cardId, at: 1 })) });
const live = (c = card("1")) => ({ ...c, taskId: "t1" });

test("R1: a comment already received when a new card's baseline read finishes is still news", async () => {
  const gate = deferred();
  const r = rig();
  const written = Date.now() + 60000; // after the card is seen, however slow the machine
  r.reads.thread = async () => (await gate.promise, { messages: [{ id: 1, who: "captain", text: "first words", at: written }] });
  await r.relay.onUp(r.reads);
  await r.relay.onCards([]);
  await r.relay.onCards([live()]);
  const sentCard = r.sent.length;
  r.relay.onThread({ cardId: "1", messages: [{ id: 1, who: "captain", text: "first words", at: written }] });
  gate.resolve();
  await r.relay.idle();
  assert.equal(r.sent.length, sentCard + 1);
  assert.match(r.sent.at(-1), /you commented under "Card 1" \(card 1\): first words/);
});

test("R6: a say running when the connection began is correlated; one that finished before is not", async () => {
  const r = rig();
  const old = claim(r.dir, "req-oooooooo", "p1", { subject: { kind: "say", textFp: textPrint("a") }, holdMs: 60000 });
  finish(old.path, { ok: true }, { outcome: "accepted", replyFp: textPrint("Done.") });
  const running = claim(r.dir, "req-rrrrrrrr", "p2", { subject: { kind: "say", textFp: textPrint("b") }, holdMs: 60000 });
  await wait(20);
  await r.relay.onUp(r.reads);
  const first = r.relay.onEvent({ type: "firstmate_reply", text: "Done." });
  await wait(60);
  finish(running.path, { ok: true }, { outcome: "accepted", replyFp: textPrint("Done.") });
  await first;
  assert.equal(r.sent.length, 0, "the running say printed that answer, so it is not news");
  await r.relay.onEvent({ type: "firstmate_reply", text: "Done." });
  assert.equal(r.sent.length, 1, "the credit of the say that finished before the connection is stale, and each credit is used once");
});

test("R10: a multipart notice keeps its progress: only the refused chunks are retried, once each, and the receipt waits for the last", async () => {
  const r = rig({ maxChars: 40 });
  const seen = [];
  let refuseSecond = true;
  r.mode = (m) => {
    seen.push(m);
    if (/^\(2\//.test(m) && refuseSecond) return { ok: false, status: 429 };
    r.sent.push(m);
    return { ok: true, status: 200 };
  };
  await r.relay.onUp(r.reads);
  const text = "word ".repeat(30);
  await r.relay.onEvent({ type: "user_turn", text });
  assert.equal(r.sent.length, 1, "the first chunk was accepted, the second refused");
  refuseSecond = false;
  await r.relay.tick();
  assert.ok(r.sent.length > 1);
  assert.equal(new Set(r.sent).size, r.sent.length, "no chunk is accepted twice");
  assert.deepEqual(r.sent.map((m) => /^\((\d+)\//.exec(m)[1]), r.sent.map((_, i) => String(i + 1)), "in order");
  assert.equal(seen.filter((m) => /^\(1\//.test(m)).length, 1, "the accepted chunk is never sent again");
});

test("R11: the switch written between two looks drops the notices waiting for a retry", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  r.mode = "refuse";
  await r.relay.onEvent({ type: "user_turn", text: "kept while on" });
  r.mode = "ok";
  r.epochValue += 1; // off and on again: still on when looked at, but the file was written
  await r.relay.tick();
  await r.relay.onUp(r.reads);
  assert.equal(r.sent.length, 0);
});

test("R12: work begun on a connection that has since been replaced reports nothing and fills nothing in", async () => {
  const gate = deferred();
  const r = rig();
  const a = card("1", { lifecycleId: "1-l1" });
  const readsA = { thread: async () => ({ messages: [] }), past: async () => (await gate.promise, { ending: { how: "chose", actionId: "go", label: "Go ahead", by: "captain", at: 1 }, answers: [] }) };
  await r.relay.onUp(readsA);
  await r.relay.onCards([a]);
  r.relay.sent["1"] = "1-v1";
  const gone = r.relay.onCards([]);
  await wait(30);
  r.relay.onDown();
  await r.relay.onUp({ thread: async () => ({ messages: [] }), past: async () => null });
  await r.relay.onCards([]);
  gate.resolve();
  await gone;
  await r.relay.idle();
  assert.equal(r.sent.length, 1 /* the card itself */);
});

test("R13: when the outbox overflows while a tick is sending the oldest notice, that notice is delivered and exactly the next one is evicted", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  r.mode = "refuse";
  for (let i = 0; i < 100; i += 1) await r.relay.onEvent({ type: "user_turn", text: `message ${i}` });
  r.mode = "ok";
  r.gate = deferred();
  const tick = r.relay.tick();
  await wait(30);
  const overflow = r.relay.onEvent({ type: "user_turn", text: "message 100" });
  await wait(30);
  r.gate.resolve();
  r.gate = null;
  await Promise.all([tick, overflow]);
  await r.relay.tick();
  const got = new Set(r.sent.map((m) => /message (\d+)/.exec(m)[1]));
  assert.equal(got.size, 100);
  assert.ok(got.has("0"), "the one in flight was delivered");
  assert.ok(!got.has("1"), "the next oldest was the one evicted");
  assert.ok(got.has("100"));
});

test("R14: Infinitary republishing a new card's existing thread is history, not a new comment", async () => {
  const r = rig();
  r.reads.thread = async () => ({ messages: [{ id: 4, who: "captain", text: "typed while the bridge was off", at: Date.now() - 60000 }] });
  await r.relay.onUp(r.reads);
  await r.relay.onCards([]);
  await r.relay.onCards([live()]);
  const sentCard = r.sent.length;
  await r.relay.onThread({ cardId: "1", messages: [{ id: 4, who: "captain", text: "typed while the bridge was off", at: Date.now() - 60000 }] });
  assert.equal(r.sent.length, sentCard, "a republished snapshot is not news");
  await r.relay.onThread({ cardId: "1", messages: [{ id: 4, who: "captain", text: "typed while the bridge was off", at: Date.now() - 60000 }, { id: 5, who: "captain", text: "now", at: Date.now() + 60000 }] });
  assert.equal(r.sent.length, sentCard + 1);
  assert.match(r.sent.at(-1), /: now$/);
});

test("R12: a card pass begun on a replaced connection does not delete or overwrite the new connection's receipts", async () => {
  const gate = deferred();
  const r = rig();
  const a = live(card("1"));
  const readsA = { thread: async () => ({ messages: [] }), past: async () => (await gate.promise, null) };
  await r.relay.onUp(readsA);
  await r.relay.onCards([a]);
  const cardSent = r.sent.length;
  r.relay.onCards([]); // card 1 leaves: the old connection waits on its ending read
  await wait(30);
  r.relay.onDown();
  await r.relay.onUp({ thread: async () => ({ messages: [] }), past: async () => null });
  await r.relay.onCards([a]);
  gate.resolve();
  await r.relay.idle();
  assert.equal(r.relay.sent["1"], "1-v1", "the new connection's receipt survives");
  assert.equal(r.sent.length, cardSent, "the card is not sent again");
  await r.relay.onThread({ cardId: "1", messages: [{ id: 1, who: "captain", text: "after reconnect", at: Date.now() + 60000 }] });
  assert.match(r.sent.at(-1), /after reconnect/, "its thread is still followed");
});

test("R1: a comment typed after a snapshot named a card is news even while an earlier delivery stalls", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  const typed = [];
  r.reads.thread = async () => ({ messages: typed });
  r.gate = deferred(); // the webhook stalls on the first snapshot's message
  r.relay.onCards([live()]);
  r.relay.onCards([live(), live(card("3"))]); // the list that names card 3 arrives behind that stalled delivery
  await wait(20);
  typed.push({ id: 1, who: "captain", text: "typed while the webhook was slow", at: Date.now() });
  r.relay.onThread({ cardId: "3", messages: typed });
  await wait(20);
  r.gate.resolve();
  r.gate = null;
  await r.relay.idle();
  assert.match(r.sent.join("\n"), /typed while the webhook was slow/);
});

test("R1: a comment on a card pushed before the card list is read is kept and reported once the card is known", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  const first = { id: 1, who: "captain", text: "typed during connect", at: Date.now() + 60000 };
  r.reads.thread = async () => ({ messages: [] });
  r.relay.onThread({ cardId: "1", messages: [first] });
  await r.relay.onCards([live()]);
  await r.relay.idle();
  assert.match(r.sent.join("\n"), /typed during connect/);
});

test("R11: a notice the switch check itself discards while an earlier one is being sent is not sent", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  r.mode = "refuse";
  await r.relay.onEvent({ type: "user_turn", text: "first words" });
  await r.relay.onEvent({ type: "user_turn", text: "second words" });
  assert.equal(r.relay.outbox.length, 2);
  r.mode = "ok";
  r.gate = deferred();
  const flushed = r.relay.tick(); // sends the first, stalled in the webhook
  await wait(20);
  r.epochValue += 1; // the switch was written meanwhile
  r.gate.resolve();
  r.gate = null;
  await flushed;
  assert.deepEqual(r.sent.map((m) => /first/.test(m)), [true], "the first was already on its way; the second belongs to the time before");
  assert.equal(r.relay.outbox.length, 0);
});

test("R12b: a card pass held behind an earlier delivery does nothing to the receipts once its connection was replaced, even with no known cards", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([live()]); // card 1 delivered and receipted
  const receipt = r.relay.sent["1"];
  assert.ok(receipt);
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  r.gate = deferred();
  r.relay.onCards([live(), live(card("2"))]); // stalls delivering card 2
  r.relay.onDown();
  r.relay.meta = {}; // nothing remembered about card 1: the next pass has no known card to guard it
  await r.relay.onUp(r.reads);
  r.relay.onCards([live(card("3"))]); // a pass that does not show card 1, held behind the stalled delivery
  await wait(20);
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  const newer = r.relay.onCards([live()]); // the newest connection shows card 1
  await wait(20);
  r.gate.resolve();
  r.gate = null;
  await newer;
  await r.relay.idle();
  assert.equal(r.relay.sent["1"], receipt, "the newest connection's receipt for card 1 survives");
  assert.equal(r.sent.filter((m) => /Card 1/.test(m)).length, 1, "card 1 is not sent again");
});

test("R16: a relayed card that ends after the connection began but before its first list is reported; one that ended earlier is not", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([live(), live(card("2"))]);
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  const edge = r.relay.s.connectedAt;
  const ends = { 1: edge + 1000, 2: edge - 1000 };
  r.reads.past = async (id) => ({ id, title: `Card ${id}`, ending: { how: "chose", actionId: "go", label: "Go ahead", by: "captain", at: ends[id] }, answers: [] });
  const before = r.sent.length;
  await r.relay.onCards([]); // the first list: both are gone
  await r.relay.idle();
  const said = r.sent.slice(before).join("\n");
  assert.match(said, /Card 1/);
  assert.doesNotMatch(said, /Card 2/);
});

test("R15 (captain's boundary): a comment timestamped exactly when the connection began is skipped; one a millisecond later is news", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  const edge = r.relay.s.connectedAt;
  const lines = [{ id: 1, who: "captain", text: "at the instant", at: edge }];
  r.reads.thread = async () => ({ messages: lines });
  await r.relay.onCards([live()]);
  lines.push({ id: 2, who: "captain", text: "a moment later", at: edge + 1 });
  await r.relay.onThread({ cardId: "1", messages: lines });
  await r.relay.idle();
  const said = r.sent.join("\n");
  assert.doesNotMatch(said, /at the instant/);
  assert.match(said, /a moment later/);
});

test("R15 (captain's boundary), pushed later: with nothing in the baseline, a pushed line stamped exactly at the connection start is skipped, one a millisecond later is news", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  const edge = r.relay.s.connectedAt;
  await r.relay.onCards([live()]); // the baseline read finds an empty thread
  await r.relay.onThread({ cardId: "1", messages: [{ id: 1, who: "captain", text: "at the instant", at: edge }] });
  await r.relay.onThread({ cardId: "1", messages: [{ id: 1, who: "captain", text: "at the instant", at: edge }, { id: 2, who: "captain", text: "a moment later", at: edge + 1 }] });
  await r.relay.idle();
  const said = r.sent.join("\n");
  assert.doesNotMatch(said, /at the instant/);
  assert.match(said, /a moment later/);
});

test("R17: a relayed card's current offer and lifecycle are kept as snapshots arrive, so an accepted answer to the newest offer is not echoed when the card ends before the next list", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([live()]);
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  const newer = live(card("1", { offerId: "1-v2", lifecycleId: "1-l2" }));
  r.mode = "refuse"; // the new version cannot be delivered: only the descriptor follows it
  await r.relay.onCards([newer]);
  r.mode = "ok";
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  const edge = r.relay.s.connectedAt;
  const done = claim(r.dir, "req-aaaaaaaa", "p3", { subject: { kind: "answer", cardId: "1", lifecycleId: "1-l2", offerId: "1-v2", actionId: "go", answersFp: answersPrint([]) }, holdMs: 60000 });
  finish(done.path, { ok: true }, { outcome: "accepted" });
  r.reads.past = async (id) => ({ id, title: "Card 1", ending: { how: "chose", actionId: "go", label: "Go", by: "captain", at: edge + 1000 }, answers: [] });
  const before = r.sent.length;
  await r.relay.onCards([]);
  await r.relay.idle();
  assert.equal(r.sent.length, before, "Grok bot's own accepted answer to the newest offer is not echoed");
});

test("R16: a receipt file from before descriptors is upgraded by an unchanged card seen on a later list, so its later ending is still reported", async () => {
  const r = rig();
  writeFileSync(join(r.dir, "relay.json"), JSON.stringify({ sent: { 1: "1-v1" }, noticeSent: false, ended: [] }));
  const relay = new Relay({ dir: r.dir, send: r.send, enabled: () => true, epoch: () => 0, pollMs: 5, reads: r.reads });
  await relay.onUp(r.reads);
  await relay.onCards([live()]); // unchanged: nothing is sent, but its descriptor is learned
  assert.equal(r.sent.length, 0);
  relay.onDown();
  await relay.onUp(r.reads);
  const edge = relay.s.connectedAt;
  r.reads.past = async (id) => ({ id, title: "Card 1", ending: { how: "chose", actionId: "go", label: "Go", by: "captain", at: edge + 1000 }, answers: [] });
  await relay.onCards([]);
  await relay.idle();
  assert.match(r.sent.join("\n"), /Card 1/);
});

test("R17: an older offer's delivery finishing after a newer list does not downgrade the card's descriptor, even when the newer offer is rejected", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  r.mode = (m) => (/offer 1-v2/.test(m) ? { ok: false, status: 403, rejected: true } : (r.sent.push(m), { ok: true, status: 200 }));
  r.gate = deferred(); // the first offer's delivery is still in flight when the newer list arrives
  const first = r.relay.onCards([live()]);
  const second = r.relay.onCards([live(card("1", { offerId: "1-v2", lifecycleId: "1-l2" }))]);
  await wait(20);
  r.gate.resolve();
  r.gate = null;
  await first;
  await second;
  await r.relay.idle();
  assert.equal(r.relay.meta["1"].offerId, "1-v2");
  assert.equal(r.relay.meta["1"].lifecycleId, "1-l2");
  r.mode = "ok";
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  const edge = r.relay.s.connectedAt;
  const done = claim(r.dir, "req-bbbbbbbb", "p4", { subject: { kind: "answer", cardId: "1", lifecycleId: "1-l2", offerId: "1-v2", actionId: "go", answersFp: answersPrint([]) }, holdMs: 60000 });
  finish(done.path, { ok: true }, { outcome: "accepted" });
  r.reads.past = async (id) => ({ id, title: "Card 1", ending: { how: "chose", actionId: "go", label: "Go", by: "captain", at: edge + 1000 }, answers: [] });
  const before = r.sent.length;
  await r.relay.onCards([]);
  await r.relay.idle();
  assert.equal(r.sent.length, before, "an accepted answer to the newest offer is not echoed");
});

// A running say holds the ordered work queue; card deliveries do not use it.
function blockQueue(r, label) {
  const running = claim(r.dir, `req-${label}`, `p-${label}`, { subject: { kind: "say", textFp: textPrint(label) }, holdMs: 60000 });
  r.relay.onEvent({ type: "user_turn", text: label });
  return () => finish(running.path, { ok: true }, { outcome: "accepted", replyFp: textPrint("x") });
}

test("R17: while a running reply holds the ordered queue, a newer successful delivery still remembers the newest offer (single card)", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([live()]);
  const release = blockQueue(r, "hold-one");
  await wait(30);
  await r.relay.onCards([live(card("1", { offerId: "1-v2", lifecycleId: "1-l2" }))]);
  assert.equal(r.relay.meta["1"].offerId, "1-v2");
  release();
  await wait(60);
  await r.relay.idle();
  assert.equal(r.relay.meta["1"].offerId, "1-v2", "the lagging refresh does not downgrade it either");
  assert.equal(r.relay.meta["1"].lifecycleId, "1-l2");
});

test("R17: the same through the summary of cards not sent in full", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([live()]);
  const release = blockQueue(r, "hold-two");
  await wait(30);
  const many = [live(card("1", { offerId: "1-v2", lifecycleId: "1-l2" })), ...["2", "3", "4", "5", "6", "7"].map((id) => live(card(id)))];
  await r.relay.onCards(many);
  assert.ok(r.sent.some((m) => /more cards? not sent in full/.test(m)), "card 1 was in the summary");
  assert.equal(r.relay.meta["1"].offerId, "1-v2");
  release();
  await wait(60);
  await r.relay.idle();
  assert.equal(r.relay.meta["1"].offerId, "1-v2");
});

test("R18: cards that vanish before ever being receipted (streaming, or rejected) are not kept", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  r.mode = "refuse";
  await r.relay.onCards([live(card("1", { status: "streaming" })), live(card("2"))]);
  assert.deepEqual(Object.keys(r.relay.meta).sort(), ["1", "2"], "known while a list shows them");
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([]);
  assert.deepEqual(Object.keys(r.relay.meta), []);
  assert.deepEqual(readJson(receiptsPath(r.dir), {}).meta, {}, "nothing saved for them either");
  assert.deepEqual(Object.keys(r.relay.sent), []);
});

// R17 (review at cfd570d): the descriptor of a card Grok bot was told of follows the newest list the moment it arrives,
// whether or not the newer version was delivered and whatever work is still queued. A rejected newer offer, a held queue
// and a reconnect (or a restart) used to leave the older offer saved, so Grok bot's own accepted answer to the newer one
// was reported back as an action taken in Infinitary.
const newer = live(card("1", { offerId: "1-v2", lifecycleId: "1-l2" }));
const crowded = [newer, ...["2", "3", "4", "5", "6", "7"].map((id) => live(card(id)))]; // card 1, the oldest, goes in the summary

async function rejectedNewerOfferWhileHeld(r, label, list, deliver) {
  await r.relay.onUp(r.reads);
  await r.relay.onCards([live()]); // card 1 at offer 1-v1, delivered and receipted
  await r.relay.idle();
  const release = blockQueue(r, label); // a running command holds the ordered queue
  const attempts = [];
  const accept = (m) => (r.sent.push(m), { ok: true, status: 200 });
  r.mode = (m) => (attempts.push(m), deliver(m) ? accept(m) : { ok: false, status: 403, rejected: true });
  const arriving = r.relay.onCards(list);
  const savedOnArrival = readJson(receiptsPath(r.dir), {}).meta?.["1"];
  await arriving; // the webhook definitely refused the newer offer
  r.mode = "ok";
  return { release, attempts, savedOnArrival };
}

async function acceptedAnswerToNewerOfferEnds(r, relay, request) {
  const edge = relay.s.connectedAt;
  const done = claim(r.dir, request, `p-${request}`, { subject: { kind: "answer", cardId: "1", lifecycleId: "1-l2", offerId: "1-v2", actionId: "go", answersFp: answersPrint([]) }, holdMs: 60000 });
  finish(done.path, { ok: true }, { outcome: "accepted" });
  r.reads.past = async (id) => (id === "1" ? { id, title: "Card 1", ending: { how: "chose", actionId: "go", label: "Go", by: "captain", at: edge + 1000 } } : null);
  const before = r.sent.length;
  await relay.onCards([]); // the new connection's first list: card 1 has ended
  await relay.idle();
  return r.sent.slice(before);
}

test("R17: a newer offer the webhook rejects while the queue is held is still the card's descriptor after a reconnect, so Grok bot's accepted answer to it is not echoed (single card)", async () => {
  const r = rig();
  const { release, attempts, savedOnArrival } = await rejectedNewerOfferWhileHeld(r, "rej-single", [newer], (m) => !/1-v2/.test(m));
  assert.ok(attempts.some((m) => /offer 1-v2/.test(m)), "the newer offer was tried and refused");
  r.relay.onDown(); // the queued work belongs to the replaced connection and is dropped
  await r.relay.onUp(r.reads);
  release();
  const said = await acceptedAnswerToNewerOfferEnds(r, r.relay, "answer-rej-single");
  assert.deepEqual(said, [], "Grok bot's own accepted answer to the newest offer is not echoed");
  assert.equal(savedOnArrival?.offerId, "1-v2", "saved the moment the list arrived, before any delivery or queued work");
  assert.equal(savedOnArrival?.lifecycleId, "1-l2");
});

test("R17: the same when the newer offer was only in the rejected summary of cards not sent in full", async () => {
  const r = rig();
  const { release, attempts, savedOnArrival } = await rejectedNewerOfferWhileHeld(r, "rej-summary", crowded, (m) => !/not sent in full/.test(m));
  assert.ok(attempts.some((m) => /not sent in full/.test(m) && /\(card 1\)/.test(m)), "card 1 was only in the refused summary");
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  release();
  const said = await acceptedAnswerToNewerOfferEnds(r, r.relay, "answer-rej-summary");
  assert.deepEqual(said, [], "Grok bot's own accepted answer to the newest offer is not echoed");
  assert.equal(savedOnArrival?.offerId, "1-v2");
});

test("R17: the same across a restart of the bridge instead of a reconnect", async () => {
  const r = rig();
  const { release, savedOnArrival } = await rejectedNewerOfferWhileHeld(r, "rej-restart", [newer], (m) => !/1-v2/.test(m));
  r.relay.onDown(); // the old process's queued work never runs
  release();
  const restarted = new Relay({ dir: r.dir, send: r.send, enabled: () => true, epoch: () => 0, pollMs: 5, reads: r.reads });
  await restarted.onUp(r.reads);
  const said = await acceptedAnswerToNewerOfferEnds(r, restarted, "answer-rej-restart");
  assert.deepEqual(said, [], "Grok bot's own accepted answer to the newest offer is not echoed");
  assert.equal(savedOnArrival?.offerId, "1-v2");
});

// R19 (review at 2e4768a): what the captain did reaches the queue before Grok bot's later command of the same words, so
// only a request begun before the event arrived can be its origin. A message, a first-mate answer or a comment held behind
// a running command used to take the later request's credit: the captain's words were hidden or attributed to the request,
// and Grok bot's own echo was then reported as the captain's.
const afterNow = async () => {
  const t = Date.now();
  while (Date.now() <= t) await wait(1);
};

test("R19: your message to the first mate held behind a running command is reported without waiting for Grok bot's later say of the same words, and that say's turn is still its own echo", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  const release = blockQueue(r, "hold-turn");
  await wait(20);
  r.relay.onEvent({ type: "user_turn", text: "ship it" }); // you, in Infinitary
  await afterNow();
  const say = claim(r.dir, "say-later-aa", "p-say-later-aa", { subject: { kind: "say", textFp: textPrint("ship it") }, holdMs: 60000 });
  r.relay.onEvent({ type: "user_turn", text: "ship it" }); // Grok bot's say of the same words
  release();
  await until(() => r.sent.length === 1, 1000);
  assert.match(r.sent[0], /you told the first mate: ship it/, "yours is reported while Grok bot's say is still running");
  finish(say.path, { ok: true }, { outcome: "accepted", replyFp: textPrint("Done.") });
  r.relay.onEvent({ type: "firstmate_reply", text: "Done." });
  await r.relay.idle();
  assert.equal(r.sent.length, 1, "Grok bot's own turn and the answer it printed are not echoed");
});

test("R19: when Grok bot's later say of the same words has an unclear outcome, your earlier message is still yours and only its own turn is reported as that request's result", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  const release = blockQueue(r, "hold-unclear");
  await wait(20);
  r.relay.onEvent({ type: "user_turn", text: "ship it" });
  await afterNow();
  const say = claim(r.dir, "say-later-bb", "p-say-later-bb", { subject: { kind: "say", textFp: textPrint("ship it") }, holdMs: 60000 });
  mark(say.path, { outcome: "unknown" }); // its acceptance was not confirmed
  r.relay.onEvent({ type: "user_turn", text: "ship it" });
  release();
  await r.relay.idle();
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[0], /^In Infinitary · you told the first mate: ship it$/);
  assert.match(r.sent[1], /^Request say-later-bb \(say\): its outcome is unclear\. The first mate was told: ship it/);
});

test("R19: the first mate's answer to you held behind a running command is reported without waiting for Grok bot's later say, and that say's own answer is not echoed", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  const release = blockQueue(r, "hold-answer");
  await wait(20);
  r.relay.onEvent({ type: "firstmate_reply", text: "Done." }); // the first mate answering you
  await afterNow();
  const say = claim(r.dir, "say-later-cc", "p-say-later-cc", { subject: { kind: "say", textFp: textPrint("go on") }, holdMs: 60000 });
  release();
  await until(() => r.sent.length === 1, 1000);
  assert.match(r.sent[0], /the first mate answered: Done\./, "yours is reported while Grok bot's say is still running");
  r.relay.onEvent({ type: "user_turn", text: "go on" });
  finish(say.path, { ok: true }, { outcome: "accepted", replyFp: textPrint("Done.") });
  r.relay.onEvent({ type: "firstmate_reply", text: "Done." }); // the same words, answering Grok bot
  await r.relay.idle();
  assert.equal(r.sent.length, 1, "Grok bot's say and the answer it printed are not echoed");
});

test("R19: your comment held behind a running command is yours even when Grok bot later replies the same words with an unclear outcome; only its own line is reported as that request's result", async () => {
  const r = rig();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([live()]);
  await r.relay.idle();
  const cardSent = r.sent.length;
  const release = blockQueue(r, "hold-line");
  await wait(20);
  const yours = { id: 1, who: "captain", text: "looks good", cardId: "1", at: Date.now() + 60000 };
  r.relay.onThread({ cardId: "1", messages: [yours] });
  await afterNow();
  const reply = claim(r.dir, "reply-later-aa", "p-reply-later-aa", { subject: { kind: "reply", cardId: "1", lifecycleId: "1-l1", offerId: "1-v1", textFp: textPrint("looks good") }, holdMs: 60000 });
  mark(reply.path, { outcome: "unknown" }); // its send was not confirmed
  const its = { id: 2, who: "captain", text: "looks good", cardId: "1", at: Date.now() + 60000 };
  r.relay.onThread({ cardId: "1", messages: [yours, its] });
  release();
  await r.relay.idle();
  const said = r.sent.slice(cardSent);
  assert.equal(said.length, 2);
  assert.match(said[0], /^In Infinitary · you commented under "Card 1" \(card 1\): looks good$/);
  assert.match(said[1], /^Request reply-later-aa \(reply\): its outcome is unclear\. A comment under "Card 1" \(card 1\) reads: looks good/);
});

// R20 (review at 2e4768a): the hold a reply or say claims is the deadline the relay waits for, so the command must not
// print anything it learns after it. Their holds used to cover only the wait plus 15 seconds, while the send alone may take
// 20 and the confirming reads more, so an answer the relay had already passed on was printed again. Driven under fake time
// with a link whose answers the test times: the command's own deadline is checked, not the link's 20-second timeout.
function timedLink(answers) {
  const link = new EventEmitter();
  link.invoke = (channel) => {
    const { ms = 0, value } = answers[channel] ?? {};
    const answer = () => (typeof value === "function" ? value() : value);
    return ms ? new Promise((resolve) => setTimeout(() => resolve(answer()), ms)) : Promise.resolve(answer());
  };
  return link;
}
const advance = async (t, ms, step = 50) => {
  for (let gone = 0; gone < ms; gone += step) {
    t.mock.timers.tick(step);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
};

for (const [label, replyMs, printedBy] of [["slower than the old hold", 18000, "command"], ["stalled past the command's whole deadline", 50000, "relay"]]) {
  test(`R20: a reply whose send is ${label}: the crewmate's answer reaches Grok bot exactly once, printed or passed on, and its own line is not reported as yours`, async (t) => {
    const r = rig();
    await r.relay.onUp(r.reads);
    await r.relay.onCards([live()]);
    await r.relay.idle();
    const before = r.sent.length;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const text = "Please proceed.";
    let lines = [];
    const link = timedLink({
      "inf:cards:list": { value: [live()] },
      "inf:cards:thread": { value: () => ({ cardId: "1", messages: lines }) },
      "inf:cards:reply": { ms: replyMs, value: () => ({ cardId: "1", messages: lines }) },
    });
    const run = replyToCard(link, r.dir, { cardId: "1", offerId: "1-v1", lifecycleId: "1-l1", requestId: "reply-slow-aa", text, waitMs: 0, pollMs: 20 }).then((v) => ({ v }), (e) => ({ e }));
    await advance(t, 1000);
    // Infinitary wrote Grok bot's line and the crewmate answered it while the reply's own result was still on its way.
    lines = [{ id: 1, who: "captain", text, cardId: "1", at: Date.now() }, { id: 2, who: "crewmate", text: "On it.", cardId: "1", at: Date.now() }];
    r.relay.onThread({ cardId: "1", messages: lines });
    await advance(t, 70000);
    const out = await run;
    await r.relay.idle();
    const said = r.sent.slice(before);
    const printed = (out.v?.answers ?? []).filter((a) => a.text === "On it.").length;
    const passedOn = said.filter((m) => /On it\./.test(m)).length;
    assert.equal(printed + passedOn, 1, "printed by the command or passed on by the relay, not both");
    if (printedBy === "command") assert.equal(printed, 1, "within its deadline the command prints it");
    else assert.match(out.e?.message ?? "", /inf:cards:reply timed out/, "past its deadline the command gives up and the relay passes it on");
    assert.ok(!said.some((m) => /you commented/.test(m)), "Grok bot's own line is not reported as yours");
  });
}

for (const [label, converseMs, printedBy] of [["slower than the old hold", 19000, "command"], ["stalled past the command's whole deadline", 60000, "relay"]]) {
  test(`R20: a say whose acceptance is ${label}: the first mate's answer reaches Grok bot exactly once, and its message is not reported as yours`, async (t) => {
    const r = rig();
    await r.relay.onUp(r.reads);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const text = "Status?";
    const link = timedLink({
      "inf:conversation:state": { value: { busy: false } },
      "inf:converse": { ms: converseMs, value: { ok: true } },
      "inf:conversation:last-turn": { ms: 3000, value: { you: text, reply: { text: "All green." } } },
    });
    const run = sayToFirstMate(link, r.dir, { requestId: "say-slow-aa", text, waitMs: 5000, pollMs: 20 }).then((v) => ({ v }), (e) => ({ e }));
    await advance(t, 1000);
    // Infinitary took the message and the first mate answered while the converse result was still on its way.
    for (const event of [{ type: "user_turn", text }, { type: "firstmate_reply", text: "All green." }]) {
      link.emit("push", "inf:event", event);
      r.relay.onEvent(event);
    }
    await advance(t, 80000);
    const out = await run;
    await r.relay.idle();
    const printed = out.v?.reply?.text === "All green." ? 1 : 0;
    assert.equal(printed + r.sent.filter((m) => /All green\./.test(m)).length, 1, "printed by the command or passed on by the relay, not both");
    if (printedBy === "command") assert.equal(printed, 1, "within its deadline the command prints it");
    else assert.match(out.e?.message ?? "", /acceptance was not confirmed/, "past its deadline the command gives up and the relay passes it on");
    assert.ok(!r.sent.some((m) => /you told the first mate/.test(m)), "Grok bot's own message is not reported as yours");
  });
}

// R21 (review at 2e4768a): a write of the switch drops what waits, and a notice already on its way keeps only the outcome
// of the chunk being sent. One kept as in flight across the write used to stay queued when that chunk was then refused,
// so the next tick or reconnect sent a notice from before the switch; and its later chunks were still sent.
for (const [how, observe] of [
  ["seen by a tick while its chunk is on its way", (r) => (r.epochValue += 1, r.relay.tick())],
  ["the switch seen going off while its chunk is on its way", (r) => (r.epochValue += 1, r.relay.onOff())],
]) {
  test(`R21: a notice being sent when the switch is written (${how}) is not tried again after that chunk is refused`, async () => {
    const r = rig();
    await r.relay.onUp(r.reads);
    const tries = [];
    r.mode = (m) => (tries.push(m), tries.length === 1 ? { ok: false, status: 403, rejected: true } : (r.sent.push(m), { ok: true, status: 200 }));
    r.gate = deferred();
    const notice = r.relay.onEvent({ type: "user_turn", text: "said before the switch" });
    await wait(20);
    const seen = observe(r);
    r.gate.resolve();
    r.gate = null;
    await notice;
    await seen;
    await r.relay.tick();
    await r.relay.onUp(r.reads);
    await r.relay.onEvent({ type: "user_turn", text: "said after the switch" });
    assert.equal(tries.filter((m) => /said before/.test(m)).length, 1, "tried once, refused, then dropped with the switch");
    assert.deepEqual(r.sent.map((m) => /said (before|after)/.exec(m)[1]), ["after"]);
    assert.equal(r.relay.outbox.length, 0);
  });
}

for (const [how, observe] of [
  ["seen by a tick while its first chunk is on its way", (r) => r.relay.tick()],
  ["first seen by the next chunk's own switch check", async () => {}],
]) {
  test(`R21: a multipart notice being sent when the switch is written (${how}) stops after the chunk already on its way`, async () => {
    const r = rig({ maxChars: 40 });
    await r.relay.onUp(r.reads);
    r.gate = deferred();
    const notice = r.relay.onEvent({ type: "user_turn", text: "word ".repeat(30) });
    await wait(20);
    r.epochValue += 1;
    const seen = observe(r);
    r.gate.resolve();
    r.gate = null;
    await notice;
    await seen;
    await r.relay.tick();
    await r.relay.onUp(r.reads);
    assert.equal(r.sent.length, 1, "the chunk on its way was delivered; the rest belongs to the time before the switch");
    assert.match(r.sent[0], /^\(1\//);
    assert.equal(r.relay.outbox.length, 0);
  });
}

// R22 (review at 2e4768a): the captain's retry rule names a 5xx as a delivery that may have happened, never sent again.
// Kept proof through the real webhook sender against a loopback endpoint, on the notice outbox itself.
test("R22: a notice the webhook answers with a 5xx is not sent again by a later notice, a tick or a reconnect", async () => {
  const bodies = [];
  let status = 500;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => (bodies.push(body), res.writeHead(status).end()));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const dir = mkdtempSync(join(tmpdir(), "gb-relay5xx-"));
    const settings = join(dir, "webhook.env");
    writeFileSync(settings, `GROKBOT_WEBHOOK_URL=http://127.0.0.1:${server.address().port}/hook\nGROKBOT_WEBHOOK_AUTH=test-key\n`, { mode: 0o600 });
    const reads = { thread: async () => ({ messages: [] }), past: async () => null, task: async () => null };
    const relay = new Relay({ dir, send: makeSender(settings), enabled: () => true, epoch: () => 0, pollMs: 5, reads });
    await relay.onUp(reads);
    await relay.onEvent({ type: "user_turn", text: "first words" }); // answered 500
    status = 200;
    await relay.onEvent({ type: "user_turn", text: "second words" });
    await relay.tick();
    relay.onDown();
    await relay.onUp(reads);
    await relay.tick();
    assert.deepEqual(bodies.map((b) => /(first|second) words/.exec(b)[1]), ["first", "second"], "the 5xx notice was tried once");
    assert.equal(relay.outbox.length, 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
