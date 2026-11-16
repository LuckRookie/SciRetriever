import { randomUUID } from "node:crypto";
import {
  ContractValidationError,
  parseFilterOperation,
  parseSavedFilter,
  parseFiltersExportFile,
  FILTERS_EXPORT_FORMAT,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";

export class FilterError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Saved conditions only, with a bounded, read-only whole-file export. */
export class FilterService {
  constructor(private readonly database: SqliteWorker) {}
  query(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const operation =
      value && typeof value === "object" && "operation" in value
        ? value.operation
        : null;
    if (!["list", "export"].includes(String(operation)))
      throw new FilterError("filter-read-operation-invalid");
    const command = parseFilterOperation(value);
    if (command.operation === "export") return this.exportFile(command, signal);
    return this.database.filters(command, signal);
  }
  private async exportFile(
    command: Extract<
      ReturnType<typeof parseFilterOperation>,
      { operation: "export" }
    >,
    signal?: AbortSignal,
  ) {
    const listed = (await this.database.filters(command, signal)) as {
      items: readonly unknown[];
    };
    return parseFiltersExportFile({
      format: FILTERS_EXPORT_FORMAT,
      version: 1,
      exported_at: new Date().toISOString(),
      filters: listed.items
        .map(parseSavedFilter)
        .map(({ name, query, sort }) => ({ name, query, sort })),
    });
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
