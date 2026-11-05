import { SEED, expect, itemHash, mainNav, openInbox, openQueue, test } from "./fixtures.ts";

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the bottom nav: five entries, Focus opens the top ask, Settings opens Settings", async ({ page }) => {
    await openQueue(page);
    const nav = mainNav(page);
    await expect(nav.getByRole("link")).toHaveText([/^Inbox/, /^Team/, /^Focus/, /^History/, /^Settings/]);
    await expect(nav.getByRole("link", { name: /^Inbox/ })).toHaveAttribute("aria-current", "page");
    const box = await nav.boundingBox();
    expect(box && box.y + box.height).toBeGreaterThan(844 - 4); // pinned to the bottom of the screen
    await expect(page.locator("#settings-link")).toBeHidden(); // the nav's Settings is the one

    const focus = nav.getByRole("link", { name: /^Focus/ });
    await expect(focus).toHaveText(/5/); // the asks that need you
    await focus.tap();
    await expect(page).toHaveURL(new RegExp(itemHash(SEED.stagingToken.id).replace(/\./g, "\\.") + "$"));
    await expect(page.getByRole("heading", { level: 2, name: SEED.stagingToken.title })).toBeVisible();
    await expect(nav).toBeHidden(); // an item page's bottom bar is its pager
    await expect(page.getByRole("navigation", { name: "Inbox items" })).toBeVisible();

    await page.locator("#back-link").tap();
    await expect(page).toHaveURL(/#inbox$/);
    await nav.getByRole("link", { name: "Settings" }).tap();
    await expect(page).toHaveURL(/#settings$/);
    await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

  test("at 320px every nav entry fits its cell, Focus's label and count inside the accent", async ({ page }) => {
    await openQueue(page);
    const overflow = await mainNav(page).getByRole("link").evaluateAll((links) =>
      links.filter((a) => a.scrollWidth > a.clientWidth + 1).map((a) => a.textContent?.trim()));
    expect(overflow).toEqual([]);
  });
});

test("desktop: the nav sits in the top bar, without Focus, and the gear is the one Settings link", async ({ page }) => {
  await openInbox(page);
  const nav = mainNav(page);
  await expect(nav.getByRole("link")).toHaveText([/^Inbox/, /^Team/, /^History/]);
  await expect(nav.getByRole("link", { name: /Focus/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  const navBox = await nav.boundingBox(), title = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(navBox && title && Math.abs(navBox.y + navBox.height / 2 - (title.y + title.height / 2))).toBeLessThan(12); // beside the title
});
