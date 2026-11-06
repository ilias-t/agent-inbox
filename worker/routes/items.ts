// Items and their Q&A threads, including the atomic page-side transitions
// (decide, claim, archive) and the orchestrator-token write rules.

import { validChoices } from "../../shared/choices.ts";
import { LEASE_SESSION_HEADER, type Doc, type Item, type ItemStatus, type ItemType, type QaMessage, type QaRole } from "../../shared/types.ts";
import { fleetScope, orchestratorScope, requireFleet, requireFullRole, requireHuman, requireRole, type Caller } from "../auth.ts";
import type { Env } from "../env.ts";
import {
  badRequest,
  checkEmail,
  conflict,
  forbidden,
  ifVersion,
  isObject,
  json,
  notFound,
  optString,
  reqString,
} from "../http.ts";
import { deleteInFleet, fleetFilter, stampFleet } from "../fleets.ts";
import { CLOSURE_FIELDS } from "../hooks/github.ts";
import { notifyAnswer, notifyItemCreated, notifyReassigned } from "../notify.ts";
import { docResponse, opRoute, type WriteOp } from "../ops.ts";
import type { Ctx, Route } from "../router.ts";
import { COLS, deleteDoc, getDoc, landedClause, listDocs, mergePatch, mutate, pinClause, toDoc, type DeletePin, type DocRow } from "../store.ts";
import { requireHeld } from "./lease.ts";
import { dropPins } from "./pins.ts";

const ITEMS = "items";
export const qaCollection = (id: string) => `items/${id}/qa`;

export const ITEM_TYPES: ItemType[] = ["proposal", "decision", "pr_ready", "blocker", "info", "auto_decided"];
export const ITEM_STATUSES: ItemStatus[] = ["open", "decided", "processing", "archived"];
const PRIORITIES = ["high", "normal", "low"];

// --- Validation and scope ------------------------------------------------------

