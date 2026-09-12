import { createHash } from "node:crypto";
import {
  parseLibrarySearchRequest,
  parseLiteratureDetail,
  parseLiteratureId,
  parseLiteratureContent,
  parseStrictJsonObject,
  parseArtifactRef,
  contentCanonicalJsonBytes,
  canonicalJsonBytes,
  sha256,
  type LiteratureDetail,
  parseLiteratureReferenceRequest,
  parseReferenceId,
  type ReferenceDetail,
  type LiteratureReferenceRequest,
  type LiteratureReferencePage,
  type LibraryQuery,
  type LibrarySearchPage,
  type LibrarySort,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import { normalizeQueryText, ftsIndexText } from "./unicode-casefold.js";

export interface SearchSnapshotRow {
  readonly item: LiteratureSearchItem;
  readonly relevance: number | null;
  readonly discovery_run_ids: readonly string[];
  readonly has_pdf_exhaustion: boolean;
}
export interface LibraryQueryRepository {
  literatureDetailSnapshot(literatureId: string): Promise<{
    readonly detail: unknown;
    readonly content: CurrentContentBinding | null;
  } | null>;
  librarySnapshot(
    ftsQuery: string | null,
    discoveryRunIds?: readonly string[],
  ): Promise<readonly SearchSnapshotRow[]>;
  referenceQuerySnapshot(
    selection:
      | {
          readonly literature_id: string;
          readonly direction: "references" | "cited-by";
        }
      | { readonly reference_id: string },
  ): Promise<readonly ReferenceDetail[] | null>;
}
export interface CurrentContentBinding {
  readonly literature_id: string;
  readonly literature_content_sha256: string;
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly primary_asset_id: string;
  readonly primary_asset_sha256: string;
  readonly parser_result_sha256: string;
  readonly structured_artifact_path: string;
  readonly structured_artifact_sha256: string;
  readonly structured_artifact_byte_size: number;
  readonly structured_artifact_media_type: string;
  readonly markdown_artifact_sha256: string;
  readonly markdown_artifact_byte_size: number;
  readonly markdown_artifact_media_type: string;
  readonly provenance: unknown;
  readonly reference_texts: readonly string[];
}
export interface LiteratureArtifactReader {
  read(reference: string, maxBytes: number): Promise<Uint8Array>;
}
export class LiteratureNotFoundError extends Error {
  readonly code = "literature-not-found";
  constructor() {
    super("requested literature or reference was not found");
  }
}
export class LiteratureQueryError extends Error {
  readonly code = "literature-query";
  constructor() {
    super("literature query failed");
  }
}
function fail(): never {
  throw new LiteratureQueryError();
}
function compareText(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return left.length - right.length;
}
const unique = (values: readonly string[]) =>
  [...new Set(values)].sort(compareText);
export function queryTerms(value: string): readonly string[] {
  return [...new Set(ftsIndexText(value).split(" ").filter(Boolean))];
}
function floatJson(value: number): string {
  if (!Number.isFinite(value)) fail();
  if (Object.is(value, -0)) return "-0.0";
  if (value !== 0 && (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e16))
    return value
      .toExponential()
      .replace(
        /e([+-])(\d+)$/u,
        (_all, sign: string, exponent: string) =>
          `e${sign}${exponent.padStart(2, "0")}`,
      );
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
/** Python query cursors have their own JSON contract, including finite bm25 float spelling. */
function canonical(value: unknown, key = ""): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return key === "bm25" ? floatJson(value) : JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null)
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item, name)}`)
      .join(",")}}`;
  return fail();
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function queryFingerprint(query: LibraryQuery): string {
  const contains = (value: string | null) =>
    value === null ? null : normalizeQueryText(value);
  const identifiers = [
    ...new Map(
      query.identifiers.map((item) => [
        `${item.namespace}\u0000${item.value}`,
        item,
      ]),
    ).values(),
  ].sort(
    (a, b) =>
      compareText(a.namespace, b.namespace) || compareText(a.value, b.value),
  );
  return digest({
    author: contains(query.author),
    author_orcids: unique(query.author_orcids),
    discovery_run_ids: unique(query.discovery_run_ids),
    document_types: unique(query.document_types),
    identifiers,
    keywords: unique(query.keywords),
    languages: unique(query.languages),
    missing_steps: unique(query.missing_steps),
    needs_manual_pdf: query.needs_manual_pdf,
    publication_year_from: query.publication_year_from,
    publication_year_to: query.publication_year_to,
    publisher: contains(query.publisher),
    schema: "sciretriever-library-query-v1",
    statuses: unique(query.statuses),
    text_terms: query.text === null ? null : unique(queryTerms(query.text)),
    title: contains(query.title),
    venue: contains(query.venue),
    version_roles: unique(query.version_roles),
  });
}
interface Position {
  readonly literature_id: string;
  readonly value: string | number | null;
}
function position(row: SearchSnapshotRow, sort: LibrarySort): Position {
  const l = row.item.literature;
  return {
    literature_id: l.literature_id,
    value: sort.startsWith("publication-year")
      ? l.metadata.publication_year
      : sort.startsWith("title")
        ? l.metadata.title === null
          ? null
          : normalizeQueryText(l.metadata.title)
        : row.relevance,
  };
}
function compare(a: Position, b: Position, sort: LibrarySort): number {
  if (a.value === null && b.value !== null) return 1;
  if (b.value === null && a.value !== null) return -1;
  let result = 0;
  if (a.value !== null && b.value !== null)
    result =
      typeof a.value === "string" && typeof b.value === "string"
        ? compareText(a.value, b.value)
        : a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0;
  if (sort.endsWith("desc")) result = -result;
  return result || compareText(a.literature_id, b.literature_id);
}
function positionPayload(p: Position, sort: LibrarySort): object {
  if (sort.startsWith("publication-year"))
    return {
      literature_id: p.literature_id,
      publication_year: p.value,
      year_is_null: p.value === null,
    };
  if (sort.startsWith("title"))
    return {
      literature_id: p.literature_id,
      normalized_title: p.value,
      title_is_null: p.value === null,
    };
  return { literature_id: p.literature_id, bm25: p.value };
}
function encodePosition(
  p: Position,
  query: LibraryQuery,
  sort: LibrarySort,
): string {
  const core = {
    kind: "library-search",
    payload: {
      position: positionPayload(p, sort),
      query_fingerprint: queryFingerprint(query),
      sort,
    },
    version: 1,
  };
  return Buffer.from(canonical({ checksum: digest(core), ...core })).toString(
    "base64url",
  );
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
function decodePosition(
  cursor: string,
  query: LibraryQuery,
  sort: LibrarySort,
): Position {
  try {
    if (cursor.length > 65536 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) fail();
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) fail();
    const e = object(JSON.parse(raw.toString("utf8")), [
      "checksum",
      "kind",
      "payload",
      "version",
    ]);
    if (
      canonical(e) !== raw.toString("utf8") ||
      e.version !== 1 ||
      e.kind !== "library-search" ||
      digest({ kind: e.kind, payload: e.payload, version: e.version }) !==
        e.checksum
    )
      fail();
    const payload = object(e.payload, [
      "position",
      "query_fingerprint",
      "sort",
    ]);
    if (
      payload.query_fingerprint !== queryFingerprint(query) ||
      payload.sort !== sort
    )
      fail();
    const field = sort.startsWith("publication-year")
      ? "publication_year"
      : sort.startsWith("title")
        ? "normalized_title"
        : "bm25";
    const flag =
      field === "publication_year" ? "year_is_null" : "title_is_null";
    const p = object(
      payload.position,
      field === "bm25"
        ? ["literature_id", field]
        : ["literature_id", field, flag],
    );
    if (
      typeof p.literature_id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(p.literature_id)
    )
      fail();
    const value = p[field];
    if (field !== "bm25" && p[flag] !== (value === null)) fail();
    if (
      field === "publication_year" &&
      value !== null &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 9999)
    )
      fail();
    if (
      field === "normalized_title" &&
      value !== null &&
      (typeof value !== "string" ||
        !value ||
        normalizeQueryText(value) !== value)
    )
      fail();
    if (
      field === "bm25" &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      fail();
    return {
      literature_id: p.literature_id,
      value: value as Position["value"],
    };
  } catch {
    return fail();
  }
}
function matches(row: SearchSnapshotRow, q: LibraryQuery): boolean {
  const l = row.item.literature,
    m = l.metadata;
  const contains = (actual: string | null, wanted: string | null) =>
    wanted === null ||
    (actual !== null &&
      normalizeQueryText(actual).includes(normalizeQueryText(wanted)));
  const any = (wanted: readonly unknown[], actual: readonly unknown[]) =>
    !wanted.length || wanted.some((value) => actual.includes(value));
  return (
    contains(m.title, q.title) &&
    contains(m.venue, q.venue) &&
    contains(m.publisher, q.publisher) &&
    (q.author === null ||
      m.authors.some((a) =>
        [a.display_name, a.given_name, a.family_name].some((name) =>
          contains(name, q.author),
        ),
      )) &&
    any(
      q.author_orcids,
      m.authors.map((a) => a.orcid),
    ) &&
    (!q.identifiers.length ||
      q.identifiers.some((wanted) =>
        m.identifiers.some(
          (actual) =>
            wanted.namespace === actual.namespace &&
            wanted.value === actual.value,
        ),
      )) &&
    (q.publication_year_from === null ||
      (m.publication_year !== null &&
        m.publication_year >= q.publication_year_from)) &&
    (q.publication_year_to === null ||
      (m.publication_year !== null &&
        m.publication_year <= q.publication_year_to)) &&
    any(q.document_types, [m.document_type]) &&
    any(q.languages, [m.language]) &&
    q.keywords.every((value) => m.keywords.includes(value)) &&
    any(q.version_roles, [l.version_role]) &&
    any(q.statuses, [l.status]) &&
    any(q.missing_steps, [row.item.missing_step]) &&
    (q.needs_manual_pdf === null ||
      (q.needs_manual_pdf
        ? row.item.needs_manual_pdf
        : !row.has_pdf_exhaustion)) &&
    any(q.discovery_run_ids, row.discovery_run_ids)
  );
}
export type LiteratureDetailSnapshot = {
  readonly detail: unknown;
  readonly content: CurrentContentBinding | null;
};
export async function verifyLiteratureDetailSnapshot(
  id: string,
  snapshot: LiteratureDetailSnapshot | null,
  artifacts?: LiteratureArtifactReader,
): Promise<LiteratureDetail> {
  if (snapshot === null) throw new LiteratureNotFoundError();
  const detail = await parseLiteratureDetail(snapshot.detail);
  if (
    detail.literature.literature_id !== id ||
    detail.meta_literature.meta_literature_id !==
      detail.literature.meta_literature_id ||
    (await sha256(canonicalJsonBytes(detail.literature.metadata))) !==
      detail.metadata_sha256
  )
    fail();
  if (
    detail.other_versions.some(
      (v) =>
        v.literature.literature_id === id ||
        v.literature.meta_literature_id !==
          detail.literature.meta_literature_id,
    )
  )
    fail();
  for (const asset of [
    ...detail.additional_assets,
    ...(detail.primary_pdf ? [detail.primary_pdf] : []),
  ])
    if (asset.literature_asset.literature_id !== id) fail();
  if (
    detail.primary_pdf &&
    (detail.primary_pdf.literature_asset.role !== "primary-pdf" ||
      detail.primary_pdf.asset.media_type !== "application/pdf")
  )
    fail();
  if (
    detail.additional_assets.some(
      (a) => a.literature_asset.role === "primary-pdf",
    )
  )
    fail();
  if (
    detail.parser_result &&
    (detail.parser_result.source_asset_id !==
      detail.primary_pdf?.asset.asset_id ||
      detail.parser_result.source_sha256 !== detail.primary_pdf.asset.sha256)
  )
    fail();
  let content = null;
  const binding = snapshot.content;
  if (binding) {
    const artifact = parseArtifactRef({
      sha256: binding.structured_artifact_sha256,
      byte_size: binding.structured_artifact_byte_size,
      media_type: binding.structured_artifact_media_type,
    });
    // Detail materializes structured text only; large PDF/Markdown bytes use independent reads.
    if (
      !artifacts ||
      artifact.media_type !== "application/json" ||
      artifact.byte_size > 16 * 1024 * 1024 ||
      artifact.byte_size === 0
    )
      fail();
    const bytes = await artifacts.read(
      binding.structured_artifact_path,
      artifact.byte_size,
    );
    if (
      bytes.byteLength !== artifact.byte_size ||
      (await sha256(bytes)) !== artifact.sha256
    )
      fail();
    content = await parseLiteratureContent(parseStrictJsonObject(bytes));
    const same = (a: unknown, b: unknown) =>
      Buffer.from(contentCanonicalJsonBytes(a)).equals(
        Buffer.from(contentCanonicalJsonBytes(b)),
      );
    const input = await sha256(
      contentCanonicalJsonBytes({
        schema: "sciretriever-literature-content-input-v1",
        metadata_sha256: detail.metadata_sha256,
        parser_result_sha256: binding.parser_result_sha256,
        primary_pdf_sha256: detail.primary_pdf?.asset.sha256,
      }),
    );
    if (
      !Buffer.from(contentCanonicalJsonBytes(content)).equals(
        Buffer.from(bytes),
      ) ||
      binding.literature_id !== id ||
      content.literature_content_sha256 !== binding.literature_content_sha256 ||
      content.metadata_revision !== detail.metadata_revision ||
      binding.metadata_revision !== detail.metadata_revision ||
      content.metadata_sha256 !== detail.metadata_sha256 ||
      binding.metadata_sha256 !== detail.metadata_sha256 ||
      binding.primary_asset_id !== detail.primary_pdf?.asset.asset_id ||
      binding.primary_asset_sha256 !== detail.primary_pdf.asset.sha256 ||
      content.provenance.input_sha256 !== input ||
      !same(content.provenance, binding.provenance) ||
      !same(content.references, binding.reference_texts) ||
      !same(content.markdown, {
        sha256: binding.markdown_artifact_sha256,
        byte_size: binding.markdown_artifact_byte_size,
        media_type: binding.markdown_artifact_media_type,
      }) ||
      detail.literature.status !== "CONTENT_READY"
    )
      fail();
  } else if (detail.literature.status === "CONTENT_READY") fail();
  const metadata_observations = [...detail.metadata_observations].sort(
    (a, b) =>
      Date.parse(b.provenance.observed_at) -
        Date.parse(a.provenance.observed_at) ||
      compareText(a.observation_id, b.observation_id),
  );
  return Object.freeze({
    ...detail,
    metadata_observations: Object.freeze(metadata_observations),
    content,
  });
}
export class LiteratureQueryService {
  constructor(
    private readonly repository: LibraryQueryRepository,
    private readonly artifacts?: LiteratureArtifactReader,
  ) {}
  async detail(value: unknown): Promise<LiteratureDetail> {
    const id = parseLiteratureId(value);
    const snapshot = await this.repository.literatureDetailSnapshot(id);
    return verifyLiteratureDetailSnapshot(id, snapshot, this.artifacts);
  }
  async referenceDetail(value: unknown): Promise<ReferenceDetail> {
    const reference_id = parseReferenceId(value);
    const rows = await this.repository.referenceQuerySnapshot({ reference_id });
    if (!rows?.length) throw new LiteratureNotFoundError();
    if (rows.length !== 1 || rows[0]!.reference.reference_id !== reference_id)
      fail();
    return rows[0]!;
  }
  async references(value: unknown): Promise<LiteratureReferencePage> {
    const request = parseLiteratureReferenceRequest(value);
    const after =
      request.cursor === null
        ? null
        : decodeReferencePosition(request.cursor, request);
    const snapshot = await this.repository.referenceQuerySnapshot({
      literature_id: request.literature_id,
      direction: request.direction,
    });
    if (snapshot === null) throw new LiteratureNotFoundError();
    const rows = snapshot.map((row) => {
      const endpoint =
        request.direction === "references" ? row.source : row.target;
      if (endpoint.literature.literature_id !== request.literature_id) fail();
      return Object.freeze({
        reference: row.reference,
        related_literature:
          request.direction === "references" ? row.target : row.source,
        support_count: row.supports.length,
      });
    });
    if (
      new Set(
        rows.map((row) => row.related_literature.literature.literature_id),
      ).size !== rows.length
    )
      fail();
    rows.sort((a, b) =>
      compareReferencePosition(
        referencePosition(a.related_literature),
        referencePosition(b.related_literature),
      ),
    );
    const remaining =
      after === null
        ? rows
        : rows.filter(
            (row) =>
              compareReferencePosition(
                referencePosition(row.related_literature),
                after,
              ) > 0,
          );
    const page = remaining.slice(0, request.limit);
    return Object.freeze({
      items: Object.freeze(page),
      total_count: rows.length,
      next_cursor:
        remaining.length > request.limit
          ? encodeReferencePosition(
              referencePosition(page.at(-1)!.related_literature),
              request,
            )
          : null,
    });
  }
  async search(value: unknown): Promise<LibrarySearchPage> {
    const request = parseLibrarySearchRequest(value);
    const after =
      request.cursor === null
        ? null
        : decodePosition(request.cursor, request.query, request.sort);
    const terms =
      request.query.text === null ? null : queryTerms(request.query.text);
    if (terms?.length === 0)
      return Object.freeze({ items: [], total_count: 0, next_cursor: null });
    const rows = (
      await this.repository.librarySnapshot(
        terms === null ? null : terms.map((term) => `"${term}"`).join(" AND "),
        request.query.discovery_run_ids,
      )
    ).filter((row) => matches(row, request.query));
    rows.sort((a, b) =>
      compare(
        position(a, request.sort),
        position(b, request.sort),
        request.sort,
      ),
    );
    const remaining =
      after === null
        ? rows
        : rows.filter(
            (row) =>
              compare(position(row, request.sort), after, request.sort) > 0,
          );
    const page = remaining.slice(0, request.limit);
    return Object.freeze({
      items: Object.freeze(page.map((row) => row.item)),
      total_count: rows.length,
      next_cursor:
        remaining.length > request.limit && page.length
          ? encodePosition(
              position(page.at(-1)!, request.sort),
              request.query,
              request.sort,
            )
          : null,
    });
  }
}

