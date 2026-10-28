import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { pinnedSocket } from "./pair.js";

/**
 * The version the bridge names in its hello. A major the home does not share gets
 * access "read": the home refuses every change on that connection. This is the
 * client's own choice, not least privilege - a copy of the key could connect
 * speaking the home's own major. See docs/security.md.
 */
export const SPEAK = "999.0.0";

/** The only requests the bridge ever sends. The read side only reads. */
export const READ_CHANNELS = new Set([
  "inf:cards:list", "inf:cards:picture", "inf:cards:thread", "inf:cards:past", "inf:conversation:last-turn", "inf:conversation:state",
]);

/** Acting: the requests that change something, each only from a command that was asked for. */
export const ACT_CHANNELS = new Set([...READ_CHANNELS, "inf:cards:act", "inf:cards:reply", "inf:cards:close", "inf:converse"]);

const MAX_FRAME = 64 * 1024 * 1024;

export class HomeLink extends EventEmitter {
  /**
   * `speak`, `channels` and `access` pick the role: the default is the read-only link.
   * The acting link (openActLink) speaks the home's own major and must be given "full".
   */
  constructor(grant, { requestTimeoutMs = 20000, speak = SPEAK, channels = READ_CHANNELS, access = "read" } = {}) {
    super();
    this.speak = speak;
    this.channels = channels;
    this.access = access;
    this.grant = grant;
    this.requestTimeoutMs = requestTimeoutMs;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  async open() {
    const [host, port] = splitAt(this.grant.at);
    const socket = await pinnedSocket({ host, port, homeKey: this.grant.homeKey, key: this.grant.key, cert: this.grant.cert });
    const ws = new WebSocket(`wss://${host}:${port}/connection`, {
      createConnection: () => socket,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME,
    });
    this.ws = ws;
    const welcome = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("The home sent no welcome.")), 10000);
      ws.on("message", (raw) => {
        let frame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.t === "welcome") {
          clearTimeout(t);
          resolve(frame);
        } else if (frame.t === "push") this.emit("push", frame.channel, frame.payload);
        else if (frame.t === "result") this.#settle(frame);
      });
      ws.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      ws.once("unexpected-response", (_r, res) => {
        clearTimeout(t);
        reject(new Error(`The home refused the connection (${res.statusCode}).`));
      });
    });
    ws.once("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("The connection closed."));
      this.pending.clear();
      this.emit("close");
    });
    ws.on("error", () => {});
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ t: "hello", protocolVersion: this.speak, spellings: ["inf"], as: "view", system: "linux" }));
    const frame = await welcome;
    // Fail closed: the link is used only at the access its role expects.
    if (frame.access !== this.access) {
      this.close();
      throw new Error(this.access === "read"
        ? "The home did not hold the connection to read access; the bridge will not use it."
        : "The home did not give this connection full access, so nothing can be changed. Update the bridge for this Infinitary.");
    }
    return frame;
  }

  #settle(frame) {
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.value);
    else p.reject(new Error(String(frame.error)));
  }

  invoke(channel, args = []) {
    if (!this.channels.has(channel)) {
      return Promise.reject(new Error(`${channel} is not a ${this.channels === READ_CHANNELS ? "read" : "request"} the bridge makes.`));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${channel} timed out.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t: "invoke", id, channel, args }));
    });
  }

  close() {
    try {
      this.ws?.close();
      this.ws?.terminate();
    } catch {}
  }
}

function splitAt(at) {
  const m = /^([^:]+):(\d+)$/.exec(at);
  if (!m) throw new Error("The grant's address is not host:port.");
  return [m[1], Number(m[2])];
}

/**
 * The link that may change things. It learns the home's own contract version from a read-only
 * hello (the welcome names it), then reconnects speaking it. Opened only for a command that
 * was asked for, and closed right after.
 */
export async function openActLink(grant, options = {}) {
  const probe = new HomeLink(grant, options);
  const welcome = await probe.open();
  probe.close();
  const version = String(welcome.protocolVersion ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.split(".")[0] === SPEAK.split(".")[0]) {
    throw new Error("The home did not say which contract version it speaks.");
  }
  const link = new HomeLink(grant, { ...options, speak: version, channels: ACT_CHANNELS, access: "full" });
  await link.open();
  return link;
}
