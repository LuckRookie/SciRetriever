import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { requestOnce, NetworkHttpError } from "../src/network/http.js";
import { resolveDestination } from "../src/network/policy.js";

describe("network response body limits", () => {
  it("limits decoded body bytes independently of response headers", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "X-Large": "header", "Content-Length": 3 });
      response.end("abc");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const destination = await resolveDestination(
      `http://127.0.0.1:${port}/bounded`,
      () => [],
      {
        allowed_schemes: ["http"],
        allowed_classes: ["loopback"],
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http", port }],
      },
    );
    try {
      await expect(
        requestOnce(destination, "127.0.0.1", {
          maxResponseBytes: 2,
          timeoutMs: 500,
        }),
      ).rejects.toBeInstanceOf(NetworkHttpError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