function checkLinks(v: unknown, key: string): void {
  if (v === undefined) return;
  const ok =
    Array.isArray(v) &&
    v.every((l) => isObject(l) && typeof l.label === "string" && typeof l.url === "string" && /^https?:\/\//i.test(l.url));
  if (!ok) throw badRequest(`${key} must be an array of {label, url} with http(s) urls`);
}

// `prev` is the stored item, if any: an unchanged assignee is kept as stored, so
// a legacy non-email value doesn't make the item unwritable.
export function validateItem(d: Record<string, unknown>, prev: Item | null = null): Item {
  if (!ITEM_TYPES.includes(d.type as ItemType)) throw badRequest(`type must be one of ${ITEM_TYPES.join(", ")}`);
  if (typeof d.title !== "string" || !d.title.trim()) throw badRequest("title is required");
  if (!ITEM_STATUSES.includes(d.status as ItemStatus)) throw badRequest(`status must be one of ${ITEM_STATUSES.join(", ")}`);
  if (d.priority !== undefined && !PRIORITIES.includes(d.priority as string)) {
    throw badRequest(`priority must be one of ${PRIORITIES.join(", ")}`);
  }
  if (
    d.options !== undefined &&
    !(
      Array.isArray(d.options) &&
      d.options.every((o) => isObject(o) && typeof o.id === "string" && o.id !== "" && typeof o.label === "string")
    )
  ) {
    throw badRequest("options must be an array of {id, label}");
  }
  checkLinks(d.links, "links");
  checkLinks(d.evidence, "evidence");
  if (d.close_on_pr !== undefined && typeof d.close_on_pr !== "boolean") throw badRequest("close_on_pr must be true or false");
  // Routing, not a lock: anyone can still decide. null (a PUT) means unassigned.
  if (d.assignee === null) delete d.assignee;
  else if (d.assignee !== undefined && d.assignee !== prev?.assignee) d.assignee = checkEmail(d.assignee, "assignee");
  return d as Item;
}

// Orchestrator tokens write only their own items, create them `open` and never
// change status after that, and never write `decision` except on creating an
// auto_decided item.
function checkScopedWrite(scope: string | null, cur: Item | null, next: Item): void {
  if (scope === null) return;
  // Own fields only: what is stored is what JSON.stringify writes, so a value
  // read through a prototype must never pass a check.
  const was = (k: string) => own(cur, k), now = (k: string) => own(next, k);
  const same = (k: string) => JSON.stringify(was(k)) === JSON.stringify(now(k));
  if (cur && was("orchestrator") !== scope) throw forbidden(`Item belongs to another orchestrator`);
  if (now("orchestrator") !== scope) throw forbidden(`Items written by this token must have orchestrator "${scope}"`);
  // Creates are open; after that the status is the human's and the manager's
  // (no reopening a decided item, which would also revive old ntfy links).
  if (now("status") !== (was("status") ?? "open")) {
    throw forbidden(cur ? "Orchestrator tokens can't change an item's status" : "Orchestrator tokens create items open");
  }
  // `source` says who asked, and archive and withdraw trust it: once posted, a
  // token can't set it to anything else (dropping it only gives that right up).
  if (cur && now("source") !== undefined && now("source") !== was("source")) {
    throw forbidden("Orchestrator tokens can't change an item's source once it is posted");
  }
  // The GitHub hook closes items from CLOSURE_FIELDS (hooks/github.ts), so they
  // are the asker's: on an item it didn't post with source = its id, a token
  // changes none of them, and it can't create one flagged close_on_pr. A new
  // item's other fields are its own post, which closes nobody else's question.
  const asker = (cur ? was("source") : now("source")) === scope && !isManagerSource(scope);
  if (!asker) {
    const moved = cur ? CLOSURE_FIELDS.filter((k) => !same(k)) : now("close_on_pr") !== undefined ? ["close_on_pr"] : [];
    if (moved.length) {
      throw forbidden(`Orchestrator tokens change ${moved.join(", ")} only on items they posted with source "${scope}"`);
    }
  }
  if (!same("decision") && !(cur === null && now("type") === "auto_decided")) {
    throw forbidden("Orchestrator tokens may only write decision when creating an auto_decided item");
  }
  // Once it isn't open, what the human decided on is the record: only fields
  // that don't change it may move. An allowlist, so unknown extra fields (which
  // a later UI may show) are frozen too. The legacy snooze fields aren't
  // content: every write drops them (dropSnooze), so they're exempt.
  if (cur && was("status") !== "open") {
    const changed = [...new Set([...Object.keys(cur), ...Object.keys(next)])].filter(
      (k) => !AFTER_OPEN_WRITABLE.has(k) && !LEGACY_SNOOZE_KEYS.has(k) && !same(k),
    );
    if (changed.length) {
      throw forbidden(`Orchestrator tokens can't change ${changed.join(", ")} once an item is ${String(was("status"))}`);
    }
  }
}

const own = (o: object | null, k: string): unknown => (o !== null && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);

// What an orchestrator token may still change on a decided/processing/archived
// item: routing, the GitHub hook's PR state, the qa bookkeeping an answer
// writes, and the server's updated_at stamp.
const AFTER_OPEN_WRITABLE = new Set(["assignee", "pr_state", "qa_pending", "qa_last_at", "qa_answered_at", "updated_at"]);

// Snoozes are per person, in the snoozes table (POST /items/:id/snooze), never
// on the item. Item writes drop the fields an item carried before that
// (migration 0007), from the body and the stored doc alike, so no token can
// write them and nothing reads them back.
const LEGACY_SNOOZE_KEYS = new Set(["snoozed_until", "snoozed_by"]);
function dropSnooze(next: Record<string, unknown>): void {
  for (const k of LEGACY_SNOOZE_KEYS) delete next[k];
}

function checkScopedRead(caller: Caller, item: Doc<Item>): void {
  requireFleet(caller, item.data);
  const scope = orchestratorScope(caller);
  if (scope !== null && item.data.orchestrator !== scope) throw forbidden("Item belongs to another orchestrator");
}

async function readItem(c: Ctx): Promise<Doc<Item>> {
  const item = await getDoc<Item>(c.env.DB, ITEMS, c.params.id);
  if (!item) throw notFound(`No item ${c.params.id}`);
  checkScopedRead(c.caller, item);
  return item;
}

function bodyData(body: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(body.data)) throw badRequest("data must be an object");
  return body.data;
}

// --- Items -------------------------------------------------------------------

