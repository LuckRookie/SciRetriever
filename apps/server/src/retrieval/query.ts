import { segmentPageRegion } from "../document/location.js";
import { createHash } from "node:crypto";
import {
  parseMaterialContextBundle,
  parseMaterialContextRequest,
  RELEVANCE_RESULT_LIMIT,
  type DocumentRef,
  type EvidenceRef,
  type MaterialContextBundle,
  type MaterialContextItem,
  type MaterialContextRequest,
  type Sha256,
} from "@sciretriever/contracts";
import {
  DocumentReadError,
  type DocumentReadService,
  type VerifiedDocumentStructure,
} from "../document/read.js";
import type { LiteratureQueryService } from "../literature/query.js";
import { queryTerms } from "../literature/query.js";
import { type RetrievalHit } from "./storage.js";
import { RetrievalStorageError, RETRIEVAL_SCORE_RULE } from "./model.js";
import { RetrievalStorageClient } from "../storage/sqlite/retrieval-client.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const MAX_EVIDENCE = 32;

type Position = Pick<
  RetrievalHit,
  "score" | "kind" | "literature_id" | "unit_ordinal"
> & {
  readonly document_version_id: string;
};
function position(hit: RetrievalHit): Position {
  return {
    score: hit.score,
    kind: hit.kind,
    literature_id: hit.literature_id,
    document_version_id: hit.document_version_id ?? "",
    unit_ordinal: hit.unit_ordinal,
  };
}
function fingerprint(request: MaterialContextRequest): string {
  return digest(
    JSON.stringify({
      query: request.query,
      scope: request.scope,
      kinds: request.kinds,
      versions: request.versions,
      budget: request.budget,
    }),
  );
}
function encodeCursor(
  request: MaterialContextRequest,
  generation: string,
  revision: number,
  after: Position,
  state: string,
): string {
  const payload = JSON.stringify({
    version: 3,
    score_rule: RETRIEVAL_SCORE_RULE,
    fingerprint: fingerprint(request),
    generation,
    revision,
    state,
    after,
  });
  return Buffer.from(
    JSON.stringify({ payload, checksum: digest(payload) }),
  ).toString("base64url");
}
function decodeCursor(
  request: MaterialContextRequest,
  value: string,
  generation: string,
  revision: number,
  state: string,
): Position {
  try {
    const envelope = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { payload: string; checksum: string };
    if (digest(envelope.payload) !== envelope.checksum) throw new Error();
    const parsed = JSON.parse(envelope.payload) as {
      version: number;
      score_rule: string;
      fingerprint: string;
      generation: string;
      revision: number;
      state: string;
      after: Position;
    };
    if (
      Object.keys(envelope).sort().join() !== "checksum,payload" ||
      typeof envelope.payload !== "string" ||
      typeof envelope.checksum !== "string" ||
      Object.keys(parsed).sort().join() !==
        "after,fingerprint,generation,revision,score_rule,state,version" ||
      parsed.version !== 3 ||
      parsed.score_rule !== RETRIEVAL_SCORE_RULE ||
      parsed.fingerprint !== fingerprint(request) ||
      parsed.generation !== generation ||
      parsed.revision !== revision ||
      parsed.state !== state ||
      !parsed.after ||
      Object.keys(parsed.after).sort().join() !==
        "document_version_id,kind,literature_id,score,unit_ordinal" ||
      !Number.isSafeInteger(parsed.after.score) ||
      parsed.after.score > 0 ||
      (parsed.after.kind !== "metadata" && parsed.after.kind !== "document") ||
      typeof parsed.after.literature_id !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
        parsed.after.literature_id,
      ) ||
      typeof parsed.after.document_version_id !== "string" ||
      (parsed.after.kind === "metadata"
        ? parsed.after.document_version_id !== ""
        : !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
            parsed.after.document_version_id,
          )) ||
      !Number.isSafeInteger(parsed.after.unit_ordinal) ||
      parsed.after.unit_ordinal < 0
    )
      throw new Error();
    return parsed.after;
  } catch {
    throw new MaterialContextError("context-cursor-invalid");
  }
}
function withBytes(bundle: MaterialContextBundle): MaterialContextBundle {
  let result = { ...bundle, usage: { ...bundle.usage, bytes: 0 } };
  for (let i = 0; i < 10; i++) {
    const bytes = encoder.encode(JSON.stringify(result)).length;
    if (bytes === result.usage.bytes) return result;
    result = { ...result, usage: { ...result.usage, bytes } };
  }
  throw new MaterialContextError("context-budget-invalid");
}
export class MaterialContextError extends Error {
  constructor(
    readonly code:
      | "context-cursor-invalid"
      | "context-budget-invalid"
      | "context-tokenizer-unsupported"
      | "context-source-integrity"
      | "context-cancelled",
  ) {
    super(code);
  }
}
export interface MaterialCandidateSession {
  readonly generation_id: string;
  readonly source_revision: number;
  readonly hits: readonly RetrievalHit[];
  readonly candidate_limit: boolean;
  readonly relevance_limited: boolean;
  readonly coverage_gaps: MaterialContextBundle["gaps"];
  expand(hit: RetrievalHit): Promise<{
    item: MaterialContextItem | null;
    gaps: MaterialContextBundle["gaps"];
  }>;
  assertCurrent(): Promise<void>;
}
export interface MaterialIndexSnapshot {
  readonly state_token: string | null;
  readonly coverage:
    | "complete"
    | "index-unavailable"
    | "index-corrupt"
    | "index-stale";
}
interface MaterialSearchWindow {
  key: string;
  result?: Awaited<ReturnType<RetrievalStorageClient["search"]>>;
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MaterialContextError("context-cancelled");
}
function documentEvidence(
  version: DocumentRef,
  structure: VerifiedDocumentStructure,
  bytes: Uint8Array,
  hit: RetrievalHit,
): readonly EvidenceRef[] | null {
  const start = hit.unit_start_utf8!;
  const end = hit.unit_end_utf8!;
  const included = structure.segments.filter(
    (segment) => segment.start_utf8 >= start && segment.end_utf8 <= end,
  );
  const heading =
    hit.section_id === null
      ? null
      : structure.segments.find(
          (segment) =>
            segment.kind === "heading" && segment.section_id === hit.section_id,
        );
  const segments =
    heading &&
    !included.some((segment) => segment.segment_id === heading.segment_id)
      ? [heading, ...included]
      : included;
  if (!included.length || segments.length > MAX_EVIDENCE) return null;
  return segments.map((segment) => ({
    schema_version: 1,
    target_kind: "document",
    locator_scheme: "utf8-segment-v1",
    document_version_id: version.document_version_id,
    representation_sha256: version.representation_sha256,
    locator: { kind: "segment", segment_id: segment.segment_id },
    ...(segmentPageRegion(segment)
      ? { page_region: segmentPageRegion(segment)! }
      : {}),
    content_sha256: digest(
      bytes.subarray(segment.start_utf8, segment.end_utf8),
    ) as Sha256,
  }));
}

