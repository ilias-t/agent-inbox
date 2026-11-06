import {
  DEFAULT_FLEET, FLEET_COLOR_RE, FLEET_ID_RE, FLEET_LABEL_MAX, FLEET_PREFIX_RE, ROLES,
  type Doc, type Fleet, type Role, type Schedule, type TokenInfo, type UserInfo,
} from "../../shared/types.ts";
import { DAYS, PICKUP_INTERVALS, computeSchedule, parseWorkHours, validateSchedule } from "../../shared/schedule.ts";
import { $, announce, esc, toast } from "../lib/dom.ts";
import { ROLE_HELP, canAct, isAdminRole, isLastAdmin, personNotes, removePrompt, sortUsers } from "../lib/roles.ts";
import { relSpan } from "../lib/time.ts";
import { ApiError, store } from "../store.ts";
import { getTheme, myEmail, myRole, setTheme, state, type Theme } from "../state.ts";
import type { PushSupport } from "../lib/push.ts";
import { devicePushState, devicePushSupport, disableDevicePush, enableDevicePush } from "../pwa.ts";
import { skeleton } from "./rows.ts";

/* ---------- settings: schedule, fleets, agent tokens, people, notifications, account ---------- */
// The page is built once per visit (and again when the viewer's role changes); live state refreshes only touch the
// account line, and refill the schedule form when it has no unsaved edits, so typing is never clobbered by a poll.
// Only admins edit the schedule, manage tokens and set people's roles; everyone else sees the schedule read-only,
// no token list and their own role (the API says 403 anyway).

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage",
  "Pacific/Honolulu", "America/Toronto", "America/Sao_Paulo", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris",
  "Europe/Berlin", "Europe/Amsterdam", "Europe/Madrid", "Europe/Athens", "Europe/Helsinki", "Asia/Jerusalem", "Asia/Dubai",
  "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC"];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Mon–Sun in the selects

const sched = { dirty: false, busy: false, msg: "", kind: "", baseVersion: null as number | null };
const prof = { loaded: false, failed: "", name: "", topic: "", busy: false, msg: "", kind: "" };
// This device's Web Push. state: "loading" until the server key and the browser's subscription are read.
const push = {
  support: "ok" as PushSupport, key: null as string | null, failed: "",
  // taken: this browser's subscription is stored for another account (409 endpoint_taken).
  state: "loading" as "loading" | "on" | "off" | "stale" | "taken", busy: false, msg: "", kind: "",
};
const tok = {
  list: null as TokenInfo[] | null, failed: "", busy: false, msg: "", kind: "",
  name: "", scope: "manager" as "manager" | "orchestrator", orch: "",
  // "": a manager token's own manager id decides (the server's rule); else "default" or a fleet id.
  fleet: DEFAULT_FLEET as string,
  created: null as { name: string; secret: string } | null,
};
// Settings → Fleets (admins): the registry, and the form that adds a fleet or edits the one picked (`editing`).
const flt = {
  list: null as Doc<Fleet>[] | null, failed: "", busy: false, msg: "", kind: "",
  editing: null as string | null, id: "", label: "", color: "", prefix: "",
};
// Settings → People (admins): everyone with a row or Web Push devices, the add form's fields, and the line under them.
const ppl = {
  list: null as UserInfo[] | null, bootstrap: false, failed: "", busy: false, msg: "", kind: "",
  email: "", role: "decider" as Role,
};
let builtFor = ""; // the role the page was built for: a role change rebuilds it

// The status lines below are rebuilt with their text already inside, and a live region only announces text that
// changes after it exists, so each new message also goes to the page's #sr-status (announce), once.
const spoken: Record<string, string> = {};
function speak(key: string, msg: string): void {
  if (spoken[key] === msg) return;
  spoken[key] = msg;
  if (msg) announce(msg);
}

export function renderSettingsPage(box: HTMLElement): void {
  if (!state.loaded) {
    if (state.shownSig !== "loading") { state.shownSig = "loading"; box.innerHTML = skeleton(3); }
    return;
  }
  if (state.shownSig === "settings" && document.getElementById("sched-form") && builtFor === String(myRole())) {
    renderAccount();
    const v = state.schedule;
    if (v && !sched.dirty && !sched.busy && v.version !== sched.baseVersion) fillSchedule();
    return;
  }
  state.shownSig = "settings"; builtFor = String(myRole());
  sched.dirty = false; sched.msg = ""; tok.created = null; tok.msg = ""; prof.msg = ""; push.msg = ""; ppl.msg = ""; flt.msg = "";
  for (const k of Object.keys(spoken)) delete spoken[k];
  const human = state.me?.kind === "human";
  // Phones, once Reviews has Team's place in the bottom bar: Team from here (style.css shows it only then).
  box.innerHTML = '<article class="show settings"><h2 id="page-title" tabindex="-1">Settings</h2>' +
    '<a class="teamlink" href="#team"><span class="tlbl">Team</span><span class="tsub">The managers and their briefings</span><span class="chev" aria-hidden="true">&rsaquo;</span></a>' +
    '<section class="panel stack" aria-labelledby="sched-h"><p class="slabel" id="sched-h">Schedule</p>' + scheduleForm() + "</section>" +
    (isAdmin() && human ? '<section class="panel stack" aria-labelledby="fleet-h"><p class="slabel" id="fleet-h">Fleets</p><div class="stack" id="fleet-body"></div></section>' : "") +
    '<section class="panel stack" aria-labelledby="tok-h"><p class="slabel" id="tok-h">Agent tokens</p><div id="tok-body"></div></section>' +
    (human ? '<section class="panel stack" aria-labelledby="ppl-h"><p class="slabel" id="ppl-h">People</p><div class="stack" id="ppl-body"></div></section>' : "") +
    (human ? '<section class="panel stack" aria-labelledby="me-h"><p class="slabel" id="me-h">Notifications</p><div class="stack" id="push-body"></div><div class="subsec" id="me-body"></div></section>' : "") +
    '<section class="panel stack" aria-labelledby="acct-h"><p class="slabel" id="acct-h">Account</p><div id="acct-body"></div></section>' +
    "</article>";
  wireSchedule();
  fillSchedule();
  renderAccount();
  if (isAdmin() && human) { renderFleets(); loadFleets(); }
  if (isAdmin()) { renderTokens(); loadTokens(); }
  else { tok.list = null; tok.failed = "Only admins manage agent tokens."; renderTokens(); }
  if (human) {
    renderPeople(); if (isAdmin()) loadPeople();
    renderProfile(); loadProfile(); renderPush(); loadPush();
  }
}

