// Pins (src/lib/pins.ts): the page headers' Pin toggle, `p`, and the Pinned group heading each list puts on top.
import type { PinKind } from "../../shared/types.ts";
import { esc, toast } from "../lib/dom.ts";
import { flattenItem, isOpen, type ItemRow } from "../lib/items.ts";
import { isPinned, pinOfHref, pinnedRefs } from "../lib/pins.ts";
import { ApiError, store } from "../store.ts";
import { applyPin, myEmail, state } from "../state.ts";

export const PIN_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7.5 3.5h5l-.8 4.3 2.8 2.7v1.5h-9v-1.5l2.8-2.7z"/><path d="M10 12v4.5"/></svg>';

// The Pinned group's heading, above a list's own groups. `id`: a focus target it stands in for (Reviews' Needs you,
// when every PR that needs you is pinned).
export function pinnedHead(n: number, id?: string): string {
  return '<h3 class="ghead pinned"' + (id ? ' id="' + esc(id) + '" tabindex="-1"' : "") + ">" + PIN_ICON + 'Pinned <span class="gn">' + n + "</span></h3>";
}

// What a page's toggle shows, for its render signature: pinned, and saving.
export function pinSig(key: string): [boolean, boolean] { return [isPinned(state.pins, key), state.pinBusy.has(key)]; }

// The page header's toggle (item, orchestrator and PR pages), for a signed-in human: tokens can't pin. Its name says
// what a press does ("Pin" / "Unpin"), and aria-pressed whether it's pinned. Busy is aria-disabled, so it keeps focus.
export function pinButton(key: string, list: string): string {
  if (!myEmail()) return "";
  const on = isPinned(state.pins, key);
  return '<button type="button" class="iconlink pinbtn" id="pin-btn" data-pin="' + esc(key) + '" aria-pressed="' + on + '" aria-label="' + (on ? "Unpin" : "Pin") + '"' +
    (state.pinBusy.has(key) ? ' aria-disabled="true"' : "") + ' title="' + esc(on ? "Pinned to the top of " + list + ". Unpin (p)" : "Pin to the top of " + list + " (p)") + '">' + PIN_ICON + "</button>";
}

// Where a pin shows: an open item in the Inbox, a past one in History, an orchestrator in Team, a PR in Reviews.
function listOf(key: string): string {
  const [kind, ref] = splitKey(key);
  if (kind === "item") { const i = state.items.find((x) => x.id === ref) || state.extra.get(ref); return i && !isOpen(i) ? "History" : "the Inbox"; }
  return kind === "orch" ? "Team" : "Reviews";
}
const splitKey = (key: string): [PinKind, string] => {
  const i = key.indexOf(":");
  return [key.slice(0, i) as PinKind, key.slice(i + 1)];
};

let redraw = (): void => {};
// Pins or unpins `key`, then redraws (a focused toggle keeps focus across the page's rebuild).
export async function togglePin(key: string): Promise<void> {
  const [kind, ref] = splitKey(key);
  if (!myEmail() || state.pinBusy.has(key) || !["item", "orch", "pr"].includes(kind)) return;
  const on = !isPinned(state.pins, key), list = listOf(key);
  state.pinBusy.add(key); draw();
  try {
    applyPin(await store.pin(kind, ref, on));
    toast(on ? "Pinned to the top of " + list : "Unpinned");
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, "unknown", String(e));
    if (err.status !== 401) toast(err.status === 404 ? "That's gone, so it can't be pinned." : on ? "Couldn't pin it. Try again." : "Couldn't unpin it. Try again.");
  } finally {
    state.pinBusy.delete(key); draw();
  }
}
function draw(): void {
  const had = document.activeElement?.id === "pin-btn";
  redraw();
  if (had) document.getElementById("pin-btn")?.focus({ preventScroll: true });
}

// `p`: the list's focused row (or a button on it), else the page open's toggle (an item, orchestrator or PR page).
// `routine`: the Reviews routine shown, for a PR row's link that doesn't name one.
export function pinFromKey(routine: string | null): void {
  const a = document.activeElement instanceof HTMLElement && document.activeElement.closest("#index-view") ? document.activeElement : null;
  const row = a && (a.matches("a.row") ? a : a.closest(".rowwrap")?.querySelector("a.row"));
  const key = row ? pinOfHref(row.getAttribute("href") || "", routine) : null;
  if (key) { togglePin(key); return; }
  const b = state.route.view !== "tab" ? document.querySelector<HTMLElement>("#detail #pin-btn") : null;
  if (b && b.dataset.pin) togglePin(b.dataset.pin);
}

export function wirePins(after: () => void): void {
  redraw = after;
  document.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-pin]");
    if (b && b.dataset.pin && b.getAttribute("aria-disabled") !== "true") togglePin(b.dataset.pin);
  });
}

// History's pinned items that aren't loaded (archived beyond the window the page holds): fetched once each, by id,
// into `extra` like an older item opened on its own page. One gone since is left out (the cron drops its pin); one
// whose fetch failed is tried again after the next successful sync (src/state.ts applySync).
const fetching = new Set<string>();
export function pinnedItems(): ItemRow[] {
  const out: ItemRow[] = [];
  for (const id of pinnedRefs(state.pins, "item")) {
    const row = state.items.find((x) => x.id === id) || state.extra.get(id);
    if (row) { out.push(row); continue; }
    if (fetching.has(id) || state.itemFetch.has(id)) continue;
    fetching.add(id);
    store.getItem(id).then((d) => { state.extra.set(id, flattenItem(d)); },
      (e) => { state.itemFetch.set(id, e instanceof ApiError && e.status === 404 ? "missing" : "failed"); })
      .finally(() => { fetching.delete(id); redraw(); });
  }
  return out;
}
