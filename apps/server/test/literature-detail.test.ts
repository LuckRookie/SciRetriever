import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseAsset,
  parseLiterature,
  parseMetadataObservation,
  parseParserResult,
  parseProvenance,
  parseReference,
  parserResultSha256,
  parseLiteratureContent,
  literatureContentSha256,
  contentCanonicalJsonBytes,
  sha256,
  type LiteratureSection,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { LiteratureQueryService } from "../src/literature/query.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it("opens a complete literature detail from one catalog snapshot and verifies canonical structured content against immutable bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-detail-"));
  const app = await createApplication(home);
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const literatureId = FIXTURE_LITERATURE.literature_id;
    await expect(app.library.detail(id(999))).rejects.toMatchObject({
      code: "literature-not-found",
    });
    expect((await app.library.detail(literatureId)).primary_pdf).toBeNull();
    await app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(3),
        version_role: "preprint",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Synthetic preprint",
          identifiers: [{ namespace: "doi", value: "10.5555/detail.preprint" }],
        },
      }),
    );
    const provenance = (n: number) => ({
      provenance_id: id(n),
      source_kind: "metadata-provider" as const,
      source_name: "fixture",
      source_record_id: `record-${n}`,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    });
    const observation = parseMetadataObservation({
      observation_id: id(20),
      provenance: provenance(21),
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title: "Source title differs from current title",
      },
      version_role: "published",
      version_links: [
        {
          record_id: "preprint-record",
          identifiers: [{ namespace: "doi", value: "10.5555/detail.preprint" }],
        },
      ],
      asset_hints: [
        {
          url: "https://fixture.example.test/paper.pdf",
          kind: "direct-file",
          media_type: "application/pdf",
          asset_role: "primary-pdf",
          version_role: "published",
          access_status: "open",
          license: null,
        },
      ],
      reference_texts: ["Synthetic source\nreference"],
      declared_keywords: ["source keyword"],
      reference_count: 500,
      cited_by_count: 400,
    });
    await app.observations.publish({
      ...observation,
      literature_id: literatureId,
    });
    await expect(
      app.observations.publish({ ...observation, literature_id: literatureId }),
    ).resolves.toBe(true);
    await expect(
      app.observations.publish({
        ...observation,
        literature_id: literatureId,
        asset_hints: [],
      }),
    ).rejects.toThrow();
    await expect(
      app.observations.publish({
        ...observation,
        literature_id: literatureId,
        metadata: { ...observation.metadata, title: "Overwritten source" },
      }),
    ).rejects.toThrow();
    const older = parseMetadataObservation({
      ...observation,
      observation_id: id(19),
      provenance: { ...provenance(22), observed_at: "2026-09-09T00:00:00Z" },
    });
    await app.observations.publish({ ...older, literature_id: literatureId });
    const before = await app.library.detail(literatureId);
    expect(before.metadata_observations).toEqual([observation, older]);
    expect(before.literature.metadata.title).toBe(
      FIXTURE_LITERATURE.metadata.title,
    );
    expect(
      before.other_versions.map((item) => item.literature.literature_id),
    ).toEqual([id(3)]);
    expect(before.reference_count).toBe(0);
    await app.references.publish(
      parseReference({
        reference_id: id(50),
        source_literature_id: literatureId,
        target_literature_id: id(3),
      }),
    );
    await app.references.supportWithMetadataReferenceText(id(50), id(20), 0);
    expect((await app.library.detail(id(3))).cited_by_count).toBe(1);
    const publish = async (path: string, bytes: Uint8Array) => {
      const stage = await app.files.stage({ maxBytes: bytes.length });
      await stage.write(bytes);
      await app.files.publish(stage, path);
      return { sha256: await sha256(bytes), byte_size: bytes.length };
    };
    const pdf = await publish("objects/source.pdf", workbenchPdf());
    const asset = parseAsset({
      asset_id: id(30),
      sha256: pdf.sha256,
      size_bytes: pdf.byte_size,
      media_type: "application/pdf",
      path: "objects/source.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(31),
      literature_id: literatureId,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: { ...provenance(32), source_kind: "asset-provider" },
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(51),
      literature_id: literatureId,
      asset,
      role: "supplementary-pdf",
      source_url: null,
      provenance: { ...provenance(52), source_kind: "asset-provider" },
    });
    const parserBytes = new TextEncoder().encode(
      "# Synthetic parser\nCafe\u0301 content\n[one](assets/😀.txt) [two](assets/\uffff.txt)\n",
    );
    const parserArtifact = await publish("objects/parser.md", parserBytes);
    const resource = {
      ...(await publish(
        "objects/resource.txt",
        new TextEncoder().encode("synthetic resource"),
      )),
      media_type: "text/plain",
    };
    const parserCore = {
      source_asset_id: asset.asset_id,
      source_sha256: asset.sha256,
      page_count: 1,
      markdown: { ...parserArtifact, media_type: "text/markdown" },
      resources: [
        { reference: "assets/😀.txt", artifact: resource },
        { reference: "assets/\uffff.txt", artifact: resource },
      ],
      provenance: {
        provenance: parseProvenance({
          ...provenance(34),
          source_kind: "parser",
          source_record_id: null,
          input_sha256: asset.sha256,
          parameters_sha256: "b".repeat(64),
        }),
        parser_version: "fixture-1",
        mode: null,
        model_identity: null,
      },
    };
    const parser = await parseParserResult({
      ...parserCore,
      result_sha256: await parserResultSha256(parserCore),
    });
    for (const invalid of [
      { ...parser, page_count: 0 },
      { ...parser, result_sha256: "0".repeat(64) },
      {
        ...parser,
        provenance: { ...parser.provenance, parser_version: "/tmp/private" },
      },
      {
        ...parser,
        provenance: {
          ...parser.provenance,
          provenance: {
            ...parser.provenance.provenance,
            input_sha256: "0".repeat(64),
          },
        },
      },
      {
        ...parser,
        resources: [{ reference: "../escape.png", artifact: parser.markdown }],
      },
      {
        ...parser,
        resources: [
          { reference: "a.png", artifact: parser.markdown },
          { reference: "a.png", artifact: parser.markdown },
        ],
      },
      { ...parser, debug: true },
    ])
      await expect(parseParserResult(invalid)).rejects.toThrow();
    await app.database.putParserResult({
      source_asset_id: asset.asset_id,
      source_sha256: asset.sha256,
      result_sha256: parser.result_sha256,
      page_count: 1,
      markdown_artifact_id: id(33),
      markdown_artifact_path: "objects/parser.md",
      markdown_sha256: parser.markdown.sha256,
      markdown_byte_size: parser.markdown.byte_size,
      markdown_media_type: "text/markdown",
      provenance: parser.provenance.provenance,
      parser_version: parser.provenance.parser_version,
      mode: null,
      model_identity: null,
      resources: parser.resources.map((r) => ({
        reference: r.reference,
        artifact_id: id(35),
        artifact_path: "objects/resource.txt",
        artifact_sha256: resource.sha256,
        artifact_byte_size: resource.byte_size,
        artifact_media_type: resource.media_type,
      })),
    });
    expect((await app.library.detail(literatureId)).parser_result).toEqual(
      parser,
    );
    const markdown = {
      ...(await publish(
        "objects/content.md",
        new TextEncoder().encode("# Synthetic content\n"),
      )),
      media_type: "text/markdown",
    };
    const sections: readonly LiteratureSection[] = [
      "background-and-objectives",
      "methods",
      "data",
      "conclusions-and-limitations",
    ].map((role) => ({
      role: role as LiteratureSection["role"],
      title: null,
      markdown: role === "data" ? "未提供" : "Synthetic Cafe\u0301\nparagraph.",
      subsections: [],
    }));
    const metadata = (await app.database.currentFacts(literatureId))!
      .metadata_snapshot;
    const inputHash = await sha256(
      contentCanonicalJsonBytes({
        metadata_sha256: metadata.sha256,
        parser_result_sha256: parser.result_sha256,
        primary_pdf_sha256: asset.sha256,
        schema: "sciretriever-literature-content-input-v1",
      }),
    );
    const contentCore = {
      metadata_sha256: metadata.sha256,
      sections,
      references: ["Synthetic reference"],
    };
    const content = await parseLiteratureContent({
      ...contentCore,
      literature_content_sha256: await literatureContentSha256(contentCore),
      metadata_revision: metadata.revision,
      markdown,
      provenance: {
        ...provenance(40),
        source_kind: "analysis",
        source_record_id: null,
        input_sha256: inputHash,
        parameters_sha256: "c".repeat(64),
      },
    });
    const bytes = contentCanonicalJsonBytes(content);
    for (const invalid of [
      { ...content, sections: content.sections.slice(1) },
      { ...content, sections: [...content.sections, content.sections[0]] },
      {
        ...content,
        sections: content.sections.map((s, i) =>
          i === 0 ? { ...s, markdown: " 未提供 " } : s,
        ),
      },
      {
        ...content,
        sections: content.sections.map((s, i) =>
          i === 0 ? { ...s, title: "Changed fixed title" } : s,
        ),
      },
      {
        ...content,
        sections: [
          ...content.sections,
          {
            role: "additional",
            title: "元数据",
            markdown: "Reserved",
            subsections: [],
          },
        ],
      },
      { ...content, references: ["未提供"] },
      { ...content, markdown: { ...content.markdown, byte_size: 0 } },
      {
        ...content,
        provenance: { ...content.provenance, parameters_sha256: null },
      },
      { ...content, literature_content_sha256: "0".repeat(64) },
    ])
      await expect(parseLiteratureContent(invalid)).rejects.toThrow();
    const structured = await publish("objects/content.json", bytes);
    const binding = {
      literature_id: literatureId,
      literature_content_sha256: content.literature_content_sha256,
      metadata_revision: metadata.revision,
      metadata_sha256: metadata.sha256,
      primary_asset_id: asset.asset_id,
      primary_asset_sha256: asset.sha256,
      parser_result_sha256: parser.result_sha256,
      structured_artifact_id: id(41),
      structured_artifact_path: "objects/content.json",
      structured_artifact_sha256: structured.sha256,
      structured_artifact_byte_size: structured.byte_size,
      structured_artifact_media_type: "application/json",
      markdown_artifact_id: id(42),
      markdown_artifact_path: "objects/content.md",
      markdown_artifact_sha256: markdown.sha256,
      markdown_artifact_byte_size: markdown.byte_size,
      markdown_artifact_media_type: "text/markdown" as const,
      provenance: content.provenance,
      reference_texts: content.references,
    };
    await app.database.putLiteratureContent(binding);
    const detail = await app.library.detail(literatureId);
    expect(detail.content).toEqual(content);
    expect(detail.literature.status).toBe("CONTENT_READY");
    expect(detail.missing_step).toBeNull();
    expect(detail.primary_pdf?.asset).toEqual(asset);
    for (const artifact of [
      detail.primary_pdf!.asset,
      detail.parser_result!.markdown,
      ...detail.parser_result!.resources.map((resource) => resource.artifact),
      detail.content!.markdown,
    ]) {
      const actual = await app.literatureArtifacts.withArtifact(
        artifact,
        async (chunks) => {
          const data: Uint8Array[] = [];
          for await (const chunk of chunks) data.push(chunk);
          return sha256(Buffer.concat(data));
        },
      );
      expect(actual).toBe(artifact.sha256);
    }
    expect(detail.reference_count).toBe(1);
    expect(detail.additional_assets[0]?.literature_asset.role).toBe(
      "supplementary-pdf",
    );
    expect(JSON.stringify(detail)).not.toContain(home);
    expect(Object.isFrozen(detail.content?.sections[0])).toBe(true);
    await expect(
      app.database.putLiteratureContent({ ...binding, metadata_revision: 2 }),
    ).rejects.toThrow();
    expect(await app.library.detail(literatureId)).toEqual(detail);
    expect(await parserResultSha256(parserCore)).toBe(parser.result_sha256);
    expect(Buffer.from(contentCanonicalJsonBytes(content))).toEqual(
      Buffer.from(bytes),
    );
    expect(detail.literature.literature_id).toBe(literatureId);
    // Change the catalog after its snapshot, during the immutable artifact read.
    // The response must retain the old complete metadata/content binding.
    const concurrent = new LiteratureQueryService(app.database, {
      read: async (reference, maxBytes) => {
        await app.observations.publish({
          ...observation,
          observation_id: id(60),
          literature_id: literatureId,
          provenance: provenance(61),
        });
        return app.files.read(reference, maxBytes);
      },
    });
    await expect(concurrent.detail(literatureId)).resolves.toEqual(detail);
    expect(
      (await app.library.detail(literatureId)).metadata_observations,
    ).toHaveLength(3);
    await writeFile(
      join(app.files.root, "objects/content.json"),
      new Uint8Array(bytes.length).fill(32),
    );
    await expect(app.library.detail(literatureId)).rejects.toMatchObject({
      code: "literature-query",
    });
    await rm(join(app.files.root, "objects/content.json"));
    await expect(app.library.detail(literatureId)).rejects.toThrow();
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
