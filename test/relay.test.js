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
