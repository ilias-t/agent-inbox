// Shared by the reviews tests: a routine's token and its report/start calls, and readers of the raw tables.
import { env } from "cloudflare:workers";
import type { ReviewPr, ReviewReport, ReviewReportPayload } from "../../shared/types.ts";
import { samplePr, sampleReport } from "../fixtures/reviews.ts";
import { agent, mintToken, uid } from "./helpers.ts";

// A fresh routine with its own orchestrator token, as Settings → Agent tokens would mint it.
export async function routine(prefix = "rv") {
  const id = uid(prefix);
  const minted = await mintToken("orchestrator", id, `orch-${id}`);
  const client = agent(minted.secret);
  return {
    id,
    token: minted.secret,
    name: `orch-${id}`,
    client,
    report: (payload: Partial<ReviewReportPayload> & { stamp: string }) => client.post("/api/reviews/report", { result: "ok", ...payload }),
    start: (stamp: string, body: Record<string, unknown> = {}) => client.post(`/api/reviews/runs/${stamp}/start`, body),
  };
}

// A run stamp `minutes` after 2026-10-08T14:00Z (stamps sort by time).
export function stamp(minutes: number): string {
  const d = new Date(Date.UTC(2026, 9, 8, 14, 0, 0) + minutes * 60_000).toISOString();
  return d.slice(0, 19).replace(/:/g, "") + "Z";
}

export const reportOf = (numbers: number[], over: Partial<ReviewReport> = {}, pr: (n: number) => Partial<ReviewPr> = () => ({})): ReviewReport =>
  sampleReport(0, { prs: numbers.map((n) => samplePr(n, pr(n))), ...over });

export const changesFor = async (routineId: string) =>
  (
    await env.DB.prepare("SELECT seq, collection, doc_id, op, version, actor, orchestrator FROM changes WHERE collection = 'reviews' AND doc_id = ? ORDER BY seq")
      .bind(routineId)
      .all<{ seq: number; op: string; version: number | null; actor: string; orchestrator: string }>()
  ).results;

export const maxSeq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;

export async function rows(routineId: string) {
  const q = (sql: string) => env.DB.prepare(sql).bind(routineId).all<any>().then((r) => r.results);
  return {
    head: (await q("SELECT * FROM review_routines WHERE routine = ?"))[0] ?? null,
    runs: await q("SELECT stamp, result, has_report FROM review_runs WHERE routine = ? ORDER BY stamp"),
    prs: await q("SELECT number, status, last_stamp, gone_at FROM review_prs WHERE routine = ? ORDER BY number"),
    events: await q("SELECT number, stamp FROM review_events WHERE routine = ? ORDER BY stamp, number"),
  };
}