// Token callers keep the old behavior (the API answers for them); humans follow their role.
function isAdmin(): boolean { return isAdminRole(myRole()); }

// The change feed saw a users write (main.ts): reload the People list if it's on screen.
export function refreshPeople(): void {
  if (state.shownSig === "settings" && document.getElementById("ppl-body") && isAdmin() && !ppl.busy) loadPeople();
}

/* ----- schedule editor ----- */
function dayOptions(id: string, label: string): string {
  return '<select class="inp" id="' + id + '" aria-label="' + esc(label) + '">' + WEEK.map((d) => '<option value="' + DAYS[d] + '">' + DAYS[d] + "</option>").join("") + "</select>";
}
function scheduleForm(): string {
  return '<form class="sform" id="sched-form" autocomplete="off" novalidate>' +
    '<div class="field"><span class="flabel">Work hours</span><div class="frow">' +
    '<input class="inp" type="time" id="s-start" required aria-label="Start time"><span class="fsep">to</span><input class="inp" type="time" id="s-end" required aria-label="End time"></div></div>' +
    '<div class="field"><span class="flabel">Days</span><div class="frow">' + dayOptions("s-d0", "First day") + '<span class="fsep">to</span>' + dayOptions("s-d1", "Last day") + "</div></div>" +
    '<div class="field"><label class="flabel" for="s-tz">Timezone</label><input class="inp" id="s-tz" list="tz-list" spellcheck="false" autocapitalize="off" placeholder="America/New_York">' +
    '<datalist id="tz-list">' + ZONES.map((z) => '<option value="' + esc(z) + '"></option>').join("") + "</datalist></div>" +
    '<div class="frow2"><div class="field"><label class="flabel" for="s-pick">Pickup every (min)</label><select class="inp" id="s-pick">' + PICKUP_INTERVALS.map((n) => '<option value="' + n + '">' + n + "</option>").join("") + "</select></div>" +
    '<div class="field"><label class="flabel" for="s-sweep">Full sweep every (min)</label><input class="inp" type="number" inputmode="numeric" min="1" max="240" step="1" id="s-sweep"></div></div>' +
    '<div class="spreview" id="s-preview" aria-live="polite"></div>' +
    (isAdmin() ? '<div class="actions"><button type="submit" class="btn primary" id="s-save">Save schedule</button><button type="button" class="btn" id="s-reset">Reset</button></div>'
      : '<p class="small-note">Only admins can change the schedule.</p>') +
    '<div class="status" id="s-status" aria-live="polite"></div></form>';
}
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (min: number) => pad(Math.floor(min / 60) % 24) + ":" + pad(min % 60);
const inp = (id: string) => $<HTMLInputElement>(id);

function fillSchedule(): void {
  const v = state.schedule; if (!v) return;
  const s = v.schedule, wh = parseWorkHours(s.work_hours);
  if (wh) {
    inp("s-start").value = hhmm(wh.start); inp("s-end").value = hhmm(wh.end); // 24:00 shows as 00:00 and reads back as 24:00
    $<HTMLSelectElement>("s-d0").value = DAYS[wh.d0]; $<HTMLSelectElement>("s-d1").value = DAYS[wh.d1];
  }
  inp("s-tz").value = s.timezone;
  // A stored interval the select doesn't offer (older data) gets its own option, so Reset shows what is saved.
  const pick = $<HTMLSelectElement>("s-pick"), cur = String(s.pickup_interval_min);
  if (![...pick.options].some((o) => o.value === cur)) pick.add(new Option(cur, cur));
  pick.value = cur; inp("s-sweep").value = String(s.sweep_interval_min);
  sched.baseVersion = v.version; sched.dirty = false;
  syncSchedule();
}
function readSchedule(): Schedule {
  const d0 = $<HTMLSelectElement>("s-d0").value, d1 = $<HTMLSelectElement>("s-d1").value;
  const end = inp("s-end").value === "00:00" ? "24:00" : inp("s-end").value;
  return {
    work_hours: inp("s-start").value + "-" + end + " " + (d0 === d1 ? d0 : d0 + "-" + d1),
    timezone: inp("s-tz").value.trim(),
    pickup_interval_min: Number($<HTMLSelectElement>("s-pick").value),
    sweep_interval_min: Number(inp("s-sweep").value),
  };
}
// Live preview: the label and the cron the manager will use, or why the schedule is invalid.
function syncSchedule(): void {
  const s = readSchedule(), v = validateSchedule(s), pv = $("s-preview");
  if (!v.ok) {
    pv.innerHTML = '<span class="err">' + esc(v.message) + "</span>";
  } else {
    const c = computeSchedule(v.schedule, new Date());
    pv.innerHTML = "<span>" + esc(c.label) + " &middot; " + (c.in_hours ? "in hours now" : "off hours now") + "</span>" +
      '<span>Orchestrator cron (UTC): ' + c.cron_utc.map((x) => "<code>" + esc(x) + "</code>").join(" + ") + "</span>" +
      (c.cron_exact ? "" : '<span class="small-note">The window isn\'t on whole UTC hours, so the cron also fires just outside it; the orchestrator skips those runs.</span>') +
      '<span class="small-note">Recomputed after a DST change: the orchestrator re-reads it on its pickups.</span>';
  }
  if (!isAdmin()) {
    $<HTMLFormElement>("sched-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select").forEach((el) => { el.disabled = true; });
    return;
  }
  $<HTMLButtonElement>("s-save").disabled = sched.busy || !v.ok || !sched.dirty;
  $<HTMLButtonElement>("s-reset").disabled = sched.busy || !sched.dirty;
  const st = $("s-status"); st.textContent = sched.msg; st.className = "status" + (sched.kind ? " " + sched.kind : "");
}
function wireSchedule(): void {
  const form = $<HTMLFormElement>("sched-form");
  form.addEventListener("input", () => { sched.dirty = true; sched.msg = ""; sched.kind = ""; syncSchedule(); });
  form.addEventListener("change", () => { sched.dirty = true; syncSchedule(); });
  document.getElementById("s-reset")?.addEventListener("click", () => { sched.msg = ""; sched.kind = ""; fillSchedule(); }); // admins only
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (sched.busy) return;
    const v = validateSchedule(readSchedule());
    if (!v.ok) { sched.msg = v.message; sched.kind = "err"; syncSchedule(); return; }
    sched.busy = true; sched.msg = "Saving…"; sched.kind = ""; syncSchedule();
    try {
      const view = await store.putSchedule(v.schedule, sched.baseVersion);
      state.schedule = view;
      sched.busy = false; sched.msg = "Saved. The orchestrator re-reads the schedule on its next pickup."; sched.kind = "ok";
      fillSchedule();
      toast("Schedule saved");
    } catch (e) {
      sched.busy = false; sched.kind = "err";
      const err = e instanceof ApiError ? e : null;
      if (err && err.status === 409) {
        // Someone (the manager, another tab) saved first. Keep the edits; the next Save overwrites theirs.
        const cur = err.current as Doc<Schedule> | null;
        if (cur && state.schedule) {
          state.schedule = { ...state.schedule, schedule: cur.data, version: cur.version, computed: computeSchedule(cur.data, new Date()) };
          sched.baseVersion = cur.version;
        }
        sched.msg = "The schedule changed elsewhere" + (cur ? " (now " + cur.data.work_hours + ", " + cur.data.timezone + ")" : "") + ". Save again to replace it, or Reset to load it.";
      } else if (err && err.status === 400) sched.msg = "The server rejected it: " + err.message;
      else if (err && err.status === 403) sched.msg = "You don't have permission to change the schedule.";
      else if (err && err.status === 401) sched.msg = "Signed out — reload to sign in again.";
      else sched.msg = "Couldn't save the schedule. Try again.";
      syncSchedule();
    }
  });
}

