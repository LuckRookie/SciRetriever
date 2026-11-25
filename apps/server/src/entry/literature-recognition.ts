import { randomUUID } from "node:crypto";
import {
  ContractValidationError,
  LITERATURE_RECOGNIZE_LIMITS,
  parseLiteratureRecognizeRequest,
} from "@sciretriever/contracts";
import type { Application } from "../bootstrap/application.js";
import { resolveMupdfRuntime } from "../proofread/mupdf.js";
import { ProductOperationError } from "./query-operations.js";

/**
 * `literature-recognize`: fixes the members at submission and queues one
 * recognition target per literature on the shared processing runtime. A
 * server that cannot read PDFs refuses instead of queueing certain failures.
 */
export async function submitLiteratureRecognition(
  app: Application,
  value: unknown,
  pdfReader: () => Promise<unknown> = resolveMupdfRuntime,
) {
  let request: ReturnType<typeof parseLiteratureRecognizeRequest>;
  try {
    request = parseLiteratureRecognizeRequest(value);
  } catch (cause) {
    if (cause instanceof ContractValidationError)
      throw new ProductOperationError("invalid-request", { cause });
    throw cause;
  }
  if (!app.processingTasks || !app.fileRecognition)
    throw new ProductOperationError("processing-unavailable");
  if (!(await pdfReader()))
    throw new ProductOperationError("pdf-reader-missing");
  const ids =
    request.selector.kind === "literatures"
      ? request.selector.literature_ids
      : await app.fileRecognition.needsMetadata(
          LITERATURE_RECOGNIZE_LIMITS.needs_metadata + 1,
        );
  if (ids.length > LITERATURE_RECOGNIZE_LIMITS.needs_metadata)
    throw new ProductOperationError("recognize-selection-too-large");
  if (!ids.length) throw new ProductOperationError("recognize-selection-empty");
  const job = await app.processingTasks.submit({
    schema_version: 1,
    idempotency_key: `literature-recognize-${randomUUID()}`,
    operations: ids.map((literature_id) => ({
      operation: "recognize-literature",
      request: { literature_id },
    })),
  });
  await app.processingTasks.start(job.job_id);
  return job;
}
