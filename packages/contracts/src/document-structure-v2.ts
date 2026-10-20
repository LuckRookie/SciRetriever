import {
  ContractValidationError,
  parsePageRegion,
  type PageRegion,
} from "./index.js";
import type {
  ProofreadSource,
  ProofreadBasis,
  ProofreadUncertainty,
} from "./proofread.js";
export const PROOFREAD_SEGMENT_KINDS = [
  "heading",
  "text",
  "table",
  "caption",
  "equation",
  "image",
  "reference-item",
  "list",
  "footnote",
] as const;
export type ProofreadSegmentKind = (typeof PROOFREAD_SEGMENT_KINDS)[number];
/** Stored page indices are zero based. Human-facing evidence readers display page + 1. */
export interface DocumentStructureV2 {
  readonly schema_version: 2;
  readonly text_encoding: "utf8";
  readonly page_count: number;
  readonly sections: readonly {
    readonly section_id: string;
    readonly title: string;
    readonly level: number;
    readonly start_utf8: number;
    readonly end_utf8: number;
    readonly role: null;
    readonly role_source: null;
  }[];
  readonly segments: readonly {
    readonly segment_id: string;
    readonly block_id: string;
    readonly kind: ProofreadSegmentKind;
    readonly section_id: string | null;
    readonly start_utf8: number;
    readonly end_utf8: number;
    readonly page: number;
    readonly region: PageRegion | null;
    readonly continuation_regions: readonly {
      readonly page: number;
      readonly region: PageRegion;
    }[];
    readonly locate: "region" | "page";
    readonly source: ProofreadSource;
    readonly basis: ProofreadBasis;
    readonly uncertainty: ProofreadUncertainty | null;
  }[];
}
function fail(): never {
  throw new ContractValidationError();
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    fail();
  return Number(value);
}
function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/u.test(value)
  )
    fail();
  return value;
}
export function parseDocumentStructureV2(
  value: unknown,
  markdownBytes: number,
): DocumentStructureV2 {
  const r = object(value, [
    "schema_version",
    "text_encoding",
    "page_count",
    "sections",
    "segments",
  ]);
  if (
    r.schema_version !== 2 ||
    r.text_encoding !== "utf8" ||
    !Array.isArray(r.sections) ||
    !Array.isArray(r.segments) ||
    r.sections.length > 100000 ||
    r.segments.length > 100000
  )
    fail();
  integer(markdownBytes, 1, 8 * 1024 * 1024);
  const pages = integer(r.page_count, 1, 10000);
  const sections = r.sections.map(
    (value): DocumentStructureV2["sections"][number] => {
      const s = object(value, [
        "section_id",
        "title",
        "level",
        "start_utf8",
        "end_utf8",
        "role",
        "role_source",
      ]);
      if (
        typeof s.title !== "string" ||
        s.title.length > 65536 ||
        s.role !== null ||
        s.role_source !== null
      )
        fail();
      const start = integer(s.start_utf8, 0, markdownBytes),
        end = integer(s.end_utf8, start + 1, markdownBytes);
      return {
        section_id: token(s.section_id),
        title: s.title,
        level: integer(s.level, 1, 6),
        start_utf8: start,
        end_utf8: end,
        role: null,
        role_source: null,
      };
    },
  );
  const byId = new Map(sections.map((s) => [s.section_id, s]));
  if (byId.size !== sections.length) fail();
  const stack: typeof sections = [];
  for (const s of sections) {
    if (stack.at(-1) && s.start_utf8 <= stack.at(-1)!.start_utf8) fail();
    while (stack.length && s.start_utf8 >= stack.at(-1)!.end_utf8) stack.pop();
    if (
      stack.length &&
      (s.end_utf8 > stack.at(-1)!.end_utf8 || s.level <= stack.at(-1)!.level)
    )
      fail();
    stack.push(s);
  }
  const segments = r.segments.map(
    (value): DocumentStructureV2["segments"][number] => {
      const s = object(value, [
        "segment_id",
        "block_id",
        "kind",
        "section_id",
        "start_utf8",
        "end_utf8",
        "page",
        "region",
        "continuation_regions",
        "locate",
        "source",
        "basis",
        "uncertainty",
      ]);
      if (
        !PROOFREAD_SEGMENT_KINDS.includes(s.kind as ProofreadSegmentKind) ||
        !["parser", "rule", "agent", "manual"].includes(String(s.source)) ||
        !Array.isArray(s.continuation_regions)
      )
        fail();
      if (
        !["text-layer", "image-only", "uncertain", "manual"].includes(
          String(s.basis),
        )
      )
        fail();
      let uncertainty: ProofreadUncertainty | null = null;
      if (s.uncertainty !== null) {
        const u = object(s.uncertainty, ["span", "reason", "page"]);
        if (
          !Array.isArray(u.span) ||
          u.span.length !== 2 ||
          typeof u.reason !== "string" ||
          !u.reason.trim()
        )
          fail();
        const start = integer(u.span[0], 0, 4 * 1024 * 1024),
          end = integer(u.span[1], start, 4 * 1024 * 1024);
        uncertainty = {
          span: [start, end],
          reason: u.reason,
          page: integer(u.page, 0, pages - 1),
        };
      }
      if ((s.basis === "uncertain") !== (uncertainty !== null)) fail();
      if (s.locate !== (s.region === null ? "page" : "region")) fail();
      const start = integer(s.start_utf8, 0, markdownBytes),
        end = integer(s.end_utf8, start + 1, markdownBytes),
        section = s.section_id === null ? null : token(s.section_id);
      if (section !== null) {
        const parent = byId.get(section);
        if (!parent || start < parent.start_utf8 || end > parent.end_utf8)
          fail();
      }
      const page = integer(s.page, 0, pages - 1);
      const continuation = s.continuation_regions.map((value) => {
        const c = object(value, ["page", "region"]);
        return {
          page: integer(c.page, page, pages - 1),
          region: parsePageRegion(c.region),
        };
      });
      return {
        segment_id: token(s.segment_id),
        block_id: token(s.block_id),
        kind: s.kind as ProofreadSegmentKind,
        section_id: section,
        start_utf8: start,
        end_utf8: end,
        page,
        region: s.region === null ? null : parsePageRegion(s.region),
        continuation_regions: continuation,
        locate: s.region === null ? "page" : "region",
        source: s.source as ProofreadSource,
        basis: s.basis as ProofreadBasis,
        uncertainty,
      };
    },
  );
  if (
    new Set(segments.map((s) => s.segment_id)).size !== segments.length ||
    new Set(segments.map((s) => s.block_id)).size !== segments.length
  )
    fail();
  for (let i = 1; i < segments.length; i++)
    if (
      segments[i]!.start_utf8 < segments[i - 1]!.end_utf8 ||
      segments[i]!.page < segments[i - 1]!.page
    )
      fail();
  return {
    schema_version: 2,
    text_encoding: "utf8",
    page_count: pages,
    sections,
    segments,
  };
}
