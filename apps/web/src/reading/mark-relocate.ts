import {
  MARK_LOCATE_METHOD,
  type MarkPlace,
  type MarkTarget,
  type ReadingMark,
} from "@sciretriever/contracts";
import { APPROXIMATE, PLACE, canon, locate } from "./mark-locate.js";

/**
 * Finding a mark again on another material (user organization 9.4): another
 * PDF of the same part, or another version of its text. The comparison and
 * its thresholds are mark-locate's (5.3); this decides when to look, reads
 * what was recorded, and grades what was found. Pure: no request, no DOM.
 */
export type Grade = "place" | "near" | "none";
export const grade = (similarity: number): Grade =>
  similarity >= PLACE ? "place" : similarity >= APPROXIMATE ? "near" : "none";

/** The material a mark is shown on: a PDF by its bytes, or a text version. */
export type Material =
  | { kind: "pdf"; sha256: string }
  | { kind: "document"; version: string };

/** The mark's own anchor on this material, if it has one: then nothing is looked for. */
export function ownAnchor(mark: ReadingMark, on: Material) {
  return on.kind === "pdf"
    ? mark.pdf?.sha256 === on.sha256
    : mark.document?.document_version_id === on.version;
}
/** What was recorded for this material under the current method, if anything. */
export function recordedPlace(
  mark: ReadingMark,
  on: Material,
): MarkPlace | null {
  return (
    mark.places.find(
      (p) =>
        p.method === MARK_LOCATE_METHOD &&
        (on.kind === "pdf"
          ? "pdf" in p.target && p.target.pdf.sha256 === on.sha256
          : "document" in p.target &&
            p.target.document.document_version_id === on.version),
    ) ?? null
  );
}
/**
 * Whether to look for the mark on this material: a highlight (a region has
 * no words to look for), without its own anchor or a recorded place there,
 * on a material of its own part (9.4 “只在同一部分里找”).
 */
export function wantsSearch(
  mark: ReadingMark,
  on: Material,
  samePart: boolean,
): boolean {
  return (
    mark.kind === "highlight" &&
    !!mark.quote.trim() &&
    samePart &&
    !ownAnchor(mark, on) &&
    !recordedPlace(mark, on)
  );
}
/** The paper's parts, by PDF bytes and by text version (9.4 “只在同一部分里找”). */
export interface PartMap {
  pdf: ReadonlyMap<string, string>;
  version: ReadonlyMap<string, string>;
}
/**
 * The mark's part (9.4): the asset its PDF anchor names, by that asset's
 * role (a PDF no longer in the paper counts as the main one); else the
 * asset its text version belongs to. Null when that cannot be told: such a
 * mark is not looked for anywhere (nothing is guessed).
 */
export function partOf(mark: ReadingMark, parts: PartMap): string | null {
  if (mark.pdf) return parts.pdf.get(mark.pdf.sha256) ?? "main";
  if (mark.document)
    return parts.version.get(mark.document.document_version_id) ?? null;
  return null;
}
/**
 * Text versions' parts from what `document describe` said of each (its
 * `source_material_ref`): the paper's main PDF is “main”, a supplement its
 * own part; an asset no longer in the paper is left out (not looked for).
 */
export function versionParts(
  described: readonly { version: string; assetId: string }[],
  assets: { primary: string | null; additional: readonly string[] },
): Map<string, string> {
  const parts = new Map<string, string>();
  for (const { version, assetId } of described)
    if (assetId === assets.primary) parts.set(version, "main");
    else if (assets.additional.includes(assetId))
      parts.set(version, `part-${assetId}`);
  return parts;
}
/** Whether the mark belongs to the part shown; false when its part is unknown. */
export function samePart(
  mark: ReadingMark,
  shown: string,
  parts: PartMap,
): boolean {
  const part = partOf(mark, parts);
  return part !== null && part === shown;
}
export interface Relocated {
  /** Positions in the canonical text searched. */
  start: number;
  end: number;
  similarity: number;
  grade: Exclude<Grade, "none">;
  method: typeof MARK_LOCATE_METHOD;
}
/** Looks for the mark's words in a material's canonical text; null when not found. */
export function relocate(
  mark: Pick<ReadingMark, "quote" | "quote_prefix" | "quote_suffix">,
  text: string,
): Relocated | null {
  const hit = locate(canon(mark.quote), text, {
    prefix: mark.quote_prefix,
    suffix: mark.quote_suffix,
  });
  if (!hit) return null;
  const g = grade(hit.sim);
  if (g === "none") return null;
  return {
    start: hit.start,
    end: hit.end,
    similarity: Math.round(hit.sim * 1000) / 1000,
    grade: g,
    method: MARK_LOCATE_METHOD,
  };
}
/** What `place` records for a mark found on a material. */
export function placeRequest(
  markId: string,
  target: MarkTarget,
  similarity: number,
) {
  return {
    operation: "place" as const,
    request: {
      mark_id: markId,
      target,
      similarity,
      method: MARK_LOCATE_METHOD,
    },
  };
}
