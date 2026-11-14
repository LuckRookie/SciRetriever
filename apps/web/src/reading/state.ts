/** Session-local reading preferences. Keys include the library and immutable material identity. */
export interface ReadingPosition {
  literatureId: string;
  page: number;
  zoom: "fit" | number;
  pageOffset: number;
  textOffset: number;
  blockOffset: number;
  loadedEnd: number;
  fontSize: number;
  wide: boolean;
  fullWidth?: boolean;
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
      textOffset: 0,
      blockOffset: 0,
      loadedEnd: 0,
      fontSize: 20,
      wide: false,
      outline: false,
      information: true,
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