export class MaterialContextService {
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly storage: RetrievalStorageClient | null,
    private readonly documents: DocumentReadService | null,
    private readonly literature: LiteratureQueryService,
  ) {}
  close(): Promise<void> {
    this.stopped = true;
    return (this.closing ??= Promise.allSettled([...this.active]).then(() => {
      this.storage?.close();
    }));
  }
  search(value: unknown, signal?: AbortSignal): Promise<MaterialContextBundle> {
    return this.startSearch(value, signal);
  }
  /** Reuse rankings while assembling one mixed-context response. */
  searchSession() {
    const window: MaterialSearchWindow = { key: "" };
    return (value: unknown, signal?: AbortSignal) =>
      this.startSearch(value, signal, window);
  }
  private startSearch(
    value: unknown,
    signal?: AbortSignal,
    window?: MaterialSearchWindow,
  ): Promise<MaterialContextBundle> {
    const request = parseMaterialContextRequest(value);
    if (request.budget.token_limit !== null)
      throw new MaterialContextError("context-tokenizer-unsupported");
    if (this.stopped) throw new MaterialContextError("context-cancelled");
    const pending = this.execute(request, signal, window);
    this.active.add(pending);
    return pending.finally(() => this.active.delete(pending));
  }
  /** Scalar state also pins mixed-context result pages after source paging ends. */
  indexSnapshot(): Promise<MaterialIndexSnapshot> {
    if (this.stopped) throw new MaterialContextError("context-cancelled");
    const pending = (async (): Promise<MaterialIndexSnapshot> => {
      if (!this.storage)
        return { state_token: null, coverage: "index-unavailable" };
      try {
        const state = await this.storage.state();
        return {
          state_token: state.state_token,
          coverage: !state.generation
            ? "index-unavailable"
            : state.source_revision !== state.generation.source_revision
              ? "index-stale"
              : "complete",
        };
      } catch (error) {
        if (
          error instanceof RetrievalStorageError &&
          error.code === "index-corrupt"
        )
          return { state_token: null, coverage: "index-corrupt" };
        throw error;
      }
    })();
    this.active.add(pending);
    return pending.finally(() => this.active.delete(pending));
  }
  /** A fixed candidate page with one document cache and one request-level verification budget. */
  async withCandidates<T>(
    value: unknown,
    expected: {
      readonly generation_id: string;
      readonly source_revision: number;
      readonly state_token?: string;
    },
    consume: (session: MaterialCandidateSession) => Promise<T>,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
    window?: MaterialSearchWindow,
  ): Promise<T> {
    const request = parseMaterialContextRequest(value);
    if (this.stopped) throw new MaterialContextError("context-cancelled");
    if (
      request.continuation !== null ||
      request.budget.token_limit !== null ||
      !this.storage
    )
      throw new MaterialContextError("context-cursor-invalid");
    const pending = (async () => {
      check(signal);
      const initial = await this.storage!.state();
      const generation = initial.generation;
      if (
        !generation ||
        generation.generation_id !== expected.generation_id ||
        generation.source_revision !== expected.source_revision ||
        (expected.state_token !== undefined &&
          initial.state_token !== expected.state_token)
      )
        throw new MaterialContextError("context-cursor-invalid");
      const scope =
        request.scope.kind === "library" ? [] : request.scope.literature_ids;
      let coverage: MaterialContextBundle["gaps"];
      try {
        coverage = await this.storage!.documentCoverage(
          scope,
          request.versions.kind === "default"
            ? null
            : request.versions.documents,
          request.kinds.includes("document"),
        );
      } catch (error) {
        if (
          !(error instanceof RetrievalStorageError) ||
          error.code !== "index-stale"
        )
          throw error;
        if (initial.source_revision === generation.source_revision)
          throw new MaterialContextError("context-source-integrity");
        coverage = [{ code: "index-stale", literature_id: null }];
      }
      const terms = queryTerms(request.query);
      const versions =
        request.versions.kind === "default"
          ? null
          : request.versions.documents.map((d) => d.document_version_id);
      const rank = () =>
        this.storage!.search(
          terms.map((term) => `"${term}"`).join(" AND "),
          terms,
          generation.generation_id,
          scope,
          request.kinds,
          versions,
          4097,
          null,
        );
      const load = async () => {
        if (!window) return rank();
        const key = JSON.stringify([
          initial.state_token,
          initial.source_revision,
          scope,
          request.kinds,
          versions,
          terms,
        ]);
        if (window.key !== key || !window.result) {
          window.result = await rank();
          window.key = key;
        }
        return window.result;
      };
      const found = terms.length
        ? await load()
        : {
            hits: [] as readonly RetrievalHit[],
            candidateLimit: false,
            relevanceLimited: false,
          };
      const documents = new Map<
        string,
        {
          version: DocumentRef;
          markdown: Uint8Array;
          structure: VerifiedDocumentStructure;
        }
      >();
      let localVerifiedBytes = 0;
      const reserve = (bytes: number) => {
        if (
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          localVerifiedBytes + bytes > 64 * 1024 * 1024
        )
          throw new MaterialContextError("context-budget-invalid");
        reserveVerifiedBytes?.(bytes);
        localVerifiedBytes += bytes;
      };
      const assertCurrent = async () => {
        check(signal);
        const latest = await this.storage!.state();
        const current = latest.generation;
        if (
          !current ||
          current.generation_id !== generation.generation_id ||
          current.source_revision !== generation.source_revision ||
          latest.state_token !== initial.state_token
        )
          throw new MaterialContextError("context-cursor-invalid");
      };
      const expandVerified = async (hit: RetrievalHit) => {
        check(signal);
        if (hit.kind === "document") {
          const id = hit.document_version_id;
          if (!id || !this.documents)
            throw new MaterialContextError("context-source-integrity");
          let source = documents.get(id);
          if (!source) {
            source = await this.documents.withVerifiedTextVersion(
              id,
              async (version, markdown, structure) => ({
                version,
                markdown,
                structure,
              }),
              signal,
              (bytes) => {
                try {
                  reserve(bytes);
                } catch (error) {
                  throw new DocumentReadError("document-budget", {
                    cause: error,
                  });
                }
              },
            );
            documents.set(id, source);
          }
          const { version, markdown, structure } = source;
          if (
            version.representation_sha256 !== hit.representation_sha256 ||
            version.source_material_ref.literature_id !== hit.literature_id ||
            version.source_material_ref.asset_id !== hit.source_asset_id ||
            version.source_material_ref.asset_sha256 !==
              hit.source_asset_sha256 ||
            hit.unit_start_utf8 === null ||
            hit.unit_end_utf8 === null ||
            hit.unit_sha256 === null ||
            hit.unit_end_utf8 > markdown.length
          )
            throw new MaterialContextError("context-source-integrity");
          const bytes = markdown.subarray(
            hit.unit_start_utf8,
            hit.unit_end_utf8,
          );
          if (digest(bytes) !== hit.unit_sha256)
            throw new MaterialContextError("context-source-integrity");
          const evidence = documentEvidence(version, structure, markdown, hit);
          const titles = new Map(
            structure.sections.map((section) => [
              section.section_id,
              section.title,
            ]),
          );
          const item: MaterialContextItem = {
            kind: "source-text",
            text_level: version.schema_version === 3 ? "draft" : "proofread",
            literature_id: hit.literature_id,
            meta_literature_id: hit.meta_literature_id,
            reference: {
              kind: "document",
              literature_id: hit.literature_id,
              document_version_id: id,
              representation_sha256: version.representation_sha256,
              asset_id: version.source_material_ref.asset_id,
              asset_sha256: version.source_material_ref.asset_sha256,
              start_utf8: hit.unit_start_utf8,
              end_utf8: hit.unit_end_utf8,
            },
            section_title:
              hit.section_id === null
                ? null
                : (titles.get(hit.section_id) ?? null),
            text: evidence ? decoder.decode(bytes) : "",
            evidence: evidence ?? [],
            rank: 0,
            score: hit.score,
            gap: evidence ? null : "evidence-limit",
          };
          return {
            item,
            gaps: evidence
              ? []
              : [
                  {
                    code: "evidence-limit" as const,
                    literature_id: hit.literature_id,
                  },
                ],
          };
        }
        const detail = await this.literature.detail(hit.literature_id);
        if (
          detail.meta_literature.meta_literature_id !==
            hit.meta_literature_id ||
          detail.metadata_revision !== hit.metadata_revision ||
          detail.metadata_sha256 !== hit.metadata_sha256 ||
          (detail.primary_pdf?.asset.asset_id ?? null) !== hit.primary_asset_id
        )
          throw new MaterialContextError("context-source-integrity");
        const gaps: MaterialContextBundle["gaps"][number][] = [];
        if (!detail.primary_pdf)
          gaps.push({
            code: "material-missing",
            literature_id: hit.literature_id,
          });
        else if (
          !(await this.storage!.hasDefault(
            hit.literature_id,
            detail.primary_pdf.asset.asset_id,
          ))
        )
          gaps.push({
            code: "representation-missing",
            literature_id: hit.literature_id,
          });
        const item: MaterialContextItem = {
          kind: "metadata",
          literature_id: hit.literature_id,
          meta_literature_id: hit.meta_literature_id,
          reference: {
            kind: "metadata",
            literature_id: hit.literature_id,
            metadata_revision: hit.metadata_revision,
            metadata_sha256: hit.metadata_sha256,
          },
          section_title: null,
          text: [
            detail.literature.metadata.title,
            detail.literature.metadata.abstract,
            detail.literature.metadata.authors
              .map((author) => author.display_name)
              .join(" "),
            detail.literature.metadata.keywords.join(" "),
            detail.literature.metadata.subject_terms.join(" "),
            detail.literature.metadata.venue,
            detail.literature.metadata.publisher,
            detail.literature.metadata.publication_year?.toString(),
          ]
            .filter(Boolean)
            .join("\n"),
          evidence: [],
          rank: 0,
          score: hit.score,
          gap: null,
        };
        return { item, gaps };
      };
      const sources = new Map<
        string,
        Awaited<ReturnType<RetrievalStorageClient["literatureSources"]>>
      >();
      const matches = async (hit: RetrievalHit, reload = false) => {
        if (reload || !sources.has(hit.literature_id))
          sources.set(
            hit.literature_id,
            await this.storage!.literatureSources(hit.literature_id),
          );
        const snapshot = sources.get(hit.literature_id)!;
        const source =
          hit.kind === "metadata"
            ? snapshot.metadata
            : snapshot.documents.find(
                (s) => s.document_version_id === hit.document_version_id,
              );
        return (
          !!source &&
          source.meta_literature_id === hit.meta_literature_id &&
          source.metadata_revision === hit.metadata_revision &&
          source.metadata_sha256 === hit.metadata_sha256 &&
          (hit.kind === "metadata"
            ? source.primary_asset_id === hit.primary_asset_id
            : source.representation_sha256 === hit.representation_sha256 &&
              source.source_asset_id === hit.source_asset_id &&
              source.source_asset_sha256 === hit.source_asset_sha256 &&
              source.is_default === hit.is_default)
        );
      };
      const expand = async (hit: RetrievalHit) => {
        const stale = () => ({
          item: null,
          gaps: [
            { code: "index-stale" as const, literature_id: hit.literature_id },
          ],
        });
        check(signal);
        if (!(await matches(hit))) return stale();
        try {
          return await expandVerified(hit);
        } catch (error) {
          check(signal);
          if (!(await matches(hit, true))) return stale();
          throw error;
        }
      };
      const session: MaterialCandidateSession = {
        generation_id: generation.generation_id,
        source_revision: generation.source_revision,
        hits: found.hits,
        candidate_limit: found.candidateLimit,
        relevance_limited: found.relevanceLimited,
        coverage_gaps: coverage,
        expand,
        assertCurrent,
      };
      const result = await consume(session);
      await assertCurrent();
      return result;
    })();
    this.active.add(pending);
    try {
      return await pending;
    } catch (error) {
      if (
        error instanceof RetrievalStorageError &&
        error.code === "index-stale"
      )
        throw new MaterialContextError("context-cursor-invalid");
      throw error;
    } finally {
      this.active.delete(pending);
    }
  }
  private async execute(
    request: MaterialContextRequest,
    signal?: AbortSignal,
    window?: MaterialSearchWindow,
  ): Promise<MaterialContextBundle> {
    check(signal);
    let generation: Awaited<ReturnType<RetrievalStorageClient["active"]>> =
      null;
    let revision: number | null = null;
    const base = (
      coverage: MaterialContextBundle["coverage"],
    ): MaterialContextBundle => ({
      score_rule: RETRIEVAL_SCORE_RULE,
      items: [],
      coverage,
      ...(coverage === "index-corrupt"
        ? { maintenance_hint: "rebuild-index" as const }
        : {}),
      generation_id: generation?.generation_id ?? null,
      source_revision: revision,
      indexed_revision: generation?.source_revision ?? null,
      gaps: [],
      usage: { bytes: 0, items: 0, tokens: null, tokenizer: null },
      truncated: false,
      continuation: null,
    });
    const finish = (value: MaterialContextBundle) => {
      check(signal);
      const counted = withBytes(value);
      if (counted.usage.bytes > request.budget.max_bytes)
        throw new MaterialContextError("context-budget-invalid");
      return parseMaterialContextBundle(counted, request);
    };
    if (!this.storage) return finish(base("index-unavailable"));
    let snapshot;
    try {
      snapshot = await this.storage.state();
    } catch (error) {
      if (
        error instanceof RetrievalStorageError &&
        error.code === "index-corrupt"
      )
        return finish(base("index-corrupt"));
      throw error;
    }
    generation = snapshot.generation;
    revision = snapshot.source_revision;
    if (!generation) return finish(base("index-unavailable"));
    const state = snapshot.state_token!;
    const after =
      request.continuation === null
        ? null
        : decodeCursor(
            request,
            request.continuation,
            generation.generation_id,
            generation.source_revision,
            state,
          );
    const gaps: MaterialContextBundle["gaps"][number][] = [];
    const boundedGaps = () =>
      gaps.length <= 32
        ? [...gaps]
        : [...new Set(gaps.map((g) => g.code))].map((code) => ({
            code,
            literature_id: null,
          }));
    const addGaps = (added: MaterialContextBundle["gaps"]) => {
      for (const gap of added)
        if (
          !gaps.some(
            (g) =>
              g.code === gap.code &&
              (g.literature_id === null ||
                g.literature_id === gap.literature_id),
          )
        )
          gaps.push(gap);
    };
    const items: MaterialContextItem[] = [];
    let relevanceLimited = false;
    const relevance = (): Pick<MaterialContextBundle, "relevance_limit"> =>
      relevanceLimited ? { relevance_limit: RELEVANCE_RESULT_LIMIT } : {};
    let cursor: string | null = request.continuation,
      truncated = false;
    try {
      await this.withCandidates(
        { ...request, continuation: null },
        { ...generation, state_token: state },
        async (session) => {
          relevanceLimited = session.relevance_limited;
          addGaps(session.coverage_gaps);
          if (session.candidate_limit)
            addGaps([{ code: "candidate-limit", literature_id: null }]);
          const follows = (hit: RetrievalHit) => {
            if (!after) return true;
            const left = position(hit),
              keys = [
                "score",
                "kind",
                "literature_id",
                "document_version_id",
                "unit_ordinal",
              ] as const;
            for (const key of keys) {
              if (left[key] !== after[key]) return left[key] > after[key];
            }
            return false;
          };
          const hits = session.hits.filter(follows);
          for (const [ordinal, hit] of hits.entries()) {
            check(signal);
            if (items.length >= request.budget.max_items) {
              truncated = true;
              break;
            }
            const next = encodeCursor(
              request,
              generation!.generation_id,
              generation!.source_revision,
              position(hit),
              state,
            );
            const expanded = await session.expand(hit);
            if (!expanded.item) {
              addGaps(expanded.gaps);
              cursor = next;
              truncated = ordinal + 1 < hits.length;
              continue;
            }
            const full = { ...expanded.item, rank: items.length + 1 };
            const make = (
              item: MaterialContextItem,
              extra: MaterialContextBundle["gaps"],
            ) =>
              withBytes({
                ...base("partial"),
                ...relevance(),
                items: [...items, item],
                gaps: extra,
                truncated: true,
                continuation: next,
                usage: {
                  bytes: 0,
                  items: items.length + 1,
                  tokens: null,
                  tokenizer: null,
                },
              });
            const proposedGaps = [...boundedGaps(), ...expanded.gaps];
            // Check with a continuation even on the last item, preserving a safe
            // budget if the next candidate needs a fresh page.
            if (
              make(
                full,
                proposedGaps.length <= 32 ? proposedGaps : boundedGaps(),
              ).usage.bytes <= request.budget.max_bytes
            ) {
              items.push(full);
              addGaps(expanded.gaps);
            } else {
              const extra = [
                ...expanded.gaps,
                {
                  code: "context-too-large" as const,
                  literature_id: hit.literature_id,
                },
              ];
              const compact = {
                ...full,
                text: "",
                evidence: [],
                gap: "context-too-large" as const,
              };
              const all = [...boundedGaps(), ...extra];
              if (
                make(compact, all.length <= 32 ? all : boundedGaps()).usage
                  .bytes > request.budget.max_bytes
              ) {
                if (!items.length)
                  throw new MaterialContextError("context-budget-invalid");
                truncated = true;
                break;
              }
              items.push(compact);
              addGaps(extra);
            }
            cursor = next;
            truncated = ordinal + 1 < hits.length;
          }
        },
        signal,
        undefined,
        window,
      );
    } catch (error) {
      if (
        error instanceof RetrievalStorageError &&
        error.code === "index-corrupt"
      )
        return finish(base("index-corrupt"));
      throw error;
    }
    // A source write alone does not invalidate this fixed index page. Each hit
    // was verified against its exact source; an index mutation does invalidate it.
    const latest = await this.storage.state();
    if (latest.state_token !== state)
      throw new MaterialContextError("context-cursor-invalid");
    revision = latest.source_revision;
    const stale =
      revision !== generation.source_revision ||
      gaps.some((g) => g.code === "index-stale");
    return finish({
      ...base(
        stale
          ? "index-stale"
          : gaps.length || truncated
            ? "partial"
            : "complete",
      ),
      ...relevance(),
      items,
      gaps: boundedGaps(),
      truncated,
      continuation: truncated ? cursor : null,
      usage: { bytes: 0, items: items.length, tokens: null, tokenizer: null },
    });
  }
}
