// Request JSON can carry "__proto__", "constructor" or "prototype" as keys: JSON.parse makes them own
// properties, and a merge that assigns them (out[k] = v) swaps the target's prototype. Guards that read a
// field then see the prototype's value while the stored JSON drops it. Bodies with those keys, at any
// depth, are refused with 400 before any route or batch op looks at them.
import { beforeAll, describe, expect, it } from "vitest";
import { mergePatch } from "../../worker/store.ts";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

const O = "O-proto";
let orch: ReturnType<typeof agent>;
beforeAll(async () => {
  orch = agent((await mintToken("orchestrator", O, "proto-token")).secret);
});

// A manager's question about O-proto's work.
const managers = async (data: Record<string, unknown> = {}) => {
  const id = uid("proto");
  await createItem(id, { orchestrator: O, source: `sweep:${O}`, ...data });
  return id;
};
const get = async (id: string) => (await human.get(`/api/items/${id}`)).body;
// Raw JSON: an object literal's __proto__ would set the prototype, and JSON.stringify would drop it.
const raw = (path: string, method: "PATCH" | "PUT" | "POST", json: string) =>
  method === "PATCH" ? orch.patch(path, json) : method === "PUT" ? orch.put(path, json) : orch.post(path, json);

describe("prototype keys in request bodies", () => {
  it("repro: a patch can't clear close_on_pr behind a __proto__ copy of it", async () => {
    const id = await managers({ close_on_pr: true, links: [{ label: "PR", url: "https://github.com/a/b/pull/1" }] });
    const r = await raw(`/api/items/${id}`, "PATCH", '{"data":{"close_on_pr":null,"__proto__":{"close_on_pr":true}}}');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/__proto__/);
    expect((await get(id)).data.close_on_pr).toBe(true);
  });

  it("repro: a batch patch can't remove status behind a __proto__ copy of it", async () => {
    const id = await managers();
    const r = await raw("/api/batch", "POST", `{"ops":[{"op":"item.patch","id":"${id}","data":{"status":null,"__proto__":{"status":"open"}}}]}`);
    expect(r.status).toBe(400);
    const doc = await get(id);
    expect(doc.data.status).toBe("open");
    expect((await human.post(`/api/items/${id}/decide`, { choice: "ack", if_version: doc.version })).status).toBe(200);
  });

  it.each([
    ["PATCH status via __proto__", "PATCH", (id: string) => `/api/items/${id}`, '{"data":{"status":null,"__proto__":{"status":"open"}}}'],
    ["PATCH, nested in a link", "PATCH", (id: string) => `/api/items/${id}`, '{"data":{"links":[{"label":"x","url":"https://x.test","__proto__":{"y":1}}]}}'],
    ["PATCH, nested in recommendation", "PATCH", (id: string) => `/api/items/${id}`, '{"data":{"recommendation":{"option":"a","__proto__":{"why":"w"}}}}'],
    ["PATCH, constructor.prototype", "PATCH", (id: string) => `/api/items/${id}`, '{"data":{"constructor":{"prototype":{"status":"open"}}}}'],
    ["PATCH, a bare prototype key", "PATCH", (id: string) => `/api/items/${id}`, '{"data":{"prototype":1}}'],
    ["PUT", "PUT", (id: string) => `/api/items/${id}`, `{"data":{"type":"decision","title":"t","orchestrator":"${O}","__proto__":{"source":"${O}"}}}`],
    ["an answer's data", "POST", (id: string) => `/api/items/${id}/qa`, '{"text":"a","data":{"__proto__":{"summary":"s"}}}'],
    ["the body itself", "POST", (id: string) => `/api/items/${id}/withdraw`, '{"if_version":1,"__proto__":{"if_version":1}}'],
    ["a batch op", "POST", () => "/api/batch", '{"ops":[{"op":"item.patch","id":"x","data":{}, "constructor":{"prototype":{}}}]}'],
  ] as const)("%s: 400, nothing written", async (_, method, path, json) => {
    const id = await managers();
    const before = await get(id);
    const r = await raw(path(id), method, json);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_request");
    const after = await get(id);
    expect(after.version).toBe(before.version);
    expect(after.data.status).toBe("open");
  });

  it("an orchestrator doc patch is refused the same way", async () => {
    const r = await raw(`/api/orchestrators/${O}`, "PATCH", '{"data":{"__proto__":{"status":"done"}}}');
    expect(r.status).toBe(400);
  });

  it("mergePatch itself never assigns through a prototype key, whoever calls it", () => {
    const patch = JSON.parse('{"status":null,"__proto__":{"status":"open"}}');
    expect(() => mergePatch({ status: "open", title: "t" }, patch)).toThrow(/__proto__/);
    const out = mergePatch({ a: 1 } as Record<string, unknown>, { b: 2, a: null });
    expect(out).toEqual({ b: 2 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("the words are fine as values, and other keys still merge", async () => {
    const id = await managers();
    const r = await raw(`/api/items/${id}`, "PATCH", '{"data":{"summary":"__proto__ constructor prototype"}}');
    expect(r.status).toBe(200);
    expect(r.body.data.summary).toBe("__proto__ constructor prototype");
  });
});
