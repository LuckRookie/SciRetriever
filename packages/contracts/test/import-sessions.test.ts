import { expect, it } from "vitest";
import {
  parseImportCreate,
  parseImportData,
  parseMetadataObservation,
  EMPTY_METADATA,
} from "../src/index.js";
it("keeps the import model neutral, rejects unknown properties and leaves adhoc identities internal", () => {
  const base = {
    format: "records",
    library: {
      system: "synthetic",
      library_id: "1",
      identity: "local",
      name: "library",
    },
    scope: "selected group",
  };
  expect(parseImportCreate(base).import_user_tags).toBe(true);
  expect(() =>
    parseImportCreate({
      ...base,
      library: { ...base.library, identity: "adhoc" },
    }),
  ).toThrow();
  expect(() =>
    parseImportCreate({ ...base, token: "not-a-request-field" }),
  ).toThrow();
  expect(() =>
    parseImportData({ records: [], arbitrary_source_payload: {} }),
  ).toThrow();
  expect(
    parseImportData({
      records: [],
      groups: [
        { external_id: "group", parent_external_id: null, name: "Group" },
      ],
    }).groups,
  ).toHaveLength(1);
  const provenance = {
    provenance_id: "00000000-0000-4000-8000-000000000001",
    source_kind: "user",
    source_name: "import",
    source_record_id: null,
    observed_at: "2026-11-10T00:00:00Z",
    input_sha256: null,
    parameters_sha256: null,
  };
  const observation = {
    observation_id: "00000000-0000-4000-8000-000000000002",
    provenance: {
      ...provenance,
      source_record_id: '["library-key","record-id"]',
      input_sha256: "a".repeat(64),
    },
    source_type: null,
    source_type_mapping_version: null,
    metadata: {
      title: "Imported",
      authors: [],
      abstract: null,
      publication_date: null,
      publication_year: null,
      publication_form: null,
      article_kind: null,
      language: null,
      venue: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      identifiers: [],
      keywords: [],
      subject_terms: [],
    },
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  };
  expect(parseMetadataObservation(observation).provenance.source_name).toBe(
    "import",
  );
  expect(() =>
    parseMetadataObservation({ ...observation, provenance }),
  ).toThrow();
  expect(() =>
    parseMetadataObservation({
      ...observation,
      provenance: {
        ...observation.provenance,
        source_name: "unknown-user-source",
      },
    }),
  ).toThrow();
});

it("refuses file paths, multiple preferred files and oversized record lists at the import boundary", () => {
  const file = {
    external_id: "attachment",
    file_name: "paper.pdf",
    media_type: "application/pdf",
    preferred: true,
  };
  const record = {
    external_id: "record",
    metadata: { ...EMPTY_METADATA, title: "Synthetic" },
    files: [file],
  };
  for (const external_id of [
    "/tmp/private.pdf",
    "../private.pdf",
    "C:\\private.pdf",
  ])
    expect(() =>
      parseImportData({
        records: [{ ...record, files: [{ ...file, external_id }] }],
      }),
    ).toThrow();
  expect(() =>
    parseImportData({
      records: [{ ...record, files: [{ ...file, file_name: "dir/file.pdf" }] }],
    }),
  ).toThrow();
  expect(() =>
    parseImportData({
      records: [
        { ...record, files: [file, { ...file, external_id: "second" }] },
      ],
    }),
  ).toThrow();
  expect(() =>
    parseImportData({ records: Array.from({ length: 50_001 }, () => record) }),
  ).toThrow();
});

it("accepts an explicit null library without allowing callers to select an adhoc identity or namespace", () => {
  const request = {
    format: "bibtex",
    library: null,
    file_name: "batch-fixture.bib",
    scope: "one file",
  };
  expect(parseImportCreate(request).library).toBeNull();
  expect(() =>
    parseImportCreate({ ...request, identity_scope: "adhoc:chosen" }),
  ).toThrow();
  expect(() =>
    parseImportCreate({
      ...request,
      library: {
        system: "file",
        library_id: "chosen",
        identity: "adhoc",
        name: "file",
      },
    }),
  ).toThrow();
  expect(() =>
    parseImportCreate({ format: "bibtex", scope: "missing library" }),
  ).toThrow();
});
