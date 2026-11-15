import { describe, expect, it } from "vitest";
import {
  parseDocumentRef,
  parseDocumentRequest,
  parseDocumentReceipt,
  parseDocumentRepresentationInput,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseDocumentMaterialBytesRequest,
  parseDocumentResourceBytesRequest,
  parseEvidenceRef,
  parseDraftDocumentRef,
  parseDraftDifference,
  parseDraftContent,
  parseDraftOutcome,
  parseDocumentSegmentLocation,
  parseDocumentSegmentLocationForVersion,
  parseDraftDocumentStructure,
  parseDocumentStructureV2,
  type DocumentRef,
} from "../src/index.js";

const literatureId = "00000000-0000-0000-0000-000000000951";
const assetId = "00000000-0000-0000-0000-000000000953";
const documentId = "00000000-0000-0000-0000-000000000956";
const versionId = "00000000-0000-0000-0000-000000000957";
const hash = (digit: string) => digit.repeat(64);
const artifact = (digit: string, media_type: string) => ({
  sha256: hash(digit),
  byte_size: 12,
  media_type,
});

describe("Draft contracts are explicitly versioned", () => {
  const draft = () => ({
    schema_version: 3,
    text_level: "draft",
    document_id: documentId,
    document_version_id: versionId,
    representation_sha256: hash("a"),
    source_material_ref: material,
    raw_parse_id: assetId,
    raw_parse_result_sha256: hash("b"),
    page_layer_sha256: hash("c"),
    draft_method_sha256: hash("d"),
    draft_content: artifact("e", "application/json"),
    builder_version: "draft-leaves-v1",
    locator_scheme: "utf8-segment-v1",
    markdown: artifact("1", "text/markdown"),
    structure: artifact("2", "application/json"),
    resources: [],
  });
  it("accepts schema 3 only through the draft parser and keeps the schema 2 parser closed", () => {
    const value = draft();
    const parsed: DocumentRef = parseDraftDocumentRef(value);
    expect(parsed).toEqual(value);
    expect(() => parseDocumentRef(value)).toThrow();
    for (const bad of [
      { ...value, text_level: "proofread" },
      { ...value, builder_version: "source-order-leaves-v4" },
      { ...value, proofread_id: assetId },
      { ...value, raw_parse_id: "invalid" },
      { ...value, page_layer_sha256: "invalid" },
      { ...value, draft_content: artifact("e", "text/markdown") },
      {
        ...value,
        draft_content: {
          ...value.draft_content,
          byte_size: 16 * 1024 * 1024 + 1,
        },
      },
    ])
      expect(() => parseDraftDocumentRef(bad)).toThrow();
  });
  it("binds each segment location's six bases to its explicit version", () => {
    const value = {
      block_id: "b1",
      page: 1,
      region: null,
      continuation_regions: [],
      source: "parser",
      locate: "page",
    };
    for (const basis of [
      "text-layer-match",
      "text-layer-differs",
      "no-text-layer",
    ]) {
      expect(
        parseDocumentSegmentLocationForVersion({ ...value, basis }, 3).basis,
      ).toBe(basis);
      expect(() => parseDocumentSegmentLocation({ ...value, basis })).toThrow();
    }
    for (const basis of ["text-layer", "image-only", "manual"]) {
      expect(
        parseDocumentSegmentLocationForVersion({ ...value, basis }, 2).basis,
      ).toBe(basis);
      expect(() =>
        parseDocumentSegmentLocationForVersion({ ...value, basis }, 3),
      ).toThrow();
    }
    const structure = {
      schema_version: 2,
      text_encoding: "utf8",
      page_count: 1,
      sections: [],
      segments: [
        {
          ...value,
          region: null,
          segment_id: "s1",
          section_id: null,
          start_utf8: 0,
          end_utf8: 1,
          kind: "text",
          page: 0,
          basis: "text-layer-match",
        },
      ],
    };
    expect(parseDraftDocumentStructure(structure, 1).segments[0]!.basis).toBe(
      "text-layer-match",
    );
    expect(() => parseDocumentStructureV2(structure, 1)).toThrow();
    expect(() =>
      parseDraftDocumentStructure(
        {
          ...structure,
          segments: [{ ...structure.segments[0], basis: "manual" }],
        },
        1,
      ),
    ).toThrow();
  });
  it("rejects ambiguous difference records and closes outcome failure codes", () => {
    const mismatch = {
      leaf_id: assetId,
      page_index: 0,
      kind: "mismatch",
      parsed: "50",
      text_layer: "60",
      other_page_index: null,
    };
    expect(parseDraftDifference(mismatch, 2)).toEqual(mismatch);
    const elsewhere = {
      ...mismatch,
      kind: "elsewhere",
      parsed: "these four words differ",
      text_layer: "",
      other_page_index: 1,
    };
    expect(parseDraftDifference(elsewhere, 2)).toEqual(elsewhere);
    for (const bad of [
      { ...mismatch, other_page_index: 1 },
      { ...mismatch, parsed: "60" },
      { ...mismatch, kind: "other" },
      { ...elsewhere, other_page_index: 0 },
      { ...elsewhere, other_page_index: 2 },
      { ...elsewhere, text_layer: "words" },
    ])
      expect(() => parseDraftDifference(bad, 2)).toThrow();
    const failed = {
      status: "failed",
      raw_parse_id: assetId,
      failure_code: "cancelled",
    };
    expect(parseDraftOutcome(failed)).toEqual(failed);
    expect(() =>
      parseDraftOutcome({ ...failed, failure_code: "input-missing" }),
    ).toThrow();
    expect(
      parseDraftOutcome({
        status: "not-formed",
        reason: "profile-not-requested",
      }),
    ).toMatchObject({ status: "not-formed" });
    const formed = {
      status: "formed",
      raw_parse_id: assetId,
      document_version_id: versionId,
      representation_sha256: hash("a"),
      default_changed: false,
      default_text_level: "proofread",
    };
    expect(parseDraftOutcome(formed)).toEqual(formed);
    expect(() =>
      parseDraftOutcome({ ...formed, default_changed: "false" }),
    ).toThrow();
  });
  it("parses immutable draft content without text-layer text and validates page/leaf difference bindings", () => {
    const value = {
      schema_version: 1,
      format: "draft-content-v1",
      differences_format: "draft-differences-v1",
      raw: {
        raw_parse_id: assetId,
        result_sha256: hash("a"),
        profile: "vlm-engine",
      },
      page_layer_sha256: hash("b"),
      pages: [{ page_index: 0, kind: "text-layer" }],
      method: {
        chrome: "page-chrome-v1",
        breaks: "paragraph-break-v3",
        reading_order: false,
        comparison: "draft-compare-v1",
        builder: "draft-leaves-v1",
      },
      draft_method_sha256: hash("c"),
      source_blocks: [],
      operations: [],
      leaves: [],
    };
    expect(parseDraftContent(value)).toEqual(value);
    for (const bad of [
      { ...value, pages: [{ page_index: 1, kind: "text-layer" }] },
      {
        ...value,
        pages: [{ page_index: 0, kind: "text-layer", text: "not stored here" }],
      },
      { ...value, method: { ...value.method, comparison: "future-rule" } },
      {
        ...value,
        leaves: [
          {
            leaf_id: assetId,
            page_index: 0,
            basis: "text-layer-differs",
            differences: [],
          },
        ],
      },
      {
        ...value,
        leaves: [
          {
            leaf_id: assetId,
            page_index: 0,
            basis: "text-layer-match",
            differences: [],
          },
        ],
      },
    ])
      expect(() => parseDraftContent(bad)).toThrow();
  });
});

