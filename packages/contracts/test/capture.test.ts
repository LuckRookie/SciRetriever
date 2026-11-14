import { expect, it } from "vitest";
import {
  parseIntakePageSave,
  parseIntakePagePreview,
  parseMetadataObservation,
} from "../src/index.js";
const request = {
  request_id: "00000000-0000-4000-8000-000000000001",
  metadata: {
    title: "Page title",
    identifiers: [{ namespace: "doi", value: "https://doi.org/10.5555/PAGE" }],
  },
};

it("admits only the declared web-capture user provenance with a record reference and input hash", () => {
  const observation = {
    observation_id: request.request_id,
    provenance: {
      provenance_id: request.request_id,
      source_kind: "user",
      source_name: "web-capture",
      source_record_id: "doi:10.5555/page",
      observed_at: "2026-11-10T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: parseIntakePageSave(request).metadata,
    source_type: null,
    source_type_mapping_version: null,
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  };
  expect(parseMetadataObservation(observation).provenance.source_name).toBe(
    "web-capture",
  );
  for (const patch of [
    { source_name: "arbitrary-user-source" },
    { input_sha256: null },
    { source_record_id: null },
    { parameters_sha256: "b".repeat(64) },
  ])
    expect(() =>
      parseMetadataObservation({
        ...observation,
        provenance: { ...observation.provenance, ...patch },
      }),
    ).toThrow();
});
it("normalizes page identifiers and fills only neutral metadata defaults", () => {
  const r = parseIntakePageSave(request);
  expect(r.metadata.identifiers).toEqual([
    { namespace: "doi", value: "10.5555/page" },
  ]);
  expect(r.metadata.abstract).toBeNull();
  expect(r.file).toBeNull();
  expect(r.folder_ids).toEqual([]);
  expect(
    parseIntakePagePreview({
      metadata: {
        identifiers: [
          {
            namespace: "arxiv",
            value: "https://arxiv.org/pdf/2601.12345v3.pdf",
          },
        ],
      },
    }).metadata.identifiers,
  ).toEqual([{ namespace: "arxiv", value: "2601.12345" }]);
});
it("accepts title-only pages, rejects empty items, unknown credentials, unknown credentials, arbitrary provenance and unsafe file references", () => {
  expect(
    parseIntakePageSave({ ...request, metadata: { title: "No ID" } }).metadata
      .title,
  ).toBe("No ID");
  expect(() => parseIntakePageSave({ ...request, metadata: {} })).toThrowError(
    expect.objectContaining({ code: "intake-item-empty" }),
  );
  for (const extra of [
    { token: "synthetic" },
    { provenance: {} },
    { page_url: "https://example.invalid" },
  ])
    expect(() => parseIntakePageSave({ ...request, ...extra })).toThrow();
  expect(() =>
    parseIntakePageSave({
      ...request,
      metadata: { ...request.metadata, cookie: "synthetic" },
    }),
  ).toThrow();
  expect(() =>
    parseIntakePageSave({ ...request, file: { file_name: "../paper.pdf" } }),
  ).toThrow();
  expect(() =>
    parseIntakePageSave({ ...request, request_id: "arbitrary" }),
  ).toThrow();
});
