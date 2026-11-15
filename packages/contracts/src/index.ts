import { parseNetworkReadiness, type NetworkReadiness } from "./network.js";
import { parseDocumentReceipt, type ParseDocumentReceipt } from "./document.js";
export * from "./network.js";
export * from "./device-connections.js";
export * from "./import-sessions.js";
import {
  parseAcquisitionAttempts,
  parseAcquisitionRouteState,
  type AcquisitionAttempt,
  type AcquisitionRouteState,
} from "./acquisition.js";
import {
  parseSourceProblem,
  parseSourceTechnicalDetails,
  type SourceProblem,
  type SourceTechnicalDetails,
} from "./source-configuration.js";
export * from "./acquisition.js";
export * from "./snapshots.js";
export * from "./archive.js";
import {
  PUBLICATION_FORMS,
  ARTICLE_KINDS,
  parsePublicationForm,
  parseArticleKind,
  type PublicationForm,
  type ArticleKind,
} from "./metadata-types.js";
export * from "./section-roles.js";
/** Provider-neutral, closed runtime contracts shared by the TypeScript apps. */

export const CONTRACTS_VERSION = "v1" as const;

export * from "./article-identity.js";
export * from "./operations.js";
export * from "./intake.js";
export * from "./capture.js";
export * from "./long-document.js";
import {
  parseLongDocumentInfo,
  type LongDocumentInfo,
} from "./long-document.js";
import {
  parseArticleIdentityAssessment,
  type ArticleIdentityAssessment,
  type ArticleIdentityStatus,
} from "./article-identity.js";

/** Execution records have their own version; the v1 literature bytes stay frozen. */
export const EXECUTION_CONTRACT_VERSION = 1 as const;

/** Current target disposition counts; attempts never contribute extra work. */
export interface TaskProgress {
  /** Number of persisted targets, including pending and interrupted targets. */
  readonly total: number;
  /** Targets whose current disposition is completed, failed or skipped. */
  readonly done: number;
}

export function parseTaskProgress(value: unknown): TaskProgress {
  const r = exact(value, ["total", "done"], []);
  const total = integer(r.total, ["total"], 0, Number.MAX_SAFE_INTEGER);
  const done = integer(r.done, ["done"], 0, total);
  return Object.freeze({ total, done });
}

export interface CandidateCapture {
  readonly session_id: string;
  readonly article_id: string;
  readonly page_id: string;
  readonly document_generation: number;
  readonly source_url: string;
  readonly captured_at: string;
}

export interface DurableCandidate {
  readonly capture: CandidateCapture | null;
  readonly source_name: string;
  readonly source_record_id: string | null;
  readonly transfer_id: string;
  readonly state: "durable-ready";
  readonly reference: RelativeArtifactPath;
  readonly size_bytes: number;
  readonly sha256: Sha256;
}

