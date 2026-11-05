import { expect, test } from "./fixtures.ts";
import { postAsk, seedReviews } from "./support/reviews.ts";

// A review routine's ask offers "Done on GitHub" beside Other (shared/choices.ts); other items don't.
const ID = "review-bot-812-product";

for (const [name, viewport] of [["1280", { width: 1280, height: 800 }], ["390", { width: 390, height: 844 }]] as const) {
  test.describe(name, () => {
    test.use({ viewport });
    test("a routine's ask offers Done on GitHub, and deciding it records that choice", async ({ page, request }) => {
      await seedReviews();
      await postAsk(request, ID, 812);
      await page.goto("/#item." + ID);
      const done = page.getByRole("radio", { name: /^Done on GitHub/ });
      await expect(done).toBeVisible();
      await done.click();
      await page.getByRole("button", { name: "Submit: Done on GitHub", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: /^Decided: Done on GitHub/ })).toBeVisible();
    });
  });
}

test("an ordinary item has no Done on GitHub choice", async ({ page }) => {
  await page.goto("/#item.O3-changelog-approach");
  await expect(page.getByRole("radio", { name: /^Other…/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Done on GitHub/ })).toHaveCount(0);
});
