// Intent: read the webhook settings from a file as data (never sourced), by strict rules, and never leak them.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWebhook, makeSender } from "../src/webhook.js";

const file = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), "gb-hook-")), "w.env");
  writeFileSync(p, text, { mode: 0o600 });
  return p;
};

test("only the two known settings, https, a bare key", () => {
  assert.deepEqual(loadWebhook(file("GROKBOT_WEBHOOK_URL=https://h.example/x\nGROKBOT_WEBHOOK_AUTH=abc\n")), { url: "https://h.example/x", auth: "abc" });
  for (const bad of [
    "GROKBOT_WEBHOOK_URL=http://h.example/x\nGROKBOT_WEBHOOK_AUTH=abc",
    "GROKBOT_WEBHOOK_URL=https://h.example/x\nGROKBOT_WEBHOOK_AUTH=Bearer abc",
    "GROKBOT_WEBHOOK_URL=https://h.example/x\nOTHER=1\nGROKBOT_WEBHOOK_AUTH=abc",
    "GROKBOT_WEBHOOK_URL=https://u:p@h.example/x\nGROKBOT_WEBHOOK_AUTH=abc",
    "GROKBOT_WEBHOOK_URL=https://h.example/x",
  ]) assert.ok(loadWebhook(file(bad)).problem, bad);
  assert.ok(loadWebhook("/nonexistent/path").problem);
});

test("one POST, text/plain, bearer, no redirect, no retry; failures name no value", async () => {
  const calls = [];
  const p = file("GROKBOT_WEBHOOK_URL=https://h.example/secret-path\nGROKBOT_WEBHOOK_AUTH=KEY123\n");
  const ok = await makeSender(p, { fetchImpl: async (u, o) => (calls.push([u, o]), { status: 200 }) })("hi");
  assert.deepEqual(ok, { ok: true, status: 200 });
  const [url, opts] = calls[0];
  assert.equal(url, "https://h.example/secret-path");
  assert.equal(opts.redirect, "manual");
  assert.equal(opts.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(opts.headers.authorization, "Bearer KEY123");
  const bad = await makeSender(p, { fetchImpl: async () => { throw new Error("boom KEY123 secret-path"); } })("hi");
  assert.equal(bad.ok, false);
  assert.doesNotMatch(JSON.stringify(bad), /KEY123|secret-path/);
  assert.equal(calls.length, 1);
});
