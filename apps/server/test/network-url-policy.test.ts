import { describe, expect, it } from "vitest";

import {
  NetworkPolicyError,
  normalizeUrl,
  resolveDestination,
} from "../src/network/policy.js";

describe("network URL policy", () => {
  it("returns a stable canonical destination for an ordinary URL", () => {
    expect(normalizeUrl("https://EXAMPLE.test/a%20b?q=ok").url).toBe(
      "https://example.test/a%20b?q=ok",
    );
  });

  it("rejects URL authority, query, path, and control character hazards", () => {
    const invalid = [
      "https://user:password@example.test",
      "https://example.test/#fragment",
      "https://example.test/?access_token=secret",
      "https://example.test/a/../b",
      "https://example.test/a/%2f/b",
      "https://example.test/a/%252e%252e/b",
      "https://example.test/a%00/b",
    ];
    for (const value of invalid)
      expect(() => normalizeUrl(value)).toThrow(NetworkPolicyError);
  });

  it("rejects malformed URLs before a resolver could be called", async () => {
    let calls = 0;
    await expect(
      resolveDestination("https://example.test:0443", () => {
        calls += 1;
        return ["93.184.216.34"];
      }),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(calls).toBe(0);
  });
});
