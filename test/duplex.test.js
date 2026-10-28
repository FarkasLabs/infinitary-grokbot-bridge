// Intent (GRBP-20, option A): what the captain does in Infinitary reaches Grok bot as "In Infinitary" messages,
// while what Grok bot itself did through answer / reply / ack / say does not come back; merge results and the
// first-mate conversation are included; only what happens while connected; an unclear request is reconciled, not repeated.
// Runs the real daemon and the real commands against a stand-in home at the wire, with a fake webhook and a scratch state folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  const r = { home, dir, sent, lines: [], attempts: 0, webhook: "ok" };
  const send = async (m) => {
    r.attempts += 1;
    if (r.webhook === "refuse") return { ok: false, status: 403, rejected: true };
    if (r.webhook === "unsure") return { ok: false, reason: "request failed (TimeoutError)" };
    return sent.push(m), { ok: true, status: 200 };
  };
  const start = () => runDaemon(dir, { send, pollMs: 20, settlePollMs: 10, tickMs: 100, log: () => {}, ...daemon });
  r.start = start;
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

// Task details shaped like Infinitary's inf:tasks:detail: the task has its own title, and its timeline holds the host's notes.
const taskOf = (id, over = {}) => ({ id, key: `T-${id}`, title: `Task ${id} as the task is named`, status: "open", closedReason: null, events: [], ...over });
const hostNote = (id, text, over = {}) => ({ id, at: Date.now() + 1000, actor: "host", kind: "note", text, data: null, ref: null, feed: true, ...over });
const taskChanged = (taskId, closedReason = null) => ({ type: "task_changed", taskId, key: "T", kind: "work", status: closedReason ? "done" : "open", from: "open", activity: null, closedReason, seq: 1 });

test("merge: the click says merge requested, never merged; the task closing as merged is the result, also when it came before the card's removal", async () => {
  const r = await rig([mergeCard, { ...mergeCard, id: "12", taskId: "t12", offerId: "12-v1", lifecycleId: "12-l1" }]);
  r.home.state.tasks = { t9: taskOf("t9"), t12: taskOf("t12", { status: "done", closedReason: "merged" }) };
  try {
    r.home.state.endCard("9", { how: "chose", actionId: "merge", by: "captain" });
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /^In Infinitary · you pressed "Merge the pull request" on "Ready to merge" \(card 9\): merge requested\. It is not merged yet/);
    r.home.state.tasks.t9 = taskOf("t9", { status: "done", closedReason: "merged" });
    r.home.state.pushEvent(taskChanged("t9", "merged"));
    await until(() => r.news().length === 2);
    assert.equal(r.news()[1], 'Merge result · "Ready to merge" is merged.');
    // Grok bot requests the merge: its click is silent; the task had already closed before the card's removal was published.
    await r.run(["answer", "12", "merge", "--offer", "12-v1", "--lifecycle", "12-l1", "--request", "req-hhhhhhhh", "--confirm"]);
    await until(() => r.news().length === 3);
    assert.equal(r.news()[2], 'Merge result · "Ready to merge" is merged.');
    r.home.state.pushEvent(taskChanged("t12", "merged"));
    await r.quiet();
    assert.equal(r.news().length, 3, "each merge reports once");
  } finally {
    await r.done();
  }
});

