import { afterEach, expect, it, vi } from "vitest";
import {
  browserPlatform,
  BrowserPlatformScheduler,
} from "../src/network/browser-platform.js";

afterEach(() => vi.useRealTimers());

it("groups platform aliases using public suffixes and excludes shared transit services", () => {
  expect(browserPlatform("https://www.sciencedirect.com/article/a")).toBe(
    browserPlatform("https://linkinghub.elsevier.com/a"),
  );
  expect(browserPlatform("https://a.publisher.co.uk/paper")).toBe(
    "publisher.co.uk",
  );
  expect(browserPlatform("https://a.other.co.uk/paper")).toBe("other.co.uk");
  expect(browserPlatform("https://paper-a.github.io/paper")).not.toBe(
    browserPlatform("https://paper-b.github.io/paper"),
  );
  for (const transit of [
    "https://doi.org/a",
    "https://tenant.auth0.com/a",
    "https://challenges.cloudflare.com/a",
    "http://127.0.0.1/a",
    "invalid",
  ])
    expect(browserPlatform(transit)).toBeNull();
});

it("keeps one platform active through download and permits another platform during its exact cooldown", async () => {
  vi.useFakeTimers();
  const owner = new BrowserPlatformScheduler({ now: () => Date.now() });
  const signal = new AbortController().signal;
  const first = await owner.acquire("a", "publisher.test", signal);
  await first.start();
  let secondStarted = false;
  const second = owner.acquire("b", "publisher.test", signal).then((lease) => {
    secondStarted = true;
    return lease;
  });
  const other = await owner.acquire("c", "other.test", signal);
  await other.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(secondStarted).toBe(false);
  first.release({ kind: "completed" });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(secondStarted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const next = await second;
  expect(secondStarted).toBe(true);
  await next.start();
  next.release({ kind: "completed" });
  other.release({ kind: "completed" });
  expect(owner.snapshot()).toMatchObject({ active: 0, queued: 0 });
  owner.close();
});

it("charges aggregate starts only once per attempt and preserves its window across workers", async () => {
  vi.useFakeTimers();
  const owner = new BrowserPlatformScheduler({
    now: () => Date.now(),
    cooldown_ms: 0,
    policy: {
      minimum_start_interval: 5,
      maximum_starts_per_window: 2,
      window_seconds: 60,
    },
  });
  const signal = new AbortController().signal;
  const a = await owner.acquire("a", "a.test", signal);
  const b = await owner.acquire("b", "b.test", signal);
  expect(owner.snapshot().recent_starts).toBe(0);
  await a.start();
  await a.start();
  let startedB = false;
  const bStart = b.start().then(() => {
    startedB = true;
  });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(startedB).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await bStart;
  a.release({ kind: "completed" });
  b.release({ kind: "completed" });
  let admitted = false;
  const c = owner.acquire("new-operation", "c.test", signal).then((lease) => {
    admitted = true;
    return lease;
  });
  await vi.advanceTimersByTimeAsync(54_999);
  expect(admitted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const lease = await c;
  await lease.start();
  lease.release({ kind: "completed" });
  owner.close();
});

it("shares Retry-After across entries without blocking an unrelated platform", async () => {
  vi.useFakeTimers();
  const owner = new BrowserPlatformScheduler({ now: () => Date.now() });
  const signal = new AbortController().signal;
  const a = await owner.acquire("a", "rate.test", signal);
  await a.start();
  a.release({ kind: "rate-limited", retry_after_ms: 90_000 });
  const b = await owner.acquire("b", "other.test", signal);
  await b.start();
  let entered = false;
  const c = owner.acquire("c", "rate.test", signal).then((lease) => {
    entered = true;
    return lease;
  });
  await vi.advanceTimersByTimeAsync(89_999);
  expect(entered).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  (await c).release({ kind: "cancelled" });
  b.release({ kind: "cancelled" });
  owner.close();
});

it("cancels a queued model-independent admission and releases a reservation without inventing a start", async () => {
  const owner = new BrowserPlatformScheduler();
  const first = await owner.acquire(
    "a",
    "a.test",
    new AbortController().signal,
  );
  const controller = new AbortController();
  const waiting = owner.acquire("b", "a.test", controller.signal);
  const rejection = expect(waiting).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejection;
  first.release({ kind: "cancelled" });
  expect(owner.ready("a.test")).toBe(true);
  expect(owner.snapshot()).toMatchObject({
    active: 0,
    queued: 0,
    recent_starts: 0,
  });
  owner.close();
});

it("enforces explicit aggregate completion and rate cooldowns across otherwise independent platforms", async () => {
  vi.useFakeTimers();
  const owner = new BrowserPlatformScheduler({
    now: () => Date.now(),
    policy: { cooldown_after_completion: 45, rate_limit_cooldown: 90 },
  });
  const signal = new AbortController().signal;
  const a = await owner.acquire("a", "a.test", signal);
  await a.start();
  a.release({ kind: "completed" });
  let entered = false;
  const b = owner.acquire("b", "b.test", signal).then((lease) => {
    entered = true;
    return lease;
  });
  await vi.advanceTimersByTimeAsync(44_999);
  expect(entered).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const second = await b;
  await second.start();
  second.release({ kind: "rate-limited", retry_after_ms: 1_000 });
  entered = false;
  const c = owner.acquire("c", "c.test", signal).then((lease) => {
    entered = true;
    return lease;
  });
  await vi.advanceTimersByTimeAsync(89_999);
  expect(entered).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  (await c).release({ kind: "cancelled" });
  owner.close();
});

it("applies failure cooldown after local validation and counts only explicit runtime failures toward its threshold", async () => {
  vi.useFakeTimers();
  const owner = new BrowserPlatformScheduler({
    now: () => Date.now(),
    policy: { failure_cooldown: 7, runtime_failure_threshold: 2 },
  });
  const signal = new AbortController().signal;
  owner.failed();
  expect(owner.snapshot().runtime_failures).toBe(0);
  expect(owner.ready("other.test")).toBe(false);
  await vi.advanceTimersByTimeAsync(7_000);
  for (const id of ["a", "b"]) {
    const lease = await owner.acquire(id, `${id}.test`, signal);
    await lease.start();
    lease.release({ kind: "runtime-failure" });
    if (id === "a") {
      expect(owner.unavailable()).toBe(false);
      await vi.advanceTimersByTimeAsync(7_000);
    }
  }
  expect(owner.unavailable()).toBe(true);
  expect(owner.snapshot().runtime_failures).toBe(2);
  const pending = owner.acquire("c", "c.test", signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  owner.close();
  await rejected;
});
