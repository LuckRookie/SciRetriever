import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  parseLiterature,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import {
  FIXTURE_DOI,
  FIXTURE_TITLE,
  FIXTURE_LITERATURE,
} from "../src/workbench/synthetic-fixture.js";
import { ParsingFailure } from "../src/parsing/ports.js";

async function fixture(found: boolean) {
  let calls = 0;
  const f = await coreProcessingFixture({
    offline: true,
    analysisModel: false,
    metadata: {
      lookup_ports: [],
      topic_search_ports: [
        {
          provider_name: "crossref",
          open_topic_search() {
            calls++;
            let sent = false;
            return {
              pull_raw_item: () =>
                !found || sent
                  ? null
                  : ((sent = true),
                    { raw_item: {}, source_exhausted_after: true }),
              convert_raw_item: () => ({
                relations: [],
                observations: [
                  parseMetadataObservation({
                    observation_id: randomUUID(),
                    metadata: {
                      ...EMPTY_METADATA,
                      title: FIXTURE_TITLE,
                      identifiers: [{ namespace: "doi", value: FIXTURE_DOI }],
                      publication_year: 2026,
                    },
                    provenance: {
                      provenance_id: randomUUID(),
                      source_kind: "metadata-provider",
                      source_name: "crossref",
                      source_record_id: FIXTURE_DOI,
                      observed_at: "2026-11-15T00:00:00Z",
                      input_sha256: "a".repeat(64),
                      parameters_sha256: null,
                    },
                    source_type: null,
                    source_type_mapping_version: null,
                    version_role: null,
                    version_links: [],
                    declared_keywords: [],
                    reference_texts: [],
                    reference_count: null,
                    cited_by_count: null,
                    asset_hints: [],
                  }),
                ],
              }),
            };
          },
        },
      ],
    },
  });
  const lit = f.rawParseRequest.literature_id;
  await f.app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      metadata: { ...EMPTY_METADATA, title: "Temporary unrecognized title" },
    }),
  );
  await f.app.identity.observe(
    parseMetadataObservation({
      observation_id: "00000000-0000-4000-8000-000000000001",
      metadata: { ...EMPTY_METADATA, title: "Temporary unrecognized title" },
      provenance: {
        provenance_id: "00000000-0000-4000-8000-000000000001",
        source_kind: "user",
        source_name: "import",
        source_record_id: JSON.stringify(["synthetic", lit]),
        observed_at: "2026-11-15T00:00:00Z",
        input_sha256: f.asset.sha256,
        parameters_sha256: null,
      },
      source_type: null,
      source_type_mapping_version: null,
      version_role: null,
      version_links: [],
      declared_keywords: [],
      reference_texts: [],
      reference_count: null,
      cited_by_count: null,
      asset_hints: [],
    }),
    { target_literature_id: lit },
  );
  await f.app.importSessions.fileItems.write({
    kind: "needs",
    literature_id: lit,
    needed: true,
    batch_id: null,
    now: "2026-11-15T00:00:00Z",
  });
  return {
    ...f,
    get app() {
      return f.app;
    },
    get modelCalls() {
      return f.modelCalls;
    },
    lit,
    calls: () => calls,
    close: () => f.close(),
  };
}
it("recognizes a marked literature after raw publication, records both sources and skips subsequent parses after clearing the mark", async () => {
  const f = await fixture(true);
  try {
    f.setText(`# ${FIXTURE_TITLE}\n\nSynthetic Author 2026\n`);
    const receipt = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    expect(receipt.profiles[0]!.status).toBe("published");
    expect(f.calls()).toBe(1);
    const detail = await f.app.library.detail(f.lit);
    expect(detail.needs_metadata).toBe(false);
    expect(
      detail.metadata_observations.map((o) => o.provenance.source_name),
    ).toEqual(expect.arrayContaining(["crossref", "post-parse-recognition"]));
    await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
      force: true,
    });
    expect(f.calls()).toBe(1);
    expect(f.modelCalls).toBe(0);
  } finally {
    await f.close();
  }
}, 40000);
it("keeps the mark when recognition or parsing fails and lets an explicit title edit clear it", async () => {
  const f = await fixture(false);
  try {
    f.setText("# A parsed replacement title\n\nSynthetic Author 2026\n");
    await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    let detail = await f.app.library.detail(f.lit);
    expect(detail.needs_metadata).toBe(true);
    expect(detail.literature.metadata.title).toBe("A parsed replacement title");
    const later = () =>
      parseMetadataObservation({
        observation_id: randomUUID(),
        metadata: {
          ...EMPTY_METADATA,
          title: "Temporary unrecognized title",
          abstract: "A later metadata arrival",
        },
        provenance: {
          provenance_id: randomUUID(),
          source_kind: "metadata-provider",
          source_name: "crossref",
          source_record_id: randomUUID(),
          observed_at: "2026-11-15T00:00:00Z",
          input_sha256: "b".repeat(64),
          parameters_sha256: null,
        },
        source_type: null,
        source_type_mapping_version: null,
        version_role: null,
        version_links: [],
        declared_keywords: [],
        reference_texts: [],
        reference_count: null,
        cited_by_count: null,
        asset_hints: [],
      });
    await f.app.identity.observe(later(), { target_literature_id: f.lit });
    expect((await f.app.library.detail(f.lit)).literature.metadata.title).toBe(
      "A parsed replacement title",
    );
    const before = f.calls();
    f.setParseHook(async () => {
      throw new ParsingFailure("parser-unavailable");
    });
    const failure = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
      force: true,
    });
    expect(failure.profiles[0]!.status).toBe("failed");
    expect(f.calls()).toBe(before);
    detail = await f.app.library.detail(f.lit);
    expect(detail.needs_metadata).toBe(true);
    const current = await f.app.metadataFields.read(f.lit);
    await f.app.metadataFields.edit({
      literature_id: f.lit,
      expected_revision: current.metadata_revision,
      set: [{ field: "title", value: "Manually identified title" }],
      unlock: [],
    });
    expect((await f.app.library.detail(f.lit)).needs_metadata).toBe(false);
    await f.app.identity.observe(later(), { target_literature_id: f.lit });
    expect((await f.app.library.detail(f.lit)).literature.metadata.title).toBe(
      "Manually identified title",
    );
    expect(f.modelCalls).toBe(0);
  } finally {
    await f.close();
  }
}, 40000);
