import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  canonicalJsonBytes,
  parseAsset,
  parseLiterature,
  parseReference,
  sha256,
} from "@sciretriever/contracts";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { LiteratureQueryService } from "../src/literature/query.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import {
  deriveCurrentState,
  type CurrentStateEvidence,
} from "../src/literature/state.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const hash = (n: string) => n.repeat(64);

it("derives current content from its generation lineage and does not regress merely because the current parser changed", () => {
  const facts: CurrentStateEvidence = {
    metadata_revision: 1,
    metadata_sha256: hash("a"),
    primary: {
      asset_id: id(1),
      sha256: hash("b"),
      media_type: "application/pdf",
    },
    parser: { source_asset_id: id(1), source_sha256: hash("b") },
    content: {
      metadata_revision: 1,
      metadata_sha256: hash("a"),
      primary_asset_id: id(1),
      primary_asset_sha256: hash("b"),
      source_kind: "analysis",
      input_sha256: hash("c"),
      expected_input_sha256: hash("c"),
    },
  };
  expect(deriveCurrentState(facts)).toEqual({
    status: "CONTENT_READY",
    missing_step: null,
  });
  expect(deriveCurrentState({ ...facts, primary: null })).toEqual({
    status: "UNREVIEWED",
    missing_step: "primary-pdf",
  });
  expect(deriveCurrentState({ ...facts, content: null })).toEqual({
    status: "ASSET_READY",
    missing_step: "literature-content",
  });
  expect(deriveCurrentState({ ...facts, parser: null })).toEqual({
    status: "CONTENT_READY",
    missing_step: "parser-result",
  });
  expect(deriveCurrentState({ ...facts, metadata_revision: 2 }).status).toBe(
    "ASSET_READY",
  );
  expect(
    deriveCurrentState({
      ...facts,
      content: { ...facts.content!, input_sha256: hash("d") },
    }).status,
  ).toBe("ASSET_READY");
  expect(
    deriveCurrentState({
      ...facts,
      content: { ...facts.content!, source_kind: "parser" },
    }).status,
  ).toBe("ASSET_READY");
});

it("uses the same truth table in actual SQLite search snapshots and preserves accepted content after failed replacement", async () => {
  const db = new SqliteWorker();
  try {
    await db.putLiterature(FIXTURE_LITERATURE);
    const metadataSha = await sha256(
      canonicalJsonBytes(FIXTURE_LITERATURE.metadata),
    );
    const provenance = {
      provenance_id: id(10),
      source_kind: "asset-provider" as const,
      source_name: "fixture",
      source_record_id: null,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: hash("a"),
      parameters_sha256: null,
    };
    const asset = {
      asset_id: id(11),
      sha256: hash("a"),
      size_bytes: 10,
      media_type: "application/pdf",
      path: "objects/fixture.pdf",
    };
    await db.putLiteratureAsset({
      literature_asset_id: id(12),
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset: parseAsset(asset),
      role: "primary-pdf",
      provenance,
      source_url: null,
    });
    expect((await db.librarySnapshot(null))[0]?.item).toMatchObject({
      literature: { status: "ASSET_READY" },
      missing_step: "parser-result",
    });
    const parser = {
      source_asset_id: id(11),
      source_sha256: hash("a"),
      result_sha256: hash("b"),
      page_count: 1,
      markdown_artifact_id: id(13),
      markdown_artifact_path: "objects/parser.md",
      markdown_sha256: hash("c"),
      markdown_byte_size: 11,
      markdown_media_type: "text/markdown" as const,
      provenance: {
        ...provenance,
        provenance_id: id(14),
        source_kind: "parser" as const,
      },
      parser_version: "fixture",
      mode: null,
      model_identity: null,
    };
    await db.putParserResult(parser);
    expect((await db.librarySnapshot(null))[0]?.item.missing_step).toBe(
      "literature-content",
    );
    const input = createHash("sha256")
      .update(
        JSON.stringify({
          metadata_sha256: metadataSha,
          parser_result_sha256: hash("b"),
          primary_pdf_sha256: hash("a"),
          schema: "sciretriever-literature-content-input-v1",
        }),
      )
      .digest("hex");
    const content = {
      literature_id: FIXTURE_LITERATURE.literature_id,
      literature_content_sha256: hash("d"),
      metadata_revision: 1,
      metadata_sha256: metadataSha,
      primary_asset_id: id(11),
      primary_asset_sha256: hash("a"),
      parser_result_sha256: hash("b"),
      structured_artifact_id: id(15),
      structured_artifact_path: "objects/content.json",
      structured_artifact_sha256: hash("e"),
      structured_artifact_byte_size: 12,
      structured_artifact_media_type: "application/json",
      markdown_artifact_id: id(16),
      markdown_artifact_path: "objects/content.md",
      markdown_artifact_sha256: hash("f"),
      markdown_artifact_byte_size: 13,
      markdown_artifact_media_type: "text/markdown" as const,
      provenance: {
        ...provenance,
        provenance_id: id(17),
        source_kind: "analysis" as const,
        input_sha256: input,
      },
      reference_texts: ["Synthetic target reference"],
    };
    await db.putLiteratureContent(content);
    await db.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(21),
        meta_literature_id: id(22),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          identifiers: [{ namespace: "doi", value: "10.5555/state.target" }],
        },
      }),
    );
    await db.putReference(
      parseReference({
        reference_id: id(20),
        source_literature_id: FIXTURE_LITERATURE.literature_id,
        target_literature_id: id(21),
      }),
    );
    await db.putContentReferenceSupport(id(20), hash("d"), 0);
    const library = new LiteratureQueryService(db);
    const reference = await library.referenceDetail(id(20));
    expect(reference.supports).toEqual([
      {
        reference_id: id(20),
        source: {
          kind: "content_reference_text",
          literature_content_sha256: hash("d"),
          reference_index: 0,
        },
      },
    ]);
    expect(
      (await db.currentFacts(FIXTURE_LITERATURE.literature_id))?.literature
        .status,
    ).toBe("CONTENT_READY");
    expect((await db.librarySnapshot(null))[0]?.item.missing_step).toBeNull();
    await expect(
      db.putLiteratureContent({ ...content, metadata_revision: 2 }),
    ).rejects.toThrow();
    expect(await library.referenceDetail(id(20))).toEqual(reference);
    expect((await db.librarySnapshot(null))[0]?.item.literature.status).toBe(
      "CONTENT_READY",
    );
    await db.putParserResult({ ...parser, result_sha256: hash("9") });
    expect(await library.referenceDetail(id(20))).toEqual(reference);
    expect((await db.librarySnapshot(null))[0]?.item.literature.status).toBe(
      "CONTENT_READY",
    );
  } finally {
    await db.close();
  }
});