async function listItems(c: Ctx): Promise<Response> {
  const q = c.url.searchParams;
  const where: string[] = [];
  const binds: unknown[] = [];
  const status = q.get("status");
  if (status) {
    const list = status.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.every((s) => ITEM_STATUSES.includes(s as ItemStatus))) throw badRequest("Unknown status filter");
    where.push(`AND status IN (${list.map(() => "?").join(", ")})`);
    binds.push(...list);
  }
  const orchestrator = orchestratorScope(c.caller) ?? q.get("orchestrator");
  if (orchestrator) {
    where.push("AND orchestrator = ?");
    binds.push(orchestrator);
  }
  // A token's own fleet, or a human's ?fleet=.
  const fleet = fleetFilter(c.caller, q);
  if (fleet !== undefined) {
    where.push(orchestrator ? "AND +fleet IS ?" : "AND fleet IS ?"); // with orchestrator: stay on docs_orchestrator
    binds.push(fleet);
  }
  const qa = q.get("qa_pending");
  if (qa === "true") where.push("AND qa_pending = 1");
  else if (qa === "false") where.push("AND coalesce(qa_pending, 0) = 0");
  else if (qa !== null) throw badRequest("qa_pending must be true or false");
  const assignee = q.get("assignee");
  if (assignee === "none") where.push("AND assignee IS NULL");
  else if (assignee) {
    where.push("AND assignee = ?");
    binds.push(checkEmail(assignee, "assignee filter"));
  }
  const type = q.get("type");
  if (type) {
    where.push("AND json_extract(data, '$.type') = ?");
    binds.push(type);
  }
  for (const word of searchWords(q.get("q"))) {
    where.push(`AND (${SEARCH_HAYSTACK}) LIKE ? ESCAPE '\\'`);
    binds.push(`%${word.replace(/[\\%_]/g, "\\$&")}%`);
  }
  const page = pageParams(q);
  if (!page) return json({ items: await listDocs<Item>(c.env.DB, ITEMS, where.join(" "), binds) });
  if (page.before !== null && page.beforeId === null) {
    where.push("AND updated_at < ?");
    binds.push(page.before);
  } else if (page.before !== null) {
    where.push("AND (updated_at < ? OR (updated_at = ? AND id < ?))");
    binds.push(page.before, page.before, page.beforeId);
  }
  // One extra row says whether there is a next page.
  const docs = await listDocs<Item>(c.env.DB, ITEMS, where.join(" "), binds, "updated_at DESC, id DESC", page.limit + 1);
  return json({ items: docs.slice(0, page.limit), more: docs.length > page.limit });
}

// What `q` searches: the fields History's own search reads (src/lib/history.ts).
const SEARCH_HAYSTACK = ["title", "summary", "question", "decision.note", "orchestrator"]
  .map((f) => `coalesce(json_extract(data, '$.${f}'), '')`)
  .join(" || char(10) || ");
const Q_MAX = 200;
const Q_WORDS_MAX = 10;

// Every word must match somewhere, as a literal substring (LIKE wildcards are
// escaped; case-insensitive for ASCII letters only, as SQLite's LIKE is).
function searchWords(raw: string | null): string[] {
  if (raw === null) return [];
  if (raw.length > Q_MAX) throw badRequest(`q must be at most ${Q_MAX} characters`);
  const words = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (words.length > Q_WORDS_MAX) throw badRequest(`q may have at most ${Q_WORDS_MAX} words`);
  return words;
}

export const PAGE_MAX = 200;
const PAGE_DEFAULT = 50;

// Keyset paging, newest first by the doc's updated_at, ties by id descending.
// `before` (an updated_at, compared as stored) with `before_id` (that row's id)
// means "strictly after that row"; `before` alone, everything older than it.
// Null when neither `limit` nor `before` is given: the old shape and order.
function pageParams(q: URLSearchParams): { limit: number; before: string | null; beforeId: string | null } | null {
  const limitRaw = q.get("limit"), before = q.get("before"), beforeId = q.get("before_id");
  if (beforeId !== null && before === null) throw badRequest("before_id needs before");
  if (limitRaw === null && before === null) return null;
  let limit = PAGE_DEFAULT;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!/^\d+$/.test(limitRaw) || limit < 1 || limit > PAGE_MAX) throw badRequest(`limit must be an integer from 1 to ${PAGE_MAX}`);
  }
  if (before !== null && (before.length > 40 || Number.isNaN(Date.parse(before)))) throw badRequest("before must be an ISO 8601 time");
  if (beforeId !== null && (beforeId === "" || beforeId.length > 200)) throw badRequest("before_id must be an item id");
  return { limit, before, beforeId };
}

