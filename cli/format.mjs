// Human-readable output. `--json` bypasses all of this.

const pad = (s, n) => String(s ?? "").padEnd(n);

function ago(iso, nowMs) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.round((nowMs - t) / 1000);
  const abs = Math.abs(s);
  const span = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
  return s >= 0 ? `${span} ago` : `in ${span}`;
}

export function itemLine(doc) {
  const d = doc.data ?? {};
  const flags = [d.qa_pending ? "qa?" : "", d.pr_state ? `pr:${d.pr_state}` : "", d.assignee ? `@${d.assignee}` : ""]
    .filter(Boolean)
    .join(" ");
  return [
    pad(doc.id, 28),
    pad(d.status, 10),
    pad(d.type, 12),
    pad(d.orchestrator ?? "-", 5),
    pad(d.priority ?? "", 6),
    d.question || d.title,
    flags ? ` [${flags}]` : "",
  ].join(" ");
}

export function itemsList(items) {
  if (!items.length) return "(no items)";
  return items.map(itemLine).join("\n");
}

function links(label, list) {
  if (!Array.isArray(list) || !list.length) return [];
  return [`${label}:`, ...list.map((l) => `  - ${l.label}: ${l.url}`)];
}

export function qaLines(messages) {
  if (!messages.length) return ["(no questions)"];
  return messages.map((m) => {
    const d = m.data ?? {};
    return `[${d.created_at ?? m.created_at}] ${d.role}${d.by ? ` (${d.by})` : ""}: ${d.text}`;
  });
}

export function itemDetail(doc, messages) {
  const d = doc.data ?? {};
  const rec = d.recommendation ?? (d.recommended ? { option: d.recommended } : null);
  const lines = [
    `${doc.id}  v${doc.version}  ${[d.type, d.status, d.priority, d.orchestrator].filter(Boolean).join(" · ")}`,
    `Title: ${d.title}`,
  ];
  if (d.assignee) lines.push(`Assignee: ${d.assignee}`);
  if (d.question) lines.push(`Question: ${d.question}`);
  if (d.summary) lines.push(`Summary: ${d.summary}`);
  if (d.context) lines.push("Context:", ...String(d.context).split("\n").map((l) => `  ${l}`));
  if (Array.isArray(d.options) && d.options.length) {
    lines.push("Options:");
    for (const o of d.options) {
      const mark = rec?.option === o.id ? "*" : "-";
      const tags = [o.reversible === true ? "reversible" : o.reversible === false ? "one-way" : ""].filter(Boolean);
      lines.push(`  ${mark} ${o.id}: ${o.label}${tags.length ? ` (${tags.join(", ")})` : ""}`);
      for (const k of ["description", "consequence", "tradeoff"]) if (o[k]) lines.push(`      ${k}: ${o[k]}`);
    }
  }
  if (rec) lines.push(`Recommendation: ${rec.option}${rec.confidence ? ` (${rec.confidence})` : ""}${rec.why ? ` — ${rec.why}` : ""}`);
  if (d.command) lines.push(`Run (paste in the asking session): ! ${d.command}`);
  if (d.steps) lines.push("Steps for you:", ...String(d.steps).split("\n").map((l) => `  ${l}`));
  if (d.cost_of_waiting) lines.push(`Cost of waiting: ${d.cost_of_waiting}`);
  lines.push(...links("Evidence", d.evidence), ...links("Links", d.links));
  if (d.decision) {
    const dec = d.decision;
    lines.push(`Decision: ${dec.choice}${dec.note ? ` — ${dec.note}` : ""} (${dec.by ?? "?"}, ${dec.decided_at})`);
  }
  if (d.override_of) lines.push(`Override of: ${d.override_of}`);
  lines.push(`Updated: ${doc.updated_at} by ${doc.updated_by}`);
  if (messages) lines.push(`Q&A${d.qa_pending ? " (question pending)" : ""}:`, ...qaLines(messages).map((l) => `  ${l}`));
  return lines.join("\n");
}

export function docSummary(collection, doc) {
  const status = doc?.data?.status ? `  ${doc.data.status}` : "";
  return `${collection}/${doc.id}  v${doc.version}${status}`;
}

