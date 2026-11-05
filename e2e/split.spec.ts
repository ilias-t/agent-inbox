// The split view (from 700px): the list beside the open item, each pane scrolling on its own (src/main.ts route()).
import type { Page } from "@playwright/test";
import { SEED, expect, inboxRow, itemHash, mainNav, openInbox, openItem, test } from "./fixtures.ts";
import { seedArchived, serverEnv } from "./support/data.ts";

const at = (id: string) => new RegExp(itemHash(id).replace(/\./g, "\\.") + "$");
// The page itself doesn't scroll in the split view: only its panes do.
async function pageDoesNotScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight, window.scrollY])).toEqual([vp(page).height, vp(page).height, 0]);
}
const vp = (page: Page) => page.viewportSize()!;

for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
  test.describe(size.width + "×" + size.height, () => {
    test.use({ viewport: size });

    test("an item shows beside the list, its row current; j moves on and the row follows", async ({ page }) => {
      await openItem(page, SEED.changelog);
      await expect(page.locator("#index-view")).toBeVisible();
      await expect(page.locator("#back-link")).toBeHidden(); // the list is right there
      const row = inboxRow(page, SEED.changelog.headline);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("aria-current", "true");
      await expect(page.locator("#inbox-list a.row[aria-current]")).toHaveCount(1);
      // One Submit in the accessibility tree: the pane's footer, not the phone's bar.
      await expect(page.getByRole("button", { name: /^Submit/ })).toHaveCount(1);
      await expect(page.locator("#decide-form").getByText("Next: " + SEED.ntfyDigest.headline)).toBeVisible();

      await page.keyboard.press("j");
      await expect(page).toHaveURL(at(SEED.ntfyDigest.id));
      await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();
      await expect(inboxRow(page, SEED.ntfyDigest.headline)).toHaveAttribute("aria-current", "true");
      await expect(row).not.toHaveAttribute("aria-current", "true");

      // Down to the FYI row at the end of the list: the list pane scrolls to keep the current row in view.
      for (const next of [SEED.prReady, SEED.d1Usage, SEED.retryBudget]) {
        await page.keyboard.press("j");
        await expect(page).toHaveURL(at(next.id));
        // The hash changes at once, the route (and the pager's new next) a moment later: wait for the page.
        await expect(page.getByRole("heading", { level: 2, name: next.title })).toBeVisible();
      }
      const last = inboxRow(page, SEED.retryBudget.headline);
      await expect(last).toHaveAttribute("aria-current", "true");
      await expect(last).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBe(0); // the page itself never scrolls
    });

    test("deciding drops the row from the list beside the item, live", async ({ page }) => {
      await openItem(page, SEED.changelog);
      const submit = page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true });
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect(page.getByRole("status").filter({ hasText: /^Decided: Keep triggers, filter by actor/ })).toBeVisible();
      await expect(page).toHaveURL(at(SEED.ntfyDigest.id));
      await expect(page.locator("#index-view")).toBeVisible();
      await expect(inboxRow(page, SEED.changelog.headline)).toHaveCount(0);
      await expect(page.locator("#count-inbox")).toHaveText("4");
      await expect(inboxRow(page, SEED.ntfyDigest.headline)).toHaveAttribute("aria-current", "true");
    });

    test("u goes back to the list with the row focused, and the placeholder offers the top ask", async ({ page }) => {
      await openInbox(page);
      const placeholder = page.locator("#split-empty");
      await expect(placeholder.getByText("Select an item")).toBeVisible();
      await expect(placeholder.getByRole("link", { name: "Start with the top ask" })).toHaveAttribute("href", itemHash(SEED.stagingToken.id));

      await inboxRow(page, SEED.changelog.headline).click();
      await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeFocused();
      await expect(placeholder).toBeHidden();
      await page.keyboard.press("u");
      await expect(page).toHaveURL(/#inbox$/);
      await expect(inboxRow(page, SEED.changelog.headline)).toBeFocused();
      await expect(page.locator("#inbox-list a.row[aria-current]")).toHaveCount(0);
      await expect(placeholder.getByText("Select an item")).toBeVisible();
    });

    test("the list beside an item keeps updating: its row drops Answered once seen; History stays History", async ({ page }) => {
      await openInbox(page);
      const row = inboxRow(page, SEED.ntfyDigest.headline);
      await expect(row).toContainText("Answered");
      await row.click();
      await expect(page.getByRole("button", { name: /Orchestrator answered your question/ })).toBeVisible();
      await expect(row).not.toContainText("Answered");

      await page.goto("/#history");
      const past = page.locator("#history-list a.row").first();
      const href = await past.getAttribute("href");
      await past.click();
      await expect(page).toHaveURL(new RegExp(href!.replace(/\./g, "\\.") + "$"));
      await expect(page.locator("#view-history")).toBeVisible();
      await expect(page.locator("#view-inbox")).toBeHidden();
      await expect(past).toHaveAttribute("aria-current", "true");
    });

    test("the page itself never scrolls: Inbox, History with hundreds of rows, an item, after a", async ({ page }) => {
      await seedArchived(300);
      await openInbox(page);
      await pageDoesNotScroll(page);
      await page.goto("/#history");
      await expect(page.locator("#history-list a.row").nth(50)).toBeAttached();
      await pageDoesNotScroll(page);
      await page.mouse.move(vp(page).width - 200, vp(page).height / 2);
      await page.mouse.wheel(0, 2000);
      await pageDoesNotScroll(page);
      await openItem(page, SEED.prReady);
      await pageDoesNotScroll(page);
      await page.keyboard.press("a");
      await pageDoesNotScroll(page);
    });

    test("the Inbox filter changed beside an item moves its place in the queue too", async ({ page }) => {
      await openItem(page, SEED.changelog);
      const status = await page.evaluate(async (id) => (await fetch("/api/items/" + encodeURIComponent(id), {
        method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ data: { assignee: "dev@localhost" } }),
      })).status, SEED.changelog.id);
      expect(status).toBe(200);
      const mine = page.locator("#inbox-filter").getByRole("radio", { name: /^Mine/ });
      await expect(mine).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#pager .ppos")).toHaveText("2 of 6");
      await mine.click();
      await expect(page.locator("#inbox-list a.row")).toHaveCount(1);
      await expect(page.locator("#pager .ppos")).toHaveText("1 of 1");
      await expect(page.locator("#call-next")).toHaveText("Then back to the inbox");
      await expect(page.locator("#pager-next")).toHaveCount(0);
    });

    test("Override… on the FYI row of the item already open opens its override note", async ({ page }) => {
      await openItem(page, SEED.retryBudget);
      await expect(page.locator("#ovr-box")).toBeHidden();
      await page.locator("#view-inbox").getByRole("button", { name: /^Override/ }).click();
      await expect(page.locator("#ovr-box")).toBeVisible();
      await expect(page.locator("#note-field")).toBeFocused();
      await expect(page).toHaveURL(at(SEED.retryBudget.id));
    });

    test("narrowed below 700px it's the phone's item page, the note and focus kept; widened, the split again", async ({ page }) => {
      await openItem(page, SEED.changelog);
      // The settle window after arriving is over (Submit is live), so nothing redraws the bar under the test.
      await expect(page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true })).toBeEnabled();
      const note = page.getByRole("textbox", { name: /^Note/ });
      await note.fill("Ship it today.");
      await expect(note).toBeFocused();

      await page.setViewportSize({ width: 600, height: size.height });
      await expect(page.locator("#index-view")).toBeHidden();
      const bar = page.getByRole("navigation", { name: "Inbox items" });
      const submit = bar.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true });
      await expect(submit).toBeVisible();
      const box = await submit.boundingBox();
      expect(box && box.y + box.height).toBeGreaterThan(size.height - 110); // the bottom bar
      await expect(page.getByRole("button", { name: /^Submit/ })).toHaveCount(1);
      await expect(note).toHaveValue("Ship it today.");
      await expect(note).toBeFocused();

      await page.setViewportSize(size);
      await expect(page.locator("#index-view")).toBeVisible();
      await expect(inboxRow(page, SEED.changelog.headline)).toHaveAttribute("aria-current", "true");
      await expect(note).toHaveValue("Ship it today.");
      await expect(page).toHaveURL(at(SEED.changelog.id));
    });
  });
}

