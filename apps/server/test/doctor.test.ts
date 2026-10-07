import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfiguration } from "../src/configuration/index.js";
import { runDoctor } from "../src/entry/doctor.js";

describe("installed runtime doctor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports all local prerequisites without launching a browser or using the network", async () => {
    vi.stubEnv("SCIRETRIEVER_CLOAK_BUNDLE", "");
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
    ).toEqual(["platform", "flock", "prlimit", "pdfinfo", "Xvfb"]);
    expect(report.checks.at(-1)).toMatchObject({
      name: "cloakbrowser",
      status: "blocked",
    });
  });
});

it("reports configured and effective Browser capacity without rewriting old values", async () => {
  const browser = parseConfiguration("[browser]\nmax_concurrency = 99").browser;
  const report = await runDoctor({ cloakBundle: null, browser });
  expect(
    report.checks.find((check) => check.name === "browser-capacity"),
  ).toEqual({
    name: "browser-capacity",
    status: "ready",
    detail:
      "configured sessions=99; effective sessions=8; decision workers=2; restriction=runtime-session-cap",
  });
  expect(browser.max_concurrency).toBe(99);
});
