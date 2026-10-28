import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAMES = new Set(["GROKBOT_WEBHOOK_URL", "GROKBOT_WEBHOOK_AUTH"]);

export function defaultWebhookEnv(env = process.env) {
  return env.GROKBOT_BRIDGE_WEBHOOK_ENV || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "infinitary-grokbot-bridge", "webhook.env");
}

/**
 * Reads the Grok bot webhook settings as data (never sourced): two names,
 * an https URL (http only to loopback) and the bare key.
 * Returns { url, auth } or { problem } with no value in it.
 */
export function loadWebhook(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { problem: "the webhook settings file cannot be read" };
  }
  const found = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const name = eq < 0 ? "" : line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!NAMES.has(name)) return { problem: "the webhook settings file has a setting this bridge does not know" };
    found[name] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  const url = found.GROKBOT_WEBHOOK_URL;
  const auth = found.GROKBOT_WEBHOOK_AUTH;
  if (!url || !auth) return { problem: "the webhook settings file is missing a setting" };
  if (/[\s"\\]/.test(url)) return { problem: "the webhook URL has whitespace, a quote or a backslash" };
  if (/^bearer\s/i.test(auth)) return { problem: "the webhook key must be bare, without Bearer" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: "the webhook URL is not a URL" };
  }
  if (parsed.username || parsed.password) return { problem: "the webhook URL must not carry user info" };
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    return { problem: "the webhook URL must be https" };
  return { url, auth };
}

/**
 * One POST per message: text/plain, Bearer key, no redirect, bounded, never retried.
 * Returns { ok, status } and never a value from the settings.
 */
export function makeSender(path, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  return async function send(text) {
    const hook = loadWebhook(path);
    if (hook.problem) return { ok: false, rejected: true, reason: hook.problem };
    try {
      const res = await fetchImpl(hook.url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "text/plain; charset=utf-8", authorization: `Bearer ${hook.auth}` },
        body: text,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const ok = res.status >= 200 && res.status < 300;
      // A 4xx answer is a definite refusal: nothing was delivered. A 5xx, a timeout or a cut connection may have been.
      return { ok, status: res.status, ...(res.status >= 400 && res.status < 500 ? { rejected: true } : {}) };
    } catch (error) {
      return { ok: false, reason: `request failed (${error?.name ?? "error"})` };
    }
  };
}
