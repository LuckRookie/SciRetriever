import { describe, expect, it } from "vitest";
import {
  createInputManifest,
  extractionCanonicalJsonBytes,
  extractionSpecHash,
  parseExtractionPreparationRequest,
  parseExtractionPreparationResult,
  parseDocumentMaterialRef,
  parseDocumentReadingRef,
  parseInputManifest,
  parseStrictJsonValue,
  parseExtractionSubmission,
  parseExtractionAcceptedResult,
  extractionSubmissionHash,
  EXTRACTION_RECEIPT_MAX_BYTES,
  parseExtractionReceiptResult,
} from "../src/index.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const hash = (digit: string) => digit.repeat(64);
const material = parseDocumentMaterialRef({
  literature_id: id(1),
  asset_id: id(2),
  asset_sha256: hash("a"),
  media_type: "application/pdf",
  byte_size: 12,
  artifact: { sha256: hash("a"), media_type: "application/pdf", byte_size: 12 },
});
const document = parseDocumentReadingRef({
  document_id: id(3),
  document_version_id: id(4),
  representation_sha256: hash("b"),
  source_material_ref: material,
  locator_scheme: "utf8-segment-v1",
});
async function spec(granularity: "file" | "segment" = "file") {
  const content = {
    schema_version: 1 as const,
    spec_id: "test.extraction",
    spec_version: "1",
    record_meaning: "一条记录是合成观察。",
    output_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      items: { type: "object" },
    },
    field_instructions: [],
    inclusion_rules: [],
    missing_value_rules: [],
    evidence_policy: {
      field_granularity: granularity,
      required_pointers: "record-root" as const,
      cross_input_relation: "optional" as const,
    },
    required_capabilities: [],
  };
  return { ...content, spec_sha256: await extractionSpecHash(content) };
}
const selection = {
  input_id: "one",
  literature_id: material.literature_id,
  asset_id: material.asset_id,
  asset_sha256: material.asset_sha256,
  document_version_id: null,
};