export function parseDurableCandidate(value: unknown): DurableCandidate {
  const r = exact(
    value,
    [
      "transfer_id",
      "state",
      "reference",
      "size_bytes",
      "sha256",
      "capture",
      "source_name",
      "source_record_id",
    ],
    [],
  );
  if (
    typeof r.transfer_id !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/u.test(r.transfer_id)
  )
    fail(["transfer_id"]);
  if (r.state !== "durable-ready") fail(["state"]);
  if (
    typeof r.source_name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(r.source_name)
  )
    fail(["source_name"]);
  if (
    r.source_record_id !== null &&
    (typeof r.source_record_id !== "string" ||
      !r.source_record_id ||
      r.source_record_id.length > 1024 ||
      /[\p{Cc}\p{Cf}]/u.test(r.source_record_id))
  )
    fail(["source_record_id"]);
  const digest = hash(r.sha256, ["sha256"]);
  if (r.reference !== `.candidates/${digest}.bin`) fail(["reference"]);
  return Object.freeze({
    capture: r.capture === null ? null : parseCandidateCapture(r.capture),
    source_name: r.source_name,
    source_record_id: r.source_record_id as string | null,
    transfer_id: r.transfer_id,
    state: "durable-ready",
    reference: r.reference as RelativeArtifactPath,
    size_bytes: integer(
      r.size_bytes,
      ["size_bytes"],
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    sha256: digest,
  });
}

type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ProvenanceId = Brand<string, "ProvenanceId">;
export type MetaLiteratureId = Brand<string, "MetaLiteratureId">;
export type LiteratureId = Brand<string, "LiteratureId">;
export type ObservationId = Brand<string, "ObservationId">;
export type ReferenceId = Brand<string, "ReferenceId">;
export type AssetId = Brand<string, "AssetId">;
export type DiscoveryRunId = Brand<string, "DiscoveryRunId">;
export type Sha256 = Brand<string, "Sha256">;
export type RelativeArtifactPath = Brand<string, "RelativeArtifactPath">;

export type SourceKind =
  | "metadata-provider"
  | "asset-provider"
  | "parser"
  | "analysis"
  | "user";
export type AuthorKind = "person" | "organization" | "unknown";
export type VersionRole =
  | "published"
  | "accepted-manuscript"
  | "preprint"
  | "other";
export const LITERATURE_STATUSES = [
  "UNREVIEWED",
  "ASSET_READY",
  "ARCHIVING",
  "ARCHIVE_FAILED",
  "READY",
  "EXCLUDED",
] as const;
export type LiteratureStatus = (typeof LITERATURE_STATUSES)[number];

export interface Provenance {
  readonly provenance_id: ProvenanceId;
  readonly source_kind: SourceKind;
  readonly source_name: string;
  readonly source_record_id: string | null;
  readonly observed_at: string;
  readonly input_sha256: Sha256 | null;
  readonly parameters_sha256: Sha256 | null;
}
export interface Affiliation {
  readonly name: string;
  readonly ror: string | null;
}
export interface Author {
  readonly kind: AuthorKind;
  readonly display_name: string;
  readonly given_name: string | null;
  readonly family_name: string | null;
  readonly orcid: string | null;
  readonly affiliations: readonly Affiliation[];
}
export interface Identifier {
  readonly namespace: string;
  readonly value: string;
}
export interface LiteratureMetadata {
  readonly title: string | null;
  readonly authors: readonly Author[];
  readonly abstract: string | null;
  readonly publication_date: string | null;
  readonly publication_year: number | null;
  readonly publication_form: PublicationForm | null;
  readonly article_kind: ArticleKind | null;
  readonly language: string | null;
  readonly venue: string | null;
  readonly publisher: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
  readonly identifiers: readonly Identifier[];
  readonly keywords: readonly string[];
  readonly subject_terms: readonly string[];
}
export interface MetaLiterature {
  readonly meta_literature_id: MetaLiteratureId;
  readonly representative_literature_id: LiteratureId;
}
export interface Literature {
  readonly literature_id: LiteratureId;
  readonly meta_literature_id: MetaLiteratureId;
  readonly version_role: VersionRole;
  readonly metadata: LiteratureMetadata;
  readonly status: LiteratureStatus;
}
export interface Reference {
  readonly reference_id: ReferenceId;
  readonly source_literature_id: LiteratureId;
  readonly target_literature_id: LiteratureId;
}
export interface Asset {
  readonly asset_id: AssetId;
  readonly sha256: Sha256;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly path: RelativeArtifactPath;
}
export const MISSING_STEPS = [
  "arrange",
  "render",
  "primary-pdf",
  "raw-parse",
  "proofread",
  "document",
  "structure",
  "metadata",
  "references",
  "tags",
] as const;
export type MissingStep = (typeof MISSING_STEPS)[number];
export interface LibraryQuery {
  readonly folder?: {
    readonly id: string;
    readonly include_descendants: boolean;
  } | null;
  readonly recently_opened?: boolean;
  readonly text: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly author_orcids: readonly string[];
  readonly identifiers: readonly Identifier[];
  readonly publication_year_from: number | null;
  readonly publication_year_to: number | null;
  readonly venue: string | null;
  readonly publisher: string | null;
  readonly publication_forms: readonly PublicationForm[];
  readonly article_kinds: readonly ArticleKind[];
  readonly languages: readonly string[];
  readonly keywords: readonly string[];
  readonly subject_terms: readonly string[];
  readonly version_roles: readonly VersionRole[];
  readonly statuses: readonly LiteratureStatus[];
  readonly missing_steps: readonly MissingStep[];
  readonly needs_manual_pdf: boolean | null;
  readonly discovery_run_ids: readonly DiscoveryRunId[];
  readonly intake_batch_ids: readonly import("./intake.js").IntakeBatchId[];
  readonly tags?: {
    readonly ids: readonly string[];
    readonly mode: "primary" | "any";
  };
}
export interface StableFailure {
  readonly code: string;
  readonly reason: string;
  readonly action: string;
  readonly retryable: boolean;
}

export type LibrarySort =
  | "intake-desc"
  | "opened-desc"
  | "publication-year-desc"
  | "publication-year-asc"
  | "title-asc"
  | "title-desc"
  | "relevance";
export interface LibrarySearchRequest {
  readonly query: LibraryQuery;
  readonly sort: LibrarySort;
  readonly limit: number;
  readonly cursor: string | null;
}
export interface LiteratureSearchItem {
  readonly long_document?: LongDocumentInfo | null;
  readonly folder_ids?: readonly string[];
  readonly last_opened_at?: string | null;
  /** Earliest attached metadata observation, UTC; null when unavailable. */
  readonly intake_at?: string | null;
  readonly tags?: readonly {
    readonly tag_id: string;
    readonly name: string;
    readonly rank: number;
  }[];

  readonly literature: Literature;
  readonly metadata_revision: number;
  readonly metadata_sha256: Sha256;
  readonly missing_step: MissingStep | null;
  readonly needs_manual_pdf: boolean;
}
export interface LibrarySearchPage {
  readonly tag_backfill_pending?: number;
  readonly items: readonly LiteratureSearchItem[];
  readonly total_count: number;
  readonly next_cursor: string | null;
}
export type ReferenceDirection = "references" | "cited-by";
export interface LiteratureReferenceRequest {
  readonly literature_id: LiteratureId;
  readonly direction: ReferenceDirection;
  readonly limit: number;
  readonly cursor: string | null;
}
export interface ArchiveReferenceTextSupport {
  readonly kind: "archive_reference_text";
  readonly document_version_id: string;
  readonly segment_ids: readonly string[];
  readonly reference_index: number;
}
export type ReferenceSupportSource =
  | ArchiveReferenceTextSupport
  | { readonly kind: "provider_relation"; readonly observation_id: string }
  | {
      readonly kind: "metadata_reference_text";
      readonly metadata_observation_id: string;
      readonly reference_index: number;
    };
export interface ReferenceSupport {
  readonly reference_id: ReferenceId;
  readonly source: ReferenceSupportSource;
}
export interface ReferenceDetail {
  readonly reference: Reference;
  readonly source: LiteratureSearchItem;
  readonly target: LiteratureSearchItem;
  readonly supports: readonly ReferenceSupport[];
}
export interface LiteratureReferenceItem {
  readonly reference: Reference;
  readonly related_literature: LiteratureSearchItem;
  readonly support_count: number;
}
export interface LiteratureReferencePage {
  readonly items: readonly LiteratureReferenceItem[];
  readonly total_count: number;
  readonly next_cursor: string | null;
}
export function parseLiteratureReferenceRequest(
  value: unknown,
): LiteratureReferenceRequest {
  const r = exact(
    { limit: 50, cursor: null, ...object(value, []) },
    ["literature_id", "direction", "limit", "cursor"],
    ["source_name"],
  );
  if (r.cursor !== null && (typeof r.cursor !== "string" || !r.cursor.trim()))
    fail();
  return Object.freeze({
    literature_id: id<"LiteratureId">(r.literature_id, []),
    direction: enumeration<ReferenceDirection>(
      r.direction,
      ["references", "cited-by"],
      [],
    ),
    limit: integer(r.limit, [], 1, Number.MAX_SAFE_INTEGER),
    cursor: r.cursor as string | null,
  });
}
export function parseReferenceId(value: unknown): ReferenceId {
  return id<"ReferenceId">(value, []);
}
export function parseAssetId(value: unknown): AssetId {
  return id<"AssetId">(value, []);
}
export function parseReferenceDetail(value: unknown): ReferenceDetail {
  const r = exact(value, ["reference", "source", "target", "supports"], []);
  const reference = parseReference(r.reference);
  const source = parseLiteratureSearchItem(r.source);
  const target = parseLiteratureSearchItem(r.target);
  if (
    source.literature.literature_id !== reference.source_literature_id ||
    target.literature.literature_id !== reference.target_literature_id
  )
    fail();
  const supports = array(r.supports, []).map((value) => {
    const s = exact(value, ["reference_id", "source"], []);
    if (s.reference_id !== reference.reference_id) fail();
    const kind = object(s.source, []).kind;
    let locator: ReferenceSupportSource;
    if (kind === "provider_relation") {
      const p = exact(s.source, ["kind", "observation_id"], []);
      locator = Object.freeze({
        kind,
        observation_id: text(p.observation_id, [], true),
      });
    } else if (kind === "metadata_reference_text") {
      const p = exact(
        s.source,
        ["kind", "metadata_observation_id", "reference_index"],
        [],
      );
      locator = Object.freeze({
        kind,
        metadata_observation_id: text(p.metadata_observation_id, [], true),
        reference_index: integer(
          p.reference_index,
          [],
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      });
    } else if (kind === "archive_reference_text") {
      const p = exact(
        s.source,
        ["kind", "document_version_id", "segment_ids", "reference_index"],
        [],
      );
      const segments = list(p.segment_ids, [], (item, path) =>
        text(item, path, true),
      );
      if (
        !segments.length ||
        segments.length > 4096 ||
        new Set(segments).size !== segments.length
      )
        fail();
      locator = Object.freeze({
        kind,
        document_version_id: parseAssetId(p.document_version_id),
        segment_ids: segments,
        reference_index: integer(
          p.reference_index,
          [],
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      });
    } else return fail();
    return Object.freeze({
      reference_id: reference.reference_id,
      source: locator,
    });
  });
  if (
    !supports.length ||
    new Set(supports.map((s) => JSON.stringify(s.source))).size !==
      supports.length
  )
    fail();
  return Object.freeze({
    reference,
    source,
    target,
    supports: Object.freeze(supports),
  });
}
export function parseLibrarySearchRequest(
  value: unknown,
): LibrarySearchRequest {
  const r = exact(
    {
      sort: "intake-desc",
      limit: 50,
      cursor: null,
      ...object(value, []),
    },
    ["query", "sort", "limit", "cursor"],
    [],
  );
  const query = parseLibraryQuery({
    text: null,
    title: null,
    author: null,
    author_orcids: [],
    identifiers: [],
    publication_year_from: null,
    publication_year_to: null,
    venue: null,
    publisher: null,
    publication_forms: [],
    article_kinds: [],
    languages: [],
    keywords: [],
    version_roles: [],
    statuses: [],
    missing_steps: [],
    needs_manual_pdf: null,
    discovery_run_ids: [],
    ...object(r.query, []),
  });
  const sort = enumeration<LibrarySort>(
    !Object.hasOwn(object(value, []), "sort") && query.recently_opened
      ? "opened-desc"
      : r.sort,
    [
      "intake-desc",
      "opened-desc",
      "publication-year-desc",
      "publication-year-asc",
      "title-asc",
      "title-desc",
      "relevance",
    ],
    [],
  );
  if (sort === "relevance" && query.text === null) fail();
  if (r.cursor !== null && (typeof r.cursor !== "string" || !r.cursor.trim()))
    fail();
  return Object.freeze({
    query,
    sort,
    limit: integer(r.limit, [], 1, Number.MAX_SAFE_INTEGER),
    cursor: r.cursor as string | null,
  });
}
export function parseLiteratureSearchItem(
  value: unknown,
): LiteratureSearchItem {
  const r = exact(
    {
      tags: undefined,
      long_document: null,
      intake_at: null,
      last_opened_at: null,
      folder_ids: [],
      ...object(value, []),
    },
    [
      "tags",
      "long_document",
      "intake_at",
      "last_opened_at",
      "folder_ids",
      "literature",
      "metadata_revision",
      "metadata_sha256",
      "missing_step",
      "needs_manual_pdf",
    ],
    [],
  );
  if (
    r.intake_at !== null &&
    (typeof r.intake_at !== "string" ||
      !Number.isFinite(Date.parse(r.intake_at)) ||
      new Date(r.intake_at).toISOString() !== r.intake_at)
  )
    fail(["intake_at"]);
  return Object.freeze({
    long_document:
      r.long_document === null ? null : parseLongDocumentInfo(r.long_document),
    intake_at: r.intake_at as string | null,
    last_opened_at:
      r.last_opened_at === null ? null : parseUtcTimestamp(r.last_opened_at),
    folder_ids: list(r.folder_ids, [], (v) => parseAssetId(v)),
    ...(r.tags === undefined
      ? {}
      : {
          tags: list(r.tags, [], (v) => {
            const t = exact(v, ["tag_id", "name", "rank"], []);
            return {
              tag_id: parseAssetId(t.tag_id),
              name: text(t.name, []),
              rank: integer(t.rank, [], 1, 1000),
            };
          }),
        }),
    literature: parseLiterature(r.literature),
    metadata_revision: integer(
      r.metadata_revision,
      [],
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    metadata_sha256: hash(r.metadata_sha256, []),
    missing_step:
      r.missing_step === null
        ? null
        : enumeration<MissingStep>(r.missing_step, MISSING_STEPS, []),
    needs_manual_pdf: wireBoolean(r.needs_manual_pdf),
  });
}
export type ReportEnd =
  | { readonly kind: "finished" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly failure: StableFailure };

/** The frozen completion goal of one database-completion request. */
export type BatchGoal = "ASSET_READY" | "PARSER_RESULT_READY";

/** The business stage that produced one completion target outcome. */
export type CompletionStage =
  | "acquisition"
  | "parsing"
  | "analysis"
  | "literature";

/** A frozen request target, selected before any stage ran. */
export type CompletionTarget =
  | {
      readonly kind: "meta-literature";
      readonly meta_literature_id: MetaLiteratureId;
    }
  | { readonly kind: "literature"; readonly literature_id: LiteratureId };

/**
 * The five mutually exclusive partitions of a database completion report.
 * Order is the presenter-facing contract order; every frozen target appears in
 * exactly one of them, so their lengths sum to the number of selected targets.
 */
export const DATABASE_COMPLETION_REPORT_PARTITIONS = [
  "completed",
  "failed",
  "skipped",
  "notStarted",
  "interrupted",
] as const;
export type DatabaseCompletionReportPartition =
  (typeof DATABASE_COMPLETION_REPORT_PARTITIONS)[number];

/** The target reached its goal; `literature_id` is the concrete version. */
export interface CompletedCompletionTarget {
  readonly target: CompletionTarget;
  readonly literature_id: LiteratureId;
  /** Present when parsing actually ran; older entries and PDF-only completion omit it. */
  readonly receipt?: ParseDocumentReceipt;
}
/** Stable reasons for a target that was deliberately not executed. */
export type SkippedCompletionReason =
  | "manual-pdf-required"
  | "already-satisfied"
  | "not-eligible";
/** A target that was explicitly not executed, never a hidden system error. */
export interface SkippedCompletionTarget {
  readonly target: CompletionTarget;
  readonly reason: SkippedCompletionReason;
  readonly literature_ids: readonly LiteratureId[];
}
/** A target failed inside one stage; `literature_id` is null before a version exists. */
export interface FailedCompletionTarget {
  readonly target: CompletionTarget;
  readonly literature_id: LiteratureId | null;
  readonly stage: CompletionStage;
  readonly failure: StableFailure;
}
/** A started target cancelled by a user-controlled stop. */
export interface InterruptedCompletionTarget {
  readonly target: CompletionTarget;
  readonly literature_id: LiteratureId | null;
}
/** A frozen target that was never started. */
export interface NotStartedCompletionTarget {
  readonly target: CompletionTarget;
}

/**
 * Non-persistent, provider-neutral receipt of one database-completion request.
 * Partitions are mutually exclusive per target and the report never enters the
 * catalog, a durable run, or the next target selection. `end.kind = "finished"`
 * means the request reached its normal boundary and therefore cannot coexist
 * with `interrupted` targets, which only a user-controlled stop produces.
 */
export interface DatabaseCompletionReport {
  readonly kind: "database-completion";
  readonly end: ReportEnd;
  readonly goal: BatchGoal;
  readonly completed: readonly CompletedCompletionTarget[];
  readonly failed: readonly FailedCompletionTarget[];
  readonly skipped: readonly SkippedCompletionTarget[];
  readonly notStarted: readonly NotStartedCompletionTarget[];
  readonly interrupted: readonly InterruptedCompletionTarget[];
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-[0-9X]{4}$/;
const SECRET_RE =
  /\b(?:api[_ -]?key|access[_ -]?token|authorization|bearer|cookie|password|secret|token|signature|sig)\s*[:=]\s*\S+/i;
const ABSOLUTE_PATH_RE = /(?:^|[\s(])\/(?:[^\s/]+\/)*[^\s]*/;

export class ContractValidationError extends Error {
  readonly code = "invalid-contract" as const;
  readonly path: readonly string[];
  constructor(path: readonly string[] = []) {
    super("contract validation failed");
    this.name = "ContractValidationError";
    this.path = Object.freeze([...path]);
  }
}
function fail(path: readonly string[] = []): never {
  throw new ContractValidationError(path);
}
function object(
  value: unknown,
  path: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(path);
  return value as Record<string, unknown>;
}
function exact(
  value: unknown,
  keys: readonly string[],
  path: readonly string[],
): Record<string, unknown> {
  const result = object(value, path);
  const expected = new Set(keys);
  if (
    Object.keys(result).some((key) => !expected.has(key)) ||
    keys.some((key) => !(key in result))
  )
    fail(path);
  return result;
}
function text(
  value: unknown,
  path: readonly string[],
  nonblank = false,
): string {
  if (typeof value !== "string") fail(path);
  const normalized = value.normalize("NFC").trim();
  if (nonblank && normalized.length === 0) fail(path);
  if (hasLoneSurrogate(normalized)) fail(path);
  if (
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  )
    fail(path);
  return normalized;
}
function rawText(value: unknown, path: readonly string[]): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasLoneSurrogate(value)
  )
    fail(path);
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  )
    fail(path);
  return value;
}
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function nullableText(value: unknown, path: readonly string[]): string | null {
  return value === null ? null : text(value, path, true);
}
function stableText(value: unknown, path: readonly string[]): string {
  const result = text(value, path, true);
  if (
    SECRET_RE.test(result) ||
    ABSOLUTE_PATH_RE.test(result) ||
    /(?:https?|ftp|file):\/\//i.test(result)
  )
    fail(path);
  return result;
}
function validOrcid(value: string): boolean {
  if (!ORCID_RE.test(value)) return false;
  const digits = value.replaceAll("-", "");
  let total = 0;
  for (const digit of digits.slice(0, -1)) total = (total + Number(digit)) * 2;
  const check = (12 - (total % 11)) % 11;
  return digits.at(-1) === (check === 10 ? "X" : String(check));
}
function array(value: unknown, path: readonly string[]): readonly unknown[] {
  if (!Array.isArray(value)) fail(path);
  return value;
}
function enumeration<T extends string>(
  value: unknown,
  values: readonly T[],
  path: readonly string[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(path);
  return value as T;
}
function integer(
  value: unknown,
  path: readonly string[],
  minimum = 1,
  maximum = 9999,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail(path);
  return value;
}
function optionalInteger(
  value: unknown,
  path: readonly string[],
): number | null {
  return value === null ? null : integer(value, path);
}
function id<T extends string>(
  value: unknown,
  path: readonly string[],
): Brand<string, T> {
  const candidate = rawText(value, path);
  if (!ID_RE.test(candidate)) fail(path);
  return candidate as Brand<string, T>;
}
function hash(value: unknown, path: readonly string[]): Sha256 {
  const candidate = rawText(value, path);
  if (!HASH_RE.test(candidate)) fail(path);
  return candidate as Sha256;
}
function list<T>(
  value: unknown,
  path: readonly string[],
  parser: (value: unknown, path: readonly string[]) => T,
): readonly T[] {
  return Object.freeze(
    array(value, path).map((item, index) =>
      parser(item, [...path, String(index)]),
    ),
  );
}

export function parseProvenance(value: unknown): Provenance {
  const record = exact(
    value,
    [
      "provenance_id",
      "source_kind",
      "source_name",
      "source_record_id",
      "observed_at",
      "input_sha256",
      "parameters_sha256",
    ],
    [],
  );
  return Object.freeze({
    provenance_id: id<"ProvenanceId">(record.provenance_id, ["provenance_id"]),
    source_kind: enumeration(
      record.source_kind,
      ["metadata-provider", "asset-provider", "parser", "analysis", "user"],
      ["source_kind"],
    ),
    source_name: text(record.source_name, ["source_name"], true),
    source_record_id: nullableText(record.source_record_id, [
      "source_record_id",
    ]),
    observed_at: parseUtcTimestamp(record.observed_at, ["observed_at"]),
    input_sha256:
      record.input_sha256 === null
        ? null
        : hash(record.input_sha256, ["input_sha256"]),
    parameters_sha256:
      record.parameters_sha256 === null
        ? null
        : hash(record.parameters_sha256, ["parameters_sha256"]),
  });
}
export function parseIdentifier(value: unknown): Identifier {
  const record = exact(value, ["namespace", "value"], []);
  const namespace = text(record.namespace, ["namespace"], true).toLowerCase();
  let identifier = text(record.value, ["value"], true);
  if (namespace === "doi") {
    if (/^https?:\/\//i.test(identifier)) {
      const match = identifier.match(
        /^https?:\/\/(?:dx\.)?doi\.org\/([^?#]+)$/i,
      );
      if (match === null) fail(["value"]);
      identifier = match[1] ?? fail(["value"]);
    } else {
      identifier = identifier.replace(/^doi:\s*/i, "");
    }
    identifier = identifier.toLowerCase();
    if (!/^10\.\d{4,9}\/\S+$/i.test(identifier) || /\s/.test(identifier))
      fail(["value"]);
  } else if (namespace === "arxiv") {
    identifier = identifier
      .replace(/^arxiv:/i, "")
      .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
      .replace(/\.pdf$/i, "")
      .replace(/v\d+$/i, "");
    if (
      !/^(?:\d{4}\.\d{4,5}|[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z]{2})?\/\d{7})$/.test(
        identifier,
      )
    )
      fail(["value"]);
  } else if (namespace === "pmid" && !/^\d+$/.test(identifier)) fail(["value"]);
  else if (namespace === "pmcid") {
    if (!/^PMC\d+$/i.test(identifier)) fail(["value"]);
    identifier = `PMC${identifier.slice(3)}`;
  }
  return Object.freeze({ namespace, value: identifier });
}
export function parseAffiliation(
  value: unknown,
  path: readonly string[] = [],
): Affiliation {
  const record = exact(value, ["name", "ror"], path);
  const ror = nullableText(record.ror, [...path, "ror"]);
  if (ror !== null && !/^0[0-9a-z]{8}$/.test(ror.toLowerCase()))
    fail([...path, "ror"]);
  return Object.freeze({
    name: text(record.name, [...path, "name"], true),
    ror: ror?.toLowerCase() ?? null,
  });
}
export function parseAuthor(
  value: unknown,
  path: readonly string[] = [],
): Author {
  const record = exact(
    value,
    [
      "kind",
      "display_name",
      "given_name",
      "family_name",
      "orcid",
      "affiliations",
    ],
    path,
  );
  const orcid = nullableText(record.orcid, [...path, "orcid"]);
  if (orcid !== null && !validOrcid(orcid.toUpperCase()))
    fail([...path, "orcid"]);
  return Object.freeze({
    kind: enumeration(
      record.kind,
      ["person", "organization", "unknown"],
      [...path, "kind"],
    ),
    display_name: text(record.display_name, [...path, "display_name"], true),
    given_name: nullableText(record.given_name, [...path, "given_name"]),
    family_name: nullableText(record.family_name, [...path, "family_name"]),
    orcid: orcid?.toUpperCase() ?? null,
    affiliations: list(
      record.affiliations,
      [...path, "affiliations"],
      parseAffiliation,
    ),
  });
}
export function parseLiteratureMetadata(value: unknown): LiteratureMetadata {
  const record = exact(
    { subject_terms: [], ...object(value, []) },
    [
      "title",
      "authors",
      "abstract",
      "publication_date",
      "publication_year",
      "publication_form",
      "article_kind",
      "language",
      "venue",
      "publisher",
      "volume",
      "issue",
      "pages",
      "identifiers",
      "keywords",
      "subject_terms",
    ],
    [],
  );
  return Object.freeze({
    title: nullableText(record.title, ["title"]),
    authors: list(record.authors, ["authors"], parseAuthor),
    abstract: nullableText(record.abstract, ["abstract"]),
    publication_date: nullableText(record.publication_date, [
      "publication_date",
    ]),
    publication_year: optionalInteger(record.publication_year, [
      "publication_year",
    ]),
    publication_form: parsePublicationForm(record.publication_form),
    article_kind: parseArticleKind(record.article_kind),
    language: nullableText(record.language, ["language"]),
    venue: nullableText(record.venue, ["venue"]),
    publisher: nullableText(record.publisher, ["publisher"]),
    volume: nullableText(record.volume, ["volume"]),
    issue: nullableText(record.issue, ["issue"]),
    pages: nullableText(record.pages, ["pages"]),
    identifiers: list(record.identifiers, ["identifiers"], parseIdentifier),
    subject_terms: list(record.subject_terms, ["subject_terms"], (item, path) =>
      text(item, path, true),
    ),
    keywords: list(record.keywords, ["keywords"], (item, path) =>
      text(item, path, true),
    ),
  });
}
export function parseMetaLiterature(value: unknown): MetaLiterature {
  const record = exact(
    value,
    ["meta_literature_id", "representative_literature_id"],
    [],
  );
  return Object.freeze({
    meta_literature_id: id<"MetaLiteratureId">(record.meta_literature_id, [
      "meta_literature_id",
    ]),
    representative_literature_id: id<"LiteratureId">(
      record.representative_literature_id,
      ["representative_literature_id"],
    ),
  });
}
export function parseLiterature(value: unknown): Literature {
  const record = exact(
    value,
    [
      "literature_id",
      "meta_literature_id",
      "version_role",
      "metadata",
      "status",
    ],
    [],
  );
  return Object.freeze({
    literature_id: id<"LiteratureId">(record.literature_id, ["literature_id"]),
    meta_literature_id: id<"MetaLiteratureId">(record.meta_literature_id, [
      "meta_literature_id",
    ]),
    version_role: enumeration(
      record.version_role,
      ["published", "accepted-manuscript", "preprint", "other"],
      ["version_role"],
    ),
    metadata: parseLiteratureMetadata(record.metadata),
    status: enumeration(record.status, LITERATURE_STATUSES, ["status"]),
  });
}
export function parseReference(value: unknown): Reference {
  const record = exact(
    value,
    ["reference_id", "source_literature_id", "target_literature_id"],
    [],
  );
  const source = id<"LiteratureId">(record.source_literature_id, [
    "source_literature_id",
  ]);
  const target = id<"LiteratureId">(record.target_literature_id, [
    "target_literature_id",
  ]);
  if (source === target) fail([]);
  return Object.freeze({
    reference_id: id<"ReferenceId">(record.reference_id, ["reference_id"]),
    source_literature_id: source,
    target_literature_id: target,
  });
}
export function parseAsset(value: unknown): Asset {
  const record = exact(
    value,
    ["asset_id", "sha256", "size_bytes", "media_type", "path"],
    [],
  );
  const size = integer(
    record.size_bytes,
    ["size_bytes"],
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const path = rawText(record.path, ["path"]);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail(["path"]);
  return Object.freeze({
    asset_id: id<"AssetId">(record.asset_id, ["asset_id"]),
    sha256: hash(record.sha256, ["sha256"]),
    size_bytes: size,
    media_type: text(record.media_type, ["media_type"], true),
    path: path as RelativeArtifactPath,
  });
}
export function parseLibraryQuery(value: unknown): LibraryQuery {
  const record = exact(
    {
      intake_batch_ids: [],
      subject_terms: [],
      tags: undefined,
      folder: undefined,
      recently_opened: undefined,
      ...object(value, []),
    },
    [
      "text",
      "title",
      "author",
      "author_orcids",
      "identifiers",
      "publication_year_from",
      "publication_year_to",
      "venue",
      "publisher",
      "publication_forms",
      "article_kinds",
      "languages",
      "keywords",
      "subject_terms",
      "intake_batch_ids",
      "version_roles",
      "statuses",
      "missing_steps",
      "needs_manual_pdf",
      "discovery_run_ids",
      "tags",
      "folder",
      "recently_opened",
    ],
    [],
  );
  const from = optionalInteger(record.publication_year_from, [
    "publication_year_from",
  ]);
  const to = optionalInteger(record.publication_year_to, [
    "publication_year_to",
  ]);
  if (from !== null && to !== null && from > to) fail([]);
  if ([from, to].some((year) => year !== null && (year < 1 || year > 9999)))
    fail([]);
  return Object.freeze({
    text: nullableText(record.text, ["text"]),
    title: nullableText(record.title, ["title"]),
    author: nullableText(record.author, ["author"]),
    author_orcids: list(
      record.author_orcids,
      ["author_orcids"],
      (item, path) => {
        const candidate = text(item, path, true).toUpperCase();
        if (!validOrcid(candidate)) fail(path);
        return candidate;
      },
    ),
    identifiers: list(record.identifiers, ["identifiers"], parseIdentifier),
    publication_year_from: from,
    publication_year_to: to,
    venue: nullableText(record.venue, ["venue"]),
    publisher: nullableText(record.publisher, ["publisher"]),
    publication_forms: list(
      record.publication_forms,
      ["publication_forms"],
      (item, path) => enumeration(item, PUBLICATION_FORMS, path),
    ),
    article_kinds: list(record.article_kinds, ["article_kinds"], (item, path) =>
      enumeration(item, ARTICLE_KINDS, path),
    ),
    languages: list(record.languages, ["languages"], (item, path) =>
      text(item, path, true),
    ),
    intake_batch_ids: list(
      record.intake_batch_ids,
      ["intake_batch_ids"],
      (v, p) => id<"IntakeBatchId">(v, p),
    ),
    subject_terms: list(record.subject_terms, ["subject_terms"], (v, p) =>
      text(v, p, true),
    ),
    keywords: list(record.keywords, ["keywords"], (item, path) =>
      text(item, path, true),
    ),
    version_roles: list<VersionRole>(
      record.version_roles,
      ["version_roles"],
      (item, path) =>
        enumeration(
          item,
          ["published", "accepted-manuscript", "preprint", "other"],
          path,
        ),
    ),
    statuses: list<LiteratureStatus>(
      record.statuses,
      ["statuses"],
      (item, path) => enumeration(item, LITERATURE_STATUSES, path),
    ),
    missing_steps: list<MissingStep>(
      record.missing_steps,
      ["missing_steps"],
      (item, path) => enumeration(item, MISSING_STEPS, path),
    ),
    needs_manual_pdf:
      record.needs_manual_pdf === null
        ? null
        : typeof record.needs_manual_pdf === "boolean"
          ? record.needs_manual_pdf
          : fail(["needs_manual_pdf"]),
    ...(record.tags === undefined
      ? {}
      : {
          tags: (() => {
            const t = exact(record.tags, ["ids", "mode"], []);
            const ids = list(t.ids, ["tags", "ids"], (v, p) =>
              text(v, p, true),
            );
            if (ids.length > 64 || ids.some((x) => x.length > 256))
              fail(["tags"]);
            return Object.freeze({
              ids,
              mode: enumeration(t.mode, ["primary", "any"] as const, [
                "tags",
                "mode",
              ]),
            });
          })(),
        }),
    ...(record.folder === undefined
      ? {}
      : {
          folder:
            record.folder === null
              ? null
              : (() => {
                  const f = exact(
                    record.folder,
                    ["id", "include_descendants"],
                    [],
                  );
                  return {
                    id: parseAssetId(f.id),
                    include_descendants: wireBoolean(f.include_descendants),
                  };
                })(),
        }),
    ...(record.recently_opened === undefined
      ? {}
      : { recently_opened: wireBoolean(record.recently_opened) }),
    discovery_run_ids: list(
      record.discovery_run_ids,
      ["discovery_run_ids"],
      (item, path) => id<"DiscoveryRunId">(item, path),
    ),
  });
}
export function parseStableFailure(value: unknown): StableFailure {
  const record = exact(value, ["code", "reason", "action", "retryable"], []);
  return Object.freeze({
    code: stableText(record.code, ["code"]),
    reason: stableText(record.reason, ["reason"]),
    action: stableText(record.action, ["action"]),
    retryable:
      typeof record.retryable === "boolean"
        ? record.retryable
        : fail(["retryable"]),
  });
}
export function parseReportEnd(value: unknown): ReportEnd {
  const record = object(value, []);
  const kind = enumeration(
    record.kind,
    ["finished", "interrupted", "failed"],
    ["kind"],
  );
  if (kind === "finished") {
    exact(record, ["kind"], []);
    return Object.freeze({ kind });
  }
  if (kind === "interrupted") {
    exact(record, ["kind"], []);
    return Object.freeze({ kind });
  }
  const failed = exact(record, ["kind", "failure"], []);
  return Object.freeze({ kind, failure: parseStableFailure(failed.failure) });
}
export function parseCompletionTarget(
  value: unknown,
  path: readonly string[] = [],
): CompletionTarget {
  const record = object(value, path);
  if (record.kind === "meta-literature") {
    const target = exact(record, ["kind", "meta_literature_id"], path);
    return Object.freeze({
      kind: "meta-literature" as const,
      meta_literature_id: id<"MetaLiteratureId">(target.meta_literature_id, [
        ...path,
        "meta_literature_id",
      ]),
    });
  }
  if (record.kind === "literature") {
    const target = exact(record, ["kind", "literature_id"], path);
    return Object.freeze({
      kind: "literature" as const,
      literature_id: id<"LiteratureId">(target.literature_id, [
        ...path,
        "literature_id",
      ]),
    });
  }
  return fail([...path, "kind"]);
}
function completionTargetKey(target: CompletionTarget): string {
  return target.kind === "meta-literature"
    ? `meta-literature:${target.meta_literature_id}`
    : `literature:${target.literature_id}`;
}
function parseCompletedCompletionTarget(
  value: unknown,
  path: readonly string[],
): CompletedCompletionTarget {
  const record = object(value, path);
  const hasReceipt = "receipt" in record;
  exact(
    record,
    ["target", "literature_id", ...(hasReceipt ? ["receipt"] : [])],
    path,
  );
  const literatureId = id<"LiteratureId">(record.literature_id, [
    ...path,
    "literature_id",
  ]);
  let receipt: ParseDocumentReceipt | undefined;
  if (hasReceipt) {
    try {
      receipt = parseDocumentReceipt(record.receipt);
    } catch (error) {
      if (error instanceof ContractValidationError)
        throw new ContractValidationError([...path, "receipt", ...error.path]);
      throw error;
    }
  }
  if (receipt && receipt.literature_id !== literatureId)
    fail([...path, "receipt", "literature_id"]);
  return Object.freeze({
    target: parseCompletionTarget(record.target, [...path, "target"]),
    literature_id: literatureId,
    ...(receipt ? { receipt } : {}),
  });
}
function parseSkippedCompletionTarget(
  value: unknown,
  path: readonly string[],
): SkippedCompletionTarget {
  const record = exact(value, ["target", "reason", "literature_ids"], path);
  const literatureIds = list(
    record.literature_ids,
    [...path, "literature_ids"],
    (item, itemPath) => id<"LiteratureId">(item, itemPath),
  );
  if (new Set(literatureIds).size !== literatureIds.length)
    fail([...path, "literature_ids"]);
  return Object.freeze({
    target: parseCompletionTarget(record.target, [...path, "target"]),
    reason: enumeration<SkippedCompletionReason>(
      record.reason,
      ["manual-pdf-required", "already-satisfied", "not-eligible"],
      [...path, "reason"],
    ),
    literature_ids: literatureIds,
  });
}
function parseFailedCompletionTarget(
  value: unknown,
  path: readonly string[],
): FailedCompletionTarget {
  const record = exact(
    value,
    ["target", "literature_id", "stage", "failure"],
    path,
  );
  return Object.freeze({
    target: parseCompletionTarget(record.target, [...path, "target"]),
    literature_id:
      record.literature_id === null
        ? null
        : id<"LiteratureId">(record.literature_id, [...path, "literature_id"]),
    stage: enumeration<CompletionStage>(
      record.stage,
      ["acquisition", "parsing", "analysis", "literature"],
      [...path, "stage"],
    ),
    failure: parseStableFailure(record.failure),
  });
}
function parseInterruptedCompletionTarget(
  value: unknown,
  path: readonly string[],
): InterruptedCompletionTarget {
  const record = exact(value, ["target", "literature_id"], path);
  return Object.freeze({
    target: parseCompletionTarget(record.target, [...path, "target"]),
    literature_id:
      record.literature_id === null
        ? null
        : id<"LiteratureId">(record.literature_id, [...path, "literature_id"]),
  });
}
function parseNotStartedCompletionTarget(
  value: unknown,
  path: readonly string[],
): NotStartedCompletionTarget {
  const record = exact(value, ["target"], path);
  return Object.freeze({
    target: parseCompletionTarget(record.target, [...path, "target"]),
  });
}
export function parseDatabaseCompletionReport(
  value: unknown,
): DatabaseCompletionReport {
  const record = exact(
    value,
    [
      "kind",
      "end",
      "goal",
      "completed",
      "failed",
      "skipped",
      "notStarted",
      "interrupted",
    ],
    [],
  );
  if (record.kind !== "database-completion") fail(["kind"]);
  const end = parseReportEnd(record.end);
  const goal = enumeration<BatchGoal>(
    record.goal,
    ["ASSET_READY", "PARSER_RESULT_READY"],
    ["goal"],
  );
  const completed = list(
    record.completed,
    ["completed"],
    parseCompletedCompletionTarget,
  );
  const failed = list(record.failed, ["failed"], parseFailedCompletionTarget);
  const skipped = list(
    record.skipped,
    ["skipped"],
    parseSkippedCompletionTarget,
  );
  const notStarted = list(
    record.notStarted,
    ["notStarted"],
    parseNotStartedCompletionTarget,
  );
  const interrupted = list(
    record.interrupted,
    ["interrupted"],
    parseInterruptedCompletionTarget,
  );
  const partitions: readonly (readonly [
    DatabaseCompletionReportPartition,
    readonly { readonly target: CompletionTarget }[],
  ])[] = [
    ["completed", completed],
    ["failed", failed],
    ["skipped", skipped],
    ["notStarted", notStarted],
    ["interrupted", interrupted],
  ];
  const targets = new Set<string>();
  for (const [partition, items] of partitions) {
    for (const [index, item] of items.entries()) {
      const key = completionTargetKey(item.target);
      if (targets.has(key)) fail([partition, String(index), "target"]);
      targets.add(key);
    }
  }
  if (end.kind === "finished" && interrupted.length > 0) fail(["interrupted"]);
  return Object.freeze({
    kind: "database-completion",
    end,
    goal,
    completed,
    failed,
    skipped,
    notStarted,
    interrupted,
  });
}
export function parseUtcTimestamp(
  value: unknown,
  path: readonly string[] = [],
): string {
  const candidate = rawText(value, path);
  const parsed = new Date(candidate);
  if (!RFC3339_UTC_RE.test(candidate) || Number.isNaN(parsed.getTime()))
    fail(path);
  const date = candidate.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  )
    fail(path);
  return candidate;
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") {
    const normalized = value.normalize("NFC");
    if (hasLoneSurrogate(normalized)) fail();
    return normalized;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const entries = Object.keys(input).map(
      (key) => [key.normalize("NFC"), input[key]] as const,
    );
    if (new Set(entries.map(([key]) => key)).size !== entries.length) fail();
    return Object.fromEntries(
      entries
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  fail();
}
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) fail();
  return new TextEncoder().encode(encoded);
}
export async function sha256(value: Uint8Array): Promise<Sha256> {
  // HTTP IP workbenches lack SubtleCrypto. Preserve the exact hash contract there.
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(
        await globalThis.crypto.subtle.digest(
          "SHA-256",
          value as unknown as BufferSource,
        ),
      )
    : (await import("@noble/hashes/sha2.js")).sha256(value);
  return Array.from(digest, (item) => item.toString(16).padStart(2, "0")).join(
    "",
  ) as Sha256;
}
export function parseStrictJsonValue(value: string | Uint8Array): unknown {
  let source: string;
  try {
    source =
      typeof value === "string"
        ? value
        : new TextDecoder("utf-8", { fatal: true }).decode(value);
    const parsed: unknown = JSON.parse(source);
    if (hasDuplicateKeys(source)) fail();
    return parsed;
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    fail();
  }
}
export function parseStrictJsonObject(
  value: string | Uint8Array,
): Record<string, unknown> {
  return object(parseStrictJsonValue(value), []);
}
function hasDuplicateKeys(source: string): boolean {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(source[index] ?? "")) index += 1;
  };
  const stringEnd = (): number => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (!escaped && character === '"') return index;
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    }
    return start;
  };
  const scanValue = (): boolean => {
    whitespace();
    if (source[index] === '"') {
      stringEnd();
      return false;
    }
    if (source[index] === "{") return scanObject();
    if (source[index] === "[") {
      index += 1;
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return false;
      }
      while (index < source.length) {
        if (scanValue()) return true;
        whitespace();
        if (source[index] === "]") {
          index += 1;
          return false;
        }
        if (source[index] !== ",") return false;
        index += 1;
      }
      return false;
    }
    while (index < source.length && !/[\s,\]}]/.test(source[index] ?? ""))
      index += 1;
    return false;
  };
  const scanObject = (): boolean => {
    index += 1;
    const keys = new Set<string>();
    whitespace();
    if (source[index] === "}") {
      index += 1;
      return false;
    }
    while (index < source.length) {
      whitespace();
      if (source[index] !== '"') return false;
      const start = index;
      const end = stringEnd();
      let key: string;
      try {
        key = JSON.parse(source.slice(start, end)) as string;
      } catch {
        return false;
      }
      if (keys.has(key)) return true;
      keys.add(key);
      whitespace();
      if (source[index] !== ":") return false;
      index += 1;
      if (scanValue()) return true;
      whitespace();
      if (source[index] === "}") {
        index += 1;
        return false;
      }
      if (source[index] !== ",") return false;
      index += 1;
    }
    return false;
  };
  return scanValue();
}
export async function encodeCursor(
  kind: string,
  payload: unknown,
  version = 1,
): Promise<string> {
  const core = { kind, payload, version };
  const checksum = await sha256(canonicalJsonBytes(core));
  return base64Url(canonicalJsonBytes({ checksum, ...core }));
}

