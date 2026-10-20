import { expect, it } from "vitest";
import {
  parseKnowledgeContextBundle,
  parseKnowledgeContextRequest,
} from "../src/knowledge-context.js";
const lit = "00000000-0000-0000-0000-000000000001",
  result = "00000000-0000-0000-0000-000000000002",
  hash = "a".repeat(64);
const request = {
  schema_version: 3,
  query: "catalyst",
  scope: { kind: "literatures", literature_ids: [lit] },
  kinds: ["metadata", "document", "knowledge"],
  versions: { kind: "default" },
  budget: { max_items: 5, max_bytes: 4096, token_limit: null },
  continuation: null,
};
function count<T extends { usage: { bytes: number } }>(value: T): T {
  let result = value;
  for (let i = 0; i < 10; i++) {
    const n = Buffer.byteLength(JSON.stringify(result));
    if (n === result.usage.bytes) return result;
    result = { ...result, usage: { ...result.usage, bytes: n } };
  }
  throw new Error("Byte accounting did not converge");
}
const item = {
  kind: "generated-result",
  reference: {
    kind: "result",
    result_id: result,
    content_sha256: hash,
    record_id: "claim-1",
  },
  processor_id: "summary",
  source_literature_ids: [lit],
  text: "A reported catalyst result.",
  evidence: [],
  rank: 1,
  score: 0,
  gap: null,
};
function bundle(items: unknown[] = [item]) {
  return count({
    schema_version: 3,
    score_rule: "sources-then-results-v1",
    items,
    coverage: "complete",
    gaps: [],
    usage: { bytes: 0, items: items.length, tokens: null, tokenizer: null },
    truncated: false,
    continuation: null,
  });
}
it("accepts fixed processor result references and rejects retired artifact requests", () => {
  const selected = parseKnowledgeContextRequest(request);
  expect(
    parseKnowledgeContextBundle(bundle(), selected).items[0]!.reference,
  ).toEqual(item.reference);
  expect(() =>
    parseKnowledgeContextRequest({
      ...request,
      schema_version: 2,
      knowledge: {
        purposes: ["overview"],
        question: null,
        selection: "all",
        artifact_ids: [],
      },
    }),
  ).toThrow();
  expect(() =>
    parseKnowledgeContextRequest({
      ...request,
      scope: { kind: "artifacts", artifact_ids: [result] },
    }),
  ).toThrow();
  expect(() =>
    parseKnowledgeContextRequest({
      ...request,
      kinds: ["knowledge", "knowledge"],
    }),
  ).toThrow();
});
it.each([
  { ...item, reference: { ...item.reference, result_id: "bad" } },
  { ...item, reference: { ...item.reference, artifact_id: result } },
  { ...item, reference: { ...item.reference, content_sha256: "wrong" } },
  { ...item, source_literature_ids: [result] },
  { ...item, rank: 2 },
  { ...item, evidence: [{ locator: "invented" }] },
  { ...item, text: "x".repeat(6000) },
])(
  "rejects malformed identities, out-of-scope content and oversized responses %#",
  (value) => {
    expect(() =>
      parseKnowledgeContextBundle(
        bundle([value]),
        parseKnowledgeContextRequest(request),
      ),
    ).toThrow();
  },
);
it("verifies actual response bytes and keeps source kind selection closed", () => {
  const selected = parseKnowledgeContextRequest(request),
    valid = bundle();
  expect(() =>
    parseKnowledgeContextBundle(
      { ...valid, usage: { ...valid.usage, bytes: valid.usage.bytes + 1 } },
      selected,
    ),
  ).toThrow();
  expect(() =>
    parseKnowledgeContextBundle(
      valid,
      parseKnowledgeContextRequest({ ...request, kinds: ["document"] }),
    ),
  ).toThrow();
});

it("rejects inconsistent continuation, truncation and coverage even with correct byte accounting", () => {
  const selected = parseKnowledgeContextRequest(request);
  for (const patch of [
    { truncated: true },
    { continuation: "cursor" },
    { coverage: "partial" },
    { gaps: [{ code: "missing", literature_id: null }] },
  ])
    expect(() =>
      parseKnowledgeContextBundle(count({ ...bundle(), ...patch }), selected),
    ).toThrow();
});
