import type { Page } from "@playwright/test";
import { SEED, expect, inboxRow, mainNav, openItem, test } from "./fixtures.ts";
import { serverEnv } from "./support/data.ts";

test("submitting a choice toasts, advances to the next item and drops it from the inbox", async ({ page }) => {
  await openItem(page, SEED.changelog);
  await page.getByRole("radio", { name: /Keep triggers, filter by actor/ }).click();
  const submit = page.getByRole("button", { name: "Submit: Keep triggers, filter by actor" });
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByRole("status").filter({ hasText: /^Decided: Keep triggers, filter by actor/ })).toBeVisible();
  // Auto-advance: the next item in triage order after the one decided.
  await expect(page).toHaveURL(/#item\.p-ntfy-digest$/);
  await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();

  await mainNav(page).getByRole("link", { name: /Inbox/ }).click();
  await expect(page.locator("#count-inbox")).toHaveText("4");
  await expect(inboxRow(page, SEED.changelog.headline)).toHaveCount(0);
  await mainNav(page).getByRole("link", { name: /History/ }).click();
  await expect(page.locator("#view-history").getByRole("link", { name: SEED.changelog.headline })).toContainText("Keep triggers, filter by actor");
});

// On a desktop, and on a phone, where the note opens on its own for Other… and the bottom bar holds Submit.
async function otherNeedsANote(page: Page): Promise<void> {
  await openItem(page, SEED.stagingToken);
  await page.getByRole("radio", { name: /^Other…/ }).click();
  const note = page.getByRole("textbox", { name: /^Note/ });
  await expect(note).toBeFocused();
  await expect(page.getByText("required for Other")).toBeVisible();
  const submit = page.getByRole("button", { name: "Submit: Other", exact: true });
  await expect(submit).toBeDisabled();
  await expect(page.getByText("Write a note to send Other.")).toBeVisible();

  await note.fill("Rotate it to a 90-day token instead.");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("status").filter({ hasText: /^Decided: Other/ })).toBeVisible();
  await expect(page).toHaveURL(/#item\.O3-changelog-approach$/);
}

test("Other… needs a note before it can be sent", async ({ page }) => { await otherNeedsANote(page); });

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  test("Other… needs a note before it can be sent, from the bottom bar", async ({ page }) => { await otherNeedsANote(page); });
});

test("Looks good on an auto-decided item archives it", async ({ page }) => {
  await openItem(page, SEED.retryBudget);
  await expect(page.getByRole("article").getByText("Decided for you", { exact: true })).toBeVisible();
  // The item page's own (from 700px the list beside it has the row's Looks good too).
  await page.locator("#detail").getByRole("button", { name: "Looks good" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Archived: looks good" })).toBeVisible();
  await expect(page).toHaveURL(/#inbox$/); // it was the last item in the queue
  await expect(page.getByText(/^FYI · decided for you/)).toHaveCount(0);
  await expect(inboxRow(page, SEED.retryBudget.headline)).toHaveCount(0);
  await mainNav(page).getByRole("link", { name: /History/ }).click();
  await expect(page.locator("#view-history").getByRole("link", { name: SEED.retryBudget.headline })).toBeVisible();
});

test("Enter on an option that isn't checked picks it; Enter on the checked one submits it", async ({ page }) => {
  await openItem(page, SEED.changelog);
  // The settle window after arriving is over once the pre-selected Submit is live.
  await expect(page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true })).toBeEnabled();
  const worker = page.getByRole("radio", { name: /Write change rows in the Worker/ });
  await worker.focus();
  await page.keyboard.press("Enter");
  await expect(worker).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /Keep triggers, filter by actor/ })).toHaveAttribute("aria-checked", "false");
  await expect(page).toHaveURL(/#item\.O3-changelog-approach$/); // nothing decided
  await expect(page.getByRole("status").filter({ hasText: /^Decided/ })).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /^Decided: Write change rows in the Worker/ })).toBeVisible();
  await expect(page).toHaveURL(/#item\.p-ntfy-digest$/);
});

test("an option that changes meaning under the same id clears the choice while you're on the item", async ({ page, request }) => {
  await openItem(page, SEED.changelog);
  const keep = page.getByRole("radio", { name: /Keep triggers, filter by actor/ });
  await expect(keep).toHaveAttribute("aria-checked", "true"); // pre-selected
  await expect(page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true })).toBeEnabled();

  // Meanwhile the orchestrator rewrites what that option does, keeping its id.
  const auth = { Authorization: "Bearer " + serverEnv().token };
  const doc = await (await request.get("/agent/api/items/" + SEED.changelog.id, { headers: auth })).json();
  const options = doc.data.options.map((o: { id: string }) => o.id === "keep-triggers" ? { ...o, description: "Drops the import rows from the log for good." } : o);
  const patch = await request.patch("/agent/api/items/" + SEED.changelog.id, { headers: auth, data: { data: { options } } });
  expect(patch.status(), await patch.text()).toBe(200);

  await expect(page.locator("#decide-status")).toHaveText("This item changed while you were on it. Review the options and choose again.", { timeout: 10_000 });
  await expect(keep).toContainText("Drops the import rows from the log for good.");
  await expect(keep).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
});

test("a proposal whose title changes while you're on it clears the pre-selected Approve", async ({ page, request }) => {
  await openItem(page, SEED.ntfyDigest);
  await expect(page.getByRole("button", { name: /^Submit: Approve/ })).toBeEnabled();
  // The proposal's subject is its title (and summary): rewrite it, keeping the implied Approve / Reject.
  const auth = { Authorization: "Bearer " + serverEnv().token };
  const patch = await request.patch("/agent/api/items/" + SEED.ntfyDigest.id, { headers: auth, data: { data: { title: "Send a daily ntfy digest at 06:00 ET, to everyone" } } });
  expect(patch.status(), await patch.text()).toBe(200);
  await expect(page.locator("#decide-status")).toHaveText("This item changed while you were on it. Review the options and choose again.", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
});
