import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  parseAnalysisInputIdentity,
  parseLiterature,
  parseReference,
  parseAsset,
  type LiteratureDetail,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { LiteratureCleanupService } from "../src/literature/cleanup.js";
import { setup, proposal, id, lit } from "./content-fixture.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
function decision(d: LiteratureDetail) {
  return {
    outcome: "no_usable_content" as const,
    input: parseAnalysisInputIdentity({
      literature_id: lit,
      primary_asset_id: d.primary_pdf!.asset.asset_id,
      primary_pdf_sha256: d.primary_pdf!.asset.sha256,
      parser_result_sha256: d.parser_result!.result_sha256,
      input_metadata_revision: d.metadata_revision,
      input_metadata_sha256: d.metadata_sha256,
    }),
  };
}
async function environment(content = true) {
  const env = await setup();
  if (content) {
    const p = await proposal(await env.app.library.detail(lit));
    await env.app.literatureContent.accept(p.value, p.bytes);
  }
  return env;
}
it.each([false, true])(
  "atomically retires the exact current PDF/Parser closure with content=%s and retains metadata across restart",
  async (content) => {
    const env = await environment(content);
    let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const before = await env.app.library.detail(lit),
        input = decision(before);
      const result = await env.app.literatureCleanup.cleanup(input);
      expect(result.outcome).toBe("catalog_cleaned");
      expect(result.retired_artifacts).toHaveLength(content ? 4 : 2);
      for (const a of result.retired_artifacts) {
        expect(await env.app.database.locateArtifact(a.artifact)).toBeNull();
        // Physical reclamation is separate from this short, all-or-nothing catalog transaction.
        expect(
          (await env.app.files.read(a.reference, a.artifact.byte_size)).length,
        ).toBe(a.artifact.byte_size);
      }
      const after = await env.app.library.detail(lit);
      expect(after.primary_pdf).toBeNull();
      expect(after.parser_result).toBeNull();
      expect(after.content).toBeNull();
      expect(after.literature.metadata).toEqual(before.literature.metadata);
      expect(after.metadata_revision).toBe(before.metadata_revision);
      expect(after.metadata_sha256).toBe(before.metadata_sha256);
      const counts = await env.app.database.snapshotCounts();
      expect(counts.tables.assets).toBe(0);
      expect(counts.tables.parser_results).toBe(0);
      expect(counts.tables.literature_contents).toBe(0);
      await expect(
        env.app.literatureCleanup.cleanup(input),
      ).rejects.toMatchObject({ code: "content-cleanup-stale" });
      await env.app.close();
      reopened = await createApplication(env.home);
      expect(await reopened.library.detail(lit)).toEqual(after);
    } finally {
      await reopened?.close();
      await env.close();
    }
  },
);
it.each([
  "parser_results",
  "literature_assets",
  "artifact_objects",
  "provenances",
])("rolls back the entire cleanup when %s deletion fails", async (table) => {
  const env = await environment();
  const raw = new DatabaseSync(join(env.home, "catalog.sqlite"));
  try {
    const before = await env.app.library.detail(lit),
      counts = await env.app.database.snapshotCounts();
    raw.exec(
      `CREATE TRIGGER cleanup_fail BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END`,
    );
    await expect(
      env.app.literatureCleanup.cleanup(decision(before)),
    ).rejects.toMatchObject({ code: "content-cleanup-storage" });
    expect(await env.app.library.detail(lit)).toEqual(before);
    expect(await env.app.database.snapshotCounts()).toEqual(counts);
    expect(
      raw
        .prepare(
          "SELECT content_body FROM literature_search_fts WHERE literature_id=?",
        )
        .get(lit)?.content_body,
    ).toContain("spectroscopy");
  } finally {
    raw.close();
    await env.close();
  }
});
it.each(["fts", "metadata", "parser"])(
  "rejects a changed %s snapshot immediately before the cleanup transaction",
  async (kind) => {
    const env = await environment(false);
    const raw = new DatabaseSync(join(env.home, "catalog.sqlite"));
    try {
      const before = await env.app.library.detail(lit),
        counts = await env.app.database.snapshotCounts();
      const service = new LiteratureCleanupService(
        {
          contentCleanupSnapshot: (id) =>
            env.app.database.contentCleanupSnapshot(id),
          cleanupNoUsableContent: async (command) => {
            if (kind === "fts")
              raw
                .prepare(
                  "UPDATE literature_search_fts SET content_body='concurrent'",
                )
                .run();
            if (kind === "metadata")
              raw
                .prepare(
                  "UPDATE literature_metadata SET metadata_revision=metadata_revision+1",
                )
                .run();
            if (kind === "parser")
              raw
                .prepare("UPDATE parser_results SET result_sha256=?")
                .run("0".repeat(64));
            return env.app.database.cleanupNoUsableContent(command);
          },
        },
        env.app.files,
      );
      await expect(service.cleanup(decision(before))).rejects.toMatchObject({
        code: "content-cleanup-stale",
      });
      expect(await env.app.database.snapshotCounts()).toEqual(counts);
      expect(
        raw
          .prepare(
            "SELECT asset_id FROM literature_assets WHERE literature_id=?",
          )
          .get(lit)?.asset_id,
      ).toBe(before.primary_pdf!.asset.asset_id);
    } finally {
      raw.close();
      await env.close();
    }
  },
);
it("rejects invalid decisions, stale identity, cancelled cleanup and corrupted FTS before any deletion", async () => {
  const env = await environment();
  const raw = new DatabaseSync(join(env.home, "catalog.sqlite"));
  try {
    const before = await env.app.library.detail(lit),
      value = decision(before),
      counts = await env.app.database.snapshotCounts();
    await expect(
      env.app.literatureCleanup.cleanup({
        ...value,
        outcome: "analysis_failed",
      }),
    ).rejects.toMatchObject({ code: "content-cleanup-input" });
    await expect(
      env.app.literatureCleanup.cleanup({
        ...value,
        input: { ...value.input, primary_pdf_sha256: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "content-cleanup-stale" });
    await expect(
      env.app.literatureCleanup.cleanup(value, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "content-cleanup-cancelled" });
    raw.exec("UPDATE literature_search_fts SET title='corrupted'");
    await expect(
      env.app.literatureCleanup.cleanup(value),
    ).rejects.toMatchObject({ code: "content-cleanup-integrity" });
    expect(await env.app.database.snapshotCounts()).toEqual(counts);
  } finally {
    raw.close();
    await env.close();
  }
});
it("preserves shared files and other reference evidence while removing supports belonging to the retired content", async () => {
  const env = await environment();
  try {
    const { app } = env;
    const before = await app.library.detail(lit);
    for (const n of [3, 4])
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Target ${n}`,
            identifiers: [{ namespace: "doi", value: `10.5555/ref.${n}` }],
          },
        }),
      );
    for (const n of [3, 4]) {
      await app.references.publish(
        parseReference({
          reference_id: id(100 + n),
          source_literature_id: lit,
          target_literature_id: id(n),
        }),
      );
      await app.references.supportWithContentReferenceText(
        id(100 + n),
        before.content!.literature_content_sha256,
        0,
      );
    }
    await app.observations.publish({
      observation_id: id(80),
      literature_id: lit,
      provenance: {
        provenance_id: id(81),
        source_kind: "metadata-provider",
        source_name: "fixture",
        source_record_id: "source",
        observed_at: "2026-09-10T00:00:00Z",
        input_sha256: "a".repeat(64),
        parameters_sha256: null,
      },
      version_role: "published",
      metadata: FIXTURE_LITERATURE.metadata,
      declared_keywords: [],
      reference_texts: ["Source evidence"],
      reference_count: null,
      cited_by_count: null,
    });
    await app.references.supportWithMetadataReferenceText(id(104), id(80), 0);
    await app.database.putLiteratureAsset({
      literature_asset_id: id(70),
      literature_id: parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(3),
      }).literature_id,
      asset: before.primary_pdf!.asset,
      role: "supplementary-pdf",
      source_url: null,
      provenance: before.primary_pdf!.literature_asset.provenance,
    });
    const parser = before.parser_result!.markdown;
    const located = await app.database.locateArtifact(parser);
    if (!located) throw new Error("fixture missing parser artifact");
    await app.database.putLiteratureAsset({
      literature_asset_id: id(71),
      literature_id: parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(3),
      }).literature_id,
      asset: parseAsset({
        asset_id: id(72),
        sha256: parser.sha256,
        size_bytes: parser.byte_size,
        media_type: parser.media_type,
        path: located.reference,
      }),
      role: "supplementary",
      source_url: null,
      provenance: before.primary_pdf!.literature_asset.provenance,
    });
    const result = await app.literatureCleanup.cleanup(
      decision(await app.library.detail(lit)),
    );
    expect(result.retired_artifacts).toHaveLength(2);
    expect(
      await app.database.getAsset(before.primary_pdf!.asset.asset_id),
    ).toEqual(before.primary_pdf!.asset);
    expect(await app.database.locateArtifact(parser)).not.toBeNull();
    const refs = await app.library.references({
      literature_id: lit,
      direction: "references",
    });
    expect(refs.items.map((r) => r.reference.reference_id)).toEqual([id(104)]);
    expect(
      (await app.library.referenceDetail(id(104))).supports.map(
        (s) => s.source.kind,
      ),
    ).toEqual(["metadata_reference_text"]);
  } finally {
    await env.close();
  }
});
it("rejects an incomplete outgoing reference closure and concurrent cleanup admits only one transaction", async () => {
  const env = await environment();
  const raw = new DatabaseSync(join(env.home, "catalog.sqlite"));
  try {
    await env.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(3),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Target",
          identifiers: [{ namespace: "doi", value: "10.5555/target" }],
        },
      }),
    );
    await env.app.references.publish(
      parseReference({
        reference_id: id(103),
        source_literature_id: lit,
        target_literature_id: id(3),
      }),
    );
    const value = decision(await env.app.library.detail(lit));
    await expect(
      env.app.literatureCleanup.cleanup(value),
    ).rejects.toMatchObject({ code: "content-cleanup-integrity" });
    raw
      .prepare("DELETE FROM literature_references WHERE reference_id=?")
      .run(id(103));
    const results = await Promise.allSettled([
      env.app.literatureCleanup.cleanup(value),
      env.app.literatureCleanup.cleanup(value),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await env.app.library.detail(lit)).primary_pdf).toBeNull();
  } finally {
    raw.close();
    await env.close();
  }
});
it("refuses to retire an Asset-scoped Parser that supports another Literature's current content", async () => {
  const env = await environment();
  try {
    const first = await env.app.library.detail(lit);
    const other = parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: id(3),
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title: "Other version",
        identifiers: [{ namespace: "doi", value: "10.5555/other" }],
      },
    });
    await env.app.database.putLiterature(other);
    await env.app.database.putLiteratureAsset({
      literature_asset_id: id(70),
      literature_id: other.literature_id,
      asset: first.primary_pdf!.asset,
      role: "primary-pdf",
      source_url: null,
      provenance: first.primary_pdf!.literature_asset.provenance,
    });
    const p = await proposal(
      await env.app.library.detail(other.literature_id),
      45,
      "Other content",
      ["other"],
    );
    await env.app.literatureContent.accept(p.value, p.bytes);
    const before = await env.app.library.detail(lit),
      beforeOther = await env.app.library.detail(other.literature_id);
    await expect(
      env.app.literatureCleanup.cleanup(decision(before)),
    ).rejects.toMatchObject({ code: "content-cleanup-stale" });
    expect(await env.app.library.detail(lit)).toEqual(before);
    expect(await env.app.library.detail(other.literature_id)).toEqual(
      beforeOther,
    );
  } finally {
    await env.close();
  }
});
