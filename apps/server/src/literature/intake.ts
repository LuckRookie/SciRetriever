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
  const id = parseIntakeBatchId(randomUUID());
  const batch = parseIntakeBatch({
    batch_id: id,
    kind,
    label,
    default_label: label,
    renamed: false,
    origin: intakeOrigin(origin),
    created_at: new Date().toISOString(),
    finished_at: null,
    status: "running",
    request,
    counts: { hits: 0, created: 0, enriched: 0, matched: 0, rejected: 0 },
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
  status: IntakeBatch["status"],
  discovery_run_id: string | null = null,
  source_failures = 0,
  rejected = 0,
) {
  return database.writeIntake({
    operation: "finish",
    batch_id,
    status,
    discovery_run_id,
    source_failures,
    rejected,
  });
}
