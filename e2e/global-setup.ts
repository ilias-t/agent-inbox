// Builds the UI, creates a fresh local D1 in .wrangler/e2e (migrations + a manager token), and
// starts `wrangler dev` on free ports with wrangler.test.jsonc and e2e/dev.env (DEV_NO_ACCESS=1)
// instead of the developer's wrangler.jsonc and .dev.vars. Returns the teardown, which stops the server. Each test reseeds the data
// itself (e2e/fixtures.ts).

import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { PERSIST_TO, QUIET_ENV, ROOT, SERVER_LOG, WRANGLER, WRANGLER_CONFIG, run } from "./support/data.ts";

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

function logTail(): string {
  try { return readFileSync(SERVER_LOG, "utf8").split("\n").slice(-40).join("\n"); } catch { return "(no server log)"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalSetup(): Promise<() => Promise<void>> {
  const t0 = Date.now();
  rmSync(PERSIST_TO, { recursive: true, force: true });
  mkdirSync(PERSIST_TO, { recursive: true });

  if (!process.env.E2E_SKIP_BUILD) run("npm", ["run", "build"], "npm run build");
  // The suite's own D1, through the committed test config (never the developer's wrangler.jsonc).
  const local = ["--local", "--persist-to", PERSIST_TO, "--config", WRANGLER_CONFIG];
  run(WRANGLER, ["d1", "migrations", "apply", "agent-inbox", ...local], "applying D1 migrations");
  const token = run("node", ["scripts/create-token.mjs", "--name", "e2e", "--scope", "manager", ...local], "create-token").trim();
  if (!/^ait_/.test(token)) throw new Error("e2e: create-token printed no token: " + token);
  // The review-bot routine's own token, for storing review runs with the CLI (e2e/support/reviews.ts).
  const routineToken = run("node", ["scripts/create-token.mjs", "--name", "orch-review-bot", "--scope", "orchestrator", "--orchestrator", "review-bot", ...local], "create-token (routine)").trim();
  if (!/^ait_/.test(routineToken)) throw new Error("e2e: create-token printed no routine token: " + routineToken);
  // A second routine, as dry runs report to their own (review-bot-dry).
  const dryToken = run("node", ["scripts/create-token.mjs", "--name", "orch-review-bot-dry", "--scope", "orchestrator", "--orchestrator", "review-bot-dry", ...local], "create-token (dry routine)").trim();
  if (!/^ait_/.test(dryToken)) throw new Error("e2e: create-token printed no dry routine token: " + dryToken);

  const port = await freePort(), inspector = await freePort();
  const out = openSync(SERVER_LOG, "a");
  const server = spawn(WRANGLER, [
    "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector),
    "--persist-to", PERSIST_TO, "--config", WRANGLER_CONFIG, "--env-file", resolve(ROOT, "e2e/dev.env"), "--show-interactive-dev-session=false",
  ], { cwd: ROOT, env: QUIET_ENV, stdio: ["ignore", out, out], detached: true }); // own process group: teardown stops workerd too
  let exited: number | null | undefined;
  server.on("exit", (code) => { exited = code; });

  const stop = async () => {
    if (exited !== undefined || !server.pid) return;
    try { process.kill(-server.pid, "SIGTERM"); } catch { return; }
    for (let i = 0; i < 50 && exited === undefined; i++) await sleep(100);
    if (exited === undefined) { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } }
  };

  const baseURL = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited !== undefined) throw new Error("e2e: wrangler dev exited (" + exited + ") before it was ready\n" + logTail());
    try {
      const r = await fetch(baseURL + "/api/state");
      if (r.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { await stop(); throw new Error("e2e: wrangler dev wasn't ready within 60 s\n" + logTail()); }
    await sleep(200);
  }

  process.env.E2E_BASE_URL = baseURL;
  process.env.E2E_TOKEN = token;
  process.env.E2E_ROUTINE_TOKEN = routineToken;
  process.env.E2E_DRY_TOKEN = dryToken;
  console.log("e2e: wrangler dev on " + baseURL + " (setup " + ((Date.now() - t0) / 1000).toFixed(1) + " s, log " + SERVER_LOG + ")");
  return stop;
}
