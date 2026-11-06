import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../cli/main.mjs";
import { resolveConfig } from "../../cli/config.mjs";
import { projectDirs, sessionDirs } from "../../cli/relink.mjs";

interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
type Handler = (req: SeenRequest) => Reply | undefined;

// One fake API server for the file; each test sets `handler` and reads `seen`.
let handler: Handler = () => ({ body: {} });
let seen: SeenRequest[] = [];
let baseUrl = "";
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const r: SeenRequest = { method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(r);
    const reply = handler(r) ?? { body: {} };
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
});

let home = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
  home = mkdtempSync(join(tmpdir(), "ai-cli-home-"));
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => {
  handler = () => ({ body: {} });
  seen = [];
});

interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
async function run(argv: string[], opts: RunOptions = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env: opts.env ?? { AGENT_INBOX_URL: baseUrl, AGENT_INBOX_TOKEN: "ait_test" },
    home,
    stdout: (s: string) => (stdout += s),
    stderr: (s: string) => (stderr += s),
    readStdin: async () => opts.stdin ?? "",
    now: opts.now ?? (() => Date.parse("2026-10-07T15:00:00.000Z")),
    sleep: opts.sleep ?? (async () => {}),
  });
  return { code, stdout, stderr };
}

const doc = (id: string, data: Record<string, unknown>, version = 1) => ({
  id,
  version,
  data,
  created_at: "2026-10-07T14:00:00.000Z",
  updated_at: "2026-10-07T14:00:00.000Z",
  updated_by: "token:manager",
});

