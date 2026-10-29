import { stageLegacyRawParse } from "../src/parsing/legacy-raw.js";
import { SqliteRawParseStorage } from "../src/storage/raw-parsing.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  parseAsset,
  parseLiterature,
  parseMetadataObservation,
  parseParserResult,
  parseProvenance,
  parseReference,
  parserResultSha256,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it("opens literature detail from one catalog snapshot and verifies artifact and metadata identities", async () => {
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
      source_type: null,
      source_type_mapping_version: null,
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
      app.observations.publish({
        ...observation,
        literature_id: literatureId,
      }),
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
    await app.observations.publish({
      ...older,
      literature_id: literatureId,
    });
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
      "# Synthetic parser\nCafe\u0301 content\n![one](assets/😀.png) ![two](assets/\uffff.png)\n",
    );
    const parserArtifact = await publish("objects/parser.md", parserBytes);
    const resourceBytes = Buffer.from("89504e470d0a1a0a00", "hex");
    const resource = {
      ...(await publish("objects/resource.png", resourceBytes)),
      media_type: "image/png",
    };
    const parserCore = {
      source_asset_id: asset.asset_id,
      source_sha256: asset.sha256,
      page_count: 1,
      markdown: { ...parserArtifact, media_type: "text/markdown" },
      resources: [
        { reference: "assets/😀.png", artifact: resource },
        { reference: "assets/\uffff.png", artifact: resource },
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
    const raw = await stageLegacyRawParse(parser, async (a) =>
      a.sha256 === parser.markdown.sha256 ? parserBytes : resourceBytes,
    );
    await new SqliteRawParseStorage(app.database, app.files).publish(raw);
    expect(await app.database.rawParse("current", asset.asset_id)).toHaveLength(
      1,
    );
    const detail = await app.library.detail(literatureId);
    expect(detail).not.toHaveProperty("content");
    expect(detail.literature.status).toBe("ASSET_READY");
    expect(detail.missing_step).toBe("arrange");
    expect(detail.primary_pdf?.asset).toEqual(asset);
    for (const artifact of [
      detail.primary_pdf!.asset,
      parser.markdown,
      ...parser.resources.map((resource) => resource.artifact),
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
    expect(Object.isFrozen(detail.literature.metadata)).toBe(true);
    const original = app.database.literatureDetailSnapshot.bind(app.database);
    vi.spyOn(app.database, "literatureDetailSnapshot").mockImplementationOnce(
      async (id) => {
        const snapshot = await original(id);
        await app.observations.publish({
          ...observation,
          observation_id:
            id === literatureId ? "00000000-0000-0000-0000-000000000060" : id,
          literature_id: literatureId,
          provenance: provenance(61),
        });
        return snapshot;
      },
    );
    expect(await app.library.detail(literatureId)).toEqual(detail);
    expect(
      (await app.library.detail(literatureId)).metadata_observations,
    ).toHaveLength(3);
    vi.spyOn(app.database, "literatureDetailSnapshot").mockImplementationOnce(
      async (id) => {
        const captured = await original(id);
        return {
          detail: {
            ...(captured!.detail as Record<string, unknown>),
            metadata_sha256: "0".repeat(64),
          },
        };
      },
    );
    await expect(app.library.detail(literatureId)).rejects.toMatchObject({
      code: "literature-query",
    });
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
