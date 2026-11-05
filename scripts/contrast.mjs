#!/usr/bin/env node
// WCAG contrast of the UI's text and boundaries, computed from the color tokens in src/style.css
// (light :root and :root[data-theme="dark"]), including the color-mix() tints chips sit on.
// Usage: node scripts/contrast.mjs [--all]   (default: failures only; exits 1 if any)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(resolve(fileURLToPath(import.meta.url), "../../src/style.css"), "utf8");

function tokens(selector) {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error("no block " + selector);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}
const THEMES = { light: tokens(":root"), dark: { ...tokens(":root"), ...tokens(':root[data-theme="dark"]') } };
// Dark is defined twice (prefers-color-scheme, and the explicit Dark choice); the copies must not drift.
{
  const auto = tokens(':root:not([data-theme="light"])'), manual = tokens(':root[data-theme="dark"]');
  const drift = [...new Set([...Object.keys(auto), ...Object.keys(manual)])].filter((k) => auto[k] !== manual[k]);
  if (drift.length) { console.error("Dark token copies differ: " + drift.map((k) => "--" + k).join(", ")); process.exit(1); }
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// color-mix(in srgb, a p, b): a straight lerp of the gamma-encoded channels. With `transparent` as b
// the result is a at alpha p, which composites over the backdrop the same way.
const mix = (a, p, b) => a.map((v, i) => v * p + b[i] * (1 - p));
const lum = (c) => {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

// [label, fg, backdrop, min]; fg/backdrop are functions of the theme's tokens (t) returning [r,g,b].
// Text is 4.5 unless large; boundaries of controls are 3.
const backdrops = {
  surface: (t) => rgb(t.surface),
  "surface-2": (t) => rgb(t["surface-2"]),
  bg: (t) => rgb(t.bg),
  field: (t) => rgb(t.field),
  "warn-soft": (t) => rgb(t["warn-soft"]),
  inv: (t) => rgb(t.inv), // the offline banner
  ink: (t) => rgb(t.ink), // a chosen History filter pill
  ghead: (t) => mix(rgb(t.muted), 0.06, rgb(t.surface)),
  checked: (t) => rgb(t["surface-2"]), // a selected option card
  "accent-soft": (t) => rgb(t["accent-soft"]), // a checked segment (.segbtn)
  "team-current": (t) => mix(rgb(t.accent), 0.1, rgb(t.surface)), // the open orchestrator's Team row (the split view)
  well: (t) => rgb(t.well), // the phone item page's focus strip
  pane: (t) => rgb(t.pane), // the detail pane beside the list (the split view)
  "peek-1": (t) => rgb(t["peek-1"]), // the peek stack's cards, nearest to farthest
  "peek-2": (t) => rgb(t["peek-2"]),
  "peek-3": (t) => rgb(t["peek-3"]),
};
const tint = (tintTok, p, inkTok = tintTok) => (t, back) => ({ fg: rgb(t[inkTok]), bg: mix(rgb(t[tintTok]), p, back) });
const plain = (tok) => (t, back) => ({ fg: rgb(t[tok]), bg: back });

const checks = [];
const add = (label, fn, on, min = 4.5) => { for (const b of on) checks.push({ label, on: b, fn, min }); };

// Neutral text. ghead = the index's group-header band.
add("--faint text", plain("faint"), ["surface", "bg", "ghead", "surface-2"]);
add("--muted text", plain("muted"), ["surface", "bg", "ghead", "surface-2", "accent-soft"]);
add("--ink text", plain("ink"), ["accent-soft", "well"]);
// The phone's focus strip (the manager status, Queue) and the peek stack's card edges.
add("--warn-ink (.fstatus .tick.warn)", plain("warn-ink"), ["well"]);
add("--accent-text (.back.toqueue:hover)", plain("accent-text"), ["well"]);
add("--muted text (.peek nearest card)", plain("muted"), ["peek-1"]);
add("--faint text (.peek cards behind)", plain("faint"), ["peek-1", "peek-2", "peek-3"]);
// Small chips on their own tint. "checked" = inside a selected option block; bg = the item page's
// sections that aren't panels (Recommendation, the meta line).
add(".choice .rec Recommended", tint("ok", 0.14, "ok-ink"), ["surface", "checked"]);
add(".choice .rec.mine Your call", tint("accent", 0.14, "accent-text"), ["surface"]);
add(".conf.high", tint("ok", 0.14, "ok-ink"), ["surface", "bg"]);
add(".conf.medium", tint("warn", 0.14, "warn-ink"), ["surface", "bg"]);
add(".conf.low", tint("muted", 0.14), ["surface", "bg"]);
add(".rtag.rev", tint("ok", 0.13, "ok-ink"), ["surface", "checked"]);
add(".rtag.oneway", tint("danger", 0.13, "danger-ink"), ["surface", "checked"]);
add(".tb proposal", tint("t-proposal", 0.13), ["surface", "bg"]);
add(".tb decision", tint("t-decision", 0.13, "decision-ink"), ["surface", "bg"]);
add(".tb pr_ready", tint("t-pr", 0.13, "ok-ink"), ["surface", "bg"]);
add(".tb blocker", tint("t-blocker", 0.13), ["surface", "bg"]);
add(".tb info", tint("t-info", 0.13), ["surface", "bg"]);
add(".tb auto_decided", tint("t-auto", 0.13, "auto-ink"), ["surface", "bg"]);
add(".badge done", tint("ok", 0.13, "ok-ink"), ["surface"]);
add(".badge parked", tint("warn", 0.13, "warn-ink"), ["surface"]);
add(".badge running/approved", tint("accent", 0.13, "accent-text"), ["surface"]);
add(".badge blocked", tint("danger", 0.13), ["surface"]);
add(".badge.ost.blocked (an orchestrator's status word)", plain("danger-ink"), ["surface", "bg", "pane", "team-current"]);
add(".chip.prs.changes_requested", plain("danger-ink"), ["surface", "bg"]);
add(".badge pr-open", tint("t-decision", 0.13, "decision-ink"), ["surface"]);
add(".badge proposed", tint("muted", 0.13), ["surface"]);
add(".badge dropped/cleaned", tint("faint", 0.13, "muted"), ["surface"]);
add(".who initials", tint("muted", 0.14), ["surface"]);
// Plain colored text
// Text in a hue uses its -text / -ink token (the bare hue is for dots, fills and borders). What needs you is the
// accent (red is for what's wrong).
const hued = ["surface", "bg", "surface-2"];
add("--accent-text (links)", plain("accent-text"), hued);
add("--accent-text (.hbadge .need, .ocount, .ghead.high, .mainnav .count.hot, .smeta .prio.high)", plain("accent-text"), [...hued, "ghead"]);
add("--ok-ink (.status.ok, .vchoice)", plain("ok-ink"), hued);
add("--warn-ink (.late, .cadence .off)", plain("warn-ink"), hued);
add("--warn-ink on --warn-soft (.secret)", plain("warn-ink"), ["warn-soft"]);
add("--inv-ink on --inv (.offline banner)", plain("inv-ink"), ["inv"]);
add("--bg on --ink (.hchip chosen)", plain("bg"), ["ink"]);
add("--ink on --warn-soft", plain("ink"), ["warn-soft"]);
add("--decision-ink (.msg .who b, PR merged)", plain("decision-ink"), hued);
add("--danger text", plain("danger"), ["surface", "bg"]);
add("--t-decision text", plain("t-decision"), ["surface", "bg"]);
add("--ink on the Q&A bubbles", (t) => ({ fg: rgb(t.ink), bg: rgb(t["bubble-mine"]) }), ["surface"]);
add("--ink on the Q&A bubbles", (t) => ({ fg: rgb(t.ink), bg: rgb(t["bubble-theirs"]) }), ["bg"]);
add("--accent-ink on --accent (primary button)", (t) => ({ fg: rgb(t["accent-ink"]), bg: rgb(t.accent) }), ["surface"]);
add(".qbox label", (t) => ({ fg: rgb(t["t-decision"]), bg: mix(rgb(t["t-decision"]), 0.07, rgb(t.surface)) }), ["surface"]);
// Reviews: a run's chips (what it posted) in the feed on the page, in a run page's card, and on the pane's own ground;
// the meta lines and marks there.
for (const [label, tok, ink] of [["rv-ok", "ok", "ok-ink"], ["rv-chg", "danger", "danger"], ["rv-held", "warn", "warn-ink"], ["rv-you", "accent", "accent-text"], ["rv-quiet", "muted", "muted"]]) {
  add(".badge." + label, tint(tok, 0.13, ink), ["bg", "surface", "pane"]);
}
for (const tok of ["ink", "muted", "faint", "accent-text"]) add("--" + tok + " on the detail pane (run and PR pages)", plain(tok), ["pane"]);
add("--ok (.pm.rvg.approved, a glyph)", plain("ok"), ["bg", "surface", "pane"], 3);
// Input boundaries (1.4.11): the border against both sides of it (inputs are filled with --field and
// sit on a panel or the page).
// The open orchestrator's row in the Team list: its id and goal, the meta line (updated, open count), the status word.
for (const tok of ["ink", "muted", "faint", "accent-text", "danger-ink", "ok-ink"]) add("--" + tok + " on the current Team row", plain(tok), ["team-current"]);
add("--field-edge input border", plain("field-edge"), ["field", "surface", "bg"], 3);

const all = process.argv.includes("--all");
let failed = 0;
const rows = [];
for (const c of checks) {
  const cells = Object.entries(THEMES).map(([name, t]) => {
    const { fg, bg } = c.fn(t, backdrops[c.on](t));
    const r = ratio(fg, bg), ok = r >= c.min;
    if (!ok) failed++;
    return { name, r, ok };
  });
  if (all || cells.some((x) => !x.ok)) rows.push([c.label, c.on, ...cells.map((x) => x.r.toFixed(2) + (x.ok ? "" : " ✗")), c.min]);
}
if (rows.length) {
  console.log("| check | on | light | dark | min |\n|---|---|---|---|---|");
  for (const r of rows) console.log("| " + r.join(" | ") + " |");
}
if (failed) { console.log("\n" + failed + " below minimum"); process.exitCode = 1; }
else console.log((rows.length ? "\n" : "") + "All " + checks.length * 2 + " checks pass (light and dark).");
