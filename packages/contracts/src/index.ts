/** Provider-neutral, closed runtime contracts shared by the TypeScript apps. */

export const CONTRACTS_VERSION = "v1" as const;

/** Execution records have their own version; the v1 literature bytes stay frozen. */
export const EXECUTION_CONTRACT_VERSION = 1 as const;

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
    size_bytes: integer(r.size_bytes, ["size_bytes"], 1, 512 * 1024 * 1024),
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
export type LiteratureStatus = "UNREVIEWED" | "ASSET_READY" | "CONTENT_READY";

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
  readonly document_type: string | null;
  readonly language: string | null;
  readonly venue: string | null;
  readonly publisher: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
  readonly identifiers: readonly Identifier[];
  readonly keywords: readonly string[];
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
export type MissingStep =
  | "primary-pdf"
  | "parser-result"
  | "literature-content";
export interface LibraryQuery {
  readonly text: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly author_orcids: readonly string[];
  readonly identifiers: readonly Identifier[];
  readonly publication_year_from: number | null;
  readonly publication_year_to: number | null;
  readonly venue: string | null;
  readonly publisher: string | null;
  readonly document_types: readonly string[];
  readonly languages: readonly string[];
  readonly keywords: readonly string[];
  readonly version_roles: readonly VersionRole[];
  readonly statuses: readonly LiteratureStatus[];
  readonly missing_steps: readonly MissingStep[];
  readonly needs_manual_pdf: boolean | null;
  readonly discovery_run_ids: readonly DiscoveryRunId[];
}
export interface StableFailure {
  readonly code: string;
  readonly reason: string;
  readonly action: string;
  readonly retryable: boolean;
}

