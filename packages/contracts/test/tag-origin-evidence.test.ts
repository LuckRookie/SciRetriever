import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseLiteratureSearchItem } from "../src/index.js";
import { parseTagAssignmentDetail } from "../src/tags.js";

const id = "00000000-0000-0000-0000-000000000001",
  tag = "00000000-0000-4000-8000-000000000002",
  doc = "00000000-0000-4000-8000-000000000003";

it("accepts listed tags with or without origin, lock and evidence count", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/compat-v1/records.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const { document_type: legacy, ...metadata } = fixture.metadata as Record<
    string,
    unknown
  >;
  void legacy;
  const item = {
    literature: {
      literature_id: id,
      meta_literature_id: id,
      version_role: "published",
      metadata: {
        ...metadata,
        publication_form: "journal-article",
        article_kind: null,
      },
      status: "UNREVIEWED",
    },
    metadata_revision: 1,
    metadata_sha256: "a".repeat(64),
    missing_step: "primary-pdf",
    needs_manual_pdf: false,
  };
  const old = { tag_id: tag, name: "Topic", rank: 1 },
    full = { ...old, origin: "backfill", locked: false, evidence_count: 3 };
  expect(parseLiteratureSearchItem({ ...item, tags: [old] }).tags).toEqual([
    old,
  ]);
  expect(parseLiteratureSearchItem({ ...item, tags: [full] }).tags).toEqual([
    full,
  ]);
  for (const bad of [
    { ...full, origin: "model" },
    { ...full, locked: 1 },
    { ...full, evidence_count: -1 },
    { ...full, extra: true },
  ])
    expect(() => parseLiteratureSearchItem({ ...item, tags: [bad] })).toThrow();
});

it("parses an assignment detail, its empty form and a coherent stale flag", () => {
  const empty = {
    literature_id: id,
    current_document_version_id: null,
    revision: null,
    vocab_version: null,
    model: null,
    items: [],
  };
  expect(parseTagAssignmentDetail(empty)).toEqual(empty);
  const detail = {
    ...empty,
    current_document_version_id: doc,
    revision: 2,
    vocab_version: 4,
    items: [
      {
        tag_id: tag,
        rank: 1,
        reason: "Why",
        evidence: [
          { document_version_id: doc, segment_ids: ["s1"], stale: false },
        ],
        origin: "auto",
        locked: false,
        evidence_stale: false,
      },
    ],
  };
  expect(parseTagAssignmentDetail(detail)).toEqual(detail);
  expect(() =>
    parseTagAssignmentDetail({
      ...detail,
      items: [{ ...detail.items[0], evidence_stale: true }],
    }),
  ).toThrow();
  expect(() =>
    parseTagAssignmentDetail({ ...empty, items: detail.items }),
  ).toThrow();
});
