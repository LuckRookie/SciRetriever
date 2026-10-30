import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ArchiveStepReceipt } from "@sciretriever/contracts";
import { parseConfiguration } from "../src/configuration/index.js";
import { AgentFailure } from "../src/agents/protocol.js";
import { ArchivePageProofreadService } from "../src/proofread/page-service.js";
import {
  archiveTextFixture,
  arranged,
  fakePages,
  fakeTextRuntime,
  initialPage,
  memoryTextCache,
  modelTool,
} from "./archive-text-fixture.js";

const fixture = (count: number) =>
  archiveTextFixture(
    Array.from({ length: count }, (_, page) => ({
      text: `PAGE${page} synthetic paragraph.`,
      page,
    })),
  );
// ADR 0047: one request per page; the fixture finds nothing to change.
const decision = () =>
  modelTool("submit_corrections", { corrections: [], uncertain: [] });

it("defaults to three independent page requests, serializes progress, and orders accepted pages independently of completion", async () => {
  const f = await fixture(5),
    steps = new Map<number, number>(),
    completed: number[] = [];
  const counts: NonNullable<ArchiveStepReceipt["pages"]>[] = [],
    calls: number[] = [];
  let release!: () => void,
    active = 0,
    peak = 0,
    reporting = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = fakeTextRuntime(async (request) => {
    const p = initialPage(request).page_index;
    const text = JSON.stringify(request.messages);
    for (let other = 0; other < 5; other++)
      if (other !== p) expect(text).not.toContain(`PAGE${other} synthetic`);
    const step = (steps.get(p) ?? 0) + 1;
    steps.set(p, step);
    active++;
    peak = Math.max(peak, active);
    try {
      if (p === 0 && step === 1) await held;
      else await delay(3);
      return decision();
    } finally {
      active--;
    }
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(
      f.source,
      arranged(f.source),
      f.pages,
      undefined,
      [],
      async (page, reused, usage, current) => {
        expect(reporting).toBe(false);
        reporting = true;
        completed.push(page.page_index);
        counts.push(current);
        calls.push(usage.calls);
        expect(reused).toBe(false);
        if (page.page_index === 2) release();
        await delay(1);
        reporting = false;
      },
    );
    expect(peak).toBe(3);
    expect(completed[0]).not.toBe(0);
    expect(result.pages.map((p) => p.page_index)).toEqual([0, 1, 2, 3, 4]);
    expect(result.complete).toBe(true);
    expect(result.usage).toMatchObject({
      calls: 5,
      usage_complete: true,
    });
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
    expect(counts.at(-1)).toEqual({
      required: 5,
      accepted: 5,
      failed: 0,
      reused: 0,
      pending: 0,
    });
    expect(
      counts.every((c) => c.required === c.accepted + c.failed + c.pending),
    ).toBe(true);
  } finally {
    release();
    await runtime.close();
  }
});

it.each(["validation-repeated"] as const)(
  "isolates a page stopped for %s and retries or reuses exactly selected inputs",
  async (stop) => {
    const f = await fixture(4),
      cache = memoryTextCache(),
      steps = new Map<number, number>();
    let broken = true;
    const visited = new Set<number>();
    const runtime = fakeTextRuntime(async (request) => {
      const p = initialPage(request).page_index;
      visited.add(p);
      // A malformed submission is rejected the same way each time.
      if (p === 1 && broken)
        return modelTool("submit_corrections", {
          corrections: "x",
          uncertain: [],
        });
      const step = (steps.get(p) ?? 0) + 1;
      steps.set(p, step);
      return decision();
    });
    try {
      const service = new ArchivePageProofreadService(
        runtime,
        fakePages(f.pages),
        cache.cache,
      );
      const first = await service.build(f.source, arranged(f.source), f.pages);
      expect(first.pages.map((p) => p.status)).toEqual([
        "accepted",
        "failed",
        "accepted",
        "accepted",
      ]);
      expect(first.pages[1]!.stop?.code).toBe(stop);
      broken = false;
      visited.clear();
      const second = await service.build(
        f.source,
        arranged(f.source),
        f.pages,
        undefined,
        [],
        undefined,
        new Map(
          first.pages
            .filter((p) => p.page_index !== 1)
            .map((p) => [p.page_index, p]),
        ),
      );
      expect([...visited]).toEqual([1]);
      expect(second.complete).toBe(true);
      expect(second.reused_page_indexes).toEqual([0, 2, 3]);
      expect(second.usage.calls).toBe(1);
      expect(cache.entries.size).toBe(4);
    } finally {
      await runtime.close();
    }
  },
);

it("retries throttled requests inside the same conversation, honors Retry-After, reduces concurrency, and excludes throttling from no-progress", async () => {
  const f = await fixture(5),
    steps = new Map<number, number>();
  const limited: number[] = [],
    attempts: number[] = [];
  let quotas = 10,
    active = 0,
    peakAfter = 0,
    firstRequest = "",
    secondRequest = "";
  const runtime = fakeTextRuntime(async (request) => {
    const p = initialPage(request).page_index;
    if (p === 0) attempts.push(Date.now());
    // Ten transport rejections must not trigger the eight-decision stop rule.
    if (p === 0 && quotas-- > 0) {
      if (!firstRequest) firstRequest = JSON.stringify(request);
      else secondRequest = JSON.stringify(request);
      limited.push(Date.now());
      throw new AgentFailure("agent-quota", true, { retry_after_ms: 15 });
    }
    active++;
    if (limited.length >= 2) peakAfter = Math.max(peakAfter, active);
    try {
      await delay(2);
      const step = (steps.get(p) ?? 0) + 1;
      steps.set(p, step);
      return decision();
    } finally {
      active--;
    }
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source), f.pages);
    expect(result.complete).toBe(true);
    expect(firstRequest).toBe(secondRequest);
    expect(result.usage.calls).toBe(15);
    expect(result.usage.usage_complete).toBe(false);
    expect(result.usage.input_tokens).toBeNull();
    expect(result.usage.rate_limits).toHaveLength(10);
    expect(
      result.usage
        .rate_limits!.slice(0, 2)
        .map((r) => [r.concurrency_before, r.concurrency_after]),
    ).toEqual([
      [3, 2],
      [2, 1],
    ]);
    expect(result.pages[0]!.usage.rate_limits).toHaveLength(10);
    expect(peakAfter).toBe(1);
    for (const time of limited)
      expect(
        attempts.find((attempt) => attempt > time)! - time,
      ).toBeGreaterThanOrEqual(14);
  } finally {
    await runtime.close();
  }
});

