// A review routine for the Reviews tab's tests: the synthetic review-bot runs (test/fixtures/review-ui.ts, times
// relative to now) stored through `agent-inbox reviews report` with the routine's own token, as its runner does.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { ReviewReportPayload } from "../../shared/types.ts";
import { uiOlderPayloads, uiPayloads } from "../../test/fixtures/review-ui.ts";
import { PERSIST_TO, ROOT, executeSql, serverEnv } from "./data.ts";

const exec = promisify(execFile);

// Stores one run, as the runner's `agent-inbox reviews report --file payload.json` (any config on this machine ignored).
// `dry`: as the review-bot-dry routine, with its own token.
export async function reportRun(payload: ReviewReportPayload, dry = false): Promise<void> {
  const file = resolve(PERSIST_TO, "review-" + payload.stamp + ".json"), token = dry ? process.env.E2E_DRY_TOKEN : process.env.E2E_ROUTINE_TOKEN;
  if (!token) throw new Error("e2e: E2E_ROUTINE_TOKEN unset; run the suite with `npm run e2e`");
  writeFileSync(file, JSON.stringify(payload));
  await exec(process.execPath, [resolve(ROOT, "bin/agent-inbox.mjs"), "reviews", "report", "--file", file, "--url", serverEnv().baseURL + "/agent", "--token", token], {
    cwd: ROOT, env: { ...process.env, AGENT_INBOX_CONFIG: resolve(PERSIST_TO, "no-cli-config.json"), AGENT_INBOX_URL: "", AGENT_INBOX_TOKEN: "" },
  });
}

// Any `agent-inbox` command as the review-bot routine, with its own token (the poller's calls); its stdout.
export async function routineCli(args: string[]): Promise<string> {
  const token = process.env.E2E_ROUTINE_TOKEN;
  if (!token) throw new Error("e2e: E2E_ROUTINE_TOKEN unset; run the suite with `npm run e2e`");
  const { stdout } = await exec(process.execPath, [resolve(ROOT, "bin/agent-inbox.mjs"), ...args, "--url", serverEnv().baseURL + "/agent", "--token", token], {
    cwd: ROOT, env: { ...process.env, AGENT_INBOX_CONFIG: resolve(PERSIST_TO, "no-cli-config.json"), AGENT_INBOX_URL: "", AGENT_INBOX_TOKEN: "" },
  });
  return stdout;
}

// The four runs, oldest first, so the newest report decides every PR's state. `older`: that many earlier runs first.
export async function seedReviews(now = Date.now(), opts: { older?: number; dry?: boolean } = {}): Promise<void> {
  for (const p of [...uiOlderPayloads(now, opts.older ?? 0), ...uiPayloads(now)]) await reportRun(p, opts.dry);
}

// #795 dropped out of the reports 9 days ago: GET /api/reviews/:routine no longer lists it (it keeps 7 days), its own
// endpoint still has it.
export async function ageGonePr(): Promise<void> {
  await executeSql("gone.sql", "UPDATE review_prs SET gone_at = '" + new Date(Date.now() - 9 * 86400000).toISOString() + "' WHERE number = 795;\n", "ageing a gone PR");
}

// An ask the runner would post for a held PR: item <routine>-<pr>-<hold>, the routine's own (here with the manager token).
export async function postAsk(request: APIRequestContext, id: string, pr: number): Promise<void> {
  const r = await request.put("/agent/api/items/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + serverEnv().token },
    data: { if_version: 0, data: {
      type: "decision", title: "#" + pr + ": fail with 413, or truncate?", question: "Should oversized uploads fail with 413, or be truncated to the limit?",
      orchestrator: "review-bot", source: "review-bot", close_on_pr: true, review_pr: { routine: "review-bot", number: pr },
      options: [{ id: "fail", label: "Fail with 413" }, { id: "truncate", label: "Truncate and warn" }],
    } },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

// Content-Security-Policy violations, console errors and uncaught exceptions while the test runs.
export async function watchPage(page: Page): Promise<{ problems: () => Promise<string[]> }> {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(e.effectiveDirective + " " + (e.blockedURI || "inline")));
  });
  return { problems: async () => [...errors, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))] };
}
