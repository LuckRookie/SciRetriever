import {
  parseIdentifier,
  type DocumentStructureV2,
  type DocumentPartRole,
  type SectionRole,
  type DocumentBasis,
} from "@sciretriever/contracts";
import type { AssignedSection } from "./section-rules.js";
type Segment = Pick<
  DocumentStructureV2["segments"][number],
  "start_utf8" | "end_utf8"
>;
const decode = (bytes: Uint8Array, s: Segment) =>
  new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(s.start_utf8, s.end_utf8),
  );
import type {
  SegmentRole,
  StructureFigure,
  StructureReference,
} from "@sciretriever/contracts";
export type {
  SegmentRole,
  StructureFigure,
  StructureReference,
} from "@sciretriever/contracts";
export function segmentRoles(
  structure: DocumentStructureV2,
  markdown: Uint8Array,
  sections: readonly AssignedSection[],
  part: DocumentPartRole,
): readonly SegmentRole[] {
  const assigned = new Map(sections.map((s) => [s.section_id, s.role]));
  return structure.segments.map((segment) => {
    let role: SectionRole =
      segment.section_id === null
        ? part === "main"
          ? "front-matter"
          : "body"
        : (assigned.get(segment.section_id) ?? "body");
    if (role === "front-matter") {
      const text = decode(markdown, segment).trim();
      if (/^(?:\*\*|__)?(?:abstract|摘要)(?:\*\*|__)?\s*[:：.\n]/iu.test(text))
        role = "abstract";
      else if (
        /^(?:\*\*|__)?(?:key\s*words|关键词|关键字)(?:\*\*|__)?\s*[:：.\n]/iu.test(
          text,
        )
      )
        role = "keywords";
    }
    return {
      segment_id: segment.segment_id,
      section_id: segment.section_id,
      role,
    };
  });
}
export function structureFigures(
  structure: DocumentStructureV2,
  markdown: Uint8Array,
): readonly StructureFigure[] {
  const result: StructureFigure[] = [],
    usedCaptions = new Set<string>();
  const parseLabel = (text: string) =>
    /^\s*((?:fig(?:ure)?s?\.?|table|scheme|图|表|图式)\s*S?\d+(?:[a-z])?)(?=[\s.:：．)-]|$)/iu.exec(
      text,
    )?.[1] ?? null;
  for (const [index, segment] of structure.segments.entries()) {
    if (segment.kind !== "image" && segment.kind !== "table") continue;
    const caption =
      [structure.segments[index + 1], structure.segments[index - 1]].find(
        (candidate) => {
          if (
            candidate?.kind !== "caption" ||
            usedCaptions.has(candidate.segment_id)
          )
            return false;
          const label = parseLabel(decode(markdown, candidate));
          return (
            !label ||
            /^(?:table|表)/iu.test(label) === (segment.kind === "table")
          );
        },
      ) ?? null;
    if (caption) usedCaptions.add(caption.segment_id);
    const label = caption ? parseLabel(decode(markdown, caption)) : null;
    result.push({
      object_segment_id: segment.segment_id,
      caption_segment_id: caption?.segment_id ?? null,
      kind:
        segment.kind === "table"
          ? "table"
          : label && /^(?:scheme|图式)/iu.test(label)
            ? "scheme"
            : "figure",
      label,
      page: segment.page,
    });
  }
  return result;
}

function referenceDoi(text: string): string | null {
  const values = new Set<string>();
  for (const match of text.matchAll(/10\.\d{4,9}\/[^\s<>"{}[\]]+/giu)) {
    let value = match[0].replace(/[.,;:]+$/u, "");
    while (
      value.endsWith(")") &&
      (value.match(/\)/gu)?.length ?? 0) > (value.match(/\(/gu)?.length ?? 0)
    )
      value = value.slice(0, -1);
    try {
      values.add(parseIdentifier({ namespace: "doi", value }).value);
    } catch {
      /* Non-identifiers remain visible in the raw citation text. */
    }
  }
  return values.size === 1 ? [...values][0]! : null;
}
/** Numbered entries can continue in later reference blocks; otherwise each block is its own unnumbered entry. */
export function structureReferences(
  structure: DocumentStructureV2<DocumentBasis>,
  markdown: Uint8Array,
  roles: readonly SegmentRole[],
): readonly StructureReference[] {
  const byId = new Map(roles.map((r) => [r.segment_id, r.role]));
  const rows: { text: string; segment_ids: string[]; numbered: boolean }[] = [];
  let section: string | null | undefined = undefined;
  for (const segment of structure.segments) {
    const role = byId.get(segment.segment_id);
    if (
      (role !== "references" && role !== "si-references") ||
      segment.kind === "heading" ||
      !["reference-item", "list", "text"].includes(segment.kind)
    )
      continue;
    const sameSection = section === segment.section_id;
    section = segment.section_id;
    const text = decode(markdown, segment).trim();
    if (!text) continue;
    const positions = [
      ...text.matchAll(/(?:^|\n)\s*(?:\[\d+\]|\(\d+\)|\d+[.)])\s+(?=\S)/gu),
    ].map((m) => m.index!);
    if (positions.length) {
      const prelude = text.slice(0, positions[0]).trim();
      if (prelude) {
        const prior = rows.at(-1);
        if (sameSection && prior?.numbered) {
          prior.text += `\n${prelude}`;
          if (!prior.segment_ids.includes(segment.segment_id))
            prior.segment_ids.push(segment.segment_id);
        } else
          rows.push({
            text: prelude,
            segment_ids: [segment.segment_id],
            numbered: false,
          });
      }
      for (const [i, start] of positions.entries())
        rows.push({
          text: text.slice(start, positions[i + 1] ?? text.length).trim(),
          segment_ids: [segment.segment_id],
          numbered: true,
        });
    } else {
      const prior = rows.at(-1);
      if (sameSection && prior?.numbered) {
        prior.text += `\n${text}`;
        if (!prior.segment_ids.includes(segment.segment_id))
          prior.segment_ids.push(segment.segment_id);
      } else
        rows.push({ text, segment_ids: [segment.segment_id], numbered: false });
    }
  }
  return rows.map((r, reference_index) => ({
    reference_index,
    text: r.text,
    segment_ids: r.segment_ids,
    doi: referenceDoi(r.text),
  }));
}
export function structureSatisfied(
  part: DocumentPartRole,
  sections: readonly AssignedSection[],
): boolean {
  return (
    part === "main" &&
    sections.some((s) =>
      [
        "body",
        "introduction",
        "methods",
        "results",
        "results-discussion",
        "discussion",
      ].includes(s.role),
    )
  );
}