export type LibrarySort =
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
  readonly literature: Literature;
  readonly metadata_revision: number;
  readonly metadata_sha256: Sha256;
  readonly missing_step: MissingStep | null;
  readonly needs_manual_pdf: boolean;
}
export interface LibrarySearchPage {
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
export type ReferenceSupportSource =
  | { readonly kind: "provider_relation"; readonly observation_id: string }
  | {
      readonly kind: "metadata_reference_text";
      readonly metadata_observation_id: string;
      readonly reference_index: number;
    }
  | {
      readonly kind: "content_reference_text";
      readonly literature_content_sha256: Sha256;
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
    } else if (kind === "content_reference_text") {
      const p = exact(
        s.source,
        ["kind", "literature_content_sha256", "reference_index"],
        [],
      );
      locator = Object.freeze({
        kind,
        literature_content_sha256: hash(p.literature_content_sha256, []),
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
      sort: "publication-year-desc",
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
    document_types: [],
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
    r.sort,
    [
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
    value,
    [
      "literature",
      "metadata_revision",
      "metadata_sha256",
      "missing_step",
      "needs_manual_pdf",
    ],
    [],
  );
  return Object.freeze({
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
        : enumeration<MissingStep>(
            r.missing_step,
            ["primary-pdf", "parser-result", "literature-content"],
            [],
          ),
    needs_manual_pdf: wireBoolean(r.needs_manual_pdf),
  });
}
export type ReportEnd =
  | { readonly kind: "finished" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly failure: StableFailure };

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
function parseAffiliation(
  value: unknown,
  path: readonly string[],
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
function parseAuthor(value: unknown, path: readonly string[]): Author {
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
    value,
    [
      "title",
      "authors",
      "abstract",
      "publication_date",
      "publication_year",
      "document_type",
      "language",
      "venue",
      "publisher",
      "volume",
      "issue",
      "pages",
      "identifiers",
      "keywords",
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
    document_type: nullableText(record.document_type, ["document_type"]),
    language: nullableText(record.language, ["language"]),
    venue: nullableText(record.venue, ["venue"]),
    publisher: nullableText(record.publisher, ["publisher"]),
    volume: nullableText(record.volume, ["volume"]),
    issue: nullableText(record.issue, ["issue"]),
    pages: nullableText(record.pages, ["pages"]),
    identifiers: list(record.identifiers, ["identifiers"], parseIdentifier),
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
    status: enumeration(
      record.status,
      ["UNREVIEWED", "ASSET_READY", "CONTENT_READY"],
      ["status"],
    ),
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
    value,
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
      "document_types",
      "languages",
      "keywords",
      "version_roles",
      "statuses",
      "missing_steps",
      "needs_manual_pdf",
      "discovery_run_ids",
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
    document_types: list(
      record.document_types,
      ["document_types"],
      (item, path) => text(item, path, true),
    ),
    languages: list(record.languages, ["languages"], (item, path) =>
      text(item, path, true),
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
      (item, path) =>
        enumeration(item, ["UNREVIEWED", "ASSET_READY", "CONTENT_READY"], path),
    ),
    missing_steps: list<MissingStep>(
      record.missing_steps,
      ["missing_steps"],
      (item, path) =>
        enumeration(
          item,
          ["primary-pdf", "parser-result", "literature-content"],
          path,
        ),
    ),
    needs_manual_pdf:
      record.needs_manual_pdf === null
        ? null
        : typeof record.needs_manual_pdf === "boolean"
          ? record.needs_manual_pdf
          : fail(["needs_manual_pdf"]),
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
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    value as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest), (item) =>
    item.toString(16).padStart(2, "0"),
  ).join("") as Sha256;
}
export function parseStrictJsonObject(
  value: string | Uint8Array,
): Record<string, unknown> {
  let source: string;
  try {
    source =
      typeof value === "string"
        ? value
        : new TextDecoder("utf-8", { fatal: true }).decode(value);
    const parsed: unknown = JSON.parse(source);
    const result = object(parsed, []);
    if (hasDuplicateKeys(source)) fail();
    return result;
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    fail();
  }
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
  readonly identity: "accepted";
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
  if (r.identity !== "accepted") fail(["identity"]);
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
  if (!asset.path.startsWith("objects/") || asset.path.length > 1024)
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
    identity: "accepted",
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
  | { readonly kind: "stop"; readonly reason: "user" | "budget" | "cancel" };

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
  readonly disposition: "accepted" | "uncertain" | "rejected";
  readonly publication: CandidatePublicationReceipt | null;
}
export interface WorkbenchView {
  readonly session_id: string;
  readonly article_id: string;
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
    | null;
  readonly candidates: readonly WorkbenchCandidate[];
}
export function parseWorkbenchView(value: unknown): WorkbenchView {
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
  const view = {
    session_id: workbenchId(r.session_id),
    article_id: workbenchId(r.article_id),
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
    candidates: Object.freeze(candidates),
  };
  if (
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

export interface ConfigurationReadinessItem {
  readonly owner:
    | "storage"
    | "parsing"
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
      "version",
      "network_performed",
      "browser_launched",
      "items",
      "credentials",
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
import {
  parseParserResult,
  parseLiteratureContent,
  type ParserResult,
  type LiteratureContent,
} from "./content.js";

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
  readonly asset: Asset;
  readonly literature_asset: LiteratureAsset;
}
export interface LiteratureDetail extends LiteratureSearchItem {
  readonly meta_literature: MetaLiterature;
  readonly metadata_observations: readonly MetadataObservation[];
  readonly primary_pdf: LiteratureAssetView | null;
  readonly additional_assets: readonly LiteratureAssetView[];
  readonly parser_result: ParserResult | null;
  readonly content: LiteratureContent | null;
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
export function parseMetadataObservation(value: unknown): MetadataObservation {
  const r = exact(
    value,
    [
      "observation_id",
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
    provenance.source_kind !== "user" ||
    provenance.source_name !== "bibliographic-import" ||
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
    array(r.asset_hints, []).map((value) => {
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
          h.asset_role === null
            ? null
            : enumeration(h.asset_role, assetRoles, []),
        version_role:
          h.version_role === null
            ? null
            : enumeration(h.version_role, versionRoles, []),
        access_status: nullableText(h.access_status, []),
        license: nullableText(h.license, []),
      });
    }),
  );
  return Object.freeze({
    observation_id: text(r.observation_id, [], true),
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
  const r = exact(value, ["asset", "literature_asset"], []);
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
  return Object.freeze({ asset, literature_asset });
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
    value,
    [
      "literature",
      "metadata_revision",
      "metadata_sha256",
      "missing_step",
      "needs_manual_pdf",
      "meta_literature",
      "metadata_observations",
      "primary_pdf",
      "additional_assets",
      "parser_result",
      "content",
      "other_versions",
      "reference_count",
      "cited_by_count",
    ],
    [],
  );
  const item = parseLiteratureSearchItem({
    literature: r.literature,
    metadata_revision: r.metadata_revision,
    metadata_sha256: r.metadata_sha256,
    missing_step: r.missing_step,
    needs_manual_pdf: r.needs_manual_pdf,
  });
  return Object.freeze({
    ...item,
    meta_literature: parseMetaLiterature(r.meta_literature),
    metadata_observations: Object.freeze(
      array(r.metadata_observations, []).map(parseMetadataObservation),
    ),
    primary_pdf:
      r.primary_pdf === null ? null : parseLiteratureAssetView(r.primary_pdf),
    additional_assets: Object.freeze(
      array(r.additional_assets, []).map(parseLiteratureAssetView),
    ),
    parser_result:
      r.parser_result === null
        ? null
        : await parseParserResult(r.parser_result),
    content:
      r.content === null ? null : await parseLiteratureContent(r.content),
    other_versions: Object.freeze(
      array(r.other_versions, []).map(parseLiteratureSearchItem),
    ),
    reference_count: integer(r.reference_count, [], 0, Number.MAX_SAFE_INTEGER),
    cited_by_count: integer(r.cited_by_count, [], 0, Number.MAX_SAFE_INTEGER),
  });
}

export {
  parseLiteratureContentProposal,
  analysisInputSha256,
  type LiteratureContentProposal,
} from "./content.js";
