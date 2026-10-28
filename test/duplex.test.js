// Intent (GRBP-20, option A): what the captain does in Infinitary reaches Grok bot as "In Infinitary" messages,
// while what Grok bot itself did through answer / reply / ack / say does not come back; merge results and the
// first-mate conversation are included; only what happens while connected; an unclear request is reconciled, not repeated.
// Runs the real daemon and the real commands against a stand-in home at the wire, with a fake webhook and a scratch state folder.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { runDaemon } from "../src/daemon.js";
import { pair } from "../src/pair.js";
import { setEnabled } from "../src/state.js";
import { card, startHome } from "./standin.js";

const questions = readFileSync(new URL("./fixtures/release-questions.html", import.meta.url), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (await f()) return;
  assert.fail("timed out waiting");
};
const ids = (c) => ["--offer", c.offerId, "--lifecycle", c.lifecycleId];
const decision = card("7", { body: questions, taskId: "t7", actions: [{ id: "build", label: "Approve and build", default: true }, { id: "later", label: "Save and defer" }] });
const mergeCard = card("9", { taskId: "t9", title: "Ready to merge", actions: [{ id: "merge", label: "Merge the pull request", default: true, effect: { kind: "request_merge", review: "r1" } }, { id: "later", label: "Later" }] });
const note = card("5", { actions: [] });
const plain = (n, over) => card(n, { actions: [{ id: "go", label: "Go ahead", default: true }, { id: "later", label: "Not now" }], ...over });

async function rig(cards, { state = {}, daemon = {} } = {}) {
  const home = await startHome({ cards });
  Object.assign(home.state, state);
  const dir = mkdtempSync(join(tmpdir(), "gb-duplex-"));
  await pair(home.link(), dir);
  setEnabled(dir, true);
  const sent = [];
  const send = async (m) => (sent.push(m), { ok: true, status: 200 });
  const start = () => runDaemon(dir, { send, pollMs: 20, settlePollMs: 10, log: () => {}, ...daemon });
  const r = { home, dir, sent, start, lines: [] };
  const env = { ...process.env, GROKBOT_BRIDGE_HOME: dir, GROKBOT_BRIDGE_POLL_MS: "20" };
  r.run = (argv, stdin = "") => main(argv, { out: (s) => r.lines.push(s), env, stdin: Object.assign((async function* () { yield stdin; })(), { isTTY: false }) });
  r.daemon = await start();
  await until(() => r.daemon.link && sent.length >= cards.filter((c) => c.status !== "streaming").length);
  r.mark = sent.length;
  r.news = () => sent.slice(r.mark);
  r.quiet = async () => (await wait(250), await r.daemon.relay.idle(), await wait(50));
  r.done = async () => (r.daemon.stop(), home.close());
  return r;
}

test("a choice made in Infinitary sends one message with the card, the button and each answer; Grok bot's own press sends none", async () => {
  const r = await rig([decision, plain("8")]);
  try {
    r.home.state.endCard("7", { how: "chose", actionId: "build", by: "captain" }, [
      { name: "target", values: ["staging"], labels: ["To the staging environment"] }, { name: "notify", values: [], written: "only people on call" }]);
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /^In Infinitary · you answered "Card 7" \(card 7\) with "Approve and build"\./);
    assert.match(r.news()[0], /- target: To the staging environment/);
    assert.match(r.news()[0], /- notify: "only people on call"/);
    // Grok bot presses on card 8: the card ends, and nothing about it comes back.
    await r.run(["answer", "8", "go", ...ids(plain("8")), "--request", "req-aaaaaaaa"]);
    assert.match(r.lines.at(-1), /Pressed "Go ahead"/);
    await r.quiet();
    assert.equal(r.news().length, 1);
  } finally {
    await r.done();
  }
});

