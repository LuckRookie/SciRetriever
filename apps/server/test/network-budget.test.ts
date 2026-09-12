import { describe, expect, it } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import {
  NetworkHttpError,
  requestFollowingRedirects,
  requestOnce,
} from "../src/network/http.js";
import { resolveDestination } from "../src/network/policy.js";
import {
  NetworkBudgetCoordinator,
  NetworkBudgetError,
  type BudgetClock,
} from "../src/network/budget.js";

const limits = {
  maxConcurrency: 1,
  maxHostConcurrency: 1,
  maxResponseBytes: 4,
  maxRedirects: 1,
  maxRetries: 1,
  maxRetryAfterMs: 20,
} as const;

class ManualClock implements BudgetClock {
  private current = 0;
  private next = 0;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  now(): number {
    return this.current;
  }

  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    const id = this.next++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  fireEarly(): void {
    const timers = [...this.timers.values()];
    this.timers.clear();
    for (const timer of timers) timer.callback();
  }

  advance(delayMs: number): void {
    this.current += delayMs;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.current) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

describe("network budget coordination", () => {
  it("shares scope and host permits and releases them idempotently", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    const first = await coordinator.acquire(
      "metadata",
      "api.example.test",
      limits,
    );
    let granted = false;
    const waiting = coordinator
      .acquire("metadata", "api.example.test", limits)
      .then((permit) => {
        granted = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(granted).toBe(false);
    first.release();
    first.release();
    const second = await waiting;
    expect(granted).toBe(true);
    second.release();
  });

  it("cancels queued acquisition without leaking a waiter", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    const first = await coordinator.acquire("scope", "host.test", limits);
    const controller = new AbortController();
    const waiting = coordinator.acquire("scope", "host.test", limits, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(NetworkBudgetError);
    first.release();
    const next = await coordinator.acquire("scope", "host.test", limits);
    next.release();
  });

  it("times out a queued acquisition and permits the next caller", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    const first = await coordinator.acquire("scope", "host.test", limits);
    await expect(
      coordinator.acquire("scope", "host.test", limits, { timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(NetworkBudgetError);
    first.release();
    const next = await coordinator.acquire("scope", "host.test", limits);
    next.release();
  });

  it("enforces response, redirect, and explicit retry budgets", async () => {
    const permit = await new NetworkBudgetCoordinator().acquire(
      "scope",
      "host.test",
      limits,
    );
    permit.consumeResponse(4);
    expect(() => permit.consumeResponse(1)).toThrow(NetworkBudgetError);
    permit.consumeRedirect();
    expect(() => permit.consumeRedirect()).toThrow(NetworkBudgetError);
    permit.consumeRetry();
    expect(() => permit.consumeRetry()).toThrow(NetworkBudgetError);
    permit.release();
  });

  it("releases the shared permit when a response exceeds the body budget", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd",
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const destination = await resolveDestination(
      `http://127.0.0.1:${port}/body`,
      () => [],
      {
        allowed_schemes: ["http"],
        allowed_classes: ["loopback"],
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http", port }],
      },
    );
    const coordinator = new NetworkBudgetCoordinator();
    try {
      const bodyLimits = { ...limits, maxResponseBytes: 2 } as const;
      await expect(
        requestOnce(destination, "127.0.0.1", {
          budget: { coordinator, scope: "body", limits: bodyLimits },
        }),
      ).rejects.toBeInstanceOf(NetworkHttpError);
      const next = await coordinator.acquire("body", "127.0.0.1", bodyLimits);
      next.release();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("shares the host permit across independent scopes", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    const first = await coordinator.acquire("metadata", "shared.test", limits);
    let granted = false;
    const waiting = coordinator
      .acquire("references", "shared.test", limits)
      .then((permit) => {
        granted = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(granted).toBe(false);
    first.release();
    const second = await waiting;
    second.release();
  });

  it("bounds Retry-After and keeps throttled acquisition queued", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    coordinator.applyRetryAfter("scope", "host.test", 10, limits);
    let granted = false;
    const waiting = coordinator
      .acquire("scope", "host.test", limits)
      .then((permit) => {
        granted = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(granted).toBe(false);
    await expect(waiting).resolves.toMatchObject({ host: "host.test" });
    const permit = await waiting;
    permit.release();
  });

  it("uses an injected clock for bounded Retry-After without wall-clock sleeping", async () => {
    const clock = new ManualClock();
    const coordinator = new NetworkBudgetCoordinator(clock);
    coordinator.applyRetryAfter("scope", "clock.test", 5, limits);
    let granted = false;
    const waiting = coordinator
      .acquire("scope", "clock.test", limits)
      .then((permit) => {
        granted = true;
        return permit;
      });
    await Promise.resolve();
    expect(granted).toBe(false);
    clock.advance(20);
    const permit = await waiting;
    expect(granted).toBe(true);
    permit.release();
  });

  it("reschedules a Retry-After timer that fires before its deadline", async () => {
    const clock = new ManualClock();
    const coordinator = new NetworkBudgetCoordinator(clock);
    coordinator.applyRetryAfter("scope", "early.test", 10, limits);
    const waiting = coordinator.acquire("scope", "early.test", limits);
    clock.advance(19);
    clock.fireEarly();
    clock.advance(1);
    const permit = await waiting;
    expect(permit.host).toBe("early.test");
    permit.release();
  });

  it("rejects invalid budget and input values with a stable error", async () => {
    expect(() =>
      new NetworkBudgetCoordinator().applyRetryAfter(
        "",
        "host.test",
        1,
        limits,
      ),
    ).toThrow(NetworkBudgetError);
    expect(() =>
      new NetworkBudgetCoordinator().acquire("scope", "host.test", {
        ...limits,
        maxResponseBytes: 0,
      }),
    ).toThrow(NetworkBudgetError);
  });

  it("consumes retry and redirect budgets in one explicit request loop", async () => {
    let requests = 0;
    const server = createServer((socket) => {
      requests += 1;
      socket.on("data", () => {
        if (requests === 1) {
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          );
        } else {
          socket.end(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const coordinator = new NetworkBudgetCoordinator();
    const retryLimits = { ...limits, maxRetries: 1, maxRedirects: 0 } as const;
    try {
      await expect(
        requestFollowingRedirects(
          `http://retry.example:${port}/retry`,
          () => ["127.0.0.1"],
          {
            allowed_schemes: ["http"],
            allowed_classes: ["loopback"],
            allowed_addresses: ["127.0.0.1"],
            allowed_ports: [{ scheme: "http", port }],
          },
          {
            budget: {
              coordinator,
              scope: "retry-loop",
              limits: retryLimits,
            },
            maxRetries: 1,
          },
        ),
      ).resolves.toMatchObject({ status: 200 });
      expect(requests).toBe(2);
      const available = await coordinator.acquire(
        "retry-loop",
        "retry.example",
        retryLimits,
      );
      available.release();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a redirect before opening the next hop when its budget is zero", async () => {
    let requests = 0;
    const server = createHttpServer((_request, response) => {
      requests += 1;
      response.writeHead(302, { Location: "/next", "Content-Length": 0 });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        requestFollowingRedirects(
          `http://redirect.example:${port}/start`,
          () => ["127.0.0.1"],
          {
            allowed_schemes: ["http"],
            allowed_classes: ["loopback"],
            allowed_addresses: ["127.0.0.1"],
            allowed_ports: [{ scheme: "http", port }],
          },
          {
            budget: {
              coordinator: new NetworkBudgetCoordinator(),
              scope: "redirect-loop",
              limits: { ...limits, maxRedirects: 0 },
            },
          },
        ),
      ).rejects.toBeInstanceOf(NetworkBudgetError);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
