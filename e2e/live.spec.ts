import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { SEED, expect, inboxRow, openInbox, test } from "./fixtures.ts";
import { ROOT, serverEnv } from "./support/data.ts";

const run = promisify(execFile);

// The CLI against the e2e server with its manager token, ignoring any config on this machine.
async function cli(args: string[]): Promise<string> {
  const { baseURL, token } = serverEnv();
  const { stdout } = await run(process.execPath, [resolve(ROOT, "bin/agent-inbox.mjs"), ...args, "--url", baseURL + "/agent", "--token", token], {
    cwd: ROOT, env: { ...process.env, AGENT_INBOX_CONFIG: resolve(ROOT, ".wrangler/e2e/no-cli-config.json"), AGENT_INBOX_URL: "", AGENT_INBOX_TOKEN: "" },
  });
  return stdout;
}

test("an item posted with the CLI and a token shows up live in an open inbox", async ({ page }) => {
  await openInbox(page);
  await expect(page.locator("#count-inbox")).toHaveText("5");
  await page.evaluate(() => { (window as unknown as { e2eMarker: number }).e2eMarker = 1; });
  const stateCalls: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/state")) stateCalls.push(u.pathname); });

  const { baseURL, token } = serverEnv();
  await run(process.execPath, [
    resolve(ROOT, "bin/agent-inbox.mjs"), "post", "e2e-live-cli", "--type", "decision", "--title", "Ship the e2e suite?",
    "--option", "yes:Ship it", "--option", "no:Not yet", "--priority", "high",
    "--url", baseURL + "/agent", "--token", token, "--json",
  ], { cwd: ROOT, env: { ...process.env, AGENT_INBOX_CONFIG: resolve(ROOT, ".wrangler/e2e/no-cli-config.json"), AGENT_INBOX_URL: "", AGENT_INBOX_TOKEN: "" } });

  // The change feed (long-polled /api/changes) brings it in without a reload.
  const row = inboxRow(page, "Ship the e2e suite?");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#count-inbox")).toHaveText("6");
  await expect(page.getByText(/^High\s+3$/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { e2eMarker?: number }).e2eMarker)).toBe(1); // same page, no reload
  // What changed came as a delta, not the whole state again.
  expect(stateCalls.length).toBeGreaterThan(0);
  expect(stateCalls.every((p) => p === "/api/state/delta")).toBe(true);
});

test("an item withdrawn with the CLI leaves the open inbox live, and History and its page say Withdrawn", async ({ page }) => {
  const { id, headline, title } = SEED.changelog;
  await openInbox(page);
  await expect(inboxRow(page, headline)).toBeVisible();
  await expect(page.locator("#count-inbox")).toHaveText("5");

  const { item } = JSON.parse(await cli(["show", id, "--json"]));
  await cli(["withdraw", id, "--if-version", String(item.version), "--note", "Settled in the PR review", "--json"]);
  await expect(inboxRow(page, headline)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("#count-inbox")).toHaveText("4");

  await page.goto("/#history");
  const row = page.locator("#history-list").getByRole("link", { name: headline });
  await expect(row).toContainText("Withdrawn");
  await expect(row).toContainText("Settled in the PR review");
  await expect(row).not.toContainText("Decided");

  await row.click();
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  const verdict = page.locator(".panel.verdict");
  await expect(verdict.locator(".vhead")).toHaveText("Withdrawn");
  await expect(verdict).toContainText("Settled in the PR review");
  await expect(page.locator("#timeline")).toContainText("Withdrawn");
  await expect(page.locator("#timeline")).not.toContainText("Decided");
});
