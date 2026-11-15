import { expect, it } from "vitest";
import {
  parseMaterialContextBundle,
  parseMaterialContextRequest,
} from "../src/index.js";

const id = "00000000-0000-0000-0000-000000000001";
const request = parseMaterialContextRequest({
  query: "synthetic",
  scope: { kind: "library" },
  kinds: ["metadata"],
  versions: { kind: "default" },
  budget: { max_items: 10, max_bytes: 65536, token_limit: null },
  continuation: null,
});
function counted<T extends { usage: { bytes: number } }>(value: T): T {
  let next = value;
  for (let i = 0; i < 10; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(next));
    if (bytes === next.usage.bytes) return next;
    next = { ...next, usage: { ...next.usage, bytes } };
  }
  throw Error("byte-count-unstable");
}
const fixture = () => ({
  score_rule: "weighted-term-frequency-v1",
  coverage: "index-stale",
  generation_id: id,
  source_revision: 10,
  indexed_revision: 9,
  items: [
    {
      kind: "metadata",
      literature_id: id,
      meta_literature_id: id,
      reference: {
        kind: "metadata",
        literature_id: id,
        metadata_revision: 1,
        metadata_sha256: "a".repeat(64),
      },
      section_title: null,
      text: "Synthetic source",
      evidence: [],
      rank: 1,
      score: -1,
      gap: null,
    },
  ],
  gaps: [{ code: "index-stale", literature_id: id }],
  usage: { items: 1, bytes: 0, tokens: null, tokenizer: null },
  truncated: true,
  continuation: "c3ludGhldGlj",
});
it("accepts verified items, continuation and bounded stale-source gaps with both watermarks", () => {
  const value = counted(fixture());
  expect(parseMaterialContextBundle(value, request)).toEqual(value);
});
it("parses optional grades only on source-text hits and preserves their fixed document reference", () => {
  const selected = parseMaterialContextRequest({
    ...request,
    kinds: ["document"],
  });
  const original = fixture();
  const item = {
    ...original.items[0]!,
    kind: "source-text",
    reference: {
      kind: "document",
      literature_id: id,
      document_version_id: id,
      representation_sha256: "a".repeat(64),
      asset_id: id,
      asset_sha256: "b".repeat(64),
      start_utf8: 0,
      end_utf8: 16,
    },
    evidence: [
      {
        schema_version: 1,
        target_kind: "document",
        locator_scheme: "utf8-segment-v1",
        document_version_id: id,
        representation_sha256: "a".repeat(64),
        locator: { kind: "segment", segment_id: "s1" },
        content_sha256: null,
      },
    ],
  };
  const legacy = counted({ ...original, items: [item] });
  expect(parseMaterialContextBundle(legacy, selected)).toEqual(legacy);
  for (const text_level of ["draft", "proofread"]) {
    const value = counted({ ...original, items: [{ ...item, text_level }] });
    expect(parseMaterialContextBundle(value, selected)).toEqual(value);
  }
  for (const text_level of ["raw", null, undefined])
    expect(() =>
      parseMaterialContextBundle(
        counted({ ...original, items: [{ ...item, text_level }] }),
        selected,
      ),
    ).toThrow();
  expect(() =>
    parseMaterialContextBundle(
      counted({
        ...original,
        items: [{ ...original.items[0]!, text_level: "draft" }],
      }),
      request,
    ),
  ).toThrow();
});
it("retains strict negative, byte, itemless-error and gap-limit validation", () => {
  for (const change of [
    { indexed_revision: -1 },
    { coverage: "index-corrupt" },
    {
      gaps: Array.from({ length: 33 }, () => ({
        code: "index-stale",
        literature_id: id,
      })),
    },
    { gaps: [{ code: "silently-skipped", literature_id: id }] },
  ])
    expect(() =>
      parseMaterialContextBundle(counted({ ...fixture(), ...change }), request),
    ).toThrow();
  const value = counted(fixture());
  expect(() =>
    parseMaterialContextBundle(
      { ...value, usage: { ...value.usage, bytes: 0 } },
      request,
    ),
  ).toThrow();
});
