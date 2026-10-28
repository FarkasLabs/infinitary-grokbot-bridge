// A stand-in Infinitary home at the wire: mutual TLS 1.3, /pair, /connection, the version rule.
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

export function makeKeys() {
  const d = mkdtempSync(join(tmpdir(), "gb-keys-"));
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(d, "k.pem")]);
  execFileSync("openssl", ["req", "-new", "-x509", "-key", join(d, "k.pem"), "-subj", "/CN=home", "-days", "30", "-out", join(d, "c.pem")], { stdio: "ignore" });
  const keys = { key: readFileSync(join(d, "k.pem"), "utf8"), cert: readFileSync(join(d, "c.pem"), "utf8") };
  rmSync(d, { recursive: true });
  return keys;
}


export const pinOf = (certPem) =>
  createHash("sha256").update(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" })).digest("base64url");

export async function startHome({ cards = [] } = {}) {
  const keys = makeKeys();
  const state = { cards, code: "c".repeat(43), paired: new Set(), hellos: [], invoked: [], changes: [], sockets: new Set(), origins: [], past: {}, delayedReplyCount: 0 };
  state.pushEvent = (event) => {
    for (const ws of state.sockets) ws.send(JSON.stringify({ t: "push", channel: "inf:event", payload: event }));
  };
  const broadcast = (channel, payload) => { for (const ws of state.sockets) ws.send(JSON.stringify({ t: "push", seq: 1, channel, payload })); };
  /** What Infinitary does when a card ends: the card leaves the list, its ending is kept, every view hears. */
  state.endCard = (cardId, ending, answers = []) => {
    const c = state.cards.find((x) => x.id === cardId);
    if (!c) return;
    const label = c.actions?.find((a) => a.id === ending.actionId)?.label;
    state.past[cardId] = { id: cardId, title: c.title, actions: c.actions, ending: { at: Date.now(), ...(label ? { label } : {}), ...ending }, answers: answers.map((a) => ({ ...a, labels: a.labels ?? a.values })), messages: [] };
    state.cards = state.cards.filter((x) => x.id !== cardId);
    broadcast("inf:cards", state.cards);
  };
  state.addLine = (cardId, who, text) => {
    const thread = (state.threads ??= {})[cardId] ??= [];
    thread.push({ id: thread.length + 1, who, text, cardId, at: Date.now() });
    broadcast("inf:cards:thread", { cardId, messages: thread });
  };
  state.broadcast = broadcast;
  const server = https.createServer({ ...keys, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" }, (req, res) => {
    if (req.url !== "/pair" || req.method !== "POST") return res.writeHead(404).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const cert = req.socket.getPeerCertificate(true);
      if (!cert?.raw) return res.writeHead(401).end(JSON.stringify({ refused: true, reason: "unproven" }));
      const b = JSON.parse(body);
      // Real DevicePairing: a computer that runs work (kind mac) must name its macOS user (docs/devices.md, Joining).
      if (b.kind === "mac" && !(typeof b.user?.name === "string" && b.user.name && Number.isInteger(b.user.uid)))
        return res.writeHead(400).end(JSON.stringify({ refused: true, reason: "The request to join is not one this home reads." }));
      if (b.code !== state.code) return res.writeHead(401).end(JSON.stringify({ refused: true, reason: "unknown" }));
      state.code = null;
      state.pairBody = b;
      state.paired.add(createHash("sha256").update(cert.raw).digest("hex"));
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ deviceId: "dev-1", kind: b.window ? "view" : b.kind }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const cert = req.socket.getPeerCertificate(true);
    const known = cert?.raw && state.paired.has(createHash("sha256").update(cert.raw).digest("hex"));
    if (req.headers.origin) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    if (req.url !== "/connection") return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    if (!known) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.sockets.add(ws);
      ws.on("close", () => state.sockets.delete(ws));
      let access = "full";
      ws.on("message", (raw) => {
        const f = JSON.parse(String(raw));
        if (f.t === "hello") {
          state.hellos.push(f);
          access = state.forceAccess ?? (f.protocolVersion.split(".")[0] === "12" ? "full" : "read");
          ws.send(JSON.stringify({ t: "welcome", protocolVersion: "12.0.0", epoch: "e1", seq: 0, catchUp: "reload", access, name: "Stand-in" }));
        } else if (f.t === "invoke") {
          state.invoked.push(f.channel);
          const reply = (value) => {
            const send = () => ws.send(JSON.stringify({ t: "result", id: f.id, ok: true, value }));
            const delay = state.delayReply;
            if (delay?.channel === f.channel) {
              state.delayedReplyCount += 1;
              if (state.delayedReplyCount === delay.occurrence) return setTimeout(send, delay.ms);
            }
            send();
          };
          if (f.channel === "inf:cards:list") reply(state.cards);
          else if (f.channel === "inf:cards:thread") reply({ cardId: f.args[0], messages: state.threads?.[f.args[0]] ?? [] });
          else if (f.channel === "inf:cards:past") reply(state.past?.[f.args[0]] ?? null);
          else if (f.channel === "inf:cards:picture") reply({ contentType: "image/png", data: "iVBORw0KGgo=" });
          else if (f.channel === "inf:conversation:last-turn") reply(state.lastTurn ?? null);
          else if (f.channel === "inf:conversation:state") reply({ busy: Boolean(state.busy) });
          else if (access === "read") ws.send(JSON.stringify({ t: "result", id: f.id, ok: false, error: "read-only" }));
          else if (f.channel === "inf:cards:act") {
            state.changes.push({ channel: f.channel, args: f.args });
            const [cardId, actionId] = f.args;
            const c = state.cards.find((x) => x.id === cardId);
            // Like Infinitary: a press on a card no longer shown answers {} (crewSupervisor.ts), and every action closes its card.
            const refusal = state.refuseAct ?? (c && !c.actions?.some((a) => a.id === actionId) ? "undeclared" : undefined);
            if (state.beatBy && c) {
              // The captain pressed another button a moment earlier: the card is already gone and the press is ignored silently.
              state.endCard(cardId, { how: "chose", actionId: state.beatBy, by: "captain" });
              state.beatBy = null;
            } else if (!refusal && c && !state.keepOnAct) state.endCard(cardId, { how: "chose", actionId, by: "captain" }, f.args[3]?.answers);
            if (state.cutOnAct) return ws.terminate();
            reply(refusal ? { refusal } : {});
          } else if (f.channel === "inf:cards:close") {
            state.changes.push({ channel: f.channel, args: f.args });
            if (!state.keepOnClose) state.endCard(f.args[0], { how: "dismissed" });
            reply({ ok: true });
          } else if (f.channel === "inf:cards:reply") {
            state.changes.push({ channel: f.channel, args: f.args });
            const thread = (state.threads ??= {})[f.args[0]] ??= [];
            state.addLine(f.args[0], "captain", f.args[1].text);
            if (state.answerReplyInInitialResponse) state.addLine(f.args[0], "crewmate", state.answerReplyInInitialResponse);
            reply({ cardId: f.args[0], messages: thread });
            if (state.answerReply) setTimeout(() => state.addLine(f.args[0], "crewmate", state.answerReply), 60);
          } else if (f.channel === "inf:converse") {
            state.changes.push({ channel: f.channel, args: f.args });
            state.busy = true;
            state.pushEvent({ type: "user_turn", text: f.args[0].text });
            state.pushEvent({ type: "firstmate_state", busy: true });
            if (state.overlapSay) setTimeout(() => state.pushEvent({ type: "user_turn", text: state.overlapSay }), 5);
            reply({ ok: true });
            setTimeout(() => {
              state.lastTurn = { you: f.args[0].text, reply: { text: state.answerSay ?? "Done." } };
              state.pushEvent({ type: "firstmate_reply", text: state.lastTurn.reply.text });
              state.busy = false;
              state.pushEvent({ type: "firstmate_state", busy: false });
            }, 60);
          } else ws.send(JSON.stringify({ t: "result", id: f.id, ok: false, error: "unexpected" }));
        }
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const pin = pinOf(keys.cert);
  return {
    state, port, pin,
    link: (code = state.code) => `infinitary://join?as=mac&at=192.0.2.10:${port}&key=${pin}&code=${code}`,
    push: (cards) => { state.cards = cards; for (const ws of state.sockets) ws.send(JSON.stringify({ t: "push", seq: 1, channel: "inf:cards", payload: cards })); },
    kick: () => { for (const ws of state.sockets) ws.terminate(); },
    close: () => new Promise((r) => { for (const ws of state.sockets) ws.terminate(); server.closeAllConnections?.(); server.close(r); }),
  };
}

export const card = (id, over = {}) => ({
  id, author: "crewmate", title: `Card ${id}`, body: `<p>Body of ${id}.</p>`, status: "ready", createdAt: Number(id.replace(/\D/g, "")) || 1,
  actions: [{ id: "go", label: "Go", default: true }], offerId: `${id}-v1`, lifecycleId: `${id}-l1`, ...over,
});
