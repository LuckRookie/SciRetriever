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
  /** PDF byte requests and SHA-256 checks, by asset SHA-256. */
  pdfRequests: Record<string, number>;
  pdfHashes: Record<string, number>;
  workersStarted: number;
  workersTerminated: number;
  workersPeak: number;
  canvasesCreated: number;
  canvasesReleased: number;
  canvasesPeak: number;
  objectUrlsCreated: number;
  objectUrlsRevoked: number;
}
type Counter =
  | "workersStarted"
  | "workersTerminated"
  | "canvasesCreated"
  | "canvasesReleased"
  | "objectUrlsCreated"
  | "objectUrlsRevoked";
type Keyed = "engines" | "pdfRequests" | "pdfHashes";

function counts(): ReaderProbeCounts {
  const scope = globalThis as { __sciretrieverReaderProbe?: ReaderProbeCounts };
  return (scope.__sciretrieverReaderProbe ??= {
    engines: {},
    pdfRequests: {},
    pdfHashes: {},
    workersStarted: 0,
    workersTerminated: 0,
    workersPeak: 0,
    canvasesCreated: 0,
    canvasesReleased: 0,
    canvasesPeak: 0,
    objectUrlsCreated: 0,
    objectUrlsRevoked: 0,
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
  if (!READER_PROBE) return;
  const map = counts()[name];
  map[key] = (map[key] ?? 0) + 1;
}