/* ----- agent tokens ----- */
async function loadTokens(): Promise<void> {
  try { tok.list = await store.listTokens(); tok.failed = ""; }
  catch (e) {
    const st = e instanceof ApiError ? e.status : 0;
    tok.failed = st === 403 ? "Token management is only available when you're signed in through Cloudflare Access." : "Couldn't load tokens.";
  }
  renderTokens();
}
function tokenRow(t: TokenInfo): string {
  const scope = t.scope === "orchestrator" ? "manager · " + (t.orchestrator || "?") : "orchestrator";
  const fleet = t.fleet && t.fleet !== DEFAULT_FLEET ? t.fleet : "";
  return '<div class="tokrow' + (t.revoked_at ? " revoked" : "") + '"><div class="tokmain">' +
    '<span class="tokname">' + esc(t.name) + '</span><span class="badge ' + (t.scope === "manager" ? "running" : "pr-open") + '">' + esc(scope) + "</span>" +
    (fleet ? '<span class="badge proposed">' + swatch(fleetColor(fleet)) + "fleet " + esc(fleet) + "</span>" : "") + "</div>" +
    '<div class="tokmeta">' + (t.revoked_at ? "<span>revoked " + relSpan(t.revoked_at) + "</span>" : "") +
    "<span>" + (t.last_used_at ? "used " + relSpan(t.last_used_at) : "never used") + "</span>" +
    "<span>created " + relSpan(t.created_at) + "</span><span class=\"mono\">" + esc(t.id) + "</span></div>" +
    (t.revoked_at ? "" : '<button type="button" class="btn" data-revoke="' + esc(t.id) + '" data-name="' + esc(t.name) + '"' + (tok.busy ? " disabled" : "") + ">Revoke</button>") +
    "</div>";
}
function renderTokens(): void {
  const body = document.getElementById("tok-body"); if (!body) return;
  let h = '<p class="small-note">Bearer tokens for the orchestrator and manager sessions (the CLI and <code>/agent/api</code>). A manager token only sees and writes its own items.</p>';
  if (!isAdmin()) { body.innerHTML = h + '<div class="status">' + esc(tok.failed) + "</div>"; return; }
  if (tok.created) {
    const snippet = "export AGENT_INBOX_URL=" + location.origin + "/agent AGENT_INBOX_TOKEN=" + tok.created.secret;
    h += '<div class="secret" role="group" aria-label="New token">' +
      "<strong>Token “" + esc(tok.created.name) + "” created. Copy it now: it won't be shown again.</strong>" +
      '<code class="secretval" id="tok-secret">' + esc(tok.created.secret) + "</code>" +
      '<pre class="snippet" id="tok-snippet">' + esc(snippet) + "</pre>" +
      '<div class="actions"><button type="button" class="btn primary" data-copy="tok-secret">Copy token</button><button type="button" class="btn" data-copy="tok-snippet">Copy CLI snippet</button><button type="button" class="btn" id="tok-done">Done</button></div></div>';
  }
  if (tok.failed) h += '<div class="status err">' + esc(tok.failed) + "</div>";
  else if (!tok.list) h += '<div class="skel"><div class="bar"></div><div class="bar"></div></div>';
  else if (!tok.list.length) h += '<div class="rows"><div class="empty compact"><span class="small">No tokens yet.</span></div></div>';
  else {
    const list = tok.list.slice().sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || b.created_at.localeCompare(a.created_at));
    h += '<div class="rows toklist">' + list.map(tokenRow).join("") + "</div>";
  }
  if (!tok.failed) {
    const orchIds = state.orchestrators.map((o) => o.id);
    h += '<form class="sform" id="tok-form" autocomplete="off"><p class="slabel">New token</p>' +
      '<div class="frow2"><div class="field"><label class="flabel" for="tok-name">Name</label><input class="inp" id="tok-name" maxlength="64" required placeholder="orchestrator-laptop" value="' + esc(tok.name) + '"></div>' +
      '<div class="field"><label class="flabel" for="tok-scope">Scope</label><select class="inp" id="tok-scope">' +
      '<option value="manager"' + (tok.scope === "manager" ? " selected" : "") + ">Orchestrator</option>" +
      '<option value="orchestrator"' + (tok.scope === "orchestrator" ? " selected" : "") + ">Manager</option></select></div></div>" +
      '<div class="field" id="tok-orch-field"' + (tok.scope === "orchestrator" ? "" : " hidden") + '><label class="flabel" for="tok-orch">Manager id</label>' +
      '<input class="inp" id="tok-orch" list="orch-list" maxlength="64" placeholder="O3" spellcheck="false" autocapitalize="characters" value="' + esc(tok.orch) + '">' +
      '<datalist id="orch-list">' + orchIds.map((id) => '<option value="' + esc(id) + '"></option>').join("") + "</datalist></div>" +
      '<div class="field"><label class="flabel" for="tok-fleet">Fleet</label><select class="inp" id="tok-fleet" aria-describedby="tok-fleet-note">' +
      fleetOptions() + "</select>" +
      '<p class="small-note" id="tok-fleet-note">A token reads and writes only its fleet\'s items and managers. A manager token belongs to the fleet that owns its manager id.</p></div>' +
      '<div class="actions"><button type="submit" class="btn primary" id="tok-create"' + (tok.busy ? " disabled" : "") + ">" + (tok.busy ? "Working…" : "Create token") + "</button></div>" +
      '<div class="status' + (tok.kind ? " " + tok.kind : "") + '">' + esc(tok.msg) + "</div></form>";
  }
  body.innerHTML = h;
  wireTokens(body);
  speak("tok", tok.msg);
}
function wireTokens(body: HTMLElement): void {
  body.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const text = $(b.dataset.copy || "").textContent || "";
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch { toast("Couldn't copy. Select the text and copy it by hand."); }
  }));
  document.getElementById("tok-done")?.addEventListener("click", () => { tok.created = null; renderTokens(); });
  body.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach((b) => b.addEventListener("click", () => revoke(b.dataset.revoke || "", b.dataset.name || "")));
  const form = document.getElementById("tok-form") as HTMLFormElement | null; if (!form) return;
  const name = inp("tok-name"), scope = $<HTMLSelectElement>("tok-scope"), orch = inp("tok-orch"), fleet = $<HTMLSelectElement>("tok-fleet");
  name.addEventListener("input", () => { tok.name = name.value; });
  orch.addEventListener("input", () => { tok.orch = orch.value; });
  fleet.addEventListener("change", () => { tok.fleet = fleet.value; });
  scope.addEventListener("change", () => {
    tok.scope = scope.value === "orchestrator" ? "orchestrator" : "manager";
    $("tok-orch-field").hidden = tok.scope !== "orchestrator";
    // "From its manager id" is a manager token's choice only; a manager token starts on it.
    const inherit = fleet.querySelector<HTMLOptionElement>('option[value=""]');
    if (inherit) inherit.hidden = inherit.disabled = tok.scope !== "orchestrator";
    if (tok.scope === "orchestrator" && tok.fleet === DEFAULT_FLEET) tok.fleet = "";
    if (tok.scope === "manager" && tok.fleet === "") tok.fleet = DEFAULT_FLEET;
    fleet.value = tok.fleet;
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (tok.busy) return;
    const n = tok.name.trim(), o = tok.orch.trim();
    if (!n) { tok.msg = "Give the token a name."; tok.kind = "err"; renderTokens(); return; }
    if (tok.scope === "orchestrator" && !o) { tok.msg = "A manager token needs the manager id (O3)."; tok.kind = "err"; renderTokens(); return; }
    tok.busy = true; tok.msg = ""; tok.kind = ""; renderTokens();
    try {
      const r = await store.createToken(n, tok.scope, tok.scope === "orchestrator" ? o : null, tok.fleet || null);
      tok.created = { name: r.token.name, secret: r.secret };
      tok.list = (tok.list || []).concat([r.token]);
      tok.name = ""; tok.orch = "";
    } catch (e) {
      tok.kind = "err";
      // 400: bad input or an unknown fleet; 409: a live token already has the name, or the manager id is another
      // fleet's. All explain themselves.
      tok.msg = e instanceof ApiError && (e.status === 400 || e.status === 409) ? "Couldn't create it: " + e.message : "Couldn't create the token. Try again.";
    }
    tok.busy = false; renderTokens();
  });
}
async function revoke(id: string, name: string): Promise<void> {
  if (!id || tok.busy) return;
  if (!confirm("Revoke token “" + name + "”? Sessions using it lose access right away.")) return;
  tok.busy = true; renderTokens();
  try {
    await store.revokeToken(id);
    tok.msg = "Revoked “" + name + "”."; tok.kind = "ok";
    await loadTokens();
  } catch {
    tok.msg = "Couldn't revoke the token. Try again."; tok.kind = "err";
  }
  tok.busy = false; renderTokens();
}

