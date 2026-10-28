// Intent (GRBP-26 re-review): the relay's own invariants, driven directly with deferred reads and a controllable webhook:
// a new card's first line stays news, a say running across a reconnect is correlated, a multipart notice keeps its
// progress, the switch changing drops waiting notices, work from a replaced connection is dropped, and the outbox
// evicts by identity.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claim, finish, textPrint, answersPrint } from "../src/requests.js";
import { Relay } from "../src/relay.js";
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
  assert.equal(r.relay.latest.size, 2);
  r.relay.onDown();
  await r.relay.onUp(r.reads);
  await r.relay.onCards([]);
  assert.equal(r.relay.latest.size, 0);
  assert.deepEqual(Object.keys(r.relay.sent), []);
});
