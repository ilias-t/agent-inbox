// History with more archived items than /api/state carries (the 100 most recent): Load older pages the rest in,
// search asks the server for the ones not loaded, and an older item's own page loads by id.
import { expect, test } from "./fixtures.ts";
import { seedArchived } from "./support/data.ts";

const ARCHIVED = 120;
const NEEDLE = 115; // well past the 100 most recent

test("Load older pages in archived items beyond the first 100", async ({ page }) => {
  await seedArchived(ARCHIVED);
  await page.goto("/#history");
  const rows = page.locator("#history-list a.row");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  // The seed's own archived item makes 121: 21 aren't loaded yet. The total counts them anyway.
  const older = page.getByRole("button", { name: /Load older/ });
  await expect(older).toHaveText("Load older 21");
  await expect(page.locator("#history-count")).toHaveText(before + 21 + " items");
  await expect(page.locator("#view-history").getByRole("link", { name: /Archived decision 119\b/ })).toHaveCount(0);

  await older.click();
  await expect(rows).toHaveCount(before + 21);
  await expect(page.locator("#view-history").getByRole("link", { name: /Archived decision 119\b/ })).toBeVisible();
  await expect(older).toHaveCount(0); // nothing left on the server
});

test("search finds an archived item that isn't loaded, through the server", async ({ page }) => {
  await seedArchived(ARCHIVED, { [NEEDLE]: "Rotate the zebra-quartz signing key" });
  await page.goto("/#history");
  await expect(page.locator("#history-list a.row").first()).toBeVisible();

  const requests: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/items?")) requests.push(r.url()); });
  await page.getByRole("searchbox", { name: "Search History" }).fill("zebra-quartz");

  const hit = page.locator("#history-list [data-server]").getByRole("link", { name: /zebra-quartz/ });
  await expect(hit).toBeVisible();
  await expect(page.locator("#history-older")).toContainText("Older matches 1");
  await expect(page.locator("#history-count")).toHaveText(/^1 of \d+$/);
  // One request for the settled query (the debounce coalesces the typing).
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get("q")).toBe("zebra-quartz");

  await hit.click();
  await expect(page.getByRole("heading", { level: 2, name: "Rotate the zebra-quartz signing key" })).toBeVisible();
});

test("an older archived item's page loads straight from its link", async ({ page }) => {
  const { id } = await seedArchived(ARCHIVED, { [NEEDLE]: "Rotate the zebra-quartz signing key" });
  await page.goto("/#item." + id(NEEDLE));
  await expect(page.getByRole("heading", { level: 2, name: "Rotate the zebra-quartz signing key" })).toBeVisible();
  await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible();
});
