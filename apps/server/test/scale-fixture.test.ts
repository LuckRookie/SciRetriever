import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMetadataObservation } from "@sciretriever/contracts";
import {
  scaleDataset,
  scalePaperCount,
  SCALE_SEED,
  scalePausedMs,
  scaleElapsed,
} from "./scale-fixture.js";

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

it("creates over 1000 retry targets without changing the standard source distribution", () => {
  const data = scaleDataset(1200, SCALE_SEED, "retry-boundary");
  expect(data.versions).toHaveLength(1320);
  expect(data.versions.every((v) => v.outcome === "retry-pdf")).toBe(true);
  expect(data.expected).toMatchObject({
    meta: 1200,
    literature: 1320,
    obtained: 1200,
    exhausted: 0,
    temporary: 0,
    with_primary_pdf: 1320,
    exhausted_versions: 0,
  });
  expect(data).toEqual(scaleDataset(1200, SCALE_SEED, "retry-boundary"));
  expect(data.expected).toMatchObject({ second_source: 240, without_doi: 180 });
});

it("subtracts only the union of pauses within each operation, including an open pause", () => {
  expect(scalePausedMs([], 100, 200)).toBe(0);
  expect(
    scalePausedMs(
      [
        { start_ms: 50, end_ms: 120 },
        { start_ms: 110, end_ms: 140 },
        { start_ms: 160, end_ms: 170 },
        { start_ms: 180, end_ms: null },
        { start_ms: 210, end_ms: 220 },
      ],
      100,
      200,
    ),
  ).toBe(70);
  expect(() =>
    scalePausedMs([{ start_ms: 200, end_ms: 100 }], 100, 200),
  ).toThrow("interval");
  expect(() =>
    scalePausedMs([{ start_ms: NaN, end_ms: null }], 100, 200),
  ).toThrow("interval");
  expect(() => scalePausedMs([], 200, 100)).toThrow("timing");
});

it("reports raw, paused and active wall time from the supervisor's persisted ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciretriever-scale-timing-"));
  try {
    const ledger = join(directory, "pauses.json");
    const start = { monotonic_ms: 10, epoch_ms: 100 };
    expect(scaleElapsed(start, ledger, 110)).toEqual({
      wall_ms: 100,
      raw_wall_ms: 100,
      paused_ms: 0,
    });
    await writeFile(ledger, JSON.stringify([{ start_ms: 120, end_ms: 160 }]));
    expect(scaleElapsed(start, ledger, 110)).toEqual({
      wall_ms: 60,
      raw_wall_ms: 100,
      paused_ms: 40,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
