import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { draftStorageFixture } from "./draft-text-storage-fixture.js";
import { runDraftTextWrite } from "../src/storage/sqlite/draft-text-engine.js";
import { correctedDocumentFixture } from "./corrected-document-fixture.js";
import type { VerifiedDocumentStructure } from "../src/document/verification-cache.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { randomUUID } from "node:crypto";
import { archiveFixture } from "./archive-fixture.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { documentRepresentationHash } from "../src/document/contract.js";
import { draftVersionId } from "../src/document/draft-builder.js";
import { parseDocumentRef } from "@sciretriever/contracts";

it("keeps an eligible current corrected version unless its publisher nominates another eligible version", async () => {
  const e = await archiveFixture({ offline: true });
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    expect((await e.submit("default-publication-choice")).failures).toEqual([]);
    const current = (
      await e.app.documentRead.default({
        literature_id: e.id,
        asset_id: e.asset.asset_id,
        asset_sha256: e.asset.sha256,
      })
    ).default!;
    const snapshot = (await e.app.database.documentVersion(
      current.document_version_id,
    ))!;
    if (snapshot.version.schema_version !== 2)
      throw new Error("Corrected fixture required");
    const v = snapshot.version;
    const input = {
      source_material_ref: v.source_material_ref,
      proofread_id: v.proofread_id,
      proofread_content_sha256: v.proofread_content_sha256,
      markdown: v.markdown,
      structure: v.structure,
      resources: v.resources,
      locator_scheme: v.locator_scheme,
      builder_version: "source-order-leaves-v3" as const,
    };
    const hash = await documentRepresentationHash(input);
    const legacy = parseDocumentRef({
      ...input,
      schema_version: 2,
      document_id: v.document_id,
      document_version_id: draftVersionId(v.document_id, hash),
      representation_sha256: hash,
    });
    const storage = new SqliteDocumentStorage(e.app.database, e.app.files);
    expect(await storage.inspectExactInput(input)).toBe("available");
    const committed = await e.app.database.commitDocumentVersion({
      ...snapshot,
      version: legacy,
      expected_default_revision: current.revision,
      expected_manual_revision: 0,
    });
    expect(committed.default_updated).toBe(true);
    const request = {
      literature_id: e.id,
      asset_id: e.asset.asset_id,
      asset_sha256: e.asset.sha256,
      expected_default_revision: committed.default_revision,
    };
    expect(
      await e.app.database.recomputeDocumentDefault(request),
    ).toMatchObject({
      document_version_id: legacy.document_version_id,
      default_changed: false,
      text_level: "proofread",
    });
    expect(
      await e.app.database.recomputeDocumentDefault({
        ...request,
        preferred_proofread_version_id: v.document_version_id,
      }),
    ).toMatchObject({
      document_version_id: v.document_version_id,
      default_changed: true,
      text_level: "proofread",
    });
  } finally {
    await e.close();
  }
}, 60_000);

