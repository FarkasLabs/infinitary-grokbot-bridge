// Intent: every card is relayed: every change resent as Updated, catch-up max five plus a summary,
// one notice after ten minutes away and one when back, nothing while disabled.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Relay } from "../src/relay.js";
import { card } from "./standin.js";

function rig(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gb-relay-"));
  const r = { sent: [], on: true, t: 0, fail: false };
  r.make = () => new Relay({ dir, send: async (m) => (r.fail ? { ok: false, status: 500 } : (r.sent.push(m), { ok: true, status: 200 })), enabled: () => r.on, now: () => r.t, ...over });
  r.relay = r.make();
  r.dir = dir;
  return r;
}

test("seven unsent cards: the newest five in full, one line listing the rest, none again later", async () => {
  const r = rig();
  const cards = Array.from({ length: 7 }, (_, i) => card(String(i + 1)));
  await r.relay.onCards(cards);
  assert.equal(r.sent.length, 6);
  assert.match(r.sent[5], /^2 more cards not sent in full:\n- Card 1 \(card 1\)\n- Card 2 \(card 2\)/);
  await r.relay.onCards(cards);
  assert.equal(r.sent.length, 6, "a second look sends nothing");
  assert.equal(r.make().sent["7"], "7-v1", "receipts survive a restart");
});

test("a changed card is resent marked Updated, a note is sent too, an unchanged one is not", async () => {
  const r = rig();
  await r.relay.onCards([card("1"), card("2", { actions: [] })]);
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1], /^Note · no answer needed/);
  await r.relay.onCards([card("1", { offerId: "1-v2", body: "<p>Changed</p>" }), card("2", { actions: [] })]);
  assert.equal(r.sent.length, 3);
  assert.match(r.sent[2], /^Updated · Decision/);
});

test("a card still being written waits until it is ready", async () => {
  const r = rig();
  await r.relay.onCards([card("1", { status: "streaming" })]);
  assert.equal(r.sent.length, 0);
  await r.relay.onCards([card("1")]);
  assert.equal(r.sent.length, 1);
});

test("while disabled nothing is sent and nothing is marked sent; switching on catches up", async () => {
  const r = rig();
  r.on = false;
  await r.relay.onCards([card("1")]);
  r.relay.onDown();
  r.t = 11 * 60 * 1000;
  await r.relay.tick();
  await r.relay.onUp();
  assert.equal(r.sent.length, 0);
  r.on = true;
  await r.relay.onCards([card("1")]);
  assert.equal(r.sent.length, 1);
});

test("away ten minutes: one notice, then one when back; back within ten minutes says nothing", async () => {
  const r = rig();
  r.relay.onDown();
  r.t = 9 * 60 * 1000;
  await r.relay.tick();
  await r.relay.onUp();
  assert.equal(r.sent.length, 0);
  r.relay.onDown();
  r.t += 10 * 60 * 1000;
  await r.relay.tick();
  await r.relay.tick();
  assert.equal(r.sent.length, 1, "said once");
  assert.match(r.sent[0], /ten minutes/);
  await r.relay.onUp();
  await r.relay.onUp();
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1], /back/);
});

test("a refused send is not marked sent, so the next look tries again; receipts hold no secret", async () => {
  const r = rig();
  r.fail = true;
  await r.relay.onCards([card("1")]);
  assert.equal(r.relay.sent["1"], undefined);
  r.fail = false;
  await r.relay.onCards([card("1")]);
  assert.equal(r.sent.length, 1);
  assert.doesNotMatch(readFileSync(join(r.dir, "relay.json"), "utf8"), /Bearer|token/i);
});

// Intent: GRBP-17. Infinitary keeps a crewmate's new card off the captain's stage (awaiting set,
// no sentBackAt) until the crewmate closes out, and refuses a choice on it; the relay must not
// offer it early, and must offer it once when it reaches the stage even though its offer is unchanged.
test("a card still with its author is held, then sent once when it reaches the stage with the same offer", async () => {
  const r = rig();
  const held = card("1", { awaiting: "close-out" });
  await r.relay.onCards([held, card("2")]);
  assert.equal(r.sent.length, 1, "only the card on the stage goes");
  assert.match(r.sent[0], /Card 2/);
  assert.equal(r.relay.sent["1"], undefined);
  await r.relay.onCards([held, card("2")]);
  assert.equal(r.sent.length, 1, "still held");
  const released = card("1", { awaiting: "close-out", sentBackAt: 9 });
  assert.equal(released.offerId, held.offerId, "a close-out does not change the offer");
  await r.relay.onCards([released, card("2")]);
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1], /^Decision/, "first delivery, not marked Updated");
  assert.match(r.sent[1], /Card 1/);
  await r.relay.onCards([released, card("2")]);
  assert.equal(r.sent.length, 2, "not again");
  assert.equal(r.make().sent["1"], "1-v1", "the receipt survives a restart");
});

test("a held card withdrawn before it reached the stage is never sent", async () => {
  const r = rig();
  await r.relay.onCards([card("1", { awaiting: "close-out" })]);
  await r.relay.onCards([]);
  assert.equal(r.sent.length, 0);
});

test("a card that closed out before the relay first looked is sent as soon as it is seen", async () => {
  const r = rig();
  await r.relay.onCards([card("1", { awaiting: "answer", sentBackAt: 5 })]);
  assert.equal(r.sent.length, 1);
});