test("merge: only Infinitary's own merge refusal is passed on, once; approval bookkeeping, other host notes, failures and a merged reference are not merge outcomes", async () => {
  const r = await rig([mergeCard]);
  const refusal = hostNote(5, "Cannot merge: checks have not passed.", { feed: false, data: { refused: "merge-pr", news: true } });
  r.home.state.tasks = { t9: taskOf("t9", { events: [hostNote(1, "An older refusal", { at: 1, data: { refused: "merge-pr" } })] }) };
  const push = (ev) => (r.home.state.tasks.t9.events.push(ev), r.home.state.pushEvent({ type: "task_event", taskId: "t9", key: "T-9", kind: ev.kind, text: ev.text, at: ev.at, feed: ev.feed }));
  try {
    r.home.state.endCard("9", { how: "chose", actionId: "merge", by: "captain" });
    await until(() => r.news().length === 1);
    push(hostNote(2, "The captain approved merging #4 at abc123.", { data: { mergeAuthorization: "a1", generation: 1, news: true } }));
    push(hostNote(3, "The captain's guidance (mark 1) holds the kept merge.", { data: { mergeGuidance: { mark: 1 }, news: true } }));
    push(hostNote(4, "Some other host note", { data: { news: true } }));
    push(hostNote(6, "Merged pull request #4 (referenced).", { data: { news: true } }));
    push({ ...hostNote(7, "Failed: the crewmate stopped"), kind: "failed" });
    push({ ...hostNote(8, "crewmate progress"), actor: "crewmate" });
    await r.quiet();
    assert.equal(r.news().length, 1, "nothing but the merge's own labelled records is a merge outcome, and nothing was used up");
    push(refusal);
    await until(() => r.news().length === 2);
    push(hostNote(9, "Another host note", { data: { news: true } }));
    r.home.state.pushEvent({ type: "task_event", taskId: "t9", key: "T-9", kind: "note", text: refusal.text, at: 2, feed: false });
    await r.quiet();
    assert.equal(r.news().length, 2);
    assert.equal(r.news()[1], 'Merge refused · "Ready to merge": Infinitary says: Cannot merge: checks have not passed.');
  } finally {
    await r.done();
  }
});

test("a switch write while connected keeps duplex working: an in-app action afterwards is still reported", async () => {
  const r = await rig([plain("8")]);
  try {
    setEnabled(r.dir, true); // `on` again, then off and on: each is a write of the switch
    setEnabled(r.dir, false);
    setEnabled(r.dir, true);
    await until(() => r.daemon.link);
    await wait(1200);
    await until(() => r.daemon.link);
    r.home.state.endCard("8", { how: "chose", actionId: "go", by: "captain" });
    await until(() => r.news().length === 1, 8000);
    assert.match(r.news()[0], /you answered "Card 8"/);
  } finally {
    await r.done();
  }
});

test("a card introduced after connecting: its first comment is sent", async () => {
  const r = await rig([]);
  try {
    r.home.push([plain("20")]);
    await until(() => r.news().length === 1);
    r.home.state.addLine("20", "captain", "first words");
    await until(() => r.news().length === 2);
    assert.match(r.news()[1], /you commented under "Card 20" \(card 20\): first words/);
  } finally {
    await r.done();
  }
});

test("a comment queued behind a running command is still sent when its card is removed right after", async () => {
  const r = await rig([plain("8"), plain("21")], { state: { delayReply: { channel: "inf:cards:act", occurrence: 1, ms: 500 } } });
  try {
    const press = r.run(["answer", "8", "go", ...ids(plain("8")), "--request", "req-iiiiiiii"]);
    await wait(100);
    r.home.state.addLine("21", "captain", "last words");
    r.home.state.endCard("21", { how: "chose", actionId: "go", by: "captain" });
    await press;
    await until(() => r.news().length === 2);
    assert.match(r.news()[0], /you commented under "Card 21" \(card 21\): last words/);
    assert.match(r.news()[1], /you answered "Card 21"/);
  } finally {
    await r.done();
  }
});

test("a say whose echo the daemon was not connected for gives no credit: the same words later are news", async () => {
  const r = await rig([], { state: { answerSay: "Fine." } });
  try {
    r.daemon.stop();
    await r.run(["say", "--request", "req-jjjjjjjj", "--wait", "5"], "status please");
    r.daemon = await r.start();
    await until(() => r.daemon.link);
    r.mark = r.sent.length;
    r.home.state.pushEvent({ type: "user_turn", text: "status please" });
    r.home.state.pushEvent({ type: "firstmate_reply", text: "Fine." });
    await until(() => r.news().length === 2);
  } finally {
    await r.done();
  }
});

