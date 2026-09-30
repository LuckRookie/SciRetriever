import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  inspectDocumentCatalog,
  migrateDocumentCatalog,
} from "../src/storage/sqlite/document-migration.js";
import { SCHEMA_V3_FINGERPRINT } from "../src/storage/sqlite/schema-v3.js";
import { documentRepresentationHash } from "../src/document/contract.js";
import { runCli } from "../src/cli/main.js";
import { acquireCatalogWriteLock } from "../src/storage/write-admission.js";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";

const lit = "00000000-0000-0000-0000-000000000951";
const meta = "00000000-0000-0000-0000-000000000952";
const asset = "00000000-0000-0000-0000-000000000953";
const pdfBytes = Buffer.from("%PDF-1.4\n%%\n");
const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
const markdownHash = "b".repeat(64);
const parserHash = "c".repeat(64);
const provenance = "00000000-0000-0000-0000-000000000954";

async function seed(path: string, v2: boolean): Promise<void> {
  const worker = new SqliteWorker(path);
  try {
    await worker.schema();
    await worker.putLiterature({
      literature_id: lit as never,
      meta_literature_id: meta as never,
      version_role: "published",
      status: "UNREVIEWED",
      metadata: {
        title: "Synthetic document migration",
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
    if (v2) await worker.upgradeExecutionSchema();
  } finally {
    await worker.close();
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare(
      "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
    ).run(asset, pdfHash, 12, "application/pdf", `objects/${pdfHash}`);
    db.prepare(
      "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) VALUES(?,?,?,?,?)",
    ).run(asset, pdfHash, 12, "application/pdf", `objects/${pdfHash}`);
    db.prepare(
      "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
    ).run(
      "markdown-1",
      markdownHash,
      10,
      "text/markdown",
      `objects/${markdownHash}`,
    );
    db.prepare(
      "INSERT INTO provenances(provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256) VALUES(?,'parser','fake-parser',NULL,'2026-09-28T00:00:00.000Z',?,?)",
    ).run(provenance, pdfHash, "d".repeat(64));
    db.prepare(
      "INSERT INTO parser_results(source_asset_id,source_sha256,result_sha256,page_count,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,provenance_id,parser_version,mode,model_identity) VALUES(?,?,?,?,?,?,?,'text/markdown',?,'1',NULL,NULL)",
    ).run(
      asset,
      pdfHash,
      parserHash,
      1,
      `objects/${markdownHash}`,
      markdownHash,
      10,
      provenance,
    );
  } finally {
    db.close();
  }
}

function facts(path: string): readonly unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return [
      db.prepare("SELECT * FROM literatures WHERE literature_id=?").get(lit),
      db.prepare("SELECT * FROM assets WHERE asset_id=?").get(asset),
      db
        .prepare("SELECT * FROM provenances WHERE provenance_id=?")
        .get(provenance),
      db
        .prepare("SELECT * FROM parser_results WHERE source_asset_id=?")
        .get(asset),
    ];
  } finally {
    db.close();
  }
}

describe("document catalog v3 migration", () => {
  for (const v2 of [false, true]) {
    it(`preserves v${v2 ? 2 : 1} facts, creates a recoverable backup, and keeps legacy readers live`, async () => {
      const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
      const catalog = join(root, "catalog.sqlite");
      const backup = join(root, "before.sqlite");
      try {
        await seed(catalog, v2);
        const original = facts(catalog);
        const originalBytes = createHash("sha256")
          .update(await readFile(catalog))
          .digest("hex");
        const inspected = await inspectDocumentCatalog(catalog);
        expect(inspected.schema_version).toBe(v2 ? 2 : 1);
        await expect(
          migrateDocumentCatalog({ catalog_path: catalog, dry_run: true }),
        ).resolves.toMatchObject({
          action: "dry-run",
          from_version: v2 ? 2 : 1,
        });
        expect(
          createHash("sha256")
            .update(await readFile(catalog))
            .digest("hex"),
        ).toBe(originalBytes);
        const result = await migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: backup,
        });
        expect(result).toMatchObject({
          action: "migrated",
          to_version: 3,
          manifest_fingerprint: SCHEMA_V3_FINGERPRINT,
        });
        expect(await inspectDocumentCatalog(catalog)).toMatchObject({
          schema_version: 3,
          document_versions: 0,
        });
        expect(facts(catalog)).toEqual(original);
        expect(facts(backup)).toEqual(original);
        expect((await inspectDocumentCatalog(backup)).schema_version).toBe(
          v2 ? 2 : 1,
        );
        const readonly = new SqliteWorker(catalog, undefined, {
          readOnly: true,
        });
        try {
          await expect(readonly.queryPreflight()).resolves.toMatchObject({
            status: "ready",
          });
          await expect(readonly.getLiterature(lit)).resolves.toMatchObject({
            metadata: { title: "Synthetic document migration" },
          });
          await expect(readonly.getAsset(asset)).resolves.toMatchObject({
            asset_id: asset,
            sha256: pdfHash,
          });
        } finally {
          await readonly.close();
        }
        const writer = new SqliteWorker(catalog);
        try {
          await expect(writer.schema()).resolves.toMatchObject({
            schema_version: 3,
          });
          await expect(writer.contentCleanupSnapshot(lit)).resolves.toBeNull();
          await expect(
            writer.isArtifactUnregistered({
              reference: `objects/${pdfHash}`,
              artifact: {
                sha256: pdfHash as never,
                byte_size: 12,
                media_type: "application/pdf",
              },
            }),
          ).resolves.toBe(false);
        } finally {
          await writer.close();
        }
        await expect(
          migrateDocumentCatalog({ catalog_path: catalog }),
        ).resolves.toMatchObject({ action: "already-v3", to_version: 3 });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("rolls back a failed schema transaction, leaves its backup intact, and reruns", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    const backup = join(root, "before.sqlite");
    try {
      await seed(catalog, false);
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: backup,
          checkpoint: (stage) => {
            if (stage === "before-commit") throw new Error("injected failure");
          },
        }),
      ).rejects.toThrow("injected failure");
      expect((await inspectDocumentCatalog(catalog)).schema_version).toBe(1);
      expect((await inspectDocumentCatalog(backup)).schema_version).toBe(1);
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: join(root, "retry.sqlite"),
        }),
      ).resolves.toMatchObject({ action: "migrated", from_version: 1 });
      const restored = join(root, "restored.sqlite");
      await copyFile(backup, restored);
      expect((await inspectDocumentCatalog(restored)).schema_version).toBe(1);
      expect(facts(restored)).toEqual(facts(backup));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a concurrent WAL commit after backup and leaves both copies readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    const backup = join(root, "before.sqlite");
    try {
      await seed(catalog, true);
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: backup,
          checkpoint: (stage) => {
            if (stage !== "backed-up") return;
            const writer = new DatabaseSync(catalog);
            try {
              writer
                .prepare(
                  "INSERT INTO provenances(provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256) VALUES(?,'user','synthetic',NULL,'2026-09-28T00:00:00.000Z',NULL,NULL)",
                )
                .run("concurrent-wal-commit");
            } finally {
              writer.close();
            }
          },
        }),
      ).rejects.toThrow("catalog changed while backing up");
      expect((await inspectDocumentCatalog(catalog)).schema_version).toBe(2);
      expect((await inspectDocumentCatalog(backup)).schema_version).toBe(2);
      const source = new DatabaseSync(catalog, { readOnly: true });
      const saved = new DatabaseSync(backup, { readOnly: true });
      try {
        expect(
          source
            .prepare(
              "SELECT 1 FROM provenances WHERE provenance_id='concurrent-wal-commit'",
            )
            .get(),
        ).toBeDefined();
        expect(
          saved
            .prepare(
              "SELECT 1 FROM provenances WHERE provenance_id='concurrent-wal-commit'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        source.close();
        saved.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares write admission with application writers and releases it after a failed migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    try {
      await seed(catalog, true);
      await expect(
        migrateDocumentCatalog({ catalog_path: catalog, dry_run: true }),
      ).resolves.toBeDefined();
      expect(await readdir(root)).not.toContain(".sciretriever-locks");
      const held = await acquireCatalogWriteLock(catalog);
      try {
        await expect(
          migrateDocumentCatalog({
            catalog_path: catalog,
            backup_path: join(root, "blocked.sqlite"),
          }),
        ).rejects.toMatchObject({ code: "write-admission-conflict" });
      } finally {
        await held.release();
      }
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: join(root, "failure.sqlite"),
          checkpoint: (stage) => {
            if (stage === "before-commit") throw new Error("injected failure");
          },
        }),
      ).rejects.toThrow("injected failure");
      const acquired = await acquireCatalogWriteLock(catalog);
      await acquired.release();
      expect((await inspectDocumentCatalog(catalog)).schema_version).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects linked catalog paths and never replaces an occupied backup target", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    try {
      await seed(catalog, true);
      const alias = join(root, "alias.sqlite");
      await link(catalog, alias);
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: join(root, "hardlink-backup.sqlite"),
        }),
      ).rejects.toBeDefined();
      await rm(alias);
      await symlink(catalog, alias);
      await expect(
        migrateDocumentCatalog({
          catalog_path: alias,
          backup_path: join(root, "symlink-backup.sqlite"),
        }),
      ).rejects.toBeDefined();
      await rm(alias);
      for (const kind of ["empty", "symlink"] as const) {
        const backup = join(root, `${kind}.sqlite`);
        await expect(
          migrateDocumentCatalog({
            catalog_path: catalog,
            backup_path: backup,
            checkpoint: async (stage) => {
              if (stage !== "before-backup-publish") return;
              if (kind === "empty") await writeFile(backup, "");
              else await symlink(catalog, backup);
            },
          }),
        ).rejects.toThrow("backup target already exists");
        if (kind === "empty")
          expect(await readFile(backup)).toEqual(Buffer.alloc(0));
        else expect(await readFile(backup)).toEqual(await readFile(catalog));
        await rm(backup);
      }
      expect((await inspectDocumentCatalog(catalog)).schema_version).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens migrated metadata and verified assets through QueryApplication", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      await seed(catalog, true);
      const db = new DatabaseSync(catalog);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        db.prepare(
          "INSERT INTO literature_assets(literature_asset_id,literature_id,asset_id,role,provenance_id,source_url) VALUES(?,?,?,'primary-pdf',?,NULL)",
        ).run("00000000-0000-0000-0000-000000000955", lit, asset, provenance);
        // The earlier retention fixture uses a deliberately synthetic parser hash.
        // This journey exercises the already valid metadata and asset path.
        db.prepare("DELETE FROM parser_results WHERE source_asset_id=?").run(
          asset,
        );
      } finally {
        db.close();
      }
      await mkdir(join(root, "artifacts", "objects"), { recursive: true });
      await writeFile(join(root, "artifacts", "objects", pdfHash), pdfBytes);
      await migrateDocumentCatalog({
        catalog_path: catalog,
        backup_path: join(root, "before.sqlite"),
      });
      query = await createQueryApplication(root);
      expect(query.readiness).toMatchObject({
        status: "ready",
        schema_version: 3,
      });
      const detail = await query.query!.detail(lit);
      expect(detail).toMatchObject({
        literature: { literature_id: lit },
        primary_pdf: { asset: { asset_id: asset, sha256: pdfHash } },
      });
      const chunks: Uint8Array[] = [];
      await query.literatureArtifacts!.withArtifact(
        detail.primary_pdf!.asset,
        async (stream) => {
          for await (const chunk of stream) chunks.push(chunk);
        },
      );
      expect(Buffer.concat(chunks)).toEqual(pdfBytes);
      await query.close();
      query = undefined;
      app = await createApplication(root, { browserHost: () => null });
      await expect(app.library.detail(lit)).resolves.toMatchObject({
        literature: { literature_id: lit },
        primary_pdf: { asset: { sha256: pdfHash } },
      });
    } finally {
      await app?.close();
      await query?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins document source, provenance, and representation artifacts in v3", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    try {
      await seed(catalog, true);
      await migrateDocumentCatalog({
        catalog_path: catalog,
        backup_path: join(root, "before.sqlite"),
      });
      const db = new DatabaseSync(catalog);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        const structureHash = "e".repeat(64);
        db.prepare(
          "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
        ).run(
          "structure-1",
          structureHash,
          32,
          "application/json",
          `objects/${structureHash}`,
        );
        db.prepare(
          "INSERT INTO document_versions(document_version_id,document_id,schema_version,literature_id,source_asset_id,source_sha256,source_byte_size,source_media_type,source_artifact_path,parser_result_sha256,parser_provenance_id,builder_version,locator_scheme,representation_sha256,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,structure_artifact_path,structure_sha256,structure_byte_size,structure_media_type,created_at) VALUES(?, ?, 1, ?, ?, ?, 12, 'application/pdf', ?, ?, ?, 'builder/1', 'utf8-segment-v1', ?, ?, ?, 10, 'text/markdown', ?, ?, 32, 'application/json', ?)",
        ).run(
          "version-1",
          "document-1",
          lit,
          asset,
          pdfHash,
          `objects/${pdfHash}`,
          parserHash,
          provenance,
          "f".repeat(64),
          `objects/${markdownHash}`,
          markdownHash,
          `objects/${structureHash}`,
          structureHash,
          "2026-09-28T00:00:00.000Z",
        );
        db.prepare("DELETE FROM parser_results WHERE source_asset_id=?").run(
          asset,
        );
        expect(() =>
          db
            .prepare(
              "INSERT INTO document_defaults(document_id,document_version_id,revision) VALUES('another-document','version-1',1)",
            )
            .run(),
        ).toThrow();
        db.prepare(
          "INSERT INTO document_defaults(document_id,document_version_id,revision) VALUES('document-1','version-1',1)",
        ).run();
        expect(() =>
          db.prepare("DELETE FROM assets WHERE asset_id=?").run(asset),
        ).toThrow();
        expect(() =>
          db
            .prepare("DELETE FROM provenances WHERE provenance_id=?")
            .run(provenance),
        ).toThrow();
        expect(() =>
          db
            .prepare("DELETE FROM artifact_objects WHERE relative_path=?")
            .run(`objects/${structureHash}`),
        ).toThrow();
        expect(() =>
          db
            .prepare("DELETE FROM artifact_objects WHERE relative_path=?")
            .run(`objects/${markdownHash}`),
        ).toThrow();
      } finally {
        db.close();
      }
      expect((await inspectDocumentCatalog(catalog)).document_versions).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects drift, damage, and a target outside the synthetic temp scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    try {
      await seed(catalog, true);
      const db = new DatabaseSync(catalog);
      try {
        db.prepare("UPDATE schema_identity SET schema_fingerprint=?").run(
          "0".repeat(64),
        );
      } finally {
        db.close();
      }
      await expect(inspectDocumentCatalog(catalog)).rejects.toBeDefined();
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: join(root, "backup.sqlite"),
        }),
      ).rejects.toBeDefined();
      await writeFile(catalog, Buffer.from("damaged catalog"));
      await expect(inspectDocumentCatalog(catalog)).rejects.toBeDefined();
      await expect(
        migrateDocumentCatalog({ catalog_path: catalog, dry_run: true }),
      ).rejects.toBeDefined();
      await expect(
        migrateDocumentCatalog({
          catalog_path: join(tmpdir(), "outside.sqlite"),
          dry_run: true,
        }),
      ).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an added table even when the stored fingerprint is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    try {
      await seed(catalog, true);
      const db = new DatabaseSync(catalog);
      try {
        db.exec(
          "CREATE TABLE document_unmanifested(id TEXT PRIMARY KEY) STRICT",
        );
      } finally {
        db.close();
      }
      await expect(inspectDocumentCatalog(catalog)).rejects.toThrow(
        "outside its manifest",
      );
      await expect(
        migrateDocumentCatalog({ catalog_path: catalog, dry_run: true }),
      ).rejects.toThrow("outside its manifest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["missing", "changed"] as const)(
    "rejects a %s v3 table through normal readers and writers",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
      const catalog = join(root, "catalog.sqlite");
      let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
      try {
        await seed(catalog, true);
        await migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: join(root, "before.sqlite"),
        });
        const db = new DatabaseSync(catalog);
        try {
          db.exec("DROP TABLE document_defaults");
          if (kind === "changed")
            db.exec(
              "CREATE TABLE document_defaults(document_id TEXT PRIMARY KEY) STRICT",
            );
        } finally {
          db.close();
        }
        await expect(inspectDocumentCatalog(catalog)).rejects.toBeDefined();
        query = await createQueryApplication(root);
        expect(query.readiness.status).toBe("unavailable");
        expect(query.query).toBeNull();
        const writer = new SqliteWorker(catalog);
        try {
          await expect(writer.schema()).rejects.toBeDefined();
        } finally {
          await writer.close();
        }
      } finally {
        await query?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("exposes explicit CLI inspection and refuses migration without declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-document-"));
    const catalog = join(root, "catalog.sqlite");
    try {
      await seed(catalog, false);
      const inspection = await runCli([
        "storage",
        "document-inspect",
        "--catalog",
        catalog,
      ]);
      expect(inspection).toMatchObject({
        code: 0,
        value: { schema_version: 1 },
      });
      const refused = await runCli([
        "storage",
        "document-migrate",
        "--catalog",
        catalog,
        "--backup",
        join(root, "backup.sqlite"),
      ]);
      expect(refused.code).toBe(3);
      expect((await inspectDocumentCatalog(catalog)).schema_version).toBe(1);
      const migrated = await runCli([
        "storage",
        "document-migrate",
        "--catalog",
        catalog,
        "--backup",
        join(root, "backup.sqlite"),
        "--synthetic-copy",
      ]);
      expect(migrated).toMatchObject({
        code: 0,
        value: { action: "migrated", to_version: 3 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("hashes logical references and structure while leaving identity and provenance separate", async () => {
  const base = {
    source_material_ref: {
      literature_id: lit,
      asset_id: asset,
      asset_sha256: pdfHash as never,
      media_type: "application/pdf",
      byte_size: 12,
      artifact: {
        sha256: pdfHash as never,
        byte_size: 12,
        media_type: "application/pdf",
      },
    },
    parser_result_sha256: parserHash as never,
    builder_version: "markdown-builder/1",
    locator_scheme: "utf8-segment-v1",
    markdown: {
      sha256: markdownHash as never,
      byte_size: 10,
      media_type: "text/markdown",
    },
    structure: {
      sha256: "e".repeat(64) as never,
      byte_size: 24,
      media_type: "application/json",
    },
    resources: [
      {
        resource_id: "r1",
        reference: "figures/one.png",
        relation: "image" as const,
        artifact: {
          sha256: "f".repeat(64) as never,
          byte_size: 8,
          media_type: "image/png",
        },
      },
    ],
  };
  const first = await documentRepresentationHash(base);
  expect(first).toBe(await documentRepresentationHash(base));
  expect(first).not.toBe(
    await documentRepresentationHash({
      ...base,
      resources: [{ ...base.resources[0]!, reference: "figures/two.png" }],
    }),
  );
  expect(first).not.toBe(
    await documentRepresentationHash({
      ...base,
      structure: { ...base.structure, sha256: "0".repeat(64) as never },
    }),
  );
  await expect(
    documentRepresentationHash({
      ...base,
      resources: [{ ...base.resources[0]!, reference: "../unsafe.png" }],
    }),
  ).rejects.toBeDefined();
});
