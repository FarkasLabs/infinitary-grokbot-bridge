// Intent: "full text, questions and buttons, plus a page on request" for every card, notes included.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cardPage, sanitizeBody } from "../src/page.js";
import { cardMessage, chunk, htmlToText } from "../src/text.js";
import { card } from "./standin.js";

const questions = readFileSync(new URL("./fixtures/release-questions.html", import.meta.url), "utf8");

test("questions and their options survive as text, with the recommended one marked", () => {
  const text = htmlToText(questions);
  assert.match(text, /Question: 1\. Where should this build be deployed\?/);
  assert.match(text, /\( \) To the staging environment \(recommended\)/);
  assert.match(text, /\( \) Something else \(write in your own words\)/);
  assert.match(text, /Question: 3\. Who should be told when the deploy finishes\?/);
  assert.equal((text.match(/To the staging environment/g) ?? []).length, 1, "an option prints once");
});

test("a note says no answer is needed; a decision lists every button with its id", () => {
  const note = cardMessage(card("1", { actions: [], title: "Done" }));
  assert.match(note, /^Note · no answer needed · Done/);
  const decision = cardMessage(card("2", { actions: [{ id: "merge", label: "Merge", default: true }, { id: "later", label: "Not now" }] }), { updated: true });
  assert.match(decision, /^Updated · Decision · Card 2/);
  assert.match(decision, /- Merge \(default\) \[merge\]\n- Not now \[later\]/);
  assert.match(decision, /card 2\b/);
});

test("a host-authored card with buttons reads as attention", () => {
  assert.match(cardMessage(card("3", { author: "host" })), /^Attention/);
});

test("long text is split in order at paragraph edges, each part under the limit", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"x".repeat(100)}`).join("\n\n");
  const parts = chunk(text, 1000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 1000 + 12));
  assert.match(parts[0], /^\(1\/\d+\)/);
});

test("the page keeps the card's body but drops script, handlers, frames and remote loads", () => {
  const hostile = `<p onclick="x()">Hi</p><script>fetch('//evil')</script><iframe src="//evil"></iframe>
    <img src="https://evil/x.png" alt="remote"><img src="data:image/png;base64,AAAA" alt="ok"><style>@import url(//evil.css);p{color:red}</style>
    <input type="radio" name="a" checked>`;
  const clean = sanitizeBody(hostile);
  assert.doesNotMatch(clean, /script|iframe|onclick|evil|@import/i);
  assert.match(clean, /<input[^>]* disabled/);
  assert.match(clean, /data:image\/png/);
  const page = cardPage(card("4", { body: questions }), {});
  assert.match(page, /Content-Security-Policy[^>]*default-src 'none'/);
  assert.match(page, /<legend>1\. Where should this build be deployed\?<\/legend>/);
  assert.match(page, /Buttons are shown for reading/);
});
