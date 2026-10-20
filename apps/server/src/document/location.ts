import type {
  DocumentStructure,
  PageRegionLocator,
} from "@sciretriever/contracts";
type Segment = DocumentStructure["segments"][number];
/** Public pages start at one; all immutable structures keep zero-based page indices. */
export function segmentLocation(segment: Segment) {
  if (!("page" in segment)) return null;
  return {
    block_id: segment.block_id,
    page: segment.page + 1,
    region: segment.region,
    continuation_regions: segment.continuation_regions.map((r) => ({
      page: r.page + 1,
      region: r.region,
    })),
    source: segment.source,
    basis: segment.basis,
    uncertainty: segment.uncertainty
      ? { ...segment.uncertainty, page: segment.uncertainty.page + 1 }
      : null,
    locate: segment.locate,
  };
}
export function segmentPageRegion(segment: Segment): PageRegionLocator | null {
  return "page" in segment
    ? {
        scheme: "page-region-v1",
        segment_id: segment.segment_id,
        page: segment.page + 1,
        region: segment.region,
      }
    : null;
}
export function readSegment(segment: Segment) {
  return { ...segment, ...segmentLocation(segment) };
}
