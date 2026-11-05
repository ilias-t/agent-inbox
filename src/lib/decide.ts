// The decide form's Submit button, as data. The same state drives the button in the form and the
// phone's bottom-bar Submit, so both always say and allow the same thing.

export interface SubmitState { label: string; help: string; enabled: boolean }

// label: the chosen option's label (labelFor). The button keeps a short action label; what's
// missing before it can be pressed goes in the help text under it.
export function submitState(d: { choice?: string; note?: string }, busy: boolean, label: string): SubmitState {
  if (busy) return { label: "Saving…", help: "", enabled: false };
  if (!d.choice) return { label: "Submit", help: "Choose an option above.", enabled: false };
  const name = "Submit: " + label;
  if (d.choice === "other" && !(d.note || "").trim()) return { label: name, help: "Write a note to send Other.", enabled: false };
  return { label: name, help: "", enabled: true };
}

// The option the page treats as chosen. A choice the viewer made (or cleared: null after a 409) wins; with none yet,
// the recommendation is pre-selected when they can decide this item and it names one of its options (never Other…).
// Derived, not stored in the draft: a recommendation that changes later still shows until the viewer picks.
export function effectiveChoice(d: { choice?: string | null }, rec: string | null | undefined, optionIds: string[], canDecide: boolean): string | undefined {
  if ("choice" in d) return d.choice ?? undefined;
  if (!canDecide || !rec || rec === "other" || !optionIds.includes(rec)) return undefined;
  return rec;
}

// The item page's progress through the queue: a segment per item while they fit (cap), else one bar filled to the
// nearest 5% (a class, since the page can't set inline styles). index is 0-based.
export const PROGRESS_CAP = 12;
export function progressView(index: number, total: number, cap = PROGRESS_CAP): { segs: number; fill: number } | null {
  if (index < 0 || total < 1) return null;
  if (total <= cap) return { segs: total, fill: 0 };
  return { segs: 0, fill: Math.round(((index + 1) / total) * 20) * 5 };
}

// A live update changed the recommendation while it was pre-selected (the viewer hadn't chosen): the page doesn't
// move the pre-selection under them; it clears it and asks them to choose again. recShown: the option pre-selected
// when the page last rendered; eff: the one effectiveChoice gives now.
export function recMoved(d: { choice?: string | null; recShown?: string }, eff: string | undefined): boolean {
  return !("choice" in d) && d.recShown !== undefined && d.recShown !== eff;
}

// What a decision is made on: the question, each option as shown (id, label, description, consequence, tradeoff,
// reversibility) and the recommended option. A live update that changes any of it, even under the same option ids,
// changes the print, so a choice made (or pre-selected) on the old version is cleared rather than sent pinned to the
// new one.
export interface PrintOption { id: string; label?: string; description?: string; consequence?: string; tradeoff?: string; reversible?: boolean }
// `subject` is the other text a choice rests on: the title (the whole subject when there is no question), the summary,
// the recommendation's why and confidence.
export function decisionPrint(question: unknown, options: PrintOption[], recOption: string | null | undefined, subject: unknown[] = []): string {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
  return JSON.stringify([
    text(question),
    subject.map(text),
    options.map((o) => [o.id, o.label ?? "", o.description ?? "", o.consequence ?? "", o.tradeoff ?? "", typeof o.reversible === "boolean" ? o.reversible : null]),
    recOption ?? null,
  ]);
}
