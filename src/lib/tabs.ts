// The index tabs (Inbox, Team, History) build their lists only while shown: a render asked for a hidden tab (a live
// update, the minute timer) marks it stale instead, and showing it builds it then. A 2,000-row History hidden behind
// the Inbox then costs nothing per update. Tab counts, the badge and the title are the caller's, every time.
export class StaleTabs<T extends string> {
  private stale: Set<T>;
  constructor(private tabs: T[]) { this.stale = new Set(tabs); } // nothing is built yet

  // Every tab rebuilds when next shown (a detail page opened: "answered" dots and the like may change).
  markAll(): void { for (const t of this.tabs) this.stale.add(t); }

  // A render of `tab`'s list was asked for while `shown` is on screen (null: a detail page). True: build it now.
  render(tab: T, shown: T | null): boolean {
    if (tab === shown) { this.stale.delete(tab); return true; }
    this.stale.add(tab);
    return false;
  }

  // `tab` is being shown: true when its list must be built (stale, or `force`).
  show(tab: T, force: boolean): boolean {
    return force || this.stale.has(tab);
  }
}
