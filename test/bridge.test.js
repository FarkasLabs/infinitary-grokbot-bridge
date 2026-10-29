// Intent: the read side end to end against a stand-in home at the wire: secure local pairing,
// pinned TLS, read-only connection, relay, pages on request, a persistent switch Grok bot can flip.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { runDaemon } from "../src/daemon.js";
import { HomeLink, SPEAK } from "../src/home.js";
import { pair } from "../src/pair.js";
import { grantPath, isEnabled, readJson, setEnabled } from "../src/state.js";
import { card, startHome } from "./standin.js";

const tmp = () => mkdtempSync(join(tmpdir(), "gb-bridge-"));
const until = async (f, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("timed out waiting");
};

test("pairing over loopback keeps a private grant; a wrong pin, a spent code and a bad code are refused", async () => {
  const home = await startHome();
  const dir = tmp();
  try {
    // The link names a LAN address; the bridge dials loopback only.
    const r = await pair(home.link(), dir);
    assert.equal(r.kind, "view");
    assert.equal(home.state.pairBody.window, true);
    assert.deepEqual(home.state.pairBody.user, { name: userInfo().username, uid: userInfo().uid });
    assert.equal(statSync(grantPath(dir)).mode & 0o777, 0o600);
    const grant = readJson(grantPath(dir));
    assert.equal(grant.at, `127.0.0.1:${home.port}`);
    await assert.rejects(pair(home.link(), tmp()), /refused the pairing \(401 unknown\)/);
    const other = await startHome();
    try {
      await assert.rejects(pair(`infinitary://join?as=mac&at=x:${other.port}&key=${home.pin}&code=${"a".repeat(43)}`, tmp()), /not the home the link names/);
    } finally {
      await other.close();
    }
    await assert.rejects(pair("https://example.com", tmp()), /not a pairing link/);
    await assert.rejects(pair(`${home.link()}&via=ssh`, tmp()), /SSH/);
  } finally {
    await home.close();
  }
});

test("the connection speaks 999.0.0, is held to read, only reads, and never leaves the grant in a message", async () => {
  const home = await startHome({ cards: [card("1")] });
  const dir = tmp();
  try {
    await pair(home.link(), dir);
    const link = new HomeLink(readJson(grantPath(dir)));
    const welcome = await link.open();
    assert.equal(welcome.access, "read");
    assert.equal(home.state.hellos[0].protocolVersion, SPEAK);
    assert.equal((await link.invoke("inf:cards:list", [])).length, 1);
    for (const change of ["inf:cards:act", "inf:cards:reply", "inf:converse", "inf:cards:seen"])
      await assert.rejects(link.invoke(change, []), /not a read the bridge makes/);
    assert.deepEqual(home.state.invoked, ["inf:cards:list"], "no change request ever left the bridge");
    link.close();
  } finally {
    await home.close();
  }
});

test("the bridge refuses a home that does not hold the connection to read access", async () => {
  const home = await startHome();
  const dir = tmp();
  try {
    await pair(home.link(), dir);
    home.state.forceAccess = "full";
    const link = new HomeLink(readJson(grantPath(dir)));
    await assert.rejects(link.open(), /did not hold the connection to read access/);
  } finally {
    await home.close();
  }
});

test("the daemon relays cards, marks updates, and the switch closes the connection and silences it", async () => {
  const home = await startHome({ cards: [card("1"), card("2", { actions: [] })] });
  const dir = tmp();
  const sent = [];
  try {
    await pair(home.link(), dir);
    setEnabled(dir, false);
    const d = await runDaemon(dir, { send: async (m) => (sent.push(m), { ok: true, status: 200 }), pollMs: 25, tickMs: 60000, log: () => {} });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(home.state.sockets.size, 0, "off holds no connection");
    assert.equal(sent.length, 0);

    setEnabled(dir, true);
    await until(() => sent.length === 2);
    assert.match(sent[0], /Decision · Card 1/);
    assert.match(sent[1], /Note · no answer needed · Card 2/);

    home.push([card("1", { offerId: "1-v2", body: "<p>Now different</p>" }), card("2", { actions: [] })]);
    await until(() => sent.length === 3);
    assert.match(sent[2], /^Updated · Decision/);
    assert.match(sent[2], /Now different/);

    setEnabled(dir, false);
    await until(() => home.state.sockets.size === 0);
    home.push([card("1", { offerId: "1-v3" }), card("2", { actions: [] }), card("3")]);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 3, "nothing goes out while off");

    setEnabled(dir, true);
    await until(() => sent.length === 5);
    assert.match(sent[3], /Updated · Decision · Card 1/);
    assert.match(sent[4], /^Decision · Card 3/);
    d.stop();
  } finally {
    await home.close();
  }
});