export async function decodeCursor(
  encoded: string,
  expectedKind: string,
  expectedVersion = 1,
): Promise<unknown> {
  try {
    if (
      encoded.length === 0 ||
      encoded.includes("=") ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)
    )
      fail();
    const raw = fromBase64Url(encoded);
    const envelope = parseStrictJsonObject(raw);
    if (
      new TextDecoder().decode(canonicalJsonBytes(envelope)) !==
      new TextDecoder().decode(raw)
    )
      fail();
    const keys = Object.keys(envelope).sort();
    if (keys.join(",") !== "checksum,kind,payload,version") fail();
    if (
      typeof envelope.checksum !== "string" ||
      !HASH_RE.test(envelope.checksum)
    )
      fail();
    if (envelope.kind !== expectedKind || envelope.version !== expectedVersion)
      fail();
    const core = {
      kind: envelope.kind,
      payload: envelope.payload,
      version: envelope.version,
    };
    if ((await sha256(canonicalJsonBytes(core))) !== envelope.checksum) fail();
    return envelope.payload;
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    fail();
  }
}
function base64Url(value: Uint8Array): string {
  let binary = "";
  value.forEach((item) => {
    binary += String.fromCharCode(item);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function fromBase64Url(value: string): Uint8Array {
  const binary = atob(
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(-value.length % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export interface MetadataSnapshot {
  readonly revision: number;
  readonly sha256: Sha256;
}

/** One read snapshot used to authorize a publication against current facts. */
export interface LiteratureCurrentFacts {
  readonly literature: Literature;
  readonly metadata_snapshot: MetadataSnapshot;
  readonly primary_asset: Asset | null;
}
export function parseLiteratureCurrentFacts(
  value: unknown,
): LiteratureCurrentFacts {
  const r = exact(
    value,
    ["literature", "metadata_snapshot", "primary_asset"],
    [],
  );
  const snapshot = exact(r.metadata_snapshot, ["revision", "sha256"], []);
  return Object.freeze({
    literature: parseLiterature(r.literature),
    metadata_snapshot: Object.freeze({
      revision: integer(snapshot.revision, [], 1, Number.MAX_SAFE_INTEGER),
      sha256: hash(snapshot.sha256, []),
    }),
    primary_asset:
      r.primary_asset === null ? null : parseAsset(r.primary_asset),
  });
}

export interface CandidatePublicationIntent {
  readonly metadata_snapshot: MetadataSnapshot;
  readonly receipt_id: string;
  readonly candidate: DurableCandidate;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly literature_asset_id: string;
  readonly target: string;
  readonly provenance: Provenance;
  readonly source_url: string | null;
  /** New downloads are unverified; accepted is retained for receipt replay only. */
  readonly identity: "unverified" | "accepted";
}

export interface CandidatePublicationReceipt {
  readonly receipt_id: string;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly sha256: Sha256;
  readonly reference: string;
  readonly created: boolean;
}

export function parseCandidatePublicationIntent(
  value: unknown,
): CandidatePublicationIntent {
  const r = exact(
    value,
    [
      "receipt_id",
      "metadata_snapshot",
      "candidate",
      "literature_id",
      "asset_id",
      "literature_asset_id",
      "target",
      "provenance",
      "source_url",
      "identity",
    ],
    [],
  );
  for (const key of [
    "receipt_id",
    "literature_id",
    "asset_id",
    "literature_asset_id",
  ] as const) {
    if (typeof r[key] !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(r[key]))
      fail([key]);
  }
  if (r.identity !== "accepted" && r.identity !== "unverified")
    fail(["identity"]);
  const snapshot = exact(
    r.metadata_snapshot,
    ["revision", "sha256"],
    ["metadata_snapshot"],
  );
  const metadataSnapshot = Object.freeze({
    revision: integer(
      snapshot.revision,
      ["metadata_snapshot", "revision"],
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    sha256: hash(snapshot.sha256, ["metadata_snapshot", "sha256"]),
  });
  const candidate = parseDurableCandidate(r.candidate);
  const asset = parseAsset({
    asset_id: r.asset_id,
    path: r.target,
    sha256: candidate.sha256,
    size_bytes: candidate.size_bytes,
    media_type: "application/pdf",
  });
  if (
    (!asset.path.startsWith("objects/") &&
      !asset.path.startsWith("originals/pdf/")) ||
    asset.path.length > 1024
  )
    fail(["target"]);
  let source: string | null = null;
  if (r.source_url !== null) {
    source = rawText(r.source_url, ["source_url"]);
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      fail(["source_url"]);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(["source_url"]);
  }
  return Object.freeze({
    metadata_snapshot: metadataSnapshot,
    receipt_id: r.receipt_id as string,
    candidate,
    literature_id: r.literature_id as string,
    asset_id: asset.asset_id,
    literature_asset_id: r.literature_asset_id as string,
    target: asset.path,
    provenance: parseProvenance(r.provenance),
    source_url: source,
    identity: r.identity,
  });
}

export function parseCandidatePublicationReceipt(
  value: unknown,
): CandidatePublicationReceipt {
  const r = exact(
    value,
    [
      "receipt_id",
      "literature_id",
      "asset_id",
      "sha256",
      "reference",
      "created",
    ],
    [],
  );
  if (typeof r.created !== "boolean") fail(["created"]);
  const asset = parseAsset({
    asset_id: r.asset_id,
    path: r.reference,
    sha256: r.sha256,
    size_bytes: 1,
    media_type: "application/pdf",
  });
  return Object.freeze({
    receipt_id: text(r.receipt_id, ["receipt_id"], true),
    literature_id: text(r.literature_id, ["literature_id"], true),
    asset_id: asset.asset_id,
    sha256: asset.sha256,
    reference: asset.path,
    created: r.created,
  });
}

export const BROWSER_AGENT_STOP_REASONS = [
  "access-unavailable",
  "no-viable-path",
] as const;
export type BrowserAgentStopReason =
  (typeof BROWSER_AGENT_STOP_REASONS)[number];

export type BrowserAction =
  | {
      readonly kind: "click-element";
      readonly element_id: string;
      readonly revision: number;
    }
  | {
      readonly kind: "click-point";
      readonly x: number;
      readonly y: number;
      readonly revision: number;
      readonly viewport_version: number;
    }
  | {
      readonly kind: "scroll-surface";
      readonly delta_x: number;
      readonly delta_y: number;
      readonly revision: number;
    }
  | { readonly kind: "go-back"; readonly revision: number }
  | {
      readonly kind: "wait-for-change";
      readonly revision: number;
      readonly timeout_ms: number;
    }
  // Existing operator/older caller commands remain readable. The Agent wire only
  // offers the two task outcomes below; runtime cancellation/budgets are not choices.
  | { readonly kind: "stop"; readonly reason: "user" | "budget" | "cancel" }
  | {
      readonly kind: "stop";
      readonly reason: BrowserAgentStopReason;
      readonly explanation: string;
    };

export type OperatorInput =
  | BrowserAction
  | {
      readonly kind: "type-text";
      readonly element_id: string;
      readonly text: string;
      readonly revision: number;
    }
  | {
      readonly kind: "press-key";
      readonly key:
        | "Enter"
        | "Tab"
        | "Escape"
        | "Backspace"
        | "ArrowUp"
        | "ArrowDown"
        | "ArrowLeft"
        | "ArrowRight";
      readonly revision: number;
    };

function actionNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    fail([name]);
  return value;
}
function actionRevision(value: unknown): number {
  return integer(value, ["revision"], 1, Number.MAX_SAFE_INTEGER);
}
function elementId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value))
    fail(["element_id"]);
  return value;
}

/** Agent boundary: exactly six actions; no text, key, selector, URL or script. */
export function parseBrowserAction(value: unknown): BrowserAction {
  const kind = object(value, []).kind;
  switch (kind) {
    case "click-element": {
      const r = exact(value, ["kind", "element_id", "revision"], []);
      return Object.freeze({
        kind,
        element_id: elementId(r.element_id),
        revision: actionRevision(r.revision),
      });
    }
    case "click-point": {
      const r = exact(
        value,
        ["kind", "x", "y", "revision", "viewport_version"],
        [],
      );
      return Object.freeze({
        kind,
        x: actionNumber(r.x, "x", 0, 16384),
        y: actionNumber(r.y, "y", 0, 16384),
        revision: actionRevision(r.revision),
        viewport_version: integer(
          r.viewport_version,
          ["viewport_version"],
          1,
          Number.MAX_SAFE_INTEGER,
        ),
      });
    }
    case "scroll-surface": {
      const r = exact(value, ["kind", "delta_x", "delta_y", "revision"], []);
      return Object.freeze({
        kind,
        delta_x: actionNumber(r.delta_x, "delta_x", -2000, 2000),
        delta_y: actionNumber(r.delta_y, "delta_y", -2000, 2000),
        revision: actionRevision(r.revision),
      });
    }
    case "go-back": {
      const r = exact(value, ["kind", "revision"], []);
      return Object.freeze({ kind, revision: actionRevision(r.revision) });
    }
    case "wait-for-change": {
      const r = exact(value, ["kind", "revision", "timeout_ms"], []);
      return Object.freeze({
        kind,
        revision: actionRevision(r.revision),
        timeout_ms: integer(r.timeout_ms, ["timeout_ms"], 1, 120000),
      });
    }
    case "stop": {
      const reason = object(value, []).reason;
      if (reason === "access-unavailable" || reason === "no-viable-path") {
        const stopped = exact(value, ["kind", "reason", "explanation"], []);
        // Validate as before, but retain the Agent's original formatting for supervision.
        text(
          typeof stopped.explanation === "string"
            ? stopped.explanation.replace(/\s+/gu, " ")
            : stopped.explanation,
          ["explanation"],
          true,
        );
        return Object.freeze({
          kind,
          reason: enumeration(stopped.reason, BROWSER_AGENT_STOP_REASONS, [
            "reason",
          ]),
          explanation: wireText(stopped.explanation, Number.MAX_SAFE_INTEGER),
        });
      }
      const r = exact(value, ["kind", "reason"], []);
      return Object.freeze({
        kind,
        reason: enumeration(r.reason, ["user", "budget", "cancel"], ["reason"]),
      });
    }
    default:
      fail(["kind"]);
  }
}

/** Only the authenticated, current human controller may submit this contract. */
export function parseOperatorInput(value: unknown): OperatorInput {
  const kind = object(value, []).kind;
  if (kind === "type-text") {
    const r = exact(value, ["kind", "element_id", "text", "revision"], []);
    if (
      typeof r.text !== "string" ||
      r.text.length > 4096 ||
      [...r.text].some((character) => {
        const code = character.charCodeAt(0);
        return (
          (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          code === 127
        );
      })
    )
      fail(["text"]);
    return Object.freeze({
      kind,
      element_id: elementId(r.element_id),
      text: r.text,
      revision: actionRevision(r.revision),
    });
  }
  if (kind === "press-key") {
    const r = exact(value, ["kind", "key", "revision"], []);
    return Object.freeze({
      kind,
      key: enumeration(
        r.key,
        [
          "Enter",
          "Tab",
          "Escape",
          "Backspace",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ],
        ["key"],
      ),
      revision: actionRevision(r.revision),
    });
  }
  return parseBrowserAction(value);
}

export function parseCandidateCapture(value: unknown): CandidateCapture {
  const r = exact(
    value,
    [
      "session_id",
      "article_id",
      "page_id",
      "document_generation",
      "source_url",
      "captured_at",
    ],
    [],
  );
  for (const key of ["session_id", "article_id", "page_id"])
    if (typeof r[key] !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(r[key]))
      fail([key]);
  const source = rawText(r.source_url, ["source_url"]);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    fail(["source_url"]);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail(["source_url"]);
  return Object.freeze({
    session_id: r.session_id as string,
    article_id: r.article_id as string,
    page_id: r.page_id as string,
    document_generation: integer(
      r.document_generation,
      ["document_generation"],
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    source_url: source,
    captured_at: parseUtcTimestamp(r.captured_at, ["captured_at"]),
  });
}

/** Wire aliases preserve the legacy action revision/viewport_version contract. */
export interface WorkbenchBinding {
  readonly session_id: string;
  readonly page_id: string;
  readonly document_generation: number;
  readonly observation_revision: number;
  readonly viewport_revision: number;
  readonly control_epoch: number;
}
export interface WorkbenchActionCommand extends WorkbenchBinding {
  readonly request_id: string;
  readonly input: OperatorInput;
}
export interface WorkbenchObservation extends WorkbenchBinding {
  readonly article_id: string;
  readonly frame_seq: number;
  readonly frame_available: boolean;
  readonly frame_dropped: boolean;
  readonly observed_at: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly loading: boolean;
  readonly partial: boolean;
  readonly page_state:
    | "NORMAL"
    | "CHALLENGE"
    | "LOGIN_REQUIRED"
    | "MFA_REQUIRED"
    | "NOT_ENTITLED"
    | "ACCESS_DENIED"
    | "NOT_FOUND"
    | "FAILED";
  readonly capture_state: "NONE" | "CANDIDATE" | "CAPTURED";
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly device_scale_factor: number;
  };
  readonly elements: readonly {
    readonly element_id: string;
    readonly role: string;
    readonly name: string;
    readonly editable: boolean;
  }[];
  readonly remaining: {
    readonly actions: number;
    readonly model_calls: number;
    readonly bytes: number;
    readonly deadline_ms: number;
  };
}
const bindingKeys = [
  "session_id",
  "page_id",
  "document_generation",
  "observation_revision",
  "viewport_revision",
  "control_epoch",
] as const;
function workbenchId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value))
    fail();
  return value;
}
function wireCount(value: unknown): number {
  return integer(value, [], 0, Number.MAX_SAFE_INTEGER);
}
function wireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function wireText(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    hasLoneSurrogate(value)
  )
    fail();
  return value;
}
function binding(r: Record<string, unknown>): WorkbenchBinding {
  return {
    session_id: workbenchId(r.session_id),
    page_id: workbenchId(r.page_id),
    document_generation: wireCount(r.document_generation),
    observation_revision: wireCount(r.observation_revision),
    viewport_revision: wireCount(r.viewport_revision),
    control_epoch: wireCount(r.control_epoch),
  };
}
export function parseWorkbenchActionCommand(
  value: unknown,
): WorkbenchActionCommand {
  const r = exact(value, [...bindingKeys, "request_id", "input"], []);
  const b = binding(r);
  const input = parseOperatorInput(r.input);
  if (input.kind !== "stop" && input.revision !== b.observation_revision)
    fail();
  if (
    input.kind === "click-point" &&
    input.viewport_version !== b.viewport_revision
  )
    fail();
  return Object.freeze({ ...b, request_id: workbenchId(r.request_id), input });
}
export function parseWorkbenchObservation(
  value: unknown,
): WorkbenchObservation {
  const r = exact(
    value,
    [
      ...bindingKeys,
      "article_id",
      "frame_seq",
      "frame_available",
      "frame_dropped",
      "observed_at",
      "url",
      "title",
      "text",
      "loading",
      "partial",
      "page_state",
      "capture_state",
      "viewport",
      "elements",
      "remaining",
    ],
    [],
  );
  const viewport = exact(
    r.viewport,
    ["width", "height", "device_scale_factor"],
    [],
  );
  if (
    typeof viewport.device_scale_factor !== "number" ||
    !Number.isFinite(viewport.device_scale_factor) ||
    viewport.device_scale_factor <= 0 ||
    viewport.device_scale_factor > 8
  )
    fail();
  const remaining = exact(
    r.remaining,
    ["actions", "model_calls", "bytes", "deadline_ms"],
    [],
  );
  if (!Array.isArray(r.elements) || r.elements.length > 100) fail();
  const elements = r.elements.map((value: unknown) => {
    const e = exact(value, ["element_id", "role", "name", "editable"], []);
    return Object.freeze({
      element_id: workbenchId(e.element_id),
      role: wireText(e.role, 128),
      name: wireText(e.name, 120),
      editable: wireBoolean(e.editable),
    });
  });
  const urlValue = wireText(r.url, 8192);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    fail();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail();
  const pageStates = [
    "NORMAL",
    "CHALLENGE",
    "LOGIN_REQUIRED",
    "MFA_REQUIRED",
    "NOT_ENTITLED",
    "ACCESS_DENIED",
    "NOT_FOUND",
    "FAILED",
  ];
  if (
    !pageStates.includes(r.page_state as string) ||
    !["NONE", "CANDIDATE", "CAPTURED"].includes(r.capture_state as string)
  )
    fail();
  return Object.freeze({
    ...binding(r),
    article_id: workbenchId(r.article_id),
    frame_seq: wireCount(r.frame_seq),
    frame_available: wireBoolean(r.frame_available),
    frame_dropped: wireBoolean(r.frame_dropped),
    observed_at: parseUtcTimestamp(r.observed_at, []),
    url: urlValue,
    title: wireText(r.title, 4096),
    text: wireText(r.text, 16000),
    loading: wireBoolean(r.loading),
    partial: wireBoolean(r.partial),
    page_state: r.page_state as WorkbenchObservation["page_state"],
    capture_state: r.capture_state as WorkbenchObservation["capture_state"],
    elements: Object.freeze(elements),
    viewport: Object.freeze({
      width: integer(viewport.width, [], 1, 16384),
      height: integer(viewport.height, [], 1, 16384),
      device_scale_factor: viewport.device_scale_factor,
    }),
    remaining: Object.freeze({
      actions: wireCount(remaining.actions),
      model_calls: wireCount(remaining.model_calls),
      bytes: wireCount(remaining.bytes),
      deadline_ms: wireCount(remaining.deadline_ms),
    }),
  });
}

