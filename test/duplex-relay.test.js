// Intent (GRBP-26 re-review): the relay's own invariants, driven directly with deferred reads and a controllable webhook:
// a new card's first line stays news, a say running across a reconnect is correlated, a multipart notice keeps its
// progress, the switch changing drops waiting notices, work from a replaced connection is dropped, and the outbox
// evicts by identity.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claim, finish, textPrint } from "../src/requests.js";
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
  r.reads.thread = async () => (await gate.promise, { messages: [{ id: 1, who: "captain", text: "first words" }] });
  await r.relay.onUp(r.reads);
  await r.relay.onCards([]);
  await r.relay.onCards([live()]);
  const sentCard = r.sent.length;
  r.relay.onThread(thread("1", [1, "captain", "first words"]));
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