/* ----- fleets (/api/fleets): admins add and label them; tokens are minted for one above ----- */
// The fleets an admin can mint for: the registry when loaded, else the ids /api/state knows.
function fleetIds(): string[] {
  const ids = flt.list ? flt.list.map((f) => f.id) : Object.keys(state.base?.fleets ?? {});
  return [...new Set([DEFAULT_FLEET, ...ids])].sort((a, b) => (a === DEFAULT_FLEET ? -1 : b === DEFAULT_FLEET ? 1 : a.localeCompare(b)));
}
function fleetDoc(id: string): Doc<Fleet> | null {
  return flt.list?.find((f) => f.id === id) ?? state.base?.fleets?.[id]?.doc ?? null;
}
function fleetColor(id: string): string { return fleetDoc(id)?.data.color ?? ""; }
// A colour dot. SVG fill rather than a style attribute: the page's CSP has no inline styles.
function swatch(color: string): string {
  if (!FLEET_COLOR_RE.test(color)) return "";
  return '<svg class="swatch" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="6" fill="' + esc(color) + '"/></svg>';
}
function fleetName(id: string): string {
  const label = fleetDoc(id)?.data.label;
  const base = id === DEFAULT_FLEET ? "Default" : id;
  return label && label !== base ? base + " (" + label + ")" : base;
}
function fleetOptions(): string {
  const opt = (value: string, text: string, hidden = false) =>
    '<option value="' + esc(value) + '"' + (tok.fleet === value ? " selected" : "") + (hidden ? " hidden disabled" : "") + ">" + esc(text) + "</option>";
  return opt("", "From its manager id", tok.scope !== "orchestrator") + fleetIds().map((id) => opt(id, fleetName(id))).join("");
}