test("a note closed in Infinitary sends one line; Grok bot's ack sends none; a withdrawn card or retired task sends none", async () => {
  const r = await rig([note, card("6", { actions: [] }), plain("8"), plain("10")]);
  try {
    r.home.state.endCard("5", { how: "dismissed" });
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /^In Infinitary · you closed the note "Card 5" \(card 5\)/);
    await r.run(["ack", "6", ...ids(card("6")), "--request", "req-bbbbbbbb"]);
    r.home.state.endCard("8", { how: "author-withdrawal", by: "crewmate" });
    r.home.state.endCard("10", { how: "task-retired", by: "host" });
    await r.quiet();
    assert.equal(r.news().length, 1);
  } finally {
    await r.done();
  }
});

test("a press in flight while the card ends is waited for, not guessed: accepted is silent, a different button is told", async () => {
  const r = await rig([plain("8"), plain("11")], { state: { delayReply: { channel: "inf:cards:act", occurrence: 1, ms: 400 } } });
  try {
    const first = r.run(["answer", "8", "go", ...ids(plain("8")), "--request", "req-cccccccc"]);
    await wait(150);
    await first;
    await r.quiet();
    assert.equal(r.news().length, 0, "the card left before the home answered the press, yet Grok bot hears nothing extra");
    // The captain's own press of the other button gets told.
    r.home.state.endCard("11", { how: "chose", actionId: "later", by: "captain" });
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /"Not now"/);
  } finally {
    await r.done();
  }
});

test("a Grok bot press that Infinitary ignored says so (not Pressed) and the captain's own choice is sent", async () => {
  const r = await rig([plain("8")], { state: { beatBy: "later" } });
  try {
    await r.run(["answer", "8", "go", ...ids(plain("8")), "--request", "req-dddddddd"]);
    assert.match(r.lines.at(-1), /^Infinitary did not take it: The card had already ended in Infinitary before this press: "Not now" was chosen\./);
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /you answered "Card 8" \(card 8\) with "Not now"/);
    const rec = JSON.parse(readFileSync(join(r.dir, "requests", "req-dddddddd.json"), "utf8"));
    assert.equal(rec.outcome, "refused");
  } finally {
    await r.done();
  }
});

test("a press whose outcome is unknown is sent as that request's result, names no presser, and is never sent again", async () => {
  const r = await rig([plain("8")], { state: { cutOnAct: true } });
  try {
    await assert.rejects(r.run(["answer", "8", "go", ...ids(plain("8")), "--request", "req-eeeeeeee"]), /closed/);
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /^Request req-eeeeeeee \(answer\): its outcome is unclear\./);
    assert.doesNotMatch(r.news()[0], /you answered|you pressed/);
    r.home.state.cutOnAct = false;
    await assert.rejects(r.run(["answer", "8", "go", ...ids(plain("8")), "--request", "req-eeeeeeee"]), /outcome is not known/);
    assert.equal(r.home.state.changes.filter((c) => c.channel === "inf:cards:act").length, 1, "the effect was not reissued");
  } finally {
    await r.done();
  }
});

test("thread: your comment in the app and a crewmate's or first mate's answer are sent; Grok bot's reply and the answer it printed are not", async () => {
  const r = await rig([plain("8")], { state: { answerReply: "Linux checked" } });
  try {
    r.home.state.addLine("8", "captain", "also check Linux");
    r.home.state.addLine("8", "host", "Revised.");
    r.home.state.addLine("8", "firstmate", "On it.");
    await until(() => r.news().length === 2);
    assert.match(r.news()[0], /^In Infinitary · you commented under "Card 8" \(card 8\): also check Linux/);
    assert.match(r.news()[1], /the first mate answered under "Card 8" \(card 8\): On it\./);
    await r.run(["reply", "8", ...ids(plain("8")), "--request", "req-ffffffff", "--wait", "5"], "from grok bot");
    assert.match(r.lines.join("\n"), /crewmate: Linux checked/);
    await r.quiet();
    assert.equal(r.news().length, 2, "neither Grok bot's own line nor the answer it printed comes back");
    // An answer that came after the reply finished was not printed, so it is news.
    r.home.state.addLine("8", "crewmate", "Later thought");
    await until(() => r.news().length === 3);
    assert.match(r.news()[2], /crewmate answered .*Later thought/);
  } finally {
    await r.done();
  }
});

