# UI design notes

The UI's look comes from a set of design boards; its behaviour is the code. Read this before a UI change that goes
beyond a bug fix.

- **[`ui-inventory.md`](ui-inventory.md)**: every capability the UI has. A change (and especially a redesign) must
  keep each one, or drop it on purpose.
- **[`boards/`](boards/)**: the signed-off mockups, as Claude Design canvases (`.dc.html`, one fixed-size board per
  file; each board's tokens are in its `renderVals()`, and its `dark` branch is the dark theme). `Main` (phone,
  landing on the top ask), `Phone-Queue`, `Phone-Night` (Focus + More sheet), `Mid-Split` (1024), `Desk-Split` and
  `Desk-Night` (1280, `?` dialog), and the older `r3-*` boards for History, states and the orchestrator page.
  They are a visual reference, not a spec: where a board and the app differ, the app's behaviour wins.

## The design

- **Direction.** A quiet, instrument-like layout: a hairline-ruled queue with priority dots, Instrument Sans with
  tabular figures, cool greys, a cobalt accent, red for high priority. The light tokens are the "Refined" board, the
  dark ones "Night" (`src/style.css`).
- **Layouts.** `src/lib/layout.ts`: phone below 700px, a split view (queue beside the item) from 700px, and desk
  extras such as key hints from 1100px. Key hints stay hidden on touch devices.
- **Phone.** Launched on the Inbox with something that needs you, a phone goes straight to the top ask, once per
  session (`src/lib/landing.ts`); a link to an item or another tab is left alone. Mid and desk open on the split view.
  After a decision or snooze the item view advances to the next item still in the queue, or back to the Inbox when
  none follows (`advanceTarget` in `src/lib/nav.ts`).

## Constraints a UI change has to respect

- **No inline styles.** The CSP is `style-src 'self'` (no `unsafe-inline`), and `e2e/security.spec.ts` treats an inline
  `style` attribute as a violation, so the boards' inline styles can't be copied as markup. Everything goes into
  classes in `src/style.css`. Fonts are bundled, not loaded from Google Fonts.
- **Dark tokens exist twice** (`:root:not([data-theme="light"])` under `prefers-color-scheme: dark`, and
  `:root[data-theme="dark"]`): change both. `scripts/contrast.mjs` fails when the two copies differ, and checks
  contrast from the `:root` and `:root[data-theme="dark"]` blocks. It reads only `--name: #rrggbb` lines, so write
  tokens as hex (composite a translucent colour over `--surface` first).
- **Unit tests have no DOM.** New UI logic goes in pure helpers in `src/lib/*` with tests in `test/app/`.
- **Viewports.** Playwright's default project is Desktop Chrome 1280×720, so most e2e specs run in the desk split
  view; `phone.spec.ts` runs at 390px.
- **The PWA starts at `/#inbox`** (`public/manifest.webmanifest`), so nothing may depend on an empty hash.
