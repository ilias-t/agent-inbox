import { $, esc, setLive, toast } from "../lib/dom.ts";
import { historyTotal } from "../lib/history.ts";
import { inboxCounts, itemHref, openItems, prioOf } from "../lib/items.ts";
import { md, plain } from "../lib/md.ts";
import { pageTitle } from "../lib/page.ts";
import { cadence, offHours, pickupPhrase } from "../lib/sched.ts";
import { digestIsNew, offlineText, tickPending, tickStatus } from "../lib/status.ts";
import { absTime, clockTime, relSpan, relTime, toMs } from "../lib/time.ts";
import { ApiError, store } from "../store.ts";
import { inboxItems, itemById, myRole, orchById, routines, scheduleZone, state } from "../state.ts";
import { isSplit } from "../lib/layout.ts";
import { reviewTitle } from "./reviews.ts";
import { canAct } from "../lib/roles.ts";

/* ---------- manager card: one status line (it opens to the ticks, lease, cadence and Run tick now), then the digest ---------- */
// The summary: the single most useful thing about the manager right now (src/lib/status.ts).
function renderStatus(): void {
  // Offline, the status pauses (the banner says how old what's shown is).
  const s = state.offline ? tickStatus(state.meta, state.lease, state.schedule, Date.now(), { offline: true })
    : !state.meta && !state.loaded ? { kind: "unknown", text: "Waiting for the orchestrator" }
    // An old snapshot from this device is shown until the server confirms it: its manager status would be stale too.
    : state.staleSince !== null ? { kind: "unknown", text: "Saved " + relTime(state.staleSince) + " · updating…" }
    : tickStatus(state.meta, state.lease, state.schedule, Date.now());
  $("tick").className = "tick " + s.kind;
  $("tick-text").textContent = s.text;
  // The same line in the phone's focus strip, above an item (index.html #focus-status).
  $("ftick").className = "tick " + s.kind;
  setText("ftick-text", s.text);
  syncTickButton();
}
// Run tick now: off while a request is saving, and while offline (it couldn't reach the server).
function syncTickButton(): void {
  $<HTMLButtonElement>("tick-btn").disabled = state.tickBusy || state.offline;
}

// The offline banner (index.html #offline): when the inbox on screen is from (src/lib/status.ts offlineText), and
// Try again ([data-retry], src/main.ts).
export function renderOfflineBanner(offline: boolean, at: number | null): void {
  const el = $("offline");
  el.hidden = !offline;
  if (!offline) return;
  const text = offlineText(at, scheduleZone()), lead = "Offline.";
  const t = $("offline-text");
  if (t.textContent !== text) t.innerHTML = "<b>" + lead + "</b>" + esc(text.slice(lead.length));
}

const DIGEST_SEEN = "agent-inbox-digest-seen";
let digestSeen: string | null = null;
try { digestSeen = localStorage.getItem(DIGEST_SEEN); } catch { /* every digest reads as new */ }
// Seen once it has been shown open on the index, so the next visit starts with it collapsed.
function markDigestSeen(text: string): void {
  if (digestSeen === text) return;
  digestSeen = text;
  try { localStorage.setItem(DIGEST_SEEN, text); } catch { /* not persisted */ }
}
function renderDigest(text: string | undefined): void {
  const d = $<HTMLDetailsElement>("digest");
  if (!text) { d.hidden = true; return; }
  // Only a changed digest re-renders (and opens if this viewer hasn't seen it); a live re-render keeps their open/closed choice.
  if (d.dataset.text !== text) {
    d.dataset.text = text;
    $("digest-body").innerHTML = md(text);
    $("digest-prev").textContent = plain(text);
    // "New" marks a digest this viewer hasn't seen: it shows with the digest opening by itself, for this visit (marked
    // seen just below doesn't clear it), until they collapse it.
    const fresh = digestIsNew(text, digestSeen);
    d.open = fresh;
    $("digest-new").hidden = !fresh;
  }
  d.hidden = false;
  if (d.open && state.route.view === "tab") markDigestSeen(text);
}

export function renderMeta(): void {
  const m = state.meta, detail = $("tick-detail"), cad = $("cadence");
  const c = cadence(state.schedule), off = offHours(state.schedule);
  cad.textContent = c.text;
  if (c.off) { const s = document.createElement("span"); s.className = "off"; s.textContent = c.off; cad.appendChild(s); }
  $("tick-form").hidden = !canAct(myRole()); // viewers can't request a tick
  renderStatus();
  if (!m) { detail.hidden = true; renderDigest(undefined); return; }
  const parts: string[] = [];
  if (m.last_tick) parts.push("Last tick " + relSpan(m.last_tick));
  const nextMs = toMs(m.next_tick);
  if (!isNaN(nextMs)) {
    if (nextMs >= Date.now() - 60000) parts.push("next tick " + relSpan(m.next_tick));
    else if (!off) parts.push('<span class="late">tick overdue ' + relSpan(m.next_tick, true) + "</span>");
  }
  if (tickPending(m)) parts.push('<span class="pending" title="' + esc(absTime(m.tick_requested_at)) + '">tick requested at ' + esc(clockTime(m.tick_requested_at)) + "</span>");
  detail.innerHTML = parts.join(" &middot; ");
  detail.hidden = !parts.length;
  renderDigest(m.digest);
}