it("cancels all in-flight pages and records unstarted ones while preserving an already accepted page", async () => {
  const f = await fixture(6),
    controller = new AbortController(),
    cache = memoryTextCache(),
    steps = new Map<number, number>();
  const aborted: number[] = [];
  const runtime = fakeTextRuntime(async (request, _options, signal) => {
    const p = initialPage(request).page_index;
    if (p !== 0) {
      try {
        await delay(10000, undefined, { signal });
      } catch {
        aborted.push(p);
        throw new AgentFailure("agent-cancelled");
      }
    }
    const step = (steps.get(p) ?? 0) + 1;
    steps.set(p, step);
    return decision();
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      cache.cache,
    ).build(
      f.source,
      arranged(f.source),
      f.pages,
      controller.signal,
      [],
      async (page) => {
        if (page.page_index === 0) controller.abort();
      },
    );
    expect(result.pages[0]!.status).toBe("accepted");
    expect(
      result.pages.slice(1).every((p) => p.stop?.code === "cancelled"),
    ).toBe(true);
    expect(aborted.sort()).toEqual([1, 2]);
    expect(cache.entries.size).toBe(1);
    expect(result.pages).toHaveLength(6);
  } finally {
    await runtime.close();
  }
});

it("validates the configuration-only page concurrency without changing the model binding", () => {
  expect(parseConfiguration("").proofread).toEqual({
    model: null,
    max_concurrent_pages: 3,
  });
  for (const value of [1, 3, 8])
    expect(
      parseConfiguration(`[proofread]\nmax_concurrent_pages=${value}\n`)
        .proofread.max_concurrent_pages,
    ).toBe(value);
  for (const value of [0, 9, -1, 1.5, '"3"', true])
    expect(() =>
      parseConfiguration(`[proofread]\nmax_concurrent_pages=${value}\n`),
    ).toThrow();
});

it("finishes publishing a host-accepted cache entry when cancellation arrives during its write", async () => {
  const f = await fixture(2),
    controller = new AbortController(),
    cache = memoryTextCache();
  const steps = new Map<number, number>();
  const runtime = fakeTextRuntime(async (request) => {
    const p = initialPage(request).page_index,
      step = (steps.get(p) ?? 0) + 1;
    steps.set(p, step);
    return decision();
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      {
        read: cache.cache.read,
        save: async (key, bytes, media, signal) => {
          expect(signal).toBeUndefined();
          controller.abort();
          return cache.cache.save(key, bytes, media);
        },
      },
      1,
    ).build(f.source, arranged(f.source), f.pages, controller.signal);
    expect(result.pages.map((p) => p.status)).toEqual(["accepted", "failed"]);
    expect(result.pages[1]!.stop?.code).toBe("cancelled");
    expect(cache.entries.size).toBe(1);
  } finally {
    await runtime.close();
  }
});

it("keeps a cache-read cancellation local to its page and retains every page disposition", async () => {
  const f = await fixture(3),
    controller = new AbortController();
  const runtime = fakeTextRuntime(async () => {
    throw Error("model-must-not-run");
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      {
        read: async () => {
          controller.abort();
          throw new Error("synthetic-cache-cancelled");
        },
        save: async () => {
          throw Error("must-not-publish");
        },
      },
    ).build(f.source, arranged(f.source), f.pages, controller.signal);
    expect(result.pages).toHaveLength(3);
    expect(result.pages.every((p) => p.stop?.code === "cancelled")).toBe(true);
    expect(result.usage.calls).toBe(0);
  } finally {
    await runtime.close();
  }
});

it("records each individual downgrade when two pages are throttled concurrently", async () => {
  const f = await fixture(3),
    limited = new Set<number>(),
    steps = new Map<number, number>();
  let release!: () => void;
  const both = new Promise<void>((done) => {
    release = done;
  });
  const runtime = fakeTextRuntime(async (request) => {
    const p = initialPage(request).page_index;
    if (p < 2 && !limited.has(p)) {
      limited.add(p);
      if (limited.size === 2) release();
      await both;
      throw new AgentFailure("agent-quota", true, { retry_after_ms: 10 });
    }
    const step = (steps.get(p) ?? 0) + 1;
    steps.set(p, step);
    return decision();
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source), f.pages);
    expect(result.complete).toBe(true);
    expect(result.usage.calls).toBe(5);
    expect(
      result.usage
        .rate_limits!.map((r) => [r.concurrency_before, r.concurrency_after])
        .sort((a, b) => b[0]! - a[0]!),
    ).toEqual([
      [3, 2],
      [2, 1],
    ]);
  } finally {
    release();
    await runtime.close();
  }
});
