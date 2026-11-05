// Parity: the doc_links lookup (migration 0008) finds exactly the items and orchestrators the old scan did.
// LEGACY is the matcher /hooks/github ran over every doc before the index, copied verbatim: an item matches
// when one of its links or evidence urls is the PR url or a sub-page of it (/files, #discussion_r1), case-
// and scheme-sensitive; an orchestrator when its pr.url, trailing slashes trimmed, is the PR url. Docs go in
// with raw SQL, so shapes the API refuses (only an import could store them) are covered too.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Item, Link, Orchestrator } from "../../shared/types.ts";
import { linkedIds, linkedQuery } from "../../worker/hooks/github.ts";
import { createItem, human } from "./helpers.ts";

const LEGACY = {
  linksTo: (url: string, pr: string) => url === pr || url.startsWith(`${pr}/`) || url.startsWith(`${pr}#`),
  item(item: Item, pr: string): boolean {
    const links: Link[] = [...(item.links ?? []), ...(item.evidence ?? [])];
    return links.some((l) => typeof l?.url === "string" && LEGACY.linksTo(l.url, pr));
  },
  orchestrator: (o: Orchestrator, pr: string) => o.pr?.url?.replace(/\/+$/, "") === pr,
  // The hook's own normalisation of pull_request.html_url.
  event: (htmlUrl: string) => htmlUrl.replace(/\/+$/, ""),
};

const P = "https://github.com/acme/repo/pull/7";
const link = (url: unknown) => ({ label: "x", url });

const ITEMS: Record<string, Record<string, unknown>> = {
  exact: { links: [link(P)] },
  trailing: { links: [link(`${P}/`)] },
  trailing2: { links: [link(`${P}//`)] },
  files: { links: [link(`${P}/files`)] },
  commit: { links: [link(`${P}/commits/abc123`)] },
  anchor: { links: [link(`${P}#discussion_r1`)] },
  filesAnchor: { evidence: [link(`${P}/files#diff-1`)] },
  query: { links: [link(`${P}?tab=files`)] },
  longerNumber: { links: [link(`${P}0`)] },
  dotDiff: { links: [link(`${P}.diff`)] },
  http: { links: [link("http://github.com/acme/repo/pull/7")] },
  upperHost: { links: [link("https://GitHub.com/acme/repo/pull/7")] },
  upperPath: { links: [link("https://github.com/Acme/repo/pull/7")] },
  secondOfTwo: { links: [link("https://linear.app/acme/issue/A-1"), link(`${P}/checks`)] },
  evidenceOnly: { links: [link("https://example.com/doc")], evidence: [link(P)] },
  both: { links: [link(P)], evidence: [link(`${P}/files`)] },
  archived: { status: "archived", links: [link(P)] },
  decided: { status: "decided", type: "pr_ready", evidence: [link(`${P}/`)] },
  otherPr: { links: [link("https://github.com/acme/repo/pull/8")] },
  otherRepo: { links: [link("https://github.com/acme/other/pull/7")] },
  repoRoot: { links: [link("https://github.com/acme/repo")] },
  percent: { links: [link(`${P}/files?q=%25_x`)] },
  unicode: { links: [link(`${P}/files#é`)] },
  noLinks: {},
  nullLinks: { links: null },
  emptyLinks: { links: [] },
  // Shapes the API refuses: none of them match, and none breaks the write that stores them.
  numberUrl: { links: [link(7)] },
  missingUrl: { links: [{ label: "x" }] },
  stringElement: { links: [P] },
  nullElement: { links: [null, link(`${P}/files`)] },
  mixedElements: { links: ["str", 7, null, true, [link(P)], { url: 5 }, link(`${P}/files`)], evidence: [P, [P], link(`${P}#x`)] },
  nestedOnly: { links: [[link(P)]], evidence: [{ inner: link(P) }] },
  stringLinks: { links: P },
  emptyUrl: { links: [link("")] },
};

const ORCHS: Record<string, Record<string, unknown>> = {
  oExact: { pr: { number: 7, url: P } },
  oTrailing: { pr: { url: `${P}/` } },
  oTrailing3: { pr: { url: `${P}///` } },
  oFiles: { pr: { url: `${P}/files` } },
  oHttp: { pr: { url: "http://github.com/acme/repo/pull/7" } },
  oUpper: { pr: { url: "https://github.com/ACME/repo/pull/7" } },
  oOther: { pr: { url: "https://github.com/acme/repo/pull/70" } },
  oNoPr: {},
  oNoUrl: { pr: { number: 7 } },
  oStringPr: { pr: P },
  oNullPr: { pr: null },
  oEmptyUrl: { pr: { url: "" } },
};

