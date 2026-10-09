import {
  ContractValidationError,
  parseLiteratureId,
  parseAssetId,
  parseProvenance,
  type Provenance,
} from "./index.js";
import { parseEvidenceRef, type EvidenceRef } from "./document.js";

export type ArticleIdentityStatus =
  | "match-supported"
  | "conflict"
  | "insufficient-evidence";
export interface ArticleIdentityRequest {
  readonly schema_version: 1;
  readonly literature_id: string;
  readonly document_version_id: string;
  readonly representation_sha256: string;
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly budget: {
    readonly max_input_bytes: number;
    readonly max_output_tokens: number;
  };
}
export interface ArticleIdentityEvidence {
  readonly field: "title" | "author" | "doi" | "arxiv" | "pmid" | "pmcid";
  readonly value: string;
  readonly quote: string;
  readonly evidence: EvidenceRef;
}
export interface ArticleIdentityAssessment {
  readonly schema_version: 1;
  readonly assessment_id: string;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly document_version_id: string;
  readonly representation_sha256: string;
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly status: ArticleIdentityStatus;
  readonly reason:
    | "identifier-match"
    | "title-and-author-match"
    | "identifier-conflict"
    | "insufficient-evidence";
  readonly evidence: readonly ArticleIdentityEvidence[];
  readonly provenance: Provenance;
  readonly method: {
    readonly id: "parsed-article-identity";
    readonly version: "1";
    readonly provider: string;
    readonly model: string;
  };
}
function fail(): never {
  throw new ContractValidationError();
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).length > max ||
    /\p{Cc}/u.test(value.replace(/[\r\n\t]/gu, ""))
  )
    fail();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}
function integer(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    fail();
  return value;
}
export function parseArticleIdentityRequest(
  value: unknown,
): ArticleIdentityRequest {
  const r = object(value, [
    "schema_version",
    "literature_id",
    "document_version_id",
    "representation_sha256",
    "metadata_revision",
    "metadata_sha256",
    "budget",
  ]);
  if (r.schema_version !== 1) fail();
  const b = object(r.budget, ["max_input_bytes", "max_output_tokens"]);
  return Object.freeze({
    schema_version: 1,
    literature_id: parseLiteratureId(r.literature_id),
    document_version_id: parseLiteratureId(r.document_version_id),
    representation_sha256: hash(r.representation_sha256),
    metadata_revision: integer(r.metadata_revision, Number.MAX_SAFE_INTEGER),
    metadata_sha256: hash(r.metadata_sha256),
    budget: {
      max_input_bytes: integer(b.max_input_bytes, 1024 * 1024),
      max_output_tokens: integer(b.max_output_tokens, 16384),
    },
  });
}
export function parseArticleIdentityEvidence(
  value: unknown,
): ArticleIdentityEvidence {
  const r = object(value, ["field", "value", "quote", "evidence"]);
  if (
    !["title", "author", "doi", "arxiv", "pmid", "pmcid"].includes(
      String(r.field),
    )
  )
    fail();
  const evidence = parseEvidenceRef(r.evidence);
  if (evidence.target_kind !== "document" || evidence.content_sha256 === null)
    fail();
  return {
    field: r.field as ArticleIdentityEvidence["field"],
    value: text(r.value, 2048),
    quote: text(r.quote),
    evidence,
  };
}
export function parseArticleIdentityAssessment(
  value: unknown,
): ArticleIdentityAssessment {
  const r = object(value, [
    "schema_version",
    "assessment_id",
    "literature_id",
    "asset_id",
    "asset_sha256",
    "document_version_id",
    "representation_sha256",
    "metadata_revision",
    "metadata_sha256",
    "status",
    "reason",
    "evidence",
    "provenance",
    "method",
  ]);
  const method = object(r.method, ["id", "version", "provider", "model"]);
  if (
    r.schema_version !== 1 ||
    method.id !== "parsed-article-identity" ||
    method.version !== "1" ||
    !Array.isArray(r.evidence) ||
    r.evidence.length > 16 ||
    new TextEncoder().encode(JSON.stringify(value)).length > 65536
  )
    fail();
  const reasons: Record<string, string> = {
    "identifier-match": "match-supported",
    "title-and-author-match": "match-supported",
    "identifier-conflict": "conflict",
    "insufficient-evidence": "insufficient-evidence",
  };
  if (typeof r.reason !== "string" || reasons[r.reason] !== r.status) fail();
  const evidence = r.evidence.map(parseArticleIdentityEvidence);
  const document = parseLiteratureId(r.document_version_id);
  const representation = hash(r.representation_sha256);
  if (
    evidence.some(
      (e) =>
        e.evidence.target_kind !== "document" ||
        e.evidence.document_version_id !== document ||
        e.evidence.representation_sha256 !== representation,
    ) ||
    (r.status !== "insufficient-evidence" && evidence.length === 0)
  )
    fail();
  return Object.freeze({
    schema_version: 1,
    assessment_id: parseLiteratureId(r.assessment_id),
    literature_id: parseLiteratureId(r.literature_id),
    asset_id: parseAssetId(r.asset_id),
    asset_sha256: hash(r.asset_sha256),
    document_version_id: document,
    representation_sha256: representation,
    metadata_revision: integer(r.metadata_revision, Number.MAX_SAFE_INTEGER),
    metadata_sha256: hash(r.metadata_sha256),
    status: r.status as ArticleIdentityStatus,
    reason: r.reason as ArticleIdentityAssessment["reason"],
    evidence,
    provenance: parseProvenance(r.provenance),
    method: {
      id: "parsed-article-identity" as const,
      version: "1" as const,
      provider: text(method.provider, 128),
      model: text(method.model, 256),
    },
  });
}
