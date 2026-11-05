// The note sent with "Run tick now": a text area that grows with what's typed, takes the server's whole 2,000
// characters (a 500 cap on the old single-line field cut a 10-16 note mid-sentence), and on a keyboard sends on Enter
// with Shift+Enter for a new line, while on a phone Enter is a new line and the button sends.
import type { Page, Request } from "@playwright/test";
import { expect, openInbox, openQueue, test } from "./fixtures.ts";

const LONG = "Let's get back to API v2 work. ".repeat(40).trim(); // ~1,200 characters, well past the old 500

async function openTickForm(page: Page) {
  await page.locator("#hstatus > summary").click();
  const note = page.getByRole("textbox", { name: "Note for the orchestrator (optional)" });
  await expect(note).toBeVisible();
  return note;
}
const sentNote = (r: Request) => (r.postDataJSON() as { note: string | null }).note;
const isTick = (r: Request) => r.url().endsWith("/api/meta/manager/tick-request") && r.method() === "POST";

test.describe("1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a long note grows the field, Shift+Enter adds a line, Enter sends all of it", async ({ page }) => {
    await openInbox(page);
    const note = await openTickForm(page);
    expect(await note.evaluate((el) => el.tagName)).toBe("TEXTAREA");
    const oneLine = (await note.boundingBox())!.height;

    await note.fill(LONG);
    await note.press("End");
    await note.press("Shift+Enter");
    await note.pressSequentially("we need to finish it.");
    await expect(note).toHaveValue(LONG + "\nwe need to finish it.");
    expect((await note.boundingBox())!.height).toBeGreaterThan(oneLine * 2);

    const req = page.waitForRequest(isTick);
    await note.press("Enter");
    expect(sentNote(await req)).toBe(LONG + "\nwe need to finish it.");
    await expect(page.locator("#tick-fb")).toHaveText(/^Requested/);
    await expect(note).toHaveValue("");
    expect((await note.boundingBox())!.height).toBeLessThanOrEqual(oneLine + 1); // back to one line
  });

  test("the field takes up to 2,000 characters and says so near the end", async ({ page }) => {
    await openInbox(page);
    const note = await openTickForm(page);
    await note.fill("x".repeat(2100));
    await expect(note).toHaveValue("x".repeat(2000));
    await expect(page.locator("#tick-count")).toHaveText("2,000 / 2,000");
    await note.fill("short");
    await expect(page.locator("#tick-count")).toBeHidden();
  });
});

test.describe("390", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("on a phone Enter is a new line, and Run tick now sends the whole note", async ({ page }) => {
    await openQueue(page);
    const note = await openTickForm(page);
    await note.fill(LONG);
    await note.press("End");
    let sent = false;
    page.on("request", (r) => { if (isTick(r)) sent = true; });
    await note.press("Enter");
    await note.pressSequentially("second line");
    await expect(note).toHaveValue(LONG + "\nsecond line");
    expect(sent).toBe(false);
    // 16px or more, so iOS doesn't zoom into it; and no "Enter sends" hint for a screen reader on touch.
    expect(await note.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await expect(note).not.toHaveAttribute("aria-describedby", /.+/);

    const req = page.waitForRequest(isTick);
    await page.getByRole("button", { name: "Run tick now" }).tap();
    expect(sentNote(await req)).toBe(LONG + "\nsecond line");
    await expect(note).toHaveValue("");
  });
});
