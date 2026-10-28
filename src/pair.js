import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { connect } from "node:tls";
import { grantPath, writePrivate } from "./state.js";

const run = promisify(execFile);

/** What a pairing link names; the code is a secret and is never returned in a message. */
export function parseLink(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error("That is not a pairing link.");
  }
  if (!["infinitary:", "firstmate3000:"].includes(url.protocol) || url.hostname !== "join")
    throw new Error("That is not a pairing link.");
  const q = url.searchParams;
  const at = q.get("at") ?? "";
  const port = Number(/:(\d{1,5})$/.exec(at)?.[1]);
  if (q.get("via")) throw new Error("A link that goes through SSH is not for this bridge.");
  if (!port || !q.get("key") || !q.get("code")) throw new Error("The pairing link is incomplete.");
  return { port, key: q.get("key"), code: q.get("code") };
}

/** TLS 1.3 showing our key; resolved only when the home's key hashes to the pin. */
export function pinnedSocket({ host, port, homeKey, key, cert }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: "", rejectUnauthorized: false, minVersion: "TLSv1.3", key, cert });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The home did not answer in time."));
    }, 10000);
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const spki = socket.getPeerX509Certificate()?.publicKey.export({ type: "spki", format: "der" });
      const pin = spki ? createHash("sha256").update(spki).digest("base64url") : null;
      if (pin !== homeKey) {
        socket.destroy();
        reject(new Error("The computer at this address is not the home the link names."));
        return;
      }
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

async function makeIdentity(dir) {
  const tmp = mkdtempSync(join(dir, "keygen-"));
  try {
    await run("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(tmp, "k.pem")]);
    await run("openssl", ["req", "-new", "-x509", "-key", join(tmp, "k.pem"), "-subj", "/CN=grokbot-bridge",
      "-days", "3650", "-out", join(tmp, "c.pem")]);
    return { key: readFileSync(join(tmp, "k.pem"), "utf8"), cert: readFileSync(join(tmp, "c.pem"), "utf8") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function postPair(socket, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const req = http.request(
      { agent, host: "127.0.0.1", port: socket.remotePort, method: "POST", path: "/pair",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Pairs once, over loopback only, as a computer link used from this computer with
 * window: true - the home makes that a view. Keeps the grant privately (0600).
 */
export async function pair(linkText, dir, { name = "Grok bot bridge", host = "127.0.0.1" } = {}) {
  const link = parseLink(linkText);
  const identity = await makeIdentity(dir);
  const socket = await pinnedSocket({ host, port: link.port, homeKey: link.key, ...identity });
  let answer;
  try {
    // The home requires the macOS user a computer runs as (docs/devices.md "Joining"), even for a window join.
    const { username, uid } = userInfo();
    answer = await postPair(socket, { code: link.code, kind: "mac", name, user: { name: username, uid }, window: true });
  } finally {
    socket.destroy();
  }
  if (answer.status !== 201) {
    let reason = "refused";
    try {
      reason = JSON.parse(answer.text).reason ?? reason;
    } catch {}
    throw new Error(`The home refused the pairing (${answer.status} ${reason}).`);
  }
  const { deviceId, kind } = JSON.parse(answer.text);
  const grant = { at: `${host}:${link.port}`, homeKey: link.key, deviceId, kind, ...identity };
  writePrivate(grantPath(dir), JSON.stringify(grant));
  return { deviceId, kind };
}
