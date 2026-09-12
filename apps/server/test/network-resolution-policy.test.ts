import { describe, expect, it } from "vitest";

import {
  classifyAddress,
  NetworkPolicyError,
  resolveDestination,
} from "../src/network/policy.js";

describe("network DNS resolution policy", () => {
  it("classifies IPv4, IPv6, mapped, and reserved ranges", () => {
    const cases = [
      ["0.0.0.0", "unspecified"],
      ["127.0.0.1", "loopback"],
      ["169.254.1.1", "link-local"],
      ["224.0.0.1", "multicast"],
      ["10.0.0.1", "private"],
      ["192.0.2.1", "reserved"],
      ["93.184.216.34", "public"],
      ["::", "unspecified"],
      ["::1", "loopback"],
      ["fe80::1", "link-local"],
      ["ff02::1", "multicast"],
      ["fc00::1", "private"],
      ["2001:db8::1", "reserved"],
      ["::ffff:127.0.0.1", "loopback"],
    ] as const;
    for (const [address, expected] of cases)
      expect(classifyAddress(address)).toBe(expected);
  });

  it("rejects mixed DNS answers, malformed answers, and rebinding", async () => {
    const publicPolicy = { allowed_schemes: ["https"] as const };
    await expect(
      resolveDestination(
        "https://mixed.example",
        () => ["93.184.216.34", "10.0.0.1"],
        publicPolicy,
      ),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(
      resolveDestination("https://bad.example", () => ["127.1"], publicPolicy),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    const first = await resolveDestination(
      "https://stable.example",
      () => ["93.184.216.34"],
      publicPolicy,
    );
    await expect(
      resolveDestination(
        first.url,
        () => ["93.184.216.35"],
        publicPolicy,
        first,
      ),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
  });
});
