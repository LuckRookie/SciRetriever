/**
 * Reader counters for browser measurements. Only a test build defines the
 * flag true; the production build defines it false, so every guarded call
 * site and this module's body fold away. Counting never changes behaviour.
 */
declare const __SCIRETRIEVER_READER_PROBE__: boolean | undefined;
export const READER_PROBE =
  typeof __SCIRETRIEVER_READER_PROBE__ === "boolean" &&
  __SCIRETRIEVER_READER_PROBE__;

export interface ReaderProbeCounts {
  /** Engine mounts, by reader mode. */
  engines: Record<string, number>;
  /**
   * PDF downloads (one per asset however many ranges it takes) and SHA-256
   * checks, by asset SHA-256; with the range requests and bytes they took.
   */
  pdfRequests: Record<string, number>;
  pdfHashes: Record<string, number>;
  pdfRanges: Record<string, number>;
  pdfBytes: Record<string, number>;
  workersStarted: number;
  workersTerminated: number;
  workersPeak: number;
  canvasesCreated: number;
  canvasesReleased: number;
  canvasesPeak: number;
  objectUrlsCreated: number;
  objectUrlsRevoked: number;
  /** Low-resolution PDF page bitmaps (spec 5.3): live now and the largest ever. */
  bitmapsCreated: number;
  bitmapsReleased: number;
  bitmapsPeak: number;
  bitmapBytes: number;
  bitmapBytesPeak: number;
  /** The most one paper held at once, in pages and in bytes. */
  bitmapsPerPaperPeak: number;
  bitmapBytesPerPaperPeak: number;
}
type Counter =
  | "workersStarted"
  | "workersTerminated"
  | "canvasesCreated"
  | "canvasesReleased"
  | "objectUrlsCreated"
  | "objectUrlsRevoked";
type Keyed = "engines" | "pdfRequests" | "pdfHashes" | "pdfRanges" | "pdfBytes";

function counts(): ReaderProbeCounts {
  const scope = globalThis as { __sciretrieverReaderProbe?: ReaderProbeCounts };
  return (scope.__sciretrieverReaderProbe ??= {
    engines: {},
    pdfRequests: {},
    pdfHashes: {},
    pdfRanges: {},
    pdfBytes: {},
    workersStarted: 0,
    workersTerminated: 0,
    workersPeak: 0,
    canvasesCreated: 0,
    canvasesReleased: 0,
    canvasesPeak: 0,
    objectUrlsCreated: 0,
    objectUrlsRevoked: 0,
    bitmapsCreated: 0,
    bitmapsReleased: 0,
    bitmapsPeak: 0,
    bitmapBytes: 0,
    bitmapBytesPeak: 0,
    bitmapsPerPaperPeak: 0,
    bitmapBytesPerPaperPeak: 0,
  });
}
// Each entry point checks the flag itself: a production chunk may keep the
// exported names, but not their bodies.
export function probeCount(name: Counter) {
  if (!READER_PROBE) return;
  const c = counts();
  c[name]++;
  c.workersPeak = Math.max(
    c.workersPeak,
    c.workersStarted - c.workersTerminated,
  );
  c.canvasesPeak = Math.max(
    c.canvasesPeak,
    c.canvasesCreated - c.canvasesReleased,
  );
}
export function probeCountKey(name: Keyed, key: string) {
  probeAddKey(name, key, 1);
}
export function probeAddKey(name: Keyed, key: string, amount: number) {
  if (!READER_PROBE) return;
  const map = counts()[name];
  map[key] = (map[key] ?? 0) + amount;
}
/** One bitmap kept (`bytes` > 0) or released (`bytes` < 0); `paper` is the owner's totals after it. */
export function probeBitmap(
  bytes: number,
  paper: { count: number; bytes: number },
) {
  if (!READER_PROBE) return;
  const c = counts();
  if (bytes > 0) c.bitmapsCreated++;
  else c.bitmapsReleased++;
  c.bitmapBytes += bytes;
  c.bitmapsPeak = Math.max(c.bitmapsPeak, c.bitmapsCreated - c.bitmapsReleased);
  c.bitmapBytesPeak = Math.max(c.bitmapBytesPeak, c.bitmapBytes);
  c.bitmapsPerPaperPeak = Math.max(c.bitmapsPerPaperPeak, paper.count);
  c.bitmapBytesPerPaperPeak = Math.max(c.bitmapBytesPerPaperPeak, paper.bytes);
}
