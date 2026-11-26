import {
  LAYERS_OUTLINE_MAX_LIMIT,
  LAYERS_POINTS_MAX,
  parseDocumentLayersRequest,
  parseDocumentLayersResult,
  type DocumentLayersOutlineResult,
  type DocumentLayersOverviewResult,
  type DocumentLayersSummary,
  type DocumentSliceText,
  type LayersPart,
} from "@sciretriever/contracts";
import type { ReadingContext } from "../contract.js";

/** A point with its evidence, as the outline part gives it. */
export type ReadLayersPoint = DocumentLayersOutlineResult["points"][number];
/** One version's reading layers as the page shows them: everything, read once. */
export interface ReadLayers {
  readonly versionId: string;
  /** `bilingual` when the layers have a translation part: all three readings from one read. */
  readonly text: DocumentSliceText;
  readonly overview: DocumentLayersOverviewResult;
  readonly points: readonly ReadLayersPoint[];
}
/** Kept for the session (spec 5.1): a version's layers never change. */
const kept = new Map<string, Promise<ReadLayers>>();
const KEEP = 24;
/**
 * Reads the layers of a version (technical 04 §10.7): the `overview` part in
 * one read, then the `outline` part page by page (50 points a page) until it
 * is all there. With a translation part it reads `bilingual`, which carries
 * the original and the translation, so switching readings reads nothing.
 */
export function readLayers(
  ctx: Pick<ReadingContext, "api" | "signal">,
  versionId: string,
  summary: DocumentLayersSummary,
): Promise<ReadLayers> {
  const text: DocumentSliceText = summary.target_language
    ? "bilingual"
    : "original";
  const key = `${versionId}|${text}`;
  const known = kept.get(key);
  if (known) {
    kept.delete(key);
    kept.set(key, known);
    return known;
  }
  const read = (async () => {
    const ask = async (part: LayersPart, cursor: string | null) => {
      const request = parseDocumentLayersRequest({
        document_version_id: versionId,
        part,
        text,
        format: "json",
        limit: LAYERS_OUTLINE_MAX_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      });
      return parseDocumentLayersResult(
        (await ctx.api.query("document-layers", request, ctx.signal)).result,
        request,
      );
    };
    const overview = await ask("overview", null);
    if (overview.format !== "json" || overview.part !== "overview")
      throw new Error("阅读层回执无效：overview");
    const points: ReadLayersPoint[] = [];
    let cursor: string | null = null;
    do {
      const page = await ask("outline", cursor);
      if (page.format !== "json" || page.part !== "outline")
        throw new Error("阅读层回执无效：outline");
      points.push(...page.points);
      cursor = page.next_cursor;
      if (points.length > LAYERS_POINTS_MAX)
        throw new Error("阅读层的要点超过上限");
    } while (cursor);
    points.sort((a, b) => a.number - b.number);
    return { versionId, text, overview, points };
  })();
  kept.set(key, read);
  read.catch(() => kept.delete(key));
  while (kept.size > KEEP) kept.delete(kept.keys().next().value!);
  return read;
}
