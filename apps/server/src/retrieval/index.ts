import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { DocumentRef, LiteratureMetadata } from "@sciretriever/contracts";
import type {
  DocumentReadService,
  VerifiedDocumentStructure,
} from "../document/read.js";
import type { LiteratureQueryService } from "../literature/query.js";
import {
  CatalogWriteAdmission,
  WriteAdmissionError,
} from "../storage/write-admission.js";
import { ftsIndexText } from "../literature/unicode-casefold.js";
import {
  type RetrievalEntry,
  type RetrievalGeneration,
  type RetrievalSource,
} from "./storage.js";
import { RetrievalStorageError } from "./model.js";
import { RetrievalStorageClient } from "../storage/sqlite/retrieval-client.js";
import type { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import {
  currentDocumentTranslation,
  unitSpan,
  type DocumentTranslationStore,
} from "../translation/document.js";
import type {
  RetrievalCheckpoint,
  RetrievalLiteratureUpdate,
} from "../storage/sqlite/retrieval-engine.js";

export const RETRIEVAL_UNIT_RULE = "markdown-context-v1";
const PAGE = 64;
const BATCH = 128;
const CHANGE_PAGE = 384;
const MAX_SOURCE_FTS_BYTES = 64 * 1024 * 1024;
const MAX_SPOOL_BATCH_BYTES = 1024 * 1024;
const FTS_CHUNK_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function* chunks(
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  let current = "";
  let size = 0;
  let examined = 0;
  for (const character of text) {
    if (++examined % 4096 === 0) {
      check(signal);
      await yieldToEventLoop();
    }
    const bytes = encoder.encode(character).length;
    if (size + bytes > FTS_CHUNK_BYTES && current) {
      yield current;
      current = "";
      size = 0;
    }
    current += character;
    size += bytes;
  }
  yield current;
}
/** Shared by normal indexing and the explicit offline keyword-layout migration. */
export function metadataIndexBody(metadata: LiteratureMetadata): string {
  return [
    metadata.abstract,
    metadata.authors.map((a) => a.display_name).join(" "),
    metadata.keywords.join(" "),
    metadata.subject_terms.join(" "),
    metadata.venue,
    metadata.publisher,
    metadata.publication_year?.toString(),
  ]
    .filter((v): v is string => !!v)
    .join("\n");
}
export async function* metadataIndexChunks(metadata: LiteratureMetadata) {
  const title = ftsIndexText(metadata.title ?? "");
  for await (const chunk of chunks(metadataIndexBody(metadata)))
    yield { title, body: ftsIndexText(chunk) };
}
interface Unit {
  readonly start: number;
  readonly end: number;
  readonly section_id: string | null;
  readonly ordinal: number;
}
/** Blank-line blocks preserve complete paragraphs and whole Markdown tables. */
export async function* contextUnits(
  markdown: Uint8Array,
  structure: VerifiedDocumentStructure,
  signal?: AbortSignal,
): AsyncGenerator<Unit> {
  if (structure.schema_version === 2) {
    for (const [ordinal, segment] of structure.segments.entries()) {
      check(signal);
      if (ordinal % 256 === 0) await yieldToEventLoop();
      yield {
        start: segment.start_utf8,
        end: segment.end_utf8,
        section_id: segment.section_id,
        ordinal,
      };
    }
    return;
  }
  let start: number | null = null;
  let end = 0;
  let section: string | null = null;
  let ordinal = 0;
  const flush = (): Unit | null => {
    if (start !== null) {
      const unit = { start, end, section_id: section, ordinal: ordinal++ };
      start = null;
      return unit;
    }
    return null;
  };
  let examined = 0;
  for (const segment of structure.segments) {
    if (++examined % 256 === 0) {
      check(signal);
      await yieldToEventLoop();
    }
    const line = decoder.decode(
      markdown.subarray(segment.start_utf8, segment.end_utf8),
    );
    if (!line.trim() || segment.kind === "heading") {
      const unit = flush();
      if (unit) yield unit;
    }
    if (!line.trim()) continue;
    if (start === null) {
      start = segment.start_utf8;
      section = segment.section_id;
    }
    end = segment.end_utf8;
    if (segment.kind === "heading") {
      const unit = flush();
      if (unit) yield unit;
    }
  }
  const last = flush();
  if (last) yield last;
}

export class RetrievalIndexError extends Error {
  constructor(
    readonly code:
      | "index-v4-required"
      | "index-limit"
      | "index-storage-full"
      | "index-cancelled"
      | "index-source-invalid",
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RetrievalIndexError("index-cancelled");
}
type LiteratureSources = Awaited<
  ReturnType<RetrievalStorageClient["literatureSources"]>
>;

export class RetrievalIndexService {
  private readonly generationAdmission: CatalogWriteAdmission;
  private readonly active = new Map<
    Promise<RetrievalGeneration>,
    AbortController
  >();
  private closing: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private readonly store: RetrievalStorageClient,
    private readonly documents: DocumentReadService,
    private readonly literature: LiteratureQueryService,
    admission: CatalogWriteAdmission,
    /** Stored translations indexed with the original (document spec 9.7). */
    private readonly translations: {
      readonly store: DocumentTranslationStore;
      readonly annotations: Pick<SqliteAnnotationStorage, "current">;
    } | null = null,
  ) {
    // Serialize builders across processes without occupying the business write
    // queue. This names a lock sidecar, not another catalog. Lock order is
    // generation -> catalog; callers must not hold catalog admission here.
    this.generationAdmission = new CatalogWriteAdmission(
      `${admission.catalogPath}.retrieval-index`,
    );
  }

  private async verifiedMetadata(
    source: RetrievalSource,
  ): Promise<LiteratureMetadata> {
    try {
      const detail = await this.literature.detail(source.literature_id);
      if (
        detail.meta_literature.meta_literature_id !==
          source.meta_literature_id ||
        detail.metadata_revision !== source.metadata_revision ||
        detail.metadata_sha256 !== source.metadata_sha256 ||
        (detail.primary_pdf?.asset.asset_id ?? null) !== source.primary_asset_id
      )
        throw new RetrievalIndexError("index-source-invalid");
      return detail.literature.metadata;
    } catch (error) {
      if (error instanceof RetrievalIndexError) throw error;
      throw new RetrievalIndexError("index-source-invalid");
    }
  }

  close(): Promise<void> {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    return (this.closing ??= Promise.allSettled([...this.active.keys()]).then(
      () => this.generationAdmission.close(),
    ));
  }

  build(
    signal?: AbortSignal,
    progress?: (value: { done: number; total: number }) => Promise<void>,
  ): Promise<RetrievalGeneration> {
    return this.run(signal, progress);
  }

  /** Refresh a fixed journal prefix. A later commit is work for the next round. */
  refresh(
    signal?: AbortSignal,
    progress?: (pending: number) => Promise<void>,
  ): Promise<RetrievalGeneration> {
    return this.track(async (active) => {
      const scan = await this.store.changesSnapshot();
      const generation =
        scan.generation ?? (await this.store.ensureActive(active));
      await this.pruneRetired(active);
      await progress?.(scan.pending);
      const generationId = generation.generation_id;
      let position = scan.position;
      const checkpoint = (last: number): RetrievalCheckpoint => ({
        previous: position,
        position: last,
        revision: last === scan.tail ? scan.revision : null,
      });
      if (
        position === scan.tail &&
        scan.revision !== generation.source_revision
      )
        await this.store.finishIncremental(
          generationId,
          checkpoint(position),
          active,
        );
      readChanges: while (position < scan.tail) {
        check(active);
        const page = await this.store.changePage(
          position,
          scan.tail,
          CHANGE_PAGE,
        );
        if (!page.length) throw new RetrievalStorageError("index-corrupt");
        const updates = new Map<string, RetrievalLiteratureUpdate>();
        let last = position,
          bytes = 0,
          count = 0;
        const flush = async () => {
          if (!updates.size) return true;
          check(active);
          if (
            !(await this.store.commitLiteratureBatch(
              generationId,
              [...updates.values()],
              checkpoint(last),
              active,
            ))
          )
            return false;
          position = last;
          updates.clear();
          bytes = count = 0;
          return true;
        };
        for (const change of page) {
          const id = change.literature_id;
          check(active);
          const source = await this.store.literatureSources(id, generationId);
          try {
            const small = await this.smallLiteratureUpdate(source, active);
            if (!small) {
              if (!(await flush())) continue readChanges;
              if (
                !(await this.stageLiterature(
                  generationId,
                  id,
                  source,
                  checkpoint(change.position),
                  active,
                ))
              )
                continue readChanges;
              position = last = change.position;
              continue;
            }
            if (
              updates.size >= BATCH ||
              count + small.entries.length > BATCH ||
              bytes + small.bytes > MAX_SPOOL_BATCH_BYTES
            )
              if (!(await flush())) continue readChanges;
            updates.set(id, {
              literature_id: id,
              fingerprint: source.fingerprint,
              entries: source.indexed ? null : small.entries,
            });
            count += small.entries.length;
            bytes += small.bytes;
            last = change.position;
          } catch (error) {
            check(active);
            // Reads may race a new source before the CAS. Retry the unfinished
            // prefix only when the source actually changed.
            if (
              (await this.store.literatureSources(id)).fingerprint ===
              source.fingerprint
            )
              throw error;
            continue readChanges;
          }
        }
        if (!(await flush())) continue;
        await yieldToEventLoop();
      }
      check(active);
      await this.pruneChanges(active);
      return (await this.store.active())!;
    }, signal);
  }
  private async smallLiteratureUpdate(
    source: LiteratureSources,
    signal: AbortSignal,
  ) {
    if (source.documents.length) return null;
    const entries: RetrievalEntry[] = [];
    let bytes = 0;
    for await (const entry of this.literatureEntries(source, signal)) {
      bytes += Buffer.byteLength(entry.title) + Buffer.byteLength(entry.body);
      if (bytes > MAX_SPOOL_BATCH_BYTES || entries.length >= BATCH) return null;
      entries.push(entry);
    }
    return { entries, bytes };
  }
  private async stageLiterature(
    generation: string,
    id: string,
    source: LiteratureSources,
    checkpoint: RetrievalCheckpoint,
    signal: AbortSignal,
  ) {
    let staged: string | null = await this.store.beginLiteratureUpdate(signal);
    try {
      let batch: RetrievalEntry[] = [],
        bytes = 0,
        total = 0;
      const flush = async () => {
        if (!batch.length) return;
        check(signal);
        await this.store.insertEntries(staged!, batch, 0, signal);
        batch = [];
        bytes = 0;
        await yieldToEventLoop();
      };
      for await (const entry of this.literatureEntries(source, signal)) {
        const size =
          Buffer.byteLength(entry.title) + Buffer.byteLength(entry.body);
        if (total + size > MAX_SOURCE_FTS_BYTES || size > MAX_SPOOL_BATCH_BYTES)
          throw new RetrievalIndexError("index-limit");
        if (
          batch.length &&
          (batch.length >= BATCH || bytes + size > MAX_SPOOL_BATCH_BYTES)
        )
          await flush();
        batch.push(entry);
        bytes += size;
        total += size;
      }
      await flush();
      const accepted = await this.store.commitLiteratureUpdate(
        generation,
        staged,
        id,
        source.fingerprint,
        checkpoint,
        signal,
      );
      if (accepted) staged = null;
      return accepted;
    } finally {
      if (staged) await this.store.discardLiteratureUpdate(staged);
    }
  }
  private async pruneChanges(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        if (await this.store.pruneChangeBatch(signal)) return;
      } catch (error) {
        if (
          signal.aborted &&
          error instanceof WriteAdmissionError &&
          error.code === "write-admission-cancelled"
        )
          return;
        throw error;
      }
      await yieldToEventLoop();
    }
  }
  private async pruneRetired(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if ((await this.store.pruneGenerationBatch(null, signal)).done) return;
      } catch (error) {
        if (
          signal.aborted &&
          error instanceof WriteAdmissionError &&
          error.code === "write-admission-cancelled"
        )
          return;
        throw error;
      }
      await yieldToEventLoop();
    }
  }
  private track(
    work: (signal: AbortSignal) => Promise<RetrievalGeneration>,
    signal?: AbortSignal,
  ) {
    if (this.stopped)
      return Promise.reject(new RetrievalIndexError("index-cancelled"));
    const controller = new AbortController(),
      combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
    const pending = this.generationAdmission.run(
      () => work(combined),
      combined,
    );
    this.active.set(pending, controller);
    void pending.finally(() => this.active.delete(pending)).catch(() => {});
    return pending;
  }
  private async *literatureEntries(
    source: LiteratureSources,
    signal?: AbortSignal,
  ): AsyncGenerator<RetrievalEntry> {
    if (source.metadata) {
      const s = source.metadata,
        metadata = await this.verifiedMetadata(s);
      const title = ftsIndexText(metadata.title ?? ""),
        body = metadataIndexBody(metadata);
      for await (const chunk of chunks(body, signal))
        yield {
          kind: "metadata",
          literature_id: s.literature_id,
          meta_literature_id: s.meta_literature_id,
          metadata_revision: s.metadata_revision,
          metadata_sha256: s.metadata_sha256,
          document_version_id: null,
          representation_sha256: null,
          source_asset_id: null,
          source_asset_sha256: null,
          unit_start_utf8: null,
          unit_end_utf8: null,
          unit_sha256: null,
          section_id: null,
          unit_ordinal: 0,
          is_default: 1,
          title,
          body: ftsIndexText(chunk),
        };
    }
    for (const s of source.documents) {
      check(signal);
      await this.verifiedMetadata(s);
      const entries: RetrievalEntry[] = [];
      await this.documents.withVerifiedTextVersion(
        s.document_version_id!,
        async (version, markdown, structure) => {
          if (version.representation_sha256 !== s.representation_sha256)
            throw new RetrievalIndexError("index-source-invalid");
          let bytes = 0;
          for await (const entry of this.versionEntries(
            s,
            version,
            markdown,
            structure,
            signal,
          )) {
            bytes +=
              Buffer.byteLength(entry.title) + Buffer.byteLength(entry.body);
            if (bytes > MAX_SOURCE_FTS_BYTES)
              throw new RetrievalIndexError("index-limit");
            entries.push(entry);
          }
        },
        signal,
      );
      if (!entries.length)
        throw new RetrievalIndexError("index-source-invalid");
      yield* entries;
    }
  }
  /** Full source/text/posting verification is an explicit maintenance operation. */
  async verify(signal?: AbortSignal) {
    const started = performance.now();
    let sourceRevision: number | undefined;
    let generationId: string | undefined;
    const generation = await this.track(async (active) => {
      const scan = await this.store.scanChanges();
      sourceRevision = scan.revision;
      if (!scan.generation)
        throw new RetrievalStorageError("index-unavailable");
      generationId = scan.generation.generation_id;
      if (scan.revision !== scan.generation.source_revision)
        throw new RetrievalStorageError("index-stale");
      if (scan.literature_ids.length)
        throw new RetrievalStorageError("index-corrupt");
      const keys: readonly (keyof RetrievalEntry)[] = [
        "kind",
        "literature_id",
        "meta_literature_id",
        "metadata_revision",
        "metadata_sha256",
        "document_version_id",
        "representation_sha256",
        "source_asset_id",
        "source_asset_sha256",
        "unit_start_utf8",
        "unit_end_utf8",
        "unit_sha256",
        "section_id",
        "unit_ordinal",
        "is_default",
        "title",
        "body",
        "translation_language",
        "translation_sha256",
      ];
      const canonical = (entries: readonly RetrievalEntry[]) =>
        entries.map((e) => JSON.stringify(keys.map((key) => e[key]))).sort();
      let after: string | null = null;
      for (;;) {
        check(active);
        const sources = await this.store.metadataPage(after, PAGE);
        for (const item of sources) {
          const source = await this.store.literatureSources(item.literature_id),
            expected: RetrievalEntry[] = [];
          for await (const entry of this.literatureEntries(source, active))
            expected.push(entry);
          const actual = await this.store.verificationEntries(
            scan.generation.generation_id,
            item.literature_id,
          );
          if (
            JSON.stringify(canonical(expected)) !==
            JSON.stringify(canonical(actual))
          ) {
            if ((await this.store.revision()) !== scan.revision)
              throw new RetrievalStorageError("index-stale");
            throw new RetrievalStorageError("index-corrupt");
          }
        }
        if (sources.length < PAGE) break;
        after = sources.at(-1)!.literature_id;
        await yieldToEventLoop();
      }
      const verified = await this.store.verify();
      check(active);
      return this.store.recordVerification(
        scan.generation.generation_id,
        scan.revision,
        verified.proof,
        active,
      );
    }, signal).catch(async (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["index-corrupt", "index-source-invalid"].includes(String(error.code))
      ) {
        if (sourceRevision !== undefined && generationId !== undefined)
          await this.store.markCorrupt(generationId, sourceRevision);
      }
      throw error;
    });
    return {
      schema_version: 1 as const,
      status: "verified" as const,
      ...generation,
      elapsed_ms: Math.round(performance.now() - started),
    };
  }

  private run(
    signal?: AbortSignal,
    progress?: (value: { done: number; total: number }) => Promise<void>,
  ): Promise<RetrievalGeneration> {
    if (this.stopped)
      return Promise.reject(new RetrievalIndexError("index-cancelled"));
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const pending = this.generationAdmission.run(async () => {
      signal = combined;
      check(signal);
      const store = this.store;
      let spoolRoot: string | null = null;
      let revision: number | null = null;
      try {
        spoolRoot = await mkdtemp(join(tmpdir(), "sciretriever-index-"));
        const spoolPath = join(spoolRoot, "entries.ndjson");
        revision = await store.revision();
        const total = progress ? await store.sourceCount() : 0;
        let progressAt = performance.now();
        await progress?.({ done: 0, total });
        const spool = await open(spoolPath, "wx", 0o600);
        let sourceCount = 0;
        const collect = async (entries: AsyncIterable<RetrievalEntry>) => {
          check(signal);
          sourceCount++;
          let sourceBytes = 0;
          let title = "";
          let titleBytes = 0;
          let batch: RetrievalEntry[] = [];
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
          for await (const entry of entries) {
            check(signal);
            if (entry.title !== title) {
              title = entry.title;
              titleBytes = encoder.encode(title).length;
            }
            const bytes = titleBytes + encoder.encode(entry.body).length;
            if (sourceBytes + bytes > MAX_SOURCE_FTS_BYTES)
              throw new RetrievalIndexError("index-limit");
            if (
              batch.length &&
              (batch.length >= BATCH ||
                batchBytes + bytes > MAX_SPOOL_BATCH_BYTES)
            )
              await flush();
            sourceBytes += bytes;
            batch.push(entry);
            batchBytes += bytes;
          }
          await flush();
          if (progress && performance.now() - progressAt >= 250) {
            if (sourceCount > total)
              throw new RetrievalStorageError("index-stale");
            await progress({ done: sourceCount, total });
            progressAt = performance.now();
          }
        };
        try {
          let after: string | null = null;
          while (true) {
            check(signal);
            const page = await store.metadataPage(after, PAGE);
            for (const source of page) {
              check(signal);
              const metadata = await this.verifiedMetadata(source);
              const title = ftsIndexText(metadata.title ?? "");
              const body = metadataIndexBody(metadata);
              await collect(
                (async function* () {
                  for await (const chunk of chunks(body, signal))
                    yield {
                      kind: "metadata",
                      literature_id: source.literature_id,
                      meta_literature_id: source.meta_literature_id,
                      metadata_revision: source.metadata_revision,
                      metadata_sha256: source.metadata_sha256,
                      document_version_id: null,
                      representation_sha256: null,
                      source_asset_id: null,
                      source_asset_sha256: null,
                      unit_start_utf8: null,
                      unit_end_utf8: null,
                      unit_sha256: null,
                      section_id: null,
                      unit_ordinal: 0,
                      is_default: 1,
                      title,
                      body: ftsIndexText(chunk),
                    };
                })(),
              );
            }
            if (page.length < PAGE) break;
            after = page.at(-1)!.literature_id;
            await yieldToEventLoop();
          }
          after = null;
          while (true) {
            check(signal);
            const page = await store.documentPage(after, PAGE);
            for (const source of page) {
              check(signal);
              await this.verifiedMetadata(source);
              if (
                !source.document_version_id ||
                !source.representation_sha256 ||
                !source.source_asset_id ||
                !source.source_asset_sha256
              )
                throw new RetrievalIndexError("index-source-invalid");
              let indexingFailure: unknown;
              let failedDuringIndexing = false;
              try {
                await this.documents.withVerifiedTextVersion(
                  source.document_version_id,
                  async (version, markdown, structure) => {
                    try {
                      await collect(
                        this.versionEntries(
                          source,
                          version,
                          markdown,
                          structure,
                          signal,
                        ),
                      );
                    } catch (error) {
                      failedDuringIndexing = true;
                      indexingFailure = error;
                      throw error;
                    }
                  },
                  signal,
                );
              } catch (error) {
                if (failedDuringIndexing) throw indexingFailure;
                check(signal);
                throw error;
              }
            }
            if (page.length < PAGE) break;
            after = page.at(-1)!.document_version_id!;
            await yieldToEventLoop();
          }
        } finally {
          await spool.close();
        }
        check(signal);
        if (progress) {
          if (sourceCount !== total)
            throw new RetrievalStorageError("index-stale");
          await progress({ done: sourceCount, total });
        }
        const generation = await store.beginGeneration(revision, signal);
        const input = createReadStream(spoolPath);
        const reader = createInterface({
          input,
          crlfDelay: Infinity,
        });
        try {
          // Spool lines follow source boundaries, often one metadata entry
          // each. Coalesce them so durability does not cost one transaction
          // per literature, while keeping memory and cancellation bounded.
          let entries: RetrievalEntry[] = [];
          let bytes = 0;
          let sources = 0;
          const flush = async () => {
            if (!entries.length && !sources) return;
            check(signal);
            await store.insertEntries(generation, entries, sources, signal);
            entries = [];
            bytes = 0;
            sources = 0;
            await yieldToEventLoop();
          };
          for await (const line of reader) {
            check(signal);
            const batch = JSON.parse(line) as {
              entries: RetrievalEntry[];
              source_count: number;
            };
            const batchBytes = batch.entries.reduce(
              (sum, entry) =>
                sum +
                encoder.encode(entry.title).length +
                encoder.encode(entry.body).length,
              0,
            );
            if (
              entries.length + batch.entries.length > BATCH ||
              bytes + batchBytes > MAX_SPOOL_BATCH_BYTES ||
              sources + batch.source_count > BATCH
            )
              await flush();
            entries.push(...batch.entries);
            bytes += batchBytes;
            sources += batch.source_count;
          }
          await flush();
        } finally {
          reader.close();
          input.destroy();
        }
        check(signal);
        const published = await store.publish(generation, revision, signal);
        // The active switch is durable. Cancellation during reclamation keeps
        // that publication and leaves the remaining retired rows for refresh.
        await this.pruneRetired(combined);
        await this.pruneChanges(combined);
        return published;
      } catch (error) {
        // The spool uses the filesystem's actual space and quota. A size
        // estimate cannot reserve either while other processes are writing.
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOSPC" ||
            error.code === "EDQUOT" ||
            error.code === "EFBIG")
        )
          throw new RetrievalIndexError("index-storage-full", { cause: error });
        if (
          error instanceof RetrievalIndexError &&
          error.code === "index-source-invalid" &&
          revision !== null &&
          (await store.revision()) !== revision
        )
          throw new RetrievalStorageError("index-stale");
        throw error;
      } finally {
        if (spoolRoot) await rm(spoolRoot, { recursive: true, force: true });
      }
    }, combined);
    this.active.set(pending, controller);
    void pending
      .finally(() => this.active.delete(pending))
      .catch(() => undefined);
    return pending;
  }

  /** A version's original units, then its stored translation's units. */
  private async *versionEntries(
    source: RetrievalSource,
    version: DocumentRef,
    markdown: Uint8Array,
    structure: VerifiedDocumentStructure,
    signal?: AbortSignal,
  ): AsyncGenerator<RetrievalEntry> {
    yield* this.documentEntries(
      source,
      version.representation_sha256,
      markdown,
      structure,
      signal,
    );
    yield* this.translationEntries(
      source,
      version,
      markdown,
      structure,
      signal,
    );
  }
  /**
   * One entry (in chunks) per translated unit of the primary PDF's default
   * version, in the configured language: the original unit's range, section
   * and ordinal, so a hit leads back to the original (spec 9.7). Exactly the
   * versions the catalog's translation stamps name.
   */
  private async *translationEntries(
    source: RetrievalSource,
    version: DocumentRef,
    markdown: Uint8Array,
    structure: VerifiedDocumentStructure,
    signal?: AbortSignal,
  ): AsyncGenerator<RetrievalEntry> {
    if (
      !this.translations ||
      source.is_default !== 1 ||
      version.schema_version !== 2 ||
      version.source_material_ref.asset_id !== source.primary_asset_id
    )
      return;
    const found = await currentDocumentTranslation(
      this.translations.store,
      this.translations.annotations,
      version,
      this.translations.store.language,
      signal,
    ).catch((error: unknown) => {
      throw new RetrievalIndexError("index-source-invalid", { cause: error });
    });
    if (!found || found.row.translated_count === 0) return;
    const segments = new Map(
      structure.segments.map((segment, ordinal) => [
        segment.segment_id,
        { segment, ordinal },
      ]),
    );
    const sectionTitle = new Map(
      structure.sections.map((s) => [s.section_id, s.title]),
    );
    for (const unit of found.file.units) {
      check(signal);
      if (unit.translation === null) continue;
      const parts = unit.segment_ids.map((id) => segments.get(id));
      if (parts.some((p) => !p))
        throw new RetrievalIndexError("index-source-invalid");
      const first = parts[0]!;
      const span = unitSpan(
        markdown,
        parts.map((p) => p!.segment),
        unit.source_sha256,
      );
      if (!span) throw new RetrievalIndexError("index-source-invalid");
      const section = first.segment.section_id ?? null;
      const title = section
        ? ftsIndexText(sectionTitle.get(section) ?? "")
        : "";
      const unitSha256 = digest(markdown.subarray(span.start, span.end));
      for await (const chunk of chunks(unit.translation, signal))
        yield {
          kind: "document",
          literature_id: source.literature_id,
          meta_literature_id: source.meta_literature_id,
          metadata_revision: source.metadata_revision,
          metadata_sha256: source.metadata_sha256,
          document_version_id: source.document_version_id!,
          representation_sha256: version.representation_sha256,
          source_asset_id: source.source_asset_id!,
          source_asset_sha256: source.source_asset_sha256!,
          unit_start_utf8: span.start,
          unit_end_utf8: span.end,
          unit_sha256: unitSha256,
          section_id: section,
          unit_ordinal: first.ordinal,
          is_default: 1,
          title,
          body: ftsIndexText(chunk),
          translation_language: found.row.target_language,
          translation_sha256: found.row.sha256,
        };
    }
  }
  private async *documentEntries(
    source: RetrievalSource,
    representation: string,
    markdown: Uint8Array,
    structure: VerifiedDocumentStructure,
    signal?: AbortSignal,
  ): AsyncGenerator<RetrievalEntry> {
    if (representation !== source.representation_sha256)
      throw new RetrievalIndexError("index-source-invalid");
    const sectionTitle = new Map(
      structure.sections.map((s) => [s.section_id, s.title]),
    );
    const normalizedTitles = new Map<string, string>();
    for await (const unit of contextUnits(markdown, structure, signal)) {
      check(signal);
      const bytes = markdown.subarray(unit.start, unit.end);
      const text = decoder.decode(bytes);
      let title = "";
      if (unit.section_id) {
        const cached = normalizedTitles.get(unit.section_id);
        if (cached !== undefined) title = cached;
        else {
          await yieldToEventLoop();
          check(signal);
          title = ftsIndexText(sectionTitle.get(unit.section_id) ?? "");
          normalizedTitles.set(unit.section_id, title);
        }
      }
      const unitSha256 = digest(bytes);
      for await (const chunk of chunks(text, signal)) {
        check(signal);
        yield {
          kind: "document",
          literature_id: source.literature_id,
          meta_literature_id: source.meta_literature_id,
          metadata_revision: source.metadata_revision,
          metadata_sha256: source.metadata_sha256,
          document_version_id: source.document_version_id!,
          representation_sha256: representation,
          source_asset_id: source.source_asset_id!,
          source_asset_sha256: source.source_asset_sha256!,
          unit_start_utf8: unit.start,
          unit_end_utf8: unit.end,
          unit_sha256: unitSha256,
          section_id: unit.section_id,
          unit_ordinal: unit.ordinal,
          is_default: source.is_default === 1 ? 1 : 0,
          title,
          body: ftsIndexText(chunk),
        };
      }
    }
  }
}
