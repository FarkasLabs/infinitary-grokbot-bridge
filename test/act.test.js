// Intent: acting - authenticated answers, replies, first-mate messages and explicit merge
// relay, with current-offer checks and request-id idempotency, against a stand-in home at the wire.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { checkAnswers } from "../src/questions.js";
import { pair } from "../src/pair.js";
import { setEnabled } from "../src/state.js";
import { card, startHome } from "./standin.js";

const questions = readFileSync(new URL("./fixtures/release-questions.html", import.meta.url), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "gb-act-"));

async function setup(cards, over = {}) {
  const home = await startHome({ cards });
  Object.assign(home.state, over);
  const dir = tmp();
  await pair(home.link(), dir);
  setEnabled(dir, true);
  const env = { ...process.env, GROKBOT_BRIDGE_HOME: dir, GROKBOT_BRIDGE_POLL_MS: "20" };
  const lines = [];
  const run = (argv, stdin = "") => main(argv, { out: (s) => lines.push(s), env, stdin: Object.assign((async function* () { yield stdin; })(), { isTTY: false }) });
  return { home, dir, lines, run };
}
const ids = (c) => ["--offer", c.offerId, "--lifecycle", c.lifecycleId];
const plain = card("6", { actions: [{ id: "go", label: "Go ahead", default: true }, { id: "later", label: "Not now" }] });
const decision = card("7", { body: questions, actions: [{ id: "build", label: "Approve and build", default: true }, { id: "later", label: "Save and defer" }] });

test("an answer reaches the home as the captain's footer click, with the offer, lifecycle and checked answers", async () => {
  const { home, run, lines } = await setup([decision]);
  try {
    const answers = { answers: [{ name: "target", values: ["staging"] }, { name: "notify", values: [], written: "only people on call" }] };
    await run(["answer", "7", "build", ...ids(decision), "--request", "req-aaaaaaaa"], JSON.stringify(answers));
    assert.match(lines.at(-1), /Pressed "Approve and build" on card 7/);
    assert.equal(home.state.hellos.at(-1).protocolVersion, "12.0.0", "the acting link speaks the home's own major");
    const [call] = home.state.changes;
    assert.equal(call.channel, "inf:cards:act");
    const [cardId, actionId, source, value, submission] = call.args;
    assert.deepEqual([cardId, actionId, source], ["7", "build", "chrome"]);
    assert.deepEqual(value.answers.map((a) => a.name), ["target", "notify"]);
    assert.deepEqual(value.answers[0], { name: "target", values: ["staging"], labels: ["To the staging environment"], changed: true });
    assert.equal(value.answers[1].written, "only people on call");
    assert.deepEqual(submission, { id: "req-aaaaaaaa", lifecycleId: "7-l1", offerId: "7-v1", reading: "none" });
  } finally {
    await home.close();
  }
});

