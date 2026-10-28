import { parseDocument } from "htmlparser2";

const MAX_VALUE = 16384;
const MAX_WRITTEN = 4000;
const MAX_ANSWERS = 256;
const squash = (s) => s.replace(/\s+/g, " ").trim();
const textOf = (n) => (n.type === "text" ? n.data : (n.children ?? []).map(textOf).join(""));

/** The named questions a card body asks: options, the write-in row, required, and the author's own state. */
export function questionsOf(html) {
  const doc = parseDocument(html ?? "");
  const labelFor = new Map();
  const all = [];
  (function walk(n) {
    if (n.name === "label" && n.attribs?.for) labelFor.set(n.attribs.for, n);
    if (n.name === "script" || n.name === "style" || n.name === "template") return;
    if (n.name === "input" || n.name === "select" || n.name === "textarea") all.push(n);
    n.children?.forEach(walk);
  })(doc);
  const labelOf = (el) => {
    const bound = el.attribs.id && labelFor.get(el.attribs.id);
    if (bound) return squash(textOf(bound));
    for (let p = el.parent; p; p = p.parent) if (p.name === "label") return squash(textOf(p));
    return el.attribs["aria-label"] ?? "";
  };
  const qs = new Map();
  const q = (name) => {
    if (!qs.has(name)) qs.set(name, { name, kind: "text", options: new Map(), writeIn: false, required: false, initial: [] });
    return qs.get(name);
  };
  for (const el of all) {
    const name = el.attribs.name;
    if (!name) continue;
    const type = el.name === "input" ? (el.attribs.type ?? "text").toLowerCase() : el.name;
    if (["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
    const item = q(name);
    if ("required" in el.attribs) item.required = true;
    if (type === "radio" || type === "checkbox") {
      item.kind = type;
      if ("data-inf-write-in" in el.attribs) item.writeIn = true;
      else {
        item.options.set(el.attribs.value ?? "on", labelOf(el));
        if ("checked" in el.attribs) item.initial.push(el.attribs.value ?? "on");
      }
    } else if (type === "select") {
      item.kind = "select";
      if ("multiple" in el.attribs) item.multiple = true;
      for (const o of el.children.filter((c) => c.name === "option")) {
        if ("data-inf-write-in" in o.attribs) item.writeIn = true;
        else if (o.attribs.value !== "") {
          const value = o.attribs.value ?? squash(textOf(o));
          item.options.set(value, squash(textOf(o)));
          if ("selected" in o.attribs) item.initial.push(value);
        }
      }
    } else {
      item.kind = "text";
      if ("data-inf-write-in" in el.attribs) item.writeIn = true;
      else {
        const initial = type === "textarea" ? textOf(el) : el.attribs.value;
        if (initial) item.initial.push(initial);
      }
    }
  }
  return qs;
}

/**
 * Checks answers a person gave against the card's own questions and returns them in the shape
 * the home takes (name, values, labels, changed, written). Throws a sentence for anything the
 * card does not ask: an unknown question, an option that is not offered, a write-in where
 * there is no Something else row, a required question left empty.
 */
export function checkAnswers(card, given) {
  const questions = questionsOf(card.body);
  if (given !== undefined && !Array.isArray(given)) throw new Error("answers must be a list.");
  const list = given ?? [];
  if (list.length > MAX_ANSWERS) throw new Error("Too many answers.");
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (typeof a !== "object" || a === null || Array.isArray(a)) throw new Error("Each answer is an object with a name.");
    const extra = Object.keys(a).filter((k) => !["name", "values", "written"].includes(k));
    if (extra.length) throw new Error(`An answer may carry only name, values and written, not ${extra.join(", ")}.`);
    const q = typeof a.name === "string" ? questions.get(a.name) : undefined;
    if (!q) throw new Error(`The card asks no question named ${JSON.stringify(a.name)}.`);
    if (seen.has(q.name)) throw new Error(`Question ${q.name} is answered twice.`);
    seen.add(q.name);
    const values = a.values ?? [];
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || v.length > MAX_VALUE)) {
      throw new Error(`Question ${q.name}: values must be a list of short texts.`);
    }
    const written = a.written;
    if (written !== undefined && (typeof written !== "string" || !written.trim() || written.length > MAX_WRITTEN)) {
      throw new Error(`Question ${q.name}: written must be words, at most ${MAX_WRITTEN} characters.`);
    }
    if (written !== undefined && !q.writeIn) throw new Error(`Question ${q.name} has no Something else row to write in.`);
    if (q.kind !== "text") {
      for (const v of values) if (!q.options.has(v)) throw new Error(`Question ${q.name} does not offer ${JSON.stringify(v)}.`);
    }
    if ((q.kind === "radio" || (q.kind === "select" && !q.multiple) || q.kind === "text") && values.length > 1) {
      throw new Error(`Question ${q.name} takes one answer.`);
    }
    if ((q.kind === "radio" || (q.kind === "select" && !q.multiple)) && written !== undefined && values.length) {
      throw new Error(`Question ${q.name}: pick an option or write in, not both.`);
    }
    const labels = q.kind === "text" ? [] : values.map((v) => q.options.get(v));
    const same = JSON.stringify([...values].sort()) === JSON.stringify([...q.initial].sort());
    out.push({
      name: q.name,
      values,
      ...(labels.length && labels.every(Boolean) ? { labels } : {}),
      changed: written !== undefined || !same,
      ...(written !== undefined ? { written } : {}),
    });
  }
  for (const q of questions.values()) {
    if (!q.required || seen.has(q.name)) continue;
    if (q.initial.length) continue;
    throw new Error(`Question ${q.name} needs an answer.`);
  }
  for (const a of out) {
    const q = questions.get(a.name);
    if (q.required && !a.values.length && a.written === undefined) throw new Error(`Question ${q.name} needs an answer.`);
  }
  return out;
}
