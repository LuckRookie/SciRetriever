import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { requestOnce, NetworkHttpError } from "../src/network/http.js";
import { resolveDestination } from "../src/network/policy.js";

describe("network cancellation propagation", () => {
  it("stops a response read and releases the permit after AbortSignal", async () => {
    let closed = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Length": 100 });
      response.write("partial");
      response.on("close", () => {
        closed = true;
      });
      setTimeout(() => response.end("late"), 200);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const destination = await resolveDestination(
      `http://127.0.0.1:${port}/slow`,
      () => [],
      {
        allowed_schemes: ["http"],
        allowed_classes: ["loopback"],
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http", port }],
      },
    );
    const controller = new AbortController();
    try {
      const pending = requestOnce(destination, "127.0.0.1", {
        signal: controller.signal,
        timeoutMs: 1_000,
        budget: {
          coordinator: new (
            await import("../src/network/budget.js")
          ).NetworkBudgetCoordinator(),
          scope: "read",
          limits: {
            maxConcurrency: 1,
            maxResponseBytes: 100,
            maxRedirects: 0,
            maxRetries: 0,
          },
        },
      });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toBeInstanceOf(NetworkHttpError);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 3_000);
});