it("publishes the exact draft, facts and raw image closure atomically, reuses it and rejects stale current CAS", async () => {
  const f = await draftStorageFixture();
  try {
    const { e, publication, output } = f;
    const v = output.document;
    expect(v.resources).toHaveLength(1);
    expect(await f.storage.commitDraftVersion(publication)).toEqual({
      published: true,
      current_revision: 1,
    });
    expect(
      await e.app.database.documentVersion(v.document_version_id),
    ).toMatchObject({
      version: v,
      draft_content_artifact_path: publication.draft_content_artifact_path,
    });
    expect(
      await e.app.database.draftVersionFacts(v.document_version_id),
    ).toEqual(output.counts);
    expect(
      await f.storage.commitDraftVersion({
        ...publication,
        expected_current_revision: 1,
      }),
    ).toEqual({ published: false, current_revision: 1 });
    await expect(
      f.storage.commitDraftVersion(publication),
    ).rejects.toMatchObject({ code: "draft-current-conflict" });
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys=ON");
      expect(
        db.prepare("SELECT count(*) n FROM document_versions").get()!.n,
      ).toBe(1);
      expect(
        db.prepare("SELECT count(*) n FROM draft_version_facts").get()!.n,
      ).toBe(1);
      expect(
        db.prepare("SELECT count(*) n FROM document_version_resources").get()!
          .n,
      ).toBe(1);
      expect(
        db
          .prepare("SELECT artifact_path FROM document_version_resources")
          .get()!.artifact_path,
      ).toBe(Object.values(publication.resource_artifact_paths)[0]);
      expect(
        Number(
          db
            .prepare(
              "SELECT revision FROM library_state_changes WHERE literature_id=?",
            )
            .get(e.parseRequest.literature_id)!.revision,
        ),
      ).toBeGreaterThan(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // The future Analysis projection is constrained now, but no writer is wired.
      db.prepare(
        "INSERT INTO artifact_objects VALUES('projection-fixture',?,1,'application/json','knowledge/projection-fixture.json')",
      ).run("f".repeat(64));
      db.prepare(
        "INSERT INTO processor_results(result_id,comparison_sha256,processor_id,processor_version,complete,producer,content_reference,content_sha256,content_size,content_media_type,created_at) VALUES('projection-result',?,'fixture','1',1,'external','knowledge/projection-fixture.json',?,1,'application/json','2026-11-15T00:00:00Z')",
      ).run("f".repeat(64), "f".repeat(64));
      db.prepare(
        "INSERT INTO processor_unfound_citations VALUES('projection-result','record','/value',?)",
      ).run(v.document_version_id);
      expect(() =>
        db
          .prepare(
            "UPDATE processor_unfound_citations SET document_version_id='missing'",
          )
          .run(),
      ).toThrow();
      db.exec(
        "DELETE FROM processor_results WHERE result_id='projection-result'",
      );
      expect(
        db.prepare("SELECT count(*) n FROM processor_unfound_citations").get()!
          .n,
      ).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    // No publication-flow/default side effect is connected in block 03.
    expect(
      await e.app.database.documentDefault(
        e.parseRequest.literature_id,
        e.asset.asset_id,
        e.asset.sha256,
      ),
    ).toBeNull();
    const result = await e.app.database.recomputeDocumentDefault({
      literature_id: e.parseRequest.literature_id,
      asset_id: e.asset.asset_id,
      asset_sha256: e.asset.sha256,
      expected_default_revision: null,
    });
    expect(result).toMatchObject({
      default_changed: true,
      text_level: "draft",
      default_revision: 1,
    });
    const bytes = vi
      .spyOn(e.app.files, "withVerified")
      .mockImplementation(() => {
        throw new Error("Batch read must not load artifacts");
      });
    expect(
      await e.app.database.primaryDocumentDefaults([
        e.parseRequest.literature_id,
      ]),
    ).toEqual([
      {
        literature_id: e.parseRequest.literature_id,
        asset_id: e.asset.asset_id,
        document_version_id: v.document_version_id,
        text_level: "draft",
      },
    ]);
    bytes.mockRestore();
    const otherId = randomUUID();
    await e.app.database.putLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: otherId as typeof FIXTURE_LITERATURE.literature_id,
      meta_literature_id:
        randomUUID() as typeof FIXTURE_LITERATURE.meta_literature_id,
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        identifiers: [],
        title: "Synthetic metadata-only entry",
      },
    });
    const reader = new SqliteWorker(join(e.home, "catalog.sqlite"), undefined, {
      readOnly: true,
    });
    try {
      expect(await reader.draftVersionFacts(v.document_version_id)).toEqual(
        output.counts,
      );
      expect(await reader.primaryDocumentDefaults([otherId])).toEqual([
        {
          literature_id: otherId,
          asset_id: null,
          document_version_id: null,
          text_level: null,
        },
      ]);
      await expect(
        reader.commitDraftVersion({ ...publication, facts: output.counts }),
      ).rejects.toThrow();
    } finally {
      await reader.close();
    }
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);

