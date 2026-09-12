import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  sha256,
  parseLiterature,
  parseProvenance,
} from "@sciretriever/contracts";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import { CandidatePublisher } from "../src/acquisition/candidate-publication.js";
import { FileStore } from "../src/storage/files/store.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const provenance = parseProvenance({
  provenance_id: id(3),
  source_kind: "asset-provider",
  source_name: "fixture",
  source_record_id: "record-1",
  observed_at: "2026-09-09T00:00:00Z",
  input_sha256: null,
  parameters_sha256: null,
});
const literature = parseLiterature({
  literature_id: id(1),
  meta_literature_id: id(2),
  version_role: "published",
  status: "UNREVIEWED",
  metadata: {
    title: "Synthetic paper",
    authors: [],
    abstract: null,
    publication_date: null,
    publication_year: 2026,
    document_type: "article",
    language: "en",
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [],
    keywords: [],
  },
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-candidate-publication-"),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const open = () => {
    const files = new FileStore(root);
    const database = new SqliteWorker(join(root, "catalog.sqlite"));
    cleanups.push(async () => {
      await files.close();
      await database.close();
    });
    const collector = new BrowserTransferCollector(files, database);
    return {
      files,
      database,
      collector,
      publisher: new CandidatePublisher(collector, database),
    };
  };
  const state = open();
  await state.database.upgradeExecutionSchema();
  await state.database.putLiterature(literature);
  await state.collector.begin("transfer-1");
  await state.collector.append("transfer-1", new Uint8Array([1, 2, 3]));
  const candidate = await state.collector.complete("transfer-1");
  const input = {
    receipt_id: "receipt-1",
    metadata_snapshot: {
      revision: 1,
      sha256: await sha256(canonicalJsonBytes(literature.metadata)),
    },
    candidate,
    literature_id: id(1),
    asset_id: id(4),
    literature_asset_id: id(5),
    target: "objects/paper.pdf",
    provenance,
    source_url: null,
    identity: "accepted" as const,
  };
  return { root, open, ...state, candidate, input };
}