export interface WorkbenchCandidate {
  readonly transfer_id: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly page_count: number;
  /** Candidate file admission; accepted does not verify article identity. */
  readonly disposition: "accepted" | "uncertain" | "rejected";
  readonly publication: CandidatePublicationReceipt | null;
}
export interface WorkbenchView {
  readonly problem?: SourceProblem;
  readonly mode?: "synthetic" | "production";
  readonly session_id: string;
  /** Null only for an idle workbench without a selected literature. */
  readonly article_id: string | null;
  readonly state:
    | "watching"
    | "agent-running"
    | "needs-assistance"
    | "paused"
    | "cancelled"
    | "finished"
    | "failed";
  readonly control: {
    readonly workspace_id: string;
    readonly viewers: number;
    readonly controller_id: string | null;
    readonly epoch: number;
  };
  readonly observation: WorkbenchObservation | null;
  readonly model_ready: boolean;
  readonly error:
    | "stale-command"
    | "session-busy"
    | "session-closed"
    | "model-unavailable"
    | "browser-failed"
    | "error"
    | null;
  readonly candidates: readonly WorkbenchCandidate[];
  /** Bounded, process-local guidance for the active article. Older v1 views omit it. */
  readonly guidance?: readonly WorkbenchGuidance[];
  /** Present only for an explicit production PDF operation. No durable run is created. */
  readonly operation_feedback?: WorkbenchOperationFeedback;
  /** Process-local article sessions; selecting a row grants no control authority. */
  readonly sessions?: readonly WorkbenchArticleSession[];
  readonly session_phase?: WorkbenchArticlePhase;
  readonly session_outcome?: WorkbenchArticleCloseOutcome | null;
  /** Process-local cleanup diagnosis; never replaces a published receipt or Library fact. */
  readonly session_cleanup_failure?: string;
  /** Recent completed inputs and lifecycle facts for the selected session; no input text. */
  readonly actions?: readonly WorkbenchActionRecord[];
}
export type WorkbenchArticlePhase =
  | "queued"
  | "ready"
  | "deciding"
  | "waiting"
  | "downloading"
  | "validating"
  | "candidate-ready"
  | "closing"
  | "closed";
