// Pins (src/views/pins.ts): the signed-in human keeps an item, an orchestrator or a Reviews PR in a Pinned group at the
// top of its own list. Pinned from each of the four lists (a page's Pin toggle, and `p` on a desk), kept across a
// reload (they're stored on the server, per person), and a pinned item that gets decided moves to History's Pinned.
import type { Page } from "@playwright/test";
import { SEED, expect, openInbox, openQueue, test } from "./fixtures.ts";
import { seedArchived, serverEnv } from "./support/data.ts";
import { ageGonePr, seedReviews, watchPage } from "./support/reviews.ts";

const PAST = { id: "O1-scope", href: "#item.O1-scope" }; // the oldest item in History
const PR = { href: "#pr.review-bot.812", title: "Return 413 for oversized uploads instead of a 500" };
const href = (id: string) => "#item." + encodeURIComponent(id);

// A list's first group heading and its first rows' links, in order.
const firstGroup = (page: Page, tab: string) => page.locator("#" + tab + "-list h3.ghead").first();
const rowHrefs = (page: Page, tab: string, n: number) =>
  page.locator("#" + tab + "-list a.row").evaluateAll((as, k) => as.slice(0, k).map((a) => a.getAttribute("href")), n);
const row = (page: Page, tab: string, h: string) => page.locator("#" + tab + '-list a.row[href="' + h + '"]');