async function loadFleets(): Promise<void> {
  try { flt.list = await store.listFleets(); flt.failed = ""; }
  catch { flt.failed = "Couldn't load fleets."; }
  renderFleets();
  // The token form's fleet choices, without rebuilding the form (someone may be typing in it).
  const sel = document.getElementById("tok-fleet") as HTMLSelectElement | null;
  if (sel) { sel.innerHTML = fleetOptions(); sel.value = tok.fleet; }
}
function fleetRow(f: Doc<Fleet>): string {
  const d = f.data;
  return '<div class="tokrow"><div class="tokmain">' + swatch(d.color ?? "") +
    '<span class="tokname">' + esc(f.id === DEFAULT_FLEET ? "Default" : f.id) + "</span>" +
    (d.label ? "<span>" + esc(d.label) + "</span>" : "") + "</div>" +
    '<div class="tokmeta">' + (d.id_prefix ? "<span>manager ids " + esc(d.id_prefix) + "1, " + esc(d.id_prefix) + "2…</span>" : "") +
    "<span>added " + relSpan(f.created_at) + "</span></div>" +
    '<button type="button" class="btn" data-fleet-edit="' + esc(f.id) + '"' + (flt.busy ? " disabled" : "") + ">Edit</button></div>";
}
function renderFleets(): void {
  const body = document.getElementById("fleet-body"); if (!body) return;
  let h = '<p class="small-note">A fleet is one orchestrator, its managers and their items. Add one here, then mint its orchestrator token below with the fleet picked. People see every fleet; a token only its own.</p>';
  if (flt.failed) h += '<div class="status err">' + esc(flt.failed) + "</div>";
  else if (!flt.list) h += '<div class="skel"><div class="bar"></div></div>';
  else if (flt.list.length) h += '<div class="rows toklist">' + flt.list.map(fleetRow).join("") + "</div>";
  else h += '<div class="rows"><div class="empty compact"><span class="small">Only the default fleet so far.</span></div></div>';
  const editing = flt.editing;
  h += '<form class="sform" id="fleet-form" autocomplete="off"><p class="slabel">' + (editing ? "Edit fleet " + esc(editing) : "New fleet") + "</p>" +
    '<div class="frow2"><div class="field"><label class="flabel" for="fleet-id">Id</label><input class="inp" id="fleet-id" maxlength="32" required spellcheck="false" autocapitalize="none" placeholder="side-a" value="' + esc(flt.id) + '"' + (editing ? " readonly" : "") + "></div>" +
    '<div class="field"><label class="flabel" for="fleet-label">Label</label><input class="inp" id="fleet-label" maxlength="' + FLEET_LABEL_MAX + '" placeholder="Side project A" value="' + esc(flt.label) + '"></div></div>' +
    '<div class="frow2"><div class="field"><label class="flabel" for="fleet-color">Colour</label><input class="inp" id="fleet-color" maxlength="7" spellcheck="false" placeholder="#3b82f6" value="' + esc(flt.color) + '"></div>' +
    '<div class="field"><label class="flabel" for="fleet-prefix">Manager id prefix</label><input class="inp" id="fleet-prefix" maxlength="8" spellcheck="false" placeholder="S" value="' + esc(flt.prefix) + '"></div></div>' +
    '<div class="actions"><button type="submit" class="btn primary" id="fleet-save"' + (flt.busy ? " disabled" : "") + ">" + (flt.busy ? "Working…" : editing ? "Save fleet" : "Add fleet") + "</button>" +
    (editing ? '<button type="button" class="btn" id="fleet-cancel">Cancel</button>' : "") + "</div>" +
    '<div class="status' + (flt.kind ? " " + flt.kind : "") + '">' + esc(flt.msg) + "</div></form>";
  body.innerHTML = h;
  wireFleets(body);
  speak("fleet", flt.msg);
}
function wireFleets(body: HTMLElement): void {
  body.querySelectorAll<HTMLButtonElement>("[data-fleet-edit]").forEach((b) => b.addEventListener("click", () => {
    const f = flt.list?.find((x) => x.id === b.dataset.fleetEdit); if (!f) return;
    Object.assign(flt, { editing: f.id, id: f.id, label: f.data.label ?? "", color: f.data.color ?? "", prefix: f.data.id_prefix ?? "", msg: "", kind: "" });
    renderFleets();
    inp("fleet-label").focus();
  }));
  document.getElementById("fleet-cancel")?.addEventListener("click", () => {
    Object.assign(flt, { editing: null, id: "", label: "", color: "", prefix: "", msg: "", kind: "" });
    renderFleets();
  });
  const form = document.getElementById("fleet-form") as HTMLFormElement | null; if (!form) return;
  for (const [id, key] of [["fleet-id", "id"], ["fleet-label", "label"], ["fleet-color", "color"], ["fleet-prefix", "prefix"]] as const) {
    const el = inp(id); el.addEventListener("input", () => { flt[key] = el.value; });
  }
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (flt.busy) return;
    const id = flt.id.trim(), label = flt.label.trim(), color = flt.color.trim(), prefix = flt.prefix.trim();
    const problem =
      id !== DEFAULT_FLEET && !FLEET_ID_RE.test(id) ? "The id is lowercase letters, numbers and -, starting with a letter (up to 32)." :
      color && !FLEET_COLOR_RE.test(color) ? "The colour is #rrggbb, like #3b82f6." :
      prefix && !FLEET_PREFIX_RE.test(prefix) ? "The prefix is a letter, then up to 7 letters or numbers." : "";
    if (problem) { flt.msg = problem; flt.kind = "err"; renderFleets(); return; }
    flt.busy = true; flt.msg = ""; flt.kind = ""; renderFleets();
    try {
      const cur = flt.editing ? flt.list?.find((f) => f.id === flt.editing) : undefined;
      if (cur) await store.patchFleet(id, { label: label || null, color: color || null, id_prefix: prefix || null }, cur.version);
      else await store.putFleet(id, { ...(label ? { label } : {}), ...(color ? { color } : {}), ...(prefix ? { id_prefix: prefix } : {}) }, 0);
      flt.msg = (cur ? "Saved " : "Added ") + id + "."; flt.kind = "ok";
      Object.assign(flt, { editing: null, id: "", label: "", color: "", prefix: "" });
    } catch (e) {
      flt.kind = "err";
      flt.msg = e instanceof ApiError && e.status === 409 ? "That fleet changed or already exists: reload and try again." :
        e instanceof ApiError && e.status === 400 ? "Couldn't save it: " + e.message : "Couldn't save the fleet. Try again.";
    }
    flt.busy = false;
    await loadFleets();
  });
}

