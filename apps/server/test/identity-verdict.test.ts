import { describe, expect, it } from "vitest";
import { judgeIdentity } from "../src/acquisition/identity-verdict.js";

describe("conservative identity and version verdict", () => {
  it("accepts matching identifier evidence and rejects an explicit version conflict", () => {
    expect(
      judgeIdentity({
        targetIdentifier: "doi:10.1/x",
        candidateIdentifier: "doi:10.1/x",
        targetVersion: "published",
        candidateVersion: "published",
        isPdf: true,
      }).disposition,
    ).toBe("accepted");
    expect(
      judgeIdentity({
        targetIdentifier: "doi:10.1/x",
        candidateIdentifier: "doi:10.1/y",
        isPdf: true,
      }).disposition,
    ).toBe("uncertain");
    expect(
      judgeIdentity({
        targetIdentifier: "doi:10.1/x",
        candidateIdentifier: "doi:10.1/x",
        targetVersion: "published",
        isPdf: true,
      }).disposition,
    ).toBe("accepted");
    expect(
      judgeIdentity({
        targetIdentifier: "doi:10.1/x",
        candidateIdentifier: "doi:10.1/x",
        targetVersion: "published",
        candidateVersion: "preprint",
        isPdf: true,
      }).disposition,
    ).toBe("uncertain");
  });
  it("rejects non-PDF and never treats missing evidence as accepted", () => {
    expect(
      judgeIdentity({ targetIdentifier: "doi:10.1/x", isPdf: false })
        .disposition,
    ).toBe("rejected");
    expect(
      judgeIdentity({ targetIdentifier: "doi:10.1/x", isPdf: true })
        .disposition,
    ).toBe("uncertain");
  });
});
