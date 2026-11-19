/**
 * The live reading state of the open papers, keyed by library and material.
 * What a reader should find again after closing a paper is also remembered in
 * this browser (spec 4.5, `rememberReading`); the live objects start from it.
 */
export interface ReadingPosition {
  literatureId: string;
  /** First page in view: the page indicator and page navigation. */
  page: number;
  zoom: "fit" | number;
  pageOffset: number;
  /** Full text: the block at the reading line (its start) and where the line falls in it. */
  textOffset: number;
  blockOffset: number;
  /** PDF: the page at the reading line and where the line falls on it. */
  anchorPage: number;
  anchorRatio: number;
  loadedEnd: number;
  fontSize: number;
  outline: boolean;
  information: boolean;
  query: string;
  scroll: number;
}
export interface ReadingState {
  entries: Map<string, ReadingPosition>;
  /** Told when a paper's tab closes, so its reader engine is released. */
  closed: Set<(literatureId: string) => void>;
}
export function createReadingState(): ReadingState {
  return { entries: new Map(), closed: new Set() };
}
export function readingPosition(
  state: ReadingState,
  key: readonly unknown[],
  literatureId: string,
): ReadingPosition {
  const identity = JSON.stringify(key);
  let entry = state.entries.get(identity);
  if (!entry) {
    entry = {
      literatureId,
      page: 1,
      zoom: "fit",
      pageOffset: 0,
      anchorPage: 1,
      anchorRatio: 0,
      textOffset: 0,
      blockOffset: 0,
      loadedEnd: 0,
      fontSize: 20,
      outline: false,
      // Spec 1.4: the side panel starts closed.
      information: false,
      query: "",
      scroll: 0,
    };
    state.entries.set(identity, entry);
  }
  return entry;
}
export function closeReadingState(
  state: ReadingState,
  literatureId: string,
): void {
  for (const [key, entry] of state.entries)
    if (entry.literatureId === literatureId) state.entries.delete(key);
  for (const listener of state.closed) listener(literatureId);
}

/** What spec 4.5 keeps per paper in this browser. Jumps and lenses are not kept. */
export interface ReadingMemory {
  view: string | null;
  doc: { version: string; start: number; ratio: number } | null;
  pdf: {
    sha256: string;
    page: number;
    ratio: number;
    zoom: "fit" | number;
  } | null;
  /** The flow view's anchor: kept once that view exists (plan 24, block 14). */
  flow: { point: string } | null;
  fontSize: number | null;
  information: boolean | null;
  sideTab: string | null;
  keySentences: boolean | null;
  sources: boolean | null;
}
export const READING_MEMORY_LIMIT = 300;
const PREFIX = "sciretriever:reading:v1:";
const INDEX = `${PREFIX}index`;
const emptyMemory = (): ReadingMemory => ({
  view: null,
  doc: null,
  pdf: null,
  flow: null,
  fontSize: null,
  information: null,
  sideTab: null,
  keySentences: null,
  sources: null,
});
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Local storage, or null where the browser refuses it: reading still works, unremembered. */
function store(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
const memoryKey = (catalog: string | null, literatureId: string) =>
  `${PREFIX}${encodeURIComponent(catalog ?? "")}:${literatureId}`;
/** Least recently used first; touching moves a key to the end, past the limit the first go. */
export function touchIndex(
  index: readonly string[],
  key: string,
  limit = READING_MEMORY_LIMIT,
): { index: string[]; evicted: string[] } {
  const next = [...index.filter((item) => item !== key), key];
  const evicted = next.splice(0, Math.max(0, next.length - limit));
  return { index: next, evicted };
}
function readIndex(storage: Store): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(INDEX) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
export function recallReading(
  catalog: string | null,
  literatureId: string,
  storage: Store | null = store(),
): ReadingMemory {
  if (!storage) return emptyMemory();
  try {
    const value: unknown = JSON.parse(
      storage.getItem(memoryKey(catalog, literatureId)) ?? "null",
    );
    return value && typeof value === "object"
      ? { ...emptyMemory(), ...(value as Partial<ReadingMemory>) }
      : emptyMemory();
  } catch {
    return emptyMemory();
  }
}
export function rememberReading(
  catalog: string | null,
  literatureId: string,
  patch: Partial<ReadingMemory>,
  storage: Store | null = store(),
): void {
  if (!storage) return;
  try {
    const key = memoryKey(catalog, literatureId);
    const value = {
      ...recallReading(catalog, literatureId, storage),
      ...patch,
    };
    storage.setItem(key, JSON.stringify(value));
    const { index, evicted } = touchIndex(readIndex(storage), key);
    for (const old of evicted) storage.removeItem(old);
    storage.setItem(INDEX, JSON.stringify(index));
  } catch {
    // Storage full or refused: the reader keeps working without remembering.
  }
}
