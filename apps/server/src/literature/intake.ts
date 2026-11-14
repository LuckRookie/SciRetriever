import { randomUUID } from "node:crypto";
import {
  parseIntakeBatch,
  parseIntakeBatchId,
  type IntakeBatch,
  type IntakeBatchId,
} from "@sciretriever/contracts";
import { activityContext } from "../logging/activity.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";

export type IntakeOrigin = "web" | "cli" | "mcp";
export function intakeOrigin(explicit?: IntakeOrigin): IntakeOrigin {
  if (explicit) return explicit;
  const actor = activityContext().actor;
  if (actor.startsWith("cli:")) return "cli";
  if (actor.startsWith("mcp:")) return "mcp";
  if (actor.startsWith("web-session:") || actor.startsWith("web:"))
    return "web";
  throw Object.assign(new Error("intake entry origin is required"), {
    code: "intake-origin-required",
  });
}
export async function startIntake(
  database: SqliteWorker,
  kind: "topic" | "citation" | "import",
  label: string,
  request: IntakeBatch["request"],
  origin?: IntakeOrigin,
) {
  const id = parseIntakeBatchId(randomUUID()),
    entryOrigin = intakeOrigin(origin);
  const device =
    /(?:^|:)device:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u.exec(
      activityContext().actor,
    );
  const batch = parseIntakeBatch({
    batch_id: id,
    kind,
    label,
    default_label: label,
    renamed: false,
    origin: entryOrigin,
    created_at: new Date().toISOString(),
    finished_at: null,
    state: "running",
    result: null,
    confirmation: null,
    confirmed_at: null,
    initiated_by: device ? `device:${device[1]}` : `local:${entryOrigin}`,
    source: null,
    progress: null,
    request,
    counts: {
      hits: 0,
      created: 0,
      enriched: 0,
      matched: 0,
      rejected: 0,
      restored: 0,
      conflicts: 0,
      possible_duplicates: 0,
      pending_decision: 0,
      needs_metadata: 0,
    },
    pdf: { has_pdf: 0, unavailable: 0, pending: 0 },
    discovery_run_id: null,
    source_failures: 0,
  });
  await database.writeIntake({
    operation: "create",
    batch,
    owner_pid: process.pid,
  });
  return id;
}
export function finishIntake(
  database: SqliteWorker,
  batch_id: IntakeBatchId,
  result: NonNullable<IntakeBatch["result"]>,
  discovery_run_id: string | null = null,
  source_failures = 0,
  rejected = 0,
) {
  return database.writeIntake({
    operation: "finish",
    batch_id,
    result,
    discovery_run_id,
    source_failures,
    rejected,
  });
}
