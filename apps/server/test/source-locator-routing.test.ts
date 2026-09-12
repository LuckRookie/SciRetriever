import { describe, expect, it } from "vitest";
import {
  arxivPdf,
  authorizedLocator,
  configuredMirrors,
  doiLanding,
  europePmcPdf,
  safeLocator,
  SourceLocatorError,
  unpaywallLocations,
} from "../src/acquisition/sources/locators.js";
import { routeCandidates } from "../src/acquisition/sources/route.js";

describe("source locator boundaries", () => {
  it("creates neutral locators only from reliable identifiers and safe explicit URLs", () => {
    expect(arxivPdf("2401.12345", "v2").locator).toBe(
      "https://arxiv.org/pdf/2401.12345v2.pdf",
    );
    expect(europePmcPdf("PMC123").locator).toContain("europepmc.org");
    expect(doiLanding("10.1000/test").locator).toBe(
      "https://doi.org/10.1000%2Ftest",
    );
    expect(safeLocator("direct", "https://example.test/a.pdf").locator).toBe(
      "https://example.test/a.pdf",
    );
    expect(() => safeLocator("direct", "https://u:p@example.test/a")).toThrow(
      SourceLocatorError,
    );
    expect(() => arxivPdf("unknown")).toThrow(SourceLocatorError);
  });
  it("preserves open-location order, keeps mirrors disabled by default and checks grants", () => {
    expect(
      unpaywallLocations([
        { url: "https://a.test/a.pdf" },
        { url: "https://b.test/b.pdf", version: "published" },
      ]).map((value) => value.locator),
    ).toEqual(["https://a.test/a.pdf", "https://b.test/b.pdf"]);
    expect(configuredMirrors(false, ["https://mirror.test/pdf"]).length).toBe(
      0,
    );
    expect(
      configuredMirrors(true, [
        "https://mirror.test/first",
        "https://mirror.test/second",
      ]).map((value) => value.locator),
    ).toEqual(["https://mirror.test/first", "https://mirror.test/second"]);
    expect(() =>
      authorizedLocator("core", "https://other.test/a", {
        origin: "https://core.test",
        allowed: true,
      }),
    ).toThrow(SourceLocatorError);
  });
  it("continues after ordinary misses but reports failures and never calls sources concurrently", async () => {
    const order: string[] = [];
    const result = await routeCandidates([
      async () => {
        order.push("first");
        return null;
      },
      async () => {
        order.push("second");
        throw new Error("fixture failure");
      },
      async () => {
        order.push("third");
        return arxivPdf("2401.12345");
      },
    ]);
    expect(order).toEqual(["first", "second", "third"]);
    expect(result.delivered).toHaveLength(1);
    expect(result.failures).toEqual(["route-failure"]);
    expect(result.exhausted).toBe(false);
  });
});
