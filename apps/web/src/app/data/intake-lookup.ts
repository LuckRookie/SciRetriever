import {
  IMPORT_LIMITS,
  type IntakeBatchItem,
  type IntakeLookupItem,
} from "@sciretriever/contracts";
import type { ApiClient } from "./api.js";
import { intakeRoute, readBatch, readItem } from "./imports.js";

/** At most this many non-empty lines go in one batch (literature materials 6.4.12). */
export const LOOKUP_LINE_LIMIT = IMPORT_LIMITS.lookup_lines;

/** Lines the service counts: blank ones (after trimming) are left out. */
export const lookupLineCount = (text: string) =>
  text.split(/\r\n|\r|\n/u).filter((line) => line.trim()).length;

/**
 * “指定文献” (page specs “找文献”): the pasted text becomes one batch, sent
 * whole as its one data part. Nothing is written to the library here.
 */
export async function submitLookup(
  api: ApiClient,
  text: string,
): Promise<string> {
  const { batch } = await api.call("/api/v1/intake/batches", {
    format: "lookup",
    source: null,
    scope: `网页指定 ${lookupLineCount(text)} 行`,
  });
  const id = readBatch(batch).batch_id;
  try {
    await api.call(intakeRoute(id, "data"), { sequence: 0, data: text });
  } catch (error) {
    // The batch holds nothing; it is cancelled rather than left collecting.
    await api.call(intakeRoute(id, "cancel"), {}).catch(() => undefined);
    throw error;
  }
  return id;
}

export type LookupItem = IntakeBatchItem & { lookup: IntakeLookupItem };
/** Every line of a `lookup` batch, in the order it was pasted. */
export async function lookupItems(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<LookupItem[]> {
  const all: LookupItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await api.call(
      intakeRoute(id, "items"),
      { cursor, limit: 200 },
      signal,
    );
    for (const value of Array.isArray(page.items) ? page.items : []) {
      const item = readItem(value);
      if (item.lookup) all.push(item as LookupItem);
    }
    cursor = typeof page.next_cursor === "string" ? page.next_cursor : null;
  } while (cursor);
  // The service lists items by their ids; the page follows the pasted lines.
  return all.sort((a, b) => a.lookup.line - b.lookup.line);
}

/** The parts of a lookup batch's page (page specs “找文献 · 指定文献”). */
export interface LookupParts {
  /** Several possible works: adopt one, or none of them. */
  candidates: LookupItem[];
  /** Not recognized: left out unless included. */
  unrecognized: LookupItem[];
  recognized: LookupItem[];
  existing: LookupItem[];
  /** Refused or repeated lines, never looked up. */
  refused: LookupItem[];
  pending: LookupItem[];
}
export function lookupParts(items: readonly LookupItem[]): LookupParts {
  const parts: LookupParts = {
    candidates: [],
    unrecognized: [],
    recognized: [],
    existing: [],
    refused: [],
    pending: [],
  };
  for (const item of items) {
    const outcome = item.lookup.outcome;
    // A line that had candidates stays with them once decided, so the
    // decision at its end can still change until the batch is confirmed.
    if (item.recognition?.candidates.length) parts.candidates.push(item);
    else if (outcome === "rejected" || outcome === "duplicate")
      parts.refused.push(item);
    else if (outcome === "existing") parts.existing.push(item);
    else if (outcome === "recognized") parts.recognized.push(item);
    else if (outcome === "unrecognized") parts.unrecognized.push(item);
    else parts.pending.push(item);
  }
  return parts;
}
