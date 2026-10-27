import { observeNetworkRequests } from "../src/network/request-activity.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import {
  createAgentTransport,
  requestFollowingRedirects,
  requestOnce,
} from "../src/network/http.js";
import { resolveDestination } from "../src/network/policy.js";

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    policy: {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: [{ scheme: "http" as const, port }],
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("HTTP diagnostic facts and declared transport limits", () => {
  it("backs off a redirected 502 across targets without reporting it as a rate limit", async () => {
    const paths: string[] = [];
    const site = await fixture((request, response) => {
      paths.push(request.url!);
      if (request.url!.startsWith("/mirror"))
        response.writeHead(302, { location: "/shared/pdf" });
      else if (request.url === "/shared/pdf") response.writeHead(502);
      response.end();
    });
    const coordinator = new NetworkBudgetCoordinator();
    const controller = new AbortController();
    const resolutions: string[] = [];
    const budget = {
      coordinator,
      scope: "mirror",
      limits: {
        maxConcurrency: 1,
        maxResponseBytes: 1024,
        maxRedirects: 2,
        maxRetries: 2,
      },
      resolveAccess: (url: string) => {
        const path = new URL(url).pathname;
        resolutions.push(path);
        return {
          scope: path.startsWith("/shared") ? "shared-host" : "mirror",
          limits: {
            retryAfterScope: "group" as const,
            serverErrorBackoffMs: 30_000,
          },
        };
      },
    };
    try {
      const first = await requestFollowingRedirects(
        `${site.url}/mirror-one`,
        () => [],
        site.policy,
        { budget },
      );
      expect(first.status).toBe(502);
      expect(first.retry_after_ms).toBeUndefined();
      const pending = requestFollowingRedirects(
        `${site.url}/mirror-two`,
        () => [],
        site.policy,
        { budget, signal: controller.signal },
      );
      const cancelled = expect(pending).rejects.toMatchObject({
        code: "network-http",
      });
      await vi.waitFor(() =>
        expect(resolutions).toEqual([
          "/mirror-one",
          "/shared/pdf",
          "/mirror-two",
          "/shared/pdf",
        ]),
      );
      // A different service remains available while the shared redirect host cools down.
      expect(
        (
          await requestFollowingRedirects(
            `${site.url}/independent`,
            () => [],
            site.policy,
            { budget },
          )
        ).status,
      ).toBe(200);
      expect(paths).toEqual([
        "/mirror-one",
        "/shared/pdf",
        "/mirror-two",
        "/independent",
      ]);
      controller.abort();
      await cancelled;
    } finally {
      controller.abort();
      coordinator.close();
      await site.close();
    }
  });

  it("re-resolves access at every redirect and never borrows the preceding service quota", async () => {
    const paths: string[] = [];
    const site = await fixture((request, response) => {
      paths.push(request.url!);
      if (request.url === "/start")
        response.writeHead(302, { location: "/file" });
      response.end("fixture");
    });
    const coordinator = new NetworkBudgetCoordinator();
    const limits = {
      maxConcurrency: 1,
      maxResponseBytes: 1024,
      maxRedirects: 2,
      maxRetries: 0,
    };
    const occupied = await coordinator.acquire("file-service", "127.0.0.1", {
      ...limits,
      maxHostConcurrency: 2,
    });
    const controller = new AbortController();
    const resolutions: string[] = [];
    try {
      const pending = requestFollowingRedirects(
        `${site.url}/start`,
        () => [],
        site.policy,
        {
          signal: controller.signal,
          budget: {
            coordinator,
            scope: "origin-service",
            limits: { ...limits, maxHostConcurrency: 2 },
            resolveAccess: (url) => {
              const path = new URL(url).pathname;
              resolutions.push(path);
              return {
                scope: path === "/file" ? "file-service" : "origin-service",
                limits: {},
              };
            },
          },
        },
      );
      const rejection = expect(pending).rejects.toMatchObject({
        code: "network-http",
      });
      await vi.waitFor(() => expect(resolutions).toEqual(["/start", "/file"]));
      expect(paths).toEqual(["/start"]);
      controller.abort();
      await rejection;
    } finally {
      occupied.release();
      coordinator.close();
      await site.close();
    }
  });

  it("blocks queued siblings before releasing a rate-limited response and reports long backoff without retrying", async () => {
    let respond!: () => void;
    let requests = 0;
    const site = await fixture((_request, response) => {
      requests++;
      respond = () => {
        response.writeHead(429);
        response.end();
      };
    });
    const coordinator = new NetworkBudgetCoordinator();
    const controller = new AbortController();
    const budget = {
      coordinator,
      scope: "quota",
      limits: {
        maxConcurrency: 1,
        maxResponseBytes: 1024,
        maxRedirects: 0,
        maxRetries: 1,
        rateLimitBackoffMs: 60_000,
      },
    };
    try {
      const first = requestFollowingRedirects(site.url, () => [], site.policy, {
        budget,
      });
      await vi.waitFor(() => expect(requests).toBe(1));
      const second = requestFollowingRedirects(
        site.url,
        () => [],
        site.policy,
        { budget, signal: controller.signal },
      );
      const rejected = expect(second).rejects.toMatchObject({
        code: "network-http",
      });
      respond();
      expect(await first).toMatchObject({
        status: 429,
        retry_after_ms: 60_000,
      });
      expect(requests).toBe(1);
      controller.abort();
      await rejected;
    } finally {
      coordinator.close();
      await site.close();
    }
  });

  it("honors a transport allowance above 1 MiB and releases after a true byte overflow", async () => {
    const payload = Buffer.alloc(1_500_000, 97);
    const site = await fixture((_request, response) => response.end(payload));
    const coordinator = new NetworkBudgetCoordinator();
    const transport = (maxResponseBytes: number) =>
      createAgentTransport({
        resolver: () => ["127.0.0.1"],
        policy: site.policy,
        coordinator,
        scope: "large-response",
        limits: {
          maxConcurrency: 1,
          maxResponseBytes,
          maxRedirects: 0,
          maxRetries: 0,
        },
      });
    const input = { endpoint: site.url, headers: [], body: new Uint8Array() };
    try {
      const response = await transport(2_000_000)(input);
      expect(Buffer.from(response.body).equals(payload)).toBe(true);
      await expect(transport(1_400_000)(input)).rejects.toMatchObject({
        code: "network-http",
        reason: "response-limit",
      });
      await expect(transport(2_000_000)(input)).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      coordinator.close();
      await site.close();
    }
  });

  it.each(["timeout", "cancelled"] as const)(
    "preserves %s after the response headers",
    async (reason) => {
      let entered!: () => void;
      const headers = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const site = await fixture((_request, response) => {
        response.flushHeaders();
        entered();
      });
      const destination = await resolveDestination(
        site.url,
        () => [],
        site.policy,
      );
      const controller = new AbortController();
      try {
        const pending = requestOnce(destination, "127.0.0.1", {
          timeoutMs: reason === "timeout" ? 100 : 1_000,
          signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({
          code: "network-http",
          reason,
        });
        await headers;
        if (reason === "cancelled") controller.abort();
        await rejected;
      } finally {
        await site.close();
      }
    },
  );

  it("reports redirect exhaustion precisely when a shared budget owns the hops", async () => {
    let requests = 0;
    const site = await fixture((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "/loop" });
      response.end();
    });
    const coordinator = new NetworkBudgetCoordinator();
    try {
      await expect(
        requestFollowingRedirects(site.url, () => [], site.policy, {
          budget: {
            coordinator,
            scope: "redirects",
            limits: {
              maxConcurrency: 1,
              maxResponseBytes: 1_024,
              maxRedirects: 2,
              maxRetries: 0,
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "network-http",
        reason: "redirect-limit",
      });
      expect(requests).toBe(3);
    } finally {
      coordinator.close();
      await site.close();
    }
  });

  it("does not count retries as redirects and retains Retry-After from earlier responses", async () => {
    let requests = 0;
    const site = await fixture((_request, response) => {
      requests += 1;
      response.writeHead(
        requests === 1 ? 429 : requests === 2 ? 302 : 200,
        requests === 1
          ? { "retry-after": "0" }
          : requests === 2
            ? { location: "/final" }
            : {},
      );
      response.end();
    });
    const coordinator = new NetworkBudgetCoordinator();
    try {
      await expect(
        requestFollowingRedirects(site.url, () => [], site.policy, {
          budget: {
            coordinator,
            scope: "retry-redirect",
            limits: {
              maxConcurrency: 1,
              maxResponseBytes: 1_024,
              maxRedirects: 1,
              maxRetries: 1,
            },
          },
        }),
      ).resolves.toMatchObject({ status: 200, retry_after_ms: 0 });
      expect(requests).toBe(3);
    } finally {
      coordinator.close();
      await site.close();
    }
  });

  it("applies the final 429 cooldown even after retries are exhausted", async () => {
    const site = await fixture((_request, response) => {
      response.writeHead(429, { "retry-after": "1" });
      response.end();
    });
    const coordinator = new NetworkBudgetCoordinator();
    const feedback = vi.spyOn(coordinator, "applyRetryAfter");
    const limits = {
      maxConcurrency: 1,
      maxResponseBytes: 1_024,
      maxRedirects: 0,
      maxRetries: 0,
    };
    try {
      const response = await requestFollowingRedirects(
        site.url,
        () => [],
        site.policy,
        {
          budget: { coordinator, scope: "limited", limits },
        },
      );
      expect(response).toMatchObject({ status: 429, retry_after_ms: 1_000 });
      expect(feedback).toHaveBeenCalledWith("limited", "127.0.0.1", 1, limits);
      const controller = new AbortController();
      let granted = false;
      const queued = coordinator.acquire("limited", "127.0.0.1", limits, {
        signal: controller.signal,
      });
      void queued.then(
        (permit) => {
          granted = true;
          permit.release();
        },
        () => undefined,
      );
      const rejected = expect(queued).rejects.toMatchObject({
        code: "network-budget",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(granted).toBe(false);
      controller.abort();
      await rejected;
    } finally {
      coordinator.close();
      await site.close();
    }
  });

  it("waits a redirect Retry-After and retains it when cancelled before the next host", async () => {
    let requests = 0;
    let entered!: () => void;
    const first = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const site = await fixture((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "/later", "retry-after": "1" });
      response.end();
      entered();
    });
    const controller = new AbortController();
    try {
      const pending = requestFollowingRedirects(
        site.url,
        () => [],
        site.policy,
        { signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: "network-http",
        reason: "cancelled",
        retry_after_ms: 1_000,
      });
      await first;
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await rejected;
      expect(requests).toBe(1);
    } finally {
      await site.close();
    }
  });

  it("retains earlier Retry-After when the redirect budget is exhausted", async () => {
    const site = await fixture((_request, response) => {
      response.writeHead(302, { location: "/loop", "retry-after": "0" });
      response.end();
    });
    try {
      await expect(
        requestFollowingRedirects(site.url, () => [], site.policy, {
          maxRedirects: 1,
        }),
      ).rejects.toMatchObject({
        code: "network-http",
        reason: "redirect-limit",
        retry_after_ms: 0,
      });
    } finally {
      await site.close();
    }
  });
});

it("reports only dispatched HTTP requests and exposes no request material to the observer", async () => {
  let requests = 0;
  const site = await fixture((_request, response) => {
    requests++;
    response.end("Synthetic response");
  });
  const dispatched = vi.fn();
  try {
    await observeNetworkRequests(dispatched, () =>
      requestFollowingRedirects(
        site.url + "/file?opaque=synthetic",
        () => [],
        site.policy,
      ),
    );
    expect(requests).toBe(1);
    expect(dispatched.mock.calls).toEqual([[]]);
    const rejected = vi.fn();
    await expect(
      observeNetworkRequests(rejected, () =>
        requestFollowingRedirects(site.url, () => [], {
          ...site.policy,
          allowed_classes: ["public"],
        }),
      ),
    ).rejects.toThrow();
    expect(rejected).not.toHaveBeenCalled();
    expect(requests).toBe(1);
  } finally {
    await site.close();
  }
});
