// The desk (from 1100px): the item's background in an aside beside the call, the snooze presets on the page, a key
// hint bar under the pane and the shortcuts dialog in three columns (src/views/item.ts, src/views/keys.ts).
import type { Page } from "@playwright/test";
import { SEED, expect, openItem, test } from "./fixtures.ts";
import { serverEnv } from "./support/data.ts";

test.use({ viewport: { width: 1280, height: 800 } });

test("desk: the key hint bar ends with All keys, and hides below 1100px", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const allKeys = page.getByRole("button", { name: "All keys" });
  await expect(allKeys).toBeVisible();
  await expect(page.locator("#key-hints")).toContainText(/j↓Next.*k↑Previous.*Choose.*Submit.*nNote.*Ask.*Snooze.*Back.*All keys/);
  await allKeys.click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
  await expect(page.locator("#key-hints")).toBeHidden();
  await expect(allKeys).toBeHidden();
});

test("desk: ? opens the shortcuts in three columns and Esc closes them", async ({ page }) => {
  await openItem(page, SEED.changelog);
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  // Item page, Inbox and Anywhere side by side: their headings share a top edge, left to right.
  const boxes = await Promise.all(["Item page", "Inbox", "Anywhere"].map((n) => dialog.getByRole("heading", { name: n, exact: true }).boundingBox()));
  const [a, b, c] = boxes.map((x) => x!);
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(Math.abs(b.y - c.y)).toBeLessThan(2);
  expect(a.x).toBeLessThan(b.x);
  expect(b.x).toBeLessThan(c.x);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("desk: j / ↓ and k / ↑ page through the items, ← and → don't, and the pager points up and down", async ({ page }) => {
  await openItem(page, SEED.changelog);
  await expect(page.locator("#pager-prev .parr")).toHaveText("↑");
  await expect(page.locator("#pager-next .parr")).toHaveText("↓");
  await expect(page.locator("#pager-prev")).toHaveAttribute("title", "Previous (k)");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(SEED.changelog.id + "$"));
  await page.keyboard.press("j");
  await expect(page.getByRole("heading", { level: 2, name: SEED.ntfyDigest.title })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
});

test("desk: n goes to the note, typing there types, and Esc leaves it", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const note = page.locator("#note-field");
  await page.keyboard.press("n");
  await expect(note).toBeFocused();
  await expect(note).toHaveValue(""); // the key itself isn't typed
  await page.keyboard.type("not now");
  await expect(note).toHaveValue("not now");
  await page.keyboard.press("Escape");
  await expect(note).not.toBeFocused();
  await expect(page).toHaveURL(new RegExp(SEED.changelog.id + "$")); // Esc left the field, not the item
  await page.keyboard.press("n");
  await expect(note).toBeFocused();
});

test("desk: 2 checks option 2, and s focuses the first snooze preset", async ({ page }) => {
  await openItem(page, SEED.changelog);
  // The decision keys wait out the moment after arriving; Submit turns live when it's over.
  await expect(page.getByRole("button", { name: /^Submit/ })).toBeEnabled();
  const options = page.getByRole("radiogroup", { name: "Options" }).getByRole("radio");
  await page.keyboard.press("2");
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("s");
  await expect(page.getByRole("button", { name: /^1 hour/ })).toBeFocused();
});

test("desk: the background sits in an aside beside the call, once, and goes back to the More sheet below 1100px", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const aside = page.getByRole("complementary", { name: "About this decision" });
  await expect(aside).toBeVisible();
  for (const id of ["#qa", "#snooze-menu", "#timeline"]) await expect(aside.locator(id)).toBeVisible();
  // The presets are drawn with their wake times: no Snooze… toggle, and no More (⋯) to open.
  await expect(aside.getByRole("button", { name: /^1 hour \S/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Snooze…/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More for this decision" })).toHaveCount(0);
  // The orchestrator's context opens the main column, above the title.
  const ctx = page.locator("#ctx-strip");
  await expect(ctx).toHaveAttribute("open", "");
  expect(await page.evaluate(() => {
    const c = document.getElementById("ctx-strip"), t = document.getElementById("page-title");
    return !!c && !!t && !c.closest("aside") && !!(c.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  // Every stable id once in the document, and the sheet empty.
  for (const id of ["qa", "snooze-menu", "ctx-strip", "timeline", "decide-form", "note-field", "submit-btn"]) await expect(page.locator("[id='" + id + "']")).toHaveCount(1);
  await expect(page.locator("#more-body")).toBeEmpty();

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(aside).toHaveCount(0);
  await page.getByRole("button", { name: "More for this decision" }).click();
  const sheet = page.getByRole("dialog", { name: "More for this decision" });
  await expect(sheet.locator("#qa")).toBeVisible();
  await expect(sheet.getByRole("button", { name: /Snooze…/ })).toBeVisible();
  await expect(page.locator("[id='qa']")).toHaveCount(1);
});

// Crossing 1100px moves the background between the aside and the More sheet: focus goes with the control it was on,
// never back to an option (where Enter would decide) nor to the page (where j would move on).
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "More for this decision" });

test("crossing to 1100px with a question being typed in the sheet keeps typing in the aside", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 768 });
  await openItem(page, SEED.changelog);
  await expect(page.getByRole("button", { name: /^Submit/ })).toBeEnabled();
  await page.locator("#choice-0").focus();
  await page.keyboard.press("a");
  await expect(sheetOf(page).locator("#ask-field")).toBeFocused();
  await page.keyboard.type("Does it");
  await page.setViewportSize({ width: 1280, height: 800 });
  const aside = page.getByRole("complementary", { name: "About this decision" });
  await expect(aside.locator("#ask-field")).toBeFocused();
  await expect(sheetOf(page)).toBeHidden();
  await page.waitForTimeout(100); // the sheet's close event has run
  await page.keyboard.type(" scale?");
  await page.keyboard.press("Enter");
  await expect(aside.locator("#ask-field")).toHaveValue("Does it scale?\n");
  await expect(page.locator("#choice-0")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible(); // not decided
});

test("crossing below 1100px with a question being typed in the aside opens the sheet at it", async ({ page }) => {
  await openItem(page, SEED.changelog);
  await page.getByRole("complementary", { name: "About this decision" }).getByRole("button", { name: "Ask a question" }).click();
  await page.keyboard.type("Does it");
  await page.setViewportSize({ width: 1000, height: 768 });
  await expect(sheetOf(page)).toBeVisible();
  await expect(sheetOf(page).locator("#ask-field")).toBeFocused();
  await page.keyboard.type(" scale?");
  await expect(sheetOf(page).locator("#ask-field")).toHaveValue("Does it scale?");
  await page.keyboard.press("Escape");
  await expect(sheetOf(page)).toBeHidden();
  await expect(page.getByRole("heading", { level: 2, name: SEED.changelog.title })).toBeVisible();
});

test("crossing below 1100px after s keeps focus on the snooze preset, in the sheet", async ({ page }) => {
  await openItem(page, SEED.changelog);
  await expect(page.getByRole("button", { name: /^Submit/ })).toBeEnabled();
  await page.keyboard.press("s");
  await expect(page.getByRole("button", { name: /^1 hour/ })).toBeFocused();
  await page.setViewportSize({ width: 1000, height: 768 });
  await expect(sheetOf(page)).toBeVisible();
  await expect(sheetOf(page).getByRole("button", { name: /^1 hour/ })).toBeFocused();
});

test("desk: long evidence labels and bare URLs wrap inside the aside", async ({ page, request }) => {
  const id = "desk-long-evidence";
  const put = await request.put("/agent/api/items/" + id, {
    headers: { Authorization: "Bearer " + serverEnv().token },
    data: { data: { type: "decision", title: "Long evidence", orchestrator: "O1", options: [{ id: "yes", label: "Yes" }], evidence: [
      { label: "The import run that logged four hundred change rows and woke the manager four hundred times in a row", url: "https://example.com/run" },
      // No label: the bare URL shows (src/views/rows.ts linksBlock), with no break points of its own.
      { label: "", url: "https://example.com/" + "a-very-long-path-segment-without-any-break-points-".repeat(4) + "end" },
    ] } },
  });
  expect(put.status(), await put.text()).toBe(201);
  await openItem(page, { id, title: "Long evidence" });
  const aside = page.getByRole("complementary", { name: "About this decision" });
  const links = aside.locator("#evidence .links a");
  await expect(links).toHaveCount(2);
  const box = (await aside.boundingBox())!;
  for (const l of await links.all()) {
    const b = (await l.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(await l.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  }
});

test("crossing below 1100px from an evidence link (no id of its own) keeps focus on it, in the sheet", async ({ page }) => {
  await openItem(page, SEED.changelog);
  const aside = page.getByRole("complementary", { name: "About this decision" });
  await aside.getByRole("link", { name: "Trigger definitions" }).focus();
  await page.setViewportSize({ width: 1000, height: 768 });
  await expect(sheetOf(page)).toBeVisible();
  await expect(sheetOf(page).getByRole("link", { name: "Trigger definitions" })).toBeFocused();
});

test("crossing to 1100px from the Context summary in the sheet keeps focus on it, in the aside", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 768 });
  await openItem(page, SEED.changelog);
  await page.getByRole("button", { name: "More for this decision" }).click();
  await sheetOf(page).locator("#ctx-doc > summary").focus();
  await page.setViewportSize({ width: 1280, height: 800 });
  const aside = page.getByRole("complementary", { name: "About this decision" });
  await expect(aside.locator("#ctx-doc > summary")).toBeFocused();
  await page.waitForTimeout(100); // the sheet's close event has run
  await expect(aside.locator("#ctx-doc > summary")).toBeFocused();
});

test("desk: a long session title ellipsizes in the context card instead of running into the aside", async ({ page, request }) => {
  const title = "O3 · Add migration guards and deduplicate manager wake events across every write path";
  const patch = await request.patch("/agent/api/orchestrators/O3", { headers: { Authorization: "Bearer " + serverEnv().token }, data: { data: { session_title: title } } });
  expect(patch.status(), await patch.text()).toBe(200);
  await page.setViewportSize({ width: 1100, height: 800 });
  await openItem(page, SEED.changelog);
  const name = page.locator("#ctx-strip > summary .oname");
  await expect(name).toHaveAttribute("title", title);
  const card = (await page.locator("#ctx-strip").boundingBox())!, aside = (await page.getByRole("complementary", { name: "About this decision" }).boundingBox())!;
  const n = (await name.boundingBox())!;
  expect(n.x + n.width).toBeLessThanOrEqual(card.x + card.width);
  expect(card.x + card.width).toBeLessThanOrEqual(aside.x);
});
