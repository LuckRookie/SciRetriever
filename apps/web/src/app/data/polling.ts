import type { Query } from "@tanstack/react-query";

/** The longest a poll waits between reads, however slow the last one was. */
export const POLL_CEILING_MS = 60_000;

type Interval = number | false;
// Any query: the pace reads only its fetch state and update times.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = Query<any, any, any, any>;

/** Per query: when the read in flight started, and how long the last one took. */
const timings = new WeakMap<
  AnyQuery,
  { startedAt: number | null; lastMs: number }
>();

/**
 * How long the query's last read took, from its own fetch state. React Query
 * asks for the interval when a read starts and again when it settles, so the
 * start is noted then and the duration taken at the answer. A read that was
 * cancelled and rolled back leaves the last duration as it was.
 */
function lastDuration(query: AnyQuery): number {
  let timing = timings.get(query);
  if (!timing) {
    timing = { startedAt: null, lastMs: 0 };
    timings.set(query, timing);
  }
  const { fetchStatus, dataUpdatedAt, errorUpdatedAt } = query.state;
  if (fetchStatus !== "idle") timing.startedAt ??= Date.now();
  else if (timing.startedAt !== null) {
    const settled = Math.max(dataUpdatedAt, errorUpdatedAt);
    if (settled >= timing.startedAt) timing.lastMs = settled - timing.startedAt;
    timing.startedAt = null;
  }
  return timing.lastMs;
}

/**
 * The wait before a query's next read, for its `refetchInterval`: the query's
 * own interval or twice its last read's duration, whichever is longer, at
 * most {@link POLL_CEILING_MS} (a longer own interval is kept). An own
 * interval of `false` stops polling, as before. Every return of a
 * `refetchInterval` goes through here, so each read's start and end are seen.
 *
 * A read is never sent while the previous one is out: an interval tick during
 * a read joins it rather than starting another, and React Query restarts the
 * interval when each read settles, so the wait counts from the answer.
 */
export function pacedInterval(query: AnyQuery, own: Interval): Interval {
  const last = lastDuration(query);
  if (own === false) return false;
  return Math.max(own, Math.min(POLL_CEILING_MS, last * 2));
}
