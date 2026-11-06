import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE, type Schedule } from "../../shared/types.ts";
import { scheduleView } from "../../worker/routes/schedule.ts";
import { createItem, human, uid } from "./helpers.ts";

describe("schedule", () => {
  it("GET returns defaults with version null while the doc is missing", async () => {
    const r = await human.get("/api/schedule");
    expect(r.status).toBe(200);
    expect(r.body.schedule).toEqual(DEFAULT_SCHEDULE);
    expect(r.body.version).toBeNull();
    expect(r.body.computed.label).toBe("10:00–18:00 ET, Mon–Fri");
    expect(r.body.computed.cron_utc).toHaveLength(1);
  });

  it("PUT validates, normalizes, pins and returns the view", async () => {
    const bad = await human.put("/api/schedule", { schedule: { ...DEFAULT_SCHEDULE, work_hours: "18:00-10:00 Mon-Fri" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("work_hours");
    expect((await human.put("/api/schedule", { schedule: { ...DEFAULT_SCHEDULE, timezone: "Nope/Zone" } })).status).toBe(400);
    expect((await human.put("/api/schedule", {})).status).toBe(400);

    const ok = await human.put("/api/schedule", {
      schedule: { ...DEFAULT_SCHEDULE, work_hours: "9:00-17:00 mon-thu", timezone: "UTC", pickup_interval_min: 15 },
      if_version: 0,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
    expect(ok.body.schedule.work_hours).toBe("09:00-17:00 Mon-Thu");
    expect(ok.body.computed.cron_utc).toEqual(["3-59/15 9-16 * * 1-4"]);
    expect((await human.put("/api/schedule", { schedule: DEFAULT_SCHEDULE, if_version: 0 })).status).toBe(409);
    expect((await human.get("/api/schedule")).body.version).toBe(1);
    // meta/schedule through the generic route is validated the same way.
    expect((await human.patch("/api/meta/schedule", { data: { pickup_interval_min: 0 } })).status).toBe(400);
    const patched = await human.patch("/api/meta/schedule", { data: { sweep_interval_min: 60 }, if_version: 1 });
    expect(patched.body.data.sweep_interval_min).toBe(60);
  });

  it("a stored doc that no longer validates is served as the defaults, flagged stored_invalid", () => {
    const stored = (data: Record<string, unknown>) => ({
      id: "schedule", version: 3, data: data as unknown as Schedule,
      created_at: "2026-10-07T14:00:00.000Z", updated_at: "2026-10-07T14:00:00.000Z", updated_by: "human:a@b.c",
    });
    const bad = scheduleView(stored({ ...DEFAULT_SCHEDULE, timezone: "Europe/Paris", pickup_interval_min: 7 }));
    expect(bad).toMatchObject({ schedule: DEFAULT_SCHEDULE, version: 3, stored_invalid: true });
    expect(scheduleView(stored({ ...DEFAULT_SCHEDULE }))).not.toHaveProperty("stored_invalid");
    expect(scheduleView(null)).not.toHaveProperty("stored_invalid");
  });
});

describe("meta", () => {
  it("PUT/PATCH/GET meta/manager and tick-request", async () => {
    expect((await human.get("/api/meta/manager")).status).toBe(404);
    const tick = await human.post("/api/meta/manager/tick-request", { note: "now please" });
    expect(tick.status).toBe(200);
    expect(tick.body.data).toMatchObject({ tick_requested_note: "now please" });
    expect(tick.body.data.tick_requested_at).toBe(tick.body.updated_at);
    const p = await human.patch("/api/meta/manager", { data: { digest: "all quiet" }, if_version: 1 });
    expect(p.body.data).toMatchObject({ digest: "all quiet", tick_requested_note: "now please" });
    const t2 = await human.post("/api/meta/manager/tick-request");
    expect(t2.body.data).toMatchObject({ digest: "all quiet", tick_requested_note: null });
    expect((await human.patch(`/api/meta/${uid("m")}`, { data: {} })).status).toBe(404);
  });
});

describe("orchestrators", () => {
  it("CRUD with id forced to the path", async () => {
    const id = uid("O");
    const c = await human.put(`/api/orchestrators/${id}`, { data: { id: "wrong", goal: "g", status: "running" } });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ id, goal: "g" });
    expect(c.body.data.updated_at).toBe(c.body.updated_at);
    const p = await human.patch(`/api/orchestrators/${id}`, { data: { headline: "h", goal: null } });
    expect(p.body.data).toMatchObject({ id, headline: "h" });
    expect(p.body.data.goal).toBeUndefined();
    expect((await human.get("/api/orchestrators")).body.orchestrators.some((o: any) => o.id === id)).toBe(true);
    expect((await human.del(`/api/orchestrators/${id}?if_version=1`)).status).toBe(409);
    expect((await human.del(`/api/orchestrators/${id}`)).status).toBe(200);
    expect((await human.get(`/api/orchestrators/${id}`)).status).toBe(404);
  });
});

describe("state", () => {
  it("returns everything with a cursor and me", async () => {
    const id = uid("s");
    await createItem(id);
    await human.post("/api/meta/manager/tick-request");
    const s = await human.get("/api/state");
    expect(s.status).toBe(200);
    expect(Object.keys(s.body).sort()).toEqual(
      ["items", "orchestrators", "manager", "lease", "schedule", "cursor", "me", "people", "snoozes", "pins", "archived_total", "archived_more", "routines", "fleets"].sort(),
    );
    expect(s.body.snoozes).toEqual({});
    expect(s.body.pins).toEqual({});
    expect(s.body.routines).toEqual([]); // no review routine has written
    expect(s.body.items.some((d: any) => d.id === id)).toBe(true);
    expect(s.body.manager.id).toBe("manager");
    expect(s.body.schedule.computed).toBeDefined();
    expect(s.body.me).toEqual({ kind: "human", email: "you@test", role: "admin", is_admin: true });
    const cursor = (await human.get("/api/changes")).body.cursor;
    expect(s.body.cursor).toBe(cursor);
  });
});