/* ----- people and roles (/api/users): admins set them; everyone else sees their own ----- */
async function loadPeople(): Promise<void> {
  try {
    const r = await store.listUsers();
    ppl.list = r.users; ppl.bootstrap = !!r.bootstrap; ppl.failed = "";
  } catch (e) {
    ppl.failed = e instanceof ApiError && e.status === 403 ? "Only admins manage people." : "Couldn't load people.";
  }
  renderPeople();
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
function roleSelect(id: string, label: string | null, value: Role, disabled: boolean, lockAdmin = false): string {
  return '<select class="inp" id="' + id + '"' + (label ? ' aria-label="' + esc(label) + '"' : "") + (disabled ? " disabled" : "") + ">" +
    ROLES.map((r) => '<option value="' + r + '"' + (r === value ? " selected" : "") + (lockAdmin && r !== "admin" ? " disabled" : "") + ">" + r[0].toUpperCase() + r.slice(1) + "</option>").join("") +
    "</select>";
}
function personRow(u: UserInfo, i: number, list: UserInfo[]): string {
  const last = isLastAdmin(list, u.email), me = u.email === myEmail(), dis = ppl.busy;
  const who = (u.name ? esc(u.name) + ' <span class="mono">' + esc(u.email) + "</span>" : '<span class="mono">' + esc(u.email) + "</span>") + (me ? " (you)" : "");
  const meta = personNotes(u, last);
  // Someone with only Web Push devices: choosing a role adds them; Remove deletes the devices.
  const rm = u.has_row === false ? "Remove " + u.email + "'s devices" : "Remove " + u.email;
  return '<div class="tokrow"><div class="tokmain"><span class="tokname">' + who + "</span></div>" +
    (meta.length ? '<div class="tokmeta">' + meta.map((m) => "<span>" + esc(m) + "</span>").join("") + "</div>" : "") +
    '<div class="pplacts">' + roleSelect("ppl-role-" + i, "Role for " + u.email, u.role, dis, last) +
    '<button type="button" class="btn" data-ppl-rm="' + i + '" aria-label="' + esc(rm) + '"' + (dis || last ? " disabled" : "") + ">Remove</button></div></div>";
}
function renderPeople(): void {
  const body = document.getElementById("ppl-body"); if (!body) return;
  const role = myRole();
  if (!isAdmin()) {
    body.innerHTML = '<p class="acct">Your role: <b>' + esc(role || "?") + "</b></p>" +
      '<p class="small-note">' + esc(ROLE_HELP[role || "viewer"]) + " An admin changes roles here.</p>";
    return;
  }
  let h = '<p class="small-note">' + esc(ROLE_HELP.admin + " " + ROLE_HELP.decider + " " + ROLE_HELP.viewer) +
    " Cloudflare Access decides who can sign in at all; someone it lets in without a role here is a viewer.</p>";
  if (ppl.bootstrap) {
    h += '<p class="small-note"><b>No admin is saved yet</b>, so everyone Access lets in is an admin. Your first change here saves you as an admin; from then on, people without a role are viewers.</p>';
  }
  if (ppl.failed) h += '<div class="status err">' + esc(ppl.failed) + "</div>";
  else if (!ppl.list) h += '<div class="skel"><div class="bar"></div><div class="bar"></div></div>';
  else if (!ppl.list.length) h += '<div class="rows"><div class="empty compact"><span class="small">Nobody saved yet.</span></div></div>';
  else {
    const list = sortUsers(ppl.list);
    h += '<div class="rows toklist" id="ppl-list">' + list.map((u, i) => personRow(u, i, list)).join("") + "</div>";
  }
  const dis = ppl.busy ? " disabled" : "";
  h += '<form class="sform" id="ppl-form" autocomplete="off" novalidate><p class="slabel">Add someone</p>' +
    '<div class="frow2"><div class="field"><label class="flabel" for="ppl-email">Email</label><input class="inp" type="email" id="ppl-email" maxlength="254" spellcheck="false" autocapitalize="off" placeholder="teammate@example.com" value="' + esc(ppl.email) + '"' + dis + "></div>" +
    '<div class="field"><label class="flabel" for="ppl-newrole">Role</label>' + roleSelect("ppl-newrole", null, ppl.role, ppl.busy) + "</div></div>" +
    '<div class="actions"><button type="submit" class="btn primary" id="ppl-add"' + (ppl.busy || !EMAIL_RE.test(ppl.email.trim()) ? " disabled" : "") + ">" + (ppl.busy ? "Saving…" : "Add") + "</button></div>" +
    '<p class="small-note">Also add them to the Access policy, or they can\'t sign in.</p>' +
    '<div class="status' + (ppl.kind ? " " + ppl.kind : "") + '">' + esc(ppl.msg) + "</div></form>";
  body.innerHTML = h;
  speak("ppl", ppl.msg);
  wirePeople(body);
}
function wirePeople(body: HTMLElement): void {
  const list = ppl.list ? sortUsers(ppl.list) : [];
  list.forEach((u, i) => {
    const sel = document.getElementById("ppl-role-" + i) as HTMLSelectElement | null;
    sel?.addEventListener("change", () => savePerson(u.email, { role: sel.value as Role },
      u.has_row === false ? "Added " + u.email + " as " + sel.value + "." : "Saved: " + u.email + " is now " + sel.value + "."));
  });
  body.querySelectorAll<HTMLButtonElement>("[data-ppl-rm]").forEach((b) => b.addEventListener("click", () => {
    const u = list[Number(b.dataset.pplRm)]; if (u) removePerson(u);
  }));
  const form = document.getElementById("ppl-form") as HTMLFormElement | null; if (!form) return;
  const email = inp("ppl-email"), role = $<HTMLSelectElement>("ppl-newrole");
  email.addEventListener("input", () => { ppl.email = email.value; $<HTMLButtonElement>("ppl-add").disabled = ppl.busy || !EMAIL_RE.test(email.value.trim()); });
  role.addEventListener("change", () => { ppl.role = role.value as Role; });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const e = ppl.email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) { ppl.msg = "Enter an email address."; ppl.kind = "err"; renderPeople(); return; }
    savePerson(e, { role: ppl.role }, "Added " + e + " as " + ppl.role + ".", true);
  });
}
function peopleError(e: unknown, what: string): string {
  const err = e instanceof ApiError ? e : null;
  if (err && err.status === 409) return err.message; // last_admin
  if (err && err.status === 400) return "Couldn't " + what + ": " + err.message;
  if (err && err.status === 403) return "Only admins manage people.";
  if (err && err.status === 401) return "Signed out — reload to sign in again.";
  return "Couldn't " + what + ". Try again.";
}
async function savePerson(email: string, body: { role?: Role }, okMsg: string, adding = false): Promise<void> {
  if (ppl.busy) return;
  ppl.busy = true; ppl.msg = ""; ppl.kind = ""; renderPeople();
  try {
    await store.putUser(email, body);
    ppl.msg = okMsg; ppl.kind = "ok";
    if (adding) ppl.email = "";
  } catch (e) {
    ppl.msg = peopleError(e, adding ? "add them" : "change the role"); ppl.kind = "err";
  }
  ppl.busy = false;
  await loadPeople();
}
async function removePerson(u: UserInfo): Promise<void> {
  if (ppl.busy) return;
  if (!confirm(removePrompt(u))) return;
  ppl.busy = true; ppl.msg = ""; ppl.kind = ""; renderPeople();
  try {
    await store.deleteUser(u.email);
    ppl.msg = u.has_row === false ? "Removed " + u.email + "'s Web Push devices." : "Removed " + u.email + "."; ppl.kind = "ok";
  } catch (e) {
    ppl.msg = peopleError(e, "remove them"); ppl.kind = "err";
  }
  ppl.busy = false;
  await loadPeople();
}