export function orchLine(doc) {
  const d = doc.data ?? {};
  return [pad(doc.id, 5), pad(d.status, 9), d.headline || d.goal || ""].join(" ");
}

export function leaseText(res, nowMs) {
  const lease = res.lease;
  if (!lease) return "lease: free (no holder)";
  const d = lease.data;
  return [
    `lease: ${res.expired ? "EXPIRED" : "held"} by ${d.holder_title ?? "?"} (${d.holder_session_id})  v${lease.version}`,
    `  heartbeat ${ago(d.heartbeat_at, nowMs)} · expires ${ago(d.expires_at, nowMs)} · acquired ${ago(d.acquired_at, nowMs)}`,
    d.holder_url ? `  ${d.holder_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function scheduleText(view) {
  const { schedule: s, computed: c } = view;
  const off = c.utc_offset_min;
  const offset = `UTC${off >= 0 ? "+" : "-"}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${String(Math.abs(off) % 60).padStart(2, "0")}` : ""}`;
  return [
    `Schedule:  ${c.label}  (${s.timezone}, ${offset} now)${view.version === null ? "  [defaults; meta/schedule not written]" : `  v${view.version}`}`,
    `Now:       ${c.in_hours ? "in work hours" : "off hours"}  (${c.now})`,
    `Intervals: pickup every ${s.pickup_interval_min} min · full sweep every ${s.sweep_interval_min} min`,
    `Next:      pickup ${c.next_pickup_at ?? "-"} · window start ${c.next_window_start ?? "-"}`,
    `Cron (UTC, for CronCreate)${c.cron_exact === undefined ? "" : c.cron_exact ? ", exact:" : ", superset:"}`,
    ...c.cron_utc.map((e) => `  ${e}`),
    ...(c.cron_exact === false
      ? ["  The cron covers whole UTC hours, so some firings fall outside work hours:", "  skip a firing when in_hours is false (agent-inbox schedule --check)."]
      : []),
  ].join("\n");
}

export function changeLine(c) {
  const target = `${c.collection}/${c.doc_id}`;
  return `change ${c.seq}  ${c.op}  ${target}${c.version ? ` v${c.version}` : ""}${c.status ? `  ${c.status}` : ""}  by ${c.actor || "?"}  at ${c.at}`;
}

export function stateText(s, nowMs) {
  const byStatus = {};
  for (const i of s.items) byStatus[i.data?.status] = (byStatus[i.data?.status] ?? 0) + 1;
  const counts = Object.entries(byStatus).map(([k, n]) => `${k} ${n}`).join(" · ") || "none";
  const open = s.items.filter((i) => i.data?.status === "open");
  const lines = [
    `me: ${principalText(s.me)}`,
    `items: ${counts}`,
    `orchestrators: ${s.orchestrators.map((o) => `${o.id} ${o.data?.status ?? "?"}`).join(", ") || "none"}`,
    leaseText({ lease: s.lease, expired: s.lease ? Date.parse(s.lease.data.expires_at) < nowMs : false }, nowMs),
    `schedule: ${s.schedule.computed.label} · ${s.schedule.computed.in_hours ? "in hours" : "off hours"}`,
    `cursor: ${s.cursor}`,
  ];
  const m = s.manager?.data;
  if (m) {
    lines.push(`manager: last tick ${m.last_tick ?? "-"} · last pickup ${m.last_pickup ?? "-"} · next ${m.next_tick ?? "-"}`);
    if (m.tick_requested_at) lines.push(`tick requested: ${m.tick_requested_at}${m.tick_requested_note ? ` (${m.tick_requested_note})` : ""}`);
  }
  if (open.length) lines.push("open:", ...open.map((i) => `  ${itemLine(i)}`));
  return lines.join("\n");
}

export function principalText(p) {
  if (!p) return "?";
  if (p.kind === "human") {
    // role since team roles; is_admin alone from a server before them.
    const role = p.role ? ` (${p.role})` : p.is_admin === false ? " (not an admin)" : "";
    return `human ${p.email}${role}`;
  }
  return `token ${p.name} (${p.scope}${p.orchestrator ? ` ${p.orchestrator}` : ""})`;
}

// GET /api/users: "email  role  name" per person.
export function usersText(r) {
  if (!r.users?.length) return "no users yet";
  return r.users.map((u) => [u.email, u.role, u.name].filter(Boolean).join("  ")).join("\n");
}

// --- Reviews (docs/reviews.md) ---

const countsText = (counts) =>
  Object.entries(counts ?? {})
    .map(([s, n]) => `${s} ${n}`)
    .join(", ") || "no PRs";

export function reviewRunLine(run) {
  const d = run.data ?? {};
  const head = [pad(run.stamp, 19), pad(run.result, 14), run.dry ? "[dry] " : ""].join(" ");
  return `${head}${d.headline ?? (run.result === "running" ? `started ${run.started_at}` : d.error ?? "")}`.trimEnd();
}

// A Run-button request (GET /api/reviews/:routine/run-request and its updates): one line.
export function runRequestLine(r) {
  const q = r.request;
  if (!q) return "no run request";
  const tail = [q.stamp && `run ${q.stamp}`, q.message].filter(Boolean).join(" · ");
  return `${pad(q.id, 29)} ${pad(q.status, 10)} by ${q.requested_by} at ${q.requested_at}${tail ? ` · ${tail}` : ""}`;
}

export function reviewReportText(r) {
  if (r.replayed) return `${r.run.stamp}: already stored (${r.run.result}), nothing written`;
  return `${r.run.stamp}: stored (${r.run.result}); ${r.prs_written} PRs written, ${r.events_written} events, ${r.gone} gone`;
}

export function reviewsText(r, nowMs) {
  if (!r.routines?.length) return "(no review routines)";
  return r.routines
    .map((x) => {
      const last = x.last_run ? `last ${x.last_run.stamp} ${x.last_run.result}` : "no finished run";
      const bits = [pad(x.routine, 20), last, countsText(x.counts)];
      if (x.needs_you) bits.push(`needs you ${x.needs_you}`);
      if (x.running) bits.push(`running since ${x.running.started_at}`);
      if (x.next_run_at) bits.push(`next ${ago(x.next_run_at, nowMs)}`);
      return bits.join("  ");
    })
    .join("\n");
}

export function prLine(pr) {
  const d = pr.data ?? {};
  const flags = [pr.needs_you ? "needs you" : "", pr.gone_at ? "gone" : ""].filter(Boolean).join(", ");
  return [pad(`#${pr.number}`, 7), pad(pr.status, 18), d.title ?? "", flags ? ` [${flags}]` : ""].join(" ").trimEnd();
}

export function routineReviewsText(r) {
  const h = r.routine;
  const lines = [`${h.routine}  v${h.version}  last run ${h.last_stamp ?? "-"}${h.next_run_at ? `  next ${h.next_run_at}` : ""}`, "", "PRs:"];
  lines.push(...(r.prs.length ? r.prs.map((p) => `  ${prLine(p)}`) : ["  (none)"]));
  lines.push("", "Runs:", ...(r.runs.length ? r.runs.map((x) => `  ${reviewRunLine(x)}`) : ["  (none)"]));
  if (r.more) lines.push(`  ... older: --before ${r.runs.at(-1).stamp}`);
  return lines.join("\n");
}

export function reviewPrText(r) {
  const d = r.pr.data ?? {};
  const lines = [prLine(r.pr), d.url ?? r.pr.url];
  if (d.status_note) lines.push(`Status: ${d.status_note}`);
  if (d.needs_you?.ask) lines.push(`Needs you: ${d.needs_you.ask}`);
  lines.push("", "Events:");
  lines.push(
    ...(r.events.length
      ? r.events.map((e) => `  ${pad(e.stamp, 19)} ${pad(e.data.action, 17)} ${e.data.summary ?? ""}${e.data.review_url ? ` (${e.data.review_url})` : ""}`.trimEnd())
      : ["  (none)"]),
  );
  return lines.join("\n");
}
