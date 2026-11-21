import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryObserver, environmentManager } from "@tanstack/react-query";
import { createQueryClient } from "../src/app/data/query.js";
import { POLL_CEILING_MS, pacedInterval } from "../src/app/data/polling.js";

// React Query schedules no interval where it sees no window; these tests stand
// in for the browser with fake timers.
beforeEach(() => {
  vi.useFakeTimers();
  environmentManager.setIsServer(() => false);
});
afterEach(() => {
  environmentManager.setIsServer(() => typeof window === "undefined");
  vi.useRealTimers();
});

/** A read that answers after `duration()` ms, noting when each one started. */
function slowRead<T>(duration: () => number, answer: () => T) {
  const t0 = Date.now(),
    starts: number[] = [];
  return {
    starts,
    queryFn: () => {
      starts.push(Date.now() - t0);
      return new Promise<T>((resolve) =>
        setTimeout(() => resolve(answer()), duration()),
      );
    },
  };
}

it("waits twice a slow read before the next, sends none while one is out, caps the wait at 60 s, and stops when the task ends", async () => {
  const client = createQueryClient();
  let duration = 100,
    finished = false;
  const read = slowRead(
    () => duration,
    () => ({ finished }),
  );
  const observer = new QueryObserver(client, {
    queryKey: ["tasks", "detail", "paced"],
    queryFn: read.queryFn,
    // The task detail's own pace: every 2 s while running, none once ended.
    refetchInterval: (query) =>
      pacedInterval(query, query.state.data?.finished ? false : 2000),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    // A quick read keeps the query's own 2 s.
    await vi.advanceTimersByTimeAsync(100);
    expect(read.starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(read.starts).toEqual([0]);
    duration = 19_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(read.starts).toEqual([0, 2100]);
    // While the 19 s read is out the 2 s ticks join it; nothing else is sent.
    await vi.advanceTimersByTimeAsync(18_999);
    expect(read.starts).toEqual([0, 2100]);
    // It answered at 21.1 s, so the next waits 38 s from then.
    await vi.advanceTimersByTimeAsync(1 + 37_999);
    expect(read.starts).toEqual([0, 2100]);
    duration = 40_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(read.starts).toEqual([0, 2100, 59_100]);
    // A 40 s read would ask for 80 s; the wait stops at the 60 s ceiling.
    await vi.advanceTimersByTimeAsync(40_000 + POLL_CEILING_MS - 1);
    expect(read.starts).toEqual([0, 2100, 59_100]);
    duration = 100;
    finished = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(read.starts).toEqual([0, 2100, 59_100, 159_100]);
    // The task ended with that answer: no more reads.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read.starts).toEqual([0, 2100, 59_100, 159_100]);
    expect(observer.getCurrentResult().data).toEqual({ finished: true });
  } finally {
    unsubscribe();
    client.clear();
  }
});

it("paces a query two views share (the shell's and the task page's activity count) as one read at a time", async () => {
  const client = createQueryClient();
  let duration = 19_000;
  const read = slowRead(
    () => duration,
    () => ({ tasks: [] }),
  );
  const options = {
    queryKey: ["tasks", "activity"],
    queryFn: read.queryFn,
    refetchInterval: (query: Parameters<typeof pacedInterval>[0]) =>
      pacedInterval(query, 5000),
  };
  const views = [
    new QueryObserver(client, options),
    new QueryObserver(client, options),
  ];
  const unsubscribe = views.map((view) => view.subscribe(() => {}));
  try {
    await vi.advanceTimersByTimeAsync(19_000);
    expect(read.starts).toEqual([0]);
    duration = 100;
    // Neither view reads again until 38 s after the 19 s answer.
    await vi.advanceTimersByTimeAsync(37_999);
    expect(read.starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.starts).toEqual([0, 57_000]);
    // A quick answer brings both back to the own 5 s.
    await vi.advanceTimersByTimeAsync(100 + 4999);
    expect(read.starts).toEqual([0, 57_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.starts).toEqual([0, 57_000, 62_100]);
  } finally {
    for (const stop of unsubscribe) stop();
    client.clear();
  }
});
