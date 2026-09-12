import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONTRACTS_VERSION } from "../src/index.js";

describe("TypeScript workspace toolchain", () => {
  it("loads the strict contracts package through its source boundary", () => {
    expect(CONTRACTS_VERSION).toBe("v1");
  });

  it("keeps test files named after behavior rather than plan ordering", () => {
    const testFiles = readdirSync(new URL(".", import.meta.url)).filter(
      (file) => file.endsWith(".test.ts"),
    );
    for (const file of testFiles) {
      expect(file).not.toMatch(/(?:^|[-_])(m[0-4]|phase|step)(?:[-_.]|$)/i);
      expect(file).not.toMatch(/(?:^|[-_])t\d{3,}(?:[-_.]|$)/i);
    }
  });
});