interface ReferencePosition {
  readonly related_literature_id: string;
  readonly publication_year: number | null;
  readonly normalized_title: string | null;
}
function referencePosition(item: LiteratureSearchItem): ReferencePosition {
  return {
    related_literature_id: item.literature.literature_id,
    publication_year: item.literature.metadata.publication_year,
    normalized_title:
      item.literature.metadata.title === null
        ? null
        : normalizeQueryText(item.literature.metadata.title),
  };
}
function compareReferencePosition(
  a: ReferencePosition,
  b: ReferencePosition,
): number {
  const nullable = <T>(
    x: T | null,
    y: T | null,
    comparator: (x: T, y: T) => number,
  ) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : comparator(x, y));
  return (
    nullable(a.publication_year, b.publication_year, (x, y) => y - x) ||
    nullable(a.normalized_title, b.normalized_title, compareText) ||
    compareText(a.related_literature_id, b.related_literature_id)
  );
}
function encodeReferencePosition(
  position: ReferencePosition,
  request: LiteratureReferenceRequest,
): string {
  const core = {
    kind: "literature-references",
    version: 1,
    payload: {
      literature_id: request.literature_id,
      direction: request.direction,
      position: {
        ...position,
        year_is_null: position.publication_year === null,
        title_is_null: position.normalized_title === null,
      },
    },
  };
  return Buffer.from(canonical({ checksum: digest(core), ...core })).toString(
    "base64url",
  );
}
function decodeReferencePosition(
  cursor: string,
  request: LiteratureReferenceRequest,
): ReferencePosition {
  try {
    if (cursor.length > 65536 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) fail();
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) fail();
    const e = object(JSON.parse(raw.toString("utf8")), [
      "checksum",
      "kind",
      "payload",
      "version",
    ]);
    if (
      canonical(e) !== raw.toString("utf8") ||
      e.version !== 1 ||
      e.kind !== "literature-references" ||
      digest({ kind: e.kind, payload: e.payload, version: e.version }) !==
        e.checksum
    )
      fail();
    const payload = object(e.payload, [
      "literature_id",
      "direction",
      "position",
    ]);
    if (
      payload.literature_id !== request.literature_id ||
      payload.direction !== request.direction
    )
      fail();
    const p = object(payload.position, [
      "related_literature_id",
      "publication_year",
      "normalized_title",
      "year_is_null",
      "title_is_null",
    ]);
    if (
      typeof p.related_literature_id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
        p.related_literature_id,
      ) ||
      p.year_is_null !== (p.publication_year === null) ||
      p.title_is_null !== (p.normalized_title === null)
    )
      fail();
    if (
      p.publication_year !== null &&
      (typeof p.publication_year !== "number" ||
        !Number.isSafeInteger(p.publication_year) ||
        p.publication_year < 1 ||
        p.publication_year > 9999)
    )
      fail();
    if (
      p.normalized_title !== null &&
      (typeof p.normalized_title !== "string" ||
        !p.normalized_title ||
        normalizeQueryText(p.normalized_title) !== p.normalized_title)
    )
      fail();
    return {
      related_literature_id: p.related_literature_id,
      publication_year: p.publication_year as number | null,
      normalized_title: p.normalized_title as string | null,
    };
  } catch {
    return fail();
  }
}