describe("Document reading response bounds", () => {
  it("binds complete resource byte requests to a fixed document and rejects paths and pagination", () => {
    const selected = { document_version_id: versionId, resource_id: "r1" };
    expect(parseDocumentResourceBytesRequest(selected)).toEqual(selected);
    for (const invalid of [
      { ...selected, document_version_id: "bad" },
      { ...selected, resource_id: "../private.png" },
      { ...selected, path: "objects/figure.png" },
      { ...selected, url: "https://example.org/figure.png" },
      { ...selected, max_bytes: 65536 },
      { ...selected, continuation: null },
    ])
      expect(() => parseDocumentResourceBytesRequest(invalid)).toThrow();
  });
  it("binds original PDF byte requests to exact stable IDs and expected hash", () => {
    const selected = {
      literature_id: literatureId,
      asset_id: assetId,
      asset_sha256: hash("a"),
    };
    expect(parseDocumentMaterialBytesRequest(selected)).toEqual(selected);
    expect(() =>
      parseDocumentMaterialBytesRequest({
        ...selected,
        path: "objects/source.pdf",
      }),
    ).toThrow();
    expect(() =>
      parseDocumentMaterialBytesRequest({ ...selected, asset_sha256: "bad" }),
    ).toThrow();
  });
  const document = {
    document_id: documentId,
    document_version_id: versionId,
    representation_sha256: hash("1"),
    source_material_ref: material,
    locator_scheme: "utf8-segment-v1",
  };
  const resource = {
    resource_id: "one",
    reference: "figures/one.png",
    relation: "image",
    artifact: artifact("f", "image/png"),
  };
  const capabilities = {
    text: true,
    outline: true,
    resources: true,
    table_context: false,
    figure_caption: false,
    page: false,
    bbox: false,
  };

  it("accepts 200 slice evidence records while preserving item and text byte limits", () => {
    const request = parseDocumentReadRequest("slice", {
      document_version_id: versionId,
      selector: { kind: "range", start_utf8: 0, end_utf8: 400 },
      max_bytes: 65536,
      continuation: null,
    });
    const evidence = Array.from({ length: 200 }, (_, i) => ({
      schema_version: 1,
      target_kind: "document",
      locator_scheme: "utf8-segment-v1",
      document_version_id: versionId,
      representation_sha256: hash("1"),
      locator: { kind: "segment", segment_id: `s${i}` },
      content_sha256: null,
    }));
    const result = {
      document,
      selector: request.selector,
      actual_range: { start_utf8: 0, end_utf8: 400 },
      text: "α".repeat(200),
      evidence,
      related_resources: [],
      truncated: false,
      continuation: null,
      capabilities,
      gaps: [],
    };
    expect(
      parseDocumentReadResult("slice", result, request).evidence,
    ).toHaveLength(200);
    expect(() =>
      parseDocumentReadResult(
        "slice",
        { ...result, evidence: [...evidence, evidence[0]] },
        request,
      ),
    ).toThrow();
    expect(() =>
      parseDocumentReadResult("slice", result, { ...request, max_bytes: 399 }),
    ).toThrow();
    expect(() =>
      parseDocumentReadRequest("slice", { ...request, max_bytes: 65537 }),
    ).toThrow();
  });

  it("rejects more page items than requested and false resource completion", () => {
    const listRequest = parseDocumentReadRequest("resources", {
      document_version_id: versionId,
      limit: 1,
      cursor: null,
    });
    const list = {
      document,
      resources: [
        resource,
        { ...resource, resource_id: "two", reference: "figures/two.png" },
      ],
      total: 2,
      next_cursor: null,
      capabilities,
      gaps: [],
    };
    expect(() =>
      parseDocumentReadResult("resources", list, listRequest),
    ).toThrow();

    const request = parseDocumentReadRequest("resource", {
      document_version_id: versionId,
      resource_id: "one",
      max_bytes: 12,
      continuation: null,
    });
    const result = {
      document,
      resource,
      bytes_base64: Buffer.from("123456").toString("base64"),
      actual_range: { start_byte: 0, end_byte: 6 },
      truncated: true,
      continuation: "next",
      gap: null,
    };
    expect(parseDocumentReadResult("resource", result, request).truncated).toBe(
      true,
    );
    expect(() =>
      parseDocumentReadResult(
        "resource",
        { ...result, truncated: false, continuation: null },
        request,
      ),
    ).toThrow();
    expect(() =>
      parseDocumentReadResult(
        "resource",
        { ...result, actual_range: { start_byte: 3, end_byte: 9 } },
        request,
      ),
    ).toThrow();
    const continued = parseDocumentReadRequest("resource", {
      ...request,
      continuation: "next",
    });
    expect(() =>
      parseDocumentReadResult("resource", result, continued),
    ).toThrow();
  });

  it("requires advancing evidence and slice ranges with an explicit unavailable context", () => {
    const evidence = parseEvidenceRef({
      schema_version: 1,
      target_kind: "document",
      locator_scheme: "utf8-segment-v1",
      document_version_id: versionId,
      representation_sha256: hash("1"),
      locator: { kind: "segment", segment_id: "p1" },
      content_sha256: null,
    });
    const request = parseDocumentReadRequest("evidence", {
      evidence,
      max_bytes: 12,
      continuation: null,
    });
    const result = {
      evidence,
      document,
      granularity: "segment",
      target_range: { start_utf8: 10, end_utf8: 22 },
      actual_range: { start_utf8: 10, end_utf8: 16 },
      text: "123456",
      content_sha256: hash("2"),
      truncated: true,
      continuation: "next",
      gaps: [],
    };
    expect(parseDocumentReadResult("evidence", result, request).truncated).toBe(
      true,
    );
    expect(() =>
      parseDocumentReadResult(
        "evidence",
        { ...result, actual_range: { start_utf8: 12, end_utf8: 18 } },
        request,
      ),
    ).toThrow();
    expect(() =>
      parseDocumentReadResult(
        "evidence",
        { ...result, truncated: false, continuation: null },
        request,
      ),
    ).toThrow();
    const continued = parseDocumentReadRequest("evidence", {
      ...request,
      continuation: "next",
    });
    expect(() =>
      parseDocumentReadResult("evidence", result, continued),
    ).toThrow();

    const sliceRequest = parseDocumentReadRequest("slice", {
      document_version_id: versionId,
      selector: { kind: "resource-context", resource_id: "one" },
      max_bytes: 12,
      continuation: null,
    });
    const missing = {
      document,
      selector: sliceRequest.selector,
      actual_range: null,
      text: "",
      evidence: [],
      related_resources: [resource],
      truncated: false,
      continuation: null,
      capabilities,
      gaps: [],
    };
    expect(() =>
      parseDocumentReadResult("slice", missing, sliceRequest),
    ).toThrow();
    expect(
      parseDocumentReadResult(
        "slice",
        { ...missing, gaps: ["resource-context-unavailable"] },
        sliceRequest,
      ).actual_range,
    ).toBeNull();
    const continuedSlice = parseDocumentReadRequest("slice", {
      ...sliceRequest,
      continuation: "next",
    });
    const repeated = {
      ...missing,
      actual_range: { start_utf8: 0, end_utf8: 6 },
      text: "123456",
      truncated: true,
      continuation: "next",
      gaps: [],
    };
    expect(() =>
      parseDocumentReadResult("slice", repeated, continuedSlice),
    ).toThrow();
  });
});
const material = {
  literature_id: literatureId,
  asset_id: assetId,
  asset_sha256: hash("a"),
  media_type: "application/pdf",
  byte_size: 12,
  artifact: artifact("a", "application/pdf"),
};
const representation = {
  proofread_id: "00000000-0000-0000-0000-000000000951",
  source_material_ref: material,
  proofread_content_sha256: hash("b"),
  builder_version: "proofread-blocks-v1",
  locator_scheme: "utf8-segment-v1",
  markdown: artifact("c", "text/markdown"),
  structure: artifact("d", "application/json"),
  resources: [
    {
      resource_id: "two",
      reference: "figures/two.png",
      relation: "image",
      artifact: artifact("e", "image/png"),
    },
    {
      resource_id: "one",
      reference: "figures/one.png",
      relation: "image",
      artifact: artifact("f", "image/png"),
    },
  ],
};

