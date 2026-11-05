// Roles (team inbox phase 2): the users table, how a human's role resolves,
// what each role may do, and /api/users. Each test starts with no users, the
// state a deployment is in right after migration 0005 without meta/people.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE } from "../../shared/types.ts";
import { agent, callAs, clearUsers, createItem, mintToken, person, setPeople, setRoles, uid } from "./helpers.ts";

const BOSS = "boss@test", DEC = "dec@test", VIEW = "view@test", NEW = "new@test";
const role = async (email: string, vars: Record<string, string> = {}) => (await person(email, vars).get("/api/me")).body.role;

let managerSecret: string, orchSecret: string;
beforeAll(async () => {
  managerSecret = (await mintToken("manager", undefined, "mgr-users")).secret;
  orchSecret = (await mintToken("orchestrator", "O7", "orch-users")).secret;
});
beforeEach(clearUsers);

describe("role resolution", () => {
  it("bootstrap: no admin in the table and no ADMIN_EMAILS, so every human is an admin (today's behavior)", async () => {
    expect((await person(NEW).get("/api/me")).body).toEqual({ kind: "human", email: NEW, role: "admin", is_admin: true });
    expect((await person(NEW).get("/api/state")).body.me).toMatchObject({ role: "admin", is_admin: true });
    // Rows without a role (people who only saved a name or topic) and non-admin rows don't end bootstrap.
    await setPeople({ [NEW]: { name: "New" }, [DEC]: { role: "decider" } });
    expect(await role(NEW)).toBe("admin");
    expect(await role(VIEW)).toBe("admin");
    expect(await role(DEC)).toBe("decider");
  });

  it("once the table has an admin, a row decides and anyone without one is a viewer", async () => {
    await setRoles({ [BOSS]: "admin", [DEC]: "decider", [VIEW]: "viewer", [NEW]: null });
    expect(await role(BOSS)).toBe("admin");
    expect(await role(DEC)).toBe("decider");
    expect(await role(VIEW)).toBe("viewer");
    expect(await role(NEW)).toBe("viewer"); // a row without a role resolves like no row
    expect(await role("stranger@test")).toBe("viewer");
    expect((await person(VIEW).get("/api/me")).body).toEqual({ kind: "human", email: VIEW, role: "viewer", is_admin: false });
  });

  it("emails compare case-insensitively", async () => {
    await setRoles({ [BOSS]: "admin", [DEC]: "decider" });
    expect(await role("DEC@Test")).toBe("decider");
  });

  it("ADMIN_EMAILS (deprecated) makes listed humans without a row admins; a row still wins", async () => {
    const vars = { ADMIN_EMAILS: " Boss@test , dec@test" };
    await setRoles({ "other@test": "admin", [DEC]: "decider" });
    expect(await role(BOSS, vars)).toBe("admin");
    expect(await role(DEC, vars)).toBe("decider");
    expect(await role(NEW, vars)).toBe("viewer");
  });

  it("ADMIN_EMAILS set and no admin in the table: unlisted humans are deciders, as they were before roles", async () => {
    const vars = { ADMIN_EMAILS: BOSS };
    expect(await role(BOSS, vars)).toBe("admin");
    expect(await role(NEW, vars)).toBe("decider");
    expect(await role(NEW, { ADMIN_EMAILS: " , " })).toBe("admin"); // blank counts as unset
  });

  it("tokens have no role", async () => {
    expect((await agent(managerSecret).get("/api/me")).body).toEqual({ kind: "token", name: "mgr-users", scope: "manager" });
  });
});