export interface WorkbenchArticleSession {
  readonly session_id: string;
  readonly article_id: string;
  readonly generation: number;
  readonly phase: WorkbenchArticlePhase;
  readonly operation_id?: string;
  readonly title?: string;
  readonly queued_at?: string;
  readonly closed_at?: string;
  readonly outcome?: WorkbenchSessionOutcome;
  readonly stop?: WorkbenchSessionStop;
  readonly prior_attempts?: readonly AcquisitionAttempt[];
}
export interface WorkbenchSessionOutcome {
  readonly kind: "published" | "retained";
  /** Published uses "published"; retained preserves the platform outcome code. */
  readonly code: string;
  readonly problem?: SourceProblem;
}
export interface WorkbenchSessionStop {
  /** Original Agent stop reason, or an existing stable platform failure code. */
  readonly reason: string;
  readonly explanation?: string;
  readonly problem?: SourceProblem;
}
export const WORKBENCH_ACTION_KINDS = [
  "click-element",
  "click-point",
  "scroll-surface",
  "type-text",
  "press-key",
  "go-back",
  "wait-for-change",
  "tab-switch",
  "navigation",
  "navigation-failed",
  "download-started",
  "download-failed",
  "validation-passed",
  "validation-failed",
  "flow-stopped",
] as const;
export interface WorkbenchActionRecord {
  readonly technical_details?: SourceTechnicalDetails;
  readonly seq: number;
  readonly at: string;
  readonly actor: "agent" | "human" | "platform";
  readonly kind: (typeof WORKBENCH_ACTION_KINDS)[number];
  readonly label?: string;
  readonly url?: string;
  readonly point?: { readonly x: number; readonly y: number };
  /** Viewport at execution, not the selected view's possibly newer viewport. */
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly frame_seq?: number;
  readonly observation_revision?: number;
  readonly page_id?: string;
  readonly document_generation?: number;
}
export function parseWorkbenchActionRecord(
  value: unknown,
): WorkbenchActionRecord {
  const shape = object(value, []);
  const optional = [
    "technical_details",
    "label",
    "url",
    "point",
    "viewport",
    "frame_seq",
    "observation_revision",
    "page_id",
    "document_generation",
  ];
  const r = exact(
    value,
    ["seq", "at", "actor", "kind", ...optional.filter((key) => key in shape)],
    [],
  );
  const kind = enumeration(r.kind, WORKBENCH_ACTION_KINDS, ["kind"]);
  let viewport: WorkbenchActionRecord["viewport"];
  if (r.viewport !== undefined) {
    const v = exact(r.viewport, ["width", "height"], []);
    viewport = Object.freeze({
      width: integer(v.width, [], 1, 16384),
      height: integer(v.height, [], 1, 16384),
    });
  }
  let point: WorkbenchActionRecord["point"];
  if (r.point !== undefined) {
    if (
      !viewport ||
      !["click-point", "click-element"].includes(kind) ||
      r.frame_seq === undefined ||
      r.observation_revision === undefined ||
      r.page_id === undefined ||
      r.document_generation === undefined
    )
      fail(["point"]);
    const p = exact(r.point, ["x", "y"], []);
    if (
      typeof p.x !== "number" ||
      typeof p.y !== "number" ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      p.x < 0 ||
      p.y < 0 ||
      p.x >= viewport.width ||
      p.y >= viewport.height
    )
      fail(["point"]);
    point = Object.freeze({ x: p.x, y: p.y });
  }
  let url: string | undefined;
  if (r.url !== undefined) {
    url = wireText(r.url, 2048);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(["url"]);
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      fail(["url"]);
  }
  return Object.freeze({
    seq: integer(r.seq, ["seq"], 1, Number.MAX_SAFE_INTEGER),
    ...(r.technical_details === undefined
      ? {}
      : {
          technical_details: parseSourceTechnicalDetails(r.technical_details),
        }),
    at: parseUtcTimestamp(r.at, ["at"]),
    actor: enumeration(r.actor, ["agent", "human", "platform"], ["actor"]),
    kind,
    ...(r.label === undefined ? {} : { label: wireText(r.label, 512) }),
    ...(url === undefined ? {} : { url }),
    ...(viewport ? { viewport } : {}),
    ...(point ? { point } : {}),
    ...(r.frame_seq === undefined ? {} : { frame_seq: wireCount(r.frame_seq) }),
    ...(r.observation_revision === undefined
      ? {}
      : { observation_revision: wireCount(r.observation_revision) }),
    ...(r.page_id === undefined ? {} : { page_id: workbenchId(r.page_id) }),
    ...(r.document_generation === undefined
      ? {}
      : { document_generation: wireCount(r.document_generation) }),
  });
}
export function parseWorkbenchSessionStop(
  value: unknown,
): WorkbenchSessionStop {
  const shape = object(value, []);
  const r = exact(
    value,
    [
      "reason",
      ...("explanation" in shape ? ["explanation"] : []),
      ...("problem" in shape ? ["problem"] : []),
    ],
    [],
  );
  return Object.freeze({
    reason: workbenchId(r.reason),
    ...(r.problem === undefined
      ? {}
      : { problem: parseSourceProblem(r.problem) }),
    ...(r.explanation === undefined
      ? {}
      : { explanation: wireText(r.explanation, 2048) }),
  });
}

