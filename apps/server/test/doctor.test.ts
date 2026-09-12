import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/entry/doctor.js";

describe("installed runtime doctor", () => {
  it("reports all local prerequisites without launching a browser or using the network", async () => {
    const report = await runDoctor({ cloakBundle: null });
    expect(report).toMatchObject({
      schema_version: 1,
      platform: "linux",
      architecture: "x64",
    });
    expect(
      report.checks
        .filter((item) => item.status === "ready")
        .map((item) => item.name),
    ).toEqual(["platform", "flock", "prlimit", "pdfinfo", "pdftotext", "Xvfb"]);
    expect(report.checks.at(-1)).toMatchObject({
      name: "cloakbrowser",
      status: "blocked",
    });
  });
});
