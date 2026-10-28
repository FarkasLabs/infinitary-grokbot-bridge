import { Parser } from "htmlparser2";
import { kindOf, needsAnswer } from "./text.js";

const DROP = new Set(["script", "iframe", "object", "embed", "link", "meta", "base", "form-action"]);
const VOID = new Set(["br", "hr", "img", "input", "col", "wbr", "source", "area"]);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The card's own body, made safe to put in a page: no script, no frames, no handlers,
 * no resource that is not inline (the page's CSP refuses the rest anyway), every control disabled.
 */
export function sanitizeBody(html) {
  let out = "";
  let skipDepth = 0;
  let inStyle = false;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (skipDepth) return void (VOID.has(name) || skipDepth++);
        if (name === "script") return void (skipDepth = 1);
        if (DROP.has(name)) return void (VOID.has(name) || (skipDepth = 1));
        if (name === "style") inStyle = true;
        const kept = [];
        for (const [k, v] of Object.entries(attribs)) {
          const key = k.toLowerCase();
          if (key.startsWith("on") || key === "srcdoc" || key === "formaction") continue;
          if ((key === "src" || key === "href" || key === "xlink:href") && !/^(data:image\/|#|https?:)/i.test(v)) continue;
          if (key === "src" && !/^data:image\//i.test(v)) continue;
          kept.push(` ${key}="${esc(v)}"`);
        }
        const dis = ["input", "select", "textarea", "button"].includes(name) ? " disabled" : "";
        out += `<${name}${kept.join("")}${dis}${VOID.has(name) ? " />" : ">"}`;
      },
      ontext(text) {
        if (skipDepth) return;
        out += inStyle ? text.replace(/@import[^;]*;?/gi, "").replace(/url\([^)]*\)/gi, "none") : esc(text);
      },
      onclosetag(name) {
        if (skipDepth) return void (skipDepth--);
        if (name === "style") inStyle = false;
        if (!VOID.has(name)) out += `</${name}>`;
      },
    },
    { lowerCaseTags: true, recognizeSelfClosing: true },
  );
  parser.write(html ?? "");
  parser.end();
  return out;
}

const STYLE = `
:root{--bg-0:#fff;--bg-1:#f6f6f4;--bg-2:#ececE8;--fg-1:#16161a;--fg-2:#4a4a52;--fg-3:#777782;--line-1:#dcdcd6;--accent:#4b5bd6;--ok:#1e8a4c;--warn:#a96a00;--danger:#c2362b;
--font:"Space Grotesk",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,monospace}
@media(prefers-color-scheme:dark){:root{--bg-0:#121214;--bg-1:#1a1a1e;--bg-2:#232328;--fg-1:#ececf0;--fg-2:#b2b2bc;--fg-3:#80808c;--line-1:#2e2e35;--accent:#8794ff;--ok:#4cc582;--warn:#e0a63b;--danger:#ef6b60}}
*{box-sizing:border-box}body{margin:0;background:var(--bg-0);color:var(--fg-1);font:15px/1.5 var(--font)}
main{max-width:760px;margin:0 auto;padding:16px}
.chip{display:inline-block;font:11px var(--mono);text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border:1px solid var(--line-1);border-radius:999px;color:var(--fg-2)}
.chip.decision{color:var(--accent);border-color:var(--accent)}.chip.attention{color:var(--warn);border-color:var(--warn)}
h1{font-size:20px;margin:10px 0 4px}.meta{font:12px var(--mono);color:var(--fg-3)}
.card{background:var(--bg-1);border:1px solid var(--line-1);border-radius:12px;padding:16px;margin-top:12px;overflow-wrap:anywhere}
.card img,.card svg{max-width:100%;height:auto}fieldset{border:1px solid var(--line-1);border-radius:8px;margin:12px 0}legend{font-weight:600;padding:0 6px}
label{display:block;padding:3px 0}pre,code{font-family:var(--mono);font-size:13px}pre{background:var(--bg-2);padding:10px;border-radius:8px;overflow:auto}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.btn{font:600 14px var(--font);padding:8px 14px;border-radius:8px;border:1px solid var(--line-1);background:var(--bg-2);color:var(--fg-1)}
.btn.default{background:var(--accent);border-color:var(--accent);color:#fff}.btn.danger{color:var(--danger);border-color:var(--danger)}
.note{color:var(--fg-3);font-size:12.5px;margin-top:10px}.thread{margin-top:12px}.msg{padding:6px 0;border-top:1px solid var(--line-1)}
.msg b{font:600 12px var(--mono);color:var(--fg-2)}details{margin-top:10px}`;

/**
 * A self-contained page of one card in Infinitary's look: its body, pictures, required actions,
 * buttons (shown, not pressable: the page only reads) and thread. `pictures` maps a picture id to a data URI.
 */
export function cardPage(card, { thread = [], pictures = {} } = {}) {
  const kind = kindOf(card);
  const pics = (card.pictures ?? [])
    .map((p) => (pictures[p.id] ? `<figure><img src="${esc(pictures[p.id])}" alt="${esc(p.alt)}" width="${p.width}" height="${p.height}"><figcaption class="meta">${esc(p.alt)}</figcaption></figure>` : `<p class="meta">[picture unavailable: ${esc(p.alt)}]</p>`))
    .join("");
  const req = (card.requiredActions ?? [])
    .map((r) => `<details open><summary><b>Required action:</b> ${esc(r.title)}</summary><p>${esc(r.consequence)}</p><ol>${r.instructions.map((i) => `<li>${esc(i)}</li>`).join("")}</ol></details>`)
    .join("");
  const buttons = card.actions?.length
    ? `<div class="actions">${card.actions.map((a) => `<span class="btn${a.default ? " default" : ""}${a.danger || a.variant === "danger" ? " danger" : ""}">${esc(a.label)}</span>`).join("")}</div><p class="note">Buttons are shown for reading. Answering from chat comes later.</p>`
    : `<p class="note">No answer needed.</p>`;
  const msgs = thread.length
    ? `<div class="thread">${thread.map((m) => `<div class="msg"><b>${esc(m.who)}</b><div>${esc(m.text)}</div></div>`).join("")}</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<title>${esc(card.title)}</title><style>${STYLE}</style></head><body><main>
<span class="chip ${kind.toLowerCase()}">${esc(kind)}${needsAnswer(card) ? "" : " · no answer needed"}</span>
<h1>${esc(card.title)}</h1><div class="meta">${esc([card.meta, card.place, card.model].filter(Boolean).join(" · "))}</div>
<div class="card">${sanitizeBody(card.body)}${pics}${req}${buttons}${msgs}</div>
<p class="meta">card ${esc(card.id)}${card.offerId ? ` · version ${esc(card.offerId)}` : ""}</p>
</main></body></html>`;
}