test("commands: on/off persist and report, reads refuse when off, show and page work when on", async () => {
  const home = await startHome({ cards: [card("1", { body: '<fieldset><legend>Pick</legend><label><input type="radio" name="a" value="x" data-inf-recommended> Yes</label></fieldset><script>bad()</script>', pictures: [{ id: "p.png", alt: "A chart", width: 1, height: 1, group: 0 }] })] });
  home.state.threads = { 1: [{ who: "firstmate", text: "Earlier reply", id: 1, cardId: "1", at: 1 }] };
  const dir = tmp();
  const env = { ...process.env, GROKBOT_BRIDGE_HOME: dir };
  const lines = [];
  const run = (...argv) => main(argv, { out: (s) => lines.push(s), env });
  try {
    await assert.rejects(run("on"), /Not paired/);
    await pair(home.link(), dir);
    await assert.rejects(run("cards"), /bridge is off/);
    await run("off");
    assert.equal(isEnabled(dir), false);
    setEnabled(dir, true); // `on` would also start the background part; the daemon has its own test
    await run("cards");
    assert.match(lines.at(-1), /^1\tDecision\tCard 1$/);
    await run("show", "1");
    assert.match(lines.at(-1), /Question: Pick/);
    assert.match(lines.at(-1), /- firstmate: Earlier reply/);
    await run("page", "1");
    const page = lines.at(-1);
    assert.match(page, /<legend>Pick<\/legend>/);
    assert.doesNotMatch(page, /bad\(\)/);
    assert.match(page, /src="data:image\/png;base64,iVBORw0KGgo="/);
    await assert.rejects(run("show", "../etc/passwd"), /Give a card id/);
    await assert.rejects(run("show", "nope"), /No card nope/);
    await run("status");
    assert.equal(JSON.parse(lines.at(-1)).enabled, true);
    assert.doesNotMatch(readFileSync(join(dir, "enabled"), "utf8"), /key|cert/i);
    assert.deepEqual([...new Set(home.state.invoked)].sort(), ["inf:cards:list", "inf:cards:picture", "inf:cards:thread"]);
  } finally {
    await home.close();
  }
});

// Intent: the captain's 'no automatic ack' rule for note acknowledgement: the running relay
// forwards notes and sends nothing and changes nothing when a note goes away.
test("the relay daemon relays a note, and when the note disappears it changes nothing at the home and says nothing", async () => {
  const note = card("31", { actions: [] });
  const home = await startHome({ cards: [note] });
  const dir = tmp();
  const sent = [];
  let daemon;
  try {
    await pair(home.link(), dir);
    setEnabled(dir, true);
    daemon = await runDaemon(dir, { send: async (m) => (sent.push(m), { ok: true, status: 200 }), pollMs: 20, log: () => {} });
    await until(() => sent.length === 1);
    assert.match(sent[0], /^Note · no answer needed/);
    home.push([]);
    await until(() => home.state.invoked.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, 1, "a note that disappears sends nothing");
    assert.deepEqual(home.state.changes, [], "the relay never changed anything at the home");
    assert.ok(!home.state.invoked.includes("inf:cards:close"));
  } finally {
    daemon?.stop();
    await home.close();
  }
});

// Intent (GRBP-31): `cards` names each card's task and marks read / put-aside cards, and `status` counts the cards showing now.
test("cards prints each task's key with read and put-aside marks, and status follows every pushed list", async () => {
  const home = await startHome({ cards: [
    card("1", { taskId: "t1", seen: true, minimized: true }),
    card("2", { actions: [], taskId: "t2", seen: true }),
    card("3", { actions: [], taskId: "gone" }),
    card("4"),
  ] });
  home.state.tasks = { t1: { id: "t1", key: "TIA-40" }, t2: { id: "t2", key: "GRBP-29" } };
  const dir = tmp();
  const env = { ...process.env, GROKBOT_BRIDGE_HOME: dir };
  const lines = [];
  let daemon;
  try {
    await pair(home.link(), dir);
    setEnabled(dir, true);
    daemon = await runDaemon(dir, { send: async () => ({ ok: true, status: 200 }), pollMs: 20, log: () => {} });
    const cardsCount = () => readJson(join(dir, "status.json"), {}).cards;
    await until(() => cardsCount() === 4);
    await main(["cards"], { env, out: (s) => lines.push(s) });
    assert.deepEqual(lines, [
      "1\tTIA-40\tDecision (read, put aside)\tCard 1",
      "2\tGRBP-29\tNote (no answer needed, read)\tCard 2",
      "3\tNote (no answer needed)\tCard 3",
      "4\tDecision\tCard 4",
    ], "an unreadable task or a card with no task keeps the plain line");
    home.push([card("4")]);
    await until(() => cardsCount() === 1);
  } finally {
    daemon?.stop();
    await home.close();
  }
});

// Intent (GRBP-31): reading or listing a note never closes it or marks it read; the bridge only reads.
test("listing cards and processing pushes leave a note open and its read state alone", async () => {
  const note = card("2", { actions: [], taskId: "t2", seen: false });
  const home = await startHome({ cards: [note] });
  home.state.tasks = { t2: { id: "t2", key: "GRBP-29" } };
  const dir = tmp();
  const env = { ...process.env, GROKBOT_BRIDGE_HOME: dir };
  const lines = [];
  let daemon;
  try {
    await pair(home.link(), dir);
    setEnabled(dir, true);
    daemon = await runDaemon(dir, { send: async () => ({ ok: true, status: 200 }), pollMs: 20, log: () => {} });
    await until(() => readJson(join(dir, "status.json"), {}).cards === 1);
    await main(["cards"], { env, out: (s) => lines.push(s) });
    await main(["show", "2"], { env, out: (s) => lines.push(s) });
    home.push([card("2", { actions: [], taskId: "t2", seen: false, offerId: "2-v2" }), card("3")]);
    await until(() => readJson(join(dir, "status.json"), {}).cards === 2);
    assert.match(lines[0], /^2\tGRBP-29\tNote \(no answer needed\)\tCard 2$/, "unread note: no read mark added by listing");
    assert.deepEqual(home.state.changes, [], "no change request left the bridge");
    const allowed = new Set(["inf:cards:list", "inf:cards:thread", "inf:cards:past", "inf:tasks:detail", "inf:cards:picture"]);
    assert.deepEqual(home.state.invoked.filter((c) => !allowed.has(c)), [], "only read channels were used: no seen, act, close or dismiss");
    assert.equal(home.state.cards.find((c) => c.id === "2")?.seen, false, "the note is still open and unread at the home");
  } finally {
    daemon?.stop();
    await home.close();
  }
});