async function getItem(c: Ctx): Promise<Response> {
  return json(await readItem(c));
}

// A human's decision isn't lost to a token's replace or patch (docs/api.md "Decided items are kept"): on a decided or
// processing item, a token write that changes status or decision is 409 `decided`, naming who decided, when and what,
// unless the body says replace_decided: true. One that carries both as they are passes, as do archive and claim.
// The same holds for an answer's data (qa).
function replaceDecided(body: Record<string, unknown>): boolean {
  const v = body.replace_decided;
  if (v !== undefined && typeof v !== "boolean") throw badRequest("replace_decided must be a boolean");
  return v === true;
}
// JSON with every object's keys sorted, so the same value written in another key order compares equal.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}
function checkDecidedKept(c: Ctx, cur: Doc<Item> | null, next: Item, meant: boolean): void {
  if (meant || !cur || c.caller.principal.kind !== "token") return;
  const d = cur.data;
  if (d.status !== "decided" && d.status !== "processing") return;
  const same = (k: string) => canonical(own(d, k)) === canonical(own(next, k));
  if (same("status") && same("decision")) return;
  const dec = d.decision, label = dec ? d.options?.find((o) => o.id === dec.choice)?.label : undefined;
  const what = dec ? `${dec.choice}${label ? ` (${JSON.stringify(label)})` : ""}` : "no recorded choice";
  throw conflict(
    "decided",
    `Item ${cur.id} is ${d.status}: ${dec?.by ?? "someone"} decided it at ${dec?.decided_at ?? "an unknown time"}, choosing ${what}. ` +
      "This write would change its status or decision. Read it first; to replace it anyway, send replace_decided: true.",
    cur,
  );
}

// --- Write ops (routes below, and POST /api/batch) -------------------------------

// Humans: writing items is an admin's (deciders decide, ask and reassign
// through their own routes). Tokens follow their scope rules.
export function putItemOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Item> {
  requireRole(c.caller, "admin");
  const input = bodyData(body);
  const scope = orchestratorScope(c.caller);
  const meant = replaceDecided(body);
  let prevAssignee: string | undefined;
  return {
    collection: ITEMS,
    id,
    ifVersion: ifVersion(body.if_version),
    authorize: (cur) => checkScopedRead(c.caller, cur),
    build: (cur) => {
      // A replace that omits status/type/created_at keeps the stored ones;
      // a create defaults them.
      const next: Record<string, unknown> = { ...input };
      stampFleet(c.caller, cur?.data ?? null, next, true);
      next.status ??= cur?.data.status ?? "open";
      next.type ??= cur?.data.type ?? "info";
      next.created_at ??= cur?.data.created_at ?? c.now;
      next.updated_at ??= c.now;
      dropSnooze(next);
      const item = validateItem(next, cur?.data);
      checkScopedWrite(scope, cur?.data ?? null, item);
      checkDecidedKept(c, cur, item, meant);
      prevAssignee = cur?.data.assignee;
      return item;
    },
    respond: docResponse,
    after: (doc, created) => {
      if (created) notifyItemCreated(c, doc);
      else notifyReassigned(c, doc, prevAssignee);
    },
  };
}

