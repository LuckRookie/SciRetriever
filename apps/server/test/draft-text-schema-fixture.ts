import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { processorFixture } from "./processor-fixture.js";
import { offlineTableCounts } from "../src/storage/sqlite/archive-schema-migration.js";
import { imageBytes } from "./archive-text-fixture.js";
import {
  archiveProofreadHash,
  canonicalJsonBytes,
  longDocumentInfo,
  parseArchiveTextBundleV2,
  parseArtifactRef,
  parseProofreadVersionV2,
  sha256,
} from "@sciretriever/contracts";
import { ArchiveTextPipeline } from "../src/archive/text-pipeline.js";
import { ArchiveOrchestrator } from "../src/archive/orchestrator.js";
import {
  arrangementAnnotation,
  arrangedStructureSatisfied,
  renderArrangement,
} from "../src/archive/render.js";
import { byteHash, textId } from "../src/archive/text-source.js";
import { emptyArchiveUsage } from "../src/archive/text-session.js";
import { documentRepresentationHash } from "../src/document/contract.js";
import { documentIdentity } from "../src/document/proofread-publication.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";

/** Seed the historical v4 closure, rather than submitting modern v5 bases to processing. */
class FrozenV16TextPipeline extends ArchiveTextPipeline {
  override async render(literature: string, asset: string) {
    const state = await this.storage.state(asset),
      output = (await this.storage.load(String(state.current!.proofread_id)))!;
    const bundle = parseArchiveTextBundleV2({
      ...output.bundle,
      leaves: output.bundle.leaves.map((row) => ({
        ...row,
        basis:
          row.text_source === "manual"
            ? "manual"
            : output.version.pages[row.leaf.page_index]!.page_kind ===
                "text-layer"
              ? "text-layer"
              : "image-only",
      })),
    });
    const {
      proofread_id: _id,
      content_sha256: _hash,
      ...body
    } = output.version;
    void _id;
    void _hash;
    const bytes = canonicalJsonBytes(bundle),
      input = {
        ...body,
        blocks: parseArtifactRef({
          sha256: byteHash(bytes),
          byte_size: bytes.length,
          media_type: "application/json",
        }),
      },
      contentHash = await archiveProofreadHash(input),
      version = await parseProofreadVersionV2({
        ...input,
        content_sha256: contentHash,
        proofread_id: `${contentHash.slice(0, 8)}-${contentHash.slice(8, 12)}-${contentHash.slice(12, 16)}-${contentHash.slice(16, 20)}-${contentHash.slice(20, 32)}`,
      });
    await this.storage.publish(version, bundle, {
      current_revision: Number(state.current!.revision),
      manual_revision: state.manual_revision,
    });
    const rendered = renderArrangement(
        bundle,
        version.resources,
        "source-order-leaves-v4",
      ),
      markdown = await this.storage.write(
        "proofread-markdown",
        rendered.markdown,
        "text/markdown",
      ),
      structure = await this.storage.write(
        "document-structure",
        rendered.bytes,
      ),
      db = this.storage.database,
      material = (await db.documentMaterial(literature, asset))!,
      resources = rendered.resources.map((resource, index) => ({
        resource_id: `r${index + 1}`,
        reference: resource.reference,
        relation: "image" as const,
        artifact: resource.artifact,
      })),
      representation = {
        source_material_ref: material.material,
        proofread_id: version.proofread_id,
        proofread_content_sha256: version.content_sha256,
        builder_version: "source-order-leaves-v4" as const,
        locator_scheme: "utf8-segment-v1" as const,
        markdown: parseArtifactRef({
          sha256: markdown.sha256,
          byte_size: markdown.byte_size,
          media_type: markdown.media_type,
        }),
        structure: parseArtifactRef({
          sha256: structure.sha256,
          byte_size: structure.byte_size,
          media_type: structure.media_type,
        }),
        resources,
      },
      hash = await documentRepresentationHash(representation),
      documentId = documentIdentity(literature, asset),
      document = {
        schema_version: 2 as const,
        document_id: documentId,
        document_version_id: textId(["document-version", documentId, hash]),
        representation_sha256: hash,
        ...representation,
      },
      paths: Record<string, string> = {};
    for (const resource of rendered.resources)
      paths[resource.reference] = (await db.locateArtifact(
        resource.artifact,
      ))!.reference;
    await db.proofread("render-resources", {
      proofread_id: version.proofread_id,
      manual_revision: state.manual_revision,
      resources: [
        {
          ...markdown,
          kind: "markdown",
          logical_reference: "render/source-order-leaves-v4/" + markdown.sha256,
        },
        ...rendered.resources.map((resource) => ({
          ...resource.artifact,
          reference: paths[resource.reference]!,
          kind: "image",
          logical_reference: resource.reference,
        })),
      ],
    });
    const previous = await db.documentDefault(
        literature,
        asset,
        version.part_sha256,
      ),
      result = await new SqliteDocumentStorage(
        db,
        this.storage.files,
      ).commitVersion({
        version: document,
        source_artifact_path: material.path,
        markdown_artifact_path: markdown.reference,
        structure_artifact_path: structure.reference,
        resource_artifact_paths: paths,
        expected_default_revision: previous?.revision ?? null,
        expected_manual_revision: state.manual_revision,
      }),
      annotations = new SqliteAnnotationStorage(db, this.storage.files),
      before = await annotations.state(document.document_version_id),
      annotation = arrangementAnnotation(
        document.document_version_id,
        "main",
        bundle,
        rendered,
      ),
      published = await annotations.publish(annotation, {
        expected_manual_revision: before.manual_revision,
        expected_current_revision: before.current?.revision ?? null,
        edit: null,
      });
    return {
      ...result,
      document_version_id: document.document_version_id,
      annotation_id: published.annotation_id,
      proofread_id: version.proofread_id,
      arrangement_id: version.arrangement_id,
      structure_satisfied: arrangedStructureSatisfied(annotation, bundle),
      long_document: longDocumentInfo(bundle.arrangement?.classification),
      source_map: rendered.source_map.length,
      usage: emptyArchiveUsage(),
      index_status: "unchanged",
    };
  }
}

