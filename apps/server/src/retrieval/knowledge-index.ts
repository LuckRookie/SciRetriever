import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  knowledgeStatementSha256,
  sha256,
  synthesisStatementSha256,
  type KnowledgeArtifact,
  type SynthesisArtifact,
} from "@sciretriever/contracts";
import { ftsIndexText } from "../literature/unicode-casefold.js";
import type {
  SynthesisReadSession,
  SynthesisSource,
  SqliteSynthesisStorage,
} from "../storage/synthesis.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import type {
  KnowledgeRetrievalEntry,
  KnowledgeRetrievalGeneration,
} from "./storage.js";
import { RetrievalStorageClient } from "../storage/sqlite/retrieval-client.js";

const PAGE = 64;
const BATCH = 128;
const MAX_SOURCES = 100_000;
const MAX_ENTRIES = 2_000_000;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_FTS_BYTES = 2 * 1024 * 1024 * 1024;
const encoder = new TextEncoder();

export class KnowledgeIndexError extends Error {
  constructor(
    readonly code:
      | "index-v8-required"
      | "index-limit"
      | "index-cancelled"
      | "index-source-invalid",
  ) {
    super(code);
  }
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KnowledgeIndexError("index-cancelled");
}
function invalid(): never {
  throw new KnowledgeIndexError("index-source-invalid");
}

