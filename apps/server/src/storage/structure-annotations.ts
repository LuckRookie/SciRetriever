import {
  canonicalJsonBytes,
  sha256,
  parseArtifactRef,
  verifyStructureAnnotation,
  type StructureAnnotation,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "./sqlite/worker.js";
import type { FileStore } from "./files/store.js";
import type {
  AnnotationState,
  AnnotationPublication,
} from "./sqlite/structure-annotation-engine.js";
import { artifactReference } from "./artifact-layout.js";
const MAX_BYTES = 32 * 1024 * 1024;
export class SqliteAnnotationStorage {
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
  ) {}
  state(id: string, signal?: AbortSignal) {
    return this.database.annotation<AnnotationState>("state", id, signal);
  }
  private async read(
    row: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<StructureAnnotation | null> {
    if (!row) return null;
    const artifact = parseArtifactRef({
      sha256: row.manifest_sha256,
      byte_size: row.manifest_size,
      media_type: row.manifest_media_type,
    });
    if (typeof row.manifest_reference !== "string")
      throw new Error("annotation-integrity");
    return this.files.withVerified(
      row.manifest_reference,
      artifact,
      async (chunks) => {
        const parts: Uint8Array[] = [];
        for await (const part of chunks) parts.push(part);
        const a = await verifyStructureAnnotation(
          JSON.parse(
            new TextDecoder("utf8", { fatal: true }).decode(
              Buffer.concat(parts),
            ),
          ),
        );
        if (
          a.annotation_id !== row.annotation_id ||
          a.document_version_id !== row.document_version_id ||
          a.manual_revision !== row.manual_revision ||
          (await sha256(canonicalJsonBytes(a.method))) !== row.method_sha256
        )
          throw new Error("annotation-integrity");
        return a;
      },
      { maxBytes: MAX_BYTES, ...(signal ? { signal } : {}) },
    );
  }
  async byId(id: string, signal?: AbortSignal) {
    return this.read(
      await this.database.annotation<Record<string, unknown> | null>(
        "get",
        id,
        signal,
      ),
      signal,
    );
  }
  async find(
    document: string,
    method: string,
    revision: number,
    signal?: AbortSignal,
  ) {
    return this.read(
      await this.database.annotation<Record<string, unknown> | null>(
        "find",
        {
          document_version_id: document,
          method_sha256: method,
          manual_revision: revision,
        },
        signal,
      ),
      signal,
    );
  }
  async current(document: string, signal?: AbortSignal) {
    const state = await this.state(document, signal);
    return state.current
      ? this.byId(state.current.annotation_id, signal)
      : null;
  }
  async publish(
    value: StructureAnnotation,
    expected: Omit<
      AnnotationPublication,
      "annotation" | "method_sha256" | "manifest"
    >,
    signal?: AbortSignal,
  ) {
    const annotation = await verifyStructureAnnotation(value),
      bytes = canonicalJsonBytes(annotation);
    if (bytes.length > MAX_BYTES) throw new Error("annotation-output-limit");
    const artifact = {
      sha256: await sha256(bytes),
      byte_size: bytes.length,
      media_type: "application/json",
    };
    return this.files.withWrite(async () => {
      if (signal?.aborted) throw new Error("annotation-cancelled");
      const reference =
        (await this.database.locateArtifact(artifact))?.reference ??
        artifactReference("structure-annotation", artifact);
      const stage = await this.files.stage({
        maxBytes: Math.max(1, bytes.length),
      });
      try {
        await stage.write(bytes);
        await this.files.publish(stage, reference);
      } finally {
        await stage.discard();
      }
      return this.database.annotation<{
        annotation_id: string;
        published: boolean;
        revision: number;
        manual_revision: number;
      }>(
        "publish",
        {
          annotation,
          method_sha256: await sha256(canonicalJsonBytes(annotation.method)),
          manifest: { ...artifact, reference },
          ...expected,
        },
        signal,
      );
    });
  }
}