describe("Document and Evidence boundary parsers", () => {
  it.each([
    "proofread-blocks-v1",
    "arranged-leaves-v2",
    "source-order-leaves-v3",
    "source-order-leaves-v4",
  ])(
    "accepts the published %s builder without changing its identity",
    (builder_version) => {
      expect(
        parseDocumentRepresentationInput({ ...representation, builder_version })
          .builder_version,
      ).toBe(builder_version);
      expect(() =>
        parseDocumentRepresentationInput({
          ...representation,
          builder_version: "source-order-leaves-v999",
        }),
      ).toThrow();
    },
  );
  it("copies a closed processing request and rejects inconsistent receipts", () => {
    const mutable = {
      literature_id: literatureId,
      asset_id: assetId,
      asset_sha256: hash("a"),
      profiles: ["pipeline", "vlm-engine"],
      force: false,
    };
    const request = parseDocumentRequest(mutable);
    mutable.profiles.pop();
    mutable.force = true;
    expect(request.profiles).toEqual(["pipeline", "vlm-engine"]);
    expect(request.force).toBe(false);
    expect(Object.isFrozen(request.profiles)).toBe(true);
    expect(
      parseDocumentRequest({
        literature_id: literatureId,
        asset_id: assetId,
        asset_sha256: hash("a"),
      }),
    ).toEqual({
      literature_id: literatureId,
      asset_id: assetId,
      asset_sha256: hash("a"),
      force: false,
    });
    expect(() =>
      parseDocumentRequest({ ...mutable, mode: "reuse-current" }),
    ).toThrow();
    expect(() =>
      parseDocumentRequest({ ...mutable, profiles: ["pipeline", "pipeline"] }),
    ).toThrow();
    const outcome = {
      profile: "pipeline",
      status: "published",
      raw_parse_id: versionId,
      result_sha256: hash("b"),
      failure_code: null,
      failure_source_type: null,
    };
    const receipt = {
      literature_id: literatureId,
      asset_id: assetId,
      asset_sha256: hash("a"),
      profiles: [outcome],
      draft: { status: "not-formed", reason: "profile-not-requested" },
    };
    expect(parseDocumentReceipt(receipt).profiles).toEqual([outcome]);
    const formed = {
      status: "formed",
      raw_parse_id: versionId,
      document_version_id: versionId,
      representation_sha256: hash("c"),
      default_changed: true,
      default_text_level: "draft",
    };
    expect(parseDocumentReceipt({ ...receipt, draft: formed }).draft).toEqual(
      formed,
    );
    expect(
      parseDocumentReceipt({
        ...receipt,
        draft: {
          ...formed,
          status: "reused",
          default_changed: false,
          default_text_level: "proofread",
        },
      }).draft.status,
    ).toBe("reused");
    expect(
      parseDocumentReceipt({
        ...receipt,
        draft: {
          status: "failed",
          raw_parse_id: versionId,
          failure_code: "cancelled",
        },
      }).draft.status,
    ).toBe("failed");
    expect(() =>
      parseDocumentReceipt({ ...receipt, draft: undefined }),
    ).toThrow();
    expect(() =>
      parseDocumentReceipt({
        ...receipt,
        draft: { ...formed, default_text_level: "unknown" },
      }),
    ).toThrow();
    expect(() =>
      parseDocumentReceipt({
        ...receipt,
        draft: { ...formed, raw_parse_id: assetId },
      }),
    ).toThrow();
    expect(() =>
      parseDocumentReceipt({ ...receipt, draft: { ...formed, extra: true } }),
    ).toThrow();
    expect(() => parseDocumentReceipt({ ...receipt, document: {} })).toThrow();
    expect(() =>
      parseDocumentReceipt({
        ...receipt,
        profiles: [{ ...outcome, raw_parse_id: null }],
      }),
    ).toThrow();
    expect(() =>
      parseDocumentReceipt({
        ...receipt,
        profiles: [{ ...outcome, status: "failed" }],
      }),
    ).toThrow();
    expect(
      parseDocumentReceipt({
        ...receipt,
        profiles: [
          {
            ...outcome,
            status: "failed",
            raw_parse_id: null,
            result_sha256: null,
            failure_code: "parser-unavailable",
          },
        ],
      }).profiles[0]?.status,
    ).toBe("failed");
  });
  it("normalizes resource order and rejects open or inconsistent representation fields", () => {
    const parsed = parseDocumentRepresentationInput(representation);
    expect(parsed.resources.map((resource) => resource.reference)).toEqual([
      "figures/one.png",
      "figures/two.png",
    ]);
    expect(
      parseDocumentRepresentationInput({
        ...representation,
        resources: [...representation.resources].reverse(),
      }),
    ).toEqual(parsed);
    expect(() =>
      parseDocumentRepresentationInput({ ...representation, extra: true }),
    ).toThrow();
    expect(() =>
      parseDocumentRepresentationInput({
        ...representation,
        locator_scheme: "xpath-v1",
      }),
    ).toThrow();
    expect(() =>
      parseDocumentRepresentationInput({
        ...representation,
        source_material_ref: { ...material, asset_sha256: hash("0") },
      }),
    ).toThrow();
    expect(() =>
      parseDocumentRepresentationInput({
        ...representation,
        resources: [{ ...representation.resources[0], relation: "citation" }],
      }),
    ).toThrow();
    expect(() =>
      parseDocumentRepresentationInput({
        ...representation,
        resources: [{ ...representation.resources[0], reference: "../escape" }],
      }),
    ).toThrow();
  });

  it("rejects invalid IDs and parses both closed evidence variants", () => {
    const document = {
      schema_version: 2,
      document_id: documentId,
      document_version_id: versionId,
      representation_sha256: hash("1"),
      ...representation,
    };
    expect(parseDocumentRef(document).document_version_id).toBe(versionId);
    expect(() =>
      parseDocumentRef({ ...document, document_id: "invalid" }),
    ).toThrow();
    expect(() => parseDocumentRef({ ...document, extra: null })).toThrow();
    const materialEvidence = {
      schema_version: 1,
      target_kind: "material",
      locator_scheme: "material-file-v1",
      material,
      locator: { kind: "file" },
      content_sha256: hash("a"),
    };
    expect(parseEvidenceRef(materialEvidence).target_kind).toBe("material");
    expect(() =>
      parseEvidenceRef({ ...materialEvidence, content_sha256: hash("0") }),
    ).toThrow();
    const documentEvidence = {
      schema_version: 1,
      target_kind: "document",
      locator_scheme: "utf8-segment-v1",
      document_version_id: versionId,
      representation_sha256: hash("1"),
      locator: { kind: "segment", segment_id: "s1" },
      content_sha256: null,
    };
    expect(parseEvidenceRef(documentEvidence).target_kind).toBe("document");
    expect(() =>
      parseEvidenceRef({
        ...documentEvidence,
        locator: { kind: "page", page: 1 },
      }),
    ).toThrow();
    expect(() =>
      parseEvidenceRef({ ...documentEvidence, unknown: true }),
    ).toThrow();
  });
});