// A decider may PATCH only the assignee (reassigning); anything else is an admin's.
export function patchItemOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Item> {
  const patch = bodyData(body);
  const p = c.caller.principal;
  if (p.kind === "human" && p.role !== "admin") {
    requireRole(c.caller, "decider");
    if (Object.keys(patch).some((k) => k !== "assignee")) throw forbidden("Deciders can only reassign: data may hold only assignee");
  }
  const scope = orchestratorScope(c.caller);
  const meant = replaceDecided(body);
  let prevAssignee: string | undefined;
  return {
    collection: ITEMS,
    id,
    ifVersion: ifVersion(body.if_version),
    authorize: (cur) => checkScopedRead(c.caller, cur),
    build: (cur) => {
      if (!cur) throw notFound(`No item ${id}`);
      const next = mergePatch(cur.data, patch);
      stampFleet(c.caller, cur.data, next, false);
      if (!("updated_at" in patch)) next.updated_at = c.now;
      dropSnooze(next);
      const item = validateItem(next, cur.data);
      checkScopedWrite(scope, cur.data, item);
      checkDecidedKept(c, cur, item, meant);
      prevAssignee = cur.data.assignee;
      return item;
    },
    respond: docResponse,
    after: (doc) => notifyReassigned(c, doc, prevAssignee),
  };
}

// The orchestrator's claim-before-act: decided → processing, naming the session that claimed it (claimed_by, its
// X-Lease-Session, which index.ts checked holds a fresh lease) and when (claimed_at). The session holding the lease
// may also claim an item another session left processing (it died or lost a takeover; none named is a claim from
// before claims were): claimed_by moves to it and reclaimed_from keeps the one it came from. Its own processing
// items it can't: one it parked stays parked. Humans name no session. docs/api.md.
export function claimOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Item> {
  requireFullRole(c.caller, "admin");
  const p = c.caller.principal;
  const session = p.kind === "token" && p.scope === "manager" ? c.request.headers.get(LEASE_SESSION_HEADER) : null;
  return {
    collection: ITEMS,
    id,
    ifVersion: ifVersion(body.if_version),
    authorize: (cur) => checkScopedRead(c.caller, cur),
    build: async (cur) => {
      if (!cur) throw notFound(`No item ${id}`);
      requireFleet(c.caller, cur.data);
      const d = cur.data, by = typeof d.claimed_by === "string" ? d.claimed_by : null;
      const retake = d.status === "processing" && session !== null && by !== session;
      if (d.status !== "decided" && !retake) throw conflict("not_decided", `Item is ${d.status}`, cur);
      // Read after the item: whoever re-took it last took the lease first, so a stale session is refused here.
      if (retake) await requireHeld(c.env.DB, session, c.now, fleetScope(c.caller) ?? null);
      const next: Item = { ...d, status: "processing", claimed_at: c.now, updated_at: c.now };
      if (session !== null) next.claimed_by = session;
      if (retake) next.reclaimed_from = by;
      return next;
    },
    respond: docResponse,
  };
}

// Sources the manager writes: those items are the manager's record even when
// they carry an orchestrator (skills/orchestration-manager, "Yours only").
const isManagerSource = (s: string) => s === "manager" || s.startsWith("scout:") || s.startsWith("sweep:");

// Humans and the manager archive from any status. An orchestrator token
// archives only its own item, pinned, once decided, and only one it posted
// with `source` = its id: the manager claims only its registry's items, and a
// claim and an archive pinned on the same version can't both land.
export function archiveOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Item> {
  requireRole(c.caller, "admin");
  const scope = orchestratorScope(c.caller);
  const pin = ifVersion(body.if_version);
  if (scope !== null && pin === undefined) throw badRequest("if_version is required: archive the version you read as decided");
  return {
    collection: ITEMS,
    id,
    ifVersion: pin,
    authorize: (cur) => checkScopedRead(c.caller, cur),
    build: (cur) => {
      if (!cur) throw notFound(`No item ${id}`);
      requireFleet(c.caller, cur.data);
      if (scope !== null) {
        const d = cur.data;
        if (d.orchestrator !== scope) throw forbidden("Item belongs to another orchestrator");
        if (d.status !== "decided") throw conflict("not_decided", `Item is ${d.status}`, cur);
        if (d.source !== scope || isManagerSource(scope)) {
          throw forbidden(`Orchestrator tokens archive only items they posted with source "${scope}"`);
        }
      }
      return { ...cur.data, status: "archived", updated_at: c.now };
    },
    respond: docResponse,
  };
}