export type WorkbenchArticleCloseOutcome =
  | { readonly kind: "published"; readonly receipt_id: string }
  | {
      readonly kind: "retained";
      readonly code: string;
      readonly problem?: SourceProblem;
    }
  | { readonly kind: "cancelled" };
const WORKBENCH_ARTICLE_PHASES = [
  "queued",
  "ready",
  "deciding",
  "waiting",
  "downloading",
  "validating",
  "candidate-ready",
  "closing",
  "closed",
] as const;
export function parseWorkbenchArticleSession(
  value: unknown,
): WorkbenchArticleSession {
  const shape = object(value, []);
  const optional = [
    "operation_id",
    "title",
    "queued_at",
    "closed_at",
    "outcome",
    "stop",
    "prior_attempts",
  ];
  const row = exact(
    value,
    [
      "session_id",
      "article_id",
      "generation",
      "phase",
      ...optional.filter((key) => key in shape),
    ],
    [],
  );
  const queued =
    row.queued_at === undefined ? undefined : parseUtcTimestamp(row.queued_at);
  const closed =
    row.closed_at === undefined ? undefined : parseUtcTimestamp(row.closed_at);
  if (
    closed &&
    (row.phase !== "closed" ||
      (queued && Date.parse(closed) < Date.parse(queued)))
  )
    fail(["closed_at"]);
  let outcome: WorkbenchSessionOutcome | undefined;
  if (row.outcome !== undefined) {
    const shape = object(row.outcome, []);
    const o = exact(
      row.outcome,
      ["kind", "code", ...("problem" in shape ? ["problem"] : [])],
      [],
    );
    outcome = Object.freeze({
      kind: enumeration(o.kind, ["published", "retained"], ["kind"]),
      code: workbenchId(o.code),
      ...(o.problem === undefined
        ? {}
        : { problem: parseSourceProblem(o.problem) }),
    });
  }
  return Object.freeze({
    ...(row.prior_attempts === undefined
      ? {}
      : { prior_attempts: parseAcquisitionAttempts(row.prior_attempts, 16) }),
    ...(row.operation_id === undefined
      ? {}
      : { operation_id: workbenchId(row.operation_id) }),
    ...(row.title === undefined ? {} : { title: wireText(row.title, 512) }),
    ...(queued ? { queued_at: queued } : {}),
    ...(closed ? { closed_at: closed } : {}),
    ...(outcome ? { outcome } : {}),
    ...(row.stop === undefined
      ? {}
      : { stop: parseWorkbenchSessionStop(row.stop) }),
    session_id: workbenchId(row.session_id),
    article_id: workbenchId(row.article_id),
    generation: wireCount(row.generation),
    phase: enumeration(row.phase, WORKBENCH_ARTICLE_PHASES, ["phase"]),
  });
}
function parseWorkbenchArticleCloseOutcome(
  value: unknown,
): WorkbenchArticleCloseOutcome {
  const shape = object(value, []);
  if (shape.kind === "published") {
    const row = exact(value, ["kind", "receipt_id"], []);
    return Object.freeze({
      kind: "published",
      receipt_id: workbenchId(row.receipt_id),
    });
  }
  if (shape.kind === "retained") {
    const row = exact(
      value,
      ["kind", "code", ...("problem" in shape ? ["problem"] : [])],
      [],
    );
    return Object.freeze({
      kind: "retained",
      code: workbenchId(row.code),
      ...(row.problem === undefined
        ? {}
        : { problem: parseSourceProblem(row.problem) }),
    });
  }
  exact(value, ["kind"], []);
  if (shape.kind !== "cancelled") fail(["kind"]);
  return Object.freeze({ kind: "cancelled" });
}
export interface WorkbenchOperationFeedback {
  readonly phase: "idle" | "acquiring" | "browser" | "settling" | "ended";
  /** Null until the selector has been frozen by Entry. */
  readonly targets: {
    readonly total: number | null;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly interrupted: number;
    readonly not_started: number;
  };
  readonly current_target: LiteratureId | null;
  readonly report: DatabaseCompletionReport | null;
  readonly failure: StableFailure | null;
  readonly primary_pdf_status:
    | "unchecked"
    | "missing"
    | "verified"
    | "unreadable";
  /** Read back through Library after the operation; capture alone never sets this. */
  readonly primary_pdf: {
    readonly sha256: string;
    readonly size_bytes: number;
  } | null;
}
export interface WorkbenchGuidance {
  readonly guidance_id: string;
  readonly article_id: string;
  readonly text: string;
  readonly state:
    | "accepted"
    | "consumed"
    | "rejected"
    | "expired"
    | "cancelled";
}
export function parseWorkbenchView(value: unknown): WorkbenchView {
  const shape = object(value, []);
  const r = exact(
    value,
    [
      "session_id",
      "article_id",
      "state",
      "control",
      "observation",
      "model_ready",
      "error",
      "candidates",
      ...("guidance" in shape ? ["guidance"] : []),
      ...("mode" in shape ? ["mode"] : []),
      ...("operation_feedback" in shape ? ["operation_feedback"] : []),
      ...("sessions" in shape ? ["sessions"] : []),
      ...("actions" in shape ? ["actions"] : []),
      ...("session_phase" in shape ? ["session_phase"] : []),
      ...("session_outcome" in shape ? ["session_outcome"] : []),
      ...("problem" in shape ? ["problem"] : []),
      ...("session_cleanup_failure" in shape
        ? ["session_cleanup_failure"]
        : []),
    ],
    [],
  );
  const c = exact(
    r.control,
    ["workspace_id", "viewers", "controller_id", "epoch"],
    [],
  );
  if (
    ![
      "watching",
      "agent-running",
      "needs-assistance",
      "paused",
      "cancelled",
      "finished",
      "failed",
    ].includes(r.state as string)
  )
    fail();
  if (
    r.error !== null &&
    ![
      "stale-command",
      "session-busy",
      "session-closed",
      "model-unavailable",
      "browser-failed",
      "error",
    ].includes(r.error as string)
  )
    fail();
  if (!Array.isArray(r.candidates) || r.candidates.length > 100) fail();
  const candidates = r.candidates.map((value: unknown): WorkbenchCandidate => {
    const candidate = exact(
      value,
      [
        "transfer_id",
        "sha256",
        "size_bytes",
        "page_count",
        "disposition",
        "publication",
      ],
      [],
    );
    if (
      !["accepted", "uncertain", "rejected"].includes(
        candidate.disposition as string,
      )
    )
      fail();
    return Object.freeze({
      transfer_id: workbenchId(candidate.transfer_id),
      sha256: hash(candidate.sha256, []),
      size_bytes: wireCount(candidate.size_bytes),
      page_count: wireCount(candidate.page_count),
      disposition: candidate.disposition as WorkbenchCandidate["disposition"],
      publication:
        candidate.publication === null
          ? null
          : parseCandidatePublicationReceipt(candidate.publication),
    });
  });
  if (
    r.guidance !== undefined &&
    (!Array.isArray(r.guidance) || r.guidance.length > 64)
  )
    fail();
  const guidance = (r.guidance as readonly unknown[] | undefined)?.map(
    (value) => {
      const item = exact(
        value,
        ["guidance_id", "article_id", "text", "state"],
        [],
      );
      if (
        !["accepted", "consumed", "rejected", "expired", "cancelled"].includes(
          item.state as string,
        )
      )
        fail();
      return Object.freeze({
        guidance_id: workbenchId(item.guidance_id),
        article_id: workbenchId(item.article_id),
        text: wireText(item.text, 2048),
        state: item.state as WorkbenchGuidance["state"],
      });
    },
  );
  let actions: readonly WorkbenchActionRecord[] | undefined;
  if (r.actions !== undefined) {
    if (!Array.isArray(r.actions) || r.actions.length > 100) fail(["actions"]);
    actions = Object.freeze(r.actions.map(parseWorkbenchActionRecord));
    if (
      actions.some(
        (item, i) =>
          i > 0 &&
          (item.seq <= actions![i - 1]!.seq ||
            Date.parse(item.at) < Date.parse(actions![i - 1]!.at)),
      )
    )
      fail(["actions"]);
  }
  const view = {
    ...(actions ? { actions } : {}),
    ...(r.mode === undefined
      ? {}
      : { mode: enumeration(r.mode, ["synthetic", "production"], ["mode"]) }),
    session_id: workbenchId(r.session_id),
    article_id: r.article_id === null ? null : workbenchId(r.article_id),
    state: r.state as WorkbenchView["state"],
    control: Object.freeze({
      workspace_id: workbenchId(c.workspace_id),
      viewers: integer(c.viewers, [], 0, 16),
      controller_id:
        c.controller_id === null ? null : workbenchId(c.controller_id),
      epoch: wireCount(c.epoch),
    }),
    observation:
      r.observation === null ? null : parseWorkbenchObservation(r.observation),
    model_ready: wireBoolean(r.model_ready),
    error: r.error as WorkbenchView["error"],
    ...(r.sessions === undefined
      ? {}
      : {
          sessions: Object.freeze(
            list(r.sessions, ["sessions"], parseWorkbenchArticleSession),
          ),
        }),
    ...(r.session_phase === undefined
      ? {}
      : {
          session_phase: enumeration(
            r.session_phase,
            WORKBENCH_ARTICLE_PHASES,
            ["session_phase"],
          ),
        }),
    ...(r.session_outcome === undefined
      ? {}
      : {
          session_outcome:
            r.session_outcome === null
              ? null
              : parseWorkbenchArticleCloseOutcome(r.session_outcome),
        }),
    ...(r.problem === undefined
      ? {}
      : { problem: parseSourceProblem(r.problem) }),
    ...(r.session_cleanup_failure === undefined
      ? {}
      : { session_cleanup_failure: workbenchId(r.session_cleanup_failure) }),
    candidates: Object.freeze(candidates),
    ...(guidance ? { guidance: Object.freeze(guidance) } : {}),
    ...(r.operation_feedback === undefined
      ? {}
      : {
          operation_feedback: parseWorkbenchOperationFeedback(
            r.operation_feedback,
          ),
        }),
  };
  if (
    (view.article_id === null &&
      (view.mode !== "production" ||
        view.state !== "watching" ||
        view.observation !== null ||
        view.control.controller_id !== null ||
        view.candidates.length !== 0 ||
        (view.guidance?.length ?? 0) !== 0 ||
        view.session_phase !== undefined)) ||
    (view.sessions &&
      (view.sessions.length > 64 ||
        new Set(view.sessions.map((session) => session.session_id)).size !==
          view.sessions.length)) ||
    (view.session_phase !== undefined &&
      view.sessions &&
      !view.sessions.some(
        (session) =>
          session.session_id === view.session_id &&
          session.article_id === view.article_id &&
          session.phase === view.session_phase,
      )) ||
    (view.session_cleanup_failure !== undefined && !view.session_outcome) ||
    view.control.workspace_id !== view.session_id ||
    view.candidates.some(
      (candidate) =>
        candidate.publication &&
        (candidate.publication.literature_id !== view.article_id ||
          candidate.publication.sha256 !== candidate.sha256),
    ) ||
    (view.observation &&
      (view.observation.session_id !== view.session_id ||
        view.observation.article_id !== view.article_id ||
        view.observation.control_epoch !== view.control.epoch))
  )
    fail();
  return Object.freeze(view);
}