describe("Extraction preparation contracts", () => {
  it("rejects duplicate JSON keys, sparse arrays, over-budget values and preserves Unicode code points", () => {
    expect(() => parseStrictJsonValue('[{"a":1,"a":2}]')).toThrow();
    const sparse = Array<number>(2);
    sparse[1] = 1;
    expect(() => extractionCanonicalJsonBytes(sparse)).toThrow();
    expect(() =>
      extractionCanonicalJsonBytes("x".repeat(1024 * 1024 + 1)),
    ).toThrow();
    expect(extractionCanonicalJsonBytes("é")).not.toEqual(
      extractionCanonicalJsonBytes("e\u0301"),
    );
  });
  it("serializes numeric and astral keys by code point without invoking array accessors", () => {
    let calls = 0;
    const withGetter = [0];
    Object.defineProperty(withGetter, "0", {
      enumerable: true,
      get() {
        calls++;
        return 7;
      },
    });
    expect(() => extractionCanonicalJsonBytes(withGetter)).toThrow();
    expect(calls).toBe(0);
    const left: Record<string, number> = {};
    left["2"] = 1;
    left["😀"] = 4;
    left["10"] = 2;
    left["\uE000"] = 3;
    const right: Record<string, number> = {};
    right["\uE000"] = 3;
    right["10"] = 2;
    right["😀"] = 4;
    right["2"] = 1;
    const actual = new TextDecoder().decode(extractionCanonicalJsonBytes(left));
    expect(actual).toBe('{"10":2,"2":1,"\uE000":3,"😀":4}');
    expect(extractionCanonicalJsonBytes(left)).toEqual(
      extractionCanonicalJsonBytes(right),
    );
  });
  it("validates manifest capability relationships and snapshots before hash awaits", async () => {
    const item = {
      input_id: "one",
      literature_id: material.literature_id,
      material,
      document: null,
      capabilities: ["material-file-v1"],
      gaps: ["document-missing"],
    };
    const manifest = await createInputManifest([item] as never);
    expect(Object.isFrozen(manifest.items[0]?.material)).toBe(true);
    await expect(
      createInputManifest([{ ...item, material: null }] as never),
    ).rejects.toThrow();
    await expect(
      createInputManifest([
        { ...item, capabilities: ["material-file-v1", "document-segment-v1"] },
      ] as never),
    ).rejects.toThrow();
    await expect(
      createInputManifest([
        { ...item, document, gaps: ["document-missing"] },
      ] as never),
    ).rejects.toThrow();
    await expect(
      createInputManifest([
        { ...item, capabilities: ["material-file-v1", "material-file-v1"] },
      ] as never),
    ).rejects.toThrow();
    const mutable = structuredClone(manifest) as unknown as Record<
      string,
      unknown
    >;
    const parsing = parseInputManifest(mutable);
    mutable.manifest_sha256 = hash("f");
    expect(await parsing).toEqual(manifest);
  });
  it("rejects forged spec, manifest, selected material/version and missing-capability claims", async () => {
    const request = await parseExtractionPreparationRequest({
      spec: await spec("segment"),
      inputs: [selection],
    });
    const manifest = await createInputManifest([
      {
        input_id: "one",
        literature_id: material.literature_id,
        material,
        document: null,
        capabilities: ["material-file-v1"],
        gaps: ["document-missing"],
      },
    ]);
    const valid = {
      schema_version: 1,
      spec: request.spec,
      manifest,
      missing_required_capabilities: [
        { input_id: "one", capabilities: ["document-segment-v1"] },
      ],
      persistence: "requires-catalog-v5",
    };
    expect(
      (await parseExtractionPreparationResult(valid, request)).manifest,
    ).toEqual(manifest);
    await expect(
      parseExtractionPreparationResult(
        { ...valid, missing_required_capabilities: [] },
        request,
      ),
    ).rejects.toThrow();
    await expect(
      parseExtractionPreparationResult(
        { ...valid, spec: { ...request.spec, spec_sha256: hash("f") } },
        request,
      ),
    ).rejects.toThrow();
    await expect(
      parseExtractionPreparationResult(
        { ...valid, manifest: { ...manifest, manifest_sha256: hash("f") } },
        request,
      ),
    ).rejects.toThrow();
    const other = await createInputManifest([
      {
        input_id: "one",
        literature_id: material.literature_id,
        material: { ...material, asset_id: id(9) },
        document: null,
        capabilities: ["material-file-v1"],
        gaps: ["document-missing"],
      },
    ]);
    await expect(
      parseExtractionPreparationResult({ ...valid, manifest: other }, request),
    ).rejects.toThrow();
    const changedHash = await createInputManifest([
      {
        ...manifest.items[0]!,
        material: parseDocumentMaterialRef({
          ...material,
          asset_sha256: hash("c"),
          artifact: { ...material.artifact, sha256: hash("c") },
        }),
      },
    ]);
    await expect(
      parseExtractionPreparationResult(
        { ...valid, manifest: changedHash },
        request,
      ),
    ).rejects.toThrow();
    const secondMaterial = parseDocumentMaterialRef({
      ...material,
      asset_id: id(9),
    });
    const ordered = await parseExtractionPreparationRequest({
      spec: request.spec,
      inputs: [selection, { ...selection, input_id: "two", asset_id: id(9) }],
    });
    const reversed = await createInputManifest([
      {
        input_id: "two",
        literature_id: material.literature_id,
        material: secondMaterial,
        document: null,
        capabilities: ["material-file-v1"],
        gaps: ["document-missing"],
      },
      manifest.items[0]!,
    ]);
    await expect(
      parseExtractionPreparationResult(
        {
          ...valid,
          manifest: reversed,
          missing_required_capabilities: [
            { input_id: "two", capabilities: ["document-segment-v1"] },
            { input_id: "one", capabilities: ["document-segment-v1"] },
          ],
        },
        ordered,
      ),
    ).rejects.toThrow();
    const explicit = await parseExtractionPreparationRequest({
      spec: request.spec,
      inputs: [{ ...selection, document_version_id: id(4) }],
    });
    await expect(
      parseExtractionPreparationResult(valid, explicit),
    ).rejects.toThrow();
  });
});

