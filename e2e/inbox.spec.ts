import { SEED, expect, inboxRow, itemHash, mainNav, openInbox, test } from "./fixtures.ts";

test("inbox renders the priority groups, FYI and counts", async ({ page }) => {
  await openInbox(page);
  const list = page.locator("#inbox-list");
  await expect(mainNav(page).getByRole("link", { name: /Inbox/ })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#count-inbox")).toHaveText("5"); // asks only; the FYI item isn't counted
  for (const group of [/^High\s+2$/, /^Normal\s+2$/, /^Low\s+1$/, /^FYI · decided for you\s+1$/]) {
    await expect(list.getByText(group)).toBeVisible();
  }
  // Triage order: high (oldest first), normal, low, then FYI.
  const rows = list.getByRole("link");
  await expect(rows).toHaveCount(6);
  const order = [SEED.stagingToken, SEED.changelog, SEED.ntfyDigest, SEED.prReady, SEED.d1Usage, SEED.retryBudget];
  for (const [i, item] of order.entries()) await expect(rows.nth(i)).toHaveAttribute("href", itemHash(item.id));
});

test("opening a row shows the item's briefing", async ({ page }) => {
  await openInbox(page);
  await inboxRow(page, SEED.changelog.headline).click();
  await expect(page).toHaveURL(new RegExp(itemHash(SEED.changelog.id).replace(/\./g, "\\.") + "$"));
  await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
  await expect(page.getByRole("article").getByText(SEED.changelog.headline)).toBeVisible(); // The question
  const options = page.getByRole("radiogroup", { name: "Options" });
  await expect(options.getByRole("radio")).toHaveCount(3); // its two options and Other…
  // The recommendation comes pre-selected, so Submit is ready at once.
  await expect(options.getByRole("radio", { name: /Keep triggers, filter by actor/ })).toHaveAttribute("aria-checked", "true");
  await expect(options.getByRole("radio", { name: /Write change rows in the Worker/ })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true })).toBeEnabled();
  await expect(mainNav(page).getByRole("link", { name: /Inbox/ })).toHaveAttribute("href", "#inbox");
});

test("j/k move between rows, Enter opens one, u returns focus to it", async ({ page }) => {
  await openInbox(page);
  const first = inboxRow(page, SEED.stagingToken.headline), second = inboxRow(page, SEED.changelog.headline);
  await page.keyboard.press("j");
  await expect(first).toBeFocused();
  await page.keyboard.press("j");
  await expect(second).toBeFocused();
  await page.keyboard.press("k");
  await expect(first).toBeFocused();
  await page.keyboard.press("j");
  await expect(second).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeFocused();
  await expect(page).toHaveURL(/#item\.O3-changelog-approach$/);

  await page.keyboard.press("u");
  await expect(page).toHaveURL(/#inbox$/);
  await expect(second).toBeFocused();
  await page.keyboard.press("j"); // and j/k carry on from there
  await expect(inboxRow(page, SEED.ntfyDigest.headline)).toBeFocused();
});
