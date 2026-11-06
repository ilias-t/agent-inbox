// Regenerates the README's screenshots (docs/screenshots/*.png) from the seed data. Skipped unless SCREENSHOTS=1:
// `npm run screenshots`. Sizes are the README's: phones at 390×844, laptops at 1280×900, both at 2x, and Reviews at
// 1280×860, 1x. Look at every image before committing it.
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { SEED, expect, openItem, openQueue, test } from "./fixtures.ts";
import { ROOT } from "./support/data.ts";
import { postAsk, seedReviews } from "./support/reviews.ts";

test.skip(process.env.SCREENSHOTS !== "1","set SCREENSHOTS=1 (npm run screenshots) to regenerate docs/screenshots");

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const LAPTOP = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 };

// Fonts loaded, nothing moving, no caret: then the shot.
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(ROOT, "docs/screenshots", name), animations: "disabled", caret: "hide" });
}

// The saved theme (src/state.ts), applied by index.html's inline script before first paint.
async function useTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.addInitScript((t) => { try { localStorage.setItem("agent-inbox-theme", t); } catch { /* no storage */ } }, theme);
}

test.describe("phone", () => {
  test.use(PHONE);

  test("1-inbox", async ({ page }) => {
    await useTheme(page, "light");
    await openQueue(page);
    await shot(page, "1-inbox.png");
  });

  test("2-item", async ({ page }) => {
    await useTheme(page, "light");
    await openQueue(page);
    await openItem(page, SEED.changelog);
    await shot(page, "2-item.png");
  });

  test("5-orch-dark", async ({ page }) => {
    await useTheme(page, "dark");
    await openQueue(page);
    await page.goto("/#orch.O3");
    await expect(page.locator('#detail h2[tabindex="-1"]')).toBeVisible();
    await shot(page, "5-orch-dark.png");
  });

  test("6-settings-dark", async ({ page }) => {
    // Headless Chromium reports notifications as denied ("Blocked"); a browser that hasn't been asked yet says "default".
    await page.addInitScript(() => { try { Object.defineProperty(Notification, "permission", { get: () => "default" }); } catch { /* none */ } });
    // The tokens global setup mints for the review-bot routines are the suite's, not the seed's: leave them out.
    await page.route("**/api/tokens", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const r = await route.fetch(), body = (await r.json()) as { tokens: { name: string }[] };
      await route.fulfill({ response: r, json: { ...body, tokens: body.tokens.filter((t) => !t.name.startsWith("orch-review-bot")) } });
    });
    await useTheme(page, "dark");
    await openQueue(page);
    await page.goto("/#settings");
    await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
    // Every section loaded (tokens, people, this device, the account) before the page is measured.
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(1);
    await expect(page.getByText("Nobody saved yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable notifications on this device" })).toBeVisible();
    await expect(page.getByText("Signed in as")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // The whole page in one viewport, so the fixed bottom bar sits at the end rather than across the middle.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: PHONE.viewport.width, height });
    await shot(page, "6-settings-dark.png");
  });
});

test.describe("laptop", () => {
  test.use(LAPTOP);

  test("3-item-desktop", async ({ page }) => {
    await useTheme(page, "light");
    await openItem(page, SEED.changelog);
    await shot(page, "3-item-desktop.png");
  });

  test("4-shortcuts", async ({ page }) => {
    await useTheme(page, "light");
    await openItem(page, SEED.changelog);
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await shot(page, "4-shortcuts.png");
  });
});

test.describe("reviews", () => {
  test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });

  test("7-reviews-desktop", async ({ page, request }) => {
    await useTheme(page, "light");
    await seedReviews();
    await postAsk(request, "review-bot-812-product", 812);
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^PRs/ }).click();
    await page.locator('#view-reviews a.row[href="#pr.review-bot.812"]').click();
    await expect(page.getByRole("heading", { level: 2, name: "Return 413 for oversized uploads instead of a 500" })).toBeVisible();
    await shot(page, "7-reviews-desktop.png");
  });
});
