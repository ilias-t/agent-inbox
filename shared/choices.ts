// What a human can choose on an item: one definition for the page (which
// renders these as the choice buttons), the ntfy lock-screen buttons and the
// server's decide validation, so they never disagree.

import type { Item, Option } from "./types.ts";

export const AUTO_CHOICES = ["accept", "override"];

// A review routine's ask (it carries review_pr, docs/reviews.md): its human may also say they handled it on GitHub
// themselves, and the routine then posts nothing. Offered beside Other, not among the item's own options, so the
// lock-screen buttons (baseChoices) never show it.
export const GITHUB_CHOICE: Option = { id: "github", label: "Done on GitHub" };
export function isReviewAsk(item: object): boolean {
  const rp = (item as { review_pr?: unknown }).review_pr;
  return typeof rp === "object" && rp !== null && !Array.isArray(rp);
}

// The item's own options (dropping a stray "other", which is always offered
// separately, and malformed legacy entries), else the type's implied defaults:
// approve / reject for a proposal, ack for everything else.
export function baseChoices(item: Pick<Item, "type" | "options">): { list: Option[]; implied: boolean } {
  const opts = Array.isArray(item.options) ? item.options.filter((o) => o && o.id && o.id !== "other") : [];
  if (opts.length) return { list: opts, implied: false };
  if (item.type === "proposal") {
    return { list: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], implied: true };
  }
  return { list: [{ id: "ack", label: "Acknowledge" }], implied: true };
}

// Every choice decide accepts: an auto_decided item takes accept or override;
// any other item its base choices plus "other" (which needs a note), and a
// review routine's ask also "github".
export function validChoices(item: Pick<Item, "type" | "options">): string[] {
  if (item.type === "auto_decided") return [...AUTO_CHOICES];
  const base = baseChoices(item).list.map((o) => o.id);
  const github = isReviewAsk(item) && !base.includes(GITHUB_CHOICE.id) ? [GITHUB_CHOICE.id] : [];
  return [...base, ...github, "other"];
}
