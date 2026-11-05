// The command table. Each command maps flags to one (or two) API calls and
// prints the response: raw JSON with --json, a readable form otherwise.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  UsageError,
  commaList,
  parseDecision,
  parseIntFlag,
  parseLink,
  parseOption,
  parseRecommend,
  parseSets,
  parseWhen,
} from "./args.mjs";
import {
  changeLine,
  docSummary,
  itemDetail,
  itemsList,
  leaseText,
  orchLine,
  principalText,
  reviewPrText,
  reviewReportText,
  reviewRunLine,
  reviewsText,
  routineReviewsText,
  runRequestLine,
  qaLines,
  scheduleText,
  stateText,
  usersText,
} from "./format.mjs";
import { ApiError } from "./http.mjs";
import { isDone, liveLinks, planRelink, projectDirs, sessionDirs } from "./relink.mjs";
import { changeMatcher, waitForChanges } from "./wait.mjs";

// Exit code for `wait` when --timeout passes without a match.
export const EXIT_TIMEOUT = 4;
// Exit code for `schedule --check` outside work hours.
export const EXIT_OFF_HOURS = 5;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const enc = encodeURIComponent;

function id(arg, what = "id") {
  if (!arg) throw new UsageError(`missing <${what}>`);
  if (!ID_RE.test(arg)) throw new UsageError(`invalid ${what} "${arg}"`);
  return arg;
}

const ifVersionOpt = { "if-version": { type: "string" } };
// A token's write that would change a decided or processing item's status or decision is refused (409 decided,
// docs/api.md "Decided items are kept") unless it says it means it.
const replaceDecidedOpt = { "replace-decided": { type: "boolean" } };
const replaceDecided = (v) => (v["replace-decided"] ? { replace_decided: true } : {});
const ifVersion = (v) => parseIntFlag(v["if-version"], "--if-version");
const fileOpt = { file: { type: "string", short: "f" } };
const setOpts = { set: { type: "string", multiple: true }, unset: { type: "string", multiple: true } };

// --file (object) merged with --set/--unset. --unset k is --set k:=null.
async function dataFrom(ctx, { allowEmpty = false } = {}) {
  const v = ctx.values;
  let data = {};
  if (v.file !== undefined) {
    const parsed = await ctx.readJson(v.file);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--file must hold a JSON object");
    data = parsed;
  }
  Object.assign(data, parseSets(v.set));
  for (const k of v.unset ?? []) data[k] = null;
  if (!allowEmpty && Object.keys(data).length === 0) throw new UsageError("nothing to write: pass --set key=value or --file");
  return data;
}

// A body field only when given (if_version 0 is meaningful, so no truthiness).
function withPin(body, pin) {
  if (pin !== undefined) body.if_version = pin;
  return body;
}

// PATCH, or create with PUT (if_version 0) when the doc doesn't exist yet and
// the caller didn't pin a version.
async function patchOrCreate(api, path, data, pin) {
  try {
    return await api("PATCH", path, { body: withPin({ data }, pin) });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404 && pin === undefined)) throw err;
    const created = Object.fromEntries(Object.entries(data).filter(([, val]) => val !== null));
    try {
      return await api("PUT", path, { body: { data: created, if_version: 0 } });
    } catch (putErr) {
      if (!(putErr instanceof ApiError && putErr.status === 403)) throw putErr;
      const why = putErr.body?.message ? `: ${putErr.body.message}` : "";
      throw new ApiError(403, {
        error: "forbidden",
        message: `${path.replace(/^\/api\//, "")} doesn't exist and this token can't create it${why}`,
      });
    }
  }
}

// `me` → the caller's email from /api/me (humans only); anything else as given.
async function emailArg(ctx, value, flag) {
  if (value !== "me") return value;
  const me = await ctx.api("GET", "/api/me");
  if (me?.kind !== "human") throw new UsageError(`${flag} me needs a human principal; this is token ${me?.name ?? "?"}`);
  return me.email;
}

function sessionFrom(ctx) {
  const s = ctx.values.session ?? ctx.env.AGENT_INBOX_SESSION ?? ctx.env.CLAUDE_SESSION_ID;
  if (!s) throw new UsageError("--session <id> is required (or set AGENT_INBOX_SESSION)");
  return s;
}

// A review run's stamp, as the runner writes it (`date -u +%Y-%m-%dT%H%M%SZ`).
function runStamp(arg) {
  if (!arg) throw new UsageError("missing <stamp>");
  if (!/^\d{4}-\d{2}-\d{2}T\d{6}Z$/.test(arg)) throw new UsageError(`invalid stamp "${arg}" (like 2026-10-08T180000Z)`);
  return arg;
}