// The html_urls a delivery might carry. The repo root and the host match every link below them, as the old
// prefix test did; "%" and "_" would be wildcards to a LIKE.
const EVENTS = [
  P,
  `${P}/`,
  `${P}///`,
  "https://github.com/acme/repo/pull/8",
  "https://github.com/acme/repo/pull/70",
  "https://github.com/acme/repo",
  "https://github.com",
  "http://github.com/acme/repo/pull/7",
  `${P}/files?q=%25_x`,
  "https://github.com/acme/repo/pull/7_",
  "https://github.com/acme/repo/pull/%",
  "///",
];

async function seed() {
  await env.DB.prepare("DELETE FROM docs WHERE collection IN ('items', 'orchestrators')").run();
  const insert = (collection: string, id: string, data: unknown, i: number) => {
    const at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    return env.DB.prepare(
      "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, 'test')",
    ).bind(collection, id, JSON.stringify(data), at, at);
  };
  // Reverse order: ids come back in created_at order, not insertion or id order.
  const items = Object.entries(ITEMS).reverse();
  await env.DB.batch([
    ...items.map(([id, d], i) => insert("items", id, { type: "decision", status: "open", title: id, ...d }, i)),
    ...Object.entries(ORCHS).map(([id, d], i) => insert("orchestrators", id, { id, ...d }, i)),
  ]);
}

async function legacy(htmlUrl: string) {
  const pr = LEGACY.event(htmlUrl);
  const all = async (c: string) =>
    (await env.DB.prepare("SELECT id, data FROM docs WHERE collection = ? ORDER BY created_at, id").bind(c).all<{ id: string; data: string }>())
      .results.map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
  return {
    items: (await all("items")).filter((d) => LEGACY.item(d.data, pr)).map((d) => d.id),
    orchestrators: (await all("orchestrators")).filter((d) => LEGACY.orchestrator(d.data, pr)).map((d) => d.id),
  };
}

async function indexed(htmlUrl: string) {
  const pr = LEGACY.event(htmlUrl);
  return { items: await linkedIds(env.DB, "items", pr), orchestrators: await linkedIds(env.DB, "orchestrators", pr) };
}