// Live updates held (the change feed never answers): what follows shows only from the page's own redraws.
async function holdLiveUpdates(page: Page): Promise<void> {
  for (const url of ["**/api/changes**", "**/api/state/delta**"]) await page.route(url, () => { /* left pending */ });
}

test.describe("1280×800, from the item page", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Looks good on the open item's own row drops it from the list at once", async ({ page }) => {
    await holdLiveUpdates(page);
    await openItem(page, SEED.retryBudget);
    const row = inboxRow(page, SEED.retryBudget.headline);
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#detail").getByRole("button", { name: "Looks good" })).toBeEnabled(); // settled
    await page.locator("#view-inbox").getByRole("button", { name: /^Looks good/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Archived: looks good" })).toBeVisible();
    await expect(row).toHaveCount(0, { timeout: 2000 });
  });

  test("a decision beside the list shows in History too, before any live update", async ({ page }) => {
    await openInbox(page);
    await holdLiveUpdates(page);
    // History built while shown, then hidden again (in-page navigation, no reload).
    await mainNav(page).getByRole("link", { name: /History/ }).click();
    await expect(page.locator("#history-list a.row").first()).toBeVisible();
    await mainNav(page).getByRole("link", { name: /Inbox/ }).click();
    await inboxRow(page, SEED.changelog.headline).click();
    const submit = page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(at(SEED.ntfyDigest.id));
    await mainNav(page).getByRole("link", { name: /History/ }).click();
    await expect(page.locator("#view-history").getByRole("link", { name: SEED.changelog.headline })).toContainText("Keep triggers, filter by actor", { timeout: 2000 });
  });

  test("with the filter hiding the open item, Submit goes on to the next item the pager shows", async ({ page }) => {
    // The next item is assigned to me, so Mine shows it and not the open one.
    const auth = { Accept: "application/json", "Content-Type": "application/json" };
    await openItem(page, SEED.changelog);
    const status = await page.evaluate(async ([id, h]) => (await fetch("/api/items/" + encodeURIComponent(id), {
      method: "PATCH", headers: h, body: JSON.stringify({ data: { assignee: "dev@localhost" } }),
    })).status, [SEED.ntfyDigest.id, auth] as const);
    expect(status).toBe(200);
    const mine = page.locator("#inbox-filter").getByRole("radio", { name: /^Mine/ });
    await expect(mine).toBeVisible({ timeout: 10_000 });
    await mine.click();
    await expect(page.locator("#inbox-list a.row")).toHaveCount(1);
    await expect(page.locator("#call-next")).toHaveText("Next: " + SEED.ntfyDigest.headline);
    await expect(page.locator("#pager-next")).toHaveAttribute("href", itemHash(SEED.ntfyDigest.id));
    const submit = page.getByRole("button", { name: "Submit: Keep triggers, filter by actor", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(at(SEED.ntfyDigest.id));
  });

  test("paging keeps the way back to the orchestrator an item was opened from; a Team row beside it opens that one", async ({ page }) => {
    await page.goto("/#orch.O3");
    await page.locator("#detail").getByRole("link", { name: SEED.changelog.headline }).click();
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#orch.O3");
    await page.keyboard.press("j"); // paging keeps the way back
    await expect(page).toHaveURL(at(SEED.ntfyDigest.id));
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#orch.O3");
    const o1 = teamRow(page, "O1");
    await o1.click();
    await expect(page).toHaveURL(/#orch\.O1$/);
    await expect(o1).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("u");
    await expect(page).toHaveURL(/#team$/);
  });

  test("a row clicked beside an item opened from an orchestrator page on a phone, then widened, goes back to the list", async ({ page }) => {
    // On a phone the orchestrator page is alone, and the list kept for later is the Inbox's.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#orch.O3");
    await page.locator("#detail").getByRole("link", { name: SEED.changelog.headline }).click();
    await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("#view-inbox")).toBeVisible();
    await expect(page.locator("#back-link")).toHaveAttribute("href", "#orch.O3");
    await inboxRow(page, SEED.stagingToken.headline).click();
    await expect(page).toHaveURL(at(SEED.stagingToken.id));
    await expect(page.locator("#back-link")).toBeHidden();
    await page.keyboard.press("u");
    await expect(page).toHaveURL(/#inbox$/);
  });

  test("a question asked shows on the row beside the item at once", async ({ page }) => {
    await openItem(page, SEED.prReady);
    const row = inboxRow(page, SEED.prReady.headline);
    await expect(row).not.toContainText("? asked");
    const qa = page.locator("#qa");
    await qa.getByRole("button", { name: "Ask a question" }).click();
    await qa.getByRole("textbox", { name: /Your question/ }).fill("Does this cover ntfy too?");
    await qa.getByRole("button", { name: "Send question" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Question sent/ })).toBeVisible();
    await expect(row).toContainText("? asked");
  });

  test("an item opened from an orchestrator page shows the way back to it, and u goes there", async ({ page }) => {
    await page.goto("/#orch.O3");
    await page.locator("#detail").getByRole("link", { name: SEED.changelog.headline }).click();
    await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
    const back = page.locator("#back-link");
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "#orch.O3");
    await page.keyboard.press("u");
    await expect(page).toHaveURL(/#orch\.O3$/);
  });
});

// The Team tab in the split view: an orchestrator page opens beside the Team list, as an item does beside its list.
const atOrch = (id: string) => new RegExp("#orch\\." + id + "$");
const teamRow = (page: Page, id: string) => page.locator("#view-team a.orow").filter({ has: page.locator(".oid", { hasText: new RegExp("^" + id + "$") }) });
async function openTeam(page: Page): Promise<void> {
  await page.goto("/#team");
  await expect(page.locator("#team-list a.orow").first()).toBeVisible();
}

for (const size of [{ width: 900, height: 700 }, { width: 1280, height: 800 }]) {
  test.describe("Team, " + size.width + "×" + size.height, () => {
    test.use({ viewport: size });

    test("an orchestrator opens beside the Team list, its row current", async ({ page }) => {
      await openTeam(page);
      await expect(page.locator("#split-empty").getByText("Select a manager")).toBeVisible();
      await expect(page.locator("#split-empty").getByText("Its briefing opens here, beside the list.")).toBeVisible();
      await teamRow(page, "O3").click();
      await expect(page).toHaveURL(atOrch("O3"));
      await expect(page.getByRole("heading", { level: 2, name: /Move the change log off triggers/ })).toBeFocused();
      await expect(page.locator("#view-team")).toBeVisible();
      await expect(teamRow(page, "O3")).toHaveAttribute("aria-current", "true");
      await expect(page.locator("#team-list a.row[aria-current]")).toHaveCount(1);
      await expect(page.locator("#split-empty")).toBeHidden();
      await expect(page.locator("#back-link")).toBeHidden(); // the list is right there
      // The briefing is in the right pane, beside the list.
      const list = (await page.locator("#index-view").boundingBox())!, pane = (await page.locator("#detail-view").boundingBox())!;
      expect(pane.x).toBeGreaterThanOrEqual(list.x + list.width - 1);
      expect(pane.x + pane.width).toBeCloseTo(size.width, 0);
      await expect(mainNav(page).getByRole("link", { name: /Team/ })).toHaveAttribute("aria-current", "page");
    });

    test("j and k move between orchestrators, the row following; Esc goes back to the list with the row focused", async ({ page }) => {
      await openTeam(page);
      await teamRow(page, "O2").click();
      await expect(page).toHaveURL(atOrch("O2"));
      // The URL moves before the hashchange is handled: wait for the page, or the first j can land on the list.
      await expect(teamRow(page, "O2")).toHaveAttribute("aria-current", "true");
      await expect(page.locator("#detail .okick .oid")).toHaveText("O2");
      for (const [key, id] of [["j", "O3"], ["j", "O1"], ["j", "O1"], ["k", "O3"]] as const) {
        await page.keyboard.press(key);
        await expect(page).toHaveURL(atOrch(id));
        await expect(page.locator("#detail .okick .oid")).toHaveText(id);
        await expect(teamRow(page, id)).toHaveAttribute("aria-current", "true");
        await expect(page.locator("#team-list a.row[aria-current]")).toHaveCount(1);
      }
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/#team$/);
      await expect(teamRow(page, "O3")).toBeFocused();
      await expect(page.locator("#team-list a.row[aria-current]")).toHaveCount(0);
      await expect(page.locator("#split-empty").getByText("Select a manager")).toBeVisible();
    });

    test("an item opened from an orchestrator page keeps the Team list beside it, and back goes to the orchestrator", async ({ page }) => {
      await openTeam(page);
      await teamRow(page, "O3").click();
      await page.locator("#detail").getByRole("link", { name: SEED.changelog.headline }).click();
      await expect(page).toHaveURL(at(SEED.changelog.id));
      await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
      await expect(page.locator("#view-team")).toBeVisible();
      await expect(page.locator("#view-inbox")).toBeHidden();
      await expect(teamRow(page, "O3")).toHaveAttribute("aria-current", "true"); // where back goes
      const back = page.locator("#back-link");
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute("href", "#orch.O3");
      await page.keyboard.press("u");
      await expect(page).toHaveURL(atOrch("O3"));
      await expect(page.locator("#view-team")).toBeVisible();
      await expect(teamRow(page, "O3")).toHaveAttribute("aria-current", "true");
      await page.keyboard.press("u");
      await expect(page).toHaveURL(/#team$/);
    });

    test("opened by its link, an orchestrator page has the Team list beside it, which keeps updating live", async ({ page, request }) => {
      await page.goto("/#orch.O1");
      await expect(page.getByRole("heading", { level: 2, name: /Deduplicate GitHub webhook retries/ })).toBeVisible();
      await expect(page.locator("#view-team")).toBeVisible();
      await expect(teamRow(page, "O1")).toHaveAttribute("aria-current", "true");
      const goal = "Retire the webhook retry queue";
      const patch = await request.patch("/agent/api/orchestrators/O2", { headers: { Authorization: "Bearer " + serverEnv().token }, data: { data: { goal } } });
      expect(patch.status(), await patch.text()).toBe(200);
      await expect(teamRow(page, "O2")).toContainText(goal, { timeout: 10_000 });
      await expect(teamRow(page, "O1")).toHaveAttribute("aria-current", "true");
      await expect(page).toHaveURL(atOrch("O1"));
    });

    test("the page itself never scrolls: Team, an orchestrator page, after a wheel over it", async ({ page }) => {
      await openTeam(page);
      await pageDoesNotScroll(page);
      await teamRow(page, "O3").click();
      await expect(page.getByRole("heading", { level: 2, name: /Move the change log off triggers/ })).toBeVisible();
      await pageDoesNotScroll(page);
      await page.mouse.move(vp(page).width - 200, vp(page).height / 2);
      await page.mouse.wheel(0, 2000);
      await pageDoesNotScroll(page);
    });
  });
}

test("an orchestrator page opened from an Inbox item keeps its way back to the Inbox through a widen and a narrow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openItem(page, SEED.changelog);
  await page.evaluate(() => { location.hash = "#orch.O3"; }); // its "Open O3 briefing"
  const back = page.locator("#back-link");
  await expect(page.getByRole("heading", { level: 2, name: /Move the change log off triggers/ })).toBeVisible();
  await expect(back).toHaveAttribute("href", "#inbox");
  // Wide, the Team list shows beside it; where Back goes doesn't change.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("#view-team")).toBeVisible();
  await expect(teamRow(page, "O3")).toHaveAttribute("aria-current", "true");
  await expect(back).toHaveAttribute("href", "#inbox");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#index-view")).toBeHidden();
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute("href", "#inbox");
  await expect(back).toHaveText(/Inbox/);
  // And Back, wide again, goes there too.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#inbox$/);
  await expect(page.locator("#view-inbox")).toBeVisible();
});

test.describe("Team, 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a phone opens an orchestrator full screen, with a back link to the team", async ({ page }) => {
    await openTeam(page);
    await teamRow(page, "O3").click();
    await expect(page).toHaveURL(atOrch("O3"));
    await expect(page.getByRole("heading", { level: 2, name: /Move the change log off triggers/ })).toBeVisible();
    await expect(page.locator("#index-view")).toBeHidden();
    const back = page.locator("#back-link");
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "#team");
    await expect(back).toHaveText(/Team/);
    await back.click();
    await expect(page).toHaveURL(/#team$/);
    await expect(page.locator("#detail-view")).toBeHidden();
  });
});
