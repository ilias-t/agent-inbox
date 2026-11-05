// Back across tabs (src/lib/backnav.ts): each link that crosses from one tab to another, then the browser's Back
// twice, checking the URL, the tab shown (the nav's current entry and the list beside the page) and focus each time;
// and the in-app way back (the back link, u, Esc), which steps back in history when it returns to the page before.
import type { Page } from "@playwright/test";
import { SEED, expect, itemHash, mainNav, openInbox, openQueue, test } from "./fixtures.ts";
import { postAsk, seedReviews } from "./support/reviews.ts";

const ASK = { id: "review-bot-812-product", title: "#812: fail with 413, or truncate?" };
const PR = "Return 413 for oversized uploads instead of a 500";
const LABEL = { inbox: "Inbox", team: "Team", reviews: "Reviews", history: "History", settings: "Settings" } as const;
type Where = keyof typeof LABEL;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = (page: Page) => page.locator('#detail h2[tabindex="-1"]');
const row = (page: Page, tab: Where, href: string) => page.locator("#view-" + tab + ' a.row[href="' + href + '"]');

// The URL ends with `hash`, the nav marks `tab` current (and from 700px its list is the one shown), and `focus` has focus.
async function at(page: Page, hash: string, tab: Where, focus: ReturnType<Page["locator"]>, split = true): Promise<void> {
  await expect(page).toHaveURL(new RegExp(esc(hash) + "$"));
  await expect(mainNav(page).getByRole("link", { name: new RegExp("^" + LABEL[tab]) })).toHaveAttribute("aria-current", "page");
  if (split && tab !== "settings") await expect(page.locator("#view-" + tab)).toBeVisible();
  await expect(focus).toBeFocused();
}