function parseWorkbenchOperationFeedback(
  value: unknown,
): WorkbenchOperationFeedback {
  const r = exact(
    value,
    [
      "phase",
      "targets",
      "current_target",
      "report",
      "failure",
      "primary_pdf_status",
      "primary_pdf",
    ],
    [],
  );
  const t = exact(
    r.targets,
    [
      "total",
      "running",
      "completed",
      "failed",
      "skipped",
      "interrupted",
      "not_started",
    ],
    [],
  );
  const targets = {
    total: t.total === null ? null : wireCount(t.total),
    running: wireCount(t.running),
    completed: wireCount(t.completed),
    failed: wireCount(t.failed),
    skipped: wireCount(t.skipped),
    interrupted: wireCount(t.interrupted),
    not_started: wireCount(t.not_started),
  };
  if (
    targets.total !== null &&
    targets.running +
      targets.completed +
      targets.failed +
      targets.skipped +
      targets.interrupted +
      targets.not_started !==
      targets.total
  )
    fail();
  const phase = enumeration(
    r.phase,
    ["idle", "acquiring", "browser", "settling", "ended"] as const,
    [],
  );
  const report =
    r.report === null ? null : parseDatabaseCompletionReport(r.report);
  const failure = r.failure === null ? null : parseStableFailure(r.failure);
  const primary =
    r.primary_pdf === null
      ? null
      : exact(r.primary_pdf, ["sha256", "size_bytes"], []);
  const primaryStatus = enumeration(
    r.primary_pdf_status,
    ["unchecked", "missing", "verified", "unreadable"] as const,
    [],
  );
  if ((primary === null) === (primaryStatus === "verified")) fail();
  return Object.freeze({
    phase,
    targets: Object.freeze(targets),
    current_target:
      r.current_target === null ? null : parseLiteratureId(r.current_target),
    report,
    failure,
    primary_pdf_status: primaryStatus,
    primary_pdf:
      primary === null
        ? null
        : Object.freeze({
            sha256: hash(primary.sha256, []),
            size_bytes: wireCount(primary.size_bytes),
          }),
  });
}

export interface ConfigurationReadinessItem {
  readonly owner:
    | "storage"
    | "parsing"
    | "tags"
    | "analyze"
    | "browser"
    | "model-provider"
    | "metadata"
    | "acquisition";
  readonly target: string;
  readonly state: "configured" | "ready" | "blocked" | "unavailable";
  readonly code: string;
  readonly next_action:
    | "none"
    | "configure"
    | "set-credential"
    | "select-model"
    | "install-runtime"
    | "select-profile"
    | "explicit-test";
}
export interface ConfigurationReadiness {
  readonly network?: NetworkReadiness;
  readonly diagnostics?: readonly {
    readonly code: "configuration-option-removed";
    readonly path: "proofread.max_calls_per_document";
    readonly message: string;
  }[];
  readonly acquisition_routes?: AcquisitionRouteState;
  readonly version: 1;
  readonly network_performed: false;
  readonly browser_launched: false;
  readonly items: readonly ConfigurationReadinessItem[];
  readonly credentials: {
    readonly sources: readonly {
      readonly target: string;
      readonly present: boolean;
    }[];
    readonly models: readonly {
      readonly target: string;
      readonly present: boolean;
    }[];
    readonly mineru: boolean;
  };
}
export function parseConfigurationReadiness(
  value: unknown,
): ConfigurationReadiness {
  const r = exact(
    value,
    [
      ...(value && typeof value === "object" && "network" in value
        ? ["network"]
        : []),
      "version",
      "network_performed",
      "browser_launched",
      "items",
      "credentials",
      ...(value && typeof value === "object" && "diagnostics" in value
        ? ["diagnostics"]
        : []),
      ...(value && typeof value === "object" && "acquisition_routes" in value
        ? ["acquisition_routes"]
        : []),
    ],
    [],
  );
  if (
    r.version !== 1 ||
    r.network_performed !== false ||
    r.browser_launched !== false ||
    !Array.isArray(r.items) ||
    r.items.length > 1000
  )
    fail();
  const items = r.items.map((value: unknown): ConfigurationReadinessItem => {
    const item = exact(
      value,
      ["owner", "target", "state", "code", "next_action"],
      [],
    );
    if (
      ![
        "storage",
        "parsing",
        "tags",
        "analyze",
        "browser",
        "model-provider",
        "metadata",
        "acquisition",
      ].includes(item.owner as string) ||
      !["configured", "ready", "blocked", "unavailable"].includes(
        item.state as string,
      ) ||
      ![
        "none",
        "configure",
        "set-credential",
        "select-model",
        "install-runtime",
        "select-profile",
        "explicit-test",
      ].includes(item.next_action as string)
    )
      fail();
    return Object.freeze({
      owner: item.owner as ConfigurationReadinessItem["owner"],
      target: workbenchId(item.target),
      state: item.state as ConfigurationReadinessItem["state"],
      code: workbenchId(item.code),
      next_action:
        item.next_action as ConfigurationReadinessItem["next_action"],
    });
  });
  const credentials = exact(r.credentials, ["models", "sources", "mineru"], []);
  if (!Array.isArray(credentials.sources) || credentials.sources.length > 1000)
    fail();
  const sources = credentials.sources.map((value: unknown) => {
    const item = exact(value, ["target", "present"], []);
    return Object.freeze({
      target: workbenchId(item.target),
      present: wireBoolean(item.present),
    });
  });
  if (!Array.isArray(credentials.models) || credentials.models.length > 1000)
    fail();
  const models = credentials.models.map((value: unknown) => {
    const item = exact(value, ["target", "present"], []);
    return Object.freeze({
      target: workbenchId(item.target),
      present: wireBoolean(item.present),
    });
  });
  if (
    new Set(sources.map((item) => item.target)).size !== sources.length ||
    new Set(models.map((item) => item.target)).size !== models.length ||
    new Set(items.map((item) => `${item.owner}:${item.target}`)).size !==
      items.length
  )
    fail();
  return Object.freeze({
    ...(r.diagnostics === undefined
      ? {}
      : {
          diagnostics: list<
            NonNullable<ConfigurationReadiness["diagnostics"]>[number]
          >(r.diagnostics, [], (v) => {
            const q = exact(v, ["code", "path", "message"], []);
            if (
              q.code !== "configuration-option-removed" ||
              q.path !== "proofread.max_calls_per_document" ||
              typeof q.message !== "string" ||
              q.message.length > 512
            )
              fail();
            return { code: q.code, path: q.path, message: q.message };
          }),
        }),
    ...(r.network === undefined
      ? {}
      : { network: parseNetworkReadiness(r.network) }),
    ...(r.acquisition_routes === undefined
      ? {}
      : {
          acquisition_routes: parseAcquisitionRouteState(r.acquisition_routes),
        }),
    version: 1,
    network_performed: false,
    browser_launched: false,
    items: Object.freeze(items),
    credentials: Object.freeze({
      sources: Object.freeze(sources),
      models: Object.freeze(models),
      mineru: wireBoolean(credentials.mineru),
    }),
  });
}
export * from "./content.js";
export * from "./document.js";
export * from "./document-read.js";
export * from "./retrieval-context.js";
export * from "./extraction.js";
export * from "./extraction-delivery.js";
export * from "./extraction-delivery-result.js";
export * from "./extraction-preparation.js";
export * from "./input-manifest.js";
export * from "./summary.js";
export * from "./knowledge-context.js";

