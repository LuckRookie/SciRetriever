import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  parseMetaLiteratureId,
  parseEvidenceRef,
  parseProcessorResult,
  processorComparison,
  processorResultBytes,
  sha256,
  type ProcessorCitation,
  type ProcessorResult,
  type DocumentReadingRef,
  type EvidenceRef,
} from "@sciretriever/contracts";
import { processorFixture } from "./processor-fixture.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import type { StoredProcessorResult } from "../src/analysis/processor.js";
import { exportProcessorResult } from "../src/analysis/processor-export.js";
import { documentAnalysisParameters } from "../src/analysis/knowledge-session.js";
import { queryProcessors } from "../src/entry/processor-operations.js";
import {
  readProcessorResult,
  resolveProcessorEvidence,
} from "../../web/src/app/data/processor-results.js";
import type { ApiClient } from "../../web/src/app/data/api.js";
import { artifactReference } from "../src/storage/artifact-layout.js";
import { SqliteProcessorStorage } from "../src/storage/processor-results.js";
import type { ProcessorStorageAction } from "../src/storage/sqlite/processor-engine.js";

const absent = "synthetic-mistyped-segment";
let env: Awaited<ReturnType<typeof processorFixture>>;
let saved: StoredProcessorResult;
let other: DocumentReadingRef;
let statements: { statement_id: string; text: string }[];
let store: SqliteProcessorStorage;
let submissions = 0;
beforeAll(async () => {
  env = await processorFixture();
  store = new SqliteProcessorStorage(
    env.app.database,
    env.app.files,
    env.app.documentRead,
  );
  await env.build(env.parseRequest);
  const literature_id = parseLiteratureId(randomUUID());
  await env.app.database.putLiterature({
    ...FIXTURE_LITERATURE,
    literature_id,
    meta_literature_id: parseMetaLiteratureId(randomUUID()),
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: "Other fixed input",
      identifiers: [{ namespace: "doi", value: "10.1234/citation-other" }],
    },
  });
  await env.app.maintenance!.ingestPdf({
    literature_id,
    bytes: workbenchPdf("Other fixed input"),
  });
  const asset = (await env.app.library.detail(literature_id)).primary_pdf!
    .asset;
  env.setText("Other document with a different fixed representation.");
  other = (
    await env.build({
      literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
    })
  ).document;
  env.setModel((input) => {
    submissions++;
    const first = input.segments![0]!;
    statements = Array.from({ length: 7 }, (_, i) => ({
      statement_id: `s${i + 1}`,
      text: first.text,
      category: "finding",
      epistemic: "reported",
      conditions: [],
      quantity: null,
      evidence_segment_ids:
        i === 6 ? [first.segment_id, absent] : [first.segment_id],
    }));
    return {
      outcome: "completed",
      title: "Seven unchanged findings",
      statements,
    };
  });
  const run = await env.app.processors!.runBatch({
    schema_version: 1,
    idempotency_key: "summary-unavailable",
    name: "Synthetic summary",
    processor: { id: "summary", version: "2" },
    spec: {},
    inputs: [
      { kind: "literature", literature_id: env.parseRequest.literature_id },
    ],
  });
  expect(run.failures).toEqual([]);
  const collection = await env.app.processorRead!.collection(
    String((run.collections[0] as { collection_id: string }).collection_id),
  );
  saved = (await env.app.processorRead!.byId(
    collection!.members[0]!.result!.result_id,
  ))!;
}, 0);
afterAll(async () => {
  await store?.close();
  await env?.close();
});

