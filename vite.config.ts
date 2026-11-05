import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { headersFile, htmlCspProblems, inlineScripts, scriptHash } from "./shared/security-headers.ts";

// Every file under dir, as posix paths relative to it.
function walk(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), root) : [relative(root, join(dir, e.name)).split(sep).join("/")],
  );
}

// public/sw.js is copied to dist/ as is; this stamps the copy with a hash of
// everything else in dist/ (so any deploy that changes a file gets a new
// cache) and the hashed /assets/ files to precache. See public/sw.js.
function serviceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "agent-inbox-sw",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const swPath = join(outDir, "sw.js");
      const src = readFileSync(swPath, "utf8");
      const BUILD = '"__SW_BUILD__"', ASSETS = "/*__SW_ASSETS__*/ []";
      if (!src.includes(BUILD) || !src.includes(ASSETS)) throw new Error("dist/sw.js: build markers not found");
      const files = walk(outDir).filter((f) => f !== "sw.js").sort();
      const hash = createHash("sha256").update(src);
      for (const f of files) hash.update(f + "\0").update(readFileSync(join(outDir, f)));
      const assets = files.filter((f) => f.startsWith("assets/")).map((f) => "/" + f);
      writeFileSync(swPath, src.replace(BUILD, JSON.stringify(hash.digest("hex").slice(0, 16))).replace(ASSETS, JSON.stringify(assets)));
    },
  };
}

// Writes dist/_headers (the UI's Content-Security-Policy and other security headers; see
// shared/security-headers.ts) with a hash of each inline <script> in the built index.html, so the
// theme script can change without the policy drifting. Fails the build if the page has anything
// else the policy would block. Runs in writeBundle, so the service worker's hash (closeBundle) covers it.
function securityHeaders(): Plugin {
  let outDir = "dist";
  return {
    name: "agent-inbox-security-headers",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    async writeBundle() {
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const problems = htmlCspProblems(html);
      if (problems.length) throw new Error("dist/index.html breaks the CSP: " + problems.join(", "));
      const hashes = await Promise.all(inlineScripts(html).map(scriptHash));
      const file = headersFile(hashes);
      for (const h of hashes) if (!file.includes(h)) throw new Error("dist/_headers: inline script hash " + h + " missing");
      writeFileSync(join(outDir, "_headers"), file);
    },
  };
}

// `npm run dev` serves the UI with hot reload and proxies the API to
// `wrangler dev` on :8787 (start it with `npm run worker:dev`), or to
// WORKER_DEV_URL when it's set (`WORKER_DEV_URL=http://localhost:8788 npm run dev`).
// The service worker is only registered from production builds (src/pwa.ts).
const workerDev = process.env.WORKER_DEV_URL || "http://localhost:8787";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [securityHeaders(), serviceWorker()],
  server: {
    proxy: {
      "/api": workerDev,
      "/agent": workerDev,
      "/hooks": workerDev,
    },
  },
});
