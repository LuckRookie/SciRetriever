import { expect, it } from "vitest";
import {
  parseIntakePageSave,
  parseIntakePagePreview,
  parseMetadataObservation,
  EMPTY_METADATA,
} from "../src/index.js";
const request = {
  request_id: "00000000-0000-4000-8000-000000000001",
  page: {
    url: "https://synthetic.invalid/article",
    title: "Page title",
    meta: [
      {
        attribute: "name",
        key: "citation_doi",
        content: "https://doi.org/10.5555/PAGE",
      },
    ],
    json_ld: [],
    is_pdf: false,
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
    metadata: {
      ...EMPTY_METADATA,
      title: "Page title",
      identifiers: [{ namespace: "doi", value: "10.5555/page" }],
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
it("preserves original page values and fills only request defaults", () => {
  const r = parseIntakePageSave(request);
  expect(r.page).toEqual(request.page);
  expect(r.page.meta[0]!.content).toBe("https://doi.org/10.5555/PAGE");
  expect(r.file).toBeNull();
  expect(r.folder_ids).toEqual([]);
  expect(parseIntakePagePreview({ page: request.page }).page).toEqual(
    request.page,
  );
  expect(() =>
    parseIntakePagePreview({ metadata: { title: "Old decoded input" } }),
  ).toThrow();
});
it("accepts original title-only pages and rejects unknown credentials, decoded metadata, arbitrary provenance and unsafe file references", () => {
  expect(
    parseIntakePageSave({
      ...request,
      page: { ...request.page, title: "No ID", meta: [] },
    }).page.title,
  ).toBe("No ID");
  for (const extra of [
    { token: "synthetic" },
    { provenance: {} },
    { page_url: "https://example.invalid" },
    { metadata: { title: "Decoded" } },
  ])
    expect(() => parseIntakePageSave({ ...request, ...extra })).toThrow();
  expect(() =>
    parseIntakePageSave({
      ...request,
      page: { ...request.page, cookie: "synthetic" },
    }),
  ).toThrow();
  expect(() =>
    parseIntakePageSave({
      ...request,
      file: {
        file_name: "../paper.pdf",
        source_url: "https://synthetic.invalid/paper.pdf",
      },
    }),
  ).toThrow();
  expect(() =>
    parseIntakePageSave({ ...request, request_id: "arbitrary" }),
  ).toThrow();
  expect(
    parseIntakePageSave({
      ...request,
      file: {
        file_name: "paper.pdf",
        source_url: "https://synthetic.invalid/paper.pdf?download=1#page=2",
      },
    }).file!.source_url,
  ).toBe("https://synthetic.invalid/paper.pdf");
});