function missingCitation(): {
  kind: "document";
  evidence: Extract<EvidenceRef, { target_kind: "document" }>;
} {
  if (saved.result.content.kind !== "report")
    throw new Error("Expected report");
  const c = saved.result.content.claims[6]!.sources[1]!;
  if (c.kind !== "document" || c.evidence.target_kind !== "document")
    throw new Error("Expected document citation");
  return { kind: "document", evidence: c.evidence };
}
function replaceMissing(citation: ProcessorCitation): ProcessorResult {
  const r = saved.result;
  if (r.content.kind !== "report") throw new Error("Expected report");
  return {
    ...r,
    content: {
      ...r.content,
      claims: r.content.claims.map((c) =>
        c.record_id !== "s7" ? c : { ...c, sources: [c.sources[0]!, citation] },
      ),
    },
    value_checks: r.value_checks.map((c) =>
      c.record_id !== "s7"
        ? c
        : {
            ...c,
            sources: c.sources.map((s, i) =>
              i === 1 ? { ...s, citation } : s,
            ),
          },
    ),
  };
}
async function changeBinding(
  patch: Record<string, unknown>,
): Promise<ProcessorResult> {
  const r = saved.result,
    input = r.invocation.inputs[0]!;
  if (input.kind !== "archive-document")
    throw new Error("Expected archive input");
  const invocation = {
    ...r.invocation,
    inputs: [{ ...input, parts: [{ ...input.parts[0]!, ...patch }] }],
  };
  return {
    ...r,
    invocation,
    comparison_sha256: await processorComparison(invocation),
  };
}

it("keeps all seven submitted claims, their mixed references and unavailable checks through publication and reads", async () => {
  expect(submissions).toBe(1);
  const calls = env.modelCalls;
  const r = saved.result;
  if (r.content.kind !== "report") throw new Error("Expected report");
  expect(
    r.content.claims.map((c) => ({ statement_id: c.record_id, text: c.text })),
  ).toEqual(
    statements.map(({ statement_id, text }) => ({ statement_id, text })),
  );
  expect(r.value_checks.slice(0, 6).map((c) => c.status)).toEqual(
    Array(6).fill("found"),
  );
  expect(r.value_checks[6]).toMatchObject({
    status: "citation-unavailable",
    sources: [
      { status: "found" },
      { status: "citation-unavailable", basis: null },
    ],
  });
  expect(missingCitation().evidence).toMatchObject({
    locator: { segment_id: absent },
    content_sha256: null,
  });
  const api: Pick<ApiClient, "processors"> = {
    processors: async (action, value, signal) => ({
      result: JSON.parse(
        JSON.stringify(await queryProcessors(env.app, action, value, signal)),
      ),
    }),
  };
  const web = await readProcessorResult(
    api,
    saved.ref,
    new AbortController().signal,
  );
  expect(web.result).toEqual(r);
  expect(
    (
      await resolveProcessorEvidence(
        api,
        missingCitation(),
        new AbortController().signal,
      )
    ).value,
  ).toMatchObject({ status: "citation-unavailable" });
  const resolved =
    await env.app.processorRead!.verifyCitation(missingCitation());
  expect(resolved).toMatchObject({
    value: {
      status: "citation-unavailable",
      reason: "corrected-fragment-unavailable",
    },
    evidence: [missingCitation().evidence],
    literature_ids: [env.parseRequest.literature_id],
  });
  const records = await env.app.processorRead!.records({
    kind: "result",
    input_id: "test",
    ...saved.ref,
    record_ids: null,
  });
  expect(records).toHaveLength(7);
  expect(
    (await env.app.processorRead!.verifyCitation(records[6]!.citation))
      .evidence,
  ).toContainEqual(missingCitation().evidence);
  const found = await env.app.processorRead!.search("synthetic");
  expect(
    found.items
      .filter((r) => r.record_id)
      .map((r) => r.record_id)
      .sort(),
  ).toEqual(statements.map((s) => s.statement_id));
  for (const format of ["json", "csv", "markdown"])
    expect(
      (await exportProcessorResult(env.app.processorRead!, saved, format))
        .content,
    ).toContain("citation-unavailable");
  const reopened = await env.openAnother();
  try {
    expect(
      (await reopened.processorRead!.byId(saved.ref.result_id))!.result,
    ).toEqual(r);
  } finally {
    await reopened.close();
  }
  expect(env.modelCalls).toBe(calls);
});