// The page header's toggle: "Pin" until pressed, then "Unpin" and pressed.
async function pinPage(page: Page): Promise<void> {
  await page.locator("#detail").getByRole("button", { name: "Pin", exact: true }).click();
  await expect(page.locator("#detail").getByRole("button", { name: "Unpin", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#toast")).toContainText("Pinned to the top of");
}

// What the four lists show once everything is pinned (`inbox`: the Inbox's pinned item ids, newest pin first).
async function expectPinned(page: Page, inbox: string[]): Promise<void> {
  await page.goto("/#inbox");
  await expect(firstGroup(page, "inbox")).toHaveText("Pinned " + inbox.length);
  await expect.poll(() => rowHrefs(page, "inbox", inbox.length)).toEqual(inbox.map(href));
  for (const id of inbox) await expect(row(page, "inbox", href(id))).toHaveCount(1); // not also in its own group
  await page.goto("/#history");
  await expect(firstGroup(page, "history")).toHaveText("Pinned 1");
  await expect.poll(() => rowHrefs(page, "history", 1)).toEqual([PAST.href]);
  await expect(row(page, "history", PAST.href)).toHaveCount(1);
  await page.goto("/#team");
  await expect(firstGroup(page, "team")).toHaveText("Pinned 1");
  await expect(page.locator("#team-list h3.ghead").nth(1)).toHaveText("Rest of the team 2");
  await expect.poll(() => rowHrefs(page, "team", 1)).toEqual(["#orch.O3"]);
  await page.goto("/#reviews");
  await page.getByRole("radio", { name: /^PRs/ }).click();
  await expect(firstGroup(page, "reviews")).toHaveText("Pinned 1");
  await expect.poll(() => rowHrefs(page, "reviews", 1)).toEqual([PR.href]);
  await expect(row(page, "reviews", PR.href)).toHaveCount(1);
}

// Decides a pinned Inbox item: it leaves the Inbox for History's Pinned group, still pinned, in pin order (the History
// item was pinned after it, so it stays first).
async function decidePinned(page: Page, decide: () => Promise<void>): Promise<void> {
  await decide();
  await page.goto("/#history");
  await expect(firstGroup(page, "history")).toHaveText("Pinned 2");
  await expect.poll(() => rowHrefs(page, "history", 2)).toEqual([PAST.href, href(SEED.d1Usage.id)]);
  await page.goto("/#inbox");
  await expect(row(page, "inbox", href(SEED.d1Usage.id))).toHaveCount(0);
  await expect(firstGroup(page, "inbox")).toHaveText("Pinned 1");
}

test.describe("1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("pins from the Inbox, History, Team and Reviews stay on top across a reload; a decided one moves to History's", async ({ page }) => {
    const w = await watchPage(page);
    await seedReviews();
    // Inbox: p on a row.
    await openInbox(page);
    await row(page, "inbox", href(SEED.ntfyDigest.id)).focus();
    await page.keyboard.press("p");
    await expect(firstGroup(page, "inbox")).toHaveText("Pinned 1");
    await expect.poll(() => rowHrefs(page, "inbox", 1)).toEqual([href(SEED.ntfyDigest.id)]);
    await expect(row(page, "inbox", href(SEED.ntfyDigest.id))).toBeFocused(); // focus follows the row
    // Inbox: the item page's toggle, and p there undoes and redoes it.
    await row(page, "inbox", href(SEED.d1Usage.id)).click();
    await expect(page.getByRole("heading", { level: 2, name: SEED.d1Usage.title })).toBeVisible();
    await pinPage(page);
    await page.keyboard.press("p");
    await expect(page.locator("#detail").getByRole("button", { name: "Pin", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("p");
    await expect(page.locator("#detail").getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    // History: p on a row.
    await page.goto("/#history");
    await row(page, "history", PAST.href).focus();
    await page.keyboard.press("p");
    await expect(firstGroup(page, "history")).toHaveText("Pinned 1");
    // Team: the orchestrator page's toggle, beside the list.
    await page.goto("/#orch.O3");
    await pinPage(page);
    await expect(firstGroup(page, "team")).toHaveText("Pinned 1");
    // Reviews: the PR page's toggle, beside the PRs.
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^PRs/ }).click();
    await row(page, "reviews", PR.href).click();
    await expect(page.getByRole("heading", { level: 2, name: PR.title })).toBeVisible();
    await pinPage(page);
    await expect(firstGroup(page, "reviews")).toHaveText("Pinned 1");

    await page.reload();
    await expectPinned(page, [SEED.d1Usage.id, SEED.ntfyDigest.id]);

    await decidePinned(page, async () => {
      await page.goto("/" + href(SEED.d1Usage.id));
      await page.getByRole("radio", { name: /Acknowledge/ }).click();
      await page.getByRole("button", { name: "Submit: Acknowledge" }).click();
      await expect(page.getByRole("status").filter({ hasText: /^Decided: Acknowledge/ })).toBeVisible();
    });
    expect(await w.problems()).toEqual([]);
  });

  test("the pager and Next follow the Inbox as shown: a pinned low ask is first, and deciding it moves on", async ({ page }) => {
    await openInbox(page);
    await row(page, "inbox", href(SEED.d1Usage.id)).focus(); // low priority, last of the asks
    await page.keyboard.press("p");
    await expect.poll(() => rowHrefs(page, "inbox", 1)).toEqual([href(SEED.d1Usage.id)]);
    await row(page, "inbox", href(SEED.d1Usage.id)).click();
    await expect(page.getByRole("heading", { level: 2, name: SEED.d1Usage.title })).toBeVisible();
    await expect(page.locator("#pager .ppos")).toHaveText("1 of 6");
    await expect(page.locator("#pager-next")).toHaveAttribute("href", href(SEED.stagingToken.id));
    await expect(page.locator("#pager-prev")).toHaveCount(0);
    await page.getByRole("radio", { name: /Acknowledge/ }).click();
    await page.getByRole("button", { name: "Submit: Acknowledge" }).click();
    await expect(page).toHaveURL(new RegExp(href(SEED.stagingToken.id).replace(/\./g, "\\.") + "$"));
    await expect(page.getByRole("heading", { level: 2, name: SEED.stagingToken.title })).toBeVisible();
  });

  test("a pinned archived item beyond the loaded window, whose fetch failed offline, comes back after a sync", async ({ page, request }) => {
    const { id } = await seedArchived(120);
    const old = id(115); // well past the 100 most recent: History fetches it on its own
    await openInbox(page);
    expect(await page.evaluate(async (i) => (await fetch("/api/pins/item/" + i, { method: "PUT", headers: { "Content-Type": "application/json" } })).status, old)).toBe(200);
    // Offline for that fetch: it fails, and History shows no Pinned group.
    let failed = 0;
    await page.route("**/api/items/" + old, (r) => { failed++; return r.abort("internetdisconnected"); });
    await page.goto("/#history");
    await expect(page.locator("#history-list a.row").first()).toBeVisible();
    await expect.poll(() => failed).toBeGreaterThan(0);
    await expect(firstGroup(page, "history")).not.toHaveText(/Pinned/);
    // Back online: the next live update (a write from the orchestrator) retries it.
    await page.unroute("**/api/items/" + old);
    const { token } = serverEnv();
    const w = await request.patch("/agent/api/items/" + SEED.changelog.id, { headers: { Authorization: "Bearer " + token }, data: { data: { summary: "touched" } } });
    expect(w.status(), await w.text()).toBe(200);
    await expect(firstGroup(page, "history")).toHaveText("Pinned 1");
    await expect.poll(() => rowHrefs(page, "history", 1)).toEqual([href(old)]);
  });

  test("with every PR that needs you pinned, the routine card's count goes to them in Pinned", async ({ page }) => {
    await seedReviews();
    await openInbox(page);
    for (const n of [812, 798]) { // the two that need you
      expect(await page.evaluate(async (k) => (await fetch("/api/pins/pr/review-bot/" + k, { method: "PUT", headers: { "Content-Type": "application/json" } })).status, n)).toBe(200);
    }
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^PRs/ }).click();
    await expect(firstGroup(page, "reviews")).toHaveText("Pinned 2");
    await expect(page.locator("#reviews-list h3.ghead", { hasText: "Needs you" })).toHaveCount(0);
    await page.getByRole("radio", { name: /^Runs/ }).click(); // the count switches to PRs too
    await page.locator("#reviews-card").getByRole("button", { name: "2 need you" }).click();
    await expect(page.getByRole("radio", { name: /^PRs/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#rv-needs")).toBeFocused();
    await expect(page.locator("#rv-needs")).toHaveText("Pinned 2");
  });

  test("a pinned PR gone from the newest report stays in Pinned, saying so, even once the list stops showing it", async ({ page }) => {
    await seedReviews();
    await ageGonePr(); // #795 dropped out 9 days ago: the list keeps 7
    await page.goto("/#pr.review-bot.795");
    await expect(page.getByText(/Dropped out of the newest report/)).toBeVisible();
    await pinPage(page);
    const pinned = row(page, "reviews", "#pr.review-bot.795");
    await expect(firstGroup(page, "reviews")).toHaveText("Pinned 1");
    await expect(pinned).toContainText("Dropped out of the newest report");
    await page.reload();
    await expect(pinned).toContainText("Dropped out of the newest report");
  });
});

test.describe("390", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("each page's Pin toggle pins it on top of its list, across a reload; a decided one moves to History's", async ({ page }) => {
    const w = await watchPage(page);
    await seedReviews();
    await openQueue(page);
    for (const id of [SEED.ntfyDigest.id, SEED.d1Usage.id]) {
      await page.goto("/" + href(id));
      await pinPage(page);
    }
    await page.goto("/" + PAST.href);
    await pinPage(page);
    await page.goto("/#orch.O3");
    await pinPage(page);
    await page.goto("/" + PR.href);
    await expect(page.getByRole("heading", { level: 2, name: PR.title })).toBeVisible();
    await pinPage(page);

    await page.reload();
    await expectPinned(page, [SEED.d1Usage.id, SEED.ntfyDigest.id]);
    // Nothing wider than the phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await decidePinned(page, async () => {
      const status = await page.evaluate(async (id) => (await fetch("/api/items/" + encodeURIComponent(id) + "/decide", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice: "ack" }),
      })).status, SEED.d1Usage.id);
      expect(status).toBe(200);
    });
    expect(await w.problems()).toEqual([]);
  });
});