describe("requests", () => {
  it("lists items with filters under /agent/api and the bearer token", async () => {
    handler = () => ({ body: { items: [doc("O3-x", { type: "decision", title: "T", status: "open", orchestrator: "O3", qa_pending: true })] } });
    const r = await run(["items", "--status", "open,decided", "--orchestrator", "O3", "--qa-pending", "--type", "decision"]);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].path).toBe("/agent/api/items?status=open%2Cdecided&orchestrator=O3&qa_pending=true&type=decision");
    expect(seen[0].headers.authorization).toBe("Bearer ait_test");
    expect(r.stdout).toContain("O3-x");
    expect(r.stdout).toContain("[qa?]");
  });

  it("--json prints the raw response", async () => {
    const body = { kind: "token", name: "manager", scope: "manager" };
    handler = () => ({ body });
    const r = await run(["me", "--json"]);
    expect(JSON.parse(r.stdout)).toEqual(body);
  });

  it("post builds a full briefing from flags and creates with if_version 0", async () => {
    handler = (req) => ({ status: 201, body: doc("O3-db", (req.body as { data: Record<string, unknown> }).data) });
    const r = await run([
      "post", "O3-db",
      "--type", "decision",
      "--title", "Pick a DB",
      "--question", "Which DB?",
      "--context", "line 1\nline 2",
      "--steps", "```bash\nnpm run deploy\n```",
      "--command", "git push --force-with-lease",
      "--priority", "high",
      "--orchestrator", "O3",
      "--cost-of-waiting", "O3 idles",
      "--option", "pg:Postgres:Managed: boring",
      "--option", "sqlite:SQLite",
      "--recommend", "pg:high:Ops: already run it",
      "--link", "PR=https://github.com/ilias-t/agent-inbox/pull/3",
      "--evidence", "https://github.com/ilias-t/agent-inbox/issues/4?a=b",
      "--set", "source=sweep:O3",
      "--set", "extra:={\"n\":1}",
    ]);
    expect(r.code).toBe(0);
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].path).toBe("/agent/api/items/O3-db");
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].body).toEqual({
      if_version: 0,
      data: {
        type: "decision",
        title: "Pick a DB",
        question: "Which DB?",
        context: "line 1\nline 2",
        steps: "```bash\nnpm run deploy\n```",
        command: "git push --force-with-lease",
        priority: "high",
        orchestrator: "O3",
        cost_of_waiting: "O3 idles",
        options: [
          { id: "pg", label: "Postgres", description: "Managed: boring" },
          { id: "sqlite", label: "SQLite" },
        ],
        recommendation: { option: "pg", confidence: "high", why: "Ops: already run it" },
        links: [{ label: "PR", url: "https://github.com/ilias-t/agent-inbox/pull/3" }],
        evidence: [{ label: "https://github.com/ilias-t/agent-inbox/issues/4?a=b", url: "https://github.com/ilias-t/agent-inbox/issues/4?a=b" }],
        source: "sweep:O3",
        extra: { n: 1 },
      },
    });
    expect(r.stdout).toMatch(/^created items\/O3-db/);
  });

  it("post --file - reads stdin, flags win, --if-version replaces", async () => {
    handler = (req) => ({ body: doc("i-1", (req.body as { data: Record<string, unknown> }).data, 4) });
    const r = await run(["post", "i-1", "--file", "-", "--title", "From flag", "--if-version", "3"], {
      stdin: JSON.stringify({ type: "info", title: "From file", summary: "s" }),
    });
    expect(r.code).toBe(0);
    expect(seen[0].body).toEqual({ if_version: 3, data: { type: "info", title: "From flag", summary: "s" } });
  });

  it("--replace-decided sends replace_decided on post and patch; without it nothing extra goes", async () => {
    handler = (req) => ({ body: doc("i-1", (req.body as { data: Record<string, unknown> }).data ?? {}, 5) });
    expect((await run(["post", "i-1", "--title", "Reset", "--if-version", "4", "--replace-decided"])).code).toBe(0);
    expect(seen[0].body).toEqual({ if_version: 4, data: { title: "Reset" }, replace_decided: true });
    expect((await run(["patch", "i-1", "--set", "status=open", "--replace-decided"])).code).toBe(0);
    expect(seen[1].body).toEqual({ data: { status: "open" }, replace_decided: true });
    expect((await run(["patch", "i-1", "--set", "summary=s"])).code).toBe(0);
    expect(seen[2].body).toEqual({ data: { summary: "s" } });
  });

  it("text that starts with a dash works as a positional and as a flag value", async () => {
    handler = (req) => ({ body: doc("i-2", (req.body as { data: Record<string, unknown> }).data) });
    const r = await run(["post", "i-2", "--title", "-3 tests flaky", "--context", "- one\n- two", "--summary=-x"]);
    expect(r.code).toBe(0);
    expect((seen[0].body as { data: unknown }).data).toEqual({ title: "-3 tests flaky", context: "- one\n- two", summary: "-x" });
  });

  it("post without a title is a usage error and sends nothing", async () => {
    const r = await run(["post", "i-1", "--type", "info"]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("patch maps --set (string and typed), --unset and --if-version", async () => {
    handler = () => ({ body: doc("i-1", { title: "x" }, 5) });
    const r = await run(["patch", "i-1", "--set", "title=10", "--set", "qa_pending:=false", "--unset", "asks", "--if-version", "4"]);
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "PATCH", path: "/agent/api/items/i-1" });
    expect(seen[0].body).toEqual({ data: { title: "10", qa_pending: false, asks: null }, if_version: 4 });
  });

  it("items --assignee passes an email or none through, and lists the assignee", async () => {
    handler = () => ({ body: { items: [doc("i-1", { type: "info", title: "T", status: "open", assignee: "bob@example.com" })] } });
    const r = await run(["items", "--assignee", "bob@example.com"]);
    await run(["items", "--assignee", "none"]);
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/items?assignee=bob%40example.com", "/agent/api/items?assignee=none"]);
    expect(r.stdout).toContain("[@bob@example.com]");
  });

  it("--assignee me / --assign me resolve to the human's email from /api/me", async () => {
    handler = (req) =>
      req.path === "/agent/api/me"
        ? { body: { kind: "human", email: "alice@example.com", is_admin: true } }
        : { body: req.method === "GET" ? { items: [] } : doc("i-1", { title: "x" }) };
    expect((await run(["items", "--assignee", "me", "--status", "open"])).code).toBe(0);
    expect((await run(["patch", "i-1", "--assign", "me"])).code).toBe(0);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["GET", "/agent/api/me", undefined],
      ["GET", "/agent/api/items?status=open&assignee=alice%40example.com", undefined],
      ["GET", "/agent/api/me", undefined],
      ["PATCH", "/agent/api/items/i-1", { data: { assignee: "alice@example.com" } }],
    ]);
  });

  it("me is a usage error for a token, before anything is written", async () => {
    handler = () => ({ body: { kind: "token", name: "manager", scope: "manager" } });
    const r = await run(["patch", "i-1", "--assign", "me"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("human");
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/me"]);
  });

  it("post --assignee sets it; patch --assign / --unassign set and clear it, with --set", async () => {
    handler = (req) => ({ body: doc("i-1", (req.body as { data: Record<string, unknown> }).data) });
    await run(["post", "i-1", "--title", "T", "--assignee", "bob@example.com"]);
    await run(["patch", "i-1", "--assign", "bob@example.com", "--set", "priority=high"]);
    await run(["patch", "i-1", "--unassign", "--if-version", "2"]);
    expect(seen.map((s) => s.body)).toEqual([
      { data: { title: "T", assignee: "bob@example.com" }, if_version: 0 },
      { data: { priority: "high", assignee: "bob@example.com" } },
      { data: { assignee: null }, if_version: 2 },
    ]);
    const both = await run(["patch", "i-1", "--assign", "bob@example.com", "--unassign"]);
    expect(both.code).toBe(2);
    expect(seen).toHaveLength(3);
  });

  it("show prints the assignee; me prints a human's role", async () => {
    handler = (req) => ({
      body: req.path.endsWith("/qa") ? { messages: [] } : doc("i-1", { type: "info", title: "T", status: "open", assignee: "bob@example.com" }),
    });
    expect((await run(["show", "i-1"])).stdout).toContain("Assignee: bob@example.com");
    handler = () => ({ body: { kind: "human", email: "bob@example.com", role: "viewer", is_admin: false } });
    expect((await run(["me"])).stdout).toBe("human bob@example.com (viewer)\n");
    handler = () => ({ body: { kind: "human", email: "bob@example.com", role: "admin", is_admin: true } });
    expect((await run(["me"])).stdout).toBe("human bob@example.com (admin)\n");
    // A server from before roles.
    handler = () => ({ body: { kind: "human", email: "bob@example.com", is_admin: false } });
    expect((await run(["me"])).stdout).toBe("human bob@example.com (not an admin)\n");
    handler = () => ({ body: { kind: "human", email: "bob@example.com", is_admin: true } });
    expect((await run(["me"])).stdout).toBe("human bob@example.com\n");
  });

  it("me prints a token's scope and fleet", async () => {
    handler = () => ({ body: { kind: "token", name: "orch", scope: "manager", fleet: "side-a" } });
    expect((await run(["me"])).stdout).toBe("token orch (manager) fleet side-a\n");
    handler = () => ({ body: { kind: "token", name: "orch-O3", scope: "orchestrator", orchestrator: "O3", fleet: "default" } });
    expect((await run(["me"])).stdout).toBe("token orch-O3 (orchestrator O3) fleet default\n");
    // A server from before fleets.
    handler = () => ({ body: { kind: "token", name: "orch", scope: "manager" } });
    expect((await run(["me"])).stdout).toBe("token orch (manager)\n");
  });

  it("users lists people and their roles (read-only: roles are set in Settings)", async () => {
    handler = () => ({
      body: { users: [{ email: "boss@example.com", name: "Boss", role: "admin" }, { email: "vic@example.com", role: "viewer" }] },
    });
    const r = await run(["users"]);
    expect(seen.map((s) => [s.method, s.path])).toEqual([["GET", "/agent/api/users"]]);
    expect(r.stdout).toBe("boss@example.com  admin  Boss\nvic@example.com  viewer\n");
    handler = () => ({ body: { users: [] } });
    expect((await run(["users"])).stdout).toBe("no users yet\n");
  });

  it("decide, claim, archive and delete hit their endpoints", async () => {
    handler = () => ({ body: doc("i-1", { status: "x" }) });
    await run(["decide", "i-1", "approve", "--note", "go", "--no-pin"]);
    await run(["decide", "i-1", "reject", "--if-version", "3"]);
    await run(["claim", "i-1", "--if-version", "0"]);
    await run(["archive", "i-1"]);
    handler = () => ({ body: { ok: true } });
    await run(["delete", "i-1", "--if-version", "2"]);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["POST", "/agent/api/items/i-1/decide", { choice: "approve", note: "go" }],
      ["POST", "/agent/api/items/i-1/decide", { choice: "reject", if_version: 3 }],
      ["POST", "/agent/api/items/i-1/claim", { if_version: 0 }],
      ["POST", "/agent/api/items/i-1/archive", {}],
      ["DELETE", "/agent/api/items/i-1?if_version=2", undefined],
    ]);
  });

  it("withdraw posts the pin and the note, and prints the archived item", async () => {
    handler = () => ({ body: doc("i-1", { status: "archived", title: "T", decision: { choice: "withdrawn" } }, 4) });
    const r = await run(["withdraw", "i-1", "--if-version", "3", "--note", "Hold cleared on GitHub"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^withdrew items\/i-1/);
    await run(["withdraw", "i-1", "--if-version", "3", "--json"]);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["POST", "/agent/api/items/i-1/withdraw", { if_version: 3, note: "Hold cleared on GitHub" }],
      ["POST", "/agent/api/items/i-1/withdraw", { if_version: 3 }],
    ]);
  });

  it("withdraw needs --if-version: it takes back only the version you read as open", async () => {
    const r = await run(["withdraw", "i-1", "--note", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--if-version/);
    expect(seen).toHaveLength(0);
  });

  it("withdraw exits 3 when the human decided first (409 not_open with current)", async () => {
    const current = doc("i-1", { status: "decided", decision: { choice: "ack" } }, 4);
    handler = () => ({ status: 409, body: { error: "not_open", message: "Item is decided", current } });
    const r = await run(["withdraw", "i-1", "--if-version", "3", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr)).toMatchObject({ error: "not_open", current });
  });

  it("withdraw's 403 (not your source) exits 1", async () => {
    handler = () => ({ status: 403, body: { error: "forbidden", message: "Orchestrator tokens withdraw only items they posted" } });
    expect((await run(["withdraw", "i-1", "--if-version", "3"])).code).toBe(1);
  });

  it("answer joins the text words and sends the pin and item data", async () => {
    handler = () => ({ body: { message: doc("m-1", { role: "manager", text: "t" }), item: doc("i-1", { status: "open" }, 3) } });
    const r = await run(["answer", "i-1", "Yes,", "it", "does.", "--if-version", "2", "--set", "recommendation:={\"option\":\"b\"}"]);
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/agent/api/items/i-1/qa" });
    expect(seen[0].body).toEqual({ text: "Yes, it does.", if_version: 2, data: { recommendation: { option: "b" } } });
  });

  it("ask posts a user-role question; show fetches the item and its qa", async () => {
    handler = (req) =>
      req.path.endsWith("/qa") && req.method === "GET"
        ? { body: { messages: [doc("m-1", { role: "user", text: "why?", created_at: "2026-10-07T14:00:00.000Z" })] } }
        : req.method === "GET"
          ? { body: doc("i-1", { type: "info", title: "T", status: "open" }) }
          : { body: { message: doc("m-2", {}), item: doc("i-1", {}) } };
    await run(["ask", "i-1", "why?"]);
    const r = await run(["show", "i-1", "--json"]);
    expect(seen[0].body).toEqual({ text: "why?", role: "user" });
    expect(seen.slice(1).map((s) => s.path).sort()).toEqual(["/agent/api/items/i-1", "/agent/api/items/i-1/qa"]);
    expect(JSON.parse(r.stdout).qa[0].data.text).toBe("why?");
  });

  it("orch set --set PATCHes and creates with PUT when missing", async () => {
    handler = (req) => (req.method === "PATCH" ? { status: 404, body: { error: "not_found", message: "no doc" } } : { status: 201, body: doc("O4", {}) });
    const r = await run(["orch", "set", "O4", "--set", "goal=Ship it", "--set", "status=running", "--unset", "asks"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["PATCH", "/agent/api/orchestrators/O4", { data: { goal: "Ship it", status: "running", asks: null } }],
      ["PUT", "/agent/api/orchestrators/O4", { data: { goal: "Ship it", status: "running" }, if_version: 0 }],
    ]);
  });

  it("a pinned orch set does not fall back to create on 404", async () => {
    handler = () => ({ status: 404, body: { error: "not_found", message: "no doc" } });
    const r = await run(["orch", "set", "O4", "--set", "goal=x", "--if-version", "3"]);
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("digest stamps last_pickup (and last_tick with --sweep) and a relative next_tick", async () => {
    handler = () => ({ body: doc("manager", {}, 9) });
    await run(["digest", "- all quiet", "--sweep", "--next-tick", "+10m", "--if-version", "8"]);
    expect(seen[0]).toMatchObject({ method: "PATCH", path: "/agent/api/meta/manager" });
    expect(seen[0].body).toEqual({
      if_version: 8,
      data: {
        digest: "- all quiet",
        last_pickup: "2026-10-07T15:00:00.000Z",
        last_tick: "2026-10-07T15:00:00.000Z",
        next_tick: "2026-10-07T15:10:00.000Z",
      },
    });
  });

  it("digest without a body stamps times and leaves the digest alone", async () => {
    handler = () => ({ body: doc("manager", {}, 9) });
    const r = await run(["digest", "--next-tick", "+10m"]);
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "PATCH", path: "/agent/api/meta/manager" });
    expect(seen[0].body).toEqual({ data: { last_pickup: "2026-10-07T15:00:00.000Z", next_tick: "2026-10-07T15:10:00.000Z" } });
  });

  it("digest without --next-tick defaults next_tick to the schedule's next pickup (also with --sweep)", async () => {
    handler = (req) =>
      req.method === "GET" && req.path === "/agent/api/schedule"
        ? { body: { computed: { next_pickup_at: "2026-10-07T15:10:00.000Z" } } }
        : { body: doc("manager", {}, 9) };
    const r = await run(["digest", "--sweep"]);
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/agent/api/schedule" });
    expect(seen[1]).toMatchObject({ method: "PATCH", path: "/agent/api/meta/manager" });
    expect(seen[1].body).toEqual({
      data: { last_pickup: "2026-10-07T15:00:00.000Z", last_tick: "2026-10-07T15:00:00.000Z", next_tick: "2026-10-07T15:10:00.000Z" },
    });
  });

  it("an explicit --next-tick skips the schedule fetch", async () => {
    handler = () => ({ body: doc("manager", {}, 9) });
    await run(["digest", "--next-tick", "+10m"]);
    expect(seen.map((s) => s.path)).toEqual(["/agent/api/meta/manager"]);
  });

  it("digest still stamps, with a stderr warning, when the schedule has no next pickup or can't be fetched", async () => {
    handler = (req) =>
      req.path === "/agent/api/schedule" ? { body: { computed: { next_pickup_at: null } } } : { body: doc("manager", {}, 9) };
    let r = await run(["digest"]);
    expect(r.code).toBe(0);
    expect(seen[1].body).toEqual({ data: { last_pickup: "2026-10-07T15:00:00.000Z" } });
    expect(r.stderr).toMatch(/next_tick/);
    seen = [];
    handler = (req) =>
      req.path === "/agent/api/schedule" ? { status: 500, body: { error: "boom", message: "boom" } } : { body: doc("manager", {}, 9) };
    r = await run(["digest"]);
    expect(r.code).toBe(0);
    expect(seen[1].body).toEqual({ data: { last_pickup: "2026-10-07T15:00:00.000Z" } });
    expect(r.stderr).toMatch(/next_tick/);
  });

  it("orch set explains a 403 on the create fallback", async () => {
    handler = (req) =>
      req.method === "PATCH"
        ? { status: 404, body: { error: "not_found", message: "no doc" } }
        : { status: 403, body: { error: "forbidden", message: "Not your orchestrator" } };
    const r = await run(["orch", "set", "O4", "--set", "goal=x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/orchestrators\/O4 doesn't exist and this token can't create it: Not your orchestrator/);
  });

  it("tick-request and meta get", async () => {
    handler = () => ({ body: doc("manager", {}) });
    await run(["tick-request", "--note", "now please"]);
    await run(["meta", "get", "manager"]);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["POST", "/agent/api/meta/manager/tick-request", { note: "now please" }],
      ["GET", "/agent/api/meta/manager", undefined],
    ]);
  });

  it("lease acquire --force requires --if-version, then sends the steal", async () => {
    expect((await run(["lease", "acquire", "--session", "s1", "--force"])).code).toBe(2);
    expect(seen).toHaveLength(0);
    handler = () => ({ body: { lease: doc("lease", { holder_session_id: "s1", heartbeat_at: "2026-10-07T15:00:00.000Z", expires_at: "2026-10-07T15:25:00.000Z", acquired_at: "2026-10-07T15:00:00.000Z" }, 8), acquired: true } });
    const r = await run(["lease", "acquire", "--session", "s1", "--title", "Manager", "--holder-url", "https://claude.ai/code/cse_x", "--ttl", "30", "--force", "--if-version", "7"]);
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/agent/api/lease/acquire" });
    expect(seen[0].body).toEqual({ session_id: "s1", title: "Manager", url: "https://claude.ai/code/cse_x", ttl_min: 30, force: true, if_version: 7 });
  });

  it("lease renew takes the session from AGENT_INBOX_SESSION; bare `lease` reads it", async () => {
    handler = () => ({ body: { lease: null, expired: false, now: "2026-10-07T15:00:00.000Z" } });
    const env = { AGENT_INBOX_URL: baseUrl, AGENT_INBOX_TOKEN: "t", AGENT_INBOX_SESSION: "sess-9" };
    await run(["lease", "renew"], { env });
    const r = await run(["lease"], { env });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/agent/api/lease/renew", body: { session_id: "sess-9" } });
    expect(seen[1]).toMatchObject({ method: "GET", path: "/agent/api/lease" });
    expect(r.stdout).toContain("free");
  });

  it("--session or AGENT_INBOX_SESSION puts X-Lease-Session on writes, never on reads", async () => {
    handler = (req) => ({ body: req.method === "GET" ? { items: [] } : doc("x", { type: "info", title: "x" }, 2) });
    const env = { AGENT_INBOX_URL: baseUrl, AGENT_INBOX_TOKEN: "t", AGENT_INBOX_SESSION: "sess-9" };
    await run(["claim", "x", "--if-version", "1"], { env });
    await run(["items"], { env });
    await run(["--session", "sess-1", "patch", "x", "--set", "summary=y"]); // global flag before the command word
    await run(["archive", "x", "--session", "sess-2"]);
    await run(["delete", "x"], { env });
    await run(["batch", "--file", "-"], { env, stdin: JSON.stringify([{ op: "item.archive", id: "x" }]) });
    expect(seen.map((r) => [r.method, r.path.split("?")[0], r.headers["x-lease-session"]])).toEqual([
      ["POST", "/agent/api/items/x/claim", "sess-9"],
      ["GET", "/agent/api/items", undefined],
      ["PATCH", "/agent/api/items/x", "sess-1"],
      ["POST", "/agent/api/items/x/archive", "sess-2"],
      ["DELETE", "/agent/api/items/x", "sess-9"],
      ["POST", "/agent/api/batch", "sess-9"],
    ]);
  });

  it("without --session or AGENT_INBOX_SESSION no header is sent, even when CLAUDE_SESSION_ID is set", async () => {
    handler = () => ({ body: doc("x", { type: "info", title: "x" }, 2) });
    await run(["claim", "x"]);
    await run(["claim", "x"], { env: { AGENT_INBOX_URL: baseUrl, AGENT_INBOX_TOKEN: "t", CLAUDE_SESSION_ID: "claude-1" } });
    expect(seen).toHaveLength(2);
    expect(seen.map((r) => r.headers["x-lease-session"])).toEqual([undefined, undefined]);
  });

  it("an empty --session or AGENT_INBOX_SESSION is a usage error, not an unchecked write", async () => {
    for (const [argv, env] of [
      [["claim", "x", "--session", ""], undefined],
      [["--session", " ", "batch", "--file", "-"], undefined],
      [["claim", "x"], { AGENT_INBOX_URL: baseUrl, AGENT_INBOX_TOKEN: "t", AGENT_INBOX_SESSION: "" }],
    ] as const) {
      const r = await run([...argv], { env: env ? { ...env } : undefined, stdin: "[]" });
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/SESSION.*empty|--session is empty/);
    }
    expect(seen).toHaveLength(0);
  });

  it("a write refused by the lease check exits 3 with lease_held and the lease on stderr", async () => {
    const lease = doc("lease", { holder_session_id: "s2", expires_at: "2026-10-07T15:25:00.000Z" }, 4);
    handler = () => ({ status: 409, body: { error: "lease_held", message: "Lease held by s2", current: lease } });
    const r = await run(["batch", "--file", "-", "--session", "s1"], { stdin: JSON.stringify({ ops: [{ op: "item.archive", id: "x" }] }) });
    expect(r.code).toBe(3);
    expect(seen[0].headers["x-lease-session"]).toBe("s1");
    expect(JSON.parse(r.stderr)).toEqual({ error: "lease_held", message: "Lease held by s2", current: lease });
  });

  it("schedule set reads, merges and writes pinned to the read version (0 while defaults)", async () => {
    const view = (version: number | null) => ({
      schedule: { work_hours: "10:00-18:00 Mon-Fri", timezone: "America/New_York", pickup_interval_min: 10, sweep_interval_min: 30 },
      version,
      computed: { now: "x", in_hours: true, next_pickup_at: null, next_window_start: null, label: "10:00–18:00 ET, Mon–Fri", utc_offset_min: -240, cron_utc: ["3-59/10 14-21 * * 1-5"] },
    });
    handler = () => ({ body: view(null) });
    await run(["schedule", "set", "--pickup", "15", "--work-hours", "09:00-17:00 Mon-Thu"]);
    expect(seen[1]).toMatchObject({ method: "PUT", path: "/agent/api/schedule" });
    expect(seen[1].body).toEqual({
      if_version: 0,
      schedule: { work_hours: "09:00-17:00 Mon-Thu", timezone: "America/New_York", pickup_interval_min: 15, sweep_interval_min: 30 },
    });
    seen = [];
    handler = () => ({ body: view(4) });
    const r = await run(["schedule"]);
    await run(["schedule", "set", "--sweep", "45"]);
    expect((seen[2].body as { if_version: number }).if_version).toBe(4);
    expect(r.stdout).toContain("3-59/10 14-21 * * 1-5");
    expect(r.stdout).toContain("UTC-4");
    const cron = await run(["schedule", "--cron"]);
    expect(cron.stdout).toBe("3-59/10 14-21 * * 1-5\n");
  });

  it("schedule set refuses to overwrite a stored schedule served as defaults, unless --force", async () => {
    handler = () => ({
      body: {
        schedule: { work_hours: "10:00-18:00 Mon-Fri", timezone: "America/New_York", pickup_interval_min: 10, sweep_interval_min: 30 },
        version: 3,
        stored_invalid: true,
        computed: { now: "x", in_hours: true, next_pickup_at: null, next_window_start: null, label: "10:00–18:00 ET, Mon–Fri", utc_offset_min: -240, cron_utc: ["3-59/10 14-21 * * 1-5"] },
      },
    });
    const refused = await run(["schedule", "set", "--pickup", "15"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/stored schedule doesn't validate/);
    expect(refused.stderr).toContain("--force");
    expect(seen).toHaveLength(1);
    seen = [];
    expect((await run(["schedule", "set", "--pickup", "15", "--force"])).code).toBe(0);
    expect(seen[1]).toMatchObject({ method: "PUT", path: "/agent/api/schedule", body: { if_version: 3 } });
  });

  it("schedule --check exits 0 in hours and 5 off hours; a superset cron is flagged", async () => {
    const view = (in_hours: boolean, cron_exact: boolean) => ({
      schedule: { work_hours: "09:30-17:30 Mon-Fri", timezone: "America/New_York", pickup_interval_min: 10, sweep_interval_min: 30 },
      version: 2,
      computed: { now: "x", in_hours, next_pickup_at: null, next_window_start: "2026-10-08T13:30:00.000Z", label: "09:30–17:30 ET, Mon–Fri", utc_offset_min: -240, cron_utc: ["3-59/10 13-21 * * 1-5"], cron_exact },
    });
    handler = () => ({ body: view(true, false) });
    const inHours = await run(["schedule", "--check"]);
    expect(inHours.code).toBe(0);
    expect(inHours.stdout).toBe("in hours\n");
    const shown = await run(["schedule"]);
    expect(shown.stdout).toContain("superset");
    expect(shown.stdout).toContain("skip a firing when in_hours is false");
    handler = () => ({ body: view(false, true) });
    const off = await run(["schedule", "--check"]);
    expect(off.code).toBe(5);
    expect(off.stdout).toBe("off hours (next window 2026-10-08T13:30:00.000Z)\n");
    expect((await run(["schedule"])).stdout).not.toContain("skip a firing");
  });

  it("changes passes since, wait and collection", async () => {
    handler = () => ({ body: { cursor: 5, changes: [] } });
    const r = await run(["changes", "--since", "3", "--wait", "25", "--collection", "items"]);
    expect(seen[0].path).toBe("/agent/api/changes?since=3&wait=25&collection=items");
    expect(r.stdout).toBe("cursor 5\n");
  });
});

