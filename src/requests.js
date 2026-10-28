import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const dirOf = (stateDir) => {
  const d = join(stateDir, "requests");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
};

export const fingerprint = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/**
 * One file per request id, created exclusively, so two runs of the same id cannot both send.
 * A change is claimed ("started") before it is sent and finished after the home answered.
 * A claim left "started" means the outcome is unknown: it is never sent again.
 */
export function claim(stateDir, id, print, { create = true } = {}) {
  if (!REQUEST_ID.test(id ?? "")) throw new Error("Give --request with a fresh id of 8 to 64 letters, digits, - or _.");
  const dir = dirOf(stateDir);
  for (const f of readdirSync(dir)) {
    try {
      if (Date.now() - statSync(join(dir, f)).mtimeMs > KEEP_MS) rmSync(join(dir, f));
    } catch {}
  }
  const path = join(dir, `${id}.json`);
  if (!create) {
    try {
      statSync(path);
    } catch {
      return { fresh: true, path: null };
    }
  } else try {
    writeFileSync(path, JSON.stringify({ print, state: "started", at: Date.now() }), { flag: "wx", mode: 0o600 });
    return { fresh: true, path };
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let seen;
  try {
    seen = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    seen = {};
  }
  if (seen.print !== print) throw new Error("That request id was already used for a different request. Use a new one.");
  if (seen.state === "done") return { fresh: false, result: seen.result };
  throw new Error("That request was sent and its outcome is not known. It is not sent again; read the card or the thread, then use a new request id if it is still wanted.");
}

export function finish(path, result) {
  const seen = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...seen, state: "done", result }), { mode: 0o600 });
}