const SESSION_URL = /^https:\/\/claude\.ai\/code\/cse_[A-Za-z0-9_-]+$/;
// Which manager session holds meta/lease. Read-only: the page never writes the lease.
export function renderLease(): void {
  const el = $("lease"), L = state.lease;
  renderStatus(); // an expired lease can turn the summary into "Manager may be down"
  if (!L) { el.hidden = true; return; }
  const title = L.holder_title || L.holder_session_id || "unknown session";
  const url = typeof L.holder_url === "string" && SESSION_URL.test(L.holder_url) ? L.holder_url : null;
  // An expired lease outside work hours is expected (no pickups run), so it isn't flagged as down.
  const off = offHours(state.schedule);
  const exp = toMs(L.expires_at), down = !isNaN(exp) && Date.now() > exp && !off && !state.offline;
  let h = '<span class="ldot" aria-hidden="true"></span><span>Orchestrator: ' +
    (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title) + "</a>" : "<b>" + esc(title) + "</b>") + "</span>";
  if (!isNaN(toMs(L.heartbeat_at))) h += "<span>&middot; heartbeat " + relSpan(L.heartbeat_at) + "</span>";
  if (down) h += '<span class="late">&middot; orchestrator may be down</span>';
  else if (off && !isNaN(exp) && Date.now() > exp) h += "<span>&middot; idle until work hours</span>";
  el.className = "lease" + (down ? " down" : "");
  el.innerHTML = h; el.hidden = false;
}

export function wireDigest(): void {
  const d = $<HTMLDetailsElement>("digest");
  d.addEventListener("toggle", () => { if (!d.open) $("digest-new").hidden = true; });
}

/* ---------- top bar: the badge and the main nav ---------- */
function setText(id: string, text: string): void {
  const el = $(id); if (el.textContent !== text) el.textContent = text;
}
const NAV_HERE: Record<string, string> = { inbox: "nav-inbox", team: "nav-team", reviews: "nav-reviews", history: "nav-history", settings: "nav-settings" };
// The main nav (index.html #mainnav): each entry's count, the Inbox's hot dot, where Focus goes, and aria-current on
// where you are. Run with every count change (the lists' renders) and on every route.
export function renderNav(): void {
  const asks = state.loaded ? openItems(inboxItems()) : []; // the Inbox's asks in triage order; snoozed ones don't count
  const hot = asks.some((i) => prioOf(i) === "high");
  setText("count-inbox", asks.length ? String(asks.length) : "");
  $("count-inbox").classList.toggle("hot", hot);
  $("hot-inbox").hidden = !hot;
  // Team: active orchestrators only. History: archived items not loaded yet count too (the server's archived_total).
  const team = state.orchestrators.filter((o) => o.status !== "done" && o.status !== "dropped" && o.status !== "cleaned").length;
  setText("count-team", team ? String(team) : "");
  const past = state.loaded ? historyTotal(state.items, state.archive.total) : 0;
  setText("count-history", past ? String(past) : "");
  // Focus (phones): straight to the top ask, the head of the triage order; the Inbox when nothing needs you.
  const focus = $("nav-focus"), href = asks.length ? itemHref(asks[0].id) : "#inbox";
  if (focus.getAttribute("href") !== href) focus.setAttribute("href", href);
  focus.classList.toggle("idle", !asks.length);
  setText("count-focus", asks.length ? String(asks.length) : "");
  // Reviews shows once a routine has reported (docs/reviews.md). On a phone it takes Team's place in the bottom bar,
  // and Team is a link on the Settings page (html[data-reviews], style.css).
  const reviews = routines().length > 0;
  $("nav-reviews").hidden = !reviews;
  document.documentElement.toggleAttribute("data-reviews", reviews);
  // An item page counts as the list it was opened from, an orchestrator's as Team, a run's or a PR's as Reviews.
  const r = state.route;
  let here = NAV_HERE[r.view === "tab" ? r.tab : r.view === "settings" ? "settings" : r.view === "orch" ? "team" : r.view === "item" ? state.tab : "reviews"];
  if (reviews && here === "nav-team" && !isSplit(state.layout)) here = "nav-settings";
  for (const id of [...Object.values(NAV_HERE), "settings-link"]) {
    const el = $(id), on = id === here || (id === "settings-link" && r.view === "settings");
    if (on) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  }
}

