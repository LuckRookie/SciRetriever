import {
  parseProcessorCitation,
  processorExact,
  processorText,
  parseAssetId,
  processorJson,
} from "@sciretriever/contracts";
import type {
  Application,
  QueryApplication,
} from "../bootstrap/application.js";
import { createProcessorRegistry } from "../analysis/processor-registry.js";
import { processorError } from "../analysis/processor.js";
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
] as const;
export type ProcessorQuery = (typeof PROCESSOR_QUERIES)[number];
/** Shared human/Agent boundary; all queries stay independent of model execution. */
export async function queryProcessors(
  app: Pick<QueryApplication, "processorRead">,
  action: string,
  value: unknown,
) {
  const q = processorJson(value);
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
      return store.byId(String(parseAssetId(q.result_id)));
    case "results":
      return store.list(
        integer(q.limit, 50),
        q.after === undefined ? "" : processorText(q.after, 256),
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
      return store.verifyCitation(parseProcessorCitation(q));
    case "export": {
      processorExact(q, ["result_id", "format"]);
      const stored = await store.byId(String(parseAssetId(q.result_id)));
      if (!stored) processorError("processor-result-missing");
      const records = await store.records({
        kind: "result",
        input_id: "export",
        ...stored.ref,
        record_ids: null,
      });
      const metadata = {
        ...stored.ref,
        invocation: stored.result.invocation,
        coverage: stored.result.coverage,
        provenance: stored.result.provenance,
      };
      const cell = (v: unknown) =>
        `"${(typeof v === "string" ? v : JSON.stringify(v)).replace(/"/g, '""')}"`;
      if (q.format === "json")
        return {
          media_type: "application/json",
          content: JSON.stringify(stored, null, 2),
        };
      if (q.format === "csv")
        return {
          media_type: "text/csv",
          metadata,
          content: [
            "record_id,payload_json,evidence_json",
            ...records.map((r) =>
              [r.record_id, r.payload, r.citation].map(cell).join(","),
            ),
          ].join("\r\n"),
        };
      if (q.format === "markdown")
        return {
          media_type: "text/markdown",
          metadata,
          content: records
            .map(
              (r) =>
                `- ${typeof r.payload.text === "string" ? r.payload.text : JSON.stringify(r.payload)}\n\n  Evidence: \`${JSON.stringify(r.citation)}\``,
            )
            .join("\n\n"),
        };
      return processorError("processor-export-format");
    }
    default:
      processorError("processor-query-invalid");
  }
}
export async function submitProcessor(
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