it("allows synthesis to retain upstream unavailable references without weakening its input scope", async () => {
  const snapshot = await env.app.snapshots.create({
    kind: "literatures",
    literature_ids: [env.parseRequest.literature_id],
  });
  env.setModel((input) => ({
    claims: [
      {
        text: "Combined synthetic finding",
        source_ids: (input.candidates as { id: string }[]).map((c) => c.id),
      },
    ],
  }));
  const run = await env.app.processors!.runBatch({
    schema_version: 1,
    idempotency_key: "synthesis-unavailable",
    name: "Synthetic synthesis",
    processor: { id: "knowledge-synthesis", version: "2" },
    spec: { question: "Compare", policy: "require-all" },
    inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
  });
  expect(run.failures).toEqual([]);
  const collection = await env.app.processorRead!.collection(
    String((run.collections[0] as { collection_id: string }).collection_id),
  );
  const ref = collection!.members[0]!.result!;
  const result = (await env.app.processorRead!.byId(ref.result_id))!.result;
  expect(result.value_checks[0]!.status).toBe("derived");
  const resolved = await env.app.processorRead!.verifyCitation({
    kind: "result",
    ...ref,
    record_id: "claim0",
    pointer: "/text",
  });
  expect(resolved.evidence).toContainEqual(missingCitation().evidence);
}, 0);

const invalidCases: [
  string,
  () => ProcessorResult | Promise<ProcessorResult>,
  string | null,
][] = [
  [
    "another fixed document",
    () => {
      const c = missingCitation();
      return replaceMissing({
        ...c,
        evidence: parseEvidenceRef({
          ...c.evidence,
          document_version_id: other.document_version_id,
          representation_sha256: other.representation_sha256,
        }),
      });
    },
    "processor-evidence-outside-scope",
  ],
  [
    "changed representation hash",
    () => {
      const c = missingCitation();
      return replaceMissing({
        ...c,
        evidence: parseEvidenceRef({
          ...c.evidence,
          representation_sha256: "0".repeat(64),
        }),
      });
    },
    "processor-invalid-evidence",
  ],
  [
    "existing segment without a hash",
    () => {
      const c = missingCitation();
      if (saved.result.content.kind !== "report")
        throw new Error("Expected report");
      const valid = saved.result.content.claims[0]!.sources[0]!;
      if (
        valid.kind !== "document" ||
        valid.evidence.target_kind !== "document"
      )
        throw new Error("Expected document");
      return replaceMissing({
        ...c,
        evidence: { ...valid.evidence, content_sha256: null },
      });
    },
    "processor-invalid-evidence",
  ],
  [
    "missing segment with a fabricated hash",
    () => {
      const c = missingCitation();
      return replaceMissing({
        ...c,
        evidence: parseEvidenceRef({
          ...c.evidence,
          content_sha256: "0".repeat(64),
        }),
      });
    },
    "document-invalid",
  ],
  [
    "existing segment with a tampered hash",
    () => {
      if (saved.result.content.kind !== "report")
        throw new Error("Expected report");
      const valid = saved.result.content.claims[0]!.sources[0]!;
      if (valid.kind !== "document") throw new Error("Expected document");
      return replaceMissing({
        ...valid,
        evidence: parseEvidenceRef({
          ...valid.evidence,
          content_sha256: "0".repeat(64),
        }),
      });
    },
    "document-integrity",
  ],
  [
    "unresolved segment with a fabricated page region",
    () => {
      const c = missingCitation();
      return replaceMissing({
        ...c,
        evidence: parseEvidenceRef({
          ...c.evidence,
          page_region: {
            scheme: "page-region-v1",
            segment_id: absent,
            page: 1,
            region: null,
          },
        }),
      });
    },
    "processor-invalid-evidence",
  ],
  [
    "changed asset binding",
    () => changeBinding({ asset_id: randomUUID() }),
    "processor-input-changed",
  ],
  [
    "changed asset hash",
    () => changeBinding({ asset_sha256: "0".repeat(64) }),
    "processor-input-changed",
  ],
  [
    "changed content version",
    () => changeBinding({ content_version: "0".repeat(64) }),
    "processor-input-changed",
  ],
  [
    "fabricated structure binding",
    () => changeBinding({ structure_annotation_id: "0".repeat(64) }),
    "processor-input-changed",
  ],
  [
    "wrong literature binding",
    async () => {
      const r = saved.result,
        invocation = {
          ...r.invocation,
          inputs: r.invocation.inputs.map((i) => ({
            ...i,
            literature_id: other.source_material_ref.literature_id,
          })),
        };
      return {
        ...r,
        invocation,
        comparison_sha256: await processorComparison(invocation),
      };
    },
    "processor-input-changed",
  ],
  [
    "illegal locator structure",
    () => {
      const c = missingCitation();
      if (c.evidence.target_kind !== "document")
        throw new Error("Expected segment");
      return replaceMissing({
        ...c,
        evidence: {
          ...c.evidence,
          locator: { kind: "segment", segment_id: "" },
        },
      });
    },
    null,
  ],
  [
    "forged found check",
    () => ({
      ...saved.result,
      value_checks: saved.result.value_checks.map((c) =>
        c.record_id !== "s7"
          ? c
          : {
              ...c,
              status: "found",
              sources: c.sources.map((s) => ({
                ...s,
                status: "found",
                basis: "text-layer",
              })),
            },
      ),
    }),
    null,
  ],
  [
    "external producer using the unresolved exception",
    () => ({ ...saved.result, producer: "external" }),
    "processor-evidence-outside-scope",
  ],
];

