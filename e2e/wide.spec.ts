// A wide desk screen: the page beside the list uses the pane's width (tables, the item's two columns, timelines), and
// only prose keeps a readable measure (.md, 68ch).
import type { Locator, Page } from "@playwright/test";
import { uiPayloads } from "../test/fixtures/review-ui.ts";
import { SEED, expect, openItem, test } from "./fixtures.ts";
import { seedReviews } from "./support/reviews.ts";

test.use({ viewport: { width: 1920, height: 1080 } });

const width = async (l: Locator) => (await l.boundingBox())!.width;
// The pane's content box: #detail less its side padding.
const pane = (page: Page) => page.locator("#detail").evaluate((el) => {
  const s = getComputedStyle(el);
  return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
});

test("an item's two columns fill the pane; its prose stays at a reading width", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const full = await pane(page);
  expect(full).toBeGreaterThan(1300);
  expect(await width(page.locator(".dcols"))).toBeGreaterThan(full - 2);
  for (const md of await page.locator("#detail .md").all()) if (await md.isVisible()) expect(await width(md)).toBeLessThanOrEqual(720);
});

test("an orchestrator's briefing fills the pane", async ({ page }) => {
  await page.goto("/#orch.O3");
  await expect(page.locator("#detail h2")).toBeVisible();
  expect(await width(page.locator("#detail > .show"))).toBeGreaterThan((await pane(page)) - 2);
});

test("a PR's facts and timeline, and a run's page, fill the pane", async ({ page }) => {
  const now = Date.now();
  await seedReviews(now);
  await page.goto("/#pr.review-bot.812");
  await expect(page.locator(".rvtl .rvte").first()).toBeVisible();
  const full = await pane(page);
  expect(await width(page.locator(".rvkv"))).toBeGreaterThan(full - 2);
  expect(await width(page.locator(".rvtl"))).toBeGreaterThan(full - 2);
  await page.goto("/#run.review-bot." + uiPayloads(now).at(-1)!.stamp);
  await expect(page.locator("#detail h2")).toBeVisible();
  expect(await width(page.locator("#detail > .show"))).toBeGreaterThan(full - 2);
});