describe("permissions", () => {
  const schedule = { ...DEFAULT_SCHEDULE, pickup_interval_min: 15 };
  let id: string;
  beforeEach(async () => {
    id = uid("perm");
    await createItem(id, { type: "proposal" }); // as the bootstrap admin, before any roles exist
    await setRoles({ [BOSS]: "admin", [DEC]: "decider", [VIEW]: "viewer" });
  });

  const writes = (i: string) => [
    ["POST", `/api/items/${i}/decide`, { choice: "approve" }],
    ["POST", `/api/items/${i}/qa`, { text: "why?" }],
    ["PATCH", `/api/items/${i}`, { data: { assignee: DEC } }],
    ["POST", "/api/meta/manager/tick-request", {}],
  ] as const;
  const adminWrites = (i: string) => [
    ["PUT", `/api/items/${i}-new`, { data: { type: "info", title: "x" } }],
    ["PATCH", `/api/items/${i}`, { data: { title: "renamed" } }],
    ["POST", `/api/items/${i}/archive`, {}],
    ["POST", `/api/items/${i}/claim`, {}],
    ["DELETE", `/api/items/${i}`, undefined],
    ["PUT", "/api/orchestrators/O1", { data: { goal: "g" } }],
    ["DELETE", "/api/orchestrators/O1", undefined],
    ["PATCH", "/api/meta/manager", { data: { digest: "d" } }],
    ["PUT", "/api/schedule", { schedule }],
    ["PATCH", "/api/meta/schedule", { data: { sweep_interval_min: 40 } }],
    ["POST", "/api/lease/acquire", { session_id: "s" }],
    ["POST", "/api/batch", { ops: [{ op: "item.patch", id: i, data: { summary: "b" } }] }],
    ["GET", "/api/tokens", undefined],
    ["POST", "/api/tokens", { name: "t", scope: "manager" }],
    ["PUT", `/api/users/${NEW}`, { role: "viewer" }],
  ] as const;

  it("a viewer reads everything and writes nothing but their own profile and devices", async () => {
    const v = person(VIEW);
    for (const path of ["/api/state", "/api/items", `/api/items/${id}`, `/api/items/${id}/qa`, "/api/schedule", "/api/people", "/api/users", "/api/changes?since=0"]) {
      expect((await v.get(path)).status, path).toBe(200);
    }
    for (const [method, path, body] of [...writes(id), ...adminWrites(id)]) {
      const r = await callAs(VIEW, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error).toBe("forbidden");
    }
    expect((await v.put("/api/people/me", { name: "Vee" })).status).toBe(200);
    expect((await v.get("/api/push/key")).status).toBe(200);
    expect((await v.del("/api/push/subscribe", { endpoint: "https://push.example.com/x" })).status).toBe(200);
    expect((await v.get(`/api/items/${id}`)).body.data.status).toBe("open");
  });

  it("a decider decides, asks, requests a tick and reassigns, and nothing an admin does", async () => {
    for (const [method, path, body] of adminWrites(id)) {
      const r = await callAs(DEC, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    // Reassign only: a PATCH touching anything but the assignee is refused, in a batch too.
    expect((await person(DEC).patch(`/api/items/${id}`, { data: { assignee: DEC, title: "x" } })).status).toBe(403);
    for (const [method, path, body] of writes(id).slice(1)) {
      const r = await callAs(DEC, method, path, body);
      expect(r.status, `${method} ${path}`).toBeLessThan(300);
    }
    expect((await person(DEC).patch(`/api/items/${id}`, { data: { assignee: null } })).status).toBe(200);
    const d = await person(DEC).post(`/api/items/${id}/decide`, { choice: "approve" });
    expect(d.status).toBe(200);
    expect(d.body.data.decision.by).toBe(`human:${DEC}`);
  });

  it("an admin does everything", async () => {
    for (const [method, path, body] of [...writes(id), ...adminWrites(id)]) {
      const r = await callAs(BOSS, method, path, body);
      // archive/claim/delete after decide may 409 on state; never 403.
      expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).not.toBe(403);
    }
  });

  it("the manager token keeps its rights whatever the roles", async () => {
    const m = agent(managerSecret);
    expect((await m.post(`/api/items/${id}/qa`, { text: "answer" })).status).toBe(201);
    expect((await m.patch(`/api/items/${id}`, { data: { summary: "s" } })).status).toBe(200);
    expect((await m.put("/api/schedule", { schedule })).status).toBe(200);
    expect((await m.post(`/api/items/${id}/decide`, { choice: "approve" })).status).toBe(200);
    expect((await m.post(`/api/items/${id}/claim`, {})).status).toBe(200);
  });
});

describe("/api/users", () => {
  const admin = person(BOSS);
  beforeEach(() => env.DB.prepare("DELETE FROM push_subscriptions").run());
  const addDevice = (email: string, name = uid("dev")) =>
    env.DB.prepare(
      "INSERT INTO push_subscriptions (email, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'k', 'a', 'now')",
    ).bind(email, `https://fcm.googleapis.com/fcm/send/${name}`).run();
  const devicesOf = async (email: string) =>
    (await env.DB.prepare("SELECT count(*) AS n FROM push_subscriptions WHERE email = ?").bind(email).first<{ n: number }>())!.n;

  it("admins also see people who only have Web Push devices (no row), with their resolved role and device count", async () => {
    await setPeople({ [BOSS]: { role: "admin" }, [DEC]: { role: "decider" } });
    await addDevice(DEC);
    await addDevice("ghost@test");
    await addDevice("ghost@test");
    const r = await admin.get("/api/users");
    expect(r.body.users.map((u: any) => [u.email, u.role, u.role_set, u.has_row, u.devices])).toEqual([
      [BOSS, "admin", true, true, 0],
      [DEC, "decider", true, true, 1],
      ["ghost@test", "viewer", false, false, 2],
    ]);
    // Teammates don't learn who enabled a device.
    expect((await person(DEC).get("/api/users")).body.users.map((u: any) => u.email)).toEqual([BOSS, DEC]);
  });

  it("DELETE removes the devices of someone without a row; 404 once nothing is left", async () => {
    await setRoles({ [BOSS]: "admin" });
    await addDevice("ghost@test");
    await addDevice("ghost@test");
    expect((await admin.del("/api/users/ghost@test")).status).toBe(200);
    expect(await devicesOf("ghost@test")).toBe(0);
    expect((await admin.del("/api/users/ghost@test")).status).toBe(404);
    expect((await admin.get("/api/users")).body.users.map((u: any) => u.email)).toEqual([BOSS]);
  });

  it("DELETE of the last admin is 409 and leaves their devices alone", async () => {
    await setRoles({ [BOSS]: "admin" });
    await addDevice(BOSS);
    expect((await admin.del(`/api/users/${BOSS}`)).status).toBe(409);
    expect(await devicesOf(BOSS)).toBe(1);
  });

  it("lists people for admins with role, whether it was set, and has_topic; never a topic", async () => {
    await setPeople({ [BOSS]: { role: "admin", name: "Boss" }, [DEC]: { role: "decider", ntfy_topic: "dec-topic" }, [NEW]: { name: "New" } });
    const r = await admin.get("/api/users");
    expect(r.status).toBe(200);
    expect(r.body.bootstrap).toBe(false);
    expect(r.body.users.map((u: any) => [u.email, u.role, u.role_set, u.name ?? null, u.has_topic])).toEqual([
      [BOSS, "admin", true, "Boss", false],
      [DEC, "decider", true, null, true],
      [NEW, "viewer", false, "New", false],
    ]);
    expect(JSON.stringify(r.body)).not.toContain("dec-topic");
  });

  it("others (and the manager token) get email, name and role only; orchestrator tokens get 403", async () => {
    await setPeople({ [BOSS]: { role: "admin", name: "Boss" }, [DEC]: { role: "decider", ntfy_topic: "dec-topic" } });
    const expected = { users: [{ email: BOSS, name: "Boss", role: "admin" }, { email: DEC, role: "decider" }] };
    expect((await person(DEC).get("/api/users")).body).toEqual(expected);
    expect((await person(VIEW).get("/api/users")).body).toEqual(expected);
    expect((await agent(managerSecret).get("/api/users")).body).toEqual(expected);
    expect((await agent(orchSecret).get("/api/users")).status).toBe(403);
  });

  it("PUT adds a person with a role (lowercased) and changes role and name", async () => {
    await setRoles({ [BOSS]: "admin" });
    const r = await admin.put("/api/users/Alice@Example.com", { role: "decider", name: " Alice " });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: "alice@example.com", role: "decider", role_set: true, name: "Alice", has_topic: false });
    expect(await role("alice@example.com")).toBe("decider");
    const u = await admin.put("/api/users/alice@example.com", { role: "viewer" });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ role: "viewer", name: "Alice" }); // an omitted name is kept
    expect((await admin.put("/api/users/alice@example.com", { name: null })).body.name).toBeUndefined();
    expect(await role("alice@example.com")).toBe("viewer");
  });

  it("PUT validates: a new person needs a role; role and email must be valid", async () => {
    await setRoles({ [BOSS]: "admin" });
    expect((await admin.put(`/api/users/${NEW}`, { name: "x" })).status).toBe(400);
    expect((await admin.put(`/api/users/${NEW}`, { role: "owner" })).status).toBe(400);
    expect((await admin.put("/api/users/not-an-email", { role: "viewer" })).status).toBe(400);
  });

  it("only admin humans write users: deciders, viewers and tokens get 403", async () => {
    await setRoles({ [BOSS]: "admin", [DEC]: "decider" });
    expect((await person(DEC).put(`/api/users/${NEW}`, { role: "viewer" })).status).toBe(403);
    expect((await person(DEC).del(`/api/users/${BOSS}`)).status).toBe(403);
    expect((await agent(managerSecret).put(`/api/users/${NEW}`, { role: "admin" })).status).toBe(403);
    expect((await agent(managerSecret).del(`/api/users/${DEC}`)).status).toBe(403);
  });

  it("refuses to demote or remove the last admin", async () => {
    await setRoles({ [BOSS]: "admin", [DEC]: "decider" });
    const demote = await admin.put(`/api/users/${BOSS}`, { role: "decider" });
    expect(demote.status).toBe(409);
    expect(demote.body.error).toBe("last_admin");
    expect((await admin.del(`/api/users/${BOSS}`)).status).toBe(409);
    expect(await role(BOSS)).toBe("admin");
    // With a second admin, either can go.
    expect((await admin.put(`/api/users/${DEC}`, { role: "admin" })).status).toBe(200);
    expect((await admin.put(`/api/users/${BOSS}`, { role: "viewer" })).status).toBe(200);
    expect(await role(BOSS)).toBe("viewer");
  });

  it("DELETE removes the row and the person's devices; 404 when there is none", async () => {
    await setRoles({ [BOSS]: "admin", [DEC]: "decider" });
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (email, endpoint, p256dh, auth, created_at) VALUES (?, 'https://push.example.com/dec', 'k', 'a', 'now')",
    ).bind(DEC).run();
    expect((await admin.del(`/api/users/${DEC}`)).status).toBe(200);
    expect(await role(DEC)).toBe("viewer");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM push_subscriptions WHERE email = ?").bind(DEC).first<{ n: number }>())!.n).toBe(0);
    expect((await admin.del(`/api/users/${DEC}`)).status).toBe(404);
  });

  it("the bootstrap admin's first users write saves them as admin, so they keep admin and others become viewers", async () => {
    expect((await person(NEW).get("/api/users")).body.bootstrap).toBe(true);
    const r = await person(NEW).put("/api/users/alice@example.com", { role: "admin" });
    expect(r.status).toBe(201);
    expect(await role(NEW)).toBe("admin");
    expect(await role("alice@example.com")).toBe("admin");
    expect(await role("stranger@test")).toBe("viewer");
    const me = (await person(NEW).get("/api/users")).body.users.find((u: any) => u.email === NEW);
    expect(me).toMatchObject({ role: "admin", role_set: true });
  });

  it("an ADMIN_EMAILS admin without a saved role is saved as admin on their first users write", async () => {
    const vars = { ADMIN_EMAILS: NEW };
    await setPeople({ [BOSS]: { role: "admin" }, [NEW]: { name: "New", ntfy_topic: "new-topic" } });
    const r = await person(NEW, vars).put(`/api/users/${DEC}`, { role: "decider" });
    expect(r.status).toBe(201);
    const me = (await person(BOSS).get("/api/users")).body.users.find((u: any) => u.email === NEW);
    expect(me).toMatchObject({ role: "admin", role_set: true, name: "New", has_topic: true });
    expect(await role(NEW)).toBe("admin"); // without ADMIN_EMAILS now
  });

  it("the bootstrap admin can't make themselves a non-admin (it would leave no admin)", async () => {
    await setPeople({ [NEW]: { name: "New", ntfy_topic: "new-topic" } });
    expect((await person(NEW).put(`/api/users/${NEW}`, { role: "viewer" })).status).toBe(409);
    const ok = await person(NEW).put(`/api/users/${NEW}`, { role: "admin" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ role: "admin", name: "New", has_topic: true }); // the profile is kept
  });

  it("writes land in the change log, so open pages refresh", async () => {
    await setRoles({ [BOSS]: "admin" });
    const cursor = (await admin.get("/api/changes")).body.cursor;
    await admin.put(`/api/users/${DEC}`, { role: "decider" });
    const ch = (await admin.get(`/api/changes?since=${cursor}`)).body.changes;
    expect(ch.map((c: any) => [c.collection, c.doc_id, c.actor])).toEqual([["users", DEC, `human:${BOSS}`]]);
    // Orchestrator tokens don't see them.
    expect((await agent(orchSecret).get(`/api/changes?since=${cursor}`)).body.changes).toEqual([]);
  });
});

