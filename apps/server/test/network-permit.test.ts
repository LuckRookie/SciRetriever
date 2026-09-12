import { describe, expect, it } from "vitest";
import {
  NetworkBudgetCoordinator,
  NetworkBudgetError,
} from "../src/network/budget.js";

const limits = {
  maxConcurrency: 1,
  maxHostConcurrency: 1,
  maxResponseBytes: 10,
  maxRedirects: 0,
  maxRetries: 0,
} as const;

describe("network permit coordination", () => {
  it("applies the strictest shared scope and host limits fairly", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    const first = await coordinator.acquire(
      "metadata",
      "shared.example",
      limits,
    );
    let granted = false;
    const waiting = coordinator
      .acquire("references", "shared.example", {
        ...limits,
        maxConcurrency: 2,
        maxHostConcurrency: 2,
      })
      .then((permit) => {
        granted = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(granted).toBe(false);
    first.release();
    first.release();
    const second = await waiting;
    second.release();
    expect(granted).toBe(true);
  });

  it("removes cancelled waiters without consuming a future permit", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    const first = await coordinator.acquire("scope", "host", limits);
    const controller = new AbortController();
    const waiting = coordinator.acquire("scope", "host", limits, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(NetworkBudgetError);
    first.release();
    const next = await coordinator.acquire("scope", "host", limits);
    next.release();
  });
});