/* ----- your notifications: display name and ntfy topic (your users row, via /api/people/me) ----- */
async function loadProfile(): Promise<void> {
  try {
    const me = await store.getMyPerson();
    prof.name = me.name || ""; prof.topic = me.ntfy_topic || ""; prof.loaded = true; prof.failed = "";
  } catch {
    prof.failed = "Couldn't load your notification settings.";
  }
  renderProfile();
}
function randomTopic(): string {
  return "agent-inbox-" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function renderProfile(): void {
  const body = document.getElementById("me-body"); if (!body) return;
  let h = '<p class="small-note">Items assigned to you push to your ntfy topic; unassigned items push to everyone\'s. Teammates see your name, never your topic.' +
    (canAct(myRole()) ? "" : " As a viewer you get no ntfy pushes (their buttons decide); this device's notifications above still work.") + "</p>";
  if (prof.failed) { body.innerHTML = h + '<div class="status err">' + esc(prof.failed) + "</div>"; return; }
  if (!prof.loaded) { body.innerHTML = h + '<div class="skel"><div class="bar"></div><div class="bar"></div></div>'; return; }
  const dis = prof.busy ? " disabled" : "";
  h += '<form class="sform" id="me-form" autocomplete="off" novalidate>' +
    '<div class="field"><label class="flabel" for="me-name">Display name</label><input class="inp" id="me-name" maxlength="100" placeholder="Shown on items assigned to you" value="' + esc(prof.name) + '"' + dis + "></div>" +
    '<div class="field"><label class="flabel" for="me-topic">ntfy topic</label><div class="frow">' +
    '<input class="inp mono" id="me-topic" maxlength="64" spellcheck="false" autocapitalize="off" placeholder="agent-inbox-…" value="' + esc(prof.topic) + '"' + dis + ">" +
    '<button type="button" class="btn" id="me-gen"' + dis + ">Generate</button></div>" +
    '<span class="small-note">Long and random: anyone who knows a topic on ntfy.sh can read it. Subscribe to it in the ntfy app. Leave it empty for no personal pushes.</span></div>' +
    '<div class="actions"><button type="submit" class="btn primary" id="me-save"' + dis + ">" + (prof.busy ? "Saving…" : "Save") + "</button></div>" +
    '<div class="status' + (prof.kind ? " " + prof.kind : "") + '">' + esc(prof.msg) + "</div></form>";
  body.innerHTML = h;
  speak("prof", prof.msg);
  const name = inp("me-name"), topic = inp("me-topic");
  name.addEventListener("input", () => { prof.name = name.value; });
  topic.addEventListener("input", () => { prof.topic = topic.value; });
  $("me-gen").addEventListener("click", () => { prof.topic = randomTopic(); topic.value = prof.topic; topic.focus(); });
  $<HTMLFormElement>("me-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (prof.busy) return;
    const t = prof.topic.trim();
    if (t && !/^[A-Za-z0-9_-]{1,64}$/.test(t)) { prof.msg = "A topic is 1–64 letters, digits, - or _."; prof.kind = "err"; renderProfile(); return; }
    prof.busy = true; prof.msg = ""; prof.kind = ""; renderProfile();
    try {
      const saved = await store.putMyPerson({ name: prof.name.trim() || undefined, ntfy_topic: t || undefined });
      prof.name = saved.name || ""; prof.topic = saved.ntfy_topic || "";
      prof.msg = saved.ntfy_topic ? "Saved. New pushes for you go to this topic." : "Saved. You get no personal pushes."; prof.kind = "ok";
      toast("Notification settings saved");
    } catch (e) {
      prof.kind = "err";
      prof.msg = e instanceof ApiError && e.status === 400 ? "The server rejected it: " + e.message : "Couldn't save. Try again.";
    }
    prof.busy = false; renderProfile();
  });
}