describe("durable candidate publication", () => {
  it("reopens candidate bytes and committed receipts after all original owners close", async () => {
    const s = await setup();
    await s.files.close();
    await s.database.close();
    const next = s.open();
    expect(await next.collector.recover("transfer-1")).toEqual(s.candidate);
    const result = await next.publisher.publish(s.input);
    await next.files.close();
    await next.database.close();
    const third = s.open();
    expect(await third.publisher.publish(s.input)).toEqual(result);
    expect(await third.database.getLiterature(id(1))).toMatchObject({
      status: "ASSET_READY",
    });
    expect(await third.database.snapshotCounts()).toMatchObject({
      tables: { assets: 1, literature_assets: 1 },
    });
    expect([...(await third.files.read(result.reference, 3))]).toEqual([
      1, 2, 3,
    ]);
  });
  it("reconciles files published before an interrupted database transaction", async () => {
    const s = await setup();
    const faulty = new CandidatePublisher(s.collector, {
      prepareReceipt: (value) => s.database.prepareReceipt(value),
      pendingReceipts: () => s.database.pendingReceipts(),
      commitReceipt: async () => {
        throw new Error("simulated interruption before commit");
      },
    });
    await expect(faulty.publish(s.input)).rejects.toMatchObject({
      bytes_published: true,
    });
    expect([...(await readFile(join(s.root, s.input.target)))]).toEqual([
      1, 2, 3,
    ]);
    expect(await s.database.getAsset(id(4))).toBeNull();
    await s.files.close();
    await s.database.close();
    const next = s.open();
    expect(await next.publisher.reconcile()).toMatchObject([
      { receipt_id: "receipt-1", created: false },
    ]);
    expect(await next.database.pendingReceipts()).toEqual([]);
    expect(await next.database.getLiterature(id(1))).toMatchObject({
      status: "ASSET_READY",
    });
  });
  it("replays a transaction whose response was lost without duplicate facts", async () => {
    const s = await setup();
    const faulty = new CandidatePublisher(s.collector, {
      prepareReceipt: (value) => s.database.prepareReceipt(value),
      pendingReceipts: () => s.database.pendingReceipts(),
      commitReceipt: async (value, created) => {
        await s.database.commitReceipt(value, created);
        throw new Error("simulated response loss");
      },
    });
    await expect(faulty.publish(s.input)).rejects.toMatchObject({
      bytes_published: true,
    });
    await s.files.close();
    await s.database.close();
    const next = s.open();
    expect(await next.publisher.publish(s.input)).toMatchObject({
      created: true,
    });
    expect(await next.database.snapshotCounts()).toMatchObject({
      tables: { assets: 1, literature_assets: 1, provenances: 1 },
    });
  });
  it("binds the entire receipt intent and refuses unaccepted identity", async () => {
    const s = await setup();
    await expect(
      s.publisher.publish({ ...s.input, identity: "uncertain" }),
    ).rejects.toMatchObject({ bytes_published: false });
    await expect(readFile(join(s.root, s.input.target))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await s.publisher.publish(s.input);
    for (const change of [
      { target: "objects/other.pdf" },
      { asset_id: id(6) },
      { literature_asset_id: id(7) },
      { provenance: { ...provenance, source_name: "changed" } },
      { source_url: "https://example.test/other" },
    ])
      await expect(
        s.publisher.publish({ ...s.input, ...change }),
      ).rejects.toMatchObject({ bytes_published: false });
  });
  it("refuses a stale metadata snapshot between preparation and commit without changing current facts", async () => {
    const s = await setup();
    await s.database.prepareReceipt(s.input);
    const changed = parseLiterature({
      ...literature,
      metadata: { ...literature.metadata, title: "Revised target" },
    });
    await s.database.putLiterature(changed);
    await expect(s.database.commitReceipt(s.input, true)).rejects.toBeDefined();
    expect(await s.database.getAsset(id(4))).toBeNull();
    expect(await s.database.pendingReceipts()).toHaveLength(1);
    expect(await s.database.getLiterature(id(1))).toMatchObject({
      metadata: { title: "Revised target" },
      status: "UNREVIEWED",
    });
  });
  it("preserves conflicting destination bytes and leaves a pending reconciliation record", async () => {
    const s = await setup();
    const stage = await s.files.stage();
    await stage.write(new Uint8Array([9, 9, 9]));
    await s.files.publish(stage, s.input.target);
    await expect(s.publisher.publish(s.input)).rejects.toMatchObject({
      bytes_published: false,
    });
    expect([...(await readFile(join(s.root, s.input.target)))]).toEqual([
      9, 9, 9,
    ]);
    expect(await s.database.pendingReceipts()).toHaveLength(1);
    expect(await s.database.getAsset(id(4))).toBeNull();
  });
  it("does not return a successful replay when already published bytes are corrupted", async () => {
    const s = await setup();
    await s.publisher.publish(s.input);
    await writeFile(join(s.root, s.input.target), new Uint8Array([9, 8, 7]));
    await expect(s.publisher.publish(s.input)).rejects.toMatchObject({
      bytes_published: true,
    });
    expect([...(await readFile(join(s.root, s.input.target)))]).toEqual([
      9, 8, 7,
    ]);
  });
  it("rejects tampered candidate bytes on recovery and publication", async () => {
    const s = await setup();
    await writeFile(
      join(s.root, s.candidate.reference),
      new Uint8Array([7, 8, 9]),
    );
    await expect(s.collector.recover("transfer-1")).rejects.toBeDefined();
    await expect(s.publisher.publish(s.input)).rejects.toMatchObject({
      bytes_published: false,
    });
  });
  it("rejects a symlink replacing the durable directory", async () => {
    const s = await setup();
    await rename(join(s.root, ".candidates"), join(s.root, "other"));
    await symlink(join(s.root, "other"), join(s.root, ".candidates"));
    await expect(s.collector.recover("transfer-1")).rejects.toBeDefined();
  });
  it("recovers and publishes in a fresh Node process using only persisted identifiers", async () => {
    const s = await setup();
    await s.database.prepareReceipt(s.input);
    await s.files.close();
    await s.database.close();
    const workerModule = pathToFileURL(
      resolve("apps/server/dist/storage/sqlite/worker.js"),
    ).href;
    const filesModule = pathToFileURL(
      resolve("apps/server/dist/storage/files/store.js"),
    ).href;
    const transferModule = pathToFileURL(
      resolve("apps/server/dist/browser/transfer.js"),
    ).href;
    const publisherModule = pathToFileURL(
      resolve("apps/server/dist/acquisition/candidate-publication.js"),
    ).href;
    const script = `
      import {SqliteWorker} from ${JSON.stringify(workerModule)};
      import {FileStore} from ${JSON.stringify(filesModule)};
      import {BrowserTransferCollector} from ${JSON.stringify(transferModule)};
      import {CandidatePublisher} from ${JSON.stringify(publisherModule)};
      const db = new SqliteWorker(process.argv[1] + "/catalog.sqlite");
      const files = new FileStore(process.argv[1]);
      try { const collector = new BrowserTransferCollector(files, db);
        const recovered = await collector.recover("transfer-1");
        const receipts = await new CandidatePublisher(collector, db).reconcile();
        process.stdout.write(JSON.stringify({recovered,receipts}));
      } finally { await files.close(); await db.close(); }
    `;
    const child = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      s.root,
    ]);
    expect(JSON.parse(child.stdout)).toMatchObject({
      recovered: s.candidate,
      receipts: [{ receipt_id: "receipt-1" }],
    });
  });
  it("backs up and rolls back only the execution extension, preserving confirmed v1 facts and evidence", async () => {
    const s = await setup();
    const v2 = await s.database.schema();
    await s.publisher.publish(s.input);
    const backupPath = join(s.root, "execution-backup.sqlite");
    await s.database.rollbackExecutionSchema(backupPath);
    expect(await s.database.schema()).toMatchObject({ schema_version: 1 });
    expect(await s.database.getLiterature(id(1))).toMatchObject({
      status: "ASSET_READY",
    });
    await expect(s.database.getCandidate("transfer-1")).rejects.toBeDefined();
    const restored = new SqliteWorker(backupPath);
    cleanups.push(() => restored.close());
    expect(await restored.schema()).toEqual(v2);
    expect(await restored.getCandidate("transfer-1")).toEqual(s.candidate);
    expect(await restored.prepareReceipt(s.input)).toMatchObject({
      receipt_id: "receipt-1",
    });
    await s.database.upgradeExecutionSchema();
    expect(await s.database.getCandidate("transfer-1")).toBeNull();
    await expect(s.database.backup(backupPath)).rejects.toBeDefined();
  });
  it("does not create execution tables implicitly in a v1 catalog", async () => {
    const database = new SqliteWorker();
    cleanups.push(() => database.close());
    await database.schema();
    await expect(database.getCandidate("missing")).rejects.toBeDefined();
    await database.upgradeExecutionSchema();
    await database.upgradeExecutionSchema();
    expect(await database.getCandidate("missing")).toBeNull();
  });
});