test("an unclear reply is reported once for its card version; the same words later are an ordinary comment", async () => {
  const r = await rig([plain("8")], { state: { cutOnReply: true } });
  try {
    await assert.rejects(r.run(["reply", "8", ...ids(plain("8")), "--request", "req-kkkkkkkk", "--wait", "1"], "same words"), /closed/);
    await until(() => r.news().length === 1);
    assert.match(r.news()[0], /^Request req-kkkkkkkk \(reply\): its outcome is unclear\./);
    r.home.state.addLine("8", "captain", "same words");
    await until(() => r.news().length === 2);
    assert.match(r.news()[1], /^In Infinitary · you commented/);
  } finally {
    await r.done();
  }
});

test("a request record is never seen half written while another process updates it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-rec-"));
  const { claim, mark, readRequests } = await import("../src/requests.js");
  const { path } = claim(dir, "req-llllllll", "p", { subject: { kind: "answer", cardId: "1" } });
  const writer = spawn(process.execPath, ["--input-type=module", "-e",
    `import { mark } from ${JSON.stringify(new URL("../src/requests.js", import.meta.url).href)}; for (let i = 0; i < 4000; i++) mark(${JSON.stringify(path)}, { n: i, pad: "x".repeat(2000) });`]);
  let reads = 0;
  while (writer.exitCode === null) {
    const [rec] = readRequests(dir);
    assert.equal(rec?.subject?.cardId, "1", "the record is always there, whole");
    reads += 1;
    await wait(0);
  }
  assert.ok(reads > 5);
  void mark;
});

// Intent (captain's R8 choice): a notice the webhook definitely rejected is kept and retried, in order, once, with its
// receipt written only after acceptance; one whose delivery is uncertain is not sent again.
test("a definitely rejected notice is retried in order after acceptance, once each, and its receipt waits for acceptance", async () => {
  const r = await rig([plain("8"), plain("10")]);
  try {
    r.webhook = "refuse";
    const before = r.attempts;
    r.home.state.endCard("8", { how: "chose", actionId: "go", by: "captain" });
    r.home.state.addLine("10", "captain", "second thing");
    await until(() => r.attempts >= before + 3);
    assert.equal(r.news().length, 0);
    assert.doesNotMatch(readFileSync(join(r.dir, "relay.json"), "utf8"), /"ended":\["8:/, "no receipt while rejected");
    r.webhook = "ok";
    await until(() => r.news().length === 2);
    assert.match(r.news()[0], /you answered "Card 8"/);
    assert.match(r.news()[1], /you commented under "Card 10" \(card 10\): second thing/);
    await r.quiet();
    await wait(300);
    assert.equal(r.news().length, 2, "each is accepted once");
    assert.match(readFileSync(join(r.dir, "relay.json"), "utf8"), /"ended":\["8:8-l1"\]/);
  } finally {
    await r.done();
  }
});

test("a notice whose delivery is uncertain is not sent again", async () => {
  const r = await rig([plain("8")]);
  try {
    r.webhook = "unsure";
    const before = r.attempts;
    r.home.state.endCard("8", { how: "chose", actionId: "go", by: "captain" });
    await until(() => r.attempts > before);
    const tried = r.attempts;
    r.webhook = "ok";
    await wait(500);
    assert.equal(r.attempts, tried);
    assert.equal(r.news().length, 0);
  } finally {
    await r.done();
  }
});

test("only while connected: what happened while cut off is not sent after reconnecting, and a restart does not repeat an ending", async () => {
  const r = await rig([plain("8"), plain("10")]);
  try {
    r.home.hold(); // the connection stays down until released, so the cut-off window is not a race with the reconnect
    r.home.kick();
    await until(() => !r.daemon.link);
    r.home.state.endCard("8", { how: "chose", actionId: "go", by: "captain" });
    r.home.state.addLine("10", "captain", "typed while away");
    r.home.release();
    await until(() => r.daemon.link && r.daemon.relay.s.seen.has("10"), 8000); // the reconnected session has taken in the card
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
