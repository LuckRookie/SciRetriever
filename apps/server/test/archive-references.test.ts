import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { randomUUID } from "node:crypto";
import { parseMetadataObservation } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
async function preparedReferences() {
  const e = await coreProcessingFixture({ analysisModel: false });
  try {
    e.setText(
      "# Introduction\n\nA synthetic paper.\n\n# References\n\n[1] Unmatched. doi:10.1234/missing\n\n[2] Linked. doi:10.1234/linked\n",
    );
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const proof = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const document = (
      await e.app.proofreadDocuments.publish({
        literature_id: e.rawParseRequest.literature_id,
        asset_id: e.asset.asset_id,
        proofread_id: proof.version.proofread_id,
        expected_default_revision: null,
      })
    ).document;
    const annotation = await e.app.structureAnnotations!.build({
      document_version_id: document.document_version_id,
      max_prefix_characters: 64,
    });
    const original = (
      await e.app.library.detail(e.rawParseRequest.literature_id)
    ).literature;
    const target = parseLiterature({
      ...original,
      literature_id: "00000000-0000-4000-8000-000000009991",
      meta_literature_id: "00000000-0000-4000-8000-000000009992",
      metadata: {
        ...original.metadata,
        title: "Linked synthetic target",
        identifiers: [{ namespace: "doi", value: "10.1234/linked" }],
      },
    });
    await e.app.database.putLiterature(target);
    const request = {
      literature_id: original.literature_id,
      document_version_id: document.document_version_id,
      annotation_id: annotation.annotation_id,
    };
    return { e, document, annotation, original, target, request };
  } catch (error) {
    await e.close();
    throw error;
  }
}
it("publishes a relation with its first archive support, hides stale evidence and cleans orphaned edges on rebuild", async () => {
  const { e, document, annotation, target, request } =
    await preparedReferences();
  try {
    expect(await e.app.archiveReferences.build(request)).toMatchObject({
      total: 2,
      linked: 1,
      unmatched: [{ reference_index: 0 }],
    });
    const snapshot = await e.app.database.referenceSnapshot();
    const edge = snapshot.find(
      (r) => r.reference.target_literature_id === target.literature_id,
    )!;
    expect(edge.supports).toMatchObject([
      {
        kind: "archive_reference_text",
        document_version_id: document.document_version_id,
        reference_index: 1,
      },
    ]);
    const detail = await e.app.library.referenceDetail(
      edge.reference.reference_id,
    );
    expect(detail.supports[0]?.source.kind).toBe("archive_reference_text");
    const store = new SqliteAnnotationStorage(e.app.database, e.app.files);
    const fixed = (await store.byId(annotation.annotation_id))!;
    const references = fixed.sections.find((s) => s.role === "references")!;
    const updated = await e.app.structureAnnotations!.setRole({
      document_version_id: document.document_version_id,
      section_id: references.section_id,
      role: "body",
      expected_manual_revision: 0,
      actor: "synthetic-test",
    });
    expect(await e.app.database.referenceSnapshot()).toEqual([]);
    expect((await store.byId(annotation.annotation_id))?.references).toEqual(
      fixed.references,
    );
    expect(
      await e.app.archiveReferences.build({
        ...request,
        annotation_id: updated.annotation_id,
      }),
    ).toMatchObject({ linked: 0 });
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      expect(
        db
          .prepare("SELECT count(*) n FROM archive_reference_text_supports")
          .get()?.n,
      ).toBe(0);
      expect(
        db.prepare("SELECT count(*) n FROM literature_references").get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await e.close();
  }
});

it("rolls back new edges and source support replacement when a target CAS fails", async () => {
  const { e, document, annotation, original, target, request } =
    await preparedReferences();
  try {
    await e.app.archiveReferences.build(request);
    const baseline = await e.app.database.referenceSnapshot();
    const another = parseLiterature({
      ...target,
      literature_id: "00000000-0000-4000-8000-000000009993",
      meta_literature_id: "00000000-0000-4000-8000-000000009994",
      metadata: {
        ...target.metadata,
        identifiers: [{ namespace: "doi", value: "10.1234/another" }],
      },
    });
    await e.app.database.putLiterature(another);
    const detail = await e.app.library.detail(another.literature_id);
    const fixed = (await new SqliteAnnotationStorage(
      e.app.database,
      e.app.files,
    ).byId(annotation.annotation_id))!;
    await expect(
      e.app.database.run({
        kind: "archive_reference_publish",
        publication: {
          literature_id: original.literature_id,
          document_version_id: document.document_version_id,
          annotation_id: annotation.annotation_id,
          expected_default_revision: (await e.app.database.documentVersion(
            document.document_version_id,
          ))!.default_revision!,
          links: [
            {
              reference: fixed.references[0]!,
              target_literature_id: another.literature_id,
              target_metadata_revision: detail.metadata_revision,
              target_metadata_sha256: detail.metadata_sha256,
              basis: "doi",
            },
            {
              reference: fixed.references[1]!,
              target_literature_id: target.literature_id,
              target_metadata_revision: 999,
              target_metadata_sha256: "0".repeat(64),
              basis: "doi",
            },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(await e.app.database.referenceSnapshot()).toEqual(baseline);
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      expect(
        db.prepare("SELECT count(*) n FROM literature_references").get()?.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await e.close();
  }
});
it("preserves a relation supported by metadata when obsolete archive support is removed", async () => {
  const { e, document, annotation, original, request } =
    await preparedReferences();
  try {
    await e.app.archiveReferences.build(request);
    const edge = (await e.app.database.referenceSnapshot())[0]!;
    const observation = parseMetadataObservation({
      observation_id: randomUUID(),
      source_type: null,
      source_type_mapping_version: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "bibliographic-import",
        source_record_id: null,
        observed_at: "2026-10-20T00:00:00Z",
        input_sha256: null,
        parameters_sha256: null,
      },
      metadata: original.metadata,
      version_role: null,
      version_links: [],
      declared_keywords: [],
      reference_texts: ["Linked synthetic target"],
      reference_count: null,
      cited_by_count: null,
      asset_hints: [],
    });
    await e.app.observations.publish({
      ...observation,
      literature_id: original.literature_id,
    });
    await e.app.references.supportWithMetadataReferenceText(
      edge.reference.reference_id,
      observation.observation_id,
      0,
    );
    const fixed = (await new SqliteAnnotationStorage(
      e.app.database,
      e.app.files,
    ).byId(annotation.annotation_id))!;
    const updated = await e.app.structureAnnotations!.setRole({
      document_version_id: document.document_version_id,
      section_id: fixed.sections.find((s) => s.role === "references")!
        .section_id,
      role: "body",
      expected_manual_revision: 0,
      actor: "synthetic-test",
    });
    await e.app.archiveReferences.build({
      ...request,
      annotation_id: updated.annotation_id,
    });
    const remaining = await e.app.database.referenceSnapshot();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.reference.reference_id).toBe(
      edge.reference.reference_id,
    );
    expect(remaining[0]?.supports).toMatchObject([
      { kind: "metadata_reference_text" },
    ]);
    expect(e.modelCalls).toBe(0);
  } finally {
    await e.close();
  }
});

it("uses the same explicit reference owner through CLI and MCP", async () => {
  const { e, request } = await preparedReferences();
  const server = createMcpServer({
    home: e.home,
    maintenance: true,
    applicationFactory: async () => e.app,
    queryFactory: () => createQueryApplication(e.home),
  });
  const client = new Client({ name: "archive-reference-test", version: "1" });
  try {
    async function* stdin() {
      yield Buffer.from(JSON.stringify(request));
    }
    const cli = await runCli(
      ["literature", "resolve-references", "--request", "-", "--json"],
      { home: e.home, stdin: stdin() },
    );
    expect(cli.code, JSON.stringify(cli)).toBe(0);
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    const result = await client.callTool({
      name: "archive_references",
      arguments: request,
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toEqual(cli.value);
    expect(await e.app.database.referenceSnapshot()).toHaveLength(1);
    expect(e.modelCalls).toBe(0);
  } finally {
    await client.close();
    await server.close();
    await e.close();
  }
});
