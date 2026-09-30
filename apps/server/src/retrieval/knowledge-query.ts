import { createHash } from "node:crypto";
import {
  parseKnowledgeContextBundle,
  parseKnowledgeContextRequest,
  knowledgeStatementSha256,
  sha256,
  synthesisStatementSha256,
  type GeneratedKnowledgeContextItem,
  type KnowledgeContextBundle,
  type KnowledgeContextGapCode,
  type KnowledgeContextItem,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";
import { queryTerms } from "../literature/query.js";
import { DocumentReadError } from "../document/read.js";
import {
  LiteratureNotFoundError,
  LiteratureQueryError,
} from "../literature/query.js";
import {
  SynthesisReadError,
  type SynthesisReadSession,
  type SqliteSynthesisStorage,
} from "../storage/synthesis.js";
import type { RetrievalStorageClient } from "../storage/sqlite/retrieval-client.js";
import { SqliteWorkerError } from "../storage/sqlite/worker.js";
import { RetrievalStorageError, RETRIEVAL_SCORE_RULE } from "./model.js";
import {
  MaterialContextError,
  MaterialContextService,
  type MaterialCandidateSession,
} from "./query.js";
import type { KnowledgeRetrievalHit, RetrievalHit } from "./storage.js";

const encoder = new TextEncoder();
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const maxCandidate = 4097;

type KnowledgePosition = Pick<
  KnowledgeRetrievalHit,
  "score" | "artifact_id" | "statement_ordinal"
>;
type Branch = { generation_id: string; source_revision: number } | null;
type Cursor = {
  version: 1;
  fingerprint: string;
  material: Branch;
  knowledge: Branch;
  material_after: string | null;
  material_done: boolean;
  knowledge_after: KnowledgePosition | null;
};
function fingerprint(request: KnowledgeContextRequest): string {
  return digest(JSON.stringify({ ...request, continuation: null }));
}
function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify(cursor);
  return Buffer.from(
    JSON.stringify({ payload, checksum: digest(payload) }),
  ).toString("base64url");
}
function sameBranch(a: Branch, b: Branch): boolean {
  return (
    a?.generation_id === b?.generation_id &&
    a?.source_revision === b?.source_revision
  );
}
function decodeCursor(
  value: string,
  request: KnowledgeContextRequest,
  material: Branch,
  knowledge: Branch,
): Cursor {
  try {
    const envelope = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { payload: string; checksum: string };
    if (
      !envelope ||
      Object.keys(envelope).sort().join() !== "checksum,payload" ||
      typeof envelope.payload !== "string" ||
      typeof envelope.checksum !== "string" ||
      digest(envelope.payload) !== envelope.checksum
    )
      throw new Error();
    const cursor = JSON.parse(envelope.payload) as Cursor;
    if (
      !cursor ||
      Object.keys(cursor).sort().join() !==
        "fingerprint,knowledge,knowledge_after,material,material_after,material_done,version" ||
      cursor.version !== 1 ||
      cursor.fingerprint !== fingerprint(request) ||
      !sameBranch(cursor.material, material) ||
      !sameBranch(cursor.knowledge, knowledge) ||
      (cursor.material_after !== null &&
        (typeof cursor.material_after !== "string" ||
          !/^(0|[1-9][0-9]{0,3})$/.test(cursor.material_after))) ||
      typeof cursor.material_done !== "boolean" ||
      (cursor.knowledge_after !== null &&
        (!cursor.knowledge_after ||
          Object.keys(cursor.knowledge_after).sort().join() !==
            "artifact_id,score,statement_ordinal" ||
          typeof cursor.knowledge_after.artifact_id !== "string" ||
          !Number.isSafeInteger(cursor.knowledge_after.score) ||
          !Number.isSafeInteger(cursor.knowledge_after.statement_ordinal)))
    )
      throw new Error();
    return cursor;
  } catch {
    throw new KnowledgeContextError("context-cursor-invalid");
  }
}
function counted(bundle: KnowledgeContextBundle): KnowledgeContextBundle {
  let result = { ...bundle, usage: { ...bundle.usage, bytes: 0 } };
  for (let i = 0; i < 10; i++) {
    const bytes = encoder.encode(JSON.stringify(result)).length;
    if (bytes === result.usage.bytes) return result;
    result = { ...result, usage: { ...result.usage, bytes } };
  }
  throw new KnowledgeContextError("context-budget-invalid");
}
function gap(
  code: KnowledgeContextGapCode,
  literature_id: string | null = null,
  artifact_id: string | null = null,
) {
  return { code, literature_id, artifact_id } as const;
}
function uniqueGaps(
  values: KnowledgeContextBundle["gaps"],
): KnowledgeContextBundle["gaps"] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareKnowledge(
  a: KnowledgeRetrievalHit,
  b: KnowledgeRetrievalHit,
): number {
  return (
    a.score - b.score ||
    compareText(a.artifact_id, b.artifact_id) ||
    a.statement_ordinal - b.statement_ordinal
  );
}
function compareItem(
  a: { item: KnowledgeContextItem; id: string; ordinal: number },
  b: { item: KnowledgeContextItem; id: string; ordinal: number },
): number {
  const kind = (item: KnowledgeContextItem) =>
    item.kind === "generated-knowledge"
      ? "knowledge"
      : item.kind === "source-text"
        ? "document"
        : "metadata";
  const lit = (item: KnowledgeContextItem) =>
    item.kind === "generated-knowledge"
      ? item.source_literature_ids[0]!
      : item.literature_id;
  return (
    a.item.score - b.item.score ||
    compareText(kind(a.item), kind(b.item)) ||
    compareText(lit(a.item), lit(b.item)) ||
    compareText(a.id, b.id) ||
    a.ordinal - b.ordinal
  );
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KnowledgeContextError("context-cancelled");
}
export class KnowledgeContextError extends Error {
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
class KnowledgeSourceError extends Error {
  constructor(readonly code: "source-missing" | "source-corrupt") {
    super(code);
  }
}
function materialSourceError(error: unknown): KnowledgeSourceError | null {
  if (error instanceof DocumentReadError) {
    if (error.code === "document-missing" || error.code === "material-missing")
      return new KnowledgeSourceError("source-missing");
    if (
      error.code === "document-integrity" &&
      !(error.cause instanceof SqliteWorkerError)
    )
      return new KnowledgeSourceError("source-corrupt");
  }
  if (error instanceof LiteratureNotFoundError)
    return new KnowledgeSourceError("source-missing");
  if (
    error instanceof LiteratureQueryError ||
    (error instanceof MaterialContextError &&
      error.code === "context-source-integrity")
  )
    return new KnowledgeSourceError("source-corrupt");
  return null;
}

/** Read-only mixed Context. It never starts maintenance, parsing, or model work. */
export class KnowledgeContextService {
  private readonly active = new Set<Promise<KnowledgeContextBundle>>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly material: MaterialContextService | null,
    private readonly storage: RetrievalStorageClient | null,
    private readonly sources: SqliteSynthesisStorage | null,
  ) {}
  close(): Promise<void> {
    this.stopped = true;
    return (this.closing ??= Promise.allSettled([...this.active]).then(
      () => undefined,
    ));
  }
  search(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeContextBundle> {
    const request = parseKnowledgeContextRequest(value);
    if (request.budget.token_limit !== null)
      throw new KnowledgeContextError("context-tokenizer-unsupported");
    if (this.stopped) throw new KnowledgeContextError("context-cancelled");
    const pending = this.execute(request, signal);
    this.active.add(pending);
    return pending.finally(() => this.active.delete(pending));
  }
  private async execute(
    request: KnowledgeContextRequest,
    signal?: AbortSignal,
  ): Promise<KnowledgeContextBundle> {
    check(signal);
    const wantsMaterial = request.kinds.some((kind) => kind !== "knowledge");
    const wantsKnowledge = request.kinds.includes("knowledge");
    const generations: { material: Branch; knowledge: Branch } = {
      material: null,
      knowledge: null,
    };
    const branchGaps: KnowledgeContextBundle["gaps"][number][] = [];
    let materialFailure:
      | "index-unavailable"
      | "index-corrupt"
      | "index-stale"
      | null = null;
    let knowledgeFailure:
      | "index-unavailable"
      | "index-corrupt"
      | "index-stale"
      | null = null;
    if (wantsMaterial) {
      if (!this.material || !this.storage)
        materialFailure = "index-unavailable";
      else
        try {
          const active = await this.storage.active();
          if (!active) materialFailure = "index-unavailable";
          else {
            const revision = await this.storage.revision();
            if (revision !== active.source_revision)
              materialFailure = "index-stale";
            else
              generations.material = {
                generation_id: active.generation_id,
                source_revision: revision,
              };
          }
        } catch (error) {
          materialFailure =
            error instanceof RetrievalStorageError &&
            error.code === "index-stale"
              ? "index-stale"
              : "index-corrupt";
        }
    }
    if (wantsKnowledge) {
      if (!this.sources || !this.storage)
        knowledgeFailure = "index-unavailable";
      else
        try {
          const active = await this.storage.knowledgeActive();
          if (!active) knowledgeFailure = "index-unavailable";
          else {
            const revision = await this.storage.knowledgeRevision();
            if (revision !== active.source_revision)
              knowledgeFailure = "index-stale";
            else
              generations.knowledge = {
                generation_id: active.generation_id,
                source_revision: revision,
              };
          }
        } catch (error) {
          knowledgeFailure =
            error instanceof RetrievalStorageError &&
            error.code === "index-stale"
              ? "index-stale"
              : "index-corrupt";
        }
    }
    const fresh: Cursor =
      request.continuation === null
        ? {
            version: 1,
            fingerprint: fingerprint(request),
            material: generations.material,
            knowledge: generations.knowledge,
            material_after: null,
            material_done: false,
            knowledge_after: null,
          }
        : decodeCursor(
            request.continuation,
            request,
            generations.material,
            generations.knowledge,
          );
    const failures = [materialFailure, knowledgeFailure].filter(
      (x): x is NonNullable<typeof x> => x !== null,
    );
    if (
      (materialFailure && knowledgeFailure) ||
      (failures.length && (!wantsMaterial || !wantsKnowledge))
    ) {
      const coverage = failures.includes("index-corrupt")
        ? "index-corrupt"
        : failures.includes("index-stale")
          ? "index-stale"
          : "index-unavailable";
      return this.finish(request, {
        schema_version: 2,
        score_rule: RETRIEVAL_SCORE_RULE,
        items: [],
        coverage,
        generations,
        gaps: [],
        usage: { bytes: 0, items: 0, tokens: null, tokenizer: null },
        truncated: false,
        continuation: null,
      });
    }
    if (materialFailure) branchGaps.push(gap(`material-${materialFailure}`));
    if (knowledgeFailure) branchGaps.push(gap(`knowledge-${knowledgeFailure}`));
    let cursor = { ...fresh };
    const terms = queryTerms(request.query);
    const fts = terms.map((term) => `"${term}"`).join(" AND ");
    let knowledgeHits: readonly KnowledgeRetrievalHit[] = [];
    let knowledgeCandidateLimit = false;
    if (generations.knowledge) {
      try {
        const scope =
          request.scope.kind === "literatures"
            ? request.scope.literature_ids
            : [];
        const artifacts =
          request.scope.kind === "artifacts"
            ? request.scope.artifact_ids
            : request.knowledge!.selection === "explicit"
              ? request.knowledge!.artifact_ids
              : null;
        const questionSha =
          request.knowledge!.question === null
            ? null
            : await sha256(encoder.encode(request.knowledge!.question));
        const coverage = await this.storage!.knowledgeCoverage(
          generations.knowledge.generation_id,
          scope,
          artifacts,
          request.knowledge!.purposes,
          questionSha,
          request.knowledge!.selection,
        );
        const missing = [
          ...coverage.missing_literature_ids.map((id) =>
            gap("knowledge-missing", id),
          ),
          ...coverage.missing_artifact_ids.map((id) =>
            gap("knowledge-missing", null, id),
          ),
        ];
        if (missing.length > 24) branchGaps.push(gap("knowledge-missing"));
        else if (missing.length) branchGaps.push(...missing);
        else if (!coverage.any) branchGaps.push(gap("knowledge-missing"));
        if (coverage.any && terms.length) {
          const result = await this.storage!.knowledgeSearch(
            fts,
            terms,
            generations.knowledge.generation_id,
            scope,
            artifacts,
            request.knowledge!.purposes,
            questionSha,
            request.knowledge!.selection,
            maxCandidate,
          );
          knowledgeHits = result.hits;
          knowledgeCandidateLimit = result.candidateLimit;
        }
      } catch {
        throw new KnowledgeContextError("context-source-integrity");
      }
    }
    const assemble = async (
      session: SynthesisReadSession | null,
      material: MaterialCandidateSession | null,
    ): Promise<KnowledgeContextBundle> => {
      const nextKnowledge = () =>
        knowledgeHits.find(
          (hit) =>
            !cursor.knowledge_after ||
            compareKnowledge(
              hit,
              cursor.knowledge_after as KnowledgeRetrievalHit,
            ) > 0,
        );
      const materialHits = material?.hits ?? [];
      let materialIndex =
        cursor.material_after === null ? 0 : Number(cursor.material_after) + 1;
      if (
        materialIndex > materialHits.length ||
        (cursor.material_done && materialIndex < materialHits.length)
      )
        throw new KnowledgeContextError("context-cursor-invalid");
      const nextMaterial = (): { hit: RetrievalHit; index: number } | null =>
        materialIndex < materialHits.length
          ? { hit: materialHits[materialIndex]!, index: materialIndex }
          : null;
      const items: KnowledgeContextItem[] = [];
      const initialGaps: KnowledgeContextBundle["gaps"][number][] = [
        ...branchGaps,
        ...(material?.coverage_gaps.map((entry) =>
          gap(entry.code, entry.literature_id),
        ) ?? []),
      ];
      if (material?.candidate_limit) initialGaps.push(gap("candidate-limit"));
      if (knowledgeCandidateLimit) initialGaps.push(gap("candidate-limit"));
      const gaps: KnowledgeContextBundle["gaps"][number][] =
        uniqueGaps(initialGaps).length <= 24
          ? [...uniqueGaps(initialGaps)]
          : [...new Set(initialGaps.map((entry) => entry.code))].map((code) =>
              gap(code),
            );
      let truncated = false;
      let progressed = false;
      const base = (
        continuation: string | null,
        proposed: readonly KnowledgeContextItem[],
        proposedGaps: KnowledgeContextBundle["gaps"],
      ): KnowledgeContextBundle => ({
        schema_version: 2,
        score_rule: RETRIEVAL_SCORE_RULE,
        items: proposed,
        coverage: proposedGaps.length || continuation ? "partial" : "complete",
        generations,
        gaps: uniqueGaps(proposedGaps),
        usage: {
          bytes: 0,
          items: proposed.length,
          tokens: null,
          tokenizer: null,
        },
        truncated: continuation !== null,
        continuation,
      });
      const acceptSourceGap = (
        sourceGap: KnowledgeContextBundle["gaps"][number],
        after: Cursor,
        nextMaterialIndex: number,
      ): boolean => {
        const previousCursor = cursor;
        const previousMaterialIndex = materialIndex;
        cursor = after;
        materialIndex = nextMaterialIndex;
        const remaining = !!nextMaterial() || !!nextKnowledge();
        const continuation = remaining ? encodeCursor(cursor) : null;
        const proposedGaps = uniqueGaps([...gaps, sourceGap]);
        const fits =
          proposedGaps.length <= 32 &&
          counted(base(continuation, items, proposedGaps)).usage.bytes <=
            request.budget.max_bytes;
        if (!fits) {
          cursor = previousCursor;
          materialIndex = previousMaterialIndex;
          return false;
        }
        gaps.push(sourceGap);
        progressed = true;
        return true;
      };
      while (items.length < request.budget.max_items) {
        check(signal);
        const materialCandidate = nextMaterial();
        const knowledge = nextKnowledge();
        if (!materialCandidate && !knowledge) break;
        if (uniqueGaps(gaps).length >= 32) {
          if (!progressed)
            throw new KnowledgeContextError("context-budget-invalid");
          truncated = true;
          break;
        }
        const materialComparable = materialCandidate && {
          item: {
            kind:
              materialCandidate.hit.kind === "document"
                ? "source-text"
                : "metadata",
            score: materialCandidate.hit.score,
            literature_id: materialCandidate.hit.literature_id,
          } as KnowledgeContextItem,
          id: materialCandidate.hit.document_version_id ?? "",
          ordinal: materialCandidate.hit.unit_ordinal,
        };
        const knowledgeComparable = knowledge && {
          item: {
            kind: "generated-knowledge",
            score: knowledge.score,
            source_literature_ids: knowledge.source_literature_ids,
          } as KnowledgeContextItem,
          id: knowledge.artifact_id,
          ordinal: knowledge.statement_ordinal,
        };
        const takeMaterial =
          !!materialComparable &&
          (!knowledgeComparable ||
            compareItem(materialComparable, knowledgeComparable) <= 0);
        const before = cursor;
        const beforeMaterialIndex = materialIndex;
        let item: KnowledgeContextItem;
        let itemGaps: KnowledgeContextBundle["gaps"] = [];
        if (takeMaterial) {
          const next = materialCandidate!;
          if (!material)
            throw new KnowledgeContextError("context-source-integrity");
          let expanded: Awaited<ReturnType<MaterialCandidateSession["expand"]>>;
          try {
            expanded = await material.expand(next.hit);
          } catch (error) {
            if (
              error instanceof DocumentReadError &&
              error.code === "document-budget"
            )
              throw new KnowledgeContextError("context-budget-invalid");
            const failure = materialSourceError(error);
            if (!failure) throw error;
            const after = {
              ...cursor,
              material_after: String(next.index),
              material_done: next.index + 1 >= materialHits.length,
            };
            if (
              !acceptSourceGap(
                gap(failure.code, next.hit.literature_id),
                after,
                next.index + 1,
              )
            ) {
              if (!progressed)
                throw new KnowledgeContextError("context-budget-invalid");
              truncated = true;
              break;
            }
            continue;
          }
          item = expanded.item;
          itemGaps = expanded.gaps.map((entry) =>
            gap(entry.code, entry.literature_id),
          );
          materialIndex++;
          cursor = {
            ...cursor,
            material_after: String(next.index),
            material_done: materialIndex >= materialHits.length,
          };
        } else {
          if (!session)
            throw new KnowledgeContextError("context-source-integrity");
          try {
            item = await this.expandKnowledge(
              knowledge!,
              request,
              session,
              signal,
            );
          } catch (error) {
            if (!(error instanceof KnowledgeSourceError)) throw error;
            const sourceGap = gap(error.code, null, knowledge!.artifact_id);
            const after = {
              ...cursor,
              knowledge_after: {
                score: knowledge!.score,
                artifact_id: knowledge!.artifact_id,
                statement_ordinal: knowledge!.statement_ordinal,
              },
            };
            if (!acceptSourceGap(sourceGap, after, materialIndex)) {
              if (!progressed)
                throw new KnowledgeContextError("context-budget-invalid");
              truncated = true;
              break;
            }
            continue;
          }
          cursor = {
            ...cursor,
            knowledge_after: {
              score: knowledge!.score,
              artifact_id: knowledge!.artifact_id,
              statement_ordinal: knowledge!.statement_ordinal,
            },
          };
          if (item.kind === "generated-knowledge") {
            if (item.source_state === "source-only")
              itemGaps = [
                ...itemGaps,
                gap(
                  "source-only",
                  item.source_literature_ids[0] ?? null,
                  item.reference.artifact_id,
                ),
              ];
            if (item.coverage_status === "partial")
              itemGaps = [
                ...itemGaps,
                gap("coverage-partial", null, item.reference.artifact_id),
              ];
          }
        }
        const full = {
          ...item,
          rank: items.length + 1,
        } as KnowledgeContextItem;
        const hasMore = !!nextMaterial() || !!nextKnowledge();
        const state = hasMore ? encodeCursor(cursor) : null;
        const fullGaps = uniqueGaps([...gaps, ...itemGaps]);
        if (
          fullGaps.length <= 32 &&
          counted(base(state, [...items, full], fullGaps)).usage.bytes <=
            request.budget.max_bytes
        ) {
          items.push(full);
          gaps.push(...itemGaps);
          progressed = true;
        } else {
          const compact =
            full.kind === "generated-knowledge"
              ? { ...full, statement: null, gap: "context-too-large" as const }
              : full.kind === "source-text"
                ? {
                    ...full,
                    text: "",
                    evidence: [],
                    gap: "context-too-large" as const,
                  }
                : null;
          const compactGap = gap(
            "context-too-large",
            full.kind === "generated-knowledge" ? null : full.literature_id,
            full.kind === "generated-knowledge"
              ? full.reference.artifact_id
              : null,
          );
          const compactGaps = uniqueGaps([...gaps, ...itemGaps, compactGap]);
          if (
            compact &&
            compactGaps.length <= 32 &&
            counted(base(state, [...items, compact], compactGaps)).usage
              .bytes <= request.budget.max_bytes
          ) {
            items.push(compact);
            gaps.push(...itemGaps, compactGap);
            progressed = true;
          } else {
            cursor = before;
            materialIndex = beforeMaterialIndex;
            if (!progressed)
              throw new KnowledgeContextError("context-budget-invalid");
            truncated = true;
            break;
          }
        }
        if (!hasMore) break;
      }
      if (!truncated) {
        truncated = !!nextMaterial() || !!nextKnowledge();
      }
      const continuation = truncated ? encodeCursor(cursor) : null;
      if (generations.knowledge) {
        const current = await this.storage!.knowledgeActive();
        const revision = await this.storage!.knowledgeRevision();
        if (
          !current ||
          current.generation_id !== generations.knowledge.generation_id ||
          current.source_revision !== generations.knowledge.source_revision ||
          revision !== generations.knowledge.source_revision
        )
          throw new KnowledgeContextError("context-cursor-invalid");
      }
      return this.finish(request, base(continuation, items, gaps));
    };
    const run = (session: SynthesisReadSession | null) => {
      if (!generations.material) return assemble(session, null);
      const materialRequest = {
        query: request.query,
        scope:
          request.scope.kind === "literatures"
            ? request.scope
            : { kind: "library" as const },
        kinds: request.kinds.filter(
          (kind): kind is "metadata" | "document" => kind !== "knowledge",
        ),
        versions: request.versions,
        budget: { max_items: 1, max_bytes: 262144, token_limit: null },
        continuation: null,
      };
      return this.material!.withCandidates(
        materialRequest,
        generations.material,
        (material) => assemble(session, material),
        signal,
        session
          ? (bytes) => session.reserveExternalVerifiedBytes(bytes)
          : undefined,
      );
    };
    try {
      return generations.knowledge
        ? await this.sources!.withReadSession(run, 64 * 1024 * 1024, signal)
        : await run(null);
    } catch (error) {
      if (
        error instanceof SynthesisReadError &&
        error.code === "synthesis-limit"
      )
        throw new KnowledgeContextError("context-budget-invalid");
      if (
        error instanceof MaterialContextError &&
        error.code === "context-budget-invalid"
      )
        throw new KnowledgeContextError("context-budget-invalid");
      throw error;
    }
  }
  private async expandKnowledge(
    hit: KnowledgeRetrievalHit,
    request: KnowledgeContextRequest,
    session: SynthesisReadSession,
    signal?: AbortSignal,
  ): Promise<GeneratedKnowledgeContextItem> {
    check(signal);
    try {
      return await (async () => {
        const source = await session.sourceById(hit.artifact_id);
        if (!source) throw new KnowledgeSourceError("source-missing");
        const artifact = source.artifact;
        const statement = artifact.content.statements[hit.statement_ordinal];
        if (
          !statement ||
          statement.statement_id !== hit.statement_id ||
          artifact.content_ref.sha256 !== hit.content_sha256 ||
          artifact.input.manifest_sha256 !== hit.manifest_sha256 ||
          artifact.purpose !== hit.purpose ||
          (await sha256(encoder.encode(artifact.question ?? ""))) !==
            hit.question_sha256 ||
          hit.statement_sha256 !==
            (await (artifact.schema_version === 1
              ? knowledgeStatementSha256(statement)
              : synthesisStatementSha256(statement)))
        )
          throw new Error("indexed identity changed");
        const independent =
          artifact.schema_version === 1
            ? [artifact.input.items[0]!.literature_id]
            : await session.independentLiteratureIdsForEvidence(
                artifact.content.statements[hit.statement_ordinal]!.evidence,
                artifact.input.items,
              );
        const layers: GeneratedKnowledgeContextItem["source_layers"][number][] =
          [];
        for (const input of artifact.input.items) {
          if ("literature_id" in input) {
            const excluded =
              artifact.schema_version === 2 &&
              artifact.coverage.items.find(
                (item) => item.input_id === input.input_id,
              )?.status === "excluded";
            let state: "verified" | "source-only" | "missing" = "missing";
            if (artifact.schema_version === 1) state = source.state;
            else if (!excluded && input.document) {
              state =
                (await session.documentById(input.document.document_version_id))
                  ?.state ?? "missing";
            } else if (!excluded && input.material) {
              const material = await session.materialById(
                input.literature_id,
                input.material.asset_id,
              );
              if (material) {
                try {
                  await session.verifyMaterial(material);
                  state = "source-only";
                } catch (error) {
                  if (
                    !(
                      error instanceof DocumentReadError &&
                      error.code === "material-missing"
                    )
                  )
                    throw error;
                }
              }
            }
            layers.push({
              input_id: input.input_id,
              kind: "document",
              state,
              compression_depth: 0,
              source_artifact_id: null,
            });
          } else if (input.kind === "knowledge") {
            const excluded =
              artifact.schema_version === 2 &&
              artifact.coverage.items.find(
                (item) => item.input_id === input.input_id,
              )?.status === "excluded";
            const upstream =
              input.state === "missing" || excluded
                ? null
                : await session.sourceById(input.source_artifact_id);
            layers.push({
              input_id: input.input_id,
              kind: "knowledge",
              state: upstream?.state ?? "missing",
              compression_depth: input.compression_depth ?? 1,
              source_artifact_id: input.source_artifact_id,
            });
          }
        }
        const requestedLiteratureIds =
          request.scope.kind === "literatures"
            ? request.scope.literature_ids
            : null;
        if (
          !layers.length ||
          independent.some((id) => !hit.source_literature_ids.includes(id)) ||
          (requestedLiteratureIds !== null &&
            (hit.scope_complete !== 1 ||
              hit.source_literature_ids.some(
                (id) => !requestedLiteratureIds.includes(id),
              )))
        )
          throw new Error("indexed scope changed");
        return {
          kind: "generated-knowledge",
          reference: {
            kind: "knowledge",
            artifact_id: hit.artifact_id,
            content_sha256: hit.content_sha256,
            manifest_sha256: hit.manifest_sha256,
            statement_id: hit.statement_id,
            statement_sha256: hit.statement_sha256,
          },
          purpose: artifact.purpose,
          question: artifact.question,
          scope_kind: hit.scope_kind,
          source_literature_ids: hit.source_literature_ids,
          independent_literature_ids: independent,
          source_state: source.state,
          source_layers: layers,
          compression_depth:
            artifact.schema_version === 1 ? 1 : artifact.compression_depth,
          coverage_status: artifact.coverage.status,
          statement,
          rank: 0,
          score: hit.score,
          gap: null,
        };
      })();
    } catch (error) {
      check(signal);
      if (
        error instanceof KnowledgeSourceError ||
        (error instanceof SynthesisReadError &&
          [
            "synthesis-limit",
            "synthesis-cancelled",
            "synthesis-closed",
          ].includes(error.code))
      )
        throw error;
      throw new KnowledgeSourceError("source-corrupt");
    }
  }
  private async finish(
    request: KnowledgeContextRequest,
    value: KnowledgeContextBundle,
  ): Promise<KnowledgeContextBundle> {
    const final = counted(value);
    if (final.usage.bytes > request.budget.max_bytes)
      throw new KnowledgeContextError("context-budget-invalid");
    try {
      return await parseKnowledgeContextBundle(final, request);
    } catch {
      throw new KnowledgeContextError("context-source-integrity");
    }
  }
}