describe("batch", () => {
  const ops = [
    { op: "item.claim", id: "i-1", if_version: 2 },
    { op: "item.qa", id: "i-2", text: "because", if_version: 3 },
    { op: "meta.patch", id: "manager", data: { digest: "d" } },
  ];

  it("posts the ops from a file or stdin (an {ops} object or a bare array) and prints one line per op", async () => {
    handler = () => ({
      body: {
        results: [
          doc("i-1", { status: "processing" }, 3),
          { message: doc("m-1", { role: "manager" }), item: doc("i-2", { status: "open" }, 4) },
          doc("manager", { digest: "d" }, 9),
        ],
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "ai-batch-"));
    const file = join(dir, "ops.json");
    writeFileSync(file, JSON.stringify({ ops }));
    const fromFile = await run(["batch", "--file", file]);
    rmSync(dir, { recursive: true, force: true });
    expect(fromFile.code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/agent/api/batch", body: { ops } });
    expect(fromFile.stdout).toBe(
      "item.claim  items/i-1  v3  processing\nitem.qa  items/i-2  v4  open\nmeta.patch  meta/manager  v9\n",
    );

    const fromStdin = await run(["batch", "--file", "-", "--json"], { stdin: JSON.stringify(ops) });
    expect(fromStdin.code).toBe(0);
    expect(seen[1].body).toEqual({ ops });
    expect(JSON.parse(fromStdin.stdout).results).toHaveLength(3);
  });

  it("a failed pin exits 3 with the failing op's index on stderr, as one write", async () => {
    const current = doc("i-2", { status: "open" }, 5);
    handler = () => ({ status: 409, body: { error: "conflict", message: "Version mismatch", index: 1, current } });
    const r = await run(["batch", "--file", "-"], { stdin: JSON.stringify({ ops }) });
    expect(r.code).toBe(3);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(r.stderr)).toEqual({ error: "conflict", message: "Version mismatch", index: 1, current });
  });

  it("other errors exit 1 and name the op", async () => {
    handler = () => ({ status: 403, body: { error: "forbidden", message: "Not allowed for this token", index: 0 } });
    const r = await run(["batch", "--file", "-"], { stdin: JSON.stringify(ops) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/403 forbidden: Not allowed for this token \[batch op 0\]/);
  });

  it("needs --file with a non-empty list of ops", async () => {
    expect((await run(["batch"])).code).toBe(2);
    expect((await run(["batch", "--file", "-"], { stdin: "{}" })).code).toBe(2);
    expect((await run(["batch", "--file", "-"], { stdin: "[]" })).code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe("decide pins the version it acts on", () => {
  const decideReply = (open: ReturnType<typeof doc>, post: (r: SeenRequest) => Reply): Handler => (r) =>
    r.method === "GET" ? { body: open } : post(r);

  it("without --if-version it reads the item and decides against the version it read", async () => {
    const open = doc("i-1", { status: "open", title: "T" }, 7);
    handler = decideReply(open, () => ({ body: doc("i-1", { status: "decided", title: "T" }, 8) }));
    const r = await run(["decide", "i-1", "approve", "--note", "go"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["GET", "/agent/api/items/i-1", undefined],
      ["POST", "/agent/api/items/i-1/decide", { choice: "approve", if_version: 7, note: "go" }],
    ]);
    expect(r.stdout).toBe("decided items/i-1  v8  decided\n");
  });

  it("an item that changed between the read and the decide exits 3 with the current doc", async () => {
    const current = doc("i-1", { status: "open", title: "Edited" }, 8);
    handler = decideReply(doc("i-1", { status: "open" }, 7), () => ({
      status: 409,
      body: { error: "conflict", message: "Version mismatch", current },
    }));
    const r = await run(["decide", "i-1", "approve"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(seen.at(-1)!.body).toEqual({ choice: "approve", if_version: 7 });
    expect(JSON.parse(r.stderr)).toEqual({ error: "conflict", message: "Version mismatch", current });
  });

  it("an item that is no longer open exits 3 with not_open and the current doc", async () => {
    const current = doc("i-1", { status: "decided", decision: { choice: "reject" } }, 4);
    handler = decideReply(current, () => ({ status: 409, body: { error: "not_open", message: "item is decided", current } }));
    const r = await run(["decide", "i-1", "approve"]);
    expect(r.code).toBe(3);
    expect(seen.at(-1)!.body).toEqual({ choice: "approve", if_version: 4 });
    expect(JSON.parse(r.stderr)).toEqual({ error: "not_open", message: "item is decided", current });
  });

  it("a missing item exits 1 on the read and decides nothing", async () => {
    handler = () => ({ status: 404, body: { error: "not_found", message: "no such item" } });
    const r = await run(["decide", "i-1", "approve"]);
    expect(r.code).toBe(1);
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("an explicit --if-version decides without the extra read", async () => {
    handler = () => ({ body: doc("i-1", { status: "decided" }, 4) });
    const r = await run(["decide", "i-1", "approve", "--if-version", "3"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["POST", "/agent/api/items/i-1/decide", { choice: "approve", if_version: 3 }],
    ]);
  });

  it("--no-pin decides whatever is current, as before, with no read", async () => {
    handler = () => ({ body: doc("i-1", { status: "decided" }, 4) });
    const r = await run(["decide", "i-1", "approve", "--no-pin"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([["POST", "/agent/api/items/i-1/decide", { choice: "approve" }]]);
  });

  it("--no-pin with --if-version is a usage error", async () => {
    const r = await run(["decide", "i-1", "approve", "--no-pin", "--if-version", "3"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--no-pin/);
    expect(seen).toHaveLength(0);
  });
});

describe("errors and exit codes", () => {
  it("any 409 exits 3 with error, message and current on stderr", async () => {
    const current = doc("i-1", { status: "open" }, 6);
    handler = () => ({ status: 409, body: { error: "not_decided", message: "item is open", current } });
    const r = await run(["claim", "i-1"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr)).toEqual({ error: "not_decided", message: "item is open", current });
  });

  it("lease_held is a conflict too", async () => {
    handler = () => ({ status: 409, body: { error: "lease_held", message: "held", current: doc("lease", {}) } });
    expect((await run(["lease", "renew", "--session", "s"])).code).toBe(3);
  });

  it("401 and 403 exit 1 with a hint; the token is never printed", async () => {
    handler = () => ({ status: 401, body: { error: "unauthorized", message: "bad token" } });
    const r = await run(["me"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/401 unauthorized: bad token \(check the token/);
    expect(r.stderr + r.stdout).not.toContain("ait_test");
    handler = () => ({ status: 403, body: { error: "forbidden", message: "nope" } });
    expect((await run(["items"])).stderr).toMatch(/scope/);
  });

  it("an Access redirect is reported, not followed", async () => {
    handler = () => ({ status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } });
    const r = await run(["me"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/redirected to https:\/\/team\.cloudflareaccess\.com\/login/);
  });

  it("usage errors exit 2: unknown command, unknown flag, missing arg, bad --if-version, extra args", async () => {
    for (const argv of [["frobnicate"], ["items", "--nope"], ["claim"], ["claim", "i-1", "--if-version", "x"], ["claim", "a", "b"], ["meta"], ["show", "bad id"]]) {
      expect((await run(argv)).code, argv.join(" ")).toBe(2);
    }
    expect(seen).toHaveLength(0);
  });

  it("no token for an /agent url is a usage error before any request", async () => {
    const r = await run(["items"], { env: { AGENT_INBOX_URL: baseUrl } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no token/);
    expect(seen).toHaveLength(0);
  });

  it("help works without config", async () => {
    const r = await run(["help"], { env: {} });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("lease acquire");
    expect((await run(["wait", "--help"], { env: {} })).stdout).toContain("--human");
  });
});

describe("config", () => {
  it("flags beat env, env beats the config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-cfg-"));
    try {
      mkdirSync(join(dir, "agent-inbox"));
      writeFileSync(join(dir, "agent-inbox", "config.json"), JSON.stringify({ url: "https://file/agent/", token: "file-t" }));
      const env = { XDG_CONFIG_HOME: dir };
      expect(resolveConfig({}, env)).toMatchObject({ url: "https://file/agent", token: "file-t" });
      expect(resolveConfig({}, { ...env, AGENT_INBOX_TOKEN: "env-t" })).toMatchObject({ url: "https://file/agent", token: "env-t" });
      expect(resolveConfig({ url: "http://flag/agent", token: "flag-t" }, { ...env, AGENT_INBOX_TOKEN: "env-t", AGENT_INBOX_URL: "http://env" })).toMatchObject({
        url: "http://flag/agent",
        token: "flag-t",
      });
      expect(resolveConfig({}, { XDG_CONFIG_HOME: join(dir, "missing") })).toMatchObject({ url: "http://localhost:8787/agent", token: undefined });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty AGENT_INBOX_TOKEN means no token, not the config file's", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-cfg-"));
    try {
      mkdirSync(join(dir, "agent-inbox"));
      writeFileSync(join(dir, "agent-inbox", "config.json"), JSON.stringify({ url: "https://file/agent", token: "file-t" }));
      const env = { XDG_CONFIG_HOME: dir, AGENT_INBOX_TOKEN: "" };
      // The URL still comes from the file; the token doesn't.
      expect(resolveConfig({}, env)).toMatchObject({ url: "https://file/agent", token: undefined });
      expect(resolveConfig({}, { ...env, AGENT_INBOX_URL: "http://localhost:8787" })).toMatchObject({ url: "http://localhost:8787", token: undefined });
      // --token still beats it.
      expect(resolveConfig({ token: "flag-t" }, env)).toMatchObject({ token: "flag-t" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wait", () => {
  const change = (seq: number, actor: string, status: string | null = "decided", doc_id = "i-1") => ({
    seq,
    collection: "items",
    doc_id,
    op: "update",
    version: 2,
    status,
    actor,
    at: "2026-10-07T15:00:00.000Z",
  });

  it("bootstraps the cursor, skips non-matching changes and returns the human one", async () => {
    const replies = [
      { cursor: 10, changes: [] },
      { cursor: 11, changes: [change(11, "token:manager")] },
      { cursor: 13, changes: [change(12, "hook:github"), change(13, "human:you@example.com")] },
    ];
    handler = () => ({ body: replies.shift() });
    const r = await run(["wait", "--human", "--collection", "items", "--json"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual([
      "/agent/api/changes?collection=items",
      "/agent/api/changes?since=10&wait=25&collection=items",
      "/agent/api/changes?since=11&wait=25&collection=items",
    ]);
    const out = JSON.parse(r.stdout);
    expect(out.cursor).toBe(13);
    expect(out.timed_out).toBe(false);
    expect(out.changes.map((c: { seq: number }) => c.seq)).toEqual([13]);
  });

  it("treats ntfy action taps as human and filters by status and id", async () => {
    handler = () => ({ body: { cursor: 4, changes: [change(2, "hook:ntfy", "open"), change(3, "hook:ntfy", "decided", "other"), change(4, "hook:ntfy")] } });
    const r = await run(["wait", "--since", "1", "--human", "--status", "decided", "--id", "i-1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("change 4  update  items/i-1 v2  decided  by hook:ntfy  at 2026-10-07T15:00:00.000Z\ncursor 4\n");
  });

  it("retries network errors and 5xx with growing backoff, but not 401", async () => {
    let n = 0;
    handler = () => (++n <= 2 ? { status: 503, body: { error: "unavailable", message: "busy" } } : { body: { cursor: 9, changes: [change(9, "human:x")] } });
    const sleeps: number[] = [];
    const r = await run(["wait", "--since", "8"], { sleep: async (ms) => void sleeps.push(ms) });
    expect(r.code).toBe(0);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    expect(r.stderr).toMatch(/retrying/);

    seen = [];
    handler = () => ({ status: 401, body: { error: "unauthorized", message: "revoked" } });
    expect((await run(["wait", "--since", "8"])).code).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("times out with exit 4 and the unchanged cursor, pausing between fast empty polls", async () => {
    let t = Date.parse("2026-10-07T15:00:00.000Z");
    handler = () => ({ body: { cursor: 20, changes: [] } });
    const r = await run(["wait", "--since", "20", "--timeout", "10", "--json"], {
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout)).toEqual({ cursor: 20, changes: [], timed_out: true });
    // 10 s of 2 s pauses: about five polls, not a busy loop.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.length).toBeLessThanOrEqual(6);
    expect(seen[0].path).toBe("/agent/api/changes?since=20&wait=10");
  });

  it("--cursor-file resumes from and saves the cursor", async () => {
    const file = join(home, "state", "cursor");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(file, "41\n");
    handler = () => ({ body: { cursor: 42, changes: [change(42, "human:x")] } });
    const r = await run(["wait", "--cursor-file", file, "--human"]);
    expect(r.code).toBe(0);
    expect(seen[0].path).toBe("/agent/api/changes?since=41&wait=25");
    expect(readFileSync(file, "utf8")).toBe("42\n");
  });
});

describe("orch relink", () => {
  const SID = "99ec767e-be9e-4a1e-87b9-d2ec69c7dae1";
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ai-relink-"));
    const sessions = join(dir, "sessions"), projects = join(dir, "projects", "-home-dev-x");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ sessionId: SID, bridgeSessionId: "session_NEW1" }));
    writeFileSync(join(sessions, "999999.json"), JSON.stringify({ sessionId: "dead", bridgeSessionId: "session_DEAD" }));
    writeFileSync(join(projects, `${SID}.jsonl`), '{"bridgeSessionId":"cse_OLD1"}\n{"bridgeSessionId":"cse_NEW1"}\n');
    const env = { AGENT_INBOX_URL: baseUrl, AGENT_INBOX_TOKEN: "ait_test", AGENT_INBOX_SESSION_DIRS: sessions, AGENT_INBOX_PROJECT_DIRS: join(dir, "projects") };
    return { dir, env };
  }
  const list = (docs: unknown[]) => (req: SeenRequest) => (req.method === "GET" ? { body: { orchestrators: docs } } : { body: {} });

  it("--all patches a changed link, skips unchanged, dead and done managers", async () => {
    const { dir, env } = setup();
    handler = list([
      doc("O1", { status: "running", session_id: SID, session_url: "https://claude.ai/code/cse_OLD1" }, 4),
      doc("O2", { status: "running", session_id: SID, session_live: true, session_url: "https://claude.ai/code/cse_NEW1" }),
      doc("O3", { status: "parked", session_id: "dead", session_live: false, session_url: "https://claude.ai/code/cse_KEEP" }),
      doc("O8", { status: "parked", session_id: "dead", session_url: "https://claude.ai/code/cse_KEEP2" }, 2),
      doc("O4", { status: "done", session_id: SID, session_url: "https://claude.ai/code/cse_OLD1" }),
    ]);
    const r = await run(["orch", "relink", "--all"], { env });
    expect(r.code).toBe(0);
    const writes = seen.filter((q) => q.method !== "GET");
    expect(writes).toHaveLength(2);
    expect(writes[0].method).toBe("PATCH");
    expect(writes[0].path).toBe("/agent/api/orchestrators/O1");
    expect(writes[0].body).toEqual({ data: { session_live: true, session_url: "https://claude.ai/code/cse_NEW1", session_url_at: "2026-10-07T15:00:00.000Z" }, if_version: 4 });
    // a stopped manager keeps its link and is flagged, once
    expect(writes[1].path).toBe("/agent/api/orchestrators/O8");
    expect(writes[1].body).toEqual({ data: { session_live: false }, if_version: 2 });
    expect(r.stdout).toContain("O2: unchanged");
    expect(r.stdout).toContain("O3: no live session; link kept");
    expect(r.stdout).not.toContain("O4");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--seed finds a missing session_id from the transcripts, even for an old link, and relinks", async () => {
    const { dir, env } = setup();
    handler = list([doc("O5", { status: "running", session_url: "https://claude.ai/code/cse_OLD1" }), doc("O6", { status: "running", session_url: "https://claude.ai/code/cse_NOPE" })]);
    const r = await run(["orch", "relink", "--all", "--seed"], { env });
    expect(r.code).toBe(0);
    const writes = seen.filter((q) => q.method !== "GET");
    expect(writes).toHaveLength(1);
    expect((writes[0].body as { data: Record<string, string> }).data).toMatchObject({ session_id: SID, session_url: "https://claude.ai/code/cse_NEW1", session_live: true });
    expect(r.stdout).toContain("O6: no session_id");
    rmSync(dir, { recursive: true, force: true });
  });

  it("one manager by id with --session-id; nothing live means exit 0 and no write", async () => {
    const { dir, env } = setup();
    handler = (req) => (req.method === "GET" ? { body: doc("O7", { status: "running", session_url: "https://claude.ai/code/cse_X" }) } : { body: {} });
    const none = await run(["orch", "relink", "O7", "--session-id", "00000000-0000-0000-0000-000000000000"], { env });
    expect(none.code).toBe(0);
    expect(seen.filter((q) => q.method !== "GET")).toHaveLength(1); // session_id recorded, link untouched
    expect((seen.filter((q) => q.method !== "GET")[0].body as { data: Record<string, string> }).data).toEqual({ session_id: "00000000-0000-0000-0000-000000000000", session_live: false });
    expect(none.stdout).toContain("no live session; link kept");
    expect((await run(["orch", "relink"], { env })).code).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to Claude Code's own directories; a set override replaces them", () => {
    expect(sessionDirs({}, "/h")).toEqual(["/h/.claude/sessions"]);
    expect(projectDirs({}, "/h")).toEqual(["/h/.claude/projects"]);
    expect(sessionDirs({ AGENT_INBOX_SESSION_DIRS: "/a/sessions::/b/sessions" }, "/h")).toEqual(["/a/sessions", "/b/sessions"]);
    expect(projectDirs({ AGENT_INBOX_PROJECT_DIRS: "/a/projects" }, "/h")).toEqual(["/a/projects"]);
  });

  it("without the overrides, reads ~/.claude/sessions and nothing beside it", async () => {
    const sessions = join(home, ".claude", "sessions"), other = join(home, ".claude-other", "sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ sessionId: SID, bridgeSessionId: "session_HOME1" }));
    writeFileSync(join(other, `${process.pid}.json`), JSON.stringify({ sessionId: "other", bridgeSessionId: "session_OTHER" }));
    handler = list([
      doc("O1", { status: "running", session_id: SID, session_url: "https://claude.ai/code/cse_OLD1" }),
      doc("O2", { status: "running", session_id: "other", session_url: "https://claude.ai/code/cse_KEEP" }),
    ]);
    const r = await run(["orch", "relink", "--all"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("O1: relinked https://claude.ai/code/cse_HOME1");
    expect(r.stdout).toContain("O2: no live session; link kept");
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    rmSync(join(home, ".claude-other"), { recursive: true, force: true });
  });
});

describe("fleets", () => {
  const sched = (over: Record<string, unknown> = {}) => ({
    schedule: { work_hours: "10:00-18:00 Mon-Fri", timezone: "UTC", pickup_interval_min: 10, sweep_interval_min: 30 },
    version: 2,
    computed: { now: "x", in_hours: true, next_pickup_at: null, next_window_start: null, label: "10:00–18:00 UTC, Mon–Fri", utc_offset_min: 0, cron_utc: ["*/10 10-17 * * 1-5"], cron_exact: true },
    ...over,
  });
  const token = (fleet?: string) => ({ kind: "token", name: "orch", scope: "manager", ...(fleet ? { fleet } : {}) });

  it("me --expect-fleet exits 0 on the token's fleet and 3 on another, a person or a malformed id", async () => {
    handler = () => ({ body: token("side-a") });
    expect((await run(["me", "--expect-fleet", "side-a"])).code).toBe(0);
    const wrong = await run(["me", "--expect-fleet", "side-b"]);
    expect(wrong.code).toBe(3);
    expect(wrong.stderr).toContain("belongs to fleet side-a, not side-b");
    handler = () => ({ body: token() }); // a server before fleets: the default fleet
    expect((await run(["me", "--expect-fleet", "default"])).code).toBe(0);
    expect((await run(["me", "--expect-fleet", "side-a"])).code).toBe(3);
    handler = () => ({ body: { kind: "human", email: "a@b.c", role: "admin", is_admin: true } });
    expect((await run(["me", "--expect-fleet", "default"])).code).toBe(3);
    expect((await run(["me", "--expect-fleet", "Side A"])).code).toBe(2);
  });

  it("fleets lists every fleet for a person, from /api/state", async () => {
    const lease = doc("lease:side-a", { holder_session_id: "s1", holder_title: "orch A", heartbeat_at: "2026-10-07T14:58:00.000Z", expires_at: "2026-10-07T15:20:00.000Z", acquired_at: "x" });
    handler = (req) => ({
      body: {
        me: { kind: "human", email: "a@b.c", role: "admin", is_admin: true },
        fleets: {
          default: { doc: null, manager: doc("manager", { next_tick: "2026-10-07T15:10:00.000Z" }), lease: null, schedule: sched() },
          "side-a": { doc: doc("side-a", { label: "Side A", id_prefix: "S" }), manager: null, lease, schedule: sched({ inherited: true, version: null }) },
        },
      },
      ...(req.path.startsWith("/agent/api/state") ? {} : { status: 500 }),
    });
    const r = await run(["fleets"]);
    expect(r.code).toBe(0);
    expect(seen[0].path).toBe("/agent/api/state?archived=0");
    expect(r.stdout).toContain("default\n  lease free\n  last tick - · next in 10m · in hours");
    expect(r.stdout).toContain('side-a  "Side A"  ids S1, S2…\n  lease held by orch A (heartbeat 2m ago)');
    expect(r.stdout).toContain("inherited)");
    expect(JSON.parse((await run(["fleets", "--json"])).stdout).fleets).toHaveProperty("side-a");
  });

  it("fleets shows a token its own fleet, labelled from the registry when it may read it", async () => {
    handler = (req) =>
      req.path.startsWith("/agent/api/fleets")
        ? { body: { fleets: [doc("side-a", { label: "Side A" })] } }
        : { body: { me: token("side-a"), manager: null, lease: null, schedule: sched() } };
    const r = await run(["fleets"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^side-a {2}"Side A"/);
    // A server from before the registry: no label.
    handler = (req) =>
      req.path.startsWith("/agent/api/fleets") ? { status: 404, body: { error: "not_found", message: "Not found" } } : { body: { me: token(), manager: null, lease: null, schedule: sched() } };
    expect((await run(["fleets"])).stdout).toMatch(/^default\n/);
  });

  it("--fleet filters items, changes and wait for a person, and a token naming another fleet is refused", async () => {
    handler = (req) => (req.path === "/agent/api/me" ? { body: { kind: "human", email: "a@b.c", role: "admin", is_admin: true } } : { body: { items: [], changes: [], cursor: 5 } });
    expect((await run(["items", "--fleet", "side-a"])).code).toBe(0);
    expect(seen.at(-1)!.path).toBe("/agent/api/items?fleet=side-a");
    expect((await run(["changes", "--since", "1", "--fleet", "side-a"])).code).toBe(0);
    expect(seen.at(-1)!.path).toBe("/agent/api/changes?since=1&fleet=side-a");
    seen = [];
    handler = (req) =>
      req.path === "/agent/api/me"
        ? { body: { kind: "human", email: "a@b.c", role: "admin", is_admin: true } }
        : { body: { changes: [{ seq: 6, collection: "items", doc_id: "i", op: "update", actor: "human:a@b.c", at: "x" }], cursor: 6 } };
    expect((await run(["wait", "--since", "5", "--fleet", "side-a", "--timeout", "30"])).code).toBe(0);
    expect(seen.at(-1)!.path).toContain("fleet=side-a");
    handler = (req) => (req.path === "/agent/api/me" ? { body: token("side-a") } : { body: { items: [] } });
    const refused = await run(["items", "--fleet", "side-b"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe("agent-inbox: this token belongs to fleet side-a, so it sees only that fleet (not side-b)\n");
    expect((await run(["items", "--fleet", "side-a"])).code).toBe(0); // its own: a no-op
    expect((await run(["items", "--fleet", "Bad"])).code).toBe(2);
  });

  it("state --fleet keeps one fleet's items, managers, status, lease and hours", async () => {
    const human = { kind: "human", email: "a@b.c", role: "admin", is_admin: true };
    handler = () => ({
      body: {
        me: human,
        items: [doc("d1", { status: "open", type: "info", title: "D" }), doc("a1", { status: "open", type: "info", title: "A", fleet: "side-a" }), doc("a2", { status: "archived", type: "info", title: "A2", fleet: "side-a" })],
        orchestrators: [doc("O1", { status: "running" }), doc("S1", { status: "running", fleet: "side-a" })],
        manager: doc("manager", { last_tick: "d" }),
        lease: null,
        schedule: sched(),
        cursor: 9,
        archived_total: 1,
        fleets: { "side-a": { doc: null, manager: doc("manager:side-a", { last_tick: "a" }), lease: null, schedule: sched({ inherited: true, version: null }) } },
      },
    });
    const r = JSON.parse((await run(["state", "--fleet", "side-a", "--json"])).stdout);
    expect(r.items.map((d: { id: string }) => d.id)).toEqual(["a1", "a2"]);
    expect(r.orchestrators.map((d: { id: string }) => d.id)).toEqual(["S1"]);
    expect(r.manager.id).toBe("manager:side-a");
    expect(r.schedule.inherited).toBe(true);
    expect(r.archived_total).toBe(1);
    const d = JSON.parse((await run(["state", "--fleet", "default", "--json"])).stdout);
    expect(d.items.map((x: { id: string }) => x.id)).toEqual(["d1"]);
    expect((await run(["state", "--fleet", "side-a"])).stdout).toContain("fleet: side-a");
    expect((await run(["state", "--fleet", "nope"])).code).toBe(1);
  });

  it("state --fleet <own> works for a named fleet's token, from the top-level status it gets", async () => {
    handler = () => ({
      body: { me: token("side-a"), items: [doc("a1", { status: "open", type: "info", title: "A", fleet: "side-a" })], orchestrators: [], manager: doc("manager:side-a", {}), lease: null, schedule: sched(), cursor: 3, archived_total: 0 },
    });
    const r = await run(["state", "--fleet", "side-a"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("fleet: side-a");
    expect(seen.map((x) => x.path)).toEqual(["/agent/api/state"]); // no extra call for a token's own fleet
  });

  it("fleets tells a manager token its fleet's status isn't visible to it, rather than showing it empty", async () => {
    handler = (req) =>
      req.path.startsWith("/agent/api/fleets")
        ? { status: 500, body: { error: "internal", message: "not called" } }
        : { body: { me: { kind: "token", name: "orch-S1", scope: "orchestrator", orchestrator: "S1", fleet: "side-a" }, manager: null, lease: null, schedule: sched() } };
    const r = await run(["fleets"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("side-a\n  lease and status: not visible to a manager token\n  in hours");
    expect(r.stdout).not.toContain("lease free");
    expect(JSON.parse((await run(["fleets", "--json"])).stdout).status_visible).toBe(false);
  });

  it("fleets shows a person the default fleet on a server from before the registry", async () => {
    handler = (req) =>
      req.path.startsWith("/agent/api/fleets")
        ? { status: 404, body: { error: "not_found", message: "Not found" } }
        : { body: { me: { kind: "human", email: "a@b.c", role: "admin", is_admin: true }, manager: null, lease: null, schedule: sched({ version: null }) } };
    const r = await run(["fleets"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^default\n {2}lease free/);
  });

  it("a person's --fleet naming a fleet the server doesn't have exits 1 rather than going unfiltered", async () => {
    handler = (req) =>
      req.path === "/agent/api/me"
        ? { body: { kind: "human", email: "a@b.c", role: "admin", is_admin: true } }
        : req.path.startsWith("/agent/api/fleets/")
          ? { status: 404, body: { error: "not_found", message: "Not found" } }
          : { body: { items: [], changes: [], cursor: 1 } };
    const r = await run(["items", "--fleet", "side-a"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("agent-inbox: no fleet side-a on this server\n");
    expect(seen.some((x) => x.path.startsWith("/agent/api/items"))).toBe(false);
    // The default fleet needs no check: on such a server every item is the default fleet's.
    expect((await run(["items", "--fleet", "default"])).code).toBe(0);
  });

  it("wait --fleet filters its first poll too", async () => {
    handler = (req) =>
      req.path === "/agent/api/me"
        ? { body: { kind: "human", email: "a@b.c", role: "admin", is_admin: true } }
        : { body: { changes: req.path.includes("since=") ? [{ seq: 2, collection: "items", doc_id: "i", op: "update", actor: "human:a@b.c", at: "x" }] : [], cursor: 1 } };
    expect((await run(["wait", "--fleet", "side-a", "--timeout", "30"])).code).toBe(0);
    const polls = seen.filter((x) => x.path.startsWith("/agent/api/changes"));
    expect(polls[0].path).toBe("/agent/api/changes?fleet=side-a");
    expect(polls.every((x) => x.path.includes("fleet=side-a"))).toBe(true);
  });

  it("labels a fleet's inherited hours, and meta set schedule starts a fleet's own from them", async () => {
    handler = () => ({ body: sched({ inherited: true, version: null, inherited_version: 4 }) });
    expect((await run(["schedule"])).stdout).toContain("[inherited: the deployment's hours v4;");
    handler = () => ({ body: sched({ inherited: true, version: null, inherited_version: null }) });
    expect((await run(["schedule"])).stdout).toContain("[inherited: the deployment's hours, not written yet (defaults);");
    handler = () => ({ body: sched({ version: null }) });
    expect((await run(["schedule"])).stdout).toContain("[defaults; meta/schedule not written]");
    // PATCH meets no doc of its own: it reads the hours the fleet has and creates its own with the change.
    handler = (req) =>
      req.method === "PATCH"
        ? { status: 404, body: { error: "not_found", message: "No meta/schedule:side-a" } }
        : req.method === "GET"
          ? { body: sched({ inherited: true, version: null }) }
          : { status: 201, body: doc("schedule:side-a", req.body as Record<string, unknown>) };
    const r = await run(["meta", "set", "schedule", "--set", "pickup_interval_min:=5"]);
    expect(r.code).toBe(0);
    const put = seen.find((x) => x.method === "PUT")!;
    expect(put.path).toBe("/agent/api/meta/schedule");
    expect(put.body).toEqual({ data: { work_hours: "10:00-18:00 Mon-Fri", timezone: "UTC", pickup_interval_min: 5, sweep_interval_min: 30 }, if_version: 0 });
    seen = [];
    await run(["meta", "set", "schedule:side-a", "--set", "pickup_interval_min:=5"]);
    expect(seen.find((x) => x.method === "GET")!.path).toBe("/agent/api/schedule?fleet=side-a");
  });
});