// An orchestrator token's routine (its orchestrator id); null for anyone else.
async function ownRoutine(ctx) {
  const me = await ctx.api("GET", "/api/me");
  return me?.kind === "token" && me.scope === "orchestrator" ? me.orchestrator : null;
}

const ITEM_FIELDS = {
  type: "type",
  title: "title",
  summary: "summary",
  question: "question",
  context: "context",
  steps: "steps",
  command: "command",
  priority: "priority",
  orchestrator: "orchestrator",
  assignee: "assignee",
  source: "source",
  "cost-of-waiting": "cost_of_waiting",
};

export const COMMANDS = [
  {
    name: "me",
    summary: "Who the token is (principal and scope)",
    usage: "me",
    run: async (ctx) => ctx.print(await ctx.api("GET", "/api/me"), principalText),
  },
  {
    // Read-only on purpose: tokens can't change roles (a leaked one could make
    // anyone an admin), so an admin sets them in Settings → People.
    name: "users",
    summary: "People and their roles (admin, decider, viewer); an admin changes them in Settings",
    usage: "users",
    run: async (ctx) => ctx.print(await ctx.api("GET", "/api/users"), usersText),
  },
  {
    name: "state",
    summary: "Everything the UI loads: items, orchestrators, manager, lease, schedule, cursor",
    usage: "state",
    run: async (ctx) => ctx.print(await ctx.api("GET", "/api/state"), (s) => stateText(s, ctx.now())),
  },
  {
    name: "items",
    summary: "List items",
    usage: "items [--status open,decided] [--orchestrator O3] [--qa-pending] [--type decision] [--assignee email|none|me]",
    options: {
      status: { type: "string" },
      orchestrator: { type: "string" },
      "qa-pending": { type: "boolean" },
      type: { type: "string" },
      assignee: { type: "string" },
    },
    run: async (ctx) => {
      const v = ctx.values;
      const assignee = v.assignee === undefined ? undefined : await emailArg(ctx, v.assignee, "--assignee");
      const query = { status: v.status, orchestrator: v.orchestrator, qa_pending: v["qa-pending"] ? "true" : undefined, type: v.type, assignee };
      ctx.print(await ctx.api("GET", "/api/items", { query }), (r) => itemsList(r.items));
    },
  },
  {
    name: "show",
    summary: "One item with its Q&A thread",
    usage: "show <id>",
    args: ["id"],
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const [item, qa] = await Promise.all([
        ctx.api("GET", `/api/items/${enc(itemId)}`),
        ctx.api("GET", `/api/items/${enc(itemId)}/qa`),
      ]);
      ctx.print({ item, qa: qa.messages }, (r) => itemDetail(r.item, r.qa));
    },
  },
  {
    name: "post",
    summary: "Create an item (PUT); --if-version N replaces version N",
    usage:
      "post <id> [--file item.json|-] [--type T] [--title ..] [--summary ..] [--question ..] [--context ..] [--steps ..] [--command ..]\n" +
      "       [--priority high|normal|low] [--orchestrator O3] [--assignee email] [--source ..] [--cost-of-waiting ..]\n" +
      "       [--option id:label[:description] ...] [--recommend opt[:confidence[:why]]]\n" +
      "       [--link label=url ...] [--evidence label=url ...] [--decision choice[:note]]\n" +
      "       [--set key=value|key:=json ...] [--if-version N] [--replace-decided]",
    args: ["id"],
    options: {
      ...fileOpt,
      ...ifVersionOpt,
      ...replaceDecidedOpt,
      set: { type: "string", multiple: true },
      ...Object.fromEntries(Object.keys(ITEM_FIELDS).map((k) => [k, { type: "string" }])),
      option: { type: "string", multiple: true },
      recommend: { type: "string" },
      link: { type: "string", multiple: true },
      evidence: { type: "string", multiple: true },
      decision: { type: "string" },
    },
    run: async (ctx) => {
      const v = ctx.values;
      const itemId = id(ctx.args[0]);
      let data = {};
      if (v.file !== undefined) {
        data = await ctx.readJson(v.file);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new UsageError("--file must hold a JSON object");
        // Accept a whole Doc ({id, version, data}) as well as bare item data.
        if (data.data && typeof data.data === "object" && data.title === undefined) data = data.data;
      }
      for (const [flag, field] of Object.entries(ITEM_FIELDS)) if (v[flag] !== undefined) data[field] = v[flag];
      if (v.option) data.options = v.option.map(parseOption);
      if (v.recommend) data.recommendation = parseRecommend(v.recommend);
      if (v.link) data.links = v.link.map((l) => parseLink(l, "--link"));
      if (v.evidence) data.evidence = v.evidence.map((l) => parseLink(l, "--evidence"));
      if (v.decision) data.decision = parseDecision(v.decision, new Date(ctx.now()).toISOString());
      Object.assign(data, parseSets(v.set));
      if (!data.title) throw new UsageError("an item needs a title (--title or in --file)");
      const pin = ifVersion(v) ?? 0;
      const doc = await ctx.api("PUT", `/api/items/${enc(itemId)}`, { body: { data, if_version: pin, ...replaceDecided(v) } });
      ctx.print(doc, (d) => (pin === 0 ? "created " : "replaced ") + docSummary("items", d));
    },
  },
  {
    name: "patch",
    summary: "Merge fields into an item (top-level keys replace; key:=null deletes); --assign/--unassign route it",
    usage:
      "patch <id> (--set key=value|key:=json ... | --unset key ... | --file patch.json|- | --assign email|me | --unassign)\n" +
      "       [--if-version N] [--replace-decided]",
    args: ["id"],
    options: { ...fileOpt, ...setOpts, ...ifVersionOpt, ...replaceDecidedOpt, assign: { type: "string" }, unassign: { type: "boolean" } },
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const v = ctx.values;
      if (v.assign !== undefined && v.unassign) throw new UsageError("pass --assign or --unassign, not both");
      const data = await dataFrom(ctx, { allowEmpty: v.assign !== undefined || !!v.unassign });
      if (v.assign !== undefined) data.assignee = await emailArg(ctx, v.assign, "--assign");
      if (v.unassign) data.assignee = null;
      const body = withPin({ data, ...replaceDecided(v) }, ifVersion(v));
      ctx.print(await ctx.api("PATCH", `/api/items/${enc(itemId)}`, { body }), (d) => "updated " + docSummary("items", d));
    },
  },
  {
    name: "decide",
    summary: "Decide an open item as a human would (mainly for testing), pinned on the version it reads first (exit 3 if it changed)",
    usage: "decide <id> <choice> [--note ..] [--if-version N | --no-pin]",
    args: ["id", "choice"],
    options: { note: { type: "string" }, ...ifVersionOpt, "no-pin": { type: "boolean" } },
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const choice = ctx.args[1];
      if (!choice) throw new UsageError("missing <choice>");
      let pin = ifVersion(ctx.values);
      if (ctx.values["no-pin"] && pin !== undefined) throw new UsageError("--no-pin and --if-version don't go together");
      // Like the page and the ntfy buttons, decide only what was read: a change
      // between the read and the decide is a 409 (exit 3) with `current`.
      if (pin === undefined && !ctx.values["no-pin"]) pin = (await ctx.api("GET", `/api/items/${enc(itemId)}`)).version;
      const body = withPin({ choice }, pin);
      if (ctx.values.note !== undefined) body.note = ctx.values.note;
      ctx.print(await ctx.api("POST", `/api/items/${enc(itemId)}/decide`, { body }), (d) => "decided " + docSummary("items", d));
    },
  },
  {
    name: "claim",
    summary: "Claim a decided item: decided → processing (exit 3 if not decided)",
    usage: "claim <id> [--if-version N]",
    args: ["id"],
    options: ifVersionOpt,
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const body = withPin({}, ifVersion(ctx.values));
      ctx.print(await ctx.api("POST", `/api/items/${enc(itemId)}/claim`, { body }), (d) => "claimed " + docSummary("items", d));
    },
  },
  {
    name: "archive",
    summary: "Archive an item (from any status; a manager token: its own decided item, with --if-version)",
    usage: "archive <id> [--if-version N]",
    args: ["id"],
    options: ifVersionOpt,
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const body = withPin({}, ifVersion(ctx.values));
      ctx.print(await ctx.api("POST", `/api/items/${enc(itemId)}/archive`, { body }), (d) => "archived " + docSummary("items", d));
    },
  },
  {
    name: "withdraw",
    summary: "Take back an open item whose question no longer applies: archived, decision withdrawn (exit 3 if it changed or isn't open)",
    usage: "withdraw <id> --if-version N [--note text]",
    args: ["id"],
    options: { ...ifVersionOpt, note: { type: "string" } },
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const pin = ifVersion(ctx.values);
      if (pin === undefined) throw new UsageError("--if-version N is required: withdraw the version you read as open");
      const body = { if_version: pin };
      if (ctx.values.note !== undefined) body.note = ctx.values.note;
      ctx.print(await ctx.api("POST", `/api/items/${enc(itemId)}/withdraw`, { body }), (d) => "withdrew " + docSummary("items", d));
    },
  },
  {
    name: "delete",
    summary: "Delete an item and its Q&A (only for items created by mistake; prefer archive)",
    usage: "delete <id> [--if-version N]",
    args: ["id"],
    options: ifVersionOpt,
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const query = { if_version: ifVersion(ctx.values) };
      ctx.print(await ctx.api("DELETE", `/api/items/${enc(itemId)}`, { query }), () => `deleted items/${itemId}`);
    },
  },
  {
    name: "ask",
    summary: "Post a user question (needs a human principal, e.g. local dev without a token)",
    usage: "ask <id> <text|->",
    args: ["id", "text"],
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const text = await ctx.readText(ctx.args[1], "text");
      const res = await ctx.api("POST", `/api/items/${enc(itemId)}/qa`, { body: { text, role: "user" } });
      ctx.print(res, (r) => `asked ${r.message.id} on ${docSummary("items", r.item)}`);
    },
  },
  {
    name: "answer",
    summary: "Answer the item's pending question (clears qa_pending); --set/--file also update the item",
    usage: "answer <id> <text|-> [--if-version N] [--set key=value|key:=json ...] [--file data.json]",
    args: ["id", "text"],
    options: { ...fileOpt, ...setOpts, ...ifVersionOpt },
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      const text = await ctx.readText(ctx.args[1], "text");
      const body = withPin({ text }, ifVersion(ctx.values));
      const data = await dataFrom(ctx, { allowEmpty: true });
      if (Object.keys(data).length) body.data = data;
      const res = await ctx.api("POST", `/api/items/${enc(itemId)}/qa`, { body });
      ctx.print(res, (r) => `answered ${r.message.id} on ${docSummary("items", r.item)}`);
    },
  },
  {
    name: "qa",
    summary: "An item's Q&A thread, oldest first",
    usage: "qa <id>",
    args: ["id"],
    run: async (ctx) => {
      const itemId = id(ctx.args[0]);
      ctx.print(await ctx.api("GET", `/api/items/${enc(itemId)}/qa`), (r) => qaLines(r.messages).join("\n"));
    },
  },
  {
    name: "orch list",
    summary: "List managers",
    usage: "orch list",
    run: async (ctx) =>
      ctx.print(await ctx.api("GET", "/api/orchestrators"), (r) => r.orchestrators.map(orchLine).join("\n") || "(none)"),
  },
  {
    name: "orch show",
    summary: "One manager doc",
    usage: "orch show <id>",
    args: ["id"],
    run: async (ctx) => ctx.print(await ctx.api("GET", `/api/orchestrators/${enc(id(ctx.args[0]))}`)),
  },
  {
    name: "orch set",
    summary: "--file replaces the doc (PUT); --set alone merges (PATCH, creating it if missing)",
    usage: "orch set <id> (--file orch.json|- [--set ...] | --set key=value|key:=json ... | --unset key) [--if-version N]",
    args: ["id"],
    options: { ...fileOpt, ...setOpts, ...ifVersionOpt },
    run: async (ctx) => {
      const orchId = id(ctx.args[0]);
      const path = `/api/orchestrators/${enc(orchId)}`;
      const data = await dataFrom(ctx);
      const pin = ifVersion(ctx.values);
      const doc =
        ctx.values.file !== undefined
          ? await ctx.api("PUT", path, { body: withPin({ data }, pin) })
          : await patchOrCreate(ctx.api, path, data, pin);
      ctx.print(doc, (d) => "saved " + docSummary("orchestrators", d));
    },
  },
  {
    name: "orch relink",
    summary: "Point a manager's session_url at its live session (--all: every manager that isn't done)",
    usage: "orch relink (<id> [--session-id <claude session uuid>] | --all) [--seed]",
    args: ["id"],
    options: { all: { type: "boolean" }, seed: { type: "boolean" }, "session-id": { type: "string" } },
    run: async (ctx) => {
      const { all, seed } = ctx.values;
      const one = ctx.args[0];
      if (!all && !one) throw new UsageError("give <id> or --all");
      const live = liveLinks(sessionDirs(ctx.env, ctx.home));
      const opts = { seed, projects: projectDirs(ctx.env, ctx.home), nowIso: new Date(ctx.now()).toISOString() };
      let docs;
      if (all) docs = (await ctx.api("GET", "/api/orchestrators")).orchestrators.filter((d) => !isDone(d));
      else docs = [await ctx.api("GET", `/api/orchestrators/${enc(id(one))}`)];
      const results = [];
      for (const doc of docs) {
        const r = planRelink(doc, live, { ...opts, sessionId: all ? undefined : ctx.values["session-id"] });
        // The doc's own version pins the write: a manager that moved on meanwhile is left for the next tick.
        if (r.patch) await ctx.api("PATCH", `/api/orchestrators/${enc(doc.id)}`, { body: { data: r.patch, if_version: doc.version } });
        results.push({ id: r.id, changed: !!r.patch, note: r.note });
      }
      ctx.print({ results }, (x) => x.results.map((r) => `${r.id}: ${r.note}`).join("\n") || "(no managers)");
    },
  },
  {
    name: "orch delete",
    summary: "Delete a manager doc",
    usage: "orch delete <id> [--if-version N]",
    args: ["id"],
    options: ifVersionOpt,
    run: async (ctx) => {
      const orchId = id(ctx.args[0]);
      const query = { if_version: ifVersion(ctx.values) };
      ctx.print(await ctx.api("DELETE", `/api/orchestrators/${enc(orchId)}`, { query }), () => `deleted orchestrators/${orchId}`);
    },
  },
  {
    name: "meta get",
    summary: "A meta doc: manager, lease or schedule",
    usage: "meta get <id>",
    args: ["id"],
    run: async (ctx) => ctx.print(await ctx.api("GET", `/api/meta/${enc(id(ctx.args[0]))}`)),
  },
  {
    name: "meta set",
    summary: "--file replaces a meta doc (PUT); --set alone merges (PATCH, creating it if missing)",
    usage: "meta set <id> (--file meta.json|- | --set key=value|key:=json ... | --unset key) [--if-version N]",
    args: ["id"],
    options: { ...fileOpt, ...setOpts, ...ifVersionOpt },
    run: async (ctx) => {
      const metaId = id(ctx.args[0]);
      const path = `/api/meta/${enc(metaId)}`;
      const data = await dataFrom(ctx);
      const pin = ifVersion(ctx.values);
      const doc =
        ctx.values.file !== undefined
          ? await ctx.api("PUT", path, { body: withPin({ data }, pin) })
          : await patchOrCreate(ctx.api, path, data, pin);
      ctx.print(doc, (d) => "saved " + docSummary("meta", d));
    },
  },
  {
    name: "tick-request",
    summary: "Ask the orchestrator for a full sweep now (sets meta/manager.tick_requested_at)",
    usage: "tick-request [--note ..]",
    options: { note: { type: "string" } },
    run: async (ctx) => {
      const body = ctx.values.note !== undefined ? { note: ctx.values.note } : {};
      ctx.print(await ctx.api("POST", "/api/meta/manager/tick-request", { body }), (d) => "requested " + docSummary("meta", d));
    },
  },
  {
    name: "digest",
    summary: "Stamp meta/manager.last_pickup (last_tick with --sweep), next_tick (default: the schedule's next pickup) and, when given, the digest",
    usage: "digest [<markdown|->] [--sweep] [--next-tick ISO|+10m (default: schedule's next pickup)] [--if-version N]",
    args: ["text"],
    options: { sweep: { type: "boolean" }, "next-tick": { type: "string" }, ...ifVersionOpt },
    run: async (ctx) => {
      const nowIso = new Date(ctx.now()).toISOString();
      // Without a body the digest is left alone, so a pickup keeps the sweep's digest.
      const data = { last_pickup: nowIso };
      if (ctx.args[0] !== undefined) data.digest = await ctx.readText(ctx.args[0], "markdown");
      if (ctx.values.sweep) data.last_tick = nowIso;
      const next = parseWhen(ctx.values["next-tick"], ctx.now());
      if (next) data.next_tick = next;
      else if (ctx.values["next-tick"] === undefined) {
        // Managers forget --next-tick and the UI then shows "Tick overdue"; the next pickup is when we run next.
        const view = await ctx.api("GET", "/api/schedule").catch(() => null);
        const nextPickup = view?.computed?.next_pickup_at;
        if (nextPickup) data.next_tick = nextPickup;
        else ctx.log("agent-inbox: warning: no next pickup from the schedule, next_tick not updated");
      }
      const doc = await patchOrCreate(ctx.api, "/api/meta/manager", data, ifVersion(ctx.values));
      ctx.print(doc, (d) => "saved " + docSummary("meta", d));
    },
  },
  {
    name: "batch",
    summary: "Several writes in one transaction, all or none (exit 3 names the op whose pin failed)",
    usage: "batch --file ops.json|-",
    options: fileOpt,
    run: async (ctx) => {
      if (ctx.values.file === undefined) throw new UsageError("--file ops.json (or - for stdin) is required");
      const parsed = await ctx.readJson(ctx.values.file);
      // {ops: [...]} as the API takes it, or the bare list.
      const ops = Array.isArray(parsed) ? parsed : parsed?.ops;
      if (!Array.isArray(ops) || ops.length === 0) throw new UsageError("--file must hold {\"ops\": [...]} or a non-empty array of ops");
      const res = await ctx.api("POST", "/api/batch", { body: { ops } });
      ctx.print(res, (r) =>
        r.results
          .map((out, i) => {
            const op = String(ops[i]?.op ?? "?");
            const collection = { item: "items", orchestrator: "orchestrators", meta: "meta" }[op.split(".")[0]] ?? "?";
            return `${op}  ${docSummary(collection, out.item ?? out)}`;
          })
          .join("\n"),
      );
    },
  },
  {
    name: "lease get",
    summary: "Who holds the orchestrator lease",
    usage: "lease [get]",
    run: async (ctx) => ctx.print(await ctx.api("GET", "/api/lease"), (r) => leaseText(r, ctx.now())),
  },
  {
    name: "lease acquire",
    summary: "Take the lease (exit 3 lease_held if another session holds it; --force --if-version N steals)",
    usage: "lease acquire --session <id> [--title ..] [--holder-url ..] [--ttl MIN] [--force --if-version N]",
    options: {
      session: { type: "string" },
      title: { type: "string" },
      "holder-url": { type: "string" },
      ttl: { type: "string" },
      force: { type: "boolean" },
      ...ifVersionOpt,
    },
    run: async (ctx) => {
      const v = ctx.values;
      const pin = ifVersion(v);
      if (v.force && pin === undefined) throw new UsageError("--force needs --if-version <the version you read>");
      const body = withPin({ session_id: sessionFrom(ctx) }, pin);
      if (v.title !== undefined) body.title = v.title;
      if (v["holder-url"] !== undefined) body.url = v["holder-url"];
      const ttl = parseIntFlag(v.ttl, "--ttl", { min: 1, max: 300 });
      if (ttl !== undefined) body.ttl_min = ttl;
      if (v.force) body.force = true;
      ctx.print(await ctx.api("POST", "/api/lease/acquire", { body }), (r) => leaseText({ lease: r.lease, expired: false }, ctx.now()));
    },
  },
  {
    name: "lease renew",
    summary: "Heartbeat the lease (exit 3 lease_held means you lost it: step down)",
    usage: "lease renew --session <id> [--ttl MIN] [--if-version N]",
    options: { session: { type: "string" }, ttl: { type: "string" }, ...ifVersionOpt },
    run: async (ctx) => {
      const body = withPin({ session_id: sessionFrom(ctx) }, ifVersion(ctx.values));
      const ttl = parseIntFlag(ctx.values.ttl, "--ttl", { min: 1, max: 300 });
      if (ttl !== undefined) body.ttl_min = ttl;
      ctx.print(await ctx.api("POST", "/api/lease/renew", { body }), (r) => leaseText({ lease: r.lease, expired: false }, ctx.now()));
    },
  },
  {
    name: "lease release",
    summary: "Give the lease up",
    usage: "lease release --session <id>",
    options: { session: { type: "string" } },
    run: async (ctx) =>
      ctx.print(await ctx.api("POST", "/api/lease/release", { body: { session_id: sessionFrom(ctx) } }), () => "released"),
  },
  {
    name: "schedule show",
    summary: "Work hours, whether we're in them, the next pickup and the UTC cron expression(s); --check exits 5 off hours",
    usage: "schedule [show] [--cron | --check]",
    options: { cron: { type: "boolean" }, check: { type: "boolean" } },
    run: async (ctx) => {
      const view = await ctx.api("GET", "/api/schedule");
      if (ctx.values.check) {
        const c = view.computed;
        ctx.print(view, () => (c.in_hours ? "in hours" : `off hours (next window ${c.next_window_start ?? "-"})`));
        return c.in_hours ? 0 : EXIT_OFF_HOURS;
      }
      if (ctx.values.cron && !ctx.json) return ctx.out(view.computed.cron_utc.join("\n"));
      ctx.print(view, scheduleText);
    },
  },
  {
    name: "schedule set",
    summary: "Change the schedule (reads it, merges your flags, writes it pinned)",
    usage: 'schedule set [--work-hours "10:00-18:00 Mon-Fri"] [--timezone America/New_York] [--pickup 10] [--sweep 30] [--if-version N] [--force]',
    options: {
      "work-hours": { type: "string" },
      timezone: { type: "string" },
      pickup: { type: "string" },
      sweep: { type: "string" },
      force: { type: "boolean" },
      ...ifVersionOpt,
    },
    run: async (ctx) => {
      const v = ctx.values;
      const current = await ctx.api("GET", "/api/schedule");
      // The server serves defaults in place of a stored schedule that doesn't validate;
      // merging flags into those would silently replace the stored zone and hours.
      if (current.stored_invalid && !v.force) {
        throw new UsageError(
          "the stored schedule doesn't validate, so the server shows defaults; " +
            "setting it would replace it with the defaults plus your flags (pass --force to do that)",
        );
      }
      const schedule = { ...current.schedule };
      if (v["work-hours"] !== undefined) schedule.work_hours = v["work-hours"];
      if (v.timezone !== undefined) schedule.timezone = v.timezone;
      const pickup = parseIntFlag(v.pickup, "--pickup", { min: 1, max: 240 });
      const sweep = parseIntFlag(v.sweep, "--sweep", { min: 1, max: 240 });
      if (pickup !== undefined) schedule.pickup_interval_min = pickup;
      if (sweep !== undefined) schedule.sweep_interval_min = sweep;
      const pin = ifVersion(v) ?? current.version ?? 0;
      ctx.print(await ctx.api("PUT", "/api/schedule", { body: { schedule, if_version: pin } }), scheduleText);
    },
  },
  // Review routines (docs/reviews.md). The routine is the token's orchestrator id, so writes name none.
  {
    name: "reviews start",
    summary: "Mark a review run as started, so the Reviews tab shows it running (best effort)",
    usage: "reviews start <stamp> [--file run.json|-]",
    args: ["stamp"],
    options: fileOpt,
    run: async (ctx) => {
      const stamp = runStamp(ctx.args[0]);
      const body = ctx.values.file === undefined ? {} : await ctx.readJson(ctx.values.file);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new UsageError("--file must hold a JSON object");
      ctx.print(await ctx.api("POST", `/api/reviews/runs/${enc(stamp)}/start`, { body }), reviewRunLine);
    },
  },
  {
    name: "reviews report",
    summary: "Store a review run's outcome and report (exit 0 on a replay, 3 if the run is stored with another report)",
    usage: "reviews report --file payload.json|-",
    options: fileOpt,
    run: async (ctx) => {
      if (ctx.values.file === undefined) throw new UsageError("--file payload.json (or - for stdin) is required");
      const body = await ctx.readJson(ctx.values.file);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new UsageError("--file must hold a JSON object");
      ctx.print(await ctx.api("POST", "/api/reviews/report", { body }), reviewReportText);
    },
  },
  {
    name: "reviews show",
    summary: "A routine's PRs and runs (default: this token's routine; for others, every routine)",
    usage: "reviews show [<routine>] [--limit N] [--before STAMP]",
    args: ["routine"],
    options: { limit: { type: "string" }, before: { type: "string" } },
    run: async (ctx) => {
      const routine = ctx.args[0] !== undefined ? id(ctx.args[0], "routine") : await ownRoutine(ctx);
      if (routine === null) {
        if (ctx.values.limit !== undefined || ctx.values.before !== undefined) throw new UsageError("--limit and --before need a <routine>");
        return ctx.print(await ctx.api("GET", "/api/reviews"), (r) => reviewsText(r, ctx.now()));
      }
      const query = { limit: parseIntFlag(ctx.values.limit, "--limit", { min: 1, max: 100 }), before: ctx.values.before && runStamp(ctx.values.before) };
      ctx.print(await ctx.api("GET", `/api/reviews/${enc(routine)}`, { query }), routineReviewsText);
    },
  },
  {
    name: "reviews pr",
    summary: "One PR's state and its events (default routine: this token's)",
    usage: "reviews pr <n> [--routine R]",
    args: ["n"],
    options: { routine: { type: "string" } },
    run: async (ctx) => {
      const n = ctx.args[0];
      if (!n) throw new UsageError("missing <n>");
      if (!/^[1-9]\d{0,8}$/.test(n)) throw new UsageError(`invalid PR number "${n}"`);
      const routine = ctx.values.routine !== undefined ? id(ctx.values.routine, "routine") : await ownRoutine(ctx);
      if (routine === null) throw new UsageError("--routine R is required: this token has no routine of its own");
      ctx.print(await ctx.api("GET", `/api/reviews/${enc(routine)}/prs/${n}`), reviewPrText);
    },
  },
  // Run requests (docs/reviews.md "Run requests"): the Reviews tab's Run button asks; the routine's poller reads the
  // request with its token and reports how it went. No command asks: only a human in the browser can.
  {
    name: "reviews request",
    summary: "A routine's newest Run-button request (default: this token's routine)",
    usage: "reviews request [<routine>]",
    args: ["routine"],
    run: async (ctx) => {
      const routine = ctx.args[0] !== undefined ? id(ctx.args[0], "routine") : await ownRoutine(ctx);
      if (routine === null) throw new UsageError("<routine> is required: this token has no routine of its own");
      ctx.print(await ctx.api("GET", `/api/reviews/${enc(routine)}/run-request`), runRequestLine);
    },
  },
  {
    name: "reviews request-update",
    summary: "Report how a run request went: starting, started (with the run's stamp), skipped or failed (exit 3 if it moved on)",
    usage: "reviews request-update <id> starting|started|skipped|failed [--stamp STAMP] [--message TEXT]",
    args: ["id", "status"],
    options: { stamp: { type: "string" }, message: { type: "string" } },
    run: async (ctx) => {
      const [rq, status] = ctx.args;
      if (!rq) throw new UsageError("missing <id>");
      if (!["starting", "started", "skipped", "failed"].includes(status)) throw new UsageError("<status> must be starting, started, skipped or failed");
      const body = { status };
      if (status === "started") body.stamp = runStamp(ctx.values.stamp);
      else if (ctx.values.stamp !== undefined) throw new UsageError("--stamp goes with started only");
      if (ctx.values.message !== undefined) body.message = ctx.values.message;
      ctx.print(await ctx.api("POST", `/api/reviews/run-requests/${enc(id(rq, "id"))}`, { body }), runRequestLine);
    },
  },
  {
    name: "changes",
    summary: "One read of the change feed (long-polls up to --wait seconds)",
    usage: "changes [--since N] [--wait 0-25] [--collection items|orchestrators|meta|qa]",
    options: { since: { type: "string" }, wait: { type: "string" }, collection: { type: "string" } },
    run: async (ctx) => {
      const v = ctx.values;
      const wait = parseIntFlag(v.wait, "--wait", { min: 0, max: 25 });
      const query = { since: parseIntFlag(v.since, "--since"), wait, collection: v.collection };
      const res = await ctx.api("GET", "/api/changes", { query, timeoutMs: ((wait ?? 0) + 15) * 1000 });
      ctx.print(res, (r) => [...r.changes.map(changeLine), `cursor ${r.cursor}`].join("\n"));
    },
  },
  {
    name: "wait",
    summary: "Block until a matching change arrives, print it and the new cursor (exit 4 on --timeout)",
    usage:
      "wait [--since N | --cursor-file PATH] [--human] [--actor prefix ...] [--collection items]\n" +
      "     [--status decided,open] [--id item-id ...] [--op create,update,delete] [--timeout 600 (0 = forever)]",
    options: {
      since: { type: "string" },
      "cursor-file": { type: "string" },
      human: { type: "boolean" },
      actor: { type: "string", multiple: true },
      collection: { type: "string" },
      status: { type: "string" },
      id: { type: "string", multiple: true },
      op: { type: "string" },
      timeout: { type: "string" },
    },
    run: async (ctx) => {
      const v = ctx.values;
      const cursorFile = v["cursor-file"];
      let since = parseIntFlag(v.since, "--since");
      if (since === undefined && cursorFile) since = readCursorFile(cursorFile);
      const timeoutS = parseIntFlag(v.timeout, "--timeout") ?? 600;
      const match = changeMatcher({
        human: v.human,
        actors: v.actor,
        statuses: commaList(v.status),
        ids: v.id,
        ops: commaList(v.op),
      });
      const res = await waitForChanges(
        ctx.api,
        { since, collection: v.collection, match, timeoutMs: timeoutS * 1000 },
        { sleep: ctx.sleep, now: ctx.now, log: ctx.log },
      );
      ctx.print(res, (r) => [...r.changes.map(changeLine), r.timed_out ? `timeout cursor ${r.cursor}` : `cursor ${r.cursor}`].join("\n"));
      if (cursorFile && res.cursor !== null && res.cursor !== undefined) writeCursorFile(cursorFile, res.cursor);
      return res.timed_out ? EXIT_TIMEOUT : 0;
    },
  },
];

function readCursorFile(path) {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeCursorFile(path, cursor) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${cursor}\n`);
}

// Groups whose bare name runs a default subcommand.
export const GROUP_DEFAULTS = { lease: "get", schedule: "show", orch: "list", reviews: "show" };
