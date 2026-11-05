import { SEED, expect, inboxRow, openInbox, openItem, snooze, test } from "./fixtures.ts";

test("snoozing an item hides it from your inbox until you unsnooze it, across reloads", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const versionBefore = await page.evaluate(async (id) => (await (await fetch("/api/items/" + encodeURIComponent(id))).json()).version, SEED.changelog.id);
  await snooze(page, "1 hour");
  await expect(page.locator("#toast")).toContainText("Snoozed until");

  await openInbox(page); // a reload: the snooze comes back from the server
  await expect(inboxRow(page, SEED.changelog.headline)).toHaveCount(0);
  await expect(page.locator("#count-inbox")).toHaveText("4");
  const group = page.locator("#snoozed-group");
  await expect(group.locator("summary")).toHaveText(/Snoozed\s+1/);
  // The item itself didn't change: links and pages pinned on its version still decide.
  const versionAfter = await page.evaluate(async (id) => (await (await fetch("/api/items/" + encodeURIComponent(id))).json()).version, SEED.changelog.id);
  expect(versionAfter).toBe(versionBefore);

  await openItem(page, SEED.changelog);
  await expect(page.getByText(/Snoozed for you until/)).toBeVisible();

  await openInbox(page);
  await group.locator("summary").click();
  await group.getByRole("button", { name: /Unsnooze/ }).click();
  await expect(inboxRow(page, SEED.changelog.headline)).toBeVisible();
  await expect(page.locator("#count-inbox")).toHaveText("5");
  await expect(group).toHaveCount(0);
});
