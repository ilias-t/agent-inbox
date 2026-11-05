#!/usr/bin/env node
// Writes the home-screen icon sources (public/icons/*.svg) and renders the PNGs
// next to them. The mark is the favicon's (index.html): a white inbox tray on
// the light theme's accent (#2c56c9). Re-run after changing the drawing below:
//   node scripts/make-icons.mjs
// Renders with rsvg-convert (brew install librsvg / apt install librsvg2-bin),
// or ImageMagick's `magick` as a fallback. The PNGs are committed, so neither
// is needed to build or deploy.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const ACCENT = "#2c56c9";

// The tray on a 512 grid, centred at (256, 256): an open top and a filled base with
// a notch, both drawn with a fat round stroke so the corners stay soft when small.
const TRAY = `<g fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
    <path d="M140 270 L184 154 H328 L372 270"/>
    <path d="M140 270 H202 L224 304 H288 L310 270 H372 V334 Q372 358 348 358 H164 Q140 358 140 334 Z" fill="#fff"/>
  </g>`;

/** @param {{ rounded: boolean, scale: number }} o */
function svg({ rounded, scale }) {
  const bg = rounded
    ? `<rect width="512" height="512" rx="112" fill="${ACCENT}"/>`
    : `<rect width="512" height="512" fill="${ACCENT}"/>`;
  const t = 256 * (1 - scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${bg}
  <g transform="translate(${t} ${t}) scale(${scale})">
  ${TRAY}
  </g>
</svg>
`;
}

// any: rounded square with transparent corners (Android "any", desktop install).
// full: full-bleed square; iOS masks apple-touch-icon itself and fills transparency with black.
// maskable: full-bleed with the tray well inside the 80% safe circle Android crops to.
// badge: the tray alone, white on transparent, for notifications (public/sw.js): Android
// keeps only a badge's alpha and draws it in the status bar.
const SOURCES = {
  "icon.svg": svg({ rounded: true, scale: 1 }),
  "icon-full.svg": svg({ rounded: false, scale: 1 }),
  "icon-maskable.svg": svg({ rounded: false, scale: 0.8 }),
  "badge.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 96 320 320">
  ${TRAY}
</svg>
`,
};
const PNGS = [
  ["icon.svg", "icon-192.png", 192],
  ["icon.svg", "icon-512.png", 512],
  ["icon-full.svg", "apple-touch-icon.png", 180],
  ["icon-maskable.svg", "icon-maskable-512.png", 512],
  ["badge.svg", "badge-96.png", 96],
];

function render(src, dst, size) {
  try {
    execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", dst, src]);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    try {
      execFileSync("magick", ["-background", "none", "-density", "384", src, "-resize", `${size}x${size}`, dst]);
    } catch (e2) {
      if (e2.code !== "ENOENT") throw e2;
      console.error("Needs rsvg-convert (brew install librsvg) or ImageMagick's magick.");
      process.exit(1);
    }
  }
}

mkdirSync(OUT, { recursive: true });
for (const [name, body] of Object.entries(SOURCES)) writeFileSync(join(OUT, name), body);
for (const [src, dst, size] of PNGS) {
  render(join(OUT, src), join(OUT, dst), size);
  console.log(`public/icons/${dst} (${size}px)`);
}
