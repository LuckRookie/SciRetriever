import { randomUUID } from "node:crypto";
import {
  parseFolderOperation,
  parseReadingOpen,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { activityContext } from "../logging/activity.js";

export class FolderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** User grouping and explicit reading history; never modifies literature facts. */
export class FolderService {
  constructor(private readonly database: SqliteWorker) {}
  query(value: unknown, signal?: AbortSignal) {
    const command = parseFolderOperation(value);
    if (command.operation !== "list" && command.operation !== "delete-preview")
      throw new FolderError("folder-read-operation-invalid");
    return this.database.folders(command, signal);
  }
  manage(value: unknown, signal?: AbortSignal) {
    const command = parseFolderOperation(value);
    if (command.operation === "list" || command.operation === "delete-preview")
      throw new FolderError("folder-write-operation-invalid");
    return this.database.folders(
      {
        ...command,
        actor: activityContext().actor,
        now: new Date().toISOString(),
        ...(command.operation === "create" ? { folder_id: randomUUID() } : {}),
      },
      signal,
    );
  }
  opened(value: unknown, signal?: AbortSignal) {
    return this.database.folders(
      {
        operation: "opened",
        request: parseReadingOpen(value),
        now: new Date().toISOString(),
      },
      signal,
    );
  }
}
