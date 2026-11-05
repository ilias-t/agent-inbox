// Security headers as wrangler dev serves them (dist/_headers for the UI, worker/http.ts for the
// API), and the pages running inside their Content-Security-Policy: no violation anywhere the UI
// renders something (inbox, an item with markdown, the keyboard overlay, Settings, theme switch,
// the service worker and the Web Push enable flow).

import type { Page } from "@playwright/test";
import { appCsp } from "../shared/security-headers.ts";
import { SEED, expect, openInbox, openItem, test } from "./fixtures.ts";
import { serverEnv } from "./support/data.ts";

// Every `securitypolicyviolation` the page sees, plus console errors and uncaught exceptions.
async function watchCsp(page: Page): Promise<{ violations: () => Promise<string[]>; errors: string[] }> {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(e.effectiveDirective + " " + (e.blockedURI || "inline") + " " + e.sourceFile + ":" + e.lineNumber));
  });
  return { violations: () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), errors };
}

test("headers on the UI, its files and the API", async ({ request }) => {
  const html = await request.get("/");
  expect(html.status()).toBe(200);
  const h = html.headers();
  const csp = h["content-security-policy"];
  expect(csp).toMatch(/^default-src 'self'; script-src 'self' 'sha256-[A-Za-z0-9+/]{43}='; style-src 'self';/);
  expect(csp).toBe(appCsp([csp.match(/'sha256-[^']+'/)![0]]));
  expect(h).toMatchObject({
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "strict-transport-security": "max-age=31536000",
  });
  expect(h["permissions-policy"]).toContain("camera=()");

  const asset = (await html.text()).match(/src="(\/assets\/[^"]+\.js)"/)![1];
  for (const [path, type] of [[asset, "javascript"], ["/sw.js", "javascript"], ["/manifest.webmanifest", "manifest+json"], ["/no/such/page", "text/html"]]) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    expect(r.headers()["content-type"], path).toContain(type);
    expect(r.headers()["content-security-policy"], path).toBe(csp);
    expect(r.headers()["x-content-type-options"], path).toBe("nosniff");
  }
  expect((await request.get("/_headers")).headers()["content-type"]).toContain("text/html"); // the rules file itself isn't served

  // Caching: hashed build files for a year; the page and the service worker script revalidated every time.
  for (const [path, cc] of [
    [asset, "public, max-age=31536000, immutable"],
    ["/", "public, max-age=0, must-revalidate"], // /index.html only redirects here
    ["/sw.js", "no-cache"],
  ]) expect((await request.get(path)).headers()["cache-control"], path).toBe(cc);

  for (const [path, status] of [["/api/state", 200], ["/agent/api/me", 401]] as const) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(status);
    expect(r.headers(), path).toMatchObject({
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
  }
});

test("no CSP violations across the inbox, an item, the overlay, Settings and the theme switch", async ({ page, request }) => {
  // An item whose context has the markdown the renderer emits: a link, inline code, a fence, a list, a quote.
  const id = "csp-markdown";
  const put = await request.put("/agent/api/items/" + id, {
    headers: { Authorization: "Bearer " + serverEnv().token },
    data: { data: { type: "decision", title: "Markdown under the CSP", orchestrator: "O1", context:
      "See [the docs](https://example.com/docs) and `code`.\n\n```ts\nconst x = 1;\n```\n\n- **bold** and *em*\n> quoted\n\n---\n1. one" } },
  });
  expect(put.status(), await put.text()).toBe(201);

  const csp = await watchCsp(page);
  await openInbox(page);
  await openItem(page, { id, title: "Markdown under the CSP" });
  await expect(page.getByRole("link", { name: "the docs" })).toHaveAttribute("href", "https://example.com/docs");
  await expect(page.locator("pre code")).toContainText("const x = 1;");
  await openItem(page, SEED.changelog);

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  // Below 1100px the item's secondary blocks are in the More sheet.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "More for this decision" }).click();
  await expect(page.getByRole("dialog", { name: "More for this decision" }).locator("#qa")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "More for this decision" })).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto("/#settings");
  await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
  for (const t of ["Dark", "Light", "System"]) {
    await page.getByRole("radio", { name: t }).click();
    await expect(page.getByRole("radio", { name: t })).toHaveAttribute("aria-checked", "true");
  }
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.reload(); // the inline theme script (allowed by hash) applies the saved theme before paint
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // The bundled fonts (Instrument Sans for the UI, Geist Mono for code) load from 'self'.
  expect(await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = ['16px "Instrument Sans Variable"', '16px "Geist Mono Variable"'];
    const loaded = await Promise.all(faces.map((f) => document.fonts.load(f)));
    return loaded.map((l, i) => l.length > 0 && l.every((face) => face.status === "loaded") && document.fonts.check(faces[i]));
  })).toEqual([true, true]);
  expect(await csp.violations()).toEqual([]);
  expect(csp.errors).toEqual([]);
});

test("the violation watch does catch one (so the empty lists above mean something)", async ({ page }) => {
  const csp = await watchCsp(page);
  await openInbox(page);
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div style="color:red"></div>'));
  await expect.poll(csp.violations).toEqual([expect.stringMatching(/^style-src-attr inline/)]);
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("registers, and the Web Push enable flow raises no CSP violation", async ({ page }) => {
    // Playwright's headless shell reports notifications as denied whatever is granted, which would hide
    // the button; say yes here. Registration, the server key fetch and subscribe() all still run for real.
    await page.addInitScript(() => {
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      Notification.requestPermission = async () => "granted";
    });
    const csp = await watchCsp(page);
    await page.goto("/#settings");
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(serverEnv().baseURL + "/");

    const enable = page.getByRole("button", { name: "Enable notifications on this device" });
    await expect(enable).toBeEnabled();
    await enable.click();
    // Headless Chromium has no push service, so subscribe() may fail there; the page reports either outcome.
    const status = page.locator("#push-body .status");
    await expect(status).toHaveText(/^(On\.|Couldn't turn notifications on)/, { timeout: 15_000 });
    test.info().annotations.push({ type: "web push", description: (await status.textContent()) ?? "" });

    // Now controlled by the worker: the page and its assets come through it, still under the policy.
    await page.reload();
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
    expect(await csp.violations()).toEqual([]);
    expect(csp.errors.filter((e) => /Content Security Policy|Permissions-Policy/i.test(e))).toEqual([]);
  });
});