export interface ProviderLiteratureKey {
  readonly record_id: string | null;
  readonly identifiers: readonly Identifier[];
}
export interface AssetHint {
  readonly url: string;
  readonly kind: "direct-file" | "landing-page";
  readonly media_type: string | null;
  readonly asset_role: AssetRole | null;
  readonly version_role: VersionRole | null;
  readonly access_status: string | null;
  readonly license: string | null;
}
export type AssetRole =
  | "primary-pdf"
  | "supplementary-pdf"
  | "xml"
  | "html"
  | "supplementary";
export interface MetadataObservation {
  readonly source_type: string | null;
  readonly source_type_mapping_version: string | null;
  readonly observation_id: string;
  readonly provenance: Provenance;
  readonly metadata: LiteratureMetadata;
  readonly version_role: VersionRole | null;
  readonly version_links: readonly ProviderLiteratureKey[];
  readonly declared_keywords: readonly string[];
  readonly reference_texts: readonly string[];
  readonly reference_count: number | null;
  readonly cited_by_count: number | null;
  readonly asset_hints: readonly AssetHint[];
}
export interface LiteratureAsset {
  readonly literature_asset_id: string;
  readonly literature_id: LiteratureId;
  readonly asset_id: AssetId;
  readonly role: AssetRole;
  readonly provenance: Provenance;
  readonly source_url: string | null;
}
export interface LiteratureAssetView {
  /** Advisory parse-stage evidence; never a download acceptance gate. */
  readonly article_identity_status: "unverified" | ArticleIdentityStatus | null;
  readonly article_identity_assessment?: ArticleIdentityAssessment;
  readonly asset: Asset;
  readonly literature_asset: LiteratureAsset;
}
export interface LiteratureDetail extends LiteratureSearchItem {
  readonly intake_batches: readonly {
    readonly batch_id: import("./intake.js").IntakeBatchId;
    readonly label: string;
  }[];
  readonly meta_literature: MetaLiterature;
  readonly metadata_observations: readonly MetadataObservation[];
  readonly primary_pdf: LiteratureAssetView | null;
  readonly additional_assets: readonly LiteratureAssetView[];
  readonly other_versions: readonly LiteratureSearchItem[];
  readonly reference_count: number;
  readonly cited_by_count: number;
}
const assetRoles: readonly AssetRole[] = [
  "primary-pdf",
  "supplementary-pdf",
  "xml",
  "html",
  "supplementary",
];
const versionRoles: readonly VersionRole[] = [
  "published",
  "accepted-manuscript",
  "preprint",
  "other",
];
function publicSourceUrl(value: unknown): string {
  const s = text(value, [], true);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return fail();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) =>
      /^(?:api[-_]?key|access[-_]?token|token|signature|sig|password|authorization|credential|cookie|x-amz-.+|x-goog-.+)$/iu.test(
        key,
      ),
    )
  )
    fail();
  return s;
}
function observationText(value: unknown): string {
  if (typeof value !== "string" || hasLoneSurrogate(value) || !value.trim())
    fail();
  return value.trim().normalize("NFC");
}
export function parseAssetHint(value: unknown): AssetHint {
  const h = exact(
    value,
    [
      "url",
      "kind",
      "media_type",
      "asset_role",
      "version_role",
      "access_status",
      "license",
    ],
    [],
  );
  return Object.freeze({
    url: publicSourceUrl(h.url),
    kind: enumeration<AssetHint["kind"]>(
      h.kind,
      ["direct-file", "landing-page"],
      [],
    ),
    media_type: nullableText(h.media_type, []),
    asset_role:
      h.asset_role === null ? null : enumeration(h.asset_role, assetRoles, []),
    version_role:
      h.version_role === null
        ? null
        : enumeration(h.version_role, versionRoles, []),
    access_status: nullableText(h.access_status, []),
    license: nullableText(h.license, []),
  });
}
export function parseMetadataObservation(value: unknown): MetadataObservation {
  const r = exact(
    value,
    [
      "observation_id",
      "source_type",
      "source_type_mapping_version",
      "provenance",
      "metadata",
      "version_role",
      "version_links",
      "declared_keywords",
      "reference_texts",
      "reference_count",
      "cited_by_count",
      "asset_hints",
    ],
    [],
  );
  const provenance = parseProvenance(r.provenance);
  if (provenance.source_kind === "metadata-provider") {
    if (
      provenance.source_record_id === null ||
      provenance.input_sha256 === null
    )
      fail();
  } else if (
    provenance.source_kind === "user" &&
    ["import", "web-capture"].includes(provenance.source_name)
  ) {
    if (
      provenance.source_record_id === null ||
      provenance.input_sha256 === null ||
      provenance.parameters_sha256 !== null
    )
      fail();
  } else if (
    provenance.source_kind !== "user" ||
    !["bibliographic-import", "manual-metadata"].includes(
      provenance.source_name,
    ) ||
    provenance.source_record_id !== null ||
    provenance.input_sha256 !== null ||
    provenance.parameters_sha256 !== null
  )
    fail();
  const version_links = Object.freeze(
    array(r.version_links, []).map((value) => {
      const link = exact(value, ["record_id", "identifiers"], []);
      const record_id = nullableText(link.record_id, []);
      const identifiers = Object.freeze(
        array(link.identifiers, []).map(parseIdentifier),
      );
      if (record_id === null && !identifiers.length) fail();
      return Object.freeze({ record_id, identifiers });
    }),
  );
  const asset_hints = Object.freeze(
    array(r.asset_hints, []).map(parseAssetHint),
  );
  return Object.freeze({
    observation_id: text(r.observation_id, [], true),
    source_type: nullableText(r.source_type, ["source_type"]),
    source_type_mapping_version: nullableText(r.source_type_mapping_version, [
      "source_type_mapping_version",
    ]),
    provenance,
    metadata: parseLiteratureMetadata(r.metadata),
    version_role:
      r.version_role === null
        ? null
        : enumeration(r.version_role, versionRoles, []),
    version_links,
    asset_hints,
    declared_keywords: Object.freeze(
      array(r.declared_keywords, []).map(observationText),
    ),
    reference_texts: Object.freeze(
      array(r.reference_texts, []).map(observationText),
    ),
    reference_count:
      r.reference_count === null
        ? null
        : integer(r.reference_count, [], 0, Number.MAX_SAFE_INTEGER),
    cited_by_count:
      r.cited_by_count === null
        ? null
        : integer(r.cited_by_count, [], 0, Number.MAX_SAFE_INTEGER),
  });
}
export function parseLiteratureAssetView(value: unknown): LiteratureAssetView {
  const raw = object(value, []);
  const r = exact(
    raw,
    [
      "asset",
      "literature_asset",
      ...(Object.hasOwn(raw, "article_identity_status")
        ? ["article_identity_status"]
        : []),
      ...(Object.hasOwn(raw, "article_identity_assessment")
        ? ["article_identity_assessment"]
        : []),
    ],
    [],
  );
  const asset = parseAsset(r.asset);
  const l = exact(
    r.literature_asset,
    [
      "literature_asset_id",
      "literature_id",
      "asset_id",
      "role",
      "provenance",
      "source_url",
    ],
    [],
  );
  if (l.asset_id !== asset.asset_id) fail();
  const literature_asset = Object.freeze({
    literature_asset_id: id(l.literature_asset_id, []),
    literature_id: id<"LiteratureId">(l.literature_id, []),
    asset_id: asset.asset_id,
    role: enumeration(l.role, assetRoles, []),
    provenance: parseProvenance(l.provenance),
    source_url: l.source_url === null ? null : publicSourceUrl(l.source_url),
  });
  const assessment =
    r.article_identity_assessment === undefined
      ? undefined
      : parseArticleIdentityAssessment(r.article_identity_assessment);
  if (
    assessment &&
    (asset.media_type !== "application/pdf" ||
      assessment.asset_id !== asset.asset_id ||
      assessment.asset_sha256 !== asset.sha256 ||
      assessment.literature_id !== literature_asset.literature_id)
  )
    fail();
  const article_identity_status =
    asset.media_type === "application/pdf"
      ? (assessment?.status ?? "unverified")
      : null;
  // Older snapshots omit the label. Neither missing data nor legacy receipt
  // acceptance constitutes a parse-stage verification.
  if (
    r.article_identity_status !== undefined &&
    r.article_identity_status !== article_identity_status
  )
    fail(["article_identity_status"]);
  return Object.freeze({
    asset,
    literature_asset,
    article_identity_status,
    ...(assessment ? { article_identity_assessment: assessment } : {}),
  });
}
export function parseLiteratureId(value: unknown): LiteratureId {
  return id<"LiteratureId">(value, []);
}
export function parseMetaLiteratureId(value: unknown): MetaLiteratureId {
  return id<"MetaLiteratureId">(value, []);
}
export function parseDiscoveryRunId(value: unknown): DiscoveryRunId {
  return id<"DiscoveryRunId">(value, []);
}
export async function parseLiteratureDetail(
  value: unknown,
): Promise<LiteratureDetail> {
  const r = exact(
    {
      long_document: null,
      intake_batches: [],
      tags: undefined,
      intake_at: null,
      last_opened_at: null,
      folder_ids: [],
      ...object(value, []),
    },
    [
      "intake_batches",
      "long_document",
      "tags",
      "intake_at",
      "last_opened_at",
      "folder_ids",
      "literature",
      "metadata_revision",
      "metadata_sha256",
      "missing_step",
      "needs_manual_pdf",
      "meta_literature",
      "metadata_observations",
      "primary_pdf",
      "additional_assets",
      "other_versions",
      "reference_count",
      "cited_by_count",
    ],
    [],
  );
  const item = parseLiteratureSearchItem({
    intake_at: r.intake_at,
    last_opened_at: r.last_opened_at,
    folder_ids: r.folder_ids,
    ...(r.tags === undefined ? {} : { tags: r.tags }),
    literature: r.literature,
    metadata_revision: r.metadata_revision,
    metadata_sha256: r.metadata_sha256,
    long_document: r.long_document,
    missing_step: r.missing_step,
    needs_manual_pdf: r.needs_manual_pdf,
  });
  return Object.freeze({
    ...item,
    intake_batches: list(r.intake_batches, ["intake_batches"], (v, p) => {
      const row = exact(v, ["batch_id", "label"], p);
      return Object.freeze({
        batch_id: id<"IntakeBatchId">(row.batch_id, p),
        label: text(row.label, p, true),
      });
    }),
    meta_literature: parseMetaLiterature(r.meta_literature),
    metadata_observations: Object.freeze(
      array(r.metadata_observations, []).map(parseMetadataObservation),
    ),
    primary_pdf:
      r.primary_pdf === null ? null : parseLiteratureAssetView(r.primary_pdf),
    additional_assets: Object.freeze(
      array(r.additional_assets, []).map(parseLiteratureAssetView),
    ),
    other_versions: Object.freeze(
      array(r.other_versions, []).map(parseLiteratureSearchItem),
    ),
    reference_count: integer(r.reference_count, [], 0, Number.MAX_SAFE_INTEGER),
    cited_by_count: integer(r.cited_by_count, [], 0, Number.MAX_SAFE_INTEGER),
  });
}

export * from "./processors.js";
export * from "./processor-transfer.js";
export * from "./raw-parsing.js";
export * from "./metadata-types.js";
export * from "./proofread.js";

export * from "./document-structure-v2.js";

export * from "./structure-annotation.js";

export * from "./metadata-fields.js";

export * from "./tags.js";

export * from "./processor-value-checks.js";
export * from "./processor-reading.js";

export * from "./library-counts.js";

export * from "./actor.js";

export * from "./folders.js";
export * from "./marks.js";

export * from "./agent-conversation.js";

export * from "./processor-outcomes.js";

export * from "./reading-status.js";

export * from "./archive-text.js";

export * from "./archive-publication.js";

export * from "./source-configuration.js";
export * from "./source-results.js";

export * from "./screencast.js";
export * from "./index-refresh.js";
export * from "./translation.js";

export * from "./document-layout.js";
export * from "./draft-document.js";
