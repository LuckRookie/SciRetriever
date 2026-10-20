import { describe, expect, it } from "vitest";
import {
  parseDocumentRef,
  parseDocumentRequest,
  parseDocumentReceipt,
  parseDocumentRepresentationInput,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseDocumentMaterialBytesRequest,
  parseEvidenceRef,
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

describe("Document reading response bounds", () => {
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
    };
    expect(parseDocumentReceipt(receipt).profiles).toEqual([outcome]);
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