describe("Extraction delivery wrapper budgets", () => {
  const operation = {
    schema_version: 1 as const,
    operation_id: "operation-1",
    caller_id: "caller-1",
    spec_id: "spec-1",
    spec_version: "1",
    spec_sha256: hash("a"),
    manifest_sha256: hash("b"),
    status: "open" as const,
    created_at: "2026-09-29T00:00:00.000Z",
    accept_until: "2026-09-30T00:00:00.000Z",
    closed_at: null,
  };
  const submission = (payload: unknown) => ({
    schema_version: 1,
    operation_id: "operation-1",
    submission_key: "key-1",
    batch_id: "batch-1",
    records: [{ record_id: "record-1", payload, field_evidence: [] }],
    relations: [],
    coverage: [{ input_id: "input-1", status: "not-processed", reason: null }],
    producer: { method_id: "method-1", method_version: "1", usage: {} },
  });
  const receipt = (submission_sha256: string) => ({
    schema_version: 1,
    receipt_id: "receipt-1",
    operation_id: "operation-1",
    submission_key: "key-1",
    batch_id: "batch-1",
    submission_sha256,
    accepted_at: "2026-09-29T01:00:00.000Z",
    receipt_expires_at: "2026-10-29T01:00:00.000Z",
    protection_expires_at: "2026-10-29T01:00:00.000Z",
    checks: {
      record_count: 1,
      relation_count: 0,
      evidence_count: 0,
      coverage_count: 1,
    },
    protected_materials: [],
    protected_documents: [],
  });
  it("hashes and reads a node-limit batch while rejecting a larger batch", async () => {
    const payload = (count: number) =>
      Array.from({ length: 32 }, (_, index) =>
        Array.from(
          { length: Math.min(256, Math.max(0, count - index * 256)) },
          () => 1,
        ),
      );
    let maximum = 0;
    for (let count = 8140; count > 8000; count--) {
      try {
        parseExtractionSubmission(submission(payload(count)));
        maximum = count;
        break;
      } catch {
        /* find the public batch boundary */
      }
    }
    expect(maximum).toBeGreaterThan(8000);
    const batch = parseExtractionSubmission(submission(payload(maximum)));
    expect(() =>
      parseExtractionSubmission(submission(payload(maximum + 1))),
    ).toThrow();
    const digest = await extractionSubmissionHash(operation, batch);
    const accepted = parseExtractionAcceptedResult({
      schema_version: 1,
      receipt: receipt(digest),
      accepted_batch: batch,
    });
    expect(accepted.accepted_batch).toEqual(batch);
  });
  it("allows one fixed wrapper level but rejects deeper original batches", async () => {
    const nested = (levels: number) => {
      let value: unknown = 1;
      for (let index = 0; index < levels; index++) value = [value];
      return value;
    };
    const batch = parseExtractionSubmission(submission(nested(29)));
    const digest = await extractionSubmissionHash(operation, batch);
    expect(
      parseExtractionAcceptedResult({
        schema_version: 1,
        receipt: receipt(digest),
        accepted_batch: batch,
      }).accepted_batch,
    ).toEqual(batch);
    expect(() => parseExtractionSubmission(submission(nested(30)))).toThrow();
  });
  it("accepts the full bounded receipt and rejects excess data", () => {
    const pins = Array.from({ length: 128 }, (_, index) => ({
      input_id: `i${String(index).padStart(3, "0")}${"x".repeat(124)}`,
      literature_id: `l${"x".repeat(127)}`,
      asset_id: `a${"x".repeat(127)}`,
      asset_sha256: hash("a"),
    }));
    const full = {
      ...receipt(hash("c")),
      protected_materials: pins,
      protected_documents: pins.map(({ input_id }) => ({
        input_id,
        document_version_id: `d${"x".repeat(127)}`,
        representation_sha256: hash("b"),
      })),
    };
    expect(
      extractionCanonicalJsonBytes(full, EXTRACTION_RECEIPT_MAX_BYTES).length,
    ).toBeGreaterThan(65536);
    expect(parseExtractionReceiptResult(full).protected_documents).toHaveLength(
      128,
    );
    expect(() =>
      parseExtractionReceiptResult({
        ...full,
        protected_materials: [...pins, pins[0]],
      }),
    ).toThrow();
  });
});
