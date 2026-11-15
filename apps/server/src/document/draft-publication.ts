import { isDeepStrictEqual } from "node:util";
import type {
  DraftOutcome,
  RawParse,
  ArtifactRef,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { FileStore } from "../storage/files/store.js";
import type { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import type { PdfPages } from "../proofread/contract.js";
import { artifactReference } from "../storage/artifact-layout.js";
import { createLogger } from "../logging/index.js";
import { SqliteDocumentStorage } from "./storage.js";
import { buildDraftDocument, DraftBuildError } from "./draft-builder.js";

export interface DraftPublicationRequest {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly raw: RawParse;
}
/** Raw facts have already committed. Failure here never changes their outcome. */
export class DraftPublicationService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<DraftOutcome>>();
  private readonly queues = new Map<string, Promise<void>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly raw: Pick<SqliteRawParseStorage, "loadSource">,
    private readonly pages: Pick<PdfPages, "inspect"> | null,
    private readonly scheduleIndex: () => Promise<unknown>,
  ) {}
  publish(
    value: DraftPublicationRequest,
    signal?: AbortSignal,
  ): Promise<DraftOutcome> {
    const input = structuredClone(value);
    const combined = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const previous = this.queues.get(input.asset_id) ?? Promise.resolve();
    const work = previous.then(() => this.perform(input, combined));
    const settled = work.then(
      () => {},
      () => {},
    );
    this.queues.set(input.asset_id, settled);
    this.active.add(work);
    void settled.then(() => {
      this.active.delete(work);
      if (this.queues.get(input.asset_id) === settled)
        this.queues.delete(input.asset_id);
    });
    return work;
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
  private async perform(
    input: DraftPublicationRequest,
    signal: AbortSignal,
  ): Promise<DraftOutcome> {
    let stage: "source" | "pages" | "build" | "publication" = "source";
    const raw_parse_id = input.raw.raw_parse_id;
    try {
      signal.throwIfAborted();
      const material = await this.database.documentMaterial(
        input.literature_id,
        input.asset_id,
      );
      if (!material || material.material.asset_sha256 !== input.asset_sha256)
        throw new DraftBuildError("source-integrity");
      const loaded = await this.raw.loadSource(raw_parse_id, signal);
      if (
        !isDeepStrictEqual(loaded.result, input.raw) ||
        loaded.result.source_asset_id !== input.asset_id ||
        loaded.result.source_sha256 !== input.asset_sha256
      )
        throw new DraftBuildError("source-integrity");
      const storage = new SqliteDocumentStorage(this.database, this.files);
      await storage.withVerifiedArtifact(
        material.path,
        material.material.artifact,
        async (chunks) => {
          for await (const chunk of chunks) {
            void chunk;
            signal.throwIfAborted();
          }
        },
        signal,
      );
      stage = "pages";
      if (!this.pages) throw new DraftBuildError("page-tools-unavailable");
      const pages = await this.pages.inspect(
        input.asset_id,
        input.asset_sha256,
        signal,
      );
      stage = "build";
      const built = await buildDraftDocument(
        input.raw,
        {
          async readArtifact(id, kind, reference) {
            signal.throwIfAborted();
            if (id !== raw_parse_id)
              throw new DraftBuildError("source-integrity");
            if (kind === "blocks" && loaded.blocks) return loaded.blocks.bytes;
            if (kind === "markdown") return loaded.markdown.bytes;
            const resource = loaded.resources.find(
              (r) => r.reference === reference,
            );
            if (kind === "image" && resource) return resource.content.bytes;
            throw new DraftBuildError("source-integrity");
          },
        },
        pages,
        material.material,
        { signal },
      );
      stage = "publication";
      const result = await this.files.withWrite(async () => {
        signal.throwIfAborted();
        const put = async (
          kind: Parameters<typeof artifactReference>[0],
          bytes: Uint8Array,
          artifact: ArtifactRef,
        ) => {
          const path =
            (await this.database.locateArtifact(artifact))?.reference ??
            artifactReference(kind, artifact);
          await storage.publishImmutableArtifact(path, bytes, artifact);
          return path;
        };
        const draft_content_artifact_path = await put(
          "draft-content",
          built.content_bytes,
          built.document.draft_content,
        );
        const markdown_artifact_path = await put(
          "draft-markdown",
          built.markdown,
          built.document.markdown,
        );
        const structure_artifact_path = await put(
          "document-structure",
          built.structure_bytes,
          built.document.structure,
        );
        const resource_artifact_paths: Record<string, string> = {};
        for (const resource of built.document.resources) {
          const located = await this.database.locateArtifact(resource.artifact);
          if (!located) throw new DraftBuildError("source-integrity");
          resource_artifact_paths[resource.reference] = located.reference;
        }
        const current = await this.database.draftCurrent(input.asset_id);
        const priorDefault = await this.database.documentDefault(
          input.literature_id,
          input.asset_id,
          input.asset_sha256,
        );
        return storage.commitDraftVersion(
          {
            version: built.document,
            source_artifact_path: material.path,
            draft_content_artifact_path,
            markdown_artifact_path,
            structure_artifact_path,
            resource_artifact_paths,
            expected_current_revision: current?.revision ?? null,
            expected_default_revision: priorDefault?.revision ?? null,
          },
          signal,
        );
      }, signal);
      if (result.index_refresh_required) {
        try {
          await this.scheduleIndex();
        } catch {
          createLogger("document-draft").warn(
            "Draft committed but index refresh could not be scheduled",
          );
        }
      }
      // A posted transaction is settled even when cancellation arrives after admission.
      return {
        status: result.published ? "formed" : "reused",
        raw_parse_id,
        document_version_id: built.document.document_version_id,
        representation_sha256: built.document.representation_sha256,
        default_changed: result.default_changed,
        default_text_level: result.default_text_level,
      };
    } catch (error) {
      return {
        status: "failed",
        raw_parse_id,
        failure_code: signal.aborted
          ? "cancelled"
          : error instanceof DraftBuildError
            ? error.code
            : stage === "pages"
              ? "page-tools-unavailable"
              : stage === "source" || stage === "build"
                ? "source-integrity"
                : "draft-publication",
      };
    }
  }
}
