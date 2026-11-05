// Tests and e2e run from wrangler.test.jsonc; deployments start from wrangler.example.jsonc. The two must be the
// same app, differing only in the per-instance values (scripts/lib/wrangler-config.mjs INSTANCE_FIELDS), so a
// binding, flag or cron added to one and not the other fails here instead of passing tests it shouldn't.
import { describe, expect, it } from "vitest";
import { INSTANCE_FIELDS, instanceConfig, readJsonc, withoutInstanceValues } from "../../scripts/lib/wrangler-config.mjs";

const example = readJsonc("wrangler.example.jsonc");
const test = readJsonc("wrangler.test.jsonc");

describe("wrangler.test.jsonc", () => {
  it("matches wrangler.example.jsonc apart from the instance values", () => {
    expect(withoutInstanceValues(test)).toEqual(withoutInstanceValues(example));
  });

  it("fills every instance value, with no placeholder left", () => {
    for (const [path] of INSTANCE_FIELDS) {
      const value = path.split(".").reduce((o, k) => o?.[k], test);
      expect(value, path).toEqual(expect.any(String));
      expect(value, path).not.toMatch(/[<>]/);
    }
  });

  it("points at no real deployment", () => {
    expect(test.vars.PUBLIC_URL).toMatch(/\.test$/);
    expect(test.vars.ACCESS_TEAM_DOMAIN).toMatch(/\.test$/);
  });
});

// The deploy action builds each instance's config with instanceConfig (scripts/wrangler-config.mjs).
describe("instanceConfig", () => {
  const values = {
    databaseId: "11111111-2222-4333-8444-555555555555",
    accessTeamDomain: "team.cloudflareaccess.com",
    accessAud: "ab".repeat(32),
    publicUrl: "https://agent-inbox.example.workers.dev/",
  };

  it("fills the instance values into the example and keeps everything else", () => {
    const c = instanceConfig(example, { ...values, vars: { CHANGES_RETENTION_DAYS: "60" } });
    expect(c.name).toBe("agent-inbox");
    expect(c.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "agent-inbox", database_id: values.databaseId });
    expect(c.vars).toEqual({
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "ab".repeat(32),
      PUBLIC_URL: "https://agent-inbox.example.workers.dev", // trailing slash dropped
      CHANGES_RETENTION_DAYS: "60",
    });
    expect(withoutInstanceValues({ ...c, vars: { ...c.vars, CHANGES_RETENTION_DAYS: undefined } })).toEqual(
      withoutInstanceValues({ ...example, vars: { ...example.vars, CHANGES_RETENTION_DAYS: undefined } }),
    );
    expect(JSON.stringify(c)).not.toMatch(/[<>]/);
    expect(example.d1_databases[0].database_id).toMatch(/^</); // the example itself is untouched
  });

  it("names the Worker when asked, for a second instance in the same account", () => {
    expect(instanceConfig(example, { ...values, name: "agent-inbox-personal" }).name).toBe("agent-inbox-personal");
  });

  it("refuses empty, placeholder and malformed values, naming each", () => {
    expect(() => instanceConfig(example, { ...values, databaseId: "" })).toThrow(/D1 database id is empty/);
    expect(() => instanceConfig(example, { ...values, databaseId: undefined as unknown as string })).toThrow(/D1 database id is empty/);
    expect(() => instanceConfig(example, { ...values, accessAud: "<Access application AUD tag>" })).toThrow(/Access AUD tag looks like a placeholder/);
    expect(() => instanceConfig(example, { ...values, publicUrl: "http://x.workers.dev" })).toThrow(/https/);
    expect(() => instanceConfig(example, { ...values, publicUrl: "https://x.workers.dev/agent" })).toThrow(/no path/);
    expect(() => instanceConfig(example, { ...values, publicUrl: "https://x.workers.dev?a=1" })).toThrow(/no path, query/);
    expect(() => instanceConfig(example, { ...values, publicUrl: "https://x.workers.dev#f" })).toThrow(/no path, query/);
    expect(() => instanceConfig(example, { ...values, databaseId: "..." })).toThrow(/must be a UUID/);
    expect(() => instanceConfig(example, { ...values, accessTeamDomain: "..." })).toThrow(/<team>\.cloudflareaccess\.com/);
    expect(() => instanceConfig(example, { ...values, accessTeamDomain: "https://team.cloudflareaccess.com" })).toThrow(/<team>\.cloudflareaccess\.com/);
    expect(() => instanceConfig(example, { ...values, accessAud: "..." })).toThrow(/64 hex/);
    expect(() => instanceConfig(example, { ...values, name: "Agent Inbox" })).toThrow(/Worker name/);
    expect(() => instanceConfig(example, { ...values, vars: { PUBLIC_URL: "https://y" } })).toThrow(/can't set PUBLIC_URL/);
    expect(() => instanceConfig(example, { ...values, vars: { N: 5 as unknown as string } })).toThrow(/must be a string/);
    expect(() => instanceConfig(example, { databaseId: "", accessTeamDomain: "", accessAud: "", publicUrl: "" })).toThrow(
      /D1 database id is empty; Access team domain is empty; Access AUD tag is empty; public URL is empty/,
    );
  });
});
