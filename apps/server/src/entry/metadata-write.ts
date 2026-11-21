import type { SqliteWorker } from "../storage/sqlite/worker.js";

/** Provider I/O has already completed before this iterator is constructed. */
export async function writeMetadataItems<T>(
  database: SqliteWorker,
  items: Iterable<T>,
  write: (item: T) => Promise<void>,
): Promise<void> {
  const iterator = items[Symbol.iterator]();
  let next = iterator.next();
  while (!next.done)
    await database.writeMetadataSegment(async (expired) => {
      do {
        await write(next.value as T);
        next = iterator.next();
      } while (!next.done && !expired());
    });
}
