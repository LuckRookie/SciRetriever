import { describe, expect, it } from "vitest";
import {
  NetworkBudgetCoordinator,
  NetworkBudgetError,
  retryAfterDelay,
} from "../src/network/budget.js";

const limits = {
  maxConcurrency: 1,
  maxResponseBytes: 16,
  maxRedirects: 0,
  maxRetries: 0,
  maxRetryAfterMs: 100,
} as const;

describe("bounded retry-after policy", () => {
  it("accepts bounded delta and HTTP dates but rejects unsafe values", () => {
    const coordinator = new NetworkBudgetCoordinator();
    expect(coordinator.retryAfterMilliseconds("2", limits)).toBe(100);
    expect(coordinator.retryAfterMilliseconds("0", limits)).toBe(0);
    expect(
      retryAfterDelay(
        "Sun, 22 Nov 2026 01:00:00 GMT",
        Date.parse("2026-11-22T00:00:00Z"),
      ),
    ).toBe(3_600_000);
    expect(() => coordinator.retryAfterMilliseconds("-1", limits)).toThrow(
      NetworkBudgetError,
    );
    expect(() =>
      coordinator.retryAfterMilliseconds("not-a-date", limits),
    ).toThrow(NetworkBudgetError);
  });

  it("allows zero redirect and retry budgets", async () => {
    const permit = await new NetworkBudgetCoordinator().acquire(
      "scope",
      "host",
      limits,
    );
    expect(() => permit.consumeRedirect()).toThrow(NetworkBudgetError);
    expect(() => permit.consumeRetry()).toThrow(NetworkBudgetError);
    permit.release();
  });
});
