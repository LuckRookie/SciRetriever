import type { ProcessorObject } from "@sciretriever/contracts";
import type { ProcessorSegment } from "./processor.js";
export const PROCESSOR_CHUNKING = {
  method: "hierarchical-atomic-text-v2",
  utf8_bytes_per_token: 1,
  maximum_input_tokens: 200000,
  default_context_tokens: 1000000,
  prompt_reserve_tokens: 8192,
  default_output_reserve_tokens: 16384,
  boundaries: ["heading-1", "heading-2-to-6", "paragraph"],
  atomic: [
    "table-caption-footnotes",
    "image-caption",
    "continued-table",
    "equation",
  ],
} as const;
export function chunkOutputReserve(model: ProcessorObject | null) {
  const limit = model?.max_output_tokens;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0
    ? Math.min(PROCESSOR_CHUNKING.default_output_reserve_tokens, limit)
    : PROCESSOR_CHUNKING.default_output_reserve_tokens;
}
export function chunkTokenLimit(
  model: ProcessorObject | null,
  extraPromptBytes = 0,
) {
  const positive = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : fallback;
  const context = positive(
      model?.context_window_tokens,
      PROCESSOR_CHUNKING.default_context_tokens,
    ),
    output = chunkOutputReserve(model);
  return Math.max(
    0,
    Math.min(
      PROCESSOR_CHUNKING.maximum_input_tokens,
      context -
        Math.max(PROCESSOR_CHUNKING.prompt_reserve_tokens, extraPromptBytes) -
        output,
    ),
  );
}
export function chunkHeading(segments: readonly ProcessorSegment[]) {
  const paths = segments.map((s) => s.section_path ?? []),
    first = paths[0] ?? [];
  const common = first.filter((title, i) =>
    paths.every(
      (p) => p[i] === title && p.slice(0, i).every((t, j) => t === first[j]),
    ),
  );
  return {
    document_title: segments[0]?.document_title ?? "",
    section_path: common.length ? common.join(" > ") : "全文",
  };
}
const size = (segments: readonly ProcessorSegment[]) =>
  Buffer.byteLength(
    JSON.stringify({
      ...chunkHeading(segments),
      segments: segments.map((s) => ({
        segment_id: s.segment_id,
        text: s.text,
        basis: s.basis ?? null,
      })),
    }),
  );
/** Conservative grouping: a larger indivisible unit is safer than a severed table note. */
function atoms(segments: readonly ProcessorSegment[]) {
  const groups: ProcessorSegment[][] = [];
  for (const s of segments) {
    const previous = groups.at(-1),
      last = previous?.at(-1);
    const samePart = last?.part_key === s.part_key;
    const adjacent =
      last?.page !== undefined &&
      s.page !== undefined &&
      s.page >= last.page &&
      s.page <= last.page + 1;
    const anchored = previous?.some(
      (p) => p.kind === "table" || p.kind === "image",
    );
    const caption = previous?.every((p) => p.kind === "caption");
    const join =
      !!last &&
      samePart &&
      ((anchored && (s.kind === "caption" || s.kind === "footnote")) ||
        (caption && (s.kind === "table" || s.kind === "image")) ||
        (adjacent &&
          s.kind === "table" &&
          previous!.some((p) => p.kind === "table")));
    if (join) previous!.push(s);
    else groups.push([s]);
  }
  return groups;
}
/** Select whole material units so a search hit cannot detach its caption or notes. */
export function selectProcessorText(
  segments: readonly ProcessorSegment[],
  query: string,
) {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return atoms(segments)
    .filter((group) =>
      group.some((segment) =>
        terms.some((term) => segment.text.toLowerCase().includes(term)),
      ),
    )
    .flat();
}
export function splitProcessorText(
  segments: readonly ProcessorSegment[],
  limit: number,
) {
  const pieces: ProcessorSegment[][] = [],
    gaps: string[] = [];
  const divide = (groups: ProcessorSegment[][], level: number): void => {
    const all = groups.flat();
    if (!all.length) return;
    if (size(all) <= limit) {
      pieces.push(all);
      return;
    }
    if (groups.length === 1) {
      gaps.push(`unit-too-large:${all[0]!.segment_id}`);
      return;
    }
    if (level > 6) {
      for (const g of groups) divide([g], 7);
      return;
    }
    const sections: ProcessorSegment[][][] = [];
    for (const g of groups) {
      if (!sections.length || g.some((s) => s.heading_level === level))
        sections.push([]);
      sections.at(-1)!.push(g);
    }
    for (const section of sections) divide(section, level + 1);
  };
  divide(atoms(segments), 1);
  const chunks: ProcessorSegment[][] = [];
  for (const piece of pieces) {
    const prev = chunks.at(-1);
    if (prev && size([...prev, ...piece]) <= limit) prev.push(...piece);
    else chunks.push([...piece]);
  }
  return { chunks, gaps };
}
