// Escaping and small DOM helpers. Everything rendered goes through esc() / safeUrl(); views build HTML strings.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function safeUrl(u: unknown): string | null {
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
}

// Typed getElementById; callers own the element ids in index.html and the views.
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// Live regions announce changes to their text only while they're in the accessibility tree, so they
// stay rendered (visually hidden when empty) and only their text changes. The same message twice is
// cleared first and set again a moment later, so it's announced again.
const liveSeq = new WeakMap<HTMLElement, number>();
export function setLive(el: HTMLElement, msg: string): void {
  const n = (liveSeq.get(el) || 0) + 1;
  liveSeq.set(el, n);
  if (!msg || el.textContent !== msg) { el.textContent = msg; return; }
  el.textContent = "";
  setTimeout(() => { if (liveSeq.get(el) === n) el.textContent = msg; }, 60);
}

// For status text whose visible line is rebuilt with the page (a fresh region would stay silent).
export function announce(msg: string): void {
  const el = document.getElementById("sr-status");
  if (el) setLive(el, msg); // "" clears it silently, so the next message is a change
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
// sticky: stays until dismissed or replaced (signed out, live updates stopped). quiet: shown but not announced, for a
// message the page already announces another way (an alert on the item page's status line).
export function toast(msg: string, sticky = false, quiet = false): void {
  clearTimeout(toastTimer);
  $("toast-close").hidden = !sticky;
  const t = $("toast");
  t.setAttribute("aria-live", quiet ? "off" : "polite");
  setLive(t, msg);
  $("toast-box").classList.remove("empty");
  if (!sticky) toastTimer = setTimeout(hideToast, 4200);
}
export function hideToast(): void {
  clearTimeout(toastTimer);
  setLive($("toast"), "");
  $("toast-box").classList.add("empty");
  $("toast-close").hidden = true;
}
