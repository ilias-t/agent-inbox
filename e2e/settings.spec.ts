import { expect, openInbox, test } from "./fixtures.ts";
import { executeSql } from "./support/data.ts";

test("Settings loads with the schedule", async ({ page }) => {
  await openInbox(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();

  const schedule = page.getByRole("region", { name: "Schedule" });
  await expect(schedule).toBeVisible();
  // The seeded schedule: 10:00-18:00 Mon-Fri, America/New_York, pickup every 10 min, sweep every 30.
  await expect(schedule.getByLabel("Start time")).toHaveValue("10:00");
  await expect(schedule.getByLabel("End time")).toHaveValue("18:00");
  await expect(schedule.getByLabel("First day")).toHaveValue("Mon");
  await expect(schedule.getByLabel("Last day")).toHaveValue("Fri");
  await expect(schedule.getByLabel("Timezone")).toHaveValue("America/New_York");
  await expect(schedule.getByLabel("Pickup every (min)")).toHaveValue("10");
  await expect(schedule.getByLabel("Full sweep every (min)")).toHaveValue("30");
  await expect(schedule.getByRole("button", { name: "Save schedule" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent tokens" })).toContainText("e2e");
});

test("People lists someone who only turned on Web Push, and Remove deletes their devices", async ({ page }) => {
  // Anyone Access lets in can enable a device without being added under People.
  await executeSql(
    "devices.sql",
    "INSERT OR IGNORE INTO push_subscriptions (email, endpoint, p256dh, auth, created_at) VALUES " +
      "('ghost@example.com', 'https://fcm.googleapis.com/fcm/send/e2e-ghost-1', 'k', 'a', '2026-01-01T00:00:00Z'), " +
      "('ghost@example.com', 'https://fcm.googleapis.com/fcm/send/e2e-ghost-2', 'k', 'a', '2026-01-01T00:00:00Z');",
    "storing Web Push devices",
  );
  await page.goto("/#settings");
  const people = page.getByRole("region", { name: "People" });
  await expect(people).toContainText("ghost@example.com");
  await expect(people).toContainText("not added here: only Web Push devices");
  await expect(people).toContainText("2 Web Push devices");

  page.once("dialog", (d) => d.accept());
  await people.getByRole("button", { name: "Remove ghost@example.com's devices" }).click();
  await expect(people.locator(".status.ok")).toHaveText("Removed ghost@example.com's Web Push devices.");
  await expect(people.getByRole("button", { name: "Remove ghost@example.com's devices" })).toHaveCount(0);
});

test("An admin adds a fleet and mints an orchestrator token for it", async ({ page }) => {
  const id = `e2e-${Date.now().toString(36)}`;
  await page.goto("/#settings");
  const fleets = page.getByRole("region", { name: "Fleets" });
  await fleets.getByLabel("Id", { exact: true }).fill(id);
  await fleets.getByLabel("Label").fill("Side project");
  await fleets.getByLabel("Colour").fill("#3B82F6");
  await fleets.getByLabel("Manager id prefix").fill("S");
  await fleets.getByRole("button", { name: "Add fleet" }).click();
  await expect(fleets.locator(".status.ok")).toHaveText(`Added ${id}.`);
  await expect(fleets).toContainText("Side project");
  await expect(fleets).toContainText("manager ids S1, S2");

  // Edit keeps the id and changes the label.
  await fleets.getByRole("button", { name: "Edit" }).last().click();
  await expect(fleets.getByLabel("Id", { exact: true })).toHaveValue(id);
  await fleets.getByLabel("Label").fill("Side project A");
  await fleets.getByRole("button", { name: "Save fleet" }).click();
  await expect(fleets.locator(".status.ok")).toHaveText(`Saved ${id}.`);
  await expect(fleets).toContainText("Side project A");

  const tokens = page.getByRole("region", { name: "Agent tokens" });
  // A manager token starts on its manager id's fleet; an orchestrator token can't pick that.
  const fleet = tokens.getByLabel("Fleet", { exact: true });
  await tokens.getByLabel("Scope").selectOption("orchestrator");
  await expect(fleet).toHaveValue("");
  await tokens.getByLabel("Scope").selectOption("manager");
  await expect(fleet).toHaveValue("default");
  await tokens.getByLabel("Name", { exact: true }).fill(`orch-${id}`);
  await tokens.getByLabel("Fleet", { exact: true }).selectOption(id);
  await tokens.getByRole("button", { name: "Create token" }).click();
  await expect(tokens).toContainText(`Token “orch-${id}” created`);
  await expect(tokens.locator(".tokrow", { hasText: `orch-${id}` })).toContainText(`fleet ${id}`);
});
