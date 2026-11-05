// Phones open on the top ask (src/lib/landing.ts, src/main.ts): once per session, from the Inbox, when something needs
// you, with Back to the queue. Never over an item the app was opened on (a push tap); mid and desk open on the list.
import type { Page } from "@playwright/test";
import { SEED, archiveOpen, expect, inboxRow, itemHash, openInbox, test } from "./fixtures.ts";

const at = (id: string) => new RegExp(itemHash(id).replace(/\./g, "\\.") + "$");

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("opening the Inbox lands on the top ask; Back returns to the queue, and a reload stays there", async ({ page }) => {
    await page.goto("/#inbox");
    await expect(page).toHaveURL(at(SEED.stagingToken.id));
    await expect(page.getByRole("heading", { level: 2, name: SEED.stagingToken.title })).toBeVisible();
    await expect(page.locator("#page-title")).not.toBeFocused(); // a cold start, as a push tap's: no focus moved
    // The focus strip: the manager's status (to the queue, where its card is) and the way back up, "Queue".
    await expect(page.locator("#focus-status")).toBeVisible();
    await expect(page.locator("#focus-status")).toHaveText("Orchestrator status: " + await page.locator("#tick-text").textContent());
    await expect(page.getByRole("link", { name: "Queue", exact: true })).toBeVisible();
    // The peek stack: what follows, as one link to the queue.
    await expect(page.getByRole("link", { name: "Up next: 4 more asks and 1 decided for you. Open the queue.", exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/#inbox$/);
    const row = inboxRow(page, SEED.stagingToken.headline);
    await expect(row).toBeVisible();
    await expect(row).toBeFocused(); // the row that was open

    await page.reload();
    await expect(inboxRow(page, SEED.stagingToken.headline)).toBeVisible();
    await expect(page).toHaveURL(/#inbox$/); // decided with the data, before the rows rendered: no jump coming
  });

  test("the peek stack and Queue both lead to the queue", async ({ page }) => {
    await page.goto("/#inbox");
    await expect(page).toHaveURL(at(SEED.stagingToken.id));
    await page.getByRole("link", { name: /^Up next:/ }).tap();
    await expect(page).toHaveURL(/#inbox$/);
    await inboxRow(page, SEED.changelog.headline).tap();
    await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
    // Further down the queue, the stack holds what's after this one.
    await expect(page.getByRole("link", { name: "Up next: 3 more asks and 1 decided for you. Open the queue.", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Queue", exact: true }).tap();
    await expect(page).toHaveURL(/#inbox$/);
  });

  test("an item the app was opened on (a push tap) isn't overridden", async ({ page }) => {
    await page.goto("/" + itemHash(SEED.ntfyDigest.id));
    await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(at(SEED.ntfyDigest.id));
    await expect(page.locator("#page-title")).not.toBeFocused();
    // That was this session's opening: back on the queue, a reload stays there.
    await page.getByRole("link", { name: "Queue", exact: true }).tap();
    await expect(inboxRow(page, SEED.stagingToken.headline)).toBeVisible();
    await page.reload();
    await expect(inboxRow(page, SEED.stagingToken.headline)).toBeVisible();
    await expect(page).toHaveURL(/#inbox$/);
  });

  test("a session that opened on History doesn't land later, and an item outside the queue has no peek stack", async ({ page }) => {
    await page.goto("/#history");
    const row = page.locator("#history-list a.row").first();
    await row.tap();
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.locator("#peek")).toBeHidden(); // decided: nothing in the queue comes "next" after it
    await page.goto("/#inbox");
    await expect(inboxRow(page, SEED.stagingToken.headline)).toBeVisible();
    await expect(page).toHaveURL(/#inbox$/);
  });

  test("with sessionStorage refused (private mode), a reload of the queue still doesn't land again", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("refused", "SecurityError"); } });
    });
    await page.goto("/#inbox");
    await expect(page).toHaveURL(at(SEED.stagingToken.id));
    await page.goBack();
    await expect(inboxRow(page, SEED.stagingToken.headline)).toBeVisible();
    await page.reload();
    await expect(inboxRow(page, SEED.stagingToken.headline)).toBeVisible();
    await expect(page).toHaveURL(/#inbox$/);
  });

  test("a navigation the page hasn't routed yet when the data arrives wins over the landing", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route("**/api/state**", async (route) => { await held; await route.continue(); });
    // Ahead of the app's own listener (listeners on window run in the order they were added): holds one hashchange.
    await page.addInitScript(() => {
      const w = window as unknown as { holdHash?: boolean };
      window.addEventListener("hashchange", (e) => { if (w.holdHash) { w.holdHash = false; e.stopImmediatePropagation(); } });
    });
    await page.goto("/#inbox");
    // The URL moves to History, but its hashchange isn't handled before the data lands.
    await page.evaluate(() => { (window as unknown as { holdHash?: boolean }).holdHash = true; location.hash = "#history"; });
    release();
    await expect(page.locator("#inbox-list a.row").first()).toBeVisible(); // the data is in, still shown as the Inbox
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#history$/);
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    await expect(page.locator("#history-list a.row").first()).toBeVisible();
  });

  test("with nothing that needs you it stays on the Inbox: Inbox clear", async ({ page, request }) => {
    await archiveOpen(request);
    await page.goto("/#inbox");
    await expect(page.locator("#inbox-list").getByText("Inbox clear.")).toBeVisible();
    await expect(page).toHaveURL(/#inbox$/);
  });

  test("an FYI isn't an ask: with only one left it stays on the Inbox", async ({ page, request }) => {
    await archiveOpen(request, [SEED.retryBudget.id]);
    await page.goto("/#inbox");
    await expect(inboxRow(page, SEED.retryBudget.headline)).toBeVisible();
    await expect(page).toHaveURL(/#inbox$/);
  });

  test("going elsewhere before the inbox loads cancels the landing", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route("**/api/state**", async (route) => { await held; await route.continue(); });
    await page.goto("/#inbox");
    await page.evaluate(() => { location.hash = "#history"; });
    release();
    await expect(page.locator("#history-list a.row").first()).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#history$/);
  });

  test("a landing on the saved copy moves on when the server says that item closed meanwhile", async ({ page, request }) => {
    await page.goto("/#inbox");
    await expect(page).toHaveURL(at(SEED.stagingToken.id));
    await expect.poll(() => savedCursor(page), { timeout: 15_000 }).not.toBeNull(); // saved a moment after the sync, when idle
    // A new session (as a new PWA launch would be), the app closed, and meanwhile the top ask is dealt with elsewhere.
    await page.evaluate(() => sessionStorage.clear());
    await page.goto("about:blank");
    await archiveOpen(request, [SEED.changelog.id, SEED.ntfyDigest.id, SEED.prReady.id, SEED.d1Usage.id, SEED.retryBudget.id]);

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route("**/api/state/delta**", async (route) => { await held; await route.continue(); });
    await page.goto("/#inbox");
    // The saved copy still has it at the top: the page lands on it, then the server's answer moves it on.
    await expect(page).toHaveURL(at(SEED.stagingToken.id));
    await expect(page.getByRole("heading", { level: 2, name: SEED.stagingToken.title })).toBeVisible();
    release();
    await expect(page).toHaveURL(at(SEED.changelog.id));
    await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#inbox$/); // in place of the closed one: Back still goes to the queue
    // And so does going up from it: Forward to it, then u steps back instead of adding an entry.
    await page.goForward();
    await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
    const len = await page.evaluate(() => history.length);
    await page.keyboard.press("u");
    await expect(page).toHaveURL(/#inbox$/);
    expect(await page.evaluate(() => history.length)).toBe(len);
  });
});

test("desktop opens on the list, never on an item", async ({ page }) => {
  await openInbox(page);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/#inbox$/);
  await expect(page.locator("#focus-status")).toBeHidden();
  await expect(page.locator("#peek")).toBeHidden();
});

// The cursor of the snapshot saved on this device (src/lib/snapshot.ts), or null when there is none.
function savedCursor(page: Page): Promise<number | null> {
  return page.evaluate(() => new Promise<number | null>((resolve) => {
    const req = indexedDB.open("agent-inbox", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("snapshot"); };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction("snapshot", "readonly").objectStore("snapshot").get("state");
      get.onsuccess = () => { db.close(); resolve(get.result ? get.result.state.cursor : null); };
      get.onerror = () => { db.close(); resolve(null); };
    };
  }));
}
