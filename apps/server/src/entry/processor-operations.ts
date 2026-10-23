import { recordOperation } from "../application/operations.js";
import {
  parseProcessorCitation,
  processorExact,
  processorText,
  parseAssetId,
  parseLiteratureId,
  processorJson,
} from "@sciretriever/contracts";
import type {
  Application,
  QueryApplication,
} from "../bootstrap/application.js";
import { createProcessorRegistry } from "../analysis/processor-registry.js";
import { processorError } from "../analysis/processor.js";
import {
  exportProcessorResult,
  transferProcessorResult,
} from "../analysis/processor-export.js";
export const PROCESSOR_QUERIES = [
  "list",
  "read",
  "results",
  "collections",
  "collection",
  "search",
  "search-collections",
  "query",
  "evidence",
  "export",
  "transfer",
] as const;
export type ProcessorQuery = (typeof PROCESSOR_QUERIES)[number];
/** Shared human/Agent boundary; all queries stay independent of model execution. */
export async function queryProcessors(
  app: Pick<QueryApplication, "processorRead">,
  action: string,
  value: unknown,
  signal?: AbortSignal,
) {
  if (signal?.aborted) processorError("processor-cancelled");
  const q = processorJson(value);
  const optionalKeys: Record<string, readonly string[]> = {
    results: ["limit", "after", "literature_id", "stale"],
    collections: ["run_id", "limit", "offset"],
    search: ["query", "limit", "offset"],
    "search-collections": ["query", "limit", "offset"],
  };
  const allowed = optionalKeys[action];
  if (allowed && Object.keys(q).some((key) => !allowed.includes(key)))
    processorError("processor-query-invalid");
  if (action === "list") {
    processorExact(q, []);
    return createProcessorRegistry().list();
  }
  const store = app.processorRead;
  if (!store) processorError("catalog-v10-required");
  const integer = (v: unknown, defaultValue: number) => {
    if (v === undefined) return defaultValue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      processorError("processor-query-invalid");
    return v;
  };
  switch (action) {
    case "read":
      processorExact(q, ["result_id"]);
      return store.byId(String(parseAssetId(q.result_id)), signal);
    case "results":
      if (q.stale !== undefined && typeof q.stale !== "boolean")
        processorError("processor-query-invalid");
      return store.list(
        integer(q.limit, 50),
        q.after === undefined ? "" : processorText(q.after, 256, true),
        signal,
        q.literature_id === undefined
          ? null
          : String(parseLiteratureId(q.literature_id)),
        (q.stale as boolean | undefined) ?? null,
      );
    case "collections":
      return store.collections(
        q.run_id === undefined ? null : processorText(q.run_id, 256),
        integer(q.limit, 50),
        integer(q.offset, 0),
      );
    case "collection":
      processorExact(q, ["collection_id"]);
      return store.collection(String(parseAssetId(q.collection_id)));
    case "search":
      return store.search(
        processorText(q.query, 1024),
        integer(q.limit, 20),
        integer(q.offset, 0),
      );
    case "search-collections":
      return store.searchCollections(
        processorText(q.query, 1024),
        integer(q.limit, 20),
        integer(q.offset, 0),
      );
    case "query":
      return store.query(q);
    case "evidence":
      return store.verifyCitation(parseProcessorCitation(q), signal);
    case "transfer":
      return transferProcessorResult(store, q, signal);
    case "export": {
      processorExact(q, ["result_id", "format"]);
      const stored = await store.byId(
        String(parseAssetId(q.result_id)),
        signal,
      );
      if (!stored) processorError("processor-result-missing");
      return exportProcessorResult(store, stored, q.format, signal);
    }
    default:
      processorError("processor-query-invalid");
  }
}
export function submitProcessor(
  app: Application,
  request: unknown,
  start: boolean,
  signal?: AbortSignal,
) {
  return recordOperation(app.database, "processor-submit", request, () =>
    performSubmitProcessor(app, request, start, signal),
  );
}
async function performSubmitProcessor(
  app: Pick<Application, "processors" | "processingTasks">,
  value: unknown,
  start: boolean,
  signal?: AbortSignal,
) {
  if (!app.processors || !app.processingTasks)
    processorError("catalog-v10-required");
  const job = await app.processors.submit(value, signal);
  if (start) app.processingTasks.start(job.job_id);
  return job;
}