// The asker takes back an open question that no longer applies: archived with
// decision {choice: "withdrawn", note?, decided_at, by}. Humans (admins) and
// the manager withdraw any open item; an orchestrator token only its own, with
// `source` = its id, pinned, as archive. Only from open, checked in the same
// pinned write as decide's, so of a withdraw and a decide exactly one lands.
export function withdrawOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Item> {
  requireRole(c.caller, "admin");
  const scope = orchestratorScope(c.caller);
  const pin = ifVersion(body.if_version);
  if (scope !== null && pin === undefined) throw badRequest("if_version is required: withdraw the version you read as open");
  const note = optString(body, "note", 8000);
  return {
    collection: ITEMS,
    id,
    ifVersion: pin,
    authorize: (cur) => checkScopedRead(c.caller, cur),
    build: (cur) => {
      if (!cur) throw notFound(`No item ${id}`);
      requireFleet(c.caller, cur.data);
      const d = cur.data;
      if (scope !== null && d.orchestrator !== scope) throw forbidden("Item belongs to another orchestrator");
      if (d.status !== "open") throw conflict("not_open", `Item is ${d.status}`, cur);
      if (scope !== null && (d.source !== scope || isManagerSource(scope))) {
        throw forbidden(`Orchestrator tokens withdraw only items they posted with source "${scope}"`);
      }
      if (d.type === "auto_decided") throw badRequest("An auto_decided item carries the agent's own decision: accept or archive it");
      const decision = { choice: "withdrawn", ended: "withdrawn" as const, ...(note ? { note } : {}), decided_at: c.now, by: c.caller.actor };
      return { ...d, status: "archived", decision, updated_at: c.now };
    },
    respond: docResponse,
  };
}

export const SNOOZE_MAX_DAYS = 30;

// A human hides an open item from their own Inbox until `until` (the page
// filters it; for everyone else, and for the API, it stays open). A row in
// snoozes for the caller only: the item doc isn't written, so its version
// doesn't move and ntfy links and pages pinned on it stay good. Not for
// tokens: agents never see snoozes. `until: null` wakes it, on any status.
// `if_version` is accepted and ignored (pages from before per-person snoozes
// send it).
async function snooze(c: Ctx): Promise<Response> {
  requireHuman(c.caller);
  requireRole(c.caller, "decider"); // triage, like deciding: viewers only read
  const body = await c.body();
  const id = c.params.id;
  const p = c.caller.principal;
  const email = p.kind === "human" ? p.email.toLowerCase() : "";
  const db = c.env.DB;
  if (body.until === null) {
    await db.prepare("DELETE FROM snoozes WHERE item_id = ? AND email = ?").bind(id, email).run();
    return json({ item_id: id, until: null });
  }
  const t = typeof body.until === "string" && body.until ? Date.parse(body.until) : NaN;
  if (Number.isNaN(t)) throw badRequest("until must be an ISO 8601 time, or null to unsnooze");
  const now = Date.parse(c.now);
  if (t <= now || t > now + SNOOZE_MAX_DAYS * 86_400_000) {
    throw badRequest(`until must be in the future and at most ${SNOOZE_MAX_DAYS} days away`);
  }
  const until = new Date(t).toISOString();
  // Only while the item is open, checked in the same statement as the write.
  const r = await db
    .prepare(
      `INSERT INTO snoozes (item_id, email, until, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM docs WHERE collection = 'items' AND id = ?1 AND status = 'open')
       ON CONFLICT (item_id, email) DO UPDATE SET until = excluded.until`,
    )
    .bind(id, email, until, c.now)
    .run();
  if (!r.meta.changes) {
    const cur = await getDoc<Item>(db, ITEMS, id);
    if (!cur) throw notFound(`No item ${id}`);
    throw conflict("not_open", `Item is ${cur.data.status}`, cur);
  }
  return json({ item_id: id, until });
}

async function deleteItem(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "admin");
  const id = c.params.id;
  const asked = ifVersion(c.url.searchParams.get("if_version"));
  await deleteInFleet(c, ITEMS, id, asked, (pin) => deleteItemPinned(c, id, pin), "Item");
  return json({ ok: true });
}

