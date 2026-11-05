import { SEED, expect, openItem, snooze, test } from "./fixtures.ts";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

test("phone: the bottom bar's Submit has the recommendation ready, follows a tap and decides", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const bar = page.getByRole("navigation", { name: "Inbox items" });
  // Pre-selected: the recommended option, ready to submit at once.
  const submit = bar.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true });
  await expect(submit).toBeEnabled();
  await expect(submit).toBeInViewport();
  const box = await submit.boundingBox();
  expect(box && box.y + box.height).toBeGreaterThan(844 - 110); // in the bottom bar, in thumb reach
  await expect(bar.getByText("Then next: " + SEED.ntfyDigest.headline)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Submit/ })).toHaveCount(1); // the form's own Submit is the bar's on a phone

  // Another option changes it; back to the recommendation, and submit.
  await page.getByRole("radio", { name: /Write change rows in the Worker/ }).tap();
  await expect(bar.getByRole("button", { name: "Submit: Write change rows in the Worker", exact: true })).toBeEnabled();
  await page.getByRole("radio", { name: /Keep triggers, filter by actor/ }).tap();

  // Time stands still from here, so the settle window after the advance lasts until the test moves the clock on.
  const t0 = Date.now();
  await page.clock.setFixedTime(t0);
  await submit.tap();
  await expect(page.getByRole("status").filter({ hasText: /^Decided: Keep triggers, filter by actor/ })).toBeVisible();
  await expect(page).toHaveURL(/#item\.p-ntfy-digest$/);
  await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();

  // The next item's recommendation is ready too, but a tap inside the settle window doesn't decide it unseen.
  const next = bar.getByRole("button", { name: "Submit: Approve", exact: true });
  await expect(next).toBeDisabled();
  await next.tap({ force: true });
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/#item\.p-ntfy-digest$/);
  await page.clock.setFixedTime(t0 + 1000);
  await expect(next).toBeEnabled();
});

test("phone: n opens the folded note and goes to it (a keyboard on a phone)", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const note = page.locator("#note-field");
  await expect(page.getByRole("button", { name: /Add a note for/ })).toBeVisible();
  await expect(note).toBeHidden();
  await page.keyboard.press("n");
  await expect(note).toBeVisible();
  await expect(note).toBeFocused();
  await expect(note).toHaveValue("");
});

test("phone: More opens the sheet; ask a question in it", async ({ page }) => {
  await openItem(page, SEED.prReady);
  await expect(page.locator("#qa")).toBeHidden(); // the thread lives in the More sheet on a phone
  await page.getByRole("button", { name: "More for this decision" }).tap();
  const sheet = page.getByRole("dialog", { name: "More for this decision" });
  await expect(sheet).toBeVisible();

  const qa = sheet.locator("#qa");
  await qa.getByRole("button", { name: "Ask a question" }).tap();
  const field = qa.getByRole("textbox", { name: /Your question/ });
  await expect(field).toBeFocused();
  await field.fill("Does this also cover ntfy redeliveries?");
  await qa.getByRole("button", { name: "Send question" }).tap();
  await expect(page.getByRole("status").filter({ hasText: /^Question sent/ })).toBeVisible();
  await expect(qa.getByRole("listitem").filter({ hasText: "Does this also cover ntfy redeliveries?" })).toBeVisible();
  await expect(qa.getByText(/^Waiting for the orchestrator/)).toBeVisible();
  await expect(sheet).toBeVisible(); // the live re-render didn't close it

  await sheet.getByRole("button", { name: "Close" }).tap();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("heading", { level: 2, name: SEED.prReady.title })).toBeVisible();
});

test("phone: snooze from the sheet moves on to the next item and closes it", async ({ page }) => {
  await openItem(page, SEED.changelog);
  await page.getByRole("button", { name: "More for this decision" }).tap();
  const sheet = page.getByRole("dialog", { name: "More for this decision" });
  await snooze(page, "1 hour");
  await expect(page.locator("#toast")).toContainText("Snoozed until");
  await expect(page).toHaveURL(/#item\.p-ntfy-digest$/);
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();
});

test("phone: Esc closes the sheet and stays on the item", async ({ page }) => {
  await openItem(page, SEED.ntfyDigest);
  // The answered line opens the sheet at the thread.
  await page.getByRole("button", { name: /Orchestrator answered your question/ }).tap();
  const sheet = page.getByRole("dialog", { name: "More for this decision" });
  await expect(sheet.locator("#qa").getByText(/quiet days stay silent/)).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/#item\.p-ntfy-digest$/);
  await expect(page.getByRole("button", { name: /Orchestrator answered your question/ })).toBeFocused(); // back to what opened it
  // More, opened by a tap, gets focus back on close too.
  await page.getByRole("button", { name: "More for this decision" }).tap();
  await sheet.getByRole("button", { name: "Close" }).tap();
  await expect(page.getByRole("button", { name: "More for this decision" })).toBeFocused();
  await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();
});

test("phone: a snooze that fails says so inside the sheet", async ({ page }) => {
  await openItem(page, SEED.changelog);
  await page.route("**/api/items/*/snooze", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await page.getByRole("button", { name: "More for this decision" }).tap();
  const sheet = page.getByRole("dialog", { name: "More for this decision" });
  await snooze(page, "1 hour");
  await expect(sheet.getByText("Couldn't save the snooze. Try again.")).toBeVisible();
  await expect(page).toHaveURL(/#item\.O3-changelog-approach$/);
});

test("phone: signing out closes the sheet and clears what it showed", async ({ page }) => {
  await openItem(page, SEED.prReady);
  await page.getByRole("button", { name: "More for this decision" }).tap();
  const sheet = page.getByRole("dialog", { name: "More for this decision" });
  await sheet.getByRole("button", { name: "Ask a question" }).tap();
  await sheet.getByRole("textbox", { name: /Your question/ }).fill("Still there?");
  // The Access session is gone: the next API call answers 401.
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
  await sheet.getByRole("button", { name: "Send question" }).tap();
  await expect(page.locator("#toast")).toContainText("Signed out");
  await expect(sheet).toBeHidden();
  await expect(page.locator("#more-body")).toBeEmpty();
});
