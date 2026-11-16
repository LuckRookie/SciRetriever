import { randomUUID } from "node:crypto";
import {
  ContractValidationError,
  parseFilterOperation,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";

export class FilterError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Saved conditions only; export is delivered separately with library exports. */
export class FilterService {
  constructor(private readonly database: SqliteWorker) {}
  query(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const operation =
      value && typeof value === "object" && "operation" in value
        ? value.operation
        : null;
    if (!["list", "export"].includes(String(operation)))
      throw new FilterError("filter-read-operation-invalid");
    return this.database.filters(parseFilterOperation(value), signal);
  }
  manage(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const operation =
      value && typeof value === "object" && "operation" in value
        ? value.operation
        : null;
    if (["list", "export"].includes(String(operation)))
      throw new FilterError("filter-write-operation-invalid");
    try {
      const command = parseFilterOperation(value);
      return this.database.filters(
        {
          ...command,
          now: new Date().toISOString(),
          ...(command.operation === "create"
            ? { filter_id: randomUUID() }
            : {}),
          ...(command.operation === "import"
            ? { import_ids: command.request.items.map(() => randomUUID()) }
            : {}),
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof ContractValidationError &&
        error.path[0] === "filter-condition"
      )
        throw new FilterError("filter-condition-invalid");
      throw error;
    }
  }
}