it.each(invalidCases)(
  "rejects %s before immutable publication and on hash-valid reread",
  async (_name, build, code) => {
    const result = await build();
    const rejection = store.publish(result);
    if (code) await expect(rejection).rejects.toMatchObject({ code });
    else await expect(rejection).rejects.toThrow();

    // This is an integrity-valid synthetic artifact. Only its catalog lookup is
    // substituted, so the test reaches scope validation instead of file hashing.
    const bytes = processorResultBytes(result);
    const artifact = {
      sha256: await sha256(bytes),
      byte_size: bytes.length,
      media_type: "application/json",
    };
    const reference = artifactReference("processor-result", artifact);
    const stage = await env.app.files.stage({ maxBytes: bytes.length });
    try {
      await stage.write(bytes);
      await env.app.files.publish(stage, reference);
    } finally {
      await stage.discard();
    }
    const original = env.app.database.processor.bind(env.app.database);
    const row = await original<Record<string, unknown>>(
      "get",
      saved.ref.result_id,
    );
    const spy = vi
      .spyOn(env.app.database, "processor")
      .mockImplementation(
        async <T>(
          action: ProcessorStorageAction,
          args: unknown,
          signal?: AbortSignal,
        ): Promise<T> => {
          if (action === "get" && args === saved.ref.result_id)
            return {
              ...row,
              producer: result.producer,
              comparison_sha256: result.comparison_sha256,
              content_reference: reference,
              content_sha256: artifact.sha256,
              content_size: bytes.length,
            } as T;
          return original<T>(action, args, signal);
        },
      );
    try {
      if (code)
        await expect(store.byId(saved.ref.result_id)).rejects.toMatchObject({
          code,
        });
      else await expect(store.byId(saved.ref.result_id)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect((await store.byId(saved.ref.result_id))!.ref).toEqual(saved.ref);
  },
);

it("keeps the method identity current while existing result bytes remain unchanged", async () => {
  expect(
    documentAnalysisParameters(undefined, "synthetic-binding"),
  ).toMatchObject({ method_version: "2" });
  expect(await parseProcessorResult(saved.result)).toEqual(saved.result);
  expect(
    await sha256(
      processorResultBytes(
        (await env.app.processorRead!.byId(saved.ref.result_id))!.result,
      ),
    ),
  ).toBe(saved.ref.content_sha256);
});
