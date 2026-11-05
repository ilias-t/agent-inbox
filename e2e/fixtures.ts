// The suite's `test`: every test starts from the seed data, against the server global setup started.
// The page loads nothing from other origins (its CSP allows only 'self'; fonts are bundled).

import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { resetData, serverEnv } from "./support/data.ts";

export { expect };

export const test = base.extend<{ seeded: void }>({
  baseURL: async ({}, use) => { await use(serverEnv().baseURL); },
  seeded: [async ({}, use) => { await resetData(); await use(); }, { auto: true }],
});

// Seed items in the inbox's triage order: high (oldest first), normal, low, then FYI.
export const SEED = {
  stagingToken: { id: "O2-blocked-staging-token", headline: "Can you renew the `e2e-staging` service token and update the CI secret?", title: "Staging Access service token expired" },
  changelog: { id: "O3-changelog-approach", headline: "Which change-log approach should O3 implement?", title: "Change log: keep D1 triggers or write rows in the Worker?" },
  ntfyDigest: { id: "p-ntfy-digest", headline: "Start an orchestrator on the end-of-day digest?", title: "Send a daily ntfy digest at 17:45 ET" },
  prReady: { id: "O1-pr-ready", headline: "PR #12: dedupe webhook redeliveries is ready for review", title: "PR #12: dedupe webhook redeliveries is ready for review" },
  d1Usage: { id: "i-d1-usage", headline: "D1 usage this week: 0.4% of the free read quota", title: "D1 usage this week: 0.4% of the free read quota" },
  retryBudget: { id: "O2-retry-budget", headline: "Raised the e2e retry budget from 1 to 2 while the flake fix lands", title: "Raised the e2e retry budget from 1 to 2 while the flake fix lands" },
} as const;

export const itemHash = (id: string) => "#item." + encodeURIComponent(id);

// An index row is a link whose name runs badge + headline + chips + time, so match on the headline.
export function inboxRow(page: Page, headline: string) {
  return page.locator("#view-inbox").getByRole("link", { name: headline });
}

// The main nav: Inbox, Team, Focus, History, Settings. Links with aria-current="page" on where you are. A bottom bar
// on phones (Focus and Settings shown there only), in the top bar from 700px.
export function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

// Opens the inbox and waits for the live data (not the loading skeleton).
export async function openInbox(page: Page): Promise<void> {
  await page.goto("/#inbox");
  await expect(page.locator("#inbox-list a.row").first()).toBeVisible();
}

// Phones open on the top ask, once per session (src/lib/landing.ts). A phone test that wants the queue itself marks
// this session's landing as done (on every load of the page, reloads too), then opens the Inbox.
export async function openQueue(page: Page): Promise<void> {
  await page.addInitScript(() => { try { sessionStorage.setItem("agent-inbox-landed", "1"); } catch { /* no storage */ } });
  await openInbox(page);
}

// Archives every open item but `keep`, with the manager token.
export async function archiveOpen(request: APIRequestContext, keep: string[] = []): Promise<void> {
  const auth = { Authorization: "Bearer " + serverEnv().token };
  const r = await request.get("/agent/api/items?status=open", { headers: auth });
  expect(r.status(), await r.text()).toBe(200);
  for (const d of (await r.json()).items as { id: string }[]) {
    if (keep.includes(d.id)) continue;
    const a = await request.post("/agent/api/items/" + encodeURIComponent(d.id) + "/archive", { headers: auth, data: {} });
    expect(a.status(), await a.text()).toBe(200);
  }
}

// Opens an item page and waits for its heading.
export async function openItem(page: Page, item: { id: string; title: string }): Promise<void> {
  await page.goto("/" + itemHash(item.id));
  await expect(page.getByRole("heading", { level: 2, name: item.title })).toBeVisible();
}

// Snoozes the open item until a preset ("1 hour", "Tomorrow 9 am", …). From 1100px the presets are on the page;
// below it they're behind "Snooze…" (in the More sheet on phones and mid widths, which the caller opens).
export async function snooze(page: Page, label: string): Promise<void> {
  const toggle = page.getByRole("button", { name: /Snooze…/ });
  if (await toggle.isVisible()) await toggle.click();
  await page.locator("#snooze-menu").getByRole("button", { name: new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
}
