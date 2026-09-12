import { describe, expect, it } from "vitest";
import {
  NetworkBudgetCoordinator,
  NetworkBudgetError,
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
