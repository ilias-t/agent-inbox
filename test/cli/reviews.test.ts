// agent-inbox reviews start|report|show|pr against a fake API: the requests each makes, and exit codes
// (0 stored or replayed, 3 a conflicting replay, 1 a refused report, 2 usage).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../cli/main.mjs";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}
type Handler = (req: Seen) => { status?: number; body?: unknown } | undefined;
let handler: Handler = () => ({ body: {} });
let seen: Seen[] = [];
let baseUrl = "";
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const r = { method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined };
    seen.push(r);
    const reply = handler(r) ?? { body: {} };
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
});
let dir = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
  dir = mkdtempSync(join(tmpdir(), "ai-cli-reviews-"));
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  handler = () => ({ body: {} });
  seen = [];
});

async function run(argv: string[], stdin = "") {
  let stdout = "", stderr = "";
  const code = await main(argv, {
    env: { AGENT_INBOX_URL: baseUrl, AGENT_INBOX_TOKEN: "ait_test" },
    home: dir,
    stdout: (s: string) => (stdout += s),
    stderr: (s: string) => (stderr += s),
    readStdin: async () => stdin,
    now: () => Date.parse("2026-10-08T15:00:00.000Z"),
    sleep: async () => {},
  });
  return { code, stdout, stderr };
}
const file = (name: string, data: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data));
  return p;
};

const STAMP = "2026-10-08T180000Z";
const runDoc = (over: Record<string, unknown> = {}) => ({
  routine: "review-bot", stamp: STAMP, started_at: "2026-10-08T18:00:00.000Z", finished_at: "2026-10-08T18:28:00.000Z",
  result: "ok", dry: false, has_report: true, report_sha: "ab", data: { headline: "Approved #4752" }, ...over,
});
const orchMe = { kind: "token", name: "orch-review-bot", scope: "orchestrator", orchestrator: "review-bot" };

