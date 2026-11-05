// /api/people (kept for compatibility, now backed by the users table): each
// human sets their own name and ntfy topic; others see names and whether a
// topic is set, never the topic.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { agent, human, mintToken, setPeople } from "./helpers.ts";

const ME = "you@test";

describe("/api/people", () => {
  let manager: ReturnType<typeof agent>;
  let orch: ReturnType<typeof agent>;
  beforeAll(async () => {
    manager = agent((await mintToken("manager", undefined, "mgr-people")).secret);
    orch = agent((await mintToken("orchestrator", "O9", "orch-people")).secret);
  });

  it("starts empty: me is just the email", async () => {
    expect((await human.get("/api/people/me")).body).toEqual({ email: ME });
    expect((await human.get("/api/people")).body).toEqual({ people: [] });
  });

  it("PUT me sets my name and topic; the list and state show the name and has_topic only", async () => {
    await setPeople({ "alice@example.com": { name: "Alice", ntfy_topic: "alice-topic" } });
    const r = await human.put("/api/people/me", { name: " You ", ntfy_topic: "inbox-you-123" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ email: ME, name: "You", ntfy_topic: "inbox-you-123" });
    expect((await human.get("/api/people/me")).body).toEqual(r.body);
    const people = [
      { email: "alice@example.com", name: "Alice", has_topic: true },
      { email: ME, name: "You", has_topic: true },
    ];
    expect((await human.get("/api/people")).body).toEqual({ people });
    expect((await human.get("/api/state")).body.people).toEqual(people);
    // Another person's entry is untouched by my write.
    const raw = await env.DB.prepare("SELECT name, ntfy_topic FROM users WHERE email = 'alice@example.com'").first();
    expect(raw).toEqual({ name: "Alice", ntfy_topic: "alice-topic" });
    // meta/people is no longer written.
    expect(await env.DB.prepare("SELECT 1 FROM docs WHERE collection = 'meta' AND id = 'people'").first()).toBeNull();
  });

  it("PUT me replaces my entry: an omitted, null or blank field clears it, and an empty entry is removed", async () => {
    await human.put("/api/people/me", { name: "You", ntfy_topic: "inbox-you-123" });
    expect((await human.put("/api/people/me", { name: "You" })).body).toEqual({ email: ME, name: "You" });
    expect((await human.put("/api/people/me", { name: "", ntfy_topic: null })).body).toEqual({ email: ME });
    expect((await human.get("/api/people")).body.people.map((p: any) => p.email)).not.toContain(ME);
  });

  it("validates the topic and the name", async () => {
    for (const body of [{ ntfy_topic: "has space" }, { ntfy_topic: "a".repeat(65) }, { ntfy_topic: 7 }, { name: "n".repeat(101) }]) {
      const r = await human.put("/api/people/me", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("the manager token can list people but has no me; orchestrator tokens see none", async () => {
    expect((await manager.get("/api/people")).status).toBe(200);
    expect((await manager.get("/api/people/me")).status).toBe(403);
    expect((await manager.put("/api/people/me", { name: "x" })).status).toBe(403);
    expect((await orch.get("/api/people")).status).toBe(403);
    expect((await orch.get("/api/state")).body.people).toEqual([]);
  });

  it("meta/people isn't reachable through /api/meta", async () => {
    expect((await human.get("/api/meta/people")).status).toBe(400);
    expect((await human.put("/api/meta/people", { data: {} })).status).toBe(400);
    expect((await manager.patch("/api/meta/people", { data: { "x@y": { ntfy_topic: "t" } } })).status).toBe(400);
  });
});
