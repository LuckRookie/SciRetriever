import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/index.js";

describe("SHA-256 in ordinary HTTP browser contexts", () => {
  it("matches native digests for standard vectors, binary data, subarrays and padding boundaries", async () => {
    const binary = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
    const samples = [
      new Uint8Array(),
      new TextEncoder().encode("abc"),
      new TextEncoder().encode("中文与 Unicode 🧪"),
      binary,
      ...[55, 56, 63, 64, 65, 127, 128].map((length) =>
        binary.subarray(7, 7 + length),
      ),
    ];
    const expected = samples.map((bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    try {
      for (let i = 0; i < samples.length; i++)
        expect(await sha256(samples[i]!)).toBe(expected[i]);
      expect(await sha256(new TextEncoder().encode("abc"))).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
