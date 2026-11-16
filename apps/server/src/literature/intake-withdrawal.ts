import {
  parseAssetId,
  parseIntakeWithdrawalPreview,
  parseIntakeWithdrawalReport,
  parseIntakeRestorePreview,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
export class IntakeWithdrawalError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Web-only application boundary. Its methods are not CLI/MCP operations. */
export class IntakeWithdrawalService {
  constructor(private readonly database: SqliteWorker) {}
  async read(id: unknown) {
    const value = await this.database.intakeWithdrawal({
      operation: "read",
      batch_id: parseAssetId(id),
      at: new Date().toISOString(),
    });
    return value === null ? null : parseIntakeWithdrawalReport(value);
  }
  async restorePreview(id: unknown) {
    return parseIntakeRestorePreview(
      await this.database.intakeWithdrawal({
        operation: "restore-preview",
        batch_id: parseAssetId(id),
        at: new Date().toISOString(),
      }),
    );
  }
  async preview(id: unknown) {
    return parseIntakeWithdrawalPreview(
      await this.database.intakeWithdrawal({
        operation: "preview",
        batch_id: parseAssetId(id),
        at: new Date().toISOString(),
      }),
    );
  }
  async withdraw(id: unknown) {
    return parseIntakeWithdrawalReport(
      await this.database.intakeWithdrawal({
        operation: "withdraw",
        batch_id: parseAssetId(id),
        at: new Date().toISOString(),
      }),
    );
  }
  async restore(id: unknown) {
    return parseIntakeWithdrawalReport(
      await this.database.intakeWithdrawal({
        operation: "restore",
        batch_id: parseAssetId(id),
        at: new Date().toISOString(),
      }),
    );
  }
}