async function deleteItemPinned(c: Ctx, id: string, pin: DeletePin): Promise<"deleted" | "missing"> {
  // The qa and everyone's snoozes and pins on it go first, while the item still exists
  // (the change-log trigger reads its orchestrator), under the same pin as the
  // item delete that follows in the same transaction: all happen or none does.
  const dropQa = c.env.DB.prepare(
    `DELETE FROM docs WHERE collection = ?1 AND EXISTS
       (SELECT 1 FROM docs WHERE collection = 'items' AND id = ?2 AND ${pinClause("?3", "?4")})`,
  ).bind(qaCollection(id), id, pin.version ?? null, pin.createdAt ?? null);
  const dropSnoozes = c.env.DB.prepare(
    `DELETE FROM snoozes WHERE item_id = ?1 AND EXISTS
       (SELECT 1 FROM docs WHERE collection = 'items' AND id = ?1 AND ${pinClause("?2", "?3")})`,
  ).bind(id, pin.version ?? null, pin.createdAt ?? null);
  const before = [dropQa, dropSnoozes, dropPins(c.env.DB, "item", id, ITEMS, pin)];
  return deleteDoc(c.env.DB, ITEMS, id, pin, before, (cur) => checkScopedRead(c.caller, cur as Doc<Item>));
}

// What a decision is bound to: the version the human saw (the page's
// if_version, an ntfy link's ver) and, for ntfy links, the item instance they
// were signed for (created_at), not a later one with the same id.
export interface DecidePin {
  version?: number;
  createdAt?: string;
}

// The page-side decision, shared with the ntfy action hook. Pinned on the
// version that was read as `open`, so a concurrent decide loses with not_open.
// With pin.version the item must still be that version (409 conflict): the
// pin is checked on every attempt, so a lost race never decides newer content.
export async function decideItem(
  env: Env,
  id: string,
  choice: string,
  note: string | undefined,
  actor: string,
  now: string,
  pin: DecidePin = {},
  caller?: Caller, // a token's decide stays in its own fleet; hooks pass none
): Promise<Doc<Item>> {
  if (choice === "other" && !note?.trim()) throw badRequest('choice "other" requires a note');
  const authorize = caller ? (cur: Doc<Item>) => requireFleet(caller, cur.data) : undefined;
  const { doc } = await mutate<Item>(env.DB, ITEMS, id, { actor, now, authorize }, (cur) => {
    if (!cur) throw notFound(`No item ${id}`);
    if (caller) requireFleet(caller, cur.data);
    const d = cur.data;
    if (d.status !== "open") throw conflict("not_open", `Item is ${d.status}`, cur);
    if (pin.createdAt !== undefined && cur.created_at !== pin.createdAt) {
      throw conflict("not_open", "Item was recreated since this link was sent", cur);
    }
    if (pin.version !== undefined && cur.version !== pin.version) {
      throw conflict("conflict", `Item changed since version ${pin.version} (now ${cur.version}): review it and decide again`, cur);
    }
    // After the open/pin checks, so a stale link or page is 409, not 400.
    const valid = validChoices(d);
    if (!valid.includes(choice)) throw badRequest(`choice must be one of ${valid.join(", ")}`);
    if (d.type === "auto_decided") {
      if (choice === "accept") return { ...d, status: "archived", updated_at: now };
      if (!note?.trim()) throw badRequest("override requires a note");
      const prev = d.decision?.choice;
      return {
        ...d,
        status: "decided",
        decision: { choice: "override", note, decided_at: now, by: actor },
        override_of: prev && prev !== "override" ? prev : (d.override_of ?? prev),
        updated_at: now,
      };
    }
    const decision = note ? { choice, note, decided_at: now, by: actor } : { choice, decided_at: now, by: actor };
    return { ...d, status: "decided", decision, updated_at: now };
  });
  return doc;
}

async function decide(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "decider");
  const body = await c.body();
  const choice = reqString(body, "choice", 200);
  const note = optString(body, "note", 8000);
  const pin = { version: ifVersion(body.if_version) };
  return json(await decideItem(c.env, c.params.id, choice, note, c.caller.actor, c.now, pin, c.caller));
}

// --- Q&A ---------------------------------------------------------------------

