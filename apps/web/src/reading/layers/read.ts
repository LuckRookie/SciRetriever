import type { ReadingContext } from "../contract.js";
import {
  parseLayersOutline,
  parseLayersOverview,
  type LayerPoint,
  type LayersOverview,
  type LayersRequest,
  type LayersSummary,
  type LayersText,
} from "./contract.js";

/** One version's reading layers as the page shows them: everything, read once. */
export interface ReadLayers {
  readonly versionId: string;
  /** `bilingual` when the layers have a translation part: all three readings from one read. */
  readonly text: LayersText;
  readonly overview: LayersOverview;
  readonly points: readonly LayerPoint[];
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
  summary: LayersSummary,
): Promise<ReadLayers> {
  const text: LayersText = summary.target_language ? "bilingual" : "original";
  const key = `${versionId}|${text}`;
  const known = kept.get(key);
  if (known) {
    kept.delete(key);
    kept.set(key, known);
    return known;
  }
  const read = (async () => {
    const ask = (
      part: LayersRequest["part"],
      cursor: string | null,
    ): LayersRequest => ({
      document_version_id: versionId,
      part,
      text,
      format: "json",
      limit: 50,
      cursor,
    });
    const first = ask("overview", null);
    const overview = parseLayersOverview(
      (await ctx.api.query("document-layers", first, ctx.signal)).result,
      first,
    );
    const points: LayerPoint[] = [];
    let cursor: string | null = null;
    do {
      const request = ask("outline", cursor);
      const page = parseLayersOutline(
        (await ctx.api.query("document-layers", request, ctx.signal)).result,
        request,
      );
      points.push(...page.points);
      cursor = page.next_cursor;
      if (points.length > 400) throw new Error("阅读层的要点超过上限");
    } while (cursor);
    points.sort((a, b) => a.number - b.number);
    return { versionId, text, overview, points };
  })();
  kept.set(key, read);
  read.catch(() => kept.delete(key));
  while (kept.size > KEEP) kept.delete(kept.keys().next().value!);
  return read;
}
