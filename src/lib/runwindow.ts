// A routine's run feed as one continuous window: the newest page (GET /api/reviews/:routine), then the older pages
// Load older fetched (?before=). Every fetch that changes it, a refresh, its refill and Load older, goes through one
// queue, so they never overlap: each step reads the window as it is when it runs, and commits only once all of its
// requests have succeeded. A step that fails leaves the window as it was and rejects, for the caller to retry.
import type { ReviewRun, RoutineReviewsResponse } from "../../shared/types.ts";
import { mergeRuns, refillOlder } from "./reviews.ts";

export type FetchPage = (before?: string, limit?: number) => Promise<RoutineReviewsResponse>;

export class RunWindow {
  data: RoutineReviewsResponse | null = null; // the newest page, with the routine's PRs and head
  older: ReviewRun[] = [];
  olderMore: boolean | null = null; // null: no older page loaded (the newest page's `more` holds)
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private fetchPage: FetchPage, private onChange: () => void = () => {}) {}

  private enqueue(step: () => Promise<void>): Promise<void> {
    const p = this.queue.then(step);
    this.queue = p.catch(() => undefined);
    return p;
  }

  // Every run loaded, newest first.
  runs(): ReviewRun[] { return this.data ? mergeRuns(this.data.runs, this.older) : []; }
  // Older runs exist below the window.
  more(): boolean { return this.olderMore ?? !!this.data?.more; }

  // The newest page again; with older pages loaded, refilled down to the oldest of them (refillOlder).
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      const page = await this.fetchPage();
      const fill = this.older.length ? await refillOlder(page.runs, { runs: this.older, more: this.olderMore }, (before) => this.fetchPage(before, 100)) : null;
      this.data = page;
      if (fill) { this.older = fill.runs; this.olderMore = fill.more; }
      this.onChange();
    });
  }

  // The page before the oldest run loaded.
  loadOlder(): Promise<void> {
    return this.enqueue(async () => {
      const last = this.runs().at(-1);
      if (!last || !this.more()) return;
      const page = await this.fetchPage(last.stamp);
      this.older = mergeRuns(this.older, page.runs);
      this.olderMore = page.more;
      this.onChange();
    });
  }
}

// One RunWindow per routine. `reset` drops a routine's (its data was replaced or reset): the next `get` starts afresh.
// `commit` copies what a window holds wherever it's shown, only while it's still the routine's window: a request the
// dropped one had out never lands over the new one's data.
export class RunWindows {
  private map = new Map<string, RunWindow>();
  constructor(private fetchFor: (routine: string) => FetchPage, private commit: (routine: string, win: RunWindow) => void) {}
  get(routine: string): RunWindow {
    let w = this.map.get(routine);
    if (!w) {
      const win: RunWindow = new RunWindow(this.fetchFor(routine), () => { if (this.map.get(routine) === win) this.commit(routine, win); });
      this.map.set(routine, (w = win));
    }
    return w;
  }
  reset(routine: string): void { this.map.delete(routine); }
}
