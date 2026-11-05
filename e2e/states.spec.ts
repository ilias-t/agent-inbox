// The app's states beside the core loop: offline (the banner, the manager status paused, Run tick now waiting), a
// decision that conflicts (409), an Inbox with nothing left that needs you, and History's day headers.
import type { Page } from "@playwright/test";
import { SEED, archiveOpen, expect, openInbox, openItem, test } from "./fixtures.ts";
import { seedArchived, serverEnv } from "./support/data.ts";

const auth = () => ({ Authorization: "Bearer " + serverEnv().token });

// Snoozes an item for the signed-in human for an hour, through the page's own API.
async function snoozeHour(page: Page, id: string): Promise<void> {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const status = await page.evaluate(async ({ id, until }) => (await fetch("/api/items/" + encodeURIComponent(id) + "/snooze", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ until }),
  })).status, { id, until });
  expect(status).toBe(200);
}

test("offline: the banner says when the inbox shown is from, the manager status pauses and Run tick now waits, until back online", async ({ page, context }) => {
  await openInbox(page);
  await page.locator("#hstatus > summary").click();
  const tick = page.getByRole("button", { name: "Run tick now" });
  await expect(tick).toBeEnabled();
  const banner = page.locator("#offline");
  await expect(banner).toBeHidden();

  await context.setOffline(true);
  await expect(banner).toBeVisible();
  const text = /^Offline\. Showing the inbox from \d{2}:\d{2}\.$/;
  await expect(page.locator("#offline-text")).toHaveText(text);
  await expect(page.locator("#sr-status")).toHaveText(text); // announced there: the banner isn't a live region
  await expect(page.locator("#tick-text")).toHaveText("Orchestrator status paused");
  await expect(tick).toBeDisabled();
  await expect(page.locator("#inbox-list a.row").first()).toBeVisible(); // what was loaded stays
  // Try again retries the connection; still offline, the banner stays.
  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(banner).toBeVisible();
  await expect(tick).toBeDisabled();

  await context.setOffline(false);
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#sr-status")).toHaveText("Back online.");
  await expect(page.locator("#tick-text")).not.toHaveText("Orchestrator status paused");
  await expect(tick).toBeEnabled();
});

test("a decision that conflicts (409) says so once, as an alert, clearing the choice and keeping the note", async ({ page, request }) => {
  await openItem(page, SEED.changelog);
  const keep = page.getByRole("radio", { name: /Keep triggers, filter by actor/ });
  await expect(keep).toHaveAttribute("aria-checked", "true");
  // Live updates held: the page keeps the version it opened while the orchestrator rewrites the item.
  await page.route("**/api/changes**", () => { /* never answered */ });
  await page.route("**/api/state/delta**", () => { /* never answered */ });
  const patch = await request.patch("/agent/api/items/" + SEED.changelog.id, { headers: auth(), data: { data: { title: "Change log: keep D1 triggers, filtered by actor?" } } });
  expect(patch.status(), await patch.text()).toBe(200);

  const note = page.locator("#note-field");
  await note.fill("Ship it today; the backfill check can follow.");
  await page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true }).click();

  const status = page.locator("#decide-status");
  const msg = "This item changed since you opened it — review and decide again.";
  await expect(status).toHaveText(msg);
  await expect(status).toHaveAttribute("role", "alert");
  // Announced by the alert only: not through #sr-status, and the toast that shows it too stays quiet.
  await expect(page.locator("#sr-status")).not.toHaveText(msg);
  await expect(page.locator("#toast")).toHaveText(msg);
  await expect(page.locator("#toast")).toHaveAttribute("aria-live", "off");
  // The updated item shows; the choice is cleared (not pre-selected again), the note is kept.
  await expect(page.getByRole("heading", { level: 2, name: "Change log: keep D1 triggers, filtered by actor?" })).toBeVisible();
  await expect(keep).toHaveAttribute("aria-checked", "false");
  await expect(note).toHaveValue("Ship it today; the backfill check can follow.");
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
  // Choosing again ends the alert: what the line says next is announced once, not as an alert too.
  await keep.click();
  await expect(status).not.toHaveAttribute("role", "alert");
  await expect(status).toHaveText("");
});