describe("reviews report", () => {
  const payload = { stamp: STAMP, result: "ok", report: { schema: 1, prs: [] } };

  it("posts the payload from a file or stdin, and prints what was stored", async () => {
    handler = () => ({ status: 201, body: { run: runDoc(), prs_written: 45, events_written: 3, gone: 1 } });
    const r = await run(["reviews", "report", "--file", file("p.json", payload)]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: "/agent/api/reviews/report", body: payload }]);
    expect(r.stdout).toBe(`${STAMP}: stored (ok); 45 PRs written, 3 events, 1 gone\n`);
    seen = [];
    expect((await run(["reviews", "report", "--file", "-", "--json"], JSON.stringify(payload))).code).toBe(0);
    expect(seen[0].body).toEqual(payload);
  });

  it("a replay of the same body exits 0", async () => {
    handler = () => ({ body: { run: runDoc(), prs_written: 0, events_written: 0, gone: 0, replayed: true } });
    const r = await run(["reviews", "report", "--file", file("p.json", payload)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${STAMP}: already stored (ok), nothing written\n`);
  });

  it("a conflicting replay exits 3 with the stored run on stderr", async () => {
    handler = () => ({ status: 409, body: { error: "conflict", message: "Run already stored", current: runDoc() } });
    const r = await run(["reviews", "report", "--file", file("p.json", payload)]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr)).toEqual({ error: "conflict", message: "Run already stored", current: runDoc() });
  });

  it("a refused report exits 1 with the server's problems", async () => {
    handler = () => ({ status: 400, body: { error: "bad_request", message: 'report: #4701: unknown status "merged"' } });
    const r = await run(["reviews", "report", "--file", file("p.json", payload)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown status "merged"');
  });

  it("needs --file holding an object", async () => {
    expect((await run(["reviews", "report"])).code).toBe(2);
    expect((await run(["reviews", "report", "--file", file("a.json", [1])])).code).toBe(2);
    expect((await run(["reviews", "report", "--file", "-"], "not json")).code).toBe(2);
    expect(seen).toEqual([]);
  });
});

describe("reviews start", () => {
  it("posts to the run's start path, with an optional body", async () => {
    handler = () => ({ status: 201, body: runDoc({ result: "running", finished_at: null, data: {} }) });
    const r = await run(["reviews", "start", STAMP]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: `/agent/api/reviews/runs/${STAMP}/start`, body: {} }]);
    expect(r.stdout).toBe(`${STAMP}  running        started 2026-10-08T18:00:00.000Z\n`);
    seen = [];
    await run(["reviews", "start", STAMP, "--file", file("s.json", { model: "opus", next_run_at: "2026-10-08T20:00:00Z" })]);
    expect(seen[0].body).toEqual({ model: "opus", next_run_at: "2026-10-08T20:00:00Z" });
  });

  it("checks the stamp before sending anything", async () => {
    for (const bad of [[], ["2026-10-08T18:00:00Z"], ["today"]]) expect((await run(["reviews", "start", ...bad])).code).toBe(2);
    expect(seen).toEqual([]);
  });
});

describe("reviews show and pr", () => {
  const view = {
    routine: { routine: "review-bot", version: 7, last_stamp: STAMP, next_run_at: null, updated_at: "x", updated_by: "token:orch-review-bot" },
    prs: [{ number: 4763, status: "approved", needs_you: false, gone_at: null, data: { title: "Hermes images" } }],
    runs: [runDoc()],
    more: true,
  };

  it("shows the token's own routine by default", async () => {
    handler = (req) => ({ body: req.path === "/agent/api/me" ? orchMe : view });
    const r = await run(["reviews"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/me", "/agent/api/reviews/review-bot"]);
    expect(r.stdout).toContain("#4763   approved           Hermes images");
    expect(r.stdout).toContain(`${STAMP}  ok             Approved #4752`);
    expect(r.stdout).toContain(`--before ${STAMP}`);
  });

  it("names a routine and pages its runs", async () => {
    handler = () => ({ body: view });
    expect((await run(["reviews", "show", "review-bot-dry", "--limit", "5", "--before", STAMP])).code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual([`/agent/api/reviews/review-bot-dry?limit=5&before=${STAMP}`]);
    expect((await run(["reviews", "show", "x", "--limit", "500"])).code).toBe(2);
  });

  it("lists every routine for a token with no routine of its own", async () => {
    handler = (req) => ({
      body:
        req.path === "/agent/api/me"
          ? { kind: "token", name: "manager", scope: "manager" }
          : { routines: [{ routine: "review-bot", version: 7, last_run: { stamp: STAMP, result: "ok" }, counts: { approved: 8 }, needs_you: 2, running: null, next_run_at: null }] },
    });
    const r = await run(["reviews", "show"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/me", "/agent/api/reviews"]);
    expect(r.stdout).toBe(`review-bot            last ${STAMP} ok  approved 8  needs you 2\n`);
  });

  it("pr reads one PR of the token's routine, or of --routine", async () => {
    const pr = { pr: { ...view.prs[0], url: "https://github.com/acme/widgets/pull/4763", data: { title: "Hermes images", status_note: "Approved." } }, events: [{ stamp: STAMP, data: { action: "approved", summary: "All fixed", review_url: null } }] };
    handler = (req) => ({ body: req.path === "/agent/api/me" ? orchMe : pr });
    const r = await run(["reviews", "pr", "4763"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/me", "/agent/api/reviews/review-bot/prs/4763"]);
    expect(r.stdout).toContain(`  ${STAMP}  approved          All fixed`);
    seen = [];
    await run(["reviews", "pr", "4763", "--routine", "other"]);
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/reviews/other/prs/4763"]);
  });

  it("pr needs a PR number, and a routine when the token has none", async () => {
    expect((await run(["reviews", "pr"])).code).toBe(2);
    expect((await run(["reviews", "pr", "47a"])).code).toBe(2);
    handler = () => ({ body: { kind: "human", email: "you@test", role: "admin", is_admin: true } });
    expect((await run(["reviews", "pr", "4763"])).code).toBe(2);
  });

  it("a read of another routine's data exits 1 with the scope hint", async () => {
    handler = (req) => (req.path === "/agent/api/me" ? { body: orchMe } : { status: 403, body: { error: "forbidden", message: "Not this token's routine" } });
    const r = await run(["reviews", "show", "theirs"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("this token's scope doesn't allow it");
  });
});

describe("reviews request and request-update", () => {
  const req = { id: "rq-20261008T180000-1a2b3c4d", status: "requested", requested_at: "2026-10-08T18:00:00.000Z", requested_by: "you@test", updated_at: "2026-10-08T18:00:00.000Z", stamp: null, message: null };

  it("request reads the token's own routine's request, or a named routine's", async () => {
    handler = (r) => ({ body: r.path === "/agent/api/me" ? orchMe : { request: req } });
    const r = await run(["reviews", "request"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/me", "/agent/api/reviews/review-bot/run-request"]);
    expect(r.stdout).toBe("rq-20261008T180000-1a2b3c4d   requested  by you@test at 2026-10-08T18:00:00.000Z\n");
    seen = [];
    handler = () => ({ body: { request: null } });
    expect((await run(["reviews", "request", "review-bot-dry", "--json"])).stdout).toBe('{\n  "request": null\n}\n');
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/reviews/review-bot-dry/run-request"]);
  });

  it("request-update posts the status, the stamp only with started, and an optional message", async () => {
    handler = () => ({ body: { request: { ...req, status: "started", stamp: STAMP } } });
    const r = await run(["reviews", "request-update", req.id, "started", "--stamp", STAMP]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: `/agent/api/reviews/run-requests/${req.id}`, body: { status: "started", stamp: STAMP } }]);
    expect(r.stdout).toContain(`started    by you@test at 2026-10-08T18:00:00.000Z · run ${STAMP}`);
    seen = [];
    await run(["reviews", "request-update", req.id, "skipped", "--message", "a run was still going"]);
    expect(seen[0].body).toEqual({ status: "skipped", message: "a run was still going" });
  });

  it("request-update checks its arguments before sending anything, and exits 3 on a 409", async () => {
    for (const bad of [[], [req.id], [req.id, "done"], [req.id, "started"], [req.id, "started", "--stamp", "now"], [req.id, "failed", "--stamp", STAMP]]) {
      expect((await run(["reviews", "request-update", ...bad])).code, bad.join(" ")).toBe(2);
    }
    expect(seen).toEqual([]);
    handler = () => ({ status: 409, body: { error: "conflict", message: "already started", current: { request: req } } });
    expect((await run(["reviews", "request-update", req.id, "starting"])).code).toBe(3);
  });
});