describe("/api/people/me on the users table", () => {
  it("a profile save keeps the role, and clearing it keeps a row that has one", async () => {
    await setRoles({ [BOSS]: "admin", [DEC]: "decider" });
    const p = person(DEC);
    expect((await p.put("/api/people/me", { name: "Dee", ntfy_topic: "dee-topic" })).body).toEqual({ email: DEC, name: "Dee", ntfy_topic: "dee-topic" });
    expect(await role(DEC)).toBe("decider");
    expect((await p.put("/api/people/me", {})).body).toEqual({ email: DEC });
    expect(await role(DEC)).toBe("decider");
    expect((await person(BOSS).get("/api/users")).body.users.map((u: any) => u.email)).toContain(DEC);
  });

  it("a person without a row gets one with no role, which a clear removes again", async () => {
    await setRoles({ [BOSS]: "admin" });
    await person(NEW).put("/api/people/me", { name: "Newt" });
    expect(await role(NEW)).toBe("viewer");
    expect((await person(BOSS).get("/api/users")).body.users.find((u: any) => u.email === NEW)).toMatchObject({ role_set: false, name: "Newt" });
    await person(NEW).put("/api/people/me", { name: "" });
    expect((await person(BOSS).get("/api/users")).body.users.map((u: any) => u.email)).not.toContain(NEW);
  });

  it("a viewer's profile save never makes them anything else", async () => {
    await setRoles({ [BOSS]: "admin", [VIEW]: "viewer" });
    await person(VIEW).put("/api/people/me", { name: "Vee", ntfy_topic: "vee-topic" });
    expect(await role(VIEW)).toBe("viewer");
  });
});
