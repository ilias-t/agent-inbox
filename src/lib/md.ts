import { esc } from "./dom.ts";

// XSS-safe markdown subset: paragraphs, "-" and "1." lists, "#" headings as bold lines, ``` fences, "> " quotes,
// "---" rules, `code`, **bold**, *em*, _em_ and [label](https://url). Every piece of input text is escaped
// before it reaches the output, so only the tags produced here reach the page; the only attribute values
// built from input are a fence language matching LANG_RE and a list start number.
export function inlineMd(src: string): string {
  let s = esc(src);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return s;
}

const LANG_RE = /^[a-z0-9+#-]{1,20}$/i;
const FENCE_OPEN = /^(\s*)(`{3,})([^`]*)$/; // a backtick in the info string makes it inline code, as in CommonMark
const FENCE_CLOSE = /^\s*(`{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const MAX_QUOTE_DEPTH = 8; // deeper ">" runs render as text instead of recursing further

// Removes up to n leading whitespace characters (a fence's own indentation) from a content line.
function dedent(line: string, n: number): string {
  let k = 0;
  while (k < n && (line[k] === " " || line[k] === "\t")) k++;
  return line.slice(k);
}

function blocks(lines: string[], depth: number): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; start: number; items: string[] } | null = null;
  const flushPara = () => { if (para.length) { out.push("<p>" + para.map(inlineMd).join("<br>") + "</p>"); para = []; } };
  const flushList = () => {
    if (!list) return;
    const open = list.tag === "ol" && list.start !== 1 ? '<ol start="' + list.start + '">' : "<" + list.tag + ">";
    out.push(open + list.items.map((l) => "<li>" + inlineMd(l) + "</li>").join("") + "</" + list.tag + ">");
    list = null;
  };
  const addItem = (tag: "ul" | "ol", text: string, start = 1) => {
    flushPara();
    if (list && list.tag !== tag) flushList();
    (list = list || { tag, start, items: [] }).items.push(text);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      flushPara(); flushList();
      const indent = fence[1].length, ticks = fence[2].length, lang = fence[3].trim().split(/\s+/)[0];
      const code: string[] = [];
      // An unterminated fence runs to the end of the input.
      for (i++; i < lines.length; i++) {
        const close = lines[i].match(FENCE_CLOSE);
        if (close && close[1].length >= ticks) break;
        code.push(dedent(lines[i], indent));
      }
      out.push('<div class="codeblock"><button type="button" class="copybtn" data-copy-code aria-label="Copy code">Copy</button><pre><code' + (LANG_RE.test(lang) ? ' class="lang-' + lang + '"' : "") + ">" + esc(code.join("\n")) + "</code></pre></div>");
      continue;
    }
    if (depth < MAX_QUOTE_DEPTH && QUOTE.test(line)) {
      flushPara(); flushList();
      const inner: string[] = [];
      for (; i < lines.length; i++) {
        const q = lines[i].match(QUOTE);
        if (!q) break;
        inner.push(q[1]);
      }
      i--;
      out.push("<blockquote>" + blocks(inner, depth + 1) + "</blockquote>");
      continue;
    }
    const b = line.match(BULLET), o = line.match(ORDERED), h = line.match(HEADING);
    if (RULE.test(line)) { flushPara(); flushList(); out.push("<hr>"); }
    else if (b) addItem("ul", b[1]);
    else if (o) addItem("ol", o[2], Number(o[1]));
    else if (h) { flushPara(); flushList(); out.push('<p class="h">' + inlineMd(h[1]) + "</p>"); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join("");
}

export function md(src: unknown): string {
  if (!src) return "";
  return blocks(String(src).replace(/\r\n?/g, "\n").split("\n"), 0);
}

// One-line plain text from markdown (for the orchestrator context strip).
export function plain(src: unknown): string {
  return String(src || "")
    .replace(/^\s*`{3,}.*$/gm, "")
    .replace(/^(\s*>)+\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*([-*+]|#{1,6}|\d{1,9}[.)])\s+/gm, "")
    .replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}
