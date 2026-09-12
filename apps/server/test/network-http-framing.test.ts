import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { requestOnce, NetworkHttpError } from "../src/network/http.js";
import { resolveDestination } from "../src/network/policy.js";

async function listen(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

describe("network HTTP framing and body limits", () => {
  it("rejects truncated content and permits a later request", async () => {
    let requests = 0;
    const { server, port } = await listen((_request, response) => {
      requests += 1;
      response.setHeader("Content-Length", requests === 1 ? "4" : "2");
      response.end(requests === 1 ? "ab" : "ok");
    });
    const destination = await resolveDestination(
      `http://127.0.0.1:${port}/resource`,
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
        requestOnce(destination, "127.0.0.1", { timeoutMs: 500 }),
      ).rejects.toBeInstanceOf(NetworkHttpError);
      await expect(
        requestOnce(destination, "127.0.0.1", { timeoutMs: 500 }),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("counts decoded body bytes and releases after an over-limit response", async () => {
    const { server, port } = await listen((_request, response) => {
      response.setHeader("X-Large", "1234567890");
      response.setHeader("Content-Length", "3");
      response.end("abc");
    });
    const destination = await resolveDestination(
      `http://127.0.0.1:${port}/resource`,
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