test("conversation: your message to the first mate and its answer are sent; those of Grok bot's say are not", async () => {
  const r = await rig([], { state: { answerSay: "Fine." } });
  try {
    await r.run(["say", "--request", "req-gggggggg", "--wait", "5"], "status please");
    assert.match(r.lines.join("\n"), /First mate: Fine\./);
    await r.quiet();
    assert.equal(r.news().length, 0);
    r.home.state.pushEvent({ type: "user_turn", text: "status please" });
    r.home.state.pushEvent({ type: "firstmate_reply", text: "Fine." });
    await until(() => r.news().length === 2);
    assert.equal(r.news()[0], "In Infinitary · you told the first mate: status please");
    assert.equal(r.news()[1], "In Infinitary · the first mate answered: Fine.", "the same words later are news: the echo allowance was used once");
  } finally {
    await r.done();
  }
});

test("merge: the click says merge requested, never merged, and the later result is sent, also after a Grok bot merge request", async () => {
  const r = await rig([mergeCard, { ...mergeCard, id: "12", taskId: "t12", offerId: "12-v1", lifecycleId: "12-l1" }]);
  try {
    r.home.state.endCard("9", { how: "chose", actionId: "merge", by: "captain" });
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /^In Infinitary · you pressed "Merge the pull request" on "Ready to merge" \(card 9\): merge requested\. It is not merged yet/);
    r.home.state.pushEvent({ type: "task_changed", taskId: "t9", key: "T-9", kind: "work", status: "done", from: "open", activity: null, closedReason: "merged", seq: 3 });
    await until(() => r.news().length === 2);
    assert.equal(r.news()[1], 'Merge result · "Ready to merge" is merged.');
    // Grok bot requests the merge: its click is silent, its result is not.
    await r.run(["answer", "12", "merge", "--offer", "12-v1", "--lifecycle", "12-l1", "--request", "req-hhhhhhhh", "--confirm"]);
    await r.quiet();
    assert.equal(r.news().length, 2);
    r.home.state.pushEvent({ type: "task_event", taskId: "t12", key: "T-12", kind: "failed", text: "Failed: checks did not pass", at: 1, feed: true });
    await until(() => r.news().length === 3);
    assert.equal(r.news()[2], 'Merge result · "Ready to merge" did not merge: Failed: checks did not pass');
    r.home.state.pushEvent({ type: "task_changed", taskId: "t12", key: "T-12", kind: "work", status: "done", from: "open", activity: null, closedReason: "merged", seq: 4 });
    await r.quiet();
    assert.equal(r.news().length, 3, "each merge reports once");
  } finally {
    await r.done();
  }
});

test("only while connected: what happened while cut off is not sent after reconnecting, and a restart does not repeat an ending", async () => {
  const r = await rig([plain("8"), plain("10")]);
  try {
    r.home.kick();
    await until(() => !r.daemon.link);
    r.home.state.endCard("8", { how: "chose", actionId: "go", by: "captain" });
    r.home.state.addLine("10", "captain", "typed while away");
    await until(() => r.daemon.link, 8000);
    await r.quiet();
    assert.equal(r.news().length, 0, "no catch-up of actions taken while disconnected");
    r.home.state.addLine("10", "captain", "typed now");
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /typed now/);
    r.home.state.endCard("10", { how: "chose", actionId: "go", by: "captain" });
    await until(() => r.news().length === 2);
    r.daemon.stop();
    r.daemon = await r.start();
    await r.quiet();
    assert.equal(r.news().length, 2, "a restart sends nothing again");
    assert.match(readFileSync(join(r.dir, "relay.json"), "utf8"), /"ended":\["10:10-l1"\]/);
  } finally {
    await r.done();
  }
});

test("switched off: nothing is sent about what happens in Infinitary", async () => {
  const r = await rig([plain("8")]);
  try {
    setEnabled(r.dir, false);
    await until(() => !r.daemon.link);
    r.home.state.endCard("8", { how: "chose", actionId: "go", by: "captain" });
    await r.quiet();
    assert.equal(r.news().length, 0);
    assert.ok(readdirSync(r.dir).length > 0);
  } finally {
    await r.done();
  }
});
