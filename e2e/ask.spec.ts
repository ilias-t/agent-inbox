import { SEED, expect, inboxRow, mainNav, openItem, test } from "./fixtures.ts";

test("asking a question shows it in the thread, waiting for the orchestrator", async ({ page }) => {
  await openItem(page, SEED.prReady);
  const qa = page.locator("#qa");
  await expect(qa.getByText("Waiting for the orchestrator")).toHaveCount(0);

  await qa.getByRole("button", { name: "Ask a question" }).click();
  const field = qa.getByRole("textbox", { name: /Your question/ });
  await expect(field).toBeFocused();
  await field.fill("Does this also cover ntfy redeliveries?");
  await qa.getByRole("button", { name: "Send question" }).click();

  await expect(page.getByRole("status").filter({ hasText: /^Question sent/ })).toBeVisible();
  await expect(qa.getByRole("listitem").filter({ hasText: "Does this also cover ntfy redeliveries?" })).toBeVisible();
  await expect(qa.getByText(/^Waiting for the orchestrator/)).toBeVisible();
  // The item stays open, flagged on its inbox row.
  await mainNav(page).getByRole("link", { name: /Inbox/ }).click();
  await expect(inboxRow(page, SEED.prReady.headline)).toContainText("? asked");
});
