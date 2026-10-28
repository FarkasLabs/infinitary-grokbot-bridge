// The "In Infinitary" messages: what happened in the app, as information only. Nothing here asks Grok bot to act.
const quote = (s) => `"${String(s ?? "").trim()}"`;

const answerLines = (answers) =>
  (answers ?? []).map((a) => {
    const picked = (a.labels?.length ? a.labels : a.values ?? []).filter(Boolean);
    const said = a.written ? [`"${a.written}"`] : [];
    return `- ${a.name}: ${[...picked, ...said].join(", ") || "(no answer)"}`;
  });

/** Your choice on a card, or your closing of a note. */
export function endingNotice(card, past, { merge = false } = {}) {
  const e = past.ending;
  if (e.how === "dismissed") return `In Infinitary · you closed the note ${quote(card.title)} (card ${card.id}).`;
  const label = e.label ?? e.actionId;
  const head = merge
    ? `In Infinitary · you pressed ${quote(label)} on ${quote(card.title)} (card ${card.id}): merge requested. It is not merged yet; the result follows if Infinitary reports one.`
    : `In Infinitary · you answered ${quote(card.title)} (card ${card.id}) with ${quote(label)}.`;
  return [head, ...answerLines(past.answers)].join("\n");
}

/** A request whose outcome is unclear, told as that request's result; it names no presser. */
export function unclearNotice(rec, what) {
  return `Request ${rec.id} (${rec.subject.kind}): its outcome is unclear. ${what} Infinitary shows it happened; whether this request did it is not known.`;
}

export const endingWhat = (card, past) =>
  past.ending.how === "dismissed"
    ? `The note ${quote(card.title)} (card ${card.id}) was closed.`
    : `Card ${quote(card.title)} (card ${card.id}) ended with ${quote(past.ending.label ?? past.ending.actionId)}.`;

export const commentNotice = (card, m) => `In Infinitary · you commented under ${quote(card.title)} (card ${card.id}): ${m.text}`;
export const threadAnswerNotice = (card, m) =>
  `In Infinitary · ${m.who === "firstmate" ? "the first mate" : "the crewmate"} answered under ${quote(card.title)} (card ${card.id}): ${m.text}`;
export const turnNotice = (text) => `In Infinitary · you told the first mate: ${text}`;
export const replyNotice = (text) => `In Infinitary · the first mate answered: ${text}`;
export const mergeResultNotice = (title, ok, text) =>
  ok ? `Merge result · ${quote(title)} is merged.` : `Merge result · ${quote(title)} did not merge${text ? `: ${text}` : "."}`;
