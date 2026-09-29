// Per-device review markers. The gateway has no notion of "reviewed", so this is
// web-local: two sets of gateway session ids, each persisted as a JSON array in
// device storage.
//   needsReview - sessions the user pinned for review ("Ready for review" group);
//                 auto-cleared when a prompt is sent from the session
//   done        - sessions the user marked done from that group (dashboard-side
//                 marker only; it never touches the omp session file)
import { device } from '../platform/storage';

const DONE_KEY = 'ompgw-reviewed';
const REVIEW_KEY = 'ompgw-needs-review';

function loadSet(key: string): Set<string> {
  const raw = device.get<unknown>(key, []);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === 'string'));
}

export class ReviewedStore {
  done = $state<Set<string>>(new Set());
  needsReview = $state<Set<string>>(new Set());

  constructor() {
    this.done = loadSet(DONE_KEY);
    this.needsReview = loadSet(REVIEW_KEY);
  }

  /** True when the session was marked done. */
  has(gwId: string): boolean {
    return this.done.has(gwId);
  }

  markDone(gwId: string): void {
    if (this.done.has(gwId)) return;
    // Cap the ledger: gwIds are ephemeral per run and nothing prunes them on
    // session exit, so an unbounded set would grow in localStorage forever.
    const next = new Set(this.done);
    next.add(gwId);
    while (next.size > 500) next.delete(next.values().next().value as string);
    this.done = next;
    device.set(DONE_KEY, [...this.done]);
    // Recording done removes the review pin; callers shouldn't have to pair the two.
    this.unflag(gwId);
  }

  undo(gwId: string): void {
    if (!this.done.has(gwId)) return;
    const next = new Set(this.done);
    next.delete(gwId);
    this.done = next;
    device.set(DONE_KEY, [...this.done]);
  }

  clear(): void {
    this.done = new Set();
    device.set(DONE_KEY, []);
  }

  flag(gwId: string): void {
    if (this.needsReview.has(gwId)) return;
    this.needsReview = new Set(this.needsReview).add(gwId);
    device.set(REVIEW_KEY, [...this.needsReview]);
  }

  unflag(gwId: string): void {
    if (!this.needsReview.has(gwId)) return;
    const next = new Set(this.needsReview);
    next.delete(gwId);
    this.needsReview = next;
    device.set(REVIEW_KEY, [...this.needsReview]);
  }
}

export const reviewed = new ReviewedStore();
