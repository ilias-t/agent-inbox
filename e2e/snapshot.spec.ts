// Instant open: the last good state is saved on the device (IndexedDB), rendered at once on the next open, then
// revalidated with a delta from its cursor (src/lib/snapshot.ts, src/main.ts boot).
import type { Page } from "@playwright/test";
import { SEED, expect, inboxRow, openInbox, test } from "./fixtures.ts";
import { serverEnv } from "./support/data.ts";

// The cursor of the snapshot saved on this device, or null when there is none.
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

test("a reload shows the saved copy before the server answers, then the delta brings what changed", async ({ page, request }) => {
  await openInbox(page);
  await expect.poll(() => savedCursor(page)).not.toBeNull();
  const cursor = await savedCursor(page);
  await page.goto("about:blank"); // the inbox is closed: it can't see what happens next live

  // Meanwhile, elsewhere: a new ask.
  const put = await request.put("/agent/api/items/e2e-while-away", {
    headers: { Authorization: "Bearer " + serverEnv().token },
    data: { data: { type: "decision", title: "Posted while the inbox was closed", question: "Posted while the inbox was closed?", orchestrator: "O1" } },
  });
  expect(put.status(), await put.text()).toBe(201);

  // The revalidation waits until the saved copy has been checked on screen.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const apiCalls: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/state")) apiCalls.push(u.pathname + u.search); });
  await page.route("**/api/state/delta**", async (route) => { await held; await route.continue(); });

  await page.goto("/#inbox");
  await expect(inboxRow(page, SEED.changelog.headline)).toBeVisible();
  await expect(inboxRow(page, "Posted while the inbox was closed?")).toHaveCount(0);

  release();
  await expect(inboxRow(page, "Posted while the inbox was closed?")).toBeVisible();
  expect(apiCalls).toEqual(["/api/state/delta?since=" + cursor]); // no full /api/state
});

test("a signed-out session clears the saved copy instead of showing it", async ({ page }) => {
  await openInbox(page);
  await expect.poll(() => savedCursor(page)).not.toBeNull();

  // The Access session is gone: every API call answers 401.
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
  await page.reload();
  await expect(page.locator("#inbox-list").getByText("Signed out.")).toBeVisible();
  await expect(page.locator("#inbox-list a.row")).toHaveCount(0);
  await expect.poll(() => savedCursor(page)).toBeNull();
});
