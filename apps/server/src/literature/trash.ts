import {
  ContractValidationError,
  parseLibraryTrashCount,
  parseLibraryTrashPage,
  parseLibraryTrashQuery,
  parseLibraryTrashRequest,
  parseLibraryTrashResult,
  parseLiteratureId,
  parseUtcTimestamp,
  type LibraryTrashCount,
  type LibraryTrashPage,
  type LibraryTrashResult,
} from "@sciretriever/contracts";
import { activityContext } from "../logging/activity.js";
import type {
  LibraryTrashStoragePage,
  LibraryTrashStorageCommand,
} from "../storage/sqlite/library-trash-engine.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";

export class LiteratureTrashError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The position after the last item: [deleted_at, literature_id] as base64url
 * JSON. Any well-formed position is a valid place to continue from. */
function encodePosition(deleted_at: string, literature_id: string): string {
  return Buffer.from(JSON.stringify([deleted_at, literature_id])).toString(
    "base64url",
  );
}
function decodePosition(cursor: string): readonly [string, string] {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  if (Buffer.from(json).toString("base64url") !== cursor)
    throw new ContractValidationError();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ContractValidationError();
  }
  if (!Array.isArray(value) || value.length !== 2)
    throw new ContractValidationError();
  return [parseUtcTimestamp(value[0]), parseLiteratureId(value[1])];
}

/** Recently deleted papers: hidden from every read, never removed. */
export class LiteratureTrashService {
  constructor(private readonly database: SqliteWorker) {}

  async query(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<LibraryTrashPage | LibraryTrashCount> {
    const command = parseLibraryTrashQuery(value);
    if (command.operation === "count")
      return parseLibraryTrashCount(
        await this.database.libraryTrash({ kind: "count" }, signal),
      );
    const { limit, cursor } = command.request;
    const after = cursor === null ? null : decodePosition(cursor);
    const storage = (await this.database.libraryTrash(
      { kind: "list", limit, after },
      signal,
    )) as LibraryTrashStoragePage;
    const last = storage.items.at(-1);
    return parseLibraryTrashPage({
      items: storage.items,
      next_cursor:
        storage.more && last
          ? encodePosition(last.deleted_at, last.literature.literature_id)
          : null,
    });
  }

  async manage(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<LibraryTrashResult> {
    const command: LibraryTrashStorageCommand = {
      kind: "write",
      request: parseLibraryTrashRequest(value),
      at: new Date().toISOString(),
      actor: activityContext().actor,
    };
    return parseLibraryTrashResult(
      await this.database.libraryTrash(command, signal),
    );
  }
}