async function buildFrozenV16(
  env: Awaited<ReturnType<typeof processorFixture>>,
) {
  await env.app.rawParsing!.parseAsset(
    env.asset.asset_id,
    ["pipeline", "vlm-engine"],
    undefined,
    { expected_sha256: env.asset.sha256 },
  );
  const text = env.app.archiveText!,
    historical = new FrozenV16TextPipeline(
      text.storage,
      text.raw,
      text.pdf,
      text.runtime,
      text.profile,
      text.scheduleIndex,
      text.maxConcurrentPages,
    );
  await new ArchiveOrchestrator(env.app.database, {
    text: historical,
    proofread: env.app.proofreading!,
    documents: env.app.proofreadDocuments,
    structure: env.app.structureAnnotations!,
    metadata: env.app.archiveMetadata,
    references: env.app.archiveReferences,
    tags: env.app.tags,
    metadataFields: env.app.metadataFields,
    method_sha256: await sha256(
      canonicalJsonBytes({ method: "synthetic-frozen-v16" }),
    ),
  }).build({
    schema_version: 2,
    literature_id: env.parseRequest.literature_id,
    mode: "full",
    from_step: null,
  });
  const current = await env.app.database.documentDefault(
    env.parseRequest.literature_id,
    env.asset.asset_id,
    env.asset.sha256,
  );
  const status = await env.app.archive.status(env.parseRequest.literature_id);
  if (!current || status.status !== "READY")
    throw new Error(
      `Synthetic historical archive did not publish: ${JSON.stringify(status)}`,
    );
  const document = (await env.app.database.documentVersion(
    current.document_version_id,
  ))!.version;
  if (
    document.schema_version !== 2 ||
    document.builder_version !== "source-order-leaves-v4"
  )
    throw new Error(
      "Synthetic schema-16 document must use the historical v4 builder",
    );
  return document;
}