test.describe("1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("item → #812 in Reviews → Back to the item (Inbox beside it) → Back to the Inbox", async ({ page, request }) => {
    await seedReviews();
    await postAsk(request, ASK.id, 812);
    await openInbox(page);
    await row(page, "inbox", itemHash(ASK.id)).click();
    await at(page, itemHash(ASK.id), "inbox", heading(page));
    await page.getByRole("link", { name: "#812 in Reviews" }).click();
    await at(page, "#pr.review-bot.812", "reviews", page.getByRole("heading", { level: 2, name: PR }));
    await page.goBack();
    await at(page, itemHash(ASK.id), "inbox", heading(page));
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox");
    await expect(row(page, "inbox", itemHash(ASK.id))).toHaveAttribute("aria-current", "true");
    await page.goBack();
    await at(page, "#inbox", "inbox", row(page, "inbox", itemHash(ASK.id)));
  });

  test("Reviews → a PR → Decide in Inbox (the Inbox) → Back to the PR → Back to Reviews", async ({ page, request }) => {
    await seedReviews();
    await postAsk(request, ASK.id, 812);
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^PRs/ }).click();
    await row(page, "reviews", "#pr.review-bot.812").click();
    const prHead = page.getByRole("heading", { level: 2, name: PR });
    await at(page, "#pr.review-bot.812", "reviews", prHead);
    await page.locator(".rvhead").getByRole("link", { name: "Decide in Inbox" }).click();
    await at(page, itemHash(ASK.id), "inbox", heading(page));
    await expect(row(page, "inbox", itemHash(ASK.id))).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox");
    await page.goBack();
    await at(page, "#pr.review-bot.812", "reviews", prHead);
    await page.goBack();
    await at(page, "#reviews", "reviews", row(page, "reviews", "#pr.review-bot.812"));
  });

  test("item → its orchestrator's briefing (Team) → Back, Back: the item still goes back to the Inbox", async ({ page }) => {
    await openInbox(page);
    await row(page, "inbox", itemHash(SEED.changelog.id)).click();
    await at(page, itemHash(SEED.changelog.id), "inbox", heading(page));
    const brief = page.getByRole("link", { name: /Open O3 briefing/ });
    if (!(await brief.isVisible())) await page.locator("details.ctx > summary").first().click();
    await brief.click();
    await at(page, "#orch.O3", "team", heading(page));
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox"); // up to the list it was opened from
    await page.goBack();
    await at(page, itemHash(SEED.changelog.id), "inbox", heading(page));
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox");
    await expect(page.locator("#back-link")).toBeHidden(); // beside the Inbox: u and Esc go up to it
    await page.goBack();
    await at(page, "#inbox", "inbox", row(page, "inbox", itemHash(SEED.changelog.id)));
  });

  test("History → an item → u back to History steps back: Forward reopens the item", async ({ page }) => {
    await openInbox(page);
    await mainNav(page).getByRole("link", { name: /^History/ }).click();
    const first = page.locator("#view-history a.row").first();
    await expect(first).toBeVisible();
    const href = (await first.getAttribute("href"))!;
    await first.click();
    await at(page, href, "history", heading(page));
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#history");
    await page.keyboard.press("u");
    await at(page, "#history", "history", row(page, "history", href));
    await page.goForward();
    await at(page, href, "history", heading(page));
    await page.goBack();
    await at(page, "#history", "history", row(page, "history", href));
    await page.goBack();
    await at(page, "#inbox", "inbox", page.locator("body"));
  });

  test("a PR opened from an item: Esc goes up to Reviews; Back returns to the PR, then to the item", async ({ page, request }) => {
    await seedReviews();
    await postAsk(request, ASK.id, 812);
    await openInbox(page);
    await row(page, "inbox", itemHash(ASK.id)).click();
    await page.getByRole("link", { name: "#812 in Reviews" }).click();
    const prHead = page.getByRole("heading", { level: 2, name: PR });
    await at(page, "#pr.review-bot.812", "reviews", prHead);
    await page.keyboard.press("Escape");
    await at(page, "#reviews", "reviews", row(page, "reviews", "#pr.review-bot.812"));
    await page.goBack();
    await at(page, "#pr.review-bot.812", "reviews", prHead);
    await page.goBack();
    await at(page, itemHash(ASK.id), "inbox", heading(page));
  });

  test("the app opened at / (no hash): an item → u back to the Inbox steps back (no entry added)", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#view-inbox")).toBeVisible();
    await row(page, "inbox", itemHash(SEED.changelog.id)).click();
    await at(page, itemHash(SEED.changelog.id), "inbox", heading(page));
    const len = await page.evaluate(() => history.length);
    await page.keyboard.press("u");
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => history.length)).toBe(len); // stepped back: no entry added
    await expect(page.locator("#view-inbox")).toBeVisible();
  });

  test("an entry made before the way back was kept: Back to it from the page after doesn't borrow that page as its predecessor", async ({ page }) => {
    await page.goto("/#history");
    await expect(page.locator("#view-history")).toBeVisible();
    // pushState adds an entry without a route() run: no nav on its state, as before this shipped.
    await page.evaluate((h) => { history.pushState(null, "", h); }, itemHash(SEED.changelog.id));
    await page.evaluate(() => { location.hash = "#orch.O3"; });
    await expect(page).toHaveURL(/#orch\.O3$/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(esc(itemHash(SEED.changelog.id)) + "$"));
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#history");
    expect(await page.evaluate(() => (history.state as { nav: { from: string | null } }).nav.from)).toBeNull();
  });

  test("deciding auto-advances to the next item; u from it still steps back to the Inbox, and Back then leaves", async ({ page }) => {
    await openInbox(page);
    await row(page, "inbox", itemHash(SEED.changelog.id)).click();
    await at(page, itemHash(SEED.changelog.id), "inbox", heading(page));
    const submit = page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(new RegExp(esc(itemHash(SEED.ntfyDigest.id)) + "$")); // a replace: no entry added
    await expect(heading(page)).toBeVisible();
    const len = await page.evaluate(() => history.length);
    await page.keyboard.press("u");
    await expect(page).toHaveURL(/#inbox$/);
    expect(await page.evaluate(() => history.length)).toBe(len);
    await page.goBack();
    await expect(page).not.toHaveURL(new RegExp(esc(itemHash(SEED.ntfyDigest.id)) + "$"));
  });

  test("without the Navigation API (older Safari): Back, then another item, still steps back with u", async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, "navigation", { value: undefined, configurable: true }); });
    await openInbox(page);
    expect(await page.evaluate(() => (window as { navigation?: unknown }).navigation)).toBeUndefined();
    await row(page, "inbox", itemHash(SEED.changelog.id)).click();
    await at(page, itemHash(SEED.changelog.id), "inbox", heading(page));
    await page.goBack();
    await expect(page).toHaveURL(/#inbox$/);
    // A new entry in place of the forward one: history.length doesn't grow, but it's a navigation, not a traversal.
    await row(page, "inbox", itemHash(SEED.stagingToken.id)).click();
    await at(page, itemHash(SEED.stagingToken.id), "inbox", heading(page));
    const len = await page.evaluate(() => history.length);
    await page.keyboard.press("u");
    await expect(page).toHaveURL(/#inbox$/);
    expect(await page.evaluate(() => history.length)).toBe(len);
  });

  test("a reload keeps a page's way back", async ({ page }) => {
    await openInbox(page);
    await row(page, "inbox", itemHash(SEED.changelog.id)).click();
    await at(page, itemHash(SEED.changelog.id), "inbox", heading(page)); // rendered before checking the fold
    const brief = page.getByRole("link", { name: /Open O3 briefing/ });
    if (!(await brief.isVisible())) await page.locator("details.ctx > summary").first().click();
    await brief.click();
    await expect(page).toHaveURL(/#orch\.O3$/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox");
    await page.goBack();
    await at(page, itemHash(SEED.changelog.id), "inbox", heading(page));
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox");
  });
});

test.describe("390", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("Settings → Team → Back to Settings (still back to the Inbox) → Back to the Inbox", async ({ page }) => {
    await seedReviews(); // Team moves under Settings on a phone once Reviews shows
    await openQueue(page);
    await mainNav(page).getByRole("link", { name: "Settings" }).tap();
    await expect(page).toHaveURL(/#settings$/);
    await expect(page.locator("#back-link")).toHaveText(/Inbox/);
    await page.getByRole("link", { name: /^Team/ }).tap();
    await expect(page).toHaveURL(/#team$/);
    await expect(mainNav(page).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(page).toHaveURL(/#settings$/);
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox");
    await expect(page.locator("#back-link")).toHaveText(/Inbox/);
    await expect(heading(page)).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/#inbox$/);
    await expect(mainNav(page).getByRole("link", { name: /^Inbox/ })).toHaveAttribute("aria-current", "page");
  });

  test("item → its orchestrator → Back: the item's back link still says Queue", async ({ page }) => {
    await openQueue(page);
    await page.locator('#view-inbox a.row[href="' + itemHash(SEED.changelog.id) + '"]').tap();
    await expect(page.locator("#back-link")).toHaveText(/Queue/);
    await page.evaluate(() => { location.hash = "#orch.O3"; }); // the briefing's link, in the More sheet on a phone
    await expect(page).toHaveURL(/#orch\.O3$/);
    await expect(page.locator("#back-link")).toHaveText(/Inbox/);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(esc(itemHash(SEED.changelog.id)) + "$"));
    await expect(page.locator("#back-link")).toHaveText(/Queue/);
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#inbox");
  });
});
