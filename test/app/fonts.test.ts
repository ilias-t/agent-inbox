// src/fonts.css hand-copies the latin @font-face of each @fontsource-variable package (they ship no
// per-subset CSS); this keeps the copy in step with the installed version.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const OURS = readFileSync(ROOT + "src/fonts.css", "utf8");
const faces = (css: string) => [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
const prop = (face: string, name: string) => face.match(new RegExp(name + "\\s*:\\s*([^;]+);"))![1].replace(/\s+/g, "").replace(/['"]/g, "");

describe("src/fonts.css", () => {
  it.each([
    ["instrument-sans", "Instrument Sans Variable"],
    ["geist-mono", "Geist Mono Variable"],
  ])("matches @fontsource-variable/%s's latin face", (pkg, family) => {
    const theirs = faces(readFileSync(`${ROOT}node_modules/@fontsource-variable/${pkg}/wght.css`, "utf8")).find((f) => f.includes(`${pkg}-latin-wght-normal.woff2`))!;
    const ours = faces(OURS).find((f) => f.includes(`${pkg}-latin-wght-normal.woff2`))!;
    expect(prop(ours, "font-family")).toBe(family.replace(/\s+/g, ""));
    for (const p of ["font-family", "font-style", "font-weight", "unicode-range"]) expect(prop(ours, p), p).toBe(prop(theirs, p));
  });

  it("bundles only those two faces", () => {
    expect(faces(OURS)).toHaveLength(2);
  });
});