function syntheticLongPdf() {
  const content = "BT /F1 14 Tf 40 740 Td (A synthetic finding.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: 51 }, (_, i) => `${i + 5} 0 R`).join(" ")}] /Count 51 >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: 51 },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(bytes));
    bytes += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(bytes);
  bytes += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(bytes);
}

/** A real offline application supplies facts; only the test projects them onto frozen v16. */
export async function draftMigrationFixture(manifest: readonly string[]) {
  const env = await processorFixture({
    offline: true,
    pageCount: 51,
    sourcePdf: syntheticLongPdf(),
    pageText: (page, text) => `${text}\n\nSynthetic page ${page}.`,
  });
  try {
    env.setResources([
      {
        reference: "images/migration.png",
        content: {
          bytes: imageBytes,
          artifact: {
            sha256: await sha256(imageBytes),
            byte_size: imageBytes.length,
            media_type: "image/png",
          },
        },
      },
    ]);
    env.setText(
      "A synthetic finding.\n\n![Synthetic diagram](images/migration.png)",
    );
    const fixed = await buildFrozenV16(env);
    const described = await env.app.documentRead.describe({
      document_version_id: fixed.document_version_id,
    });
    const document = described.document;
    const state = await env.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "draft-migration-result",
      name: "Synthetic migration result",
      processor: { id: "summary", version: "2" },
      spec: {},
      inputs: [
        { kind: "literature", literature_id: env.parseRequest.literature_id },
      ],
    });
    if (state.failures.length)
      throw new Error(
        `Synthetic migration result did not publish: ${JSON.stringify(state.failures)}`,
      );
    await env.app.marks.manage({
      operation: "create",
      request: {
        literature_id: env.parseRequest.literature_id,
        kind: "region",
        color: "purple",
        note: "Synthetic migration note #fixture",
        pdf: {
          sha256: env.asset.sha256,
          page: 1,
          rects: [[40, 40, 100, 20]],
        },
      },
    });
    await env.app.maintenance!.refreshIndex!();
    await env.app.close();

    const source = join(env.home, "catalog.sqlite");
    const path = join(env.home, "frozen-v16.sqlite");
    const db = new DatabaseSync(path);
    try {
      db.prepare("ATTACH DATABASE ? AS fixture_source").run(source);
      db.exec("PRAGMA foreign_keys=OFF;BEGIN");
      // Do not replay fact invalidation while constructing the historic input.
      for (const sql of manifest)
        if (!sql.startsWith("CREATE TRIGGER ")) db.exec(sql);
      const names = manifest.flatMap((sql) => {
        const match = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/u.exec(
          sql,
        );
        return match ? [match[1]!] : [];
      });
      for (const name of names) {
        if (name === "schema_identity") {
          db.prepare(
            "INSERT INTO schema_identity SELECT singleton,product,16,?,created_at FROM fixture_source.schema_identity",
          ).run(
            createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
          );
          continue;
        }
        const columns = db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((row) => String(row.name));
        if (columns.some((column) => !/^[a-z_][a-z0-9_]*$/u.test(column)))
          throw new Error("Invalid synthetic schema column");
        const rowid = manifest.some((sql) =>
          sql.startsWith(`CREATE VIRTUAL TABLE ${name} `),
        )
          ? "rowid,"
          : "";
        const list = rowid + columns.join(",");
        db.exec(
          `INSERT INTO ${name}(${list}) SELECT ${list} FROM fixture_source.${name}`,
        );
      }
      for (const sql of manifest)
        if (sql.startsWith("CREATE TRIGGER ")) db.exec(sql);
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Synthetic schema-16 fixture violates foreign keys");
      db.exec("COMMIT;DETACH DATABASE fixture_source;PRAGMA foreign_keys=ON");
      return {
        env,
        path,
        document,
        longDocument: described.long_document,
        counts: offlineTableCounts(db),
        close: () => env.close(),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    await env.close();
    throw error;
  }
}
