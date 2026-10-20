import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetRepository } from "../src/storage/sqlite/repositories.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { FileStore } from "../src/storage/files/store.js";

describe("asset repository", () => {
  it("reads actual published bytes and rejects a stored hash mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-asset-read-"));
    const files = new FileStore(root);
    const worker = new SqliteWorker();
    try {
      const repository = new AssetRepository(worker, files);
      const bytes = new TextEncoder().encode("synthetic immutable PDF bytes");
      const stage = await files.stage();
      await stage.write(bytes);
      const published = await files.publish(stage, "objects/paper.pdf");
      const asset = {
        asset_id: "00000000-0000-0000-0000-000000000071" as never,
        sha256: published.sha256,
        size_bytes: published.size,
        media_type: "application/pdf",
        path: published.reference,
      };
      await repository.publish(asset);
      await expect(repository.readAsset(asset.asset_id)).resolves.toEqual(
        bytes,
      );
      await writeFile(
        join(root, published.reference),
        new Uint8Array(bytes.length).fill(65),
      );
      await expect(repository.readAsset(asset.asset_id)).rejects.toMatchObject({
        code: "repository",
      });
    } finally {
      await files.close();
      await worker.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("stores only relative artifact identity and rejects invalid asset rows atomically", async () => {
    const worker = new SqliteWorker();
    try {
      const repository = new AssetRepository(worker);
      await expect(
        repository.publish({
          asset_id: "00000000-0000-0000-0000-000000000021" as never,
          sha256: "a".repeat(64) as never,
          size_bytes: 3,
          media_type: "application/pdf",
          path: "objects/a.pdf" as never,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.publish({
          asset_id: "00000000-0000-0000-0000-000000000022" as never,
          sha256: "b".repeat(64) as never,
          size_bytes: 3,
          media_type: "application/pdf",
          path: "objects/a.pdf" as never,
        }),
      ).rejects.toBeDefined();
      await expect(worker.snapshotCounts()).resolves.toMatchObject({
        tables: { assets: 1, artifact_objects: 1 },
      });
    } finally {
      await worker.close();
    }
  });

  it("publishes an asset and its literature relation in one typed command", async () => {
    const worker = new SqliteWorker();
    try {
      const literature = {
        literature_id: "00000000-0000-0000-0000-000000000041" as never,
        meta_literature_id: "00000000-0000-0000-0000-000000000042" as never,
        version_role: "published" as const,
        status: "UNREVIEWED" as const,
        metadata: {
          title: "Asset owner",
          authors: [],
          abstract: null,
          publication_date: null,
          publication_year: 2026,
          publication_form: "journal-article" as const,
          article_kind: null,
          language: "en",
          venue: null,
          publisher: null,
          volume: null,
          issue: null,
          pages: null,
          identifiers: [],
          keywords: [],
        },
      };
      await worker.putLiterature(literature);
      const repository = new AssetRepository(worker);
      await expect(
        repository.publishForLiterature({
          literature_asset_id: "00000000-0000-0000-0000-000000000043",
          literature_id: literature.literature_id,
          asset: {
            asset_id: "00000000-0000-0000-0000-000000000044" as never,
            sha256: "c".repeat(64) as never,
            size_bytes: 4,
            media_type: "application/pdf",
            path: "objects/c.pdf" as never,
          },
          role: "primary-pdf",
          provenance: {
            provenance_id: "00000000-0000-0000-0000-000000000045",
            source_kind: "asset-provider",
            source_name: "offline-provider",
            source_record_id: "asset-1",
            observed_at: "2026-09-09T00:00:00Z",
            input_sha256: null,
            parameters_sha256: null,
          },
          source_url: null,
        }),
      ).resolves.toBe(true);
      await expect(worker.snapshotCounts()).resolves.toMatchObject({
        tables: {
          assets: 1,
          literature_assets: 1,
        },
      });
    } finally {
      await worker.close();
    }
  });
});
