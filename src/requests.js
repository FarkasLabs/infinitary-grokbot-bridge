import { createHash } from "node:crypto";
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * `until` (the claim time plus `holdMs`) is the command's deadline, and the relay waits for a running record until then.
 */
export function claim(stateDir, id, print, { create = true, subject, holdMs = 60000 } = {}) {
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
    // Written whole under a temporary name, then linked into place, so a reader never sees half a record.
    const tmp = `${path}.${process.pid}.new`;
    const at = Date.now();
    writeFileSync(tmp, JSON.stringify({ print, state: "started", at, until: at + holdMs, subject }), { mode: 0o600 });
    try {
      linkSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
    return { fresh: true, path, until: at + holdMs };
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

/** Adds facts to a request's record, for the relay to read: outcome, own thread line id, printed answers. */
export function mark(path, patch) {
  const seen = JSON.parse(readFileSync(path, "utf8"));
  const tmp = `${path}.${process.pid}.new`;
  writeFileSync(tmp, JSON.stringify({ ...seen, ...patch }), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The relay's own facts about a request (an echo it has already skipped) live beside the record, never in it,
 * so the command that owns the record and the daemon that reads it cannot overwrite each other.
 */
const markerPath = (path, name) => path.replace(/\.json$/, `.${name}`);
export const hasMarker = (path, name) => {
  try {
    statSync(markerPath(path, name));
    return true;
  } catch {
    return false;
  }
};
/** True only for the one caller that creates it. */
export function claimMarker(path, name) {
  try {
    closeSync(openSync(markerPath(path, name), "wx", 0o600));
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

export function finish(path, result, patch = {}) {
  mark(path, { state: "done", result, doneAt: Date.now(), ...patch });
}

/** Every request record in the state folder; the relay matches what it sees against them. */
export function readRequests(stateDir) {
  const dir = dirOf(stateDir);
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      out.push({ id: f.replace(/\.json$/, ""), path: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), "utf8")) });
    } catch {}
  }
  return out;
}

/** Normalised so the bridge's submitted answers and the home's recorded ones compare equal. */
export const answersPrint = (answers) =>
  fingerprint((answers ?? []).map((a) => [a.name, [...(a.values ?? [])].sort(), a.written ?? ""]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/** The record keeps no reply or message text, only this. */
export const textPrint = (text) => fingerprint(["text", String(text ?? "").trim()]);
