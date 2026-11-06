// The CLI's fleet support (docs/cli.md "Fleets") against the real Worker: a token minted for a fleet checks its fleet
// at startup, lists it with its status, sees the hours it inherits labelled as such, and gives itself its own.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures.ts";
import { PERSIST_TO, ROOT, serverEnv } from "./support/data.ts";

const exec = promisify(execFile);

// `agent-inbox <args>` with `token` (any config on this machine ignored): its exit code and output. Without a token:
// the local person (DEV_NO_ACCESS), on the plain /api URL.
async function cli(token: string | null, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const target = token ? ["--url", serverEnv().baseURL + "/agent", "--token", token] : ["--url", serverEnv().baseURL];
  try {
    const { stdout, stderr } = await exec(process.execPath, [resolve(ROOT, "bin/agent-inbox.mjs"), ...args, ...target], {
      cwd: ROOT, env: { ...process.env, AGENT_INBOX_CONFIG: resolve(PERSIST_TO, "no-cli-config.json"), AGENT_INBOX_URL: "", AGENT_INBOX_TOKEN: "" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test("a fleet's orchestrator token checks its fleet, lists it, and sets its own hours", async ({ request }) => {
  const fleet = `cli-${Date.now().toString(36)}`;
  expect((await request.put(`/api/fleets/${fleet}`, { data: { data: { label: "CLI fleet", id_prefix: "C" } } })).status()).toBe(201);
  const minted = await request.post("/api/tokens", { data: { name: `orch-${fleet}`, scope: "manager", fleet } });
  expect(minted.status(), await minted.text()).toBe(201);
  const token = (await minted.json()).secret as string;

  expect((await cli(token, ["me"])).stdout).toContain(`fleet ${fleet}`);
  expect((await cli(token, ["me", "--expect-fleet", fleet])).code).toBe(0);
  const wrong = await cli(token, ["me", "--expect-fleet", "default"]);
  expect(wrong.code).toBe(3);
  expect(wrong.stderr).toContain(`belongs to fleet ${fleet}`);

  const listed = await cli(token, ["fleets"]);
  expect(listed.stdout).toMatch(new RegExp(`^${fleet} {2}"CLI fleet" {2}ids C1, C2…\\n {2}lease free`));
  expect(listed.stdout).toContain("inherited)");

  expect((await cli(token, ["schedule"])).stdout).toContain("[inherited: the deployment's hours");
  const set = await cli(token, ["meta", "set", "schedule", "--set", "pickup_interval_min:=5"]);
  expect(set.code, set.stderr).toBe(0);
  expect(set.stdout).toContain(`meta/schedule:${fleet}  v1`);
  const own = await cli(token, ["schedule", "--json"]);
  expect(JSON.parse(own.stdout)).toMatchObject({ version: 1, schedule: { pickup_interval_min: 5 } });
  expect(JSON.parse(own.stdout)).not.toHaveProperty("inherited");

  // Another fleet's filter is refused rather than quietly ignored.
  expect((await cli(token, ["items", "--fleet", "default"])).code).toBe(1);
});

test("a person lists every fleet and filters by one", async ({ request }) => {
  const fleet = `cli-p-${Date.now().toString(36)}`;
  expect((await request.put(`/api/fleets/${fleet}`, { data: { data: { label: "Person view" } } })).status()).toBe(201);
  const minted = await request.post("/api/tokens", { data: { name: `orch-${fleet}`, scope: "manager", fleet } });
  const token = (await minted.json()).secret as string;
  expect((await cli(token, ["post", `${fleet}-ask`, "--type", "info", "--title", "From the fleet"])).code).toBe(0);

  const listed = await cli(null, ["fleets"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.stdout).toMatch(/^default\n/);
  expect(listed.stdout).toContain(`${fleet}  "Person view"`);

  const items = await cli(null, ["items", "--fleet", fleet, "--json"]);
  expect(items.code, items.stderr).toBe(0);
  expect(JSON.parse(items.stdout).items.map((d: { id: string }) => d.id)).toEqual([`${fleet}-ask`]);
  const state = JSON.parse((await cli(null, ["state", "--fleet", fleet, "--json"])).stdout);
  expect(state.items.map((d: { id: string }) => d.id)).toEqual([`${fleet}-ask`]);
  expect(state.schedule.inherited).toBe(true);
  expect((await cli(null, ["items", "--fleet", "no-such-fleet"])).code).toBe(1);
});
