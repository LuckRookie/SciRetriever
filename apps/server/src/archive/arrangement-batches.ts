import { ARRANGE_INPUT_MAX_BYTES } from "@sciretriever/contracts";
import { ArchiveTextError } from "./text-source.js";

/** Pack indivisible groups using the serialized request, including its envelope. */
export function boundedArrangementBatches<T>(
  groups: readonly (readonly T[])[],
  request: (items: readonly T[]) => unknown,
  maxBytes = ARRANGE_INPUT_MAX_BYTES,
): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let batch: T[] = [];
  for (const group of groups) {
    if (Buffer.byteLength(JSON.stringify(request(group))) > maxBytes)
      throw new ArchiveTextError("request-too-large");
    if (
      Buffer.byteLength(JSON.stringify(request([...batch, ...group]))) >
      maxBytes
    ) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** All blocks from a PDF page remain in the same request. */
export function arrangementPages<T extends { readonly page: number }>(
  items: readonly T[],
): readonly (readonly T[])[] {
  const pages = new Map<number, T[]>();
  for (const item of items) {
    const page = pages.get(item.page) ?? [];
    page.push(item);
    pages.set(item.page, page);
  }
  return [...pages.values()];
}
