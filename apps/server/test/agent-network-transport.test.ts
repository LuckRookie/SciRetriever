import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  createAgentTransport,
  type AgentTransportOptions,
} from "../src/network/http.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

describe("agent network transport", () => {
  it("dispatches only after the shared permit and never sends a cancelled or rejected call", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      request.resume();
      response.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const coordinator = new NetworkBudgetCoordinator();
    const limits = {
      maxConcurrency: 1,
      maxHostConcurrency: 1,
      maxResponseBytes: 16,
      maxRedirects: 0,
      maxRetries: 0,
    };
    const transport = createAgentTransport({
      resolver: () => ["127.0.0.1"],
      policy: {
        allowed_schemes: ["http"],
        allowed_classes: ["loopback"],
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http", port }],
      },
      coordinator,
      scope: "dispatch",
      limits,
    });
    const held = await coordinator.acquire("dispatch", "127.0.0.1", limits);
    const dispatched = vi.fn();
    const input = {
      endpoint: `http://127.0.0.1:${port}/completion`,
      headers: [],
      body: new Uint8Array(),
      timeout_ms: 1000,
    };
    try {
      const cancelled = new AbortController();
      const cancelledCall = transport({
        ...input,
        signal: cancelled.signal,
        onDispatched: dispatched,
      });
      const rejected = expect(cancelledCall).rejects.toMatchObject({
        code: "network-http",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(dispatched).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      cancelled.abort();
      await rejected;
      const queued = transport({ ...input, onDispatched: dispatched });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(dispatched).not.toHaveBeenCalled();
      held.release();
      await queued;
      expect(dispatched).toHaveBeenCalledTimes(1);
      const budgetError = new Error("article dispatch budget exhausted");
      await expect(
        transport({
          ...input,
          onDispatched: () => {
            throw budgetError;
          },
        }),
      ).rejects.toBe(budgetError);
      await transport(input);
      expect(requests).toEqual(["/completion", "/completion"]);
    } finally {
      held.release();
      coordinator.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([
    { method: "POST", body: "{}", expectedMethod: "POST" },
    { method: "GET", body: "", expectedMethod: "GET" },
    { method: undefined, body: "", expectedMethod: "GET" },
  ])(
    "preserves $expectedMethod through URL admission and shared budget state (method=$method)",
    async ({ method, body, expectedMethod }) => {
      let receivedAuthorization: string | undefined;
      let receivedCredential: string | null = null;
      let receivedMethod: string | undefined;
      let receivedBody = "";
      const server = createServer(async (request, response) => {
        receivedMethod = request.method;
        const chunks: Buffer[] = [];
        for await (const chunk of request)
          chunks.push(Buffer.from(chunk as Uint8Array));
        receivedBody = Buffer.concat(chunks).toString();
        receivedAuthorization = request.headers.authorization;
        receivedCredential = new URL(
          request.url ?? "/",
          "http://fixture.test",
        ).searchParams.get("api_key");
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": 2,
        });
        response.end("ok");
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as AddressInfo).port;
      const limits = {
        maxConcurrency: 1,
        maxHostConcurrency: 1,
        maxResponseBytes: 16,
        maxRedirects: 0,
        maxRetries: 0,
      } as const;
      const transport = createAgentTransport({
        resolver: () => ["127.0.0.1"],
        policy: {
          allowed_schemes: ["http"],
          allowed_classes: ["loopback"],
          allowed_addresses: ["127.0.0.1"],
          allowed_ports: [{ scheme: "http", port }],
        },
        coordinator: new NetworkBudgetCoordinator(),
        scope: "agent",
        limits,
      } satisfies AgentTransportOptions);
      try {
        await expect(
          transport({
            endpoint: `http://agent.example:${port}/completion`,
            ...(method === undefined ? {} : { method }),
            headers: [["authorization", "Bearer secret"]],
            credential_query: [["api_key", "query-secret"]],
            body: new TextEncoder().encode(body),
          }),
        ).resolves.toMatchObject({ status: 200 });
        expect(receivedAuthorization).toBe("Bearer secret");
        expect(receivedCredential).toBe("query-secret");
        expect(receivedMethod).toBe(expectedMethod);
        expect(receivedBody).toBe(body);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each(["timeout", "cancel"] as const)(
    "honors the model HTTP timeout and earlier cancellation (%s)",
    async (mode) => {
      let received!: () => void;
      const entered = new Promise<void>((resolve) => {
        received = resolve;
      });
      let requests = 0;
      const server = createServer((request, response) => {
        request.resume();
        requests += 1;
        if (requests === 1) received();
        else response.end("ok");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as AddressInfo).port;
      const transport = createAgentTransport({
        resolver: () => ["127.0.0.1"],
        policy: {
          allowed_schemes: ["http"],
          allowed_classes: ["loopback"],
          allowed_addresses: ["127.0.0.1"],
          allowed_ports: [{ scheme: "http", port }],
        },
        coordinator: new NetworkBudgetCoordinator(),
        scope: "model-timeout",
        limits: {
          maxConcurrency: 1,
          maxHostConcurrency: 1,
          maxResponseBytes: 16,
          maxRedirects: 0,
          maxRetries: 0,
        },
      });
      const controller = new AbortController();
      // A broken timeout mapping still releases the local socket instead of waiting 10 s.
      const watchdog = setTimeout(() => controller.abort(), 1_000);
      try {
        const pending = transport({
          endpoint: `http://127.0.0.1:${port}/responses`,
          method: "POST",
          timeout_ms: mode === "timeout" ? 100 : 120_000,
          headers: [],
          body: new TextEncoder().encode("{}"),
          signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({
          code: "network-http",
        });
        await entered;
        if (mode === "cancel") controller.abort();
        await rejected;
        expect(controller.signal.aborted).toBe(mode === "cancel");
        await expect(
          transport({
            endpoint: `http://127.0.0.1:${port}/next`,
            timeout_ms: 500,
            headers: [],
            body: new Uint8Array(),
          }),
        ).resolves.toMatchObject({ status: 200 });
        expect(requests).toBe(2);
      } finally {
        clearTimeout(watchdog);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
