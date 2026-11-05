// The UI's security headers (dist/_headers, written by vite.config.ts) and the checks that keep the
// page inside its Content-Security-Policy: no inline styles or handlers, no third-party scripts or
// stylesheets, and every inline <script> covered by a hash.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_HEADERS,
  APP_HEADERS,
  appCsp,
  headersFile,
  htmlCspProblems,
  inlineScripts,
  scriptHash,
} from "../../shared/security-headers.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const INDEX = readFileSync(join(ROOT, "index.html"), "utf8");

describe("appCsp", () => {
  it("is the strict policy, with the given inline-script hashes", () => {
    expect(appCsp(["'sha256-abc='"])).toBe(
      "default-src 'self'; script-src 'self' 'sha256-abc='; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
        "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
        "form-action 'self'; object-src 'none'",
    );
  });

  it("allows no inline script at all without a hash", () => {
    expect(appCsp([])).toContain("script-src 'self';");
    expect(appCsp([])).not.toMatch(/unsafe-(inline|eval)/);
  });
});

describe("scriptHash", () => {
  it("is the CSP source expression for the exact script text", async () => {
    expect(await scriptHash("")).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(await scriptHash("a")).not.toBe(await scriptHash("a "));
  });
});

describe("headersFile", () => {
  it("puts the CSP and the other headers on every path", () => {
    const f = headersFile(["'sha256-xyz='"]);
    const lines = f.split("\n");
    expect(lines.filter((l) => /^\S/.test(l) && !l.startsWith("#"))).toEqual(["/*", "/assets/*", "/sw.js"]); // Cloudflare allows 100
    expect(f).toContain("  Content-Security-Policy: " + appCsp(["'sha256-xyz='"]) + "\n");
    for (const [k, v] of Object.entries(APP_HEADERS)) expect(f).toContain(`  ${k}: ${v}\n`);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(2000); // Cloudflare's line limit
  });

  // Rule name -> its header lines.
  const rules = (f: string) => {
    const out: Record<string, string[]> = {};
    let cur = "";
    for (const l of f.split("\n")) {
      if (/^\S/.test(l) && !l.startsWith("#")) out[(cur = l)] = [];
      else if (l.startsWith("  ")) out[cur].push(l.trim());
    }
    return out;
  };

  it("caches hashed assets for a year and has the service worker script revalidated every time", () => {
    const r = rules(headersFile([]));
    expect(r["/assets/*"]).toEqual(["Cache-Control: public, max-age=31536000, immutable"]);
    expect(r["/sw.js"]).toEqual(["Cache-Control: no-cache"]);
    // Matching rules' values for one header are joined with a comma, so /* (which also covers /assets/*
    // and /sw.js) must not set one: / and index.html keep the default "public, max-age=0, must-revalidate".
    expect(r["/*"].filter((l) => /^cache-control:/i.test(l))).toEqual([]);
  });

  it("covers the headers the UI is meant to have", () => {
    expect(APP_HEADERS).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Strict-Transport-Security": "max-age=31536000",
    });
    for (const f of ["camera", "microphone", "geolocation"]) expect(APP_HEADERS["Permissions-Policy"]).toContain(f + "=()");
    expect(API_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(API_HEADERS["Cache-Control"]).toBe("no-store");
  });
});

describe("inlineScripts", () => {
  it("returns the bodies of scripts without src, exactly", () => {
    const html = '<script>\n  a();\n</script><script type="module" src="/x.js"></script><SCRIPT type="text/javascript">b()</SCRIPT>';
    expect(inlineScripts(html)).toEqual(["\n  a();\n", "b()"]);
  });
});

describe("htmlCspProblems", () => {
  it("flags what the policy would block", () => {
    expect(htmlCspProblems('<div style="width:5%"></div>')).toHaveLength(1);
    expect(htmlCspProblems('<button onclick="go()">')).toHaveLength(1);
    expect(htmlCspProblems('<a href="javascript:go()">')).toHaveLength(1);
    expect(htmlCspProblems('<link rel="stylesheet" href="https://fonts.googleapis.com/css2">')).toHaveLength(1);
    expect(htmlCspProblems('<script src="https://cdn.example/x.js"></script>')).toHaveLength(1);
    expect(htmlCspProblems('<link rel="preconnect" href="https://fonts.gstatic.com">')).toHaveLength(1);
  });

  it("passes plain same-origin markup", () => {
    expect(htmlCspProblems('<link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/src/main.ts"></script><p data-x="onclick=">x</p>')).toEqual([]);
  });
});

describe("the UI source", () => {
  it("index.html fits the policy, with one inline script (the theme)", () => {
    expect(htmlCspProblems(INDEX)).toEqual([]);
    const scripts = inlineScripts(INDEX);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("agent-inbox-theme");
  });

  it("no view builds a style attribute or an inline handler (style-src / script-src would block it)", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const offenders = walk(join(ROOT, "src"))
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => htmlCspProblems(readFileSync(f, "utf8")).map((p) => f.slice(ROOT.length) + ": " + p));
    expect(offenders).toEqual([]);
  });
});