describe("doc_links lookup", () => {
  beforeEach(seed);

  it("matches exactly what the old scan matched, for every link shape and event url", async () => {
    for (const url of EVENTS) expect(await indexed(url), url).toEqual(await legacy(url));
    // The fixtures do exercise both sides.
    const hits = new Set(["exact", "trailing", "trailing2", "files", "commit", "anchor", "filesAnchor", "secondOfTwo", "evidenceOnly", "both", "archived", "decided", "nullElement", "mixedElements", "percent", "unicode"]);
    expect((await indexed(P)).items).toEqual(Object.keys(ITEMS).reverse().filter((id) => hits.has(id)));
    expect((await indexed(P)).orchestrators).toEqual(["oExact", "oTrailing", "oTrailing3"]);
    expect((await indexed("https://github.com/acme/repo")).items).toHaveLength(21);
  });

  it("follows edits and deletes, whoever writes them", async () => {
    // Raw SQL, as an older Worker or an import would write.
    await env.DB.prepare("UPDATE docs SET data = json_set(data, '$.links', json('[]')) WHERE collection = 'items' AND id = 'exact'").run();
    await env.DB.prepare("UPDATE docs SET data = json_set(data, '$.links', json(?)) WHERE collection = 'items' AND id = 'otherPr'")
      .bind(JSON.stringify([link(`${P}/files`)]))
      .run();
    await env.DB.prepare("UPDATE docs SET data = json_set(data, '$.title', 'renamed') WHERE collection = 'items' AND id = 'files'").run();
    await env.DB.prepare("DELETE FROM docs WHERE collection = 'items' AND id = 'anchor'").run();
    await env.DB.prepare("UPDATE docs SET data = json_set(data, '$.pr.url', ?) WHERE collection = 'orchestrators' AND id = 'oOther'").bind(P).run();
    await env.DB.prepare("UPDATE docs SET data = json_remove(data, '$.pr') WHERE collection = 'orchestrators' AND id = 'oExact'").run();
    for (const url of EVENTS) expect(await indexed(url), url).toEqual(await legacy(url));
    const now = await indexed(P);
    expect(now.items).toContain("otherPr");
    expect(now.items).toContain("files");
    expect(now.items).not.toContain("exact");
    expect(now.items).not.toContain("anchor");
    expect(now.orchestrators).toEqual(["oTrailing", "oTrailing3", "oOther"]);
  });

  it("follows API writes: create, patch away the link, delete", async () => {
    const pr = "https://github.com/acme/repo/pull/4242";
    await createItem("api-a", { links: [{ label: "PR", url: `${pr}/files` }] });
    await createItem("api-b", { evidence: [{ label: "PR", url: pr }, { label: "PR again", url: pr }] });
    await human.put("/api/orchestrators/api-o", { data: { pr: { number: 4242, url: `${pr}/` } } });
    expect(await indexed(pr)).toEqual({ items: ["api-a", "api-b"], orchestrators: ["api-o"] });

    expect((await human.patch("/api/items/api-a", { data: { links: [] } })).status).toBe(200);
    expect((await human.del("/api/items/api-b")).status).toBe(200);
    expect((await human.patch("/api/orchestrators/api-o", { data: { pr: { url: "https://github.com/acme/repo/pull/1" } } })).status).toBe(200);
    expect(await indexed(pr)).toEqual({ items: [], orchestrators: [] });
    expect(await legacy(pr)).toEqual({ items: [], orchestrators: [] });
  });

  it("a doc the old scan threw on (links an object, pr.url a number) is stored, updated and never matched", async () => {
    // Not in the parity fixtures: the old matcher threw on these, failing the whole delivery.
    const insert = (collection: string, id: string, data: unknown) =>
      env.DB.prepare(
        "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, 'test')",
      ).bind(collection, id, JSON.stringify(data), "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    await env.DB.batch([
      insert("items", "objectLinks", { type: "decision", status: "open", title: "x", links: { a: link(P) } }),
      insert("items", "objectEvidence", { type: "decision", status: "open", title: "x", evidence: { a: link(P) }, links: [link("https://example.com")] }),
      insert("orchestrators", "oNumberUrl", { id: "oNumberUrl", pr: { url: 7 } }),
    ]);
    await env.DB.prepare("UPDATE docs SET data = json_set(data, '$.links.b', json(?)) WHERE collection = 'items' AND id = 'objectLinks'")
      .bind(JSON.stringify(link(`${P}/files`)))
      .run();
    expect((await human.patch("/api/orchestrators/oNumberUrl", { data: { pr: { url: 8, state: "open" } } })).status).toBe(200);
    const found = await indexed(P);
    expect(found.items).not.toContain("objectLinks");
    expect(found.items).not.toContain("objectEvidence");
    expect(found.orchestrators).not.toContain("oNumberUrl");
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM doc_links WHERE id IN ('objectLinks', 'oNumberUrl')").first<{ n: number }>())!.n,
    ).toBe(0);
  });

  it("migration 0008 backfills the same rows the triggers write, leaving the docs and the change log alone", async () => {
    const links = async () => (await env.DB.prepare("SELECT collection, id, url FROM doc_links ORDER BY collection, id, url").all()).results;
    const docs = async () => (await env.DB.prepare("SELECT collection, id, data, version, updated_at FROM docs ORDER BY collection, id").all()).results;
    const maxSeq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;
    const fromTriggers = await links();
    expect(fromTriggers.length).toBeGreaterThan(30);

    // Rewind to before 0008: the docs as they are, no table, no triggers.
    await env.DB.batch(
      ["DROP TRIGGER doc_links_ai", "DROP TRIGGER doc_links_au", "DROP TRIGGER doc_links_ad", "DROP TABLE doc_links"].map((q) => env.DB.prepare(q)),
    );
    const [before, seq] = [await docs(), await maxSeq()];
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0008"))!;
    await env.DB.batch(m.queries.map((q) => env.DB.prepare(q)));

    expect(await links()).toEqual(fromTriggers);
    expect(await docs()).toEqual(before);
    expect(await maxSeq()).toBe(seq);
    for (const url of EVENTS) expect(await indexed(url), url).toEqual(await legacy(url));
  });

  it("is an index search, not a scan", async () => {
    for (const collection of ["items", "orchestrators"] as const) {
      const { sql, binds } = linkedQuery(collection, P);
      const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail);
      expect(plan.filter((d) => d.startsWith("SCAN")), plan.join("\n")).toEqual([]);
      expect(plan.filter((d) => d.includes("INDEX doc_links_url (collection=? AND url")), plan.join("\n")).toHaveLength(collection === "items" ? 3 : 1);
    }
  });
});
