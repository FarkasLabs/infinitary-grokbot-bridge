import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The bridge's private folder: grant, on/off switch, relay receipts. Never in git, never logged. */
export function stateDir(env = process.env) {
  const dir = env.GROKBOT_BRIDGE_HOME || join(homedir(), ".local", "state", "infinitary-grokbot-bridge");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export const grantPath = (dir) => join(dir, "grant.json");
export const switchPath = (dir) => join(dir, "enabled");
export const receiptsPath = (dir) => join(dir, "relay.json");
export const pidPath = (dir) => join(dir, "daemon.pid");

/** Off unless the file says "on": a fresh install, or a damaged file, sends nothing. */
export function isEnabled(dir) {
  try {
    return readFileSync(switchPath(dir), "utf8").trim() === "on";
  } catch {
    return false;
  }
}

export function setEnabled(dir, on) {
  writePrivate(switchPath(dir), on ? "on\n" : "off\n");
}

export const hasGrant = (dir) => existsSync(grantPath(dir));
