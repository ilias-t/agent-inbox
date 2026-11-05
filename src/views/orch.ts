import { esc, safeUrl } from "../lib/dom.ts";
import { PR_LABEL, PRIO, isAsk, isAuto, isOpen, pastItems, prioOf } from "../lib/items.ts";
import { md } from "../lib/md.ts";
import { relSpan, toMs } from "../lib/time.ts";
import { orchById, state } from "../state.ts";
import { chatButton, itemRow, orchBadge, skeleton } from "./rows.ts";
import { pinKey } from "../lib/pins.ts";
import { pinButton, pinSig } from "./pins.ts";

/* ---------- orchestrator show page ---------- */
export function renderOrchPage(id: string, box: HTMLElement): void {
  if (!state.loaded) {
    if (state.shownSig !== "loading") { state.shownSig = "loading"; box.innerHTML = skeleton(2); }
    return;
  }
  const o = orchById(id);
  if (!o) {
    state.shownSig = "gone";
    box.innerHTML = '<div class="panel empty"><strong>No manager called ' + esc(id) + '.</strong><a class="btn" href="#team">Back to the team</a></div>';
    return;
  }
  const mine = state.items.filter((i) => i.orchestrator === id);
  const pinned = pinKey("orch", id);
  const sig = JSON.stringify([o, mine, pinSig(pinned)]);
  if (sig === state.shownSig) return;
  state.shownSig = sig;
  const asks = mine.filter(isAsk).sort((a, b) => PRIO[prioOf(a)] - PRIO[prioOf(b)] || (toMs(a.created_at) || 0) - (toMs(b.created_at) || 0));
  const autos = mine.filter(isAuto).sort((a, b) => (Number(isOpen(b)) - Number(isOpen(a))) || (toMs(b.created_at) || 0) - (toMs(a.created_at) || 0));
  const past = pastItems(state.items).filter((i) => i.orchestrator === id && !isAuto(i));
  // The briefing in the same order on every orchestrator, so a context switch reads in seconds: whose briefing and how
  // fresh, the goal as the heading, Why and Where it stands, then what it needs from you.
  let h = '<article class="show orch">';
  h += '<div class="ohead"><span class="okick"><span class="oid">' + esc(o.id) + "</span> <span>Manager briefing</span></span>" +
    (o.updated_at ? '<span class="oupd">updated ' + relSpan(o.updated_at) + "</span>" : "") + pinButton(pinned, "Team") + "</div>";
  h += '<h2 class="ogoal" id="page-title" tabindex="-1"><span class="vh">Goal: </span>' + esc(o.goal || "(no goal)") + "</h2>";

  h += '<section class="obrief" aria-label="Briefing">';
  h += '<h3 class="olbl">Why</h3>' + (o.motivation ? '<div class="md">' + md(o.motivation) + "</div>" : '<p class="unset">No motivation recorded yet.</p>');
  const stand = o.summary ? md(o.summary) : o.headline ? "<p>" + esc(o.headline) + "</p>" : "";
  h += '<h3 class="olbl">Where it stands</h3>' + (stand ? '<div class="md">' + stand + "</div>" : '<p class="unset">The orchestrator hasn\'t written a summary yet.</p>');
  h += "</section>";

  let needs = "";
  if (o.asks) needs += '<div class="md">' + md(o.asks) + "</div>";
  if (asks.length) needs += '<div class="rows">' + asks.map((i) => itemRow(i, { hideOrch: true })).join("") + "</div>";
  if (!needs) needs = '<p class="calm">Nothing — running on its own</p>';
  h += '<section class="oneeds' + (asks.length || o.asks ? " has" : "") + '" aria-labelledby="needs-h"><h3 class="olbl" id="needs-h">Needs from you' +
    (asks.length ? ' <span class="nopen"><b>' + asks.length + "</b> open</span>" : "") + "</h3>" + needs + "</section>";

  const kv: [string, string][] = [["Status", orchBadge(o)]];
  const pr = o.pr as { number?: number; url?: string; state?: string; title?: string } | undefined;
  const prUrl = pr && safeUrl(pr.url);
  if (pr && prUrl) {
    kv.push(["Pull request", '<a href="' + esc(prUrl) + '" target="_blank" rel="noopener">#' + esc(pr.number) + (pr.title ? " " + esc(pr.title) : "") + "</a>" +
      (pr.state && PR_LABEL[pr.state] ? ' <span class="chip prs ' + esc(pr.state) + '">' + esc(PR_LABEL[pr.state]) + "</span>" : "")]);
  } else kv.push(["Pull request", '<span class="unset">None yet</span>']);
  if (o.session_title) kv.push(["Session", esc(o.session_title)]);
  h += '<dl class="okv">' + kv.map((r) => "<div><dt>" + r[0] + "</dt><dd>" + r[1] + "</dd></div>").join("") + "</dl>";
  const chat = chatButton(o, "Open chat");
  if (chat) h += chat.replace('class="btn"', 'class="btn primary big ochat"');

  if (autos.length) {
    h += '<section class="osec"><h3 class="olbl">Auto-decided &middot; ' + autos.length + '</h3><div class="rows">' +
      autos.map((i) => isOpen(i) ? itemRow(i, { fyi: true, hideOrch: true }) : itemRow(i, { past: true, hideOrch: true })).join("") + "</div></section>";
  }
  h += '<section class="osec"><h3 class="olbl">History &middot; ' + past.length + "</h3>";
  h += past.length
    ? '<div class="rows">' + past.map((i) => itemRow(i, { past: true, hideOrch: true })).join("") + "</div>"
    : '<div class="rows"><div class="empty compact"><span class="small">Nothing from ' + esc(o.id) + " has been decided yet.</span></div></div>";
  h += "</section></article>";
  box.innerHTML = h;
}
