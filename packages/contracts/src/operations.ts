import {
  parseArchiveBuildRequest,
  type ArchiveBuildRequest,
} from "./archive.js";
import {
  parseArticleIdentityRequest,
  type ArticleIdentityRequest,
} from "./article-identity.js";
import { parseDocumentRequest, type ParseDocumentRequest } from "./document.js";
import {
  ContractValidationError,
  canonicalJsonBytes,
  parseAssetId,
} from "./index.js";
import {
  parseProcessorInvocation,
  type ProcessorInvocation,
} from "./processors.js";
import {
  parseMetadataTaskRequest,
  type MetadataTaskRequest,
} from "./source-results.js";
import { parseAcquirePdfSelector } from "./intake.js";
import { tagRecord } from "./tags.js";
import type {
  FormDraftsPreviewRequest,
  FormDraftsRequest,
} from "./form-drafts.js";

function formDraftsFields(value: unknown, required: readonly string[]) {
  const optional =
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "include_older_method")
      ? ["include_older_method"]
      : [];
  return tagRecord(value, [...required, ...optional]);
}
export function parseFormDraftsPreviewRequest(
  value: unknown,
): FormDraftsPreviewRequest {
  const r = formDraftsFields(value, ["selector"]);
  if (
    r.include_older_method !== undefined &&
    typeof r.include_older_method !== "boolean"
  )
    throw new ContractValidationError(["form-drafts"]);
  return {
    selector: parseAcquirePdfSelector(r.selector),
    include_older_method: r.include_older_method ?? false,
  };
}
export function parseFormDraftsRequest(value: unknown): FormDraftsRequest {
  const r = formDraftsFields(value, ["selector", "idempotency_key"]);
  if (
    typeof r.idempotency_key !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(r.idempotency_key)
  )
    throw new ContractValidationError(["form-drafts"]);
  return {
    ...parseFormDraftsPreviewRequest({
      selector: r.selector,
      ...(r.include_older_method === undefined
        ? {}
        : { include_older_method: r.include_older_method }),
    }),
    idempotency_key: r.idempotency_key,
  };
}

export type ProcessingOperation =
  | {
      readonly operation: "acquire-metadata";
      readonly request: MetadataTaskRequest;
    }
  | {
      readonly operation: "backfill-tags";
      readonly request: { readonly tag_ids: readonly string[] };
    }
  | {
      readonly operation: "build-archive";
      readonly request: ArchiveBuildRequest;
    }
  | {
      readonly operation: "run-processor";
      readonly request: ProcessorInvocation;
    }
  | {
      readonly operation: "parse-documents";
      readonly request: ParseDocumentRequest;
    }
  | {
      readonly operation: "assess-article-identity";
      readonly request: ArticleIdentityRequest;
    };
export interface ProcessingTaskRequest {
  readonly schema_version: 1 | 2;
  readonly collection_name?: string;
  readonly source_request_sha256?: string;
  readonly idempotency_key: string;
  readonly operations: readonly ProcessingOperation[];
}
export async function parseProcessingOperation(
  value: unknown,
): Promise<ProcessingOperation> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "operation,request"
  )
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  switch (r.operation) {
    case "acquire-metadata":
      return {
        operation: r.operation,
        request: parseMetadataTaskRequest(r.request),
      };
    case "backfill-tags": {
      const request = r.request as Record<string, unknown>;
      if (
        !request ||
        typeof request !== "object" ||
        Object.keys(request).join() !== "tag_ids" ||
        !Array.isArray(request.tag_ids) ||
        !request.tag_ids.length ||
        request.tag_ids.length > 200
      )
        throw new ContractValidationError();
      return {
        operation: r.operation,
        request: { tag_ids: [...new Set(request.tag_ids.map(parseAssetId))] },
      };
    }
    case "build-archive":
      return {
        operation: r.operation,
        request: parseArchiveBuildRequest(r.request),
      };
    case "run-processor":
      return {
        operation: r.operation,
        request: parseProcessorInvocation(r.request),
      };
    case "parse-documents":
      return {
        operation: r.operation,
        request: parseDocumentRequest(r.request),
      };
    case "assess-article-identity":
      return {
        operation: r.operation,
        request: parseArticleIdentityRequest(r.request),
      };
    default:
      throw new ContractValidationError();
  }
}
export async function parseProcessingTaskRequest(
  value: unknown,
): Promise<ProcessingTaskRequest> {
  // Copy before awaiting any nested validation. The persisted snapshot cannot track caller mutations.
  const bytes = canonicalJsonBytes(value);
  if (bytes.length > 4 * 1024 * 1024) throw new ContractValidationError();
  const r = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    ![1, 2].includes(Number(r.schema_version)) ||
    (r.schema_version === 1
      ? Object.keys(r).sort().join() !==
        "idempotency_key,operations,schema_version"
      : Object.keys(r).sort().join() !==
          "collection_name,idempotency_key,operations,schema_version,source_request_sha256" ||
        typeof r.collection_name !== "string" ||
        !r.collection_name.trim() ||
        r.collection_name.length > 1024 ||
        typeof r.source_request_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(r.source_request_sha256)) ||
    typeof r.idempotency_key !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(r.idempotency_key) ||
    !Array.isArray(r.operations) ||
    r.operations.length < 1 ||
    r.operations.length > 10000
  )
    throw new ContractValidationError();
  const operations = await Promise.all(
    r.operations.map(parseProcessingOperation),
  );
  if (
    r.schema_version === 2 &&
    operations.some((o) => o.operation !== "run-processor")
  )
    throw new ContractValidationError();
  return Object.freeze({
    schema_version: r.schema_version as 1 | 2,
    ...(r.schema_version === 2
      ? {
          collection_name: r.collection_name as string,
          source_request_sha256: r.source_request_sha256 as string,
        }
      : {}),
    idempotency_key: r.idempotency_key,
    operations: Object.freeze(operations),
  });
}