test("a stale offer, a reopened card, a missing id and an unready card are refused before anything is sent", async () => {
  const { home, run } = await setup([decision, card("8", { status: "streaming" })]);
  try {
    await assert.rejects(run(["answer", "7", "build", "--offer", "7-v0", "--lifecycle", "7-l1", "--request", "req-bbbbbbbb"]), /has changed since you read it/);
    await assert.rejects(run(["answer", "7", "build", "--offer", "7-v1", "--lifecycle", "7-l0", "--request", "req-bbbbbbbb"]), /has changed since you read it/);
    await assert.rejects(run(["answer", "7", "build", "--request", "req-bbbbbbbb"]), /Name the card's current offer/);
    await assert.rejects(run(["answer", "9", "build", ...ids(decision), "--request", "req-bbbbbbbb"]), /no longer showing/);
    await assert.rejects(run(["answer", "8", "go", ...ids(card("8")), "--request", "req-bbbbbbbb"]), /not ready/);
    await assert.rejects(run(["answer", "7", "nope", ...ids(decision), "--request", "req-bbbbbbbb"]), /no button nope/);
    await assert.rejects(run(["answer", "7", "build", ...ids(decision)]), /fresh id/);
    assert.equal(home.state.changes.length, 0);
  } finally {
    await home.close();
  }
});

test("a replayed request id does nothing twice; a reused id for other content, and an unknown outcome, are refused", async () => {
  const { home, run, lines, dir } = await setup([plain]);
  try {
    const args = ["answer", "6", "later", ...ids(plain), "--request", "req-cccccccc"];
    await run(args);
    await run(args);
    assert.match(lines.at(-1), /^Already done: Pressed/);
    assert.equal(home.state.changes.length, 1);
    // Replays answer from the record even after the card moved on.
    home.state.cards = [];
    await run(args);
    assert.match(lines.at(-1), /^Already done/);
    await assert.rejects(run(["answer", "6", "go", ...ids(plain), "--request", "req-cccccccc"]), /different request/);
    // A claim with no result is an unsent-or-unknown outcome: never sent again.
    home.state.cards = [plain];
    const { claim, fingerprint } = await import("../src/requests.js");
    claim(dir, "req-dddddddd", fingerprint(["answer", "6", "later", "6-v1", "6-l1", [], false]));
    await assert.rejects(run(["answer", "6", "later", ...ids(plain), "--request", "req-dddddddd"]), /outcome is not known/);
    assert.equal(home.state.changes.length, 1);
    assert.equal(statSync(join(dir, "requests")).mode & 0o777, 0o700);
  } finally {
    await home.close();
  }
});

test("two runs of one request id at once send once", async () => {
  const { home, run } = await setup([plain]);
  try {
    const args = ["answer", "6", "later", ...ids(plain), "--request", "req-eeeeeeee"];
    const results = await Promise.allSettled([run(args), run(args)]);
    assert.equal(home.state.changes.length, 1);
    assert.equal(results.filter((r) => r.status === "fulfilled").length >= 1, true);
  } finally {
    await home.close();
  }
});

test("merge, discard and kept writes need --confirm; buttons that open Infinitary's own pages cannot be pressed", async () => {
  const merge = card("5", {
    requiredActions: [{ id: "install", target: "x", title: "Install", consequence: "c", instructions: ["a"], criterion: "k", prerequisites: [], completion: { kind: "manual", label: "done" } }],
    actions: [{ id: "merge", label: "Merge the branch", default: true, effect: { kind: "settle", mode: "merge" } }, { id: "settings", label: "Open settings", effect: { kind: "open", target: "settings" } }],
  });
  const { home, run, lines } = await setup([merge]);
  try {
    await run(["show", "5"]).catch(() => {});
    await assert.rejects(run(["answer", "5", "merge", ...ids(merge), "--request", "req-ffffffff"]), /merge\. Say so explicitly by adding --confirm/);
    await assert.rejects(run(["answer", "5", "settings", ...ids(merge), "--request", "req-ffffffff"]), /needs your computer/);
    assert.equal(home.state.changes.length, 0);
    await run(["answer", "5", "merge", ...ids(merge), "--confirm", "--request", "req-ffffffff"]);
    const [call] = home.state.changes;
    assert.equal(call.args[1], "merge");
    assert.equal(call.args[4].offerId, "5-v1", "a merge with required actions carries the current offer and lifecycle");
    assert.match(lines.at(-1), /Pressed "Merge the branch"/);
  } finally {
    await home.close();
  }
});

test("the home's refusal is reported and recorded, not retried", async () => {
  const { home, run, lines } = await setup([plain], { refuseAct: "This card changed." });
  try {
    await run(["answer", "6", "later", ...ids(plain), "--request", "req-gggggggg"]);
    assert.match(lines.at(-1), /Infinitary did not take it: This card changed\./);
    home.state.refuseAct = undefined;
    await run(["answer", "6", "later", ...ids(plain), "--request", "req-gggggggg"]);
    assert.equal(home.state.changes.length, 1);
  } finally {
    await home.close();
  }
});

test("answers are checked against the card's own questions", () => {
  const c = { body: questions };
  assert.throws(() => checkAnswers(c, [{ name: "nope", values: ["x"] }]), /asks no question named/);
  assert.throws(() => checkAnswers(c, [{ name: "target", values: ["mars"] }]), /does not offer/);
  assert.throws(() => checkAnswers(c, [{ name: "target", values: ["staging", "production"] }]), /takes one answer/);
  assert.throws(() => checkAnswers(c, [{ name: "notes", values: [], written: "" }]), /written must be words/);
  assert.throws(() => checkAnswers({ body: '<input type="radio" name="a" value="x">' }, [{ name: "a", values: [], written: "hi" }]), /no Something else row/);
  assert.throws(() => checkAnswers(c, [{ name: "notify", values: ["team-channel"] }]), /needs an answer/, "question 1 is required and unanswered");
  assert.throws(() => checkAnswers(c, [{ name: "target", values: ["staging"], changed: false }]), /may carry only/);
  assert.throws(() => checkAnswers(c, [{ name: "target", values: [] }]), /needs an answer/);
  assert.deepEqual(checkAnswers(c, [{ name: "target", values: [], written: "my own words" }])[0], { name: "target", values: [], changed: true, written: "my own words" });
});

test("a reply carries its text to the thread and brings back what the crewmate answers", async () => {
  const { home, run, lines } = await setup([decision], { answerReply: "Understood, building." });
  try {
    await run(["reply", "7", ...ids(decision), "--request", "req-hhhhhhhh", "--wait", "5"], "Please also add tests.");
    const [call] = home.state.changes;
    assert.equal(call.channel, "inf:cards:reply");
    assert.equal(call.args[1].text, "Please also add tests.");
    assert.equal(call.args[2].offerId, "7-v1");
    assert.deepEqual(lines.slice(-2), ["Reply sent.", "crewmate: Understood, building."]);
    await assert.rejects(run(["reply", "7", ...ids(decision), "--request", "req-iiiiiiii"], "  "), /reply on stdin/);
    await assert.rejects(run(["reply", "7", "--offer", "7-v9", "--lifecycle", "7-l1", "--request", "req-iiiiiiii"], "hi"), /has changed/);
  } finally {
    await home.close();
  }
});

test("a message to the first mate is relayed once and its answer comes back", async () => {
  const { home, run, lines } = await setup([], { answerSay: "Started the deploy." });
  try {
    const args = ["say", "--request", "req-jjjjjjjj", "--wait", "5"];
    await run(args, "Start the next task");
    assert.deepEqual(lines.slice(-2), ["Sent.", "First mate: Started the deploy."]);
    assert.deepEqual(home.state.changes[0].args, [{ text: "Start the next task" }]);
    await run(args, "Start the next task");
    assert.match(lines.at(-2), /^Already sent\./);
    assert.equal(home.state.changes.length, 1);
    await run(["say", "--request", "req-mmmmmmmm", "--wait", "5"], "Start the next task");
    assert.deepEqual(lines.slice(-2), ["Sent.", "First mate: Started the deploy."]);
    assert.equal(home.state.changes.length, 2);
    await run(["last"]);
    assert.match(lines.at(-1), /First mate: Started the deploy\./);
  } finally {
    await home.close();
  }
});

// Source: protocol 12 contract; no push payload carries a turn id.
test("a conversation overlap is refused rather than returning an ambiguous reply", async () => {
  const { home, run, lines } = await setup([], { answerSay: "Possibly stale." });
  home.state.overlapSay = "Another message";
  try {
    await assert.rejects(
      run(["say", "--request", "req-overlap1", "--wait", "5"], "Start the next task"),
      /answer is ambiguous/,
    );
    assert.equal(home.state.changes.length, 1, "the bridge sends only its requested message");
    assert.ok(!lines.includes("First mate: Possibly stale."));
  } finally {
    await home.close();
  }
});

test("a first-mate timeout leaves an unknown request and never reuses its stale reply", async () => {
  const { home, run } = await setup([], { answerSay: "Possibly stale." });
  try {
    await assert.rejects(
      run(["say", "--request", "req-timeout1", "--wait", "0"], "Start the next task"),
      /No safely correlated first-mate reply/,
    );
    await assert.rejects(
      run(["say", "--request", "req-timeout1", "--wait", "5"], "Start the next task"),
      /outcome is not known/,
    );
    assert.equal(home.state.changes.length, 1);
  } finally {
    await home.close();
  }
});

test("acting needs the switch on and a pairing, and the read link still cannot change anything", async () => {
  const { home, run, dir } = await setup([decision]);
  try {
    setEnabled(dir, false);
    await assert.rejects(run(["say", "--request", "req-kkkkkkkk"], "hi"), /bridge is off/);
    await assert.rejects(run(["answer", "7", "later", ...ids(decision), "--request", "req-kkkkkkkk"]), /bridge is off/);
    assert.equal(home.state.sockets.size, 0, "off holds no connection");
    assert.equal(home.state.changes.length, 0);
    assert.equal(existsSync(join(dir, "requests")), false, "a refused command leaves no claim");
  } finally {
    await home.close();
  }
});

test("the acting link refuses a home that does not give it full access", async () => {
  const { home, run } = await setup([decision]);
  try {
    home.state.forceAccess = "read";
    await assert.rejects(run(["say", "--request", "req-llllllll"], "hi"), /did not give this connection full access/);
    assert.equal(home.state.changes.length, 0);
  } finally {
    await home.close();
  }
});

// Source: exercise a completed claim between preflight and final claim.
for (const scenario of [
  { name: "answer", channel: "inf:cards:list", args: () => ["answer", "6", "go", ...ids(plain), "--request", "req-raceaaaa"] },
  { name: "reply", channel: "inf:cards:list", args: () => ["reply", "6", ...ids(plain), "--request", "req-racebbbb", "--wait", "0"], stdin: "hello" },
  { name: "say", channel: "inf:conversation:state", args: () => ["say", "--request", "req-racecccc", "--wait", "5"], stdin: "hello", overlappingOutcome: true },
]) {
  test(`concurrent ${scenario.name} with the same request id does not send twice`, async () => {
    const { home, run, lines } = await setup([plain]);
    home.state.delayReply = { channel: scenario.channel, occurrence: 2, ms: 150 };
    try {
      const args = scenario.args();
      const results = await Promise.allSettled([run(args, scenario.stdin), run(args, scenario.stdin)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, scenario.overlappingOutcome ? 1 : 2);
      assert.equal(home.state.changes.length, 1);
      if (scenario.overlappingOutcome) {
        assert.match(results.find((r) => r.status === "rejected").reason.message, /already working|outcome is not known|conversation message arrived/i);
      } else assert.ok(lines.some((line) => /Already done|Already sent/.test(line)));
    } finally {
      await home.close();
    }
  });
}

// Source: a reply response may already include the new answer.
test("a crewmate reply included in the initial thread response is returned", async () => {
  const { home, run, lines } = await setup([decision], { answerReplyInInitialResponse: "Already here." });
  try {
    await run(["reply", "7", ...ids(decision), "--request", "req-replyearly", "--wait", "0"], "Please proceed.");
    assert.deepEqual(lines.slice(-2), ["Reply sent.", "crewmate: Already here."]);
  } finally {
    await home.close();
  }
});

// Source: browser-restored textarea values are already answered.
test("a required textarea preserves its initial answer and unchanged submissions", () => {
  const existing = { body: '<textarea name="notes" required>Existing notes</textarea>' };
  assert.deepEqual(checkAnswers(existing, []), []);
  assert.deepEqual(checkAnswers(existing, [{ name: "notes", values: ["Existing notes"] }]), [
    { name: "notes", values: ["Existing notes"], changed: false },
  ]);
});

// Intent: the captain's request to acknowledge a relayed note from Grok Bot with an 'ack' command
// that keeps the offer/lifecycle checks, fails closed on stale or repeated requests, and never acts by itself.
const note = card("21", { actions: [] });
const required = [{ id: "x", target: "t", title: "Do it", consequence: "c", instructions: ["i"], criterion: "k", prerequisites: [], completion: { kind: "manual", label: "done" } }];

test("ack closes the exact note with the app's own submission, once, and a replay or different content does not repeat it", async () => {
  const { home, run, lines } = await setup([note]);
  try {
    const args = ["ack", "21", ...ids(note), "--request", "ack-21-v1aa"];
    await run(args);
    assert.match(lines.at(-1), /^Acknowledged note 21; Infinitary closed it\./);
    assert.equal(home.state.hellos.at(-1).protocolVersion, "12.0.0", "the acting link speaks the home's own major");
    assert.deepEqual(home.state.changes, [{ channel: "inf:cards:close", args: ["21", { id: "ack-21-v1aa", lifecycleId: "21-l1", offerId: "21-v1" }] }]);
    await run(args);
    assert.match(lines.at(-1), /^Already done: Acknowledged/);
    await assert.rejects(run(["ack", "21", "--offer", "21-v2", "--lifecycle", "21-l1", "--request", "ack-21-v1aa"]), /different request/);
    assert.equal(home.state.changes.length, 1);
  } finally {
    await home.close();
  }
});

test("ack sends nothing for anything but a ready note on the stage with no buttons and no required actions", async () => {
  const cases = {
    decision: card("22"),
    attention: card("23", { author: "host", actions: [{ id: "deny", label: "Deny" }] }),
    required: card("24", { actions: [], requiredActions: required }),
    unread: card("25", { actions: [], awaiting: "close-out" }),
    streaming: card("26", { actions: [], status: "streaming" }),
  };
  const { home, run, dir } = await setup([note, ...Object.values(cases)]);
  try {
    await assert.rejects(run(["ack", "22", ...ids(cases.decision), "--request", "ack-req-22"]), /not a note/);
    await assert.rejects(run(["ack", "23", ...ids(cases.attention), "--request", "ack-req-23"]), /not a note/);
    await assert.rejects(run(["ack", "24", ...ids(cases.required), "--request", "ack-req-24"]), /required actions/);
    await assert.rejects(run(["ack", "25", ...ids(cases.unread), "--request", "ack-req-25"]), /still with its author/);
    await assert.rejects(run(["ack", "26", ...ids(cases.streaming), "--request", "ack-req-26"]), /not ready/);
    await assert.rejects(run(["ack", "21", "--offer", "21-v0", "--lifecycle", "21-l1", "--request", "ack-req-27"]), /has changed/);
    await assert.rejects(run(["ack", "21", "--offer", "21-v1", "--lifecycle", "21-l0", "--request", "ack-req-27"]), /has changed/);
    await assert.rejects(run(["ack", "99", "--offer", "99-v1", "--lifecycle", "99-l1", "--request", "ack-req-27"]), /no longer showing/);
    await assert.rejects(run(["ack", "21", "--lifecycle", "21-l1", "--request", "ack-req-27"]), /Name the card's current offer/);
    await assert.rejects(run(["ack", "21", "--offer", "21-v1", "--request", "ack-req-27"]), /Name the card's current offer/);
    await assert.rejects(run(["ack", "21", ...ids(note), "--request", "short"]), /fresh id/);
    await assert.rejects(run(["ack", "21", ...ids(note)]), /fresh id/);
    assert.equal(home.state.changes.length, 0, "nothing reached the home");
    setEnabled(dir, false);
    await assert.rejects(run(["ack", "21", ...ids(note), "--request", "ack-req-28"]), /bridge is off/);
    assert.equal(home.state.changes.length, 0);
  } finally {
    await home.close();
  }
});

test("a note that was replied under and is back on the stage closes, as the app's close does", async () => {
  const answered = card("27", { actions: [], awaiting: "answer", sentBackAt: 5 });
  const { home, run } = await setup([answered]);
  try {
    await run(["ack", "27", ...ids(answered), "--request", "ack-req-29"]);
    assert.equal(home.state.changes.length, 1);
  } finally {
    await home.close();
  }
});

test("a home that still lists the note after the close is reported as not acknowledged, and is recorded", async () => {
  const { home, run, lines } = await setup([note]);
  home.state.keepOnClose = true;
  try {
    const args = ["ack", "21", ...ids(note), "--request", "ack-req-30"];
    await run(args);
    assert.equal(lines.at(-1), "Not acknowledged: Infinitary still shows the note.");
    await run(args);
    assert.match(lines.at(-1), /^Not acknowledged/);
    assert.equal(home.state.changes.length, 1);
  } finally {
    await home.close();
  }
});

test("closing is never a read: the relay's read link cannot close a card, and the read channels exclude it", async () => {
  const { READ_CHANNELS, HomeLink } = await import("../src/home.js");
  assert.equal(READ_CHANNELS.has("inf:cards:close"), false);
  const { home, dir } = await setup([note]);
  try {
    const link = new HomeLink(JSON.parse(readFileSync(join(dir, "grant.json"), "utf8")));
    await link.open();
    await assert.rejects(link.invoke("inf:cards:close", ["21"]), /not a read/);
    link.close();
    assert.equal(home.state.changes.length, 0);
  } finally {
    await home.close();
  }
});
