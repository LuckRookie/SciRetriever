import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import {
  createAgentTransport,
  type AgentTransportOptions,
} from "../src/network/http.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

describe("agent network transport", () => {
  it("routes adapter requests through URL admission and shared budget state", async () => {
    let receivedAuthorization: string | undefined;
    let receivedCredential: string | null = null;
    const server = createServer((request, response) => {
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
          headers: [["authorization", "Bearer secret"]],
          credential_query: [["api_key", "query-secret"]],
          body: new TextEncoder().encode("{}"),
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(receivedAuthorization).toBe("Bearer secret");
      expect(receivedCredential).toBe("query-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
