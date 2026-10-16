import { createTaskReader } from "./task-read.js";
import type { Application } from "../bootstrap/application.js";
import { ProcessingTaskError } from "../application/jobs/processing.js";
import { normalizeExecutionPolicy } from "../storage/execution/repository.js";
import type { LiteratureSelector } from "./selectors.js";
import {
  ContractValidationError,
  parseLibraryQuery,
  parseMetaLiteratureId,
  parseDiscoveryRunId,
  parseLiteratureId,
} from "@sciretriever/contracts";
import { operationRecord as inputRecord } from "./query-operations.js";
function taskSelector(value: unknown): LiteratureSelector {
  const item = inputRecord(
    value,
    ["kind"],
    ["query", "literature_ids", "meta_literature_ids", "discovery_run_id"],
  );
  switch (item.kind) {
    case "all-pending":
      inputRecord(value, ["kind"]);
      return { kind: "all-pending" };
    case "query":
      inputRecord(value, ["kind", "query"]);
      return { kind: "query", query: parseLibraryQuery(item.query) };
    case "discovery-run":
      inputRecord(value, ["kind", "discovery_run_id"]);
      return {
        kind: "discovery-run",
        discovery_run_id: parseDiscoveryRunId(item.discovery_run_id),
      };
    case "literatures": {
      inputRecord(value, ["kind", "literature_ids"]);
      if (
        !Array.isArray(item.literature_ids) ||
        !item.literature_ids.length ||
        item.literature_ids.length > 10000
      )
        throw new ContractValidationError();
      return {
        kind: "literatures",
        literature_ids: item.literature_ids.map(parseLiteratureId),
      };
    }
    case "meta-literatures":
    case "import-report": {
      inputRecord(value, ["kind", "meta_literature_ids"]);
      if (
        !Array.isArray(item.meta_literature_ids) ||
        !item.meta_literature_ids.length ||
        item.meta_literature_ids.length > 10000
      )
        throw new ContractValidationError();
      return {
        kind: item.kind,
        meta_literature_ids: item.meta_literature_ids.map(
          parseMetaLiteratureId,
        ),
      };
    }
    default:
      throw new ContractValidationError();
  }
}

/** One task projection and lifecycle shared by machine and human adapters. */
export function createTaskOperations(app: Application) {
  const repository = app.jobs,
    runtime = app.processingTasks;
  if (!repository || !runtime || !app.jobService || !app.interventions)
    return null;
  const reader = createTaskReader(repository);
  const read = reader.read;
  const start = async (id: string) => {
    const task = await repository.getJob(id);
    if (!task) throw new ProcessingTaskError("processing-not-found");
    if (task.status === "cancelled" || task.status === "completed")
      throw new ProcessingTaskError("processing-terminal");
    if (
      task.status === "paused" ||
      task.status === "interrupted" ||
      task.status === "failed"
    )
      throw new ProcessingTaskError("processing-resume-required");
    return { started: runtime.start(id), task };
  };
  const control = async (
    id: string,
    action: "pause" | "cancel" | "resume" | "retry",
  ) => {
    if (!(await repository.getJob(id)))
      throw new ProcessingTaskError("processing-not-found");
    await runtime.control(id, action);
    if (action === "resume" || action === "retry") runtime.start(id);
    return read(id);
  };
  return {
    ...reader,
    read,
    start,
    control,
    create: async (value: unknown) => {
      const r = inputRecord(
        value,
        ["kind"],
        ["idempotency_key", "selector", "policy", "request"],
      );
      if (r.kind === "processing") {
        inputRecord(value, ["kind", "request"]);
        return runtime.submit(r.request);
      }
      if (r.kind !== "acquire-pdf") throw new ContractValidationError();
      inputRecord(value, ["kind", "idempotency_key", "selector"], ["policy"]);
      if (
        typeof r.idempotency_key !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(r.idempotency_key)
      )
        throw new ContractValidationError();
      let policy;
      try {
        policy = normalizeExecutionPolicy(
          r.policy === undefined
            ? {}
            : inputRecord(
                r.policy,
                [],
                [
                  "mode",
                  "max_retries",
                  "max_attempts",
                  "max_network_bytes",
                  "max_model_calls",
                  "intervention_timeout_ms",
                ],
              ),
        );
      } catch {
        throw new ContractValidationError();
      }
      return app.jobService!.create({
        target_kind: "selector",
        selector: taskSelector(r.selector),
        goal: "pdf",
        policy_version: "workbench-v1",
        policy,
        idempotency_key: r.idempotency_key,
      });
    },
  };
}
