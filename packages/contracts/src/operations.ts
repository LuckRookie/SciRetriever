import { ContractValidationError, canonicalJsonBytes } from "./index.js";
import { parseDocumentRequest, type ParseDocumentRequest } from "./document.js";
import {
  parseArticleIdentityRequest,
  type ArticleIdentityRequest,
} from "./article-identity.js";
import {
  parseKnowledgeAnalysisRequest,
  parseKnowledgeLongAnalysisRequest,
  type KnowledgeAnalysisRequest,
  type KnowledgeLongAnalysisRequest,
} from "./knowledge.js";
import {
  parseKnowledgeSynthesisRequest,
  type KnowledgeSynthesisRequest,
} from "./synthesis.js";

export type ProcessingOperation =
  | {
      readonly operation: "parse-documents";
      readonly request: ParseDocumentRequest;
    }
  | {
      readonly operation: "assess-article-identity";
      readonly request: ArticleIdentityRequest;
    }
  | {
      readonly operation: "analyze";
      readonly request: KnowledgeAnalysisRequest;
    }
  | {
      readonly operation: "analyze-long";
      readonly request: KnowledgeLongAnalysisRequest;
    }
  | {
      readonly operation: "synthesize";
      readonly request: KnowledgeSynthesisRequest;
    };
export interface ProcessingTaskRequest {
  readonly schema_version: 1;
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
    case "analyze":
      return {
        operation: r.operation,
        request: await parseKnowledgeAnalysisRequest(r.request),
      };
    case "analyze-long":
      return {
        operation: r.operation,
        request: await parseKnowledgeLongAnalysisRequest(r.request),
      };
    case "synthesize":
      return {
        operation: r.operation,
        request: await parseKnowledgeSynthesisRequest(r.request),
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
  if (bytes.length > 1024 * 1024) throw new ContractValidationError();
  const r = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join() !==
      "idempotency_key,operations,schema_version" ||
    r.schema_version !== 1 ||
    typeof r.idempotency_key !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(r.idempotency_key) ||
    !Array.isArray(r.operations) ||
    r.operations.length < 1 ||
    r.operations.length > 100
  )
    throw new ContractValidationError();
  return Object.freeze({
    schema_version: 1,
    idempotency_key: r.idempotency_key,
    operations: Object.freeze(
      await Promise.all(r.operations.map(parseProcessingOperation)),
    ),
  });
}
