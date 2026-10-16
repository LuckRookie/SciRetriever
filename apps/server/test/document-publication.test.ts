import { artifactReference } from "../src/storage/artifact-layout.js";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseAsset,
  parseProvenance,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { startMaintenanceWorkbench } from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import type { ParserBackend } from "../src/parsing/ports.js";
import { ParsingFailure } from "../src/parsing/ports.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import {
  DocumentProcessingError,
  DocumentProcessingService,
} from "../src/document/service.js";
import type { DocumentStoragePort } from "../src/document/contract.js";
import { buildDocumentStructure } from "../src/document/builder.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const literatureId = FIXTURE_LITERATURE.literature_id;
const artifact = (bytes: Uint8Array, mediaType: string): ArtifactRef => ({
  sha256: createHash("sha256")
    .update(bytes)
    .digest("hex") as ArtifactRef["sha256"],
  byte_size: bytes.length,
  media_type: mediaType,
});
const figure = Buffer.from("89504e470d0a1a0a00", "hex");

async function setup() {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-document-publication-"),
  );
  let app: Application | undefined;
  let calls = 0;
  let text = "# 标题\nαβ evidence\n![figure](fig.png)\n";
  const backend: ParserBackend = {
    parse: async (request) => {
      calls++;
      const markdown = Buffer.from(text);
      return {
        source_asset_id: request.source_asset_id,
        source_sha256: request.source_sha256,
        page_count: 1,
        markdown: {
          artifact: artifact(markdown, "text/markdown"),
          bytes: markdown,
        },
        resources: [
          {
            reference: "fig.png",
            content: { artifact: artifact(figure, "image/png"), bytes: figure },
          },
        ],
        provenance: {
          provenance: parseProvenance({
            provenance_id: id(600 + calls),
            source_kind: "parser",
            source_name: "fixture",
            source_record_id: null,
            observed_at: "2026-09-29T00:00:00Z",
            input_sha256: request.source_sha256,
            parameters_sha256: "a".repeat(64),
          }),
          parser_version: "fixture-1",
          mode: null,
          model_identity: null,
        },
      };
    },
  };
  try {
    app = await createApplication(home, {
      parsing: { parser: backend, rules: new TypeScriptParserArtifactRules() },
    });
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const pdf = workbenchPdf();
    const stage = await app.files.stage();
    await stage.write(pdf);
    await app.files.publish(stage, "objects/source.pdf");
    const asset = parseAsset({
      asset_id: id(610),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/source.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(611),
      literature_id: literatureId,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: {
        provenance_id: id(612),
        source_kind: "asset-provider",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
    await app.close();
    app = undefined;
    await migrateDocumentCatalog({
      catalog_path: join(home, "catalog.sqlite"),
      backup_path: join(home, "before.sqlite"),
    });
    app = await createApplication(home, {
      parsing: { parser: backend, rules: new TypeScriptParserArtifactRules() },
    });
    const request = (
      mode: "reparse" | "reuse-current",
      revision: number | null = null,
    ) => ({
      literature_id: literatureId,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode,
      expected_default_revision: revision,
    });
    return {
      home,
      asset,
      get app() {
        return app!;
      },
      request,
      get calls() {
        return calls;
      },
      setText(value: string) {
        text = value;
      },
      async close() {
        await app?.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app?.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

describe("v3 document publication", () => {
  it("copies the request before asynchronous work and settles an active parse on close", async () => {
    const env = await setup();
    try {
      const mutable = { ...env.request("reparse") };
      const parser = env.app.parsing!;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let activeSignal: AbortSignal | undefined;
      let reentrantClose: Promise<void> | undefined;
      vi.spyOn(parser, "prepareCurrentPrimary").mockImplementation(
        async (_id, signal) => {
          activeSignal = signal;
          signal?.addEventListener(
            "abort",
            () => {
              reentrantClose = env.app.documentProcessing.close();
            },
            { once: true },
          );
          entered();
          await gate;
          if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
          throw new Error("unexpected parser continuation");
        },
      );
      const pending = env.app.documentProcessing.parseDocuments(mutable);
      mutable.asset_sha256 = "f".repeat(64) as typeof mutable.asset_sha256;
      mutable.mode = "reuse-current";
      await ready;
      const closing = env.app.documentProcessing.close();
      expect(reentrantClose).toBe(closing);
      expect(env.app.documentProcessing.close()).toBe(closing);
      await vi.waitFor(() => expect(activeSignal?.aborted).toBe(true));
      release();
      await expect(pending).rejects.toMatchObject({ code: "parser-cancelled" });
      await closing;
      await expect(
        env.app.documentProcessing.parseDocuments(env.request("reuse-current")),
      ).rejects.toMatchObject({ code: "document-cancelled" });
    } finally {
      await env.close();
    }
  });

  it("rejects a changed current PDF before reading or invoking the Parser backend", async () => {
    const env = await setup();
    try {
      const originalFacts = await env.app.database.currentFacts(literatureId);
      const replacement = parseAsset({
        asset_id: id(720),
        sha256: "f".repeat(64),
        size_bytes: env.asset.size_bytes,
        media_type: "application/pdf",
        path: "objects/other.pdf",
      });
      const originalInput = env.app.database.documentInput.bind(
        env.app.database,
      );
      vi.spyOn(env.app.database, "documentInput").mockImplementation(
        async (material) => {
          const snapshot = await originalInput(material);
          vi.spyOn(env.app.database, "currentFacts").mockResolvedValue({
            ...originalFacts!,
            primary_asset: replacement,
          });
          return snapshot;
        },
      );
      const artifactRead = vi.spyOn(
        env.app.literatureArtifacts,
        "withArtifact",
      );
      await expect(
        env.app.documentProcessing.parseDocuments(env.request("reparse")),
      ).rejects.toMatchObject({ code: "parser-stale" });
      expect(artifactRead).not.toHaveBeenCalled();
      expect(env.calls).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("cancels a slow verified read and rejects oversized declared Markdown before reading", async () => {
    const env = await setup();
    try {
      await env.app.parsing!.commitCurrentPrimary(
        await env.app.parsing!.prepareCurrentPrimary(literatureId),
      );
      const real = new SqliteDocumentStorage(env.app.database, env.app.files);
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const slow: DocumentStoragePort = {
        publishImmutableArtifact: (...args) =>
          real.publishImmutableArtifact(...args),
        inspectExactInput: (...args) => real.inspectExactInput(...args),
        commitVersion: (...args) => real.commitVersion(...args),
        withPinnedVersion: (...args) => real.withPinnedVersion(...args),
        withVerifiedArtifact: async (reference, expected, consume) => {
          if (first) {
            first = false;
            entered();
            await gate;
          }
          return real.withVerifiedArtifact(reference, expected, consume);
        },
      };
      const processor = new DocumentProcessingService(
        env.app.database,
        slow,
        new TypeScriptParserArtifactRules(),
        env.app.parsing,
      );
      const pending = processor.parseDocuments(env.request("reuse-current"));
      await ready;
      const closing = processor.close();
      release();
      await expect(pending).rejects.toMatchObject({
        code: "document-cancelled",
      });
      await closing;
      await processor.close();

      const snapshot = await env.app.database.documentInput({
        literature_id: literatureId,
        asset_id: env.asset.asset_id,
        asset_sha256: env.asset.sha256,
        media_type: "application/pdf",
        byte_size: env.asset.size_bytes,
        artifact: {
          sha256: env.asset.sha256,
          byte_size: env.asset.size_bytes,
          media_type: "application/pdf",
        },
      });
      vi.spyOn(env.app.database, "documentInput").mockResolvedValueOnce({
        ...snapshot!,
        parser: {
          ...snapshot!.parser!,
          result: {
            ...snapshot!.parser!.result,
            markdown: {
              ...snapshot!.parser!.result.markdown,
              byte_size: 8 * 1024 * 1024 + 1,
            },
          },
        },
      });
      await expect(
        env.app.documentProcessing.parseDocuments(env.request("reuse-current")),
      ).rejects.toMatchObject({ code: "document-integrity" });
    } finally {
      await env.close();
    }
  });
  it("preserves the first version provenance across A-B-A reparsing", async () => {
    const env = await setup();
    try {
      const first = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      env.setText("# B\nchanged\n![figure](fig.png)\n");
      const middle = await env.app.documentProcessing.parseDocuments(
        env.request("reparse", 1),
      );
      env.setText("# 标题\nαβ evidence\n![figure](fig.png)\n");
      const again = await env.app.documentProcessing.parseDocuments(
        env.request("reparse", 2),
      );
      expect(again).toMatchObject({
        published: false,
        default_updated: true,
        default_revision: 3,
      });
      expect(again.document).toEqual(first.document);
      expect(again.parser_provenance_id).toBe(first.parser_provenance_id);
      expect(middle.parser_provenance_id).not.toBe(first.parser_provenance_id);
      const current = await env.app.database.documentInput(
        first.document.source_material_ref,
      );
      expect(current!.parser!.provenance_id).not.toBe(
        first.parser_provenance_id,
      );
      const storage = new SqliteDocumentStorage(
        env.app.database,
        env.app.files,
      );
      await storage.withPinnedVersion(
        first.document.document_version_id,
        async (version) => expect(version).toEqual(first.document),
      );
    } finally {
      await env.close();
    }
  });

  it("reuses an already registered structure path for the same SHA", async () => {
    const env = await setup();
    try {
      const built = await buildDocumentStructure(
        Buffer.from("# 标题\nαβ evidence\n![figure](fig.png)\n"),
      );
      const alternate = "objects/existing-structure.json";
      const stage = await env.app.files.stage();
      await stage.write(built.bytes);
      await env.app.files.publish(stage, alternate);
      const catalog = new DatabaseSync(join(env.home, "catalog.sqlite"));
      try {
        catalog
          .prepare(
            "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
          )
          .run(
            id(799),
            built.sha256,
            built.bytes.byteLength,
            "application/json",
            alternate,
          );
      } finally {
        catalog.close();
      }
      const receipt = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      expect(receipt.document.structure.sha256).toBe(built.sha256);
      const version = await env.app.database.documentVersion(
        receipt.document.document_version_id,
      );
      expect(version?.structure_artifact_path).toBe(alternate);
      await expect(
        readFile(
          join(
            env.home,
            "artifacts",
            artifactReference("document-structure", receipt.document.structure),
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await env.close();
    }
  });

  it("does not infer a successful default CAS from an old version after a pre-commit failure", async () => {
    const env = await setup();
    try {
      const first = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      env.setText("# B\nchanged\n![figure](fig.png)\n");
      const middle = await env.app.documentProcessing.parseDocuments(
        env.request("reparse", 1),
      );
      env.setText("# 标题\nαβ evidence\n![figure](fig.png)\n");
      const real = new SqliteDocumentStorage(env.app.database, env.app.files);
      const failing: DocumentStoragePort = {
        publishImmutableArtifact: (...args) =>
          real.publishImmutableArtifact(...args),
        inspectExactInput: (...args) => real.inspectExactInput(...args),
        commitVersion: async () => {
          throw new Error("injected before transaction");
        },
        withPinnedVersion: (...args) => real.withPinnedVersion(...args),
        withVerifiedArtifact: (...args) => real.withVerifiedArtifact(...args),
      };
      const processor = new DocumentProcessingService(
        env.app.database,
        failing,
        new TypeScriptParserArtifactRules(),
        env.app.parsing,
      );
      await expect(
        processor.parseDocuments(env.request("reparse", 2)),
      ).rejects.toMatchObject({
        code: "document-publication",
        cause: expect.any(Error),
      });
      const old = await env.app.database.documentVersion(
        first.document.document_version_id,
      );
      const current = await env.app.database.documentVersion(
        middle.document.document_version_id,
      );
      expect(old?.is_default).toBe(false);
      expect(current).toMatchObject({ is_default: true, default_revision: 2 });
      await processor.close();
    } finally {
      await env.close();
    }
  });

  it("does not start a queued Document commit after cancellation, but finishes one already committed", async () => {
    const env = await setup();
    try {
      await env.app.parsing!.commitCurrentPrimary(
        await env.app.parsing!.prepareCurrentPrimary(literatureId),
      );
      const built = await buildDocumentStructure(
        Buffer.from("# 标题\nαβ evidence\n![figure](fig.png)\n"),
      );
      const structurePath = "objects/queued-structure.json";
      const stage = await env.app.files.stage();
      await stage.write(built.bytes);
      await env.app.files.publish(stage, structurePath);
      const catalog = new DatabaseSync(join(env.home, "catalog.sqlite"));
      try {
        catalog
          .prepare(
            "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
          )
          .run(
            id(730),
            built.sha256,
            built.bytes.byteLength,
            "application/json",
            structurePath,
          );
      } finally {
        catalog.close();
      }
      let admitted!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = env.app.writes.run(async () => {
        admitted();
        await gate;
      });
      await entered;
      const commit = vi.spyOn(env.app.database, "commitDocumentVersion");
      const stop = new AbortController();
      const pending = env.app.documentProcessing.parseDocuments(
        env.request("reuse-current"),
        stop.signal,
      );
      await vi.waitFor(() => expect(commit).toHaveBeenCalled());
      stop.abort();
      release();
      await held;
      await expect(pending).rejects.toMatchObject({
        code: "document-cancelled",
      });
      commit.mockRestore();
      const before = new DatabaseSync(join(env.home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          before.prepare("SELECT count(*) AS n FROM document_versions").get()
            ?.n,
        ).toBe(0);
        expect(
          before.prepare("SELECT count(*) AS n FROM document_defaults").get()
            ?.n,
        ).toBe(0);
      } finally {
        before.close();
      }

      const confirmed = new AbortController();
      const real = new SqliteDocumentStorage(env.app.database, env.app.files);
      const afterCommit: DocumentStoragePort = {
        publishImmutableArtifact: (...args) =>
          real.publishImmutableArtifact(...args),
        inspectExactInput: (...args) => real.inspectExactInput(...args),
        commitVersion: async (...args) => {
          const receipt = await real.commitVersion(...args);
          confirmed.abort();
          return receipt;
        },
        withPinnedVersion: (...args) => real.withPinnedVersion(...args),
        withVerifiedArtifact: (...args) => real.withVerifiedArtifact(...args),
      };
      const processor = new DocumentProcessingService(
        env.app.database,
        afterCommit,
        new TypeScriptParserArtifactRules(),
        env.app.parsing,
      );
      const result = await processor.parseDocuments(
        env.request("reuse-current"),
        confirmed.signal,
      );
      expect(result).toMatchObject({
        published: true,
        default_updated: true,
        default_revision: 1,
      });
      expect(confirmed.signal.aborted).toBe(true);
      await real.withPinnedVersion(
        result.document.document_version_id,
        async (version) => expect(version).toEqual(result.document),
      );
      await processor.close();
    } finally {
      await env.close();
    }
  });

  it("keeps the committed parser input after the current relation changes", async () => {
    const env = await setup();
    try {
      const parser = env.app.parsing!;
      const commit = parser.commitCurrentPrimary.bind(parser);
      const spy = vi
        .spyOn(parser, "commitCurrentPrimary")
        .mockImplementation(async (...args) => {
          const result = await commit(...args);
          const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
          try {
            db.exec("PRAGMA foreign_keys=ON");
            db.prepare(
              "DELETE FROM literature_assets WHERE literature_id=? AND asset_id=? AND role='primary-pdf'",
            ).run(literatureId, env.asset.asset_id);
          } finally {
            db.close();
          }
          return result;
        });
      const receipt = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      spy.mockRestore();
      expect(receipt.document.source_material_ref.asset_sha256).toBe(
        env.asset.sha256,
      );
      expect(
        (await env.app.database.currentFacts(literatureId))?.primary_asset,
      ).toBeNull();
      const storage = new SqliteDocumentStorage(
        env.app.database,
        env.app.files,
      );
      await storage.withPinnedVersion(
        receipt.document.document_version_id,
        async (v) => expect(v).toEqual(receipt.document),
      );
    } finally {
      await env.close();
    }
  });
  it("serializes concurrent publication of one immutable representation", async () => {
    const env = await setup();
    try {
      await env.app.parsing!.commitCurrentPrimary(
        await env.app.parsing!.prepareCurrentPrimary(literatureId),
      );
      const results = await Promise.all([
        env.app.documentProcessing.parseDocuments(env.request("reuse-current")),
        env.app.documentProcessing.parseDocuments(env.request("reuse-current")),
      ]);
      expect(results.map((result) => result.published).sort()).toEqual([
        false,
        true,
      ]);
      expect(results[0]!.document).toEqual(results[1]!.document);
      expect(env.calls).toBe(1);
      const storage = new SqliteDocumentStorage(
        env.app.database,
        env.app.files,
      );
      await storage.withPinnedVersion(
        results[0]!.document.document_version_id,
        async (version) => expect(version).toEqual(results[0]!.document),
      );
    } finally {
      await env.close();
    }
  });
  it("publishes exact UTF-8 structure, reuses without parser, and retains v1 after reparse/default CAS", async () => {
    const env = await setup();
    try {
      await expect(
        env.app.documentProcessing.parseDocuments(env.request("reuse-current")),
      ).rejects.toMatchObject({ code: "parser-result-missing" });
      expect(env.calls).toBe(0);
      const first = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      expect(first).toMatchObject({
        published: true,
        default_updated: true,
        default_revision: 1,
        parser_mode: "reparse",
      });
      expect(env.calls).toBe(1);
      const files = new SqliteDocumentStorage(env.app.database, env.app.files);
      for (const [artifact, directory, extension] of [
        [first.document.markdown, "parsed/markdown", "md"],
        [first.document.structure, "parsed/structure", "json"],
        [first.document.resources[0]!.artifact, "parsed/images", "png"],
      ] as const) {
        expect(await env.app.database.locateArtifact(artifact)).toMatchObject({
          reference: `${directory}/${artifact.sha256.slice(0, 2)}/${artifact.sha256}.${extension}`,
        });
      }
      const input = {
        source_material_ref: first.document.source_material_ref,
        parser_result_sha256: first.document.parser_result_sha256,
        builder_version: first.document.builder_version,
        locator_scheme: first.document.locator_scheme,
        markdown: first.document.markdown,
        structure: first.document.structure,
        resources: first.document.resources,
      };
      await expect(files.inspectExactInput(input)).resolves.toBe("available");
      await files.withPinnedVersion(
        first.document.document_version_id,
        async (version) => {
          expect(version).toEqual(first.document);
        },
      );
      const structurePath = artifactReference(
        "document-structure",
        first.document.structure,
      );
      const structure = JSON.parse(
        (await readFile(join(env.home, "artifacts", structurePath))).toString(
          "utf8",
        ),
      );
      const markdown = Buffer.from("# 标题\nαβ evidence\n![figure](fig.png)\n");
      expect(structure.segments[1]).toMatchObject({
        start_utf8: Buffer.byteLength("# 标题\n"),
        end_utf8: Buffer.byteLength("# 标题\nαβ evidence\n"),
      });
      expect(structure.segments.at(-1).end_utf8).toBe(markdown.length);
      expect((await buildDocumentStructure(markdown)).structure).toEqual(
        structure,
      );
      const reused = await env.app.documentProcessing.parseDocuments(
        env.request("reuse-current", 1),
      );
      expect(reused).toMatchObject({
        published: false,
        default_updated: true,
        default_revision: 1,
      });
      expect(env.calls).toBe(1);
      env.setText("# 标题\nαβ revised\n![figure](fig.png)\n");
      const second = await env.app.documentProcessing.parseDocuments(
        env.request("reparse", null),
      );
      expect(second).toMatchObject({
        published: true,
        default_updated: false,
        default_revision: 1,
      });
      expect(second.document.document_version_id).not.toBe(
        first.document.document_version_id,
      );
      const parserSnapshot = await env.app.database.documentInput(
        second.document.source_material_ref,
      );
      await expect(
        env.app.database.commitDocumentVersion({
          version: second.document,
          source_artifact_path: parserSnapshot!.source_artifact_path,
          markdown_artifact_path:
            parserSnapshot!.parser!.markdown_artifact_path,
          structure_artifact_path: artifactReference(
            "document-structure",
            second.document.structure,
          ),
          resource_artifact_paths: { "fig.png": "objects/missing-resource" },
          expected_default_revision: 1,
        }),
      ).rejects.toBeInstanceOf(Error);
      await files.withPinnedVersion(
        first.document.document_version_id,
        async (version) => expect(version).toEqual(first.document),
      );
      const db = new DatabaseSync(join(env.home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          db
            .prepare(
              "SELECT document_version_id FROM document_defaults WHERE document_id=?",
            )
            .get(first.document.document_id)?.document_version_id,
        ).toBe(first.document.document_version_id);
        expect(
          db.prepare("SELECT count(*) AS n FROM document_versions").get()?.n,
        ).toBe(2);
      } finally {
        db.close();
      }
      const promoted = await env.app.documentProcessing.parseDocuments(
        env.request("reuse-current", 1),
      );
      expect(promoted).toMatchObject({
        published: false,
        default_updated: true,
        default_revision: 2,
      });
      expect(env.calls).toBe(2);
    } finally {
      await env.close();
    }
  });
  it("keeps material and prior version after parser failure, cancellation, tamper and duplicate publication", async () => {
    const env = await setup();
    try {
      const first = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        env.app.documentProcessing.parseDocuments(
          env.request("reparse", 1),
          cancelled.signal,
        ),
      ).rejects.toMatchObject({ code: "document-cancelled" });
      await expect(
        env.app.documentProcessing.parseDocuments({
          ...env.request("reuse-current"),
          asset_sha256: "f".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "material-stale" });
      await expect(
        env.app.documentProcessing.parseDocuments({
          ...env.request("reuse-current"),
          literature_id: id(999),
        }),
      ).rejects.toMatchObject({ code: "material-missing" });
      expect(
        (await env.app.library.detail(literatureId)).primary_pdf?.asset.sha256,
      ).toBe(env.asset.sha256);
      const files = new SqliteDocumentStorage(env.app.database, env.app.files);
      await files.withPinnedVersion(
        first.document.document_version_id,
        async (version) => expect(version).toEqual(first.document),
      );
      const duplicate = await env.app.documentProcessing.parseDocuments(
        env.request("reuse-current", 1),
      );
      expect(duplicate.published).toBe(false);
      const resourcePath = artifactReference(
        "parser-resource",
        first.document.resources[0]!.artifact,
      );
      const fullPath = join(env.home, "artifacts", resourcePath);
      const original = await readFile(fullPath);
      await writeFile(fullPath, Buffer.from("corrupt"));
      await expect(
        files.inspectExactInput({
          source_material_ref: first.document.source_material_ref,
          parser_result_sha256: first.document.parser_result_sha256,
          builder_version: first.document.builder_version,
          locator_scheme: first.document.locator_scheme,
          markdown: first.document.markdown,
          structure: first.document.structure,
          resources: first.document.resources,
        }),
      ).resolves.toBe("integrity-failure");
      await expect(
        files.withPinnedVersion(
          first.document.document_version_id,
          async () => true,
        ),
      ).rejects.toBeInstanceOf(Error);
      await writeFile(fullPath, original);
      await expect(
        files.withPinnedVersion(
          first.document.document_version_id,
          async () => true,
        ),
      ).resolves.toBe(true);
      const catalog = new DatabaseSync(join(env.home, "catalog.sqlite"));
      try {
        catalog
          .prepare(
            "UPDATE document_versions SET representation_sha256=? WHERE document_version_id=?",
          )
          .run("f".repeat(64), first.document.document_version_id);
        await expect(
          files.withPinnedVersion(
            first.document.document_version_id,
            async () => true,
          ),
        ).rejects.toThrow("representation hash");
        catalog
          .prepare(
            "UPDATE document_versions SET representation_sha256=? WHERE document_version_id=?",
          )
          .run(
            first.document.representation_sha256,
            first.document.document_version_id,
          );
      } finally {
        catalog.close();
      }
    } finally {
      await env.close();
    }
  });

  it("retains a valid old version through file/transaction faults and recovers idempotently", async () => {
    const env = await setup();
    try {
      const first = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      const real = new SqliteDocumentStorage(env.app.database, env.app.files);
      let phase:
        | "before-file"
        | "after-file"
        | "before-transaction"
        | "after-transaction" = "before-file";
      const failing: DocumentStoragePort = {
        publishImmutableArtifact: async (...args) => {
          if (phase === "before-file") throw new Error("injected before file");
          const result = await real.publishImmutableArtifact(...args);
          if (phase === "after-file") throw new Error("injected after file");
          return result;
        },
        inspectExactInput: (...args) => real.inspectExactInput(...args),
        commitVersion: async (...args) => {
          if (phase === "before-transaction")
            throw new Error("injected before transaction");
          const result = await real.commitVersion(...args);
          if (phase === "after-transaction")
            throw new Error("injected after transaction");
          return result;
        },
        withPinnedVersion: (...args) => real.withPinnedVersion(...args),
        withVerifiedArtifact: (...args) => real.withVerifiedArtifact(...args),
      };
      const processor = new DocumentProcessingService(
        env.app.database,
        failing,
        new TypeScriptParserArtifactRules(),
        env.app.parsing,
      );
      const counts = () => {
        const db = new DatabaseSync(join(env.home, "catalog.sqlite"), {
          readOnly: true,
        });
        try {
          return Number(
            db.prepare("SELECT count(*) AS n FROM document_versions").get()?.n,
          );
        } finally {
          db.close();
        }
      };
      for (const [index, fault] of (
        ["before-file", "after-file", "before-transaction"] as const
      ).entries()) {
        phase = fault;
        env.setText(`# Revision ${index}\nαβ\n![figure](fig.png)\n`);
        await expect(
          processor.parseDocuments(env.request("reparse", 1)),
        ).rejects.toMatchObject({ code: "document-publication" });
        expect(counts()).toBe(1);
        await real.withPinnedVersion(
          first.document.document_version_id,
          async (v) => expect(v).toEqual(first.document),
        );
      }
      phase = "after-transaction";
      env.setText(
        "# Committed despite response loss\nαβ\n![figure](fig.png)\n",
      );
      await expect(
        processor.parseDocuments(env.request("reparse", 1)),
      ).rejects.toMatchObject({ code: "document-publication" });
      expect(counts()).toBe(2);
      const replay = await env.app.documentProcessing.parseDocuments(
        env.request("reuse-current", 1),
      );
      expect(replay).toMatchObject({
        published: false,
        default_updated: true,
        default_revision: 2,
      });
      await real.withPinnedVersion(
        first.document.document_version_id,
        async (v) => expect(v).toEqual(first.document),
      );
    } finally {
      await env.close();
    }
  });

  it("holds an exact version closure while a new version is published", async () => {
    const env = await setup();
    try {
      const first = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      const storage = new SqliteDocumentStorage(
        env.app.database,
        env.app.files,
      );
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pinned = storage.withPinnedVersion(
        first.document.document_version_id,
        async (v) => {
          entered();
          await gate;
          return v;
        },
      );
      await ready;
      env.setText("# Concurrent revision\nαβ\n![figure](fig.png)\n");
      const second = await env.app.documentProcessing.parseDocuments(
        env.request("reparse", 1),
      );
      expect(second.document.document_version_id).not.toBe(
        first.document.document_version_id,
      );
      release();
      await expect(pinned).resolves.toEqual(first.document);
      await storage.withPinnedVersion(
        first.document.document_version_id,
        async (v) => expect(v).toEqual(first.document),
      );
    } finally {
      await env.close();
    }
  });
  it("exposes explicit CLI and authenticated HTTP reuse without starting a parser", async () => {
    const env = await setup();
    let web: Awaited<ReturnType<typeof startMaintenanceWorkbench>> | undefined;
    try {
      const first = await env.app.documentProcessing.parseDocuments(
        env.request("reparse"),
      );
      const output: string[] = [];
      const cli = await runCli(
        [
          "document",
          "parse",
          "--literature-id",
          literatureId,
          "--asset-id",
          env.asset.asset_id,
          "--asset-sha256",
          env.asset.sha256,
          "--mode",
          "reuse-current",
          "--json",
        ],
        { home: env.home, stdout: (value) => output.push(value) },
      );
      expect(cli.code).toBe(0);
      expect(JSON.parse(output.join("")).document.document_version_id).toBe(
        first.document.document_version_id,
      );
      expect(env.calls).toBe(1);
      web = await startMaintenanceWorkbench({
        home: env.home,
        assets: new Map([
          ["/", { contentType: "text/html", body: "<html>maintenance</html>" }],
          ["/query", { contentType: "text/html", body: "<html>query</html>" }],
        ]),
      });
      const home = await fetch(web.origin);
      expect(home.status).toBe(200);
      const cookie = home.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const session = await fetch(`${web.origin}/api/v1/maintenance/session`, {
        headers: { cookie: cookie! },
      });
      const grant = (await session.json()) as { csrf: string };
      const response = await fetch(
        `${web.origin}/api/v1/maintenance/parse-document`,
        {
          method: "POST",
          headers: {
            cookie: cookie!,
            origin: web.origin,
            "x-sciretriever-csrf": grant.csrf,
            "x-sciretriever-protocol-version": "1",
            "content-type": "application/json",
          },
          body: JSON.stringify(env.request("reuse-current", 1)),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        receipt: {
          document: { document_version_id: first.document.document_version_id },
          published: false,
        },
      });
      expect(env.calls).toBe(1);
      const forbidden = await fetch(
        `${web.origin}/api/v1/maintenance/parse-document`,
        {
          method: "POST",
          headers: { origin: web.origin, "content-type": "application/json" },
          body: JSON.stringify(env.request("reuse-current", 1)),
        },
      );
      expect(forbidden.status).toBe(403);
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let disconnected = false;
      Object.assign(web.application.maintenance!, {
        parseDocuments: async (_value: unknown, signal?: AbortSignal) => {
          entered();
          await new Promise<void>((resolve) =>
            signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
          disconnected = true;
          throw new DocumentProcessingError("document-cancelled");
        },
      });
      const client = new AbortController();
      const disconnectedRequest = fetch(
        `${web.origin}/api/v1/maintenance/parse-document`,
        {
          method: "POST",
          headers: {
            cookie: cookie!,
            origin: web.origin,
            "x-sciretriever-csrf": grant.csrf,
            "x-sciretriever-protocol-version": "1",
            "content-type": "application/json",
          },
          body: JSON.stringify(env.request("reuse-current", 1)),
          signal: client.signal,
        },
      );
      await ready;
      client.abort();
      await expect(disconnectedRequest).rejects.toBeInstanceOf(Error);
      await vi.waitFor(() => expect(disconnected).toBe(true));
    } finally {
      await web?.close();
      await env.close();
    }
  });
});
