// Inbox rows: the meta line (who an item is assigned to) and the FYI row's own Looks good / Override….
import { SEED, expect, inboxRow, itemHash, mainNav, openInbox, test } from "./fixtures.ts";

test("a row assigned to you says You, and the Mine filter appears", async ({ page }) => {
  await openInbox(page);
  const row = inboxRow(page, SEED.changelog.headline);
  await expect(row).not.toContainText("You");
  await expect(page.locator("#inbox-filter")).toBeHidden(); // nobody assigned, no People: a one-person inbox
  // Reassigning is a decider's PATCH of `assignee` (docs/api.md); the page picks it up live.
  const status = await page.evaluate(async (id) => (await fetch("/api/items/" + encodeURIComponent(id), {
    method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ data: { assignee: "dev@localhost" } }),
  })).status, SEED.changelog.id);
  expect(status).toBe(200);
  await expect(row).toContainText("You", { timeout: 10_000 });
  await page.locator("#inbox-filter").getByRole("radio", { name: /^Mine/ }).click();
  await expect(page.locator("#inbox-list a.row")).toHaveCount(1);
  await expect(page.locator("#inbox-list a.row")).toHaveAttribute("href", itemHash(SEED.changelog.id));
});

test("Looks good on an FYI row archives it without leaving the inbox", async ({ page }) => {
  await openInbox(page);
  await expect(page.getByText(/^FYI · decided for you\s+1$/)).toBeVisible();
  await page.locator("#view-inbox").getByRole("button", { name: /^Looks good/ }).click();

  await expect(page.getByRole("status").filter({ hasText: "Archived: looks good" })).toBeVisible();
  await expect(page).toHaveURL(/#inbox$/);
  await expect(inboxRow(page, SEED.retryBudget.headline)).toHaveCount(0);
  await expect(page.getByText(/^FYI · decided for you/)).toHaveCount(0);
  await expect(page.locator("#count-inbox")).toHaveText("5"); // the asks are all still there
  await mainNav(page).getByRole("link", { name: /History/ }).click();
  await expect(page.locator("#view-history").getByRole("link", { name: SEED.retryBudget.headline })).toContainText("Accepted");
});

test("Looks good pressed from the keyboard leaves focus on a row, not the page", async ({ page }) => {
  await openInbox(page);
  const ok = page.locator("#view-inbox").getByRole("button", { name: /^Looks good/ });
  await ok.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Archived: looks good" })).toBeVisible();
  await expect(inboxRow(page, SEED.retryBudget.headline)).toHaveCount(0);
  // The FYI row was the last one: focus goes to the row before it.
  await expect(inboxRow(page, SEED.d1Usage.headline)).toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();
});

test("with the Snoozed group collapsed, focus after Looks good skips its hidden rows", async ({ page }) => {
  await openInbox(page);
  // Snooze the Low row: the collapsed Snoozed group (after FYI) now holds the only row below the FYI one.
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const status = await page.evaluate(async ([id, until]) => (await fetch("/api/items/" + encodeURIComponent(id) + "/snooze", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ until }),
  })).status, [SEED.d1Usage.id, until]);
  expect(status).toBe(200);
  await expect(page.locator("#snoozed-group")).toBeAttached({ timeout: 10_000 });
  await expect(page.locator("#snoozed-group")).not.toHaveAttribute("open", "");
  const ok = page.locator("#view-inbox").getByRole("button", { name: /^Looks good/ });
  await ok.focus();
  await page.keyboard.press("Enter");
  await expect(inboxRow(page, SEED.retryBudget.headline)).toHaveCount(0);
  await expect(inboxRow(page, SEED.prReady.headline)).toBeFocused();
});

test("Override… on an FYI row opens the item with the override note open", async ({ page }) => {
  await openInbox(page);
  await page.locator("#view-inbox").getByRole("button", { name: /^Override/ }).click();
  await expect(page).toHaveURL(new RegExp(itemHash(SEED.retryBudget.id).replace(/\./g, "\\.") + "$"));
  await expect(page.locator("#ovr-btn")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#ovr-box")).toBeVisible();
  await expect(page.getByRole("button", { name: "Write a note to override" })).toBeDisabled();
});