/* ----- this device's Web Push (src/pwa.ts, /api/push) ----- */
async function loadPush(): Promise<void> {
  push.support = devicePushSupport(); push.failed = ""; push.state = "loading";
  renderPush();
  if (push.support !== "ok") return;
  try {
    // Fetched now, not on click: iOS only prompts for permission when nothing is awaited first.
    push.key = await store.getPushKey();
    const cur = await devicePushState(push.key);
    push.state = cur.state;
    // Re-confirm a working subscription quietly, so one the server dropped (a failed push, a reset) comes back.
    // A 409 means the server has it for another account (a shared browser): pushes here go to them, not you.
    if (cur.state === "on" && cur.sub) {
      store.subscribePush(cur.sub).catch((e) => {
        if (e instanceof ApiError && e.status === 409 && push.state === "on") { push.state = "taken"; renderPush(); }
        /* otherwise shown as on; a test push will tell */
      });
    }
  } catch (e) {
    push.failed = e instanceof ApiError && e.status === 503 ? "Web Push isn't configured on the server: " + e.message : "Couldn't check notifications on this device.";
  }
  renderPush();
}
const PUSH_CHIP: Record<string, [string, string]> = {
  on: ["on", "On"], off: ["off", "Off"], stale: ["stale", "Needs re-enabling"], taken: ["stale", "Another account's"], loading: ["off", "Checking…"],
  blocked: ["blocked", "Blocked"], unsupported: ["off", "Not available"], install: ["off", "Off"],
};
function renderPush(): void {
  const body = document.getElementById("push-body"); if (!body) return;
  const view = push.support === "ok" ? push.state : push.support;
  const [cls, label] = PUSH_CHIP[view];
  const dis = push.busy ? " disabled" : "";
  let h = '<div class="pushrow"><span class="flabel">This device</span><span class="pushstate ' + cls + '">' + label + "</span></div>" +
    '<p class="small-note">Push straight to this phone or browser: the same items as ntfy, encrypted end to end to the device.</p>';
  if (push.support === "install") {
    h += '<p class="small-note"><b>Add to Home Screen first.</b> On iPhone and iPad, notifications only work in the installed app: tap Share, then Add to Home Screen, open Inbox from the Home Screen, and come back here.</p>';
  } else if (push.support === "unsupported") {
    h += '<p class="small-note">This browser can\'t receive Web Push' + (/iPhone|iPad/.test(navigator.userAgent) ? " (it needs iOS 16.4 or later)" : "") + ". ntfy below still works.</p>";
  } else if (push.support === "blocked") {
    h += '<p class="small-note">Notifications are blocked for this site. Allow them in the browser\'s site settings (on iPhone: Settings, Notifications, Inbox), then reload.</p>';
  } else if (push.failed) {
    h += '<div class="status err">' + esc(push.failed) + "</div>";
  } else if (push.state === "on") {
    h += '<div class="actions"><button type="button" class="btn" id="push-test"' + dis + '>Send test notification</button><button type="button" class="btn" id="push-off"' + dis + ">Turn off on this device</button></div>";
  } else if (push.state !== "loading") {
    if (push.state === "stale") h += '<p class="small-note">The server\'s key changed since this device subscribed, so pushes can\'t reach it. Enable it again.</p>';
    if (push.state === "taken") h += '<p class="small-note">Notifications on this browser are turned on for another account, so they get the pushes here, not you. Enabling them for you turns them off for that account on this browser.</p>';
    h += '<div class="actions"><button type="button" class="btn primary" id="push-on"' + (push.busy || !push.key ? " disabled" : "") + ">Enable notifications on this device</button></div>";
  }
  h += '<div class="status' + (push.kind ? " " + push.kind : "") + '">' + esc(push.msg) + "</div>";
  body.innerHTML = h;
  speak("push", push.msg);
  document.getElementById("push-on")?.addEventListener("click", enablePush);
  document.getElementById("push-off")?.addEventListener("click", disablePush);
  document.getElementById("push-test")?.addEventListener("click", testPush);
}
function pushDone(msg: string, kind: "ok" | "err" | ""): void { push.busy = false; push.msg = msg; push.kind = kind; renderPush(); }
// From the click itself: enableDevicePush asks for permission before awaiting anything else.
async function enablePush(): Promise<void> {
  if (push.busy || !push.key) return;
  // Another account's subscription on this browser: make a new one (a new endpoint) rather than reuse it.
  const asking = enableDevicePush(push.key, push.state === "taken");
  push.busy = true; push.msg = "Asking for permission…"; push.kind = ""; renderPush();
  try {
    const sub = await asking;
    if (!sub) { push.support = devicePushSupport(); pushDone("Notifications weren't allowed.", "err"); return; }
    await store.subscribePush(sub);
    push.state = "on";
    pushDone("On. New asks, answers and reassigns reach this device. Send a test to check.", "ok");
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      push.state = "taken";
      pushDone("This browser's notifications belong to another account. Tap Enable again to switch them to you.", "err");
      return;
    }
    pushDone("Couldn't turn notifications on: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}
async function disablePush(): Promise<void> {
  if (push.busy) return;
  push.busy = true; push.msg = ""; renderPush();
  try {
    const endpoint = await disableDevicePush();
    if (endpoint) await store.unsubscribePush(endpoint);
    push.state = "off";
    pushDone("Off on this device.", "ok");
  } catch {
    pushDone("Couldn't turn notifications off. Try again.", "err");
  }
}
async function testPush(): Promise<void> {
  if (push.busy) return;
  push.busy = true; push.msg = "Sending…"; push.kind = ""; renderPush();
  try {
    const r = await store.testPush();
    if (r.sent) pushDone("Sent to " + r.sent + (r.sent === 1 ? " device" : " devices") + (r.failed ? "; " + r.failed + " failed" : "") + ". It should arrive in a few seconds.", "ok");
    else if (r.removed) { pushDone("The push service says this device's subscription has expired. Enable it again.", "err"); push.state = "off"; renderPush(); }
    else pushDone(r.failed ? "The push service refused it. Try again, or turn notifications off and on." : "No devices are registered for you. Enable notifications again.", "err");
  } catch {
    pushDone("Couldn't send the test. Try again.", "err");
  }
}

/* ----- account + theme ----- */
const THEMES: [Theme, string][] = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
function renderAccount(): void {
  const body = document.getElementById("acct-body"); if (!body) return;
  const me = state.me, t = getTheme();
  const who = !me ? "Not signed in"
    : me.kind === "human" ? "Signed in as <b>" + esc(me.email) + "</b>"
    : "Using token <b>" + esc(me.name) + "</b> (" + esc(me.scope === "orchestrator" ? "manager " + me.orchestrator : "orchestrator") + ")";
  body.innerHTML = '<p class="acct">' + who + "</p>" +
    '<div class="field"><span class="flabel" id="theme-lbl">Theme</span><div class="seg" role="radiogroup" aria-labelledby="theme-lbl">' +
    THEMES.map(([v, l]) => '<button type="button" role="radio" class="segbtn" data-theme-opt="' + v + '" aria-checked="' + (t === v) + '">' + l + "</button>").join("") +
    "</div></div>";
  body.querySelectorAll<HTMLButtonElement>("[data-theme-opt]").forEach((b) => b.addEventListener("click", () => {
    setTheme(b.dataset.themeOpt as Theme); renderAccount();
    (body.querySelector('[data-theme-opt="' + b.dataset.themeOpt + '"]') as HTMLElement | null)?.focus();
  }));
}