test("Inbox clear offers the snoozed items and what was decided", async ({ page, request }) => {
  await openInbox(page);
  await snoozeHour(page, SEED.changelog.id); // snoozed first: only an open item can be
  await archiveOpen(request, [SEED.changelog.id]);
  await page.goto("/#inbox");
  const list = page.locator("#inbox-list");
  await expect(list.getByText("Inbox clear.")).toBeVisible();
  await expect(list).toContainText(/One snoozed item wakes (today|tomorrow|\w{3}) \d{2}:\d{2}/);

  const group = page.locator("#snoozed-group");
  await expect(group).toHaveJSProperty("open", false);
  const show = list.getByRole("button", { name: "Show snoozed" });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await show.click();
  await expect(group).toHaveJSProperty("open", true);
  await expect(show).toHaveAttribute("aria-expanded", "true");
  const row = group.getByRole("link", { name: SEED.changelog.headline });
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();

  await list.getByRole("link", { name: "See what was decided" }).click();
  await expect(page).toHaveURL(/#history$/);
  await expect(page.locator("#history-list a.row").first()).toBeVisible();
});

test("with nothing snoozed, Inbox clear only offers what was decided", async ({ page, request }) => {
  await archiveOpen(request);
  await page.goto("/#inbox");
  const list = page.locator("#inbox-list");
  await expect(list.getByText("Inbox clear.")).toBeVisible();
  await expect(list.getByRole("button", { name: "Show snoozed" })).toHaveCount(0);
  await expect(list.getByRole("link", { name: "See what was decided" })).toBeVisible();
});

test("History heads its rows by day, and Load older appends without heading a day twice", async ({ page }) => {
  await seedArchived(120); // a day and more ago, an hour apart
  await page.goto("/#history");
  const list = page.locator("#history-list");
  await expect(list.locator("a.row").first()).toBeVisible();
  // Headers are headings, not rows; the seed's own decisions are from today.
  await expect(list.getByRole("heading", { level: 3, name: "Today" })).toBeVisible();
  const before = await list.locator("h3.ghead.day").allTextContents();
  // The last row shown gets a marker: if Load older rebuilt the list, its node (and the marker) would be gone.
  const lastDay = await list.evaluate((l) => {
    const rows = l.querySelectorAll<HTMLElement>("a.row"), last = rows[rows.length - 1];
    last.dataset.e2eKept = "1";
    return last.querySelector(".clk")!.getAttribute("title")!.replace(/, .*$/, ""); // "Mon 5 Oct 2026"
  });
  await page.getByRole("button", { name: /Load older/ }).click();
  await expect(page.getByRole("button", { name: /Load older/ })).toHaveCount(0);
  await expect(list.locator("a.row[data-e2e-kept]")).toHaveCount(1); // appended, not rebuilt

  const after = await list.locator("h3.ghead.day").allTextContents();
  expect(after.length).toBeGreaterThanOrEqual(before.length);
  expect(new Set(after).size).toBe(after.length); // no day headed twice, across the append
  expect(after.slice(0, before.length)).toEqual(before);
  // At the page edge: the first appended row continues the last shown one's day under its header (none between them),
  // or starts a new day with exactly one header.
  const edge = await list.evaluate((l) => {
    const kept = l.querySelector("a.row[data-e2e-kept]")!.closest(".rowwrap")!;
    const between: string[] = [];
    let el = kept.nextElementSibling;
    while (el && !el.querySelector("a.row")) { if (el.matches("h3")) between.push(el.textContent || ""); el = el.nextElementSibling; }
    return { between, next: el?.querySelector(".clk")?.getAttribute("title")?.replace(/, .*$/, "") ?? null };
  });
  expect(edge.next).not.toBeNull();
  expect(edge.between).toHaveLength(edge.next === lastDay ? 0 : 1);
});

test("past midnight in the schedule's zone, History's Today becomes Yesterday without a reload", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await page.goto("/#history");
  const list = page.locator("#history-list");
  await expect(list.locator("a.row").first()).toBeVisible();
  const before = await list.locator("h3.ghead.day").allTextContents();
  // A day later (the page's clock only): the minute timer sees the new day and rebuilds the labels.
  await page.clock.setSystemTime(Date.now() + 86400_000);
  await page.clock.fastForward(61_000);
  await expect(list.getByRole("heading", { level: 3, name: "Today" })).toHaveCount(0);
  const after = await list.locator("h3.ghead.day").allTextContents();
  expect(after).toHaveLength(before.length);
  if (before[0] === "Today") expect(after[0]).toBe("Yesterday");
});
