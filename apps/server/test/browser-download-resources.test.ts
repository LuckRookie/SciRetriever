import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BrowserDownloadResources } from "../src/browser/resources.js";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import { FileStore } from "../src/storage/files/store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(temporaryBytes: number, available = async () => 1000) {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-download-resources-"),
  );
  const files = new FileStore(root);
  const resources = new BrowserDownloadResources({
    temporary_bytes: temporaryBytes,
    disk_reserve_bytes: 100,
    available_bytes: available,
  });
  const collector = new BrowserTransferCollector(files, undefined, resources);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => files.close());
  return { root, files, resources, collector };
}

it("uses one ledger for native original, Intake and both immutable publication copies", async () => {
  const s = await setup(12);
  await s.resources.updateNative("transfer-1", s.root, 4);
  await s.collector.begin("transfer-1");
  await s.collector.append("transfer-1", new Uint8Array([1, 2, 3, 4]));
  expect(s.resources.snapshot()).toMatchObject({
    native_bytes: 4,
    staging_bytes: 4,
  });
  const candidate = await s.collector.complete("transfer-1");
  expect(s.resources.snapshot()).toMatchObject({
    native_bytes: 4,
    staging_bytes: 0,
    preparation_bytes: 0,
    peak_temporary_bytes: 12,
  });
  const prepared = await s.collector.preparePublication(
    candidate,
    "objects/file.pdf",
  );
  try {
    expect(s.resources.snapshot()).toMatchObject({
      native_bytes: 4,
      staging_bytes: 4,
      preparation_bytes: 4,
      temporary_bytes: 12,
    });
    await s.collector.withPublication(() =>
      s.collector.commitPrepared(prepared),
    );
  } finally {
    await s.collector.releasePrepared(prepared);
  }
  s.resources.releaseNative("transfer-1");
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
  expect([...(await readFile(join(s.root, candidate.reference)))]).toEqual([
    1, 2, 3, 4,
  ]);
  expect([...(await readFile(join(s.root, "objects/file.pdf")))]).toEqual([
    1, 2, 3, 4,
  ]);
});

it("rejects the next unknown-length Intake chunk before writing and keeps another transfer intact", async () => {
  const s = await setup(8);
  await s.collector.begin("transfer-a");
  await s.collector.begin("transfer-b");
  await s.collector.append("transfer-a", new Uint8Array([1, 2, 3, 4]));
  await s.collector.append("transfer-b", new Uint8Array([5, 6, 7, 8]));
  await expect(
    s.collector.append("transfer-a", new Uint8Array([9])),
  ).rejects.toMatchObject({
    cause: { code: "browser-download-temporary-quota" },
  });
  expect(s.resources.snapshot()).toMatchObject({
    temporary_bytes: 4,
    staging_bytes: 4,
  });
  expect([...(await s.collector.bytes("transfer-b"))]).toEqual([5, 6, 7, 8]);
  expect(await readdir(join(s.root, ".staging"))).toHaveLength(1);
  await s.collector.discard("transfer-b");
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
});

it("counts the preparation duplicate and keeps a durable candidate when final publication cannot fit", async () => {
  const s = await setup(8);
  await s.collector.begin("transfer-1");
  await s.collector.append("transfer-1", new Uint8Array([1, 2, 3, 4]));
  const candidate = await s.collector.complete("transfer-1");
  await s.resources.updateNative("other-native", s.root, 1);
  await expect(
    s.collector.preparePublication(candidate, "objects/file.pdf"),
  ).rejects.toMatchObject({
    cause: { code: "browser-download-temporary-quota" },
  });
  expect(s.resources.snapshot()).toMatchObject({
    temporary_bytes: 1,
    native_bytes: 1,
    staging_bytes: 0,
    preparation_bytes: 0,
  });
  expect([...(await readFile(join(s.root, candidate.reference)))]).toEqual([
    1, 2, 3, 4,
  ]);
  expect(await readdir(join(s.root, "objects"))).toEqual([]);
  s.resources.releaseNative("other-native");
});