it("rolls back every registration and invalidation when facts fail after version and resource insertion", async () => {
  const f = await draftStorageFixture();
  try {
    const db = new DatabaseSync(join(f.e.home, "catalog.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const tables = [
        "artifact_objects",
        "document_versions",
        "document_version_resources",
        "draft_version_facts",
        "draft_current",
        "library_state_revision",
        "library_state_changes",
        "retrieval_source_revision",
      ];
      const snapshot = () =>
        tables.map((table) =>
          db.prepare("SELECT * FROM " + table + " ORDER BY 1").all(),
        );
      const before = snapshot();
      const failure = new Error("Synthetic facts insertion failure");
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("INSERT INTO draft_version_facts")) throw failure;
        return prepare(sql);
      });
      expect(() =>
        runDraftTextWrite(db, {
          kind: "commit",
          publication: { ...f.publication, facts: f.output.counts },
        }),
      ).toThrow(failure);
      spy.mockRestore();
      expect(db.isTransaction).toBe(false);
      expect(snapshot()).toEqual(before);
      expect(
        runDraftTextWrite(db, {
          kind: "commit",
          publication: { ...f.publication, facts: f.output.counts },
        }),
      ).toMatchObject({ published: true });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);

it("verifies draft content without page tools, preserves cache budgets and rejects one changed content byte", async () => {
  const f = await draftStorageFixture();
  try {
    await f.storage.commitDraftVersion(f.publication);
    const budgets: number[] = [];
    const consume = async (
      _version: unknown,
      markdown: Uint8Array,
      structure: VerifiedDocumentStructure,
    ) => {
      expect(Buffer.from(markdown)).toEqual(Buffer.from(f.output.markdown));
      expect(
        structure.schema_version === 2 &&
          structure.segments.some((s) => s.basis === "text-layer-match"),
      ).toBe(true);
    };
    await f.storage.withVerifiedDocument(
      f.output.document.document_version_id,
      consume,
      undefined,
      (n) => budgets.push(n),
    );
    const reads = vi.spyOn(f.e.app.files, "withVerified");
    const warmBudget: number[] = [];
    await f.storage.withVerifiedDocument(
      f.output.document.document_version_id,
      consume,
      undefined,
      (n) => warmBudget.push(n),
    );
    expect(reads).not.toHaveBeenCalled();
    expect(warmBudget).toEqual(budgets);
    reads.mockRestore();
    const path = join(
      f.e.app.files.root,
      f.publication.draft_content_artifact_path,
    );
    const original = await readFile(path);
    const changed = Buffer.from(original);
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    await writeFile(path, changed);
    await expect(
      f.storage.withVerifiedDocument(
        f.output.document.document_version_id,
        consume,
      ),
    ).rejects.toThrow();
    await writeFile(path, original);
    await f.storage.withVerifiedDocument(
      f.output.document.document_version_id,
      consume,
    );
    const stopped = AbortSignal.abort();
    await expect(
      f.storage.withVerifiedDocument(
        f.output.document.document_version_id,
        consume,
        stopped,
      ),
    ).rejects.toThrow();
    await f.e.app.close();
    await expect(
      f.storage.withVerifiedDocument(
        f.output.document.document_version_id,
        consume,
      ),
    ).rejects.toThrow();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);

it("recomputes draft/proofread/missing defaults with the legacy v2 JSON and events, retaining fixed old versions", async () => {
  const f = await draftStorageFixture();
  try {
    const e = f.e,
      v = f.output.document;
    await f.storage.commitDraftVersion(f.publication);
    const request = {
      literature_id: e.parseRequest.literature_id,
      asset_id: e.asset.asset_id,
      asset_sha256: e.asset.sha256,
      expected_default_revision: null as number | null,
    };
    await e.app.database.recomputeDocumentDefault(request);
    const readJson = () => {
      const db = new DatabaseSync(join(e.home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT source_json FROM archive_content_heads")
          .get()!.source_json;
      } finally {
        db.close();
      }
    };
    expect(readJson()).toBe(
      JSON.stringify({
        text_level: "draft",
        document_version_id: v.document_version_id,
      }),
    );
    await expect(
      e.app.database.recomputeDocumentDefault(request),
    ).rejects.toMatchObject({ code: "document-default-conflict" });
    const corrected = await correctedDocumentFixture(e.app).parseDocuments({
      ...e.parseRequest,
      mode: "reuse-current",
      expected_default_revision: 1,
    });
    await e.app.structureAnnotations!.buildRules({
      document_version_id: corrected.document.document_version_id,
    });
    // Construct a corrected text that depends on both raw profiles, while the
    // draft depends only on vlm-engine, to test profile-specific fallback.
    const pipeline = (await f.rawStore.current(e.asset.asset_id)).find(
      (r) => r.profile === "pipeline",
    )!.result!;
    await f.rawStore.pin(
      pipeline.raw_parse_id,
      corrected.document.proofread_id,
    );
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      // Explicit publication already selected v2. Recompute keeps that valid text.
      expect(
        await e.app.database.recomputeDocumentDefault({
          ...request,
          expected_default_revision: 2,
        }),
      ).toMatchObject({ text_level: "proofread", default_changed: false });
      const annotation = db
        .prepare(
          "SELECT annotation_id FROM structure_annotation_current WHERE document_version_id=?",
        )
        .get(corrected.document.document_version_id);
      expect(annotation).toBeDefined();
      expect(readJson()).toBe(
        JSON.stringify({
          document_version_id: corrected.document.document_version_id,
          structure_annotation_id: annotation!.annotation_id,
        }),
      );
      const before = Number(
        db.prepare("SELECT count(*) n FROM archive_version_events").get()!.n,
      );
      // Test the helper in the same transaction a raw-current owner will use.
      db.exec(
        "BEGIN IMMEDIATE;UPDATE raw_parse_current SET raw_parse_id=NULL WHERE profile='pipeline'",
      );
      const { recomputeDocumentDefault } = await import(
        "../src/storage/sqlite/document-defaults.js"
      );
      expect(
        recomputeDocumentDefault(db, {
          ...request,
          expected_default_revision: 2,
        }),
      ).toMatchObject({
        text_level: "draft",
        default_changed: true,
        default_revision: 3,
      });
      db.exec("COMMIT");
      expect(readJson()).toBe(
        JSON.stringify({
          text_level: "draft",
          document_version_id: v.document_version_id,
        }),
      );
      db.exec(
        "BEGIN IMMEDIATE;UPDATE raw_parse_current SET raw_parse_id=NULL WHERE profile='vlm-engine'",
      );
      expect(
        recomputeDocumentDefault(db, {
          ...request,
          expected_default_revision: 3,
        }),
      ).toMatchObject({ text_level: null, default_changed: true });
      db.exec("COMMIT");
      expect(
        await e.app.database.documentDefault(
          request.literature_id,
          request.asset_id,
          request.asset_sha256,
        ),
      ).toBeNull();
      expect(readJson()).toBeNull();
      expect(
        Number(
          db.prepare("SELECT count(*) n FROM archive_version_events").get()!.n,
        ),
      ).toBeGreaterThan(before);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    // Losing currentness never changes a pinned version or its evidence bytes.
    await f.storage.withVerifiedDocument(
      v.document_version_id,
      async (document, markdown) => {
        expect(document).toEqual(v);
        expect(Buffer.from(markdown)).toEqual(Buffer.from(f.output.markdown));
      },
    );
  } finally {
    await f.close();
  }
}, 60_000);
