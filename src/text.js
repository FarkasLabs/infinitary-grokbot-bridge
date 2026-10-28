import { parseDocument } from "htmlparser2";

const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "ul", "ol", "li", "table", "tr", "figure",
  "figcaption", "details", "summary", "fieldset", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "form", "hr", "br"]);
const SKIP = new Set(["script", "style", "template", "head"]);

const inputsIn = (n) =>
  (n.children ?? []).flatMap((c) => (c.name === "input" || c.name === "select" ? [c] : inputsIn(c)));
const textOf = (node) =>
  node.type === "text" ? node.data : node.children ? node.children.map(textOf).join("") : "";
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** Plain text of a card body, with each question and its options spelled out. */
export function htmlToText(html) {
  const doc = parseDocument(html ?? "");
  const byId = new Map();
  const labelFor = new Map();
  (function index(n) {
    if (n.attribs?.id) byId.set(n.attribs.id, n);
    if (n.name === "label" && n.attribs?.for) labelFor.set(n.attribs.for, n);
    n.children?.forEach(index);
  })(doc);

  const out = [];
  const push = (s) => out.push(s);
  const para = () => {
    if (out.length && out.at(-1) !== "\n") push("\n");
  };
  const labelOf = (input) => {
    const bound = input.attribs.id && labelFor.get(input.attribs.id);
    if (bound) return squash(textOf(bound));
    for (let p = input.parent; p; p = p.parent) if (p.name === "label") return squash(textOf(p));
    return input.attribs["aria-label"] ?? input.attribs.value ?? "";
  };
  const hasInput = (n) => n.children?.some((c) => c.name === "input" || c.name === "select" || hasInput(c));

  function walk(n) {
    if (n.type === "text") return push(n.data.replace(/\s+/g, " "));
    if (n.type !== "tag") return n.children?.forEach(walk);
    const name = n.name;
    if (SKIP.has(name)) return;
    if (name === "svg") {
      const label = n.attribs["aria-label"] || squash(textOf(n.children.find((c) => c.name === "title") ?? { type: "text", data: "" }));
      return label ? push(` [figure: ${label}] `) : undefined;
    }
    if (name === "img") return push(` [picture: ${n.attribs.alt ?? ""}] `);
    if (name === "legend") {
      para();
      push(`Question: ${squash(textOf(n))}`);
      return para();
    }
    if (name === "label") {
      // An option's label prints once, at its input.
      if (n.attribs.for && byId.has(n.attribs.for)) return;
      if (hasInput(n)) return inputsIn(n).forEach(walk);
      return n.children.forEach(walk);
    }
    if (name === "input") {
      const type = (n.attribs.type ?? "text").toLowerCase();
      if (type === "hidden") return;
      para();
      const rec = "data-inf-recommended" in n.attribs ? " (recommended)" : "";
      const write = "data-inf-write-in" in n.attribs ? " (write in your own words)" : "";
      if (type === "radio") push(`( ) ${labelOf(n) || n.attribs.value}${rec}${write}`);
      else if (type === "checkbox") push(`[ ] ${labelOf(n) || n.attribs.value}${rec}${write}`);
      else if (type === "submit" || type === "button") push(`[button: ${n.attribs.value ?? ""}]`);
      else push(`[${labelOf(n) ? `${labelOf(n)}: ` : ""}text answer${n.attribs.placeholder ? `, e.g. ${n.attribs.placeholder}` : ""}]`);
      return para();
    }
    if (name === "textarea") {
      para();
      push(`[text answer${n.attribs.placeholder ? `, e.g. ${n.attribs.placeholder}` : ""}]`);
      return para();
    }
    if (name === "select") {
      para();
      const opts = n.children.filter((c) => c.name === "option" && c.attribs.value !== "")
        .map((o) => `${squash(textOf(o))}${"data-inf-recommended" in o.attribs ? " (recommended)" : ""}`);
      push(`[choose one: ${opts.join(" | ")}]`);
      return para();
    }
    if (name === "button") {
      para();
      push(`[button: ${squash(textOf(n))}]`);
      return para();
    }
    if (name === "li") {
      para();
      push("- ");
    }
    if (name === "pre") {
      para();
      push(textOf(n));
      return para();
    }
    if (name === "h1" || name === "h2" || name === "h3" || name === "h4") {
      para();
      push("## ");
    }
    if (name === "a" && n.attribs.href && /^https?:/.test(n.attribs.href)) {
      n.children.forEach(walk);
      return push(` (${n.attribs.href})`);
    }
    if (name === "td" || name === "th") push(" | ");
    const block = BLOCK.has(name);
    if (block) para();
    n.children.forEach(walk);
    if (block) para();
  }
  doc.children.forEach(walk);
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").replace(/\n +/g, "\n").trim();
}

export const kindOf = (card) =>
  !card.actions?.length ? "Note" : card.author === "host" ? "Attention" : "Decision";

/**
 * Whether Infinitary's own stage shows the card (onStage, src/shared/cards.ts). A crewmate's
 * new card waits off the stage until its author closes out, and Infinitary refuses a choice on it.
 */
export const onStage = (card) => card.awaiting === undefined || card.sentBackAt !== undefined;

/** Whether the card needs an answer from the captain. */
export const needsAnswer = (card) => (card.actions?.length ?? 0) > 0;

/** The card as a message: title, kind, whole text with questions, then every button. */
export function cardMessage(card, { updated = false, replies = [] } = {}) {
  const lines = [];
  const kind = kindOf(card);
  lines.push(`${updated ? "Updated · " : ""}${kind}${needsAnswer(card) ? "" : " · no answer needed"} · ${card.title}`);
  const meta = [card.meta, card.place, card.model].filter(Boolean).join(" · ");
  if (meta) lines.push(meta);
  lines.push(`card ${card.id}${card.offerId && card.lifecycleId ? ` · offer ${card.offerId} · lifecycle ${card.lifecycleId}` : ""}`);
  lines.push("");
  lines.push(htmlToText(card.body));
  for (const r of card.requiredActions ?? []) {
    lines.push("", `Required action: ${r.title}`, r.consequence, ...r.instructions.map((s, i) => `${i + 1}. ${s}`));
  }
  if (card.pictures?.length) lines.push("", ...card.pictures.map((p) => `[picture: ${p.alt}]`));
  if (card.actions?.length) {
    lines.push("", "Buttons:");
    for (const a of card.actions) {
      const e = a.effect;
      const note = e?.kind === "settle" || e?.kind === "request_merge" ? ` (${e.mode ?? "merge"}; needs --confirm)` : e?.kind === "open" ? " (needs your computer)" : "";
      lines.push(`- ${a.label}${a.default ? " (default)" : ""} [${a.id}]${note}`);
    }
  }
  if (replies.length) {
    lines.push("", "Thread:");
    for (const m of replies) lines.push(`- ${m.who}: ${m.text}`);
  }
  if (card.status === "streaming") lines.push("", "(still being written)");
  lines.push("", `Page: ask for a page of card ${card.id}.`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Splits at paragraph edges so each POST stays under the limit. The limit of Grok bot is unknown. */
export function chunk(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = "";
  for (const piece of text.split(/(?<=\n\n)/)) {
    for (let p = piece; p.length; p = p.slice(max)) {
      const slice = p.slice(0, max);
      if (cur.length + slice.length > max) {
        parts.push(cur);
        cur = "";
      }
      cur += slice;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p, i) => `(${i + 1}/${parts.length})\n${p}`);
}