it("checks the disk reserve before each chunk rather than trusting an earlier free-space result", async () => {
  let free = 104;
  const s = await setup(100, async () => free);
  const stage = await s.files.stage({
    budget: s.resources.forTransfer("transfer-1"),
  });
  const reference = stage.reference;
  await stage.write(new Uint8Array([1, 2, 3, 4]));
  free = 100;
  await expect(stage.write(new Uint8Array([5]))).rejects.toMatchObject({
    code: "browser-download-disk-reserve",
  });
  expect([...(await readFile(join(s.root, reference)))]).toEqual([1, 2, 3, 4]);
  await stage.discard();
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
});

it("keeps durable files subject to actual disk reserve after releasing their temporary allocation", async () => {
  let free = 108;
  const s = await setup(100, async () => free);
  await s.collector.begin("durable");
  await s.collector.append("durable", new Uint8Array([1, 2, 3, 4]));
  const candidate = await s.collector.complete("durable");
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
  free = 100;
  await s.collector.begin("next");
  await expect(
    s.collector.append("next", new Uint8Array([5])),
  ).rejects.toMatchObject({
    cause: { code: "browser-download-disk-reserve" },
  });
  expect([...(await readFile(join(s.root, candidate.reference)))]).toEqual([
    1, 2, 3, 4,
  ]);
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
});

it("writes no bytes when cancellation arrives during a disk reservation", async () => {
  let enter!: () => void;
  let continueProbe!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    continueProbe = resolve;
  });
  const s = await setup(100, async () => {
    enter();
    await hold;
    return 1000;
  });
  const controller = new AbortController();
  const stage = await s.files.stage({
    budget: s.resources.forTransfer("cancelled"),
    signal: controller.signal,
  });
  const reference = stage.reference;
  const writing = stage.write(new Uint8Array([1, 2, 3]));
  await entered;
  controller.abort();
  continueProbe();
  await expect(writing).rejects.toMatchObject({ code: "file-staging" });
  expect((await readFile(join(s.root, reference))).length).toBe(0);
  expect(s.resources.snapshot().peak_written_bytes).toBe(0);
  await stage.discard();
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
});

it("includes uncommitted writes in simultaneous free-space reservations", async () => {
  const s = await setup(100, async () => 120);
  const a = s.resources.forTransfer("transfer-a").open(s.root, "staging");
  const b = s.resources.forTransfer("transfer-b").open(s.root, "staging");
  const results = await Promise.allSettled([a.reserve(15), b.reserve(15)]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(results[1]).toMatchObject({
    reason: { code: "browser-download-disk-reserve" },
  });
  expect(s.resources.snapshot()).toMatchObject({
    temporary_bytes: 15,
    pending_write_bytes: 15,
  });
  a.release();
  b.release();
});

it("keeps the native maximum across duplicate and reset terminal events until its writer retires", async () => {
  const s = await setup(8);
  await s.resources.updateNative("native", s.root, 8);
  await s.resources.updateNative("native", s.root, 0);
  expect(s.resources.snapshot().native_bytes).toBe(8);
  await expect(
    s.resources.updateNative("native", s.root, 9),
  ).rejects.toMatchObject({ code: "browser-download-temporary-quota" });
  // These bytes already exist: rejection must not silently free their ledger entry.
  expect(s.resources.snapshot().native_bytes).toBe(9);
  s.resources.releaseNative("native");
  s.resources.releaseNative("native");
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
});

it("refuses disk-probe failures and released in-flight leases without leaking a reservation", async () => {
  let continueProbe!: () => void;
  const pendingProbe = new Promise<void>((resolve) => {
    continueProbe = resolve;
  });
  const s = await setup(100, async () => {
    await pendingProbe;
    return 1000;
  });
  const lease = s.resources.forTransfer("transfer-1").open(s.root, "staging");
  const writing = lease.reserve(10);
  await Promise.resolve();
  lease.release();
  continueProbe();
  await expect(writing).rejects.toMatchObject({
    code: "browser-download-resource-ownership",
  });
  expect(s.resources.snapshot().temporary_bytes).toBe(0);
  const unavailable = new BrowserDownloadResources({
    available_bytes: async () => {
      throw new Error("offline filesystem unavailable");
    },
  });
  const failed = unavailable.forTransfer("transfer-2").open(s.root, "staging");
  await expect(failed.reserve(1)).rejects.toMatchObject({
    code: "browser-download-disk-unavailable",
  });
  failed.release();
  expect(unavailable.snapshot().temporary_bytes).toBe(0);
});
