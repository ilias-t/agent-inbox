// The Run button on the Reviews tab's routine card (docs/reviews.md "Run requests"): a human asks, the button holds
// while the request waits and its run goes, and the card says how it ended. The runner's poller is played here by the
// routine's own token through the CLI, making the calls a poller makes (docs/reviews.md "Writing a runner").
import { stampOf, uiPayloads } from "../test/fixtures/review-ui.ts";
import { expect, test } from "./fixtures.ts";
import { reportRun, routineCli, seedReviews, watchPage } from "./support/reviews.ts";

test.use({ viewport: { width: 390, height: 844 } });

test("ask for a run, watch it picked up, run and finish; a second ask is refused meanwhile", async ({ page }) => {
  const w = await watchPage(page);
  await seedReviews();
  page.on("dialog", (d) => void d.accept());
  await page.goto("/#reviews");
  const card = page.locator("#reviews-card"), button = card.getByRole("button", { name: "Run bot review" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(card).toContainText("waiting for the runner to pick it up");
  await expect(card.locator("[data-rv-run]")).toBeDisabled();
  await expect(card.locator("[data-rv-run]")).toHaveText("Requested");

  // The server holds it too: a second ask is 409, and a reload still shows it held.
  expect((await page.request.post("/api/reviews/review-bot/run-request", { data: {} })).status()).toBe(409);
  await page.reload();
  await expect(card.locator("[data-rv-run]")).toBeDisabled();

  // The poller picks it up, then starts the run.
  const id = /^(rq-\S+)/.exec(await routineCli(["reviews", "request"]))![1];
  await routineCli(["reviews", "request-update", id, "starting", "--message", "waiting for 4 GB of free memory"]);
  await expect(card).toContainText("Picked up at");
  await expect(card).toContainText("waiting for 4 GB of free memory");
  const now = Date.now(), stamp = stampOf(now);
  await routineCli(["reviews", "request-update", id, "started", "--stamp", stamp]);
  await routineCli(["reviews", "start", stamp]);
  await expect(card.locator("[data-rv-run]")).toHaveText("Running");
  await expect(card).toContainText("Your run started");
  await expect(card.getByRole("link", { name: "View run" })).toHaveAttribute("href", "#run.review-bot." + stamp);

  // It reports: the button is back, and the card links the finished run.
  const last = uiPayloads(now).at(-1)!;
  await reportRun({ ...last, stamp, started_at: new Date(now).toISOString(), finished_at: new Date(now + 60_000).toISOString() });
  await expect(card.getByRole("button", { name: "Run bot review" })).toBeEnabled();
  await expect(card).toContainText("Requested run finished at");
  await card.getByRole("link", { name: "View run" }).click();
  await expect(page).toHaveURL(new RegExp("#run\\.review-bot\\." + stamp + "$"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await w.problems()).toEqual([]);
});

test("a skipped request says why, and the button is back", async ({ page }) => {
  await seedReviews();
  page.on("dialog", (d) => void d.accept());
  await page.goto("/#reviews");
  const card = page.locator("#reviews-card");
  await card.getByRole("button", { name: "Run bot review" }).click();
  await expect(card.locator("[data-rv-run]")).toBeDisabled();
  const id = /^(rq-\S+)/.exec(await routineCli(["reviews", "request"]))![1];
  await routineCli(["reviews", "request-update", id, "skipped", "--message", "a run of review-bot was still going after a 5-minute wait"]);
  await expect(card).toContainText("Skipped at");
  await expect(card).toContainText("a run of review-bot was still going");
  await expect(card.getByRole("button", { name: "Run bot review" })).toBeEnabled();
});
