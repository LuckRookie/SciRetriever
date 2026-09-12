import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { requestFollowingRedirects } from "../src/network/http.js";

describe("network redirect credential handling", () => {
  it("re-admits each hop and removes authorization across origins", async () => {
    let secondAuthorization: string | undefined;
    const second = createServer((socket) => {
      socket.on("data", (data) => {
        secondAuthorization = data
          .toString()
          .split("\r\n")
          .find((line) => line.toLowerCase().startsWith("authorization:"));
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
        );
      });
    });
    const first = createServer((socket) => {
      socket.on("data", () => {
        socket.end(
          `HTTP/1.1 302 Found\r\nLocation: http://second.example:${(second.address() as AddressInfo).port}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
      });
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        second.once("error", reject);
        second.listen(0, "127.0.0.1", () => resolve());
      }),
      new Promise<void>((resolve, reject) => {
        first.once("error", reject);
        first.listen(0, "127.0.0.1", () => resolve());
      }),
    ]);
    const firstPort = (first.address() as AddressInfo).port;
    const secondPort = (second.address() as AddressInfo).port;
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"] as const,
      allowed_ports: [
        { scheme: "http" as const, port: firstPort },
        { scheme: "http" as const, port: secondPort },
      ],
    };
    try {
      await expect(
        requestFollowingRedirects(
          `http://first.example:${firstPort}/start`,
          () => ["127.0.0.1"],
          policy,
          { headers: [["Authorization", "Bearer secret"]] },
        ),
      ).resolves.toMatchObject({ status: 200 });
      expect(secondAuthorization).toBeUndefined();
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => first.close(() => resolve())),
        new Promise<void>((resolve) => second.close(() => resolve())),
      ]);
    }
  });
});