// The item and its thread in one batch (one transaction), so the check on the item holds for the thread read
// with it: a concurrent move to another fleet can't slip that fleet's answers in between.
async function listQa(c: Ctx): Promise<Response> {
  const db = c.env.DB;
  const id = c.params.id;
  const [item, messages] = await db.batch<DocRow>([
    db.prepare(`SELECT ${COLS} FROM docs WHERE collection = 'items' AND id = ?`).bind(id),
    db.prepare(`SELECT ${COLS} FROM docs WHERE collection = ? ORDER BY created_at, id`).bind(qaCollection(id)),
  ]);
  const row = item.results[0];
  if (!row) throw notFound(`No item ${id}`);
  checkScopedRead(c.caller, toDoc<Item>(row));
  return json({ messages: messages.results.map((r) => toDoc<QaMessage>(r)) });
}

function defaultRole(caller: Caller): QaRole {
  if (caller.principal.kind === "human") return "user";
  return caller.principal.scope === "orchestrator" ? "orchestrator" : "manager";
}

function messageId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => (b % 36).toString(36)).join("");
  return `m-${Date.now()}-${rand}`;
}

// One transaction: the item update (pinned) and the message insert, which is
// guarded on the item update having landed so a failed pin stores nothing.
export function qaOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Item> {
  requireRole(c.caller, "decider"); // a human's question
  const role = (optString(body, "role", 20) ?? defaultRole(c.caller)) as QaRole;
  if (role !== defaultRole(c.caller)) throw forbidden(`This caller posts as ${defaultRole(c.caller)}, not ${role}`);
  const text = body.text;
  if (typeof text !== "string" || !text.trim() || text.length > 8000) throw badRequest("text must be 1-8000 chars");
  let patch: Record<string, unknown> = {};
  if (body.data !== undefined) {
    if (role === "user") throw badRequest("data is only accepted with answers");
    patch = bodyData(body);
  }
  const scope = orchestratorScope(c.caller);
  const meant = replaceDecided(body);
  const { actor } = c.caller;
  const now = c.now;

  const msgId = messageId();
  const qaColl = qaCollection(id);
  const message: QaMessage = { role, text, created_at: now, by: actor };
  const msgDoc: Doc<QaMessage> = { id: msgId, version: 1, data: message, created_at: now, updated_at: now, updated_by: actor };
  return {
    collection: ITEMS,
    id,
    ifVersion: ifVersion(body.if_version),
    authorize: (cur) => checkScopedRead(c.caller, cur),
    extra: ({ version }) => [
      c.env.DB.prepare(
        `INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by)
         SELECT ?, ?, ?, 1, ?, ?, ? WHERE ${landedClause}`,
      ).bind(qaColl, msgId, JSON.stringify(message), now, now, actor, ITEMS, id, version, now, actor),
    ],
    build: (cur) => {
      if (!cur) throw notFound(`No item ${id}`);
      requireFleet(c.caller, cur.data);
      if (scope !== null && cur.data.orchestrator !== scope) throw forbidden("Item belongs to another orchestrator");
      const next =
        role === "user"
          ? { ...cur.data, qa_pending: true, qa_last_at: now, updated_at: now }
          : { ...mergePatch(cur.data, patch), qa_pending: false, qa_answered_at: now, updated_at: now };
      stampFleet(c.caller, cur.data, next, false);
      dropSnooze(next);
      const valid = validateItem(next, cur.data);
      checkScopedWrite(scope, cur.data, valid);
      checkDecidedKept(c, cur, valid, meant);
      return valid;
    },
    respond: (item) => ({ body: { message: msgDoc, item }, status: 201 }),
    after: (item) => {
      if (role !== "user") notifyAnswer(c, item, msgDoc);
    },
  };
}

export const itemRoutes: Route[] = [
  ["GET", "/items", listItems],
  ["GET", "/items/:id", getItem],
  ["PUT", "/items/:id", opRoute(putItemOp)],
  ["PATCH", "/items/:id", opRoute(patchItemOp)],
  ["DELETE", "/items/:id", deleteItem],
  ["POST", "/items/:id/decide", decide],
  ["POST", "/items/:id/claim", opRoute(claimOp)],
  ["POST", "/items/:id/archive", opRoute(archiveOp)],
  ["POST", "/items/:id/withdraw", opRoute(withdrawOp)],
  ["POST", "/items/:id/snooze", snooze],
  ["GET", "/items/:id/qa", listQa],
  ["POST", "/items/:id/qa", opRoute(qaOp)],
];
