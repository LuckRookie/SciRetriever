import { expect, it } from "vitest";
import { parseMetadataObservation } from "@sciretriever/contracts";
import { scaleDataset, scalePaperCount, SCALE_SEED } from "./scale-fixture.js";

it("reproduces the seeded paper, second-source, DOI-free and version cohorts", () => {
  const data = scaleDataset(500);
  expect(data).toEqual(scaleDataset(500));
  expect(data.bibliography).not.toBe(
    scaleDataset(500, SCALE_SEED + 1).bibliography,
  );
  expect(data.expected).toMatchObject({
    meta: 500,
    literature: 550,
    second_source: 100,
    without_doi: 75,
    obtained: 325,
    exhausted: 150,
    temporary: 25,
  });
  expect(
    data.versions.filter((v) => v.version === "published" && v.doi === null),
  ).toHaveLength(75);
  expect(
    data.discovery.filter((o) => o.version_role === "preprint"),
  ).toHaveLength(50);
  expect(
    data.discovery.filter((o) => o.version_role === "published"),
  ).toHaveLength(100);
  expect(data.discovery.some((o) => o.metadata.identifiers.length === 0)).toBe(
    true,
  );
  expect(new Set(data.versions.map((v) => v.key)).size).toBe(550);
  for (const observation of [...data.discovery, data.sentinel])
    expect(parseMetadataObservation(observation)).toEqual(observation);
});

it("allocates 60/30/10 source outcomes, half of transient failures recover, and includes large PDFs", () => {
  const data = scaleDataset(10000);
  const primary = data.versions.filter((v) => v.version === "published");
  for (const [outcome, count] of [
    ["pdf", 6000],
    ["miss", 3000],
    ["retry-pdf", 500],
    ["temporary", 500],
  ] as const)
    expect(primary.filter((v) => v.outcome === outcome)).toHaveLength(count);
  const success = data.versions.filter((v) =>
    ["pdf", "retry-pdf"].includes(v.outcome),
  );
  const large = success.filter((v) => v.bytes === 20 * 1024 * 1024);
  expect(large.length / success.length).toBeGreaterThan(0.008);
  expect(large.length / success.length).toBeLessThan(0.012);
  expect(
    success.every(
      (v) =>
        v.bytes === 20 * 1024 * 1024 ||
        (v.bytes >= 50 * 1024 && v.bytes <= 500 * 1024),
    ),
  ).toBe(true);
});

it("rejects invalid scale sizes before starting any process", () => {
  for (const count of [0, 1, -1, 19, 20.5, Number.NaN])
    expect(() => scaleDataset(count)).toThrow("SCIRETRIEVER_SCALE_RECORDS");
});

it("counts one paper for multiple versions and reports the later sentinel separately", () => {
  const dataset = scaleDataset(20);
  const alternate = dataset.versions.find(
    (version) => version.version === "preprint",
  )!;
  expect(
    scalePaperCount(dataset, [
      alternate.key,
      alternate.key.replace(/-v2$/u, ""),
      alternate.key,
    ]),
  ).toBe(1);
  expect(
    scalePaperCount(dataset, [
      ...dataset.versions.map((v) => v.key),
      "sentinel",
    ]),
  ).toBe(21);
  expect(() => scalePaperCount(dataset, ["unknown"])).toThrow("unavailable");
});
