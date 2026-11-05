// The Reviews tab (src/views/reviews.ts): shown once a review routine has reported, the routine's card, Runs | PRs,
// the run feed and the PR groups, and a run's and a PR's page (beside the list from 700px, alone on a phone).
// The routine's runs are stored through the CLI with its own token (e2e/support/reviews.ts), from the synthetic fixture.
import type { Page, Route } from "@playwright/test";
import { stampOf, uiPayloads } from "../test/fixtures/review-ui.ts";
import { expect, mainNav, openInbox, openQueue, test } from "./fixtures.ts";
import { ageGonePr, postAsk, reportRun, seedReviews, watchPage } from "./support/reviews.ts";

const PR = "Return 413 for oversized uploads instead of a 500";
const groups = (page: Page) => page.locator("#reviews-list h3.ghead");
// Nothing wider than the viewport: no sideways scroll.
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("without a routine the nav has no Reviews entry, and #reviews says none has reported", async ({ page }) => {
  await openInbox(page);
  await expect(mainNav(page).getByRole("link")).toHaveText([/^Inbox/, /^Team/, /^History/]);
  await page.goto("/#reviews");
  await expect(page.getByText("No review routine has reported yet.")).toBeVisible();
});

test.describe("1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Reviews joins the nav; PRs by group, Mine and Bots folded, Held empty", async ({ page }) => {
    const w = await watchPage(page);
    await seedReviews();
    await openInbox(page);
    await expect(mainNav(page).getByRole("link")).toHaveText([/^Inbox/, /^Team/, /^Reviews/, /^History/]);
    await page.keyboard.press("g"); await page.keyboard.press("r");
    await expect(page).toHaveURL(/#reviews$/);
    await expect(mainNav(page).getByRole("link", { name: /^Reviews/ })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#manager")).toBeHidden(); // the routine's card instead
    await expect(page.locator("#reviews-card")).toContainText("Last run");
    await expect(page.locator("#reviews-card")).toContainText("2 need you");

    await page.getByRole("radio", { name: /^PRs/ }).click();
    await expect(groups(page)).toHaveText(["Needs you 2", "Held 2", "With author 3", "Approved 2", /^Mine 4/, /^Bots 2/]);
    await expect(page.locator("#reviews-list").getByRole("link", { name: new RegExp("#812 " + PR) })).toBeVisible();
    await expect(page.locator("#reviews-list").getByRole("link", { name: /Show export progress/ })).toBeHidden(); // Mine is folded
    await page.locator("#reviews-list summary", { hasText: "Mine" }).click();
    await expect(page.locator("#reviews-list").getByRole("link", { name: /Show export progress/ })).toBeVisible();
    await expect(page.getByText("Select a run or a PR")).toBeVisible();

    // A PR opens beside the list, its row current.
    await page.locator("#reviews-list").getByRole("link", { name: new RegExp("#812 " + PR) }).click();
    await expect(page).toHaveURL(/#pr\.review-bot\.812$/);
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeVisible();
    await expect(page.locator("#reviews-list a.row[aria-current]")).toHaveText(new RegExp("#812"));
    await expect(page.getByText("Clears when you make the call or review on GitHub.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Review on GitHub/ })).toHaveAttribute("href", "https://github.com/acme/widgets/pull/812");
    await expect(page.getByText("Should oversized uploads fail with 413, or be truncated to the limit?")).toBeVisible();
    expect(await w.problems()).toEqual([]);
  });

  test("Runs: the feed under day headers; a run opens beside it with what it did", async ({ page }) => {
    const w = await watchPage(page);
    await seedReviews();
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    await expect(page.getByRole("radio", { name: /^Runs/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#reviews-list .rvnext")).toContainText("Next run");
    await expect(page.locator("#reviews-list h3.ghead.day").first()).toHaveText(/Today|Yesterday/);
    const first = page.locator("#reviews-list .rvrun a.row").first();
    await expect(first).toContainText("Approved #809");
    const acts = page.locator("#reviews-list .rvacts").first().getByRole("link");
    // The Worker lists a run's actions in its report's order (newest PR first), then needs-you PRs, then skips.
    await expect(acts).toHaveText([/Commented\s*#812/, /Approved\s*#809/, /Req. changes\s*#803/, /Needs you\s*#798/, /Skipped\s*#801/]);
    await expect(page.locator("#reviews-list .rvrun").nth(2)).toContainText("45-minute limit"); // the run that timed out

    await first.click();
    await expect(page).toHaveURL(/#run\.review-bot\.\d{4}-\d{2}-\d{2}T\d{6}Z$/);
    await expect(page.locator("#detail h2")).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
    await expect(first).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#detail").getByText("What it did")).toBeVisible();
    await expect(page.locator("#detail").getByRole("link", { name: "#809: the review on GitHub" })).toHaveAttribute("href", /pullrequestreview-80901$/);
    await expect(page.locator("#detail").getByText("Didn't run the upload limit against the staging bucket")).toBeVisible();
    // Esc goes back to the list.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/#reviews$/);
    expect(await w.problems()).toEqual([]);
  });

  test("a run stored while the tab is open shows up live, at the top of the feed", async ({ page }) => {
    await seedReviews();
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    await expect(page.locator("#reviews-list .rvrun a.row").first()).toContainText("Approved #809");
    const now = Date.now(), last = uiPayloads(now).at(-1)!, started = now - 6 * 60000;
    await reportRun({
      ...last, stamp: stampOf(started), started_at: new Date(started).toISOString(), finished_at: new Date(now - 60000).toISOString(),
      report: { ...last.report!, headline: "Approved #799; the rate-limit docs read well",
        prs: last.report!.prs.map((p) => ({ ...p, this_run: p.number === 799 ? { action: "approved" as const, url: p.url + "#pullrequestreview-79901", summary: "Docs match the headers", changes: [] } : { action: "none" as const, url: null, summary: "", changes: [] } })) },
    });
    await expect(page.locator("#reviews-list .rvrun a.row").first()).toContainText("Approved #799", { timeout: 15_000 });
    await expect(page.locator("#reviews-list .rvacts").first().getByRole("link")).toHaveText([/Approved\s*#799/, /Needs you\s*#812/, /Needs you\s*#798/, /Skipped\s*#801/]);
    await expect(page.locator("#reviews-card")).toContainText("Approved #799");
  });

  test("the choice of Runs or PRs is kept across a reload", async ({ page }) => {
    await seedReviews();
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    await page.reload();
    await expect(page.getByRole("radio", { name: /^Runs/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#reviews-list .rvrun").first()).toBeVisible();
  });
});

test.describe("1280, a PR's pane", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Decide in Inbox opens the ask; decided, the PR says it relays next run; the item links back", async ({ page, request }) => {
    const w = await watchPage(page);
    await seedReviews();
    await postAsk(request, "review-bot-812-product", 812);
    await page.goto("/#pr.812");
    const head = page.locator(".rvhead");
    await expect(head).toContainText("Needs you · Held · product call");
    await expect(head).toContainText("Clears when you decide in the Inbox or review on GitHub.");
    await head.getByRole("link", { name: "Decide in Inbox" }).click();
    await expect(page).toHaveURL(/#item\.review-bot-812-product$/);
    await page.getByRole("radio", { name: /Fail with 413/ }).click();
    await page.getByRole("button", { name: "Submit: Fail with 413" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Decided: Fail with 413/ })).toBeVisible();

    await page.goto("/#item.review-bot-812-product");
    await page.getByRole("link", { name: "#812 in Reviews" }).click();
    await expect(page).toHaveURL(/#pr\.review-bot\.812$/);
    await expect(head).toContainText(/Decided · relays at \d{2}:\d{2}/);
    await expect(head).toContainText("You chose “Fail with 413”. The next run posts it on GitHub.");
    await expect(head.getByRole("link", { name: /Review on GitHub/ })).toBeVisible();

    // The timeline: everything, then only you, then only the routine.
    const tl = page.locator(".rvtl");
    await expect(tl.locator(".rvte")).toHaveText([/You chose\s*Fail with 413/, /Asked you/, /Commented\s*Size check reads the header/]);
    await tl.getByRole("radio", { name: "You" }).click();
    await expect(tl.locator(".rvte")).toHaveText([/You chose/]);
    await tl.getByRole("radio", { name: "Routine" }).click();
    await expect(tl.locator(".rvte")).toHaveText([/Asked you/, /Commented/]);
    await expect(tl.getByRole("link", { name: /review/ })).toHaveAttribute("href", /pullrequestreview-81201$/);
    expect(await w.problems()).toEqual([]);
  });

  test("the header stays at the top of the pane as it scrolls", async ({ page }) => {
    await seedReviews();
    await page.goto("/#pr.812");
    await expect(page.locator(".rvtl .rvte").first()).toBeVisible();
    await page.locator("#detail").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const [pane, head] = await Promise.all([page.locator("#detail").boundingBox(), page.locator(".rvhead").boundingBox()]);
    expect(head && pane && Math.round(head.y - pane.y)).toBe(0);
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeInViewport();
  });

  test("keys: j and k move between PRs beside the list, v switches to Runs, Esc goes back", async ({ page }) => {
    await seedReviews();
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^PRs/ }).click();
    await page.goto("/#pr.812");
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeVisible();
    await page.keyboard.press("j");
    await expect(page).toHaveURL(/#pr\.review-bot\.798$/);
    await expect(page.getByRole("heading", { level: 2, name: "Changelog: 6 October entry" })).toBeVisible();
    await page.keyboard.press("k");
    await expect(page).toHaveURL(/#pr\.review-bot\.812$/);
    await page.keyboard.press("v");
    await expect(page.getByRole("radio", { name: /^Runs/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeVisible(); // the pane stays
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/#reviews$/);
    await page.keyboard.press("v");
    await expect(page.getByRole("radio", { name: /^PRs/ })).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("1280, reaching every run and PR", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a PR gone from the list for over a week still opens from its link", async ({ page }) => {
    await seedReviews();
    await ageGonePr();
    await page.goto("/#pr.review-bot.795");
    await expect(page.getByRole("heading", { level: 2, name: "Remove the unused theme toggle" })).toBeVisible();
    await expect(page.getByText(/Dropped out of the newest report/)).toBeVisible();
  });

  test("Load older brings in the runs before the newest 30", async ({ page }) => {
    await seedReviews(Date.now(), { older: 30 });
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    const rows = page.locator("#reviews-list .rvrun a.row"), older = page.getByRole("button", { name: "Load older runs" });
    await expect(rows).toHaveCount(30);
    await older.click();
    await expect(rows).toHaveCount(34);
    await expect(older).toHaveCount(0);
    await expect(rows.last()).toContainText("Older run 30");
  });

  test("links name their routine: a PR opens in its own routine whichever was shown last, and an old link in the one shown", async ({ page }) => {
    const now = Date.now();
    await seedReviews(now);
    await seedReviews(now, { dry: true });
    await page.goto("/#reviews.review-bot");
    await page.getByRole("radio", { name: /^PRs/ }).click();
    await expect(page.locator("#reviews-list").getByRole("link", { name: new RegExp("#812 " + PR) })).toHaveAttribute("href", "#pr.review-bot.812");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    await expect(page.locator("#reviews-list .rvrun a.row").first()).toHaveAttribute("href", /^#run\.review-bot\.\d{4}-/);
    await expect(page.locator("#reviews-list .rvacts a").first()).toHaveAttribute("href", /^#pr\.review-bot\.\d+$/);

    await page.goto("/#reviews.review-bot-dry");
    await expect(page.locator("#reviews-card [aria-current]")).toHaveText("review-bot-dry");
    await page.goto("/#pr.review-bot.812");
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeVisible();
    await expect(page.locator("#reviews-card [aria-current]")).toHaveText("review-bot");
    await page.goto("/#pr.812"); // a link from before routines were named: the routine shown
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeVisible();
    await page.getByRole("radio", { name: /^PRs/ }).click();
    await expect(page.locator("#reviews-list a.row[aria-current]")).toHaveAttribute("href", "#pr.review-bot.812");
  });

  test("a run's page opened before Reviews has loaded focuses its heading once it loads", async ({ page }) => {
    const now = Date.now();
    await seedReviews(now);
    await openInbox(page);
    await page.evaluate((h) => { location.hash = h; }, "#run.review-bot." + uiPayloads(now).at(-1)!.stamp);
    await expect(page.locator("#detail h2")).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
    await expect(page.locator("#detail h2")).toBeFocused();
  });
});

test.describe("1280, codex follow-ups", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  // A run that lands now, as the routine's next one: its report is the newest one's with #799 approved.
  async function reportNewRun(now: number): Promise<void> {
    const last = uiPayloads(now).at(-1)!, started = Date.now() - 6 * 60000;
    await reportRun({
      ...last, stamp: stampOf(started), started_at: new Date(started).toISOString(), finished_at: new Date(Date.now() - 60000).toISOString(),
      report: { ...last.report!, headline: "Approved #799",
        prs: last.report!.prs.map((p) => ({ ...p, this_run: p.number === 799 ? { action: "approved" as const, url: p.url + "#pullrequestreview-79901", summary: "Docs match", changes: [] } : { action: "none" as const, url: null, summary: "", changes: [] } })) },
    });
  }

  test("after Load older, a live refresh keeps every run loaded, with none missing between the pages", async ({ page }) => {
    const now = Date.now();
    await seedReviews(now, { older: 30 });
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    const rows = page.locator("#reviews-list .rvrun a.row");
    await page.getByRole("button", { name: "Load older runs" }).click();
    await expect(rows).toHaveCount(34);
    await reportNewRun(now);
    await expect(rows.first()).toContainText("Approved #799", { timeout: 15_000 });
    await expect(rows).toHaveCount(35);
    await expect(rows.filter({ hasText: "Older run 26" })).toHaveCount(1); // the one the new run pushed off the newest page
  });

  test("a PR's page opened before Reviews has loaded keeps its heading focused once its timeline loads", async ({ page }) => {
    await seedReviews();
    await openInbox(page);
    await page.evaluate(() => { location.hash = "#pr.review-bot.812"; });
    await expect(page.locator(".rvtl .rvte").first()).toBeVisible();
    await expect(page.locator("#detail h2")).toBeFocused();
  });

  test("a gone PR that fails to load says so and offers Try again, then loads", async ({ page }) => {
    await seedReviews();
    await ageGonePr();
    let failed = false;
    await page.route(/\/api\/reviews\/review-bot\/prs\/795$/, (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.fulfill({ status: 500, json: { error: "internal", message: "boom" } });
    });
    await page.goto("/#pr.review-bot.795");
    await expect(page.getByText("#795 couldn't load.")).toBeVisible();
    await expect(page.getByText(/isn't one of/)).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Remove the unused theme toggle" })).toBeVisible();
  });

  test("Decide in Inbox shows once, in the PR's header; with two PRs needing you, the card points at the Needs you group", async ({ page, request }) => {
    await seedReviews();
    await postAsk(request, "review-bot-812-product", 812);
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    await page.goto("/#pr.review-bot.812");
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeVisible();
    await expect(page.getByRole("link", { name: "Decide in Inbox" })).toHaveCount(1);
    await expect(page.locator(".rvhead").getByRole("link", { name: "Decide in Inbox" })).toBeVisible();
    await page.locator("#reviews-card").getByRole("button", { name: "2 need you" }).click();
    await expect(page.getByRole("radio", { name: /^PRs/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#reviews-list h3", { hasText: "Needs you" })).toBeFocused();
  });
});

test.describe("390", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("Reviews takes Team's place in the bottom bar; Team is under Settings", async ({ page }) => {
    await seedReviews();
    await openQueue(page);
    const nav = mainNav(page);
    await expect(nav.getByRole("link")).toHaveText([/^Inbox/, /^Reviews/, /^Focus/, /^History/, /^Settings/]);
    await nav.getByRole("link", { name: "Settings" }).tap();
    await page.getByRole("link", { name: /^Team/ }).tap();
    await expect(page).toHaveURL(/#team$/);
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });

  test("the list, then a PR full screen with Back to Reviews; nothing scrolls sideways", async ({ page }) => {
    const w = await watchPage(page);
    await seedReviews();
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^PRs/ }).tap();
    await expect(groups(page).first()).toHaveText("Needs you 2");
    expect(await noSideways(page)).toBe(true);
    await page.getByRole("radio", { name: /^Runs/ }).tap();
    await expect(page.locator("#reviews-list .rvacts").first()).toBeVisible();
    expect(await noSideways(page)).toBe(true);

    await page.locator("#reviews-list .rvacts").first().getByRole("link", { name: /#812/ }).tap();
    await expect(page.getByRole("heading", { level: 2, name: PR })).toBeVisible();
    await expect(mainNav(page)).toBeHidden(); // full screen
    await expect(page.locator("#back-link")).toHaveText(/Reviews/);
    expect(await noSideways(page)).toBe(true);
    // One row stays under the back bar as the page scrolls: the status chip and the one action, at most 56px tall;
    // what clears it scrolls away under them.
    await expect(page.locator(".rvclears")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const box = await page.locator(".rvhline").boundingBox();
    expect(box && Math.round(box.y)).toBe(44);
    expect(box && box.height).toBeLessThanOrEqual(56);
    await expect(page.locator(".rvhline").getByRole("link", { name: /Review on GitHub/ })).toBeInViewport();
    await expect(page.locator(".rvhline .badge")).toHaveAttribute("title", "Needs you · Held · product call");
    await expect(page.locator(".rvclears")).not.toBeInViewport();
    await page.locator("#back-link").tap();
    await expect(page).toHaveURL(/#reviews$/);
    expect(await w.problems()).toEqual([]);
  });
});

test.describe("1280, codex post-merge follow-ups", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  // Requests to `url` held back until the test lets them go.
  async function hold(page: Page, url: RegExp): Promise<{ count: () => number; release: () => Promise<void> }> {
    const held: Route[] = [];
    let holding = true, seen = 0;
    await page.route(url, (route) => { seen++; return holding ? void held.push(route) : route.continue(); });
    return { count: () => seen, release: async () => { holding = false; for (const r of held.splice(0)) await r.continue(); } };
  }

  test("a gone PR's page keeps showing, its heading focused, while its refetch outlasts the routine's", async ({ page }) => {
    const now = Date.now();
    await seedReviews(now);
    await ageGonePr();
    await openInbox(page);
    await page.evaluate(() => { location.hash = "#pr.review-bot.795"; });
    const heading = page.getByRole("heading", { level: 2, name: "Remove the unused theme toggle" });
    await expect(page.locator(".rvtl")).toBeVisible();
    await expect(page.getByText("Loading the timeline…")).toHaveCount(0);
    await expect(heading).toBeFocused();
    // The next run moves the routine's head on: the routine and the PR are fetched again, the PR's answer held back.
    const pr = await hold(page, /\/api\/reviews\/review-bot\/prs\/795$/);
    const last = uiPayloads(now).at(-1)!, started = Date.now() - 6 * 60000;
    await reportRun({ ...last, stamp: stampOf(started), started_at: new Date(started).toISOString(), finished_at: new Date(Date.now() - 60000).toISOString(), report: { ...last.report!, headline: "Approved #799" } });
    await expect(page.locator("#reviews-card")).toContainText("Approved #799", { timeout: 15_000 });
    await expect.poll(pr.count).toBeGreaterThan(0);
    await expect(page.locator('#detail .skel[aria-busy="true"]')).toHaveCount(0);
    await expect(heading).toBeFocused();
    await pr.release();
    await expect(heading).toBeFocused();
  });

  test("Load older doesn't take focus back from a run opened while it loaded", async ({ page }) => {
    await seedReviews(Date.now(), { older: 30 });
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    const rows = page.locator("#reviews-list .rvrun a.row");
    await expect(rows).toHaveCount(30);
    const older = await hold(page, /\/api\/reviews\/review-bot\?.*before=/);
    await page.getByRole("button", { name: "Load older runs" }).click();
    await expect.poll(older.count).toBe(1);
    await rows.first().click();
    await expect(page.locator("#detail h2")).toBeFocused();
    await older.release();
    await expect(rows).toHaveCount(34);
    await expect(page.locator("#detail h2")).toBeFocused();
  });

  test("Load older, left alone, keeps focus at the end of the feed", async ({ page }) => {
    await seedReviews(Date.now(), { older: 30 });
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    const rows = page.locator("#reviews-list .rvrun a.row");
    await page.getByRole("button", { name: "Load older runs" }).click();
    await expect(rows).toHaveCount(34);
    await expect(rows.last()).toBeFocused();
  });

  test("v keeps focus on Runs | PRs, from a row or from the toggle, or on the row open beside the list", async ({ page }) => {
    await seedReviews();
    await page.goto("/#reviews");
    const runs = page.getByRole("radio", { name: /^Runs/ }), prs = page.getByRole("radio", { name: /^PRs/ });
    await prs.click();
    await expect(prs).toBeFocused();
    await page.keyboard.press("v");
    await expect(runs).toHaveAttribute("aria-checked", "true");
    await expect(runs).toBeFocused();
    await page.keyboard.press("j");
    await expect(page.locator("#reviews-list .rvrun a.row").first()).toBeFocused();
    await page.keyboard.press("v");
    await expect(prs).toHaveAttribute("aria-checked", "true");
    await expect(prs).toBeFocused();
    // The view switched to has the row of the page open beside the list: it takes focus.
    await page.locator("#reviews-list").getByRole("link", { name: new RegExp("#812 " + PR) }).click();
    await expect(page).toHaveURL(/#pr\.review-bot\.812$/);
    await runs.click();
    await page.keyboard.press("v");
    await expect(prs).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#reviews-list a.row[aria-current]")).toBeFocused();
  });

  test("v: with the open PR in a folded group, focus stays on Runs | PRs instead of falling to the page", async ({ page }) => {
    await seedReviews();
    await page.goto("/#reviews");
    const runs = page.getByRole("radio", { name: /^Runs/ }), prs = page.getByRole("radio", { name: /^PRs/ });
    await prs.click();
    const mine = page.locator("#reviews-list summary", { hasText: "Mine" });
    await mine.click();
    await page.locator("#reviews-list").getByRole("link", { name: /Show export progress/ }).click();
    await expect(page.locator("#reviews-list a.row[aria-current]")).toHaveText(/Show export progress/);
    await mine.click(); // fold Mine again: the open PR's row is inside it, in the DOM but not focusable
    await runs.click();
    await page.keyboard.press("v");
    await expect(prs).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#reviews-list a.row[aria-current]")).toBeHidden();
    await expect(prs).toBeFocused();
  });

  test("Load older doesn't take focus back from an action link focused while it loaded, and restores it there", async ({ page }) => {
    await seedReviews(Date.now(), { older: 30 });
    await page.goto("/#reviews");
    await page.getByRole("radio", { name: /^Runs/ }).click();
    const rows = page.locator("#reviews-list .rvrun a.row");
    await expect(rows).toHaveCount(30);
    const older = await hold(page, /\/api\/reviews\/review-bot\?.*before=/);
    await page.getByRole("button", { name: "Load older runs" }).click();
    await expect.poll(older.count).toBe(1);
    const act = page.locator("#reviews-list a.rvact").first();
    const href = await act.getAttribute("href");
    await act.focus();
    await older.release();
    await expect(rows).toHaveCount(34);
    await expect(page.locator('#reviews-list a.rvact[href="' + href + '"]').first()).toBeFocused();
  });
});

test.describe("320", () => {
  test.use({ viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("a PR's status row fits: the chip ellipsizes beside the whole action", async ({ page, request }) => {
    await seedReviews();
    await postAsk(request, "review-bot-812-product", 812);
    await page.goto("/#pr.review-bot.812");
    const line = page.locator(".rvhline"), badge = line.locator(".badge"), go = line.getByRole("link", { name: "Decide in Inbox" });
    await expect(badge).toHaveAttribute("title", "Needs you · Held · product call");
    expect(await noSideways(page)).toBe(true);
    const [l, g] = await Promise.all([line.boundingBox(), go.boundingBox()]);
    expect(l && l.height).toBeLessThanOrEqual(56);
    expect(g && g.x + g.width).toBeLessThanOrEqual(320 - 16 + 0.5);
    expect(await badge.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true); // ellipsized, not cut off by the screen
    expect(await go.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});
