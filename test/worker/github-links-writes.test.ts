// doc_links' triggers (migration 0008) must never make a doc write fail, whatever conflict clause the write
// itself carries: SQLite runs a trigger's statements under the outer statement's conflict policy, so an
// INSERT OR IGNORE in the trigger is overridden by an upsert's ON CONFLICT (an ABORT). Every real write path
// here stores a url twice (within links, and across links and evidence), and must leave one row per url.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// @ts-expect-error: the importer is plain JS (scripts/lib), with no type declarations.
import { buildImportSql } from "../../scripts/lib/import.mjs";
import { linkedIds } from "../../worker/hooks/github.ts";
import { human, uid } from "./helpers.ts";

const pr = () => `https://github.com/acme/repo/pull/${uid("n")}`;
const dupData = (p: string, label = "PR") => ({
  type: "decision",
  title: "dup",
  links: [{ label, url: p }, { label: `${label} again`, url: p }, { label: "files", url: `${p}/files` }],
  evidence: [{ label: "same PR", url: p }],
});
const rows = async (id: string) =>
  (await env.DB.prepare("SELECT url FROM doc_links WHERE collection = 'items' AND id = ? ORDER BY url").bind(id).all<{ url: string }>())
    .results.map((r) => r.url);

describe("doc_links triggers never fail a doc write", () => {
  it("API create and update with a url repeated within links and across links and evidence", async () => {
    const p = pr();
    const id = uid("dup");
    const put = await human.put(`/api/items/${id}`, { data: dupData(p) });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    expect(await rows(id)).toEqual([p, `${p}/files`]);

    const patch = await human.patch(`/api/items/${id}`, { data: { links: dupData(p, "Renamed").links } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const replace = await human.put(`/api/items/${id}`, { data: { ...dupData(p, "Again"), status: "open" } });
    expect(replace.status, JSON.stringify(replace.body)).toBe(200);
    expect(await rows(id)).toEqual([p, `${p}/files`]);
    expect(await linkedIds(env.DB, "items", p)).toEqual([id]);
  });

  it("a batch write", async () => {
    const p = pr();
    const [a, b] = [uid("ba"), uid("bb")];
    await human.put(`/api/items/${b}`, { data: dupData(p) });
    const r = await human.post("/api/batch", {
      ops: [
        { op: "item.put", id: a, data: dupData(p), if_version: 0 },
        { op: "item.patch", id: b, data: { links: dupData(p, "Renamed").links } },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await rows(a)).toEqual([p, `${p}/files`]);
    expect(await rows(b)).toEqual([p, `${p}/files`]);
  });

  it("an import, then an import --replace that changes a label (ON CONFLICT DO UPDATE)", async () => {
    const p = pr();
    const id = uid("imp");
    const run = async (replace: boolean, label: string) => {
      const { statements } = buildImportSql([{ collection: "items", id, data: { ...dupData(p, label), status: "open" } }], {
        replace,
        now: "2026-03-01T00:00:00.000Z",
      });
      await env.DB.batch(statements.map((s: string) => env.DB.prepare(s)));
    };
    await run(false, "PR");
    await run(false, "PR"); // ON CONFLICT DO NOTHING: no write, no trigger
    await run(true, "Renamed");
    expect(JSON.parse((await env.DB.prepare("SELECT data FROM docs WHERE collection = 'items' AND id = ?").bind(id).first<{ data: string }>())!.data).links[0].label).toBe("Renamed");
    expect(await rows(id)).toEqual([p, `${p}/files`]);
  });

  it("repairing links stored as a string to the same JSON as a real array indexes them", async () => {
    const p = pr();
    const id = uid("str");
    const links = [{ label: "PR", url: p }];
    // Only an import could store this: links as a string holding the array's JSON.
    await env.DB.prepare(
      "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('items', ?, ?, 1, ?, ?, 'test')",
    )
      .bind(id, JSON.stringify({ type: "decision", status: "open", title: "s", links: JSON.stringify(links) }), "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z")
      .run();
    expect(await rows(id)).toEqual([]);
    const fix = await human.patch(`/api/items/${id}`, { data: { links } });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect(await rows(id)).toEqual([p]);
  });

  it("repairing pr.url and evidence stored as strings indexes them too", async () => {
    const p = pr();
    const [item, orch] = [uid("ev"), uid("O")];
    const evidence = [{ label: "PR", url: p }];
    const insert = (collection: string, id: string, data: unknown) =>
      env.DB.prepare(
        "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, 'test')",
      ).bind(collection, id, JSON.stringify(data), "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
    // pr.url "7" (a string) and 7 (a number) are different json_types with the same text.
    await env.DB.batch([
      insert("items", item, { type: "decision", status: "open", title: "e", evidence: JSON.stringify(evidence) }),
      insert("orchestrators", orch, { id: orch, pr: { url: 7 } }),
    ]);
    expect((await human.patch(`/api/items/${item}`, { data: { evidence } })).status).toBe(200);
    expect(await rows(item)).toEqual([p]);
    expect((await human.patch(`/api/orchestrators/${orch}`, { data: { pr: { url: "7" } } })).status).toBe(200);
    expect(await linkedIds(env.DB, "orchestrators", "7")).toEqual([orch]);
  });

  it("non-object elements (a string, a number, null, a boolean, a nested array) beside real links are skipped, not fatal", async () => {
    const p = pr();
    const id = uid("mix");
    const data = {
      type: "decision",
      title: "mixed",
      links: ["plain string", 42, null, true, [{ label: "nested", url: `${p}/nested` }], { label: "n", url: 7 }, { label: "PR", url: p }],
      evidence: [p, [p], { label: "files", url: `${p}/files` }, {}],
    };
    const put = await human.put(`/api/items/${id}`, { data: { type: "decision", title: "mixed", links: [{ label: "PR", url: p }] } });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    // The API refuses these shapes, so they go in as an import would write them, then get updated.
    await env.DB.prepare("UPDATE docs SET data = ? WHERE collection = 'items' AND id = ?").bind(JSON.stringify({ ...data, status: "open" }), id).run();
    expect(await rows(id)).toEqual([p, `${p}/files`]);
    await env.DB.prepare("DELETE FROM docs WHERE collection = 'items' AND id = ?").bind(id).run();
    await env.DB.prepare(
      "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('items', ?, ?, 1, ?, ?, 'test')",
    ).bind(id, JSON.stringify({ ...data, status: "open" }), "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z").run();
    expect(await rows(id)).toEqual([p, `${p}/files`]);
  });

  // Each element's url is read from the element (json_each's value), not by a path from the doc's root, which
  // re-walks the array for every element: 8,000 links took ~3 s to index that way. Checked on the triggers' SQL
  // rather than timed, so CI load can't make it flaky; the large doc still has to index every link.
  it("reads each link's url from the element, so a doc's links index in linear time", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'doc_links_%'",
    ).all<{ name: string; sql: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(["doc_links_ad", "doc_links_ai", "doc_links_au"]);
    for (const t of results) expect(t.sql, t.name).not.toMatch(/fullkey/i);

    const id = uid("many");
    const links = Array.from({ length: 8000 }, (_, i) => ({ label: `l${i}`, url: `https://github.com/acme/repo/pull/${i}` }));
    await env.DB.prepare(
      "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('items', ?, ?, 1, ?, ?, 'test')",
    ).bind(id, JSON.stringify({ type: "decision", status: "open", title: "many", links }), "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z").run();
    expect(await rows(id)).toHaveLength(8000);
  });
});