/** Knowledge sources are read through the bounded, fixed-artifact reader. */
export class KnowledgeRetrievalIndexService {
  private readonly active = new Map<
    Promise<KnowledgeRetrievalGeneration>,
    AbortController
  >();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly store: RetrievalStorageClient,
    private readonly reader: SqliteSynthesisStorage,
    private readonly admission: CatalogWriteAdmission,
  ) {}
  close(): Promise<void> {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    return (this.closing ??= Promise.allSettled([...this.active.keys()]).then(
      () => undefined,
    ));
  }
  build(signal?: AbortSignal): Promise<KnowledgeRetrievalGeneration> {
    if (this.stopped)
      return Promise.reject(new KnowledgeIndexError("index-cancelled"));
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const pending = this.admission.run(() => this.run(combined), combined);
    this.active.set(pending, controller);
    void pending
      .finally(() => this.active.delete(pending))
      .catch(() => undefined);
    return pending;
  }
  private async run(
    signal: AbortSignal,
  ): Promise<KnowledgeRetrievalGeneration> {
    check(signal);
    const root = await mkdtemp(join(tmpdir(), "sciretriever-knowledge-index-"));
    try {
      const spoolPath = join(root, "entries.ndjson");
      const spool = await open(spoolPath, "wx", 0o600);
      let sourceCount = 0;
      let entryCount = 0;
      let ftsBytes = 0;
      let revision: number;
      try {
        revision = await this.store.knowledgeRevision();
        let after: string | null = null;
        while (true) {
          check(signal);
          const page = await this.store.knowledgeSourcePage(after, PAGE);
          for (const source of page) {
            check(signal);
            if (++sourceCount > MAX_SOURCES)
              throw new KnowledgeIndexError("index-limit");
            let entries: KnowledgeRetrievalEntry[];
            try {
              entries = await this.reader.withReadSession(
                async (session) => {
                  const fixed = await session.sourceById(source.artifact_id);
                  if (!fixed) invalid();
                  return this.entries(source, fixed, session);
                },
                64 * 1024 * 1024,
                signal,
              );
            } catch (error) {
              check(signal);
              if (error instanceof KnowledgeIndexError) throw error;
              throw new KnowledgeIndexError("index-source-invalid");
            }
            let batch: KnowledgeRetrievalEntry[] = [];
            let batchBytes = 0;
            let first = true;
            const flush = async () => {
              if (!batch.length && !first) return;
              check(signal);
              await spool.writeFile(
                `${JSON.stringify({ entries: batch, source_count: first ? 1 : 0 })}\n`,
              );
              batch = [];
              batchBytes = 0;
              first = false;
              await yieldToEventLoop();
            };
            for (const entry of entries) {
              check(signal);
              const bytes = encoder.encode(JSON.stringify(entry)).length;
              const fts =
                encoder.encode(entry.title).length +
                encoder.encode(entry.body).length;
              if (
                ++entryCount > MAX_ENTRIES ||
                (ftsBytes += fts) > MAX_FTS_BYTES ||
                bytes > MAX_BATCH_BYTES
              )
                throw new KnowledgeIndexError("index-limit");
              if (
                batch.length &&
                (batch.length >= BATCH || batchBytes + bytes > MAX_BATCH_BYTES)
              )
                await flush();
              batch.push(entry);
              batchBytes += bytes;
            }
            await flush();
          }
          if (page.length < PAGE) break;
          after = page.at(-1)!.artifact_id;
          await yieldToEventLoop();
        }
      } finally {
        await spool.close();
      }
      check(signal);
      const generation = await this.store.knowledgeBegin(revision, signal);
      const input = createReadStream(spoolPath);
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          check(signal);
          const batch = JSON.parse(line) as {
            entries: KnowledgeRetrievalEntry[];
            source_count: number;
          };
          await this.store.knowledgeInsert(
            generation,
            batch.entries,
            batch.source_count,
            signal,
          );
          await yieldToEventLoop();
        }
      } finally {
        lines.close();
        input.destroy();
      }
      check(signal);
      return await this.store.knowledgePublish(generation, revision, signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  private async entries(
    source: Awaited<
      ReturnType<RetrievalStorageClient["knowledgeSourcePage"]>
    >[number],
    fixed: SynthesisSource,
    session: SynthesisReadSession,
  ): Promise<KnowledgeRetrievalEntry[]> {
    const artifact = fixed.artifact;
    const single = artifact.schema_version === 1;
    if (
      artifact.artifact_id !== source.artifact_id ||
      artifact.content_ref.sha256 !== source.content_sha256 ||
      artifact.input.manifest_sha256 !== source.manifest_sha256 ||
      artifact.purpose !== source.purpose ||
      (single ? "literature" : "manifest") !== source.scope_kind ||
      (single
        ? artifact.input.items[0]?.literature_id
        : artifact.input.manifest_sha256) !== source.scope_key ||
      (await sha256(encoder.encode(artifact.question ?? ""))) !==
        source.question_sha256 ||
      (single && source.purpose === "synthesis") ||
      (!single && source.purpose !== "synthesis")
    )
      invalid();
    const closure = await this.closure(artifact, session);
    const title = ftsIndexText(artifact.content.title);
    if (encoder.encode(title).length > 8192)
      throw new KnowledgeIndexError("index-limit");
    const entries: KnowledgeRetrievalEntry[] = [];
    for (const [ordinal, statement] of artifact.content.statements.entries()) {
      const body = ftsIndexText(
        [
          statement.text,
          ...statement.conditions,
          ...(statement.quantity
            ? [
                statement.quantity.value,
                statement.quantity.unit,
                statement.quantity.comparison_basis ?? "",
              ]
            : []),
        ].join("\n"),
      );
      if (!body) invalid();
      if (encoder.encode(body).length > 65536)
        throw new KnowledgeIndexError("index-limit");
      entries.push({
        artifact_id: artifact.artifact_id,
        content_sha256: artifact.content_ref.sha256,
        manifest_sha256: artifact.input.manifest_sha256,
        scope_kind: source.scope_kind,
        scope_key: source.scope_key,
        purpose: source.purpose,
        question_sha256: source.question_sha256,
        statement_id: statement.statement_id,
        statement_ordinal: ordinal,
        statement_sha256: single
          ? await knowledgeStatementSha256(statement)
          : await synthesisStatementSha256(statement),
        source_literature_ids: closure.ids,
        scope_complete: closure.complete ? 1 : 0,
        is_default: source.default_artifact_id === artifact.artifact_id ? 1 : 0,
        title,
        body,
      });
    }
    return entries;
  }
  private async closure(
    root: KnowledgeArtifact | SynthesisArtifact,
    session: SynthesisReadSession,
  ): Promise<{ ids: readonly string[]; complete: boolean }> {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let complete = true;
    let edges = 0;
    const visit = async (
      artifact: KnowledgeArtifact | SynthesisArtifact,
      depth: number,
    ): Promise<void> => {
      if (depth > 32 || seen.size > 4096)
        throw new KnowledgeIndexError("index-limit");
      if (seen.has(artifact.artifact_id)) return;
      seen.add(artifact.artifact_id);
      for (const item of artifact.input.items) {
        if (++edges > 4096) throw new KnowledgeIndexError("index-limit");
        if ("literature_id" in item) {
          ids.add(item.literature_id);
          if (ids.size > 1024) throw new KnowledgeIndexError("index-limit");
        } else if (item.kind === "knowledge") {
          if (item.state === "missing") {
            complete = false;
            continue;
          }
          const upstream = await session.sourceById(item.source_artifact_id);
          if (!upstream) invalid();
          await visit(upstream.artifact, depth + 1);
        }
      }
    };
    await visit(root, 0);
    if (!ids.size) invalid();
    return { ids: [...ids].sort(), complete };
  }
}