// Header badge: asks and FYI counted separately, e.g. "3 need you · 2 FYI".
export function renderBadge(): void {
  const b = $("hbadge");
  if (!state.loaded) { b.hidden = true; return; }
  const { need, fyi } = inboxCounts(inboxItems()); // snoozed items don't count until they wake
  let h = need ? '<span class="need">' + need + " need you</span>" : "<span>Nothing needs you</span>";
  if (fyi) h += '<span class="sep" aria-hidden="true">&middot;</span><span>' + fyi + " FYI</span>";
  b.innerHTML = h; b.hidden = false;
  syncTitle();
}

// "(3) Item title – Agent Inbox": the page, after the open count (which shows in a background tab).
export function syncTitle(): void {
  const r = state.route, need = state.loaded ? openItems(inboxItems()).length : 0;
  const item = r.view === "item" ? itemById(r.id) : null, orch = r.view === "orch" ? orchById(r.id) : null;
  document.title = pageTitle(r, { need, itemTitle: item ? item.title || "" : null, orch: orch && { id: orch.id, goal: orch.goal }, review: reviewTitle() });
}

function tickFeedback(msg: string, kind?: string): void {
  // The region stays rendered (visually hidden while empty), so screen readers hear each message.
  const f = $("tick-fb"); f.className = "tickfb" + (kind ? " " + kind : ""); setLive(f, msg);
}

// The note's cap: the server takes up to 2,000 characters (worker/routes/meta.ts tickRequest). The count shows from
// TICK_NOTE_WARN on, so a long note never runs into the cap unseen.
const TICK_NOTE_MAX = 2000, TICK_NOTE_WARN = 1800;
// One line that grows with its text, up to the CSS max-height (~8 lines), then scrolls.
function growTickNote(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  // Empty, it's one line again: Chrome would count a wrapped placeholder in scrollHeight.
  if (!ta.value) { ta.style.height = ""; ta.classList.remove("scroll"); $("tick-count").hidden = true; return; }
  const max = parseFloat(getComputedStyle(ta).maxHeight) || Infinity, h = ta.scrollHeight + (ta.offsetHeight - ta.clientHeight);
  ta.style.height = Math.min(h, max) + "px";
  ta.classList.toggle("scroll", h > max);
  const n = ta.value.length, count = $("tick-count");
  count.hidden = n < TICK_NOTE_WARN;
  count.textContent = n.toLocaleString("en-US") + " / " + TICK_NOTE_MAX.toLocaleString("en-US");
  count.classList.toggle("full", n >= TICK_NOTE_MAX);
}
// Enter sends with a keyboard, Shift+Enter is a new line; on touch (a phone's Return) Enter is a new line and the
// button sends. Ctrl/⌘+Enter sends everywhere. Never mid-composition (an IME's Enter picks a candidate).
const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function wireTickForm(): void {
  const form = $<HTMLFormElement>("tick-form"), ta = $<HTMLTextAreaElement>("tick-note");
  // The "Enter sends" hint is for keyboards: on touch, Enter is a new line, so screen readers don't hear it there.
  if (coarse()) ta.removeAttribute("aria-describedby");
  ta.addEventListener("input", () => growTickNote(ta));
  ta.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
    if (ev.ctrlKey || ev.metaKey || (!ev.shiftKey && !ev.altKey && !coarse())) { ev.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (state.tickBusy) return;
    const input = ta;
    const note = input.value.trim().slice(0, TICK_NOTE_MAX);
    if (!state.loaded) { tickFeedback("Still connecting. Try again in a moment.", "err"); return; }
    if (state.offline) { tickFeedback("Offline. Request a tick once you're back online.", "err"); return; }
    state.tickBusy = true; syncTickButton(); tickFeedback("Requesting a tick…");
    try {
      const doc = await store.requestTick(note);
      state.meta = doc.data; renderMeta();
    } catch (e) {
      state.tickBusy = false; syncTickButton();
      const st = e instanceof ApiError ? e.status : 0;
      tickFeedback(st === 401 ? "Signed out — reload to sign in again." : st === 403 ? "You don't have permission to request a tick." : "Couldn't save the tick request. Try again.", "err");
      return;
    }
    input.value = ""; growTickNote(input);
    state.tickBusy = false; syncTickButton();
    const msg = "Requested — the orchestrator runs a tick on its next pickup (" + pickupPhrase(state.schedule) + ")";
    tickFeedback(msg, "ok"); toast("Tick requested");
  });
}
