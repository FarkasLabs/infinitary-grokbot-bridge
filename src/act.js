import { checkAnswers } from "./questions.js";
import { claim, finish, fingerprint } from "./requests.js";

const CARD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const IDENT = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_REPLY = 4000;
export const MAX_SAY = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What pressing a button does, in words, and whether it needs --confirm. */
export function effectOf(action) {
  const e = action.effect;
  if (!e) return { kind: "plain", needsConfirm: false };
  if (e.kind === "settle") return { kind: e.mode, needsConfirm: true };
  if (e.kind === "request_merge") return { kind: "merge", needsConfirm: true };
  if (e.kind === "request_write") return { kind: "write", needsConfirm: true };
  if (e.kind === "open") return { kind: "open", needsConfirm: false, impossible: true };
  return { kind: e.kind, needsConfirm: action.variant === "danger" || action.danger === true };
}

function currentCard(cards, { cardId, offerId, lifecycleId }) {
  if (!CARD_ID.test(cardId ?? "")) throw new Error("Give a card id, as 'cards' lists them.");
  if (!IDENT.test(offerId ?? "") || !IDENT.test(lifecycleId ?? "")) {
    throw new Error("Name the card's current offer and lifecycle: --offer and --lifecycle, as 'show' prints them.");
  }
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Card ${cardId} is no longer showing.`);
  if (card.lifecycleId !== lifecycleId || card.offerId !== offerId) {
    throw new Error(`Card ${cardId} has changed since you read it (now offer ${card.offerId}). Read it again with 'show' before answering.`);
  }
  if (card.status !== "ready") throw new Error(`Card ${cardId} is not ready to be answered (${card.status}).`);
  return card;
}

/** Presses one button of the card's current offer, with the answers to its questions. */
export async function answerCard(link, dir, opts) {
  const { cardId, actionId, offerId, lifecycleId, requestId, answers, confirm } = opts;
  if (!IDENT.test(actionId ?? "")) throw new Error("Give a button id, as 'show' lists them in brackets.");
  const print = fingerprint(["answer", cardId, actionId, offerId, lifecycleId, answers ?? [], Boolean(confirm)]);
  const prior = claim(dir, requestId, print, { create: false });
  if (!prior.fresh) return { ...prior.result, replayed: true };

  const card = currentCard(await link.invoke("inf:cards:list", []), opts);
  const action = card.actions?.find((a) => a.id === actionId);
  if (!action) throw new Error(`Card ${cardId} has no button ${actionId}.`);
  const effect = effectOf(action);
  if (effect.impossible) throw new Error(`"${action.label}" opens a page in Infinitary itself (settings, a sign-in or the browser). That needs your computer.`);
  if (effect.needsConfirm && !confirm) {
    throw new Error(`"${action.label}" will ${effect.kind === "write" ? "send a kept write" : effect.kind}. Say so explicitly by adding --confirm.`);
  }
  const checked = checkAnswers(card, answers);

  const acquired = claim(dir, requestId, print);
  if (!acquired.fresh) return { ...acquired.result, replayed: true };
  const { path } = acquired;
  const submission = { id: requestId, lifecycleId, offerId, reading: "none" };
  const reply = await link.invoke("inf:cards:act", [cardId, actionId, "chrome", checked.length ? { answers: checked } : null, submission]);
  const result = reply?.refusal
    ? { ok: false, refusal: String(reply.refusal), label: action.label }
    : { ok: true, label: action.label, kind: effect.kind };
  finish(path, result);
  return result;
}

/** The newest message id in a thread, so only later ones are news. */
const newest = (messages) => messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);

/** A reply in a card's thread, then (for a while) what the first mate or the crewmate answers. */
export async function replyToCard(link, dir, opts) {
  const { cardId, offerId, lifecycleId, requestId, text, waitMs = 60000, pollMs = 2000 } = opts;
  if (typeof text !== "string" || !text.trim()) throw new Error("Give the reply on stdin.");
  if (text.length > MAX_REPLY) throw new Error(`A reply is at most ${MAX_REPLY} characters.`);
  const print = fingerprint(["reply", cardId, offerId, lifecycleId, text]);
  const prior = claim(dir, requestId, print, { create: false });
  if (!prior.fresh) return { ...prior.result, replayed: true };

  currentCard(await link.invoke("inf:cards:list", []), opts);
  const before = (await link.invoke("inf:cards:thread", [cardId]))?.messages ?? [];
  const baseline = newest(before);
  const acquired = claim(dir, requestId, print);
  if (!acquired.fresh) return { ...acquired.result, replayed: true };
  const { path } = acquired;
  const submission = { id: requestId, lifecycleId, offerId, reading: "none" };
  const thread = await link.invoke("inf:cards:reply", [cardId, { text }, submission]);
  const answers = [];
  const seenIds = new Set();
  const collect = (messages) => {
    for (const m of messages) {
      const id = Number(m.id) || 0;
      if (id > baseline && m.who !== "captain" && m.text && !seenIds.has(id)) {
        seenIds.add(id);
        answers.push({ who: m.who, text: m.text });
      }
    }
  };
  collect(thread?.messages ?? []);
  const end = Date.now() + waitMs;
  while (Date.now() < end && !answers.length) {
    await sleep(pollMs);
    const now = (await link.invoke("inf:cards:thread", [cardId]))?.messages ?? [];
    collect(now);
  }
  const result = { ok: true, answers };
  finish(path, result);
  return result;
}

/**
 * Infinitary protocol 12 has no turn id on converse, last-turn, or its pushes.
 * Correlate conservatively by push order and refuse any overlap or timeout.
 */
export async function sayToFirstMate(link, dir, opts) {
  const { requestId, text, waitMs = 90000, pollMs = 2000 } = opts;
  if (typeof text !== "string" || !text.trim()) throw new Error("Give the message on stdin.");
  if (text.length > MAX_SAY) throw new Error(`A message is at most ${MAX_SAY} characters.`);
  const print = fingerprint(["say", text]);
  const prior = claim(dir, requestId, print, { create: false });
  if (!prior.fresh) return { ...prior.result, replayed: true };

  const seen = [];
  const onPush = (_channel, payload) => {
    const event = payload?.type ? payload : payload?.event;
    if (event && ["user_turn", "firstmate_reply"].includes(event.type)) seen.push(event);
  };
  link.on("push", onPush);
  try {
    const initialState = await link.invoke("inf:conversation:state", []);
    if (initialState?.busy !== false) throw new Error("The first mate is working or its idle state could not be confirmed. Nothing was sent; retry when the conversation is idle.");
    if (seen.some((event) => event.type === "user_turn")) {
      throw new Error("A conversation message arrived while checking the first mate. Nothing was sent; retry when the conversation is idle.");
    }

    const acquired = claim(dir, requestId, print);
    if (!acquired.fresh) return { ...acquired.result, replayed: true };
    const { path } = acquired;
    try {
      await link.invoke("inf:converse", [{ text }]);
    } catch {
      throw new Error("The first mate's acceptance was not confirmed. The message may have been sent; read 'last' before deciding what to do next.");
    }

    const end = Date.now() + waitMs;
    let ownTurnIndex = -1;
    while (Date.now() < end) {
      const userTurns = seen.map((event, index) => ({ event, index })).filter(({ event }) => event.type === "user_turn");
      if (userTurns.length > 1 || userTurns.some(({ event }) => event.text !== text)) {
        throw new Error("Another conversation message overlapped this request. Its answer is ambiguous; read 'last' before sending anything else.");
      }
      if (userTurns.length === 1) ownTurnIndex = userTurns[0].index;
      if (ownTurnIndex >= 0) {
        const replyEvent = seen.find((event, index) => index > ownTurnIndex && event.type === "firstmate_reply");
        if (replyEvent) {
          const [turn, state] = await Promise.all([
            link.invoke("inf:conversation:last-turn", []),
            link.invoke("inf:conversation:state", []),
          ]);
          if (seen.filter((event) => event.type === "user_turn").length !== 1) {
            throw new Error("Another conversation message overlapped this request. Its answer is ambiguous; read 'last' before sending anything else.");
          }
          if (state?.busy === false && turn?.you === text && turn?.reply?.text === replyEvent.text) {
            const result = { ok: true, reply: turn.reply };
            finish(path, result);
            return result;
          }
        }
      }
      await sleep(Math.min(pollMs, Math.max(0, end - Date.now())));
    }
    throw new Error("No safely correlated first-mate reply arrived before the wait ended. The message was sent; read 'last' before deciding what to do next.");
  } finally {
    link.off("push", onPush);
  }
}
