import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
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
      await expect(
        repository.publishParserResult({
          source_asset_id: "00000000-0000-0000-0000-000000000044",
          source_sha256: "c".repeat(64),
          result_sha256: "d".repeat(64),
          page_count: 1,
          markdown_artifact_id: "00000000-0000-0000-0000-000000000046",
          markdown_artifact_path: "objects/c.md",
          markdown_sha256: "e".repeat(64),
          markdown_byte_size: 12,
          markdown_media_type: "text/markdown",
          provenance: {
            provenance_id: "00000000-0000-0000-0000-000000000047",
            source_kind: "parser",
            source_name: "offline-parser",
            source_record_id: null,
            observed_at: "2026-09-09T00:00:00Z",
            input_sha256: "c".repeat(64),
            parameters_sha256: "f".repeat(64),
          },
          parser_version: "1",
          mode: null,
          model_identity: null,
          resources: [
            {
              reference: "images/figure-1.png",
              artifact_id: "00000000-0000-0000-0000-000000000048",
              artifact_path: "objects/figure-1.png",
              artifact_sha256: "1".repeat(64),
              artifact_byte_size: 8,
              artifact_media_type: "image/png",
            },
          ],
        }),
      ).resolves.toBe(true);
      await expect(worker.snapshotCounts()).resolves.toMatchObject({
        tables: {
          assets: 1,
          literature_assets: 1,
          parser_results: 1,
          parser_result_resources: 1,
        },
      });
    } finally {
      await worker.close();
    }
  });

  it("publishes and reads a content artifact only when all current inputs are bound", async () => {
    const worker = new SqliteWorker();
    try {
      const literature = {
        literature_id: "00000000-0000-0000-0000-000000000051" as never,
        meta_literature_id: "00000000-0000-0000-0000-000000000052" as never,
        version_role: "published" as const,
        status: "UNREVIEWED" as const,
        metadata: {
          title: "Content owner",
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
      };
      await worker.putLiterature(literature);
      const metadataSha256 = await sha256(
        canonicalJsonBytes(literature.metadata),
      );
      const repository = new AssetRepository(worker);
      await repository.publish({
        asset_id: "00000000-0000-0000-0000-000000000053" as never,
        sha256: "3".repeat(64) as never,
        size_bytes: 10,
        media_type: "application/pdf",
        path: "objects/content.pdf" as never,
      });
      await repository.publishParserResult({
        source_asset_id: "00000000-0000-0000-0000-000000000053",
        source_sha256: "3".repeat(64),
        result_sha256: "5".repeat(64),
        page_count: 1,
        markdown_artifact_id: "00000000-0000-0000-0000-000000000060",
        markdown_artifact_path: "objects/parser.md",
        markdown_sha256: "a".repeat(64),
        markdown_byte_size: 12,
        markdown_media_type: "text/markdown",
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000061",
          source_kind: "parser",
          source_name: "offline-parser",
          source_record_id: null,
          observed_at: "2026-09-09T00:00:00Z",
          input_sha256: "3".repeat(64),
          parameters_sha256: "b".repeat(64),
        },
        parser_version: "1",
        mode: null,
        model_identity: null,
      });
      await expect(
        repository.publishContent({
          literature_id: literature.literature_id,
          literature_content_sha256: "4".repeat(64),
          metadata_revision: 1,
          metadata_sha256: metadataSha256,
          primary_asset_id: "00000000-0000-0000-0000-000000000053",
          primary_asset_sha256: "3".repeat(64),
          parser_result_sha256: "5".repeat(64),
          structured_artifact_id: "00000000-0000-0000-0000-000000000054",
          structured_artifact_path: "objects/content.json",
          structured_artifact_sha256: "6".repeat(64),
          structured_artifact_byte_size: 20,
          structured_artifact_media_type: "application/json",
          markdown_artifact_id: "00000000-0000-0000-0000-000000000055",
          markdown_artifact_path: "objects/content.md",
          markdown_artifact_sha256: "7".repeat(64),
          markdown_artifact_byte_size: 30,
          markdown_artifact_media_type: "text/markdown",
          provenance: {
            provenance_id: "00000000-0000-0000-0000-000000000056",
            source_kind: "analysis",
            source_name: "offline-analysis",
            source_record_id: null,
            observed_at: "2026-09-09T00:00:00Z",
            input_sha256: "8".repeat(64),
            parameters_sha256: "9".repeat(64),
          },
          reference_texts: ["A reference from the accepted content"],
        }),
      ).resolves.toBe(true);
      await expect(
        repository.getContent(literature.literature_id),
      ).resolves.toMatchObject({
        literature_id: literature.literature_id,
        metadata_revision: 1,
        metadata_sha256: metadataSha256,
        primary_asset_sha256: "3".repeat(64),
        markdown_artifact_sha256: "7".repeat(64),
        reference_texts: ["A reference from the accepted content"],
      });
      await expect(
        repository.publishContent({
          literature_id: literature.literature_id,
          literature_content_sha256: "a".repeat(64),
          metadata_revision: 1,
          metadata_sha256: metadataSha256,
          primary_asset_id: "00000000-0000-0000-0000-000000000053",
          primary_asset_sha256: "3".repeat(64),
          parser_result_sha256: "5".repeat(64),
          structured_artifact_id: "00000000-0000-0000-0000-000000000057",
          structured_artifact_path: "objects/invalid.json",
          structured_artifact_sha256: "b".repeat(64),
          structured_artifact_byte_size: 20,
          structured_artifact_media_type: "application/json",
          markdown_artifact_id: "00000000-0000-0000-0000-000000000058",
          markdown_artifact_path: "objects/invalid.md",
          markdown_artifact_sha256: "c".repeat(64),
          markdown_artifact_byte_size: 30,
          markdown_artifact_media_type: "text/markdown",
          provenance: {
            provenance_id: "00000000-0000-0000-0000-000000000059",
            source_kind: "analysis",
            source_name: "offline-analysis",
            source_record_id: null,
            observed_at: "2026-09-09T00:00:00Z",
            input_sha256: "8".repeat(64),
            parameters_sha256: "9".repeat(64),
          },
          reference_texts: ["", "invalid"],
        }),
      ).rejects.toBeDefined();
      await expect(
        repository.getContent(literature.literature_id),
      ).resolves.toMatchObject({
        literature_content_sha256: "4".repeat(64),
        reference_texts: ["A reference from the accepted content"],
      });
    } finally {
      await worker.close();
    }
  });
});
