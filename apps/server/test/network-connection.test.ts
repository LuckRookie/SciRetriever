import { describe, expect, it } from "vitest";

import { connectVerified } from "../src/network/connection.js";
import {
  NetworkPolicyError,
  resolveDestination,
} from "../src/network/policy.js";

describe("network socket admission", () => {
  it("rejects an unverified destination before invoking a connector", async () => {
    let calls = 0;
    const connector = (): never => {
      calls += 1;
      throw new Error("connector must not run");
    };
    await expect(
      connectVerified({} as never, "127.0.0.1", 100, { connect: connector }),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(calls).toBe(0);
  });

  it("passes the admitted IP and port to the connector", async () => {
    const destination = await resolveDestination(
      "http://127.0.0.1:1234/resource",
      () => [],
      {
        allowed_schemes: ["http"],
        allowed_classes: ["loopback"],
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http", port: 1234 }],
      },
    );
    let options: unknown;
    const socket = {
      on: () => socket,
      once: (event: string, callback: () => void) => {
        if (event === "connect") queueMicrotask(callback);
        return socket;
      },
      removeListener: () => socket,
      destroy: () => undefined,
    } as never;
    await connectVerified(destination, "127.0.0.1", 100, {
      connect: (value) => {
        options = value;
        return socket;
      },
    });
    expect(options).toEqual({ host: "127.0.0.1", port: 1234 });
  });
});
