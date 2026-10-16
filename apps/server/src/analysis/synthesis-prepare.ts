import {
  ContractValidationError,
  createSynthesisInputManifest,
  parseSynthesisSelections,
  type SynthesisSelection,
  type SynthesisInputItem,
  type SynthesisInputManifest,
  type SynthesisPolicy,
  type InputManifestItem,
} from "@sciretriever/contracts";
import {
  DocumentReadError,
  type DocumentReadService,
} from "../document/read.js";
import type { LiteratureQueryService } from "../literature/query.js";
import {
  SynthesisReadError,
  type SqliteSynthesisStorage,
  type SynthesisReadSession,
} from "../storage/synthesis.js";

export class SynthesisPreparationError extends Error {
  constructor(
    readonly code:
      | "synthesis-invalid"
      | "synthesis-stale-binding"
      | "synthesis-integrity"
      | "synthesis-cancelled"
      | "synthesis-closed"
      | "synthesis-limit",
    options?: ErrorOptions,
  ) {
    super("synthesis preparation failed", options);
  }
}
function fail(code: SynthesisPreparationError["code"]): never {
  throw new SynthesisPreparationError(code);
}
export interface SynthesisPreparation {
  readonly manifest: SynthesisInputManifest;
  readonly policy: SynthesisPolicy;
  readonly ready: boolean;
  readonly gaps: readonly {
    readonly input_id: string;
    readonly code: string;
  }[];
}
/** Read-only preparation fixes ordered selectors before any model work. */
export class SynthesisPreparationService {
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly documents: DocumentReadService,
    private readonly literature: LiteratureQueryService,
    private readonly knowledge: SqliteSynthesisStorage,
  ) {}
  close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      this.closing = Promise.allSettled([...this.active]).then(() => undefined);
    }
    return this.closing;
  }
  async prepare(
    value: unknown,
    signal?: AbortSignal,
    maxVerificationBytes = Number.MAX_SAFE_INTEGER,
  ): Promise<SynthesisPreparation> {
    if (this.stopped) fail("synthesis-closed");
    if (signal?.aborted) fail("synthesis-cancelled");
    let fixed: {
      policy: SynthesisPolicy;
      selections: readonly SynthesisSelection[];
    };
    try {
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail("synthesis-invalid");
      const r = value as Record<string, unknown>;
      if (
        Object.keys(r).sort().join("\0") !==
          ["inputs", "policy"].sort().join("\0") ||
        !["require-all", "allow-partial"].includes(r.policy as string)
      )
        fail("synthesis-invalid");
      fixed = {
        policy: r.policy as SynthesisPolicy,
        selections: parseSynthesisSelections(r.inputs),
      };
    } catch (error) {
      if (error instanceof SynthesisPreparationError) throw error;
      throw new SynthesisPreparationError("synthesis-invalid", {
        cause: error,
      });
    }
    const pending = this.knowledge.withReadSession(
      (session) => this.prepareInner(fixed, session, signal),
      maxVerificationBytes,
      signal,
    );
    this.active.add(pending);
    try {
      return await pending;
    } catch (error) {
      if (error instanceof SynthesisPreparationError) throw error;
      if (
        signal?.aborted ||
        (error instanceof DocumentReadError &&
          error.code === "document-cancelled") ||
        (error instanceof SynthesisReadError &&
          error.code === "synthesis-cancelled")
      )
        throw new SynthesisPreparationError("synthesis-cancelled", {
          cause: error,
        });
      if (
        (error instanceof DocumentReadError &&
          error.code === "document-closed") ||
        (error instanceof SynthesisReadError &&
          error.code === "synthesis-closed")
      )
        throw new SynthesisPreparationError("synthesis-closed", {
          cause: error,
        });
      if (
        error instanceof SynthesisReadError &&
        error.code === "synthesis-limit"
      )
        throw new SynthesisPreparationError("synthesis-limit", {
          cause: error,
        });
      if (
        error instanceof ContractValidationError ||
        (error instanceof SynthesisReadError &&
          error.code === "synthesis-invalid")
      )
        throw new SynthesisPreparationError("synthesis-invalid", {
          cause: error,
        });
      throw new SynthesisPreparationError("synthesis-integrity", {
        cause: error,
      });
    } finally {
      this.active.delete(pending);
    }
  }
  private async prepareInner(
    fixed: {
      policy: SynthesisPolicy;
      selections: readonly SynthesisSelection[];
    },
    session: SynthesisReadSession,
    signal?: AbortSignal,
  ): Promise<SynthesisPreparation> {
    const { policy, selections } = fixed;
    const items: SynthesisInputItem[] = [];
    const gaps: { input_id: string; code: string }[] = [];
    let usable = 0;
    for (const selection of selections) {
      if (signal?.aborted) fail("synthesis-cancelled");
      if (selection.kind === "knowledge") {
        const source = await session.sourceById(selection.source_artifact_id);
        if (!source) {
          items.push({
            kind: "knowledge",
            input_id: selection.input_id,
            source_artifact_id: selection.source_artifact_id,
            source_content_sha256: null,
            source_manifest_sha256: null,
            compression_depth: null,
            state: "missing",
          });
          gaps.push({
            input_id: selection.input_id,
            code: "knowledge-missing",
          });
        } else {
          items.push({
            kind: "knowledge",
            input_id: selection.input_id,
            source_artifact_id: selection.source_artifact_id,
            source_content_sha256: source.artifact.content_ref.sha256,
            source_manifest_sha256: source.artifact.input.manifest_sha256,
            compression_depth:
              source.artifact.schema_version === 1
                ? 1
                : source.artifact.compression_depth,
            state: source.state,
          });
          usable++;
          if (source.state === "source-only")
            gaps.push({
              input_id: selection.input_id,
              code: "original-unavailable",
            });
        }
        continue;
      }
      if (selection.asset_id === null) {
        const detail = await this.literature.detail(selection.literature_id);
        if (!detail) fail("synthesis-stale-binding");
        if (
          detail.primary_pdf ||
          detail.additional_assets.some(
            (item) => item.asset.media_type === "application/pdf",
          )
        )
          fail("synthesis-stale-binding");
        items.push({
          kind: "document",
          input_id: selection.input_id,
          literature_id: selection.literature_id,
          material: null,
          document: null,
          capabilities: [],
          gaps: ["material-missing", "document-missing"],
        });
        gaps.push({ input_id: selection.input_id, code: "material-missing" });
        continue;
      }
      const material = await session.materialById(
        selection.literature_id,
        selection.asset_id,
      );
      if (!material || material.asset_sha256 !== selection.asset_sha256)
        fail("synthesis-stale-binding");
      let versionId = selection.document_version_id;
      if (versionId === null) {
        const current = await this.documents.default(
          {
            literature_id: selection.literature_id,
            asset_id: selection.asset_id,
            asset_sha256: selection.asset_sha256!,
          },
          signal,
        );
        versionId = current.default?.document_version_id ?? null;
      }
      let document = null;
      const capabilities: InputManifestItem["capabilities"][number][] = [
        "material-file-v1",
      ];
      const documentGaps: ("document-missing" | "document-unsupported")[] = [];
      if (versionId !== null) {
        try {
          const verified = await session.documentById(versionId);
          if (verified?.state === "source-only") fail("synthesis-integrity");
          if (
            !verified ||
            verified.literature_id !== selection.literature_id ||
            verified.asset_id !== selection.asset_id ||
            verified.asset_sha256 !== selection.asset_sha256 ||
            verified.reading.document_version_id !== versionId ||
            JSON.stringify(verified.reading.source_material_ref) !==
              JSON.stringify(material)
          )
            fail("synthesis-stale-binding");
          document = verified.reading;
          capabilities.push("document-segment-v1");
          capabilities.push("document-text-v1");
          capabilities.push("document-outline-v1");
          capabilities.push("document-resources-v1");
        } catch (error) {
          if (error instanceof SynthesisPreparationError) throw error;
          if (error instanceof SynthesisReadError) throw error;
          if (
            error instanceof DocumentReadError &&
            ["document-cancelled", "document-closed"].includes(error.code)
          )
            throw error;
          if (
            error instanceof DocumentReadError &&
            ["document-missing", "document-unsupported"].includes(error.code)
          )
            fail("synthesis-stale-binding");
          else
            throw new SynthesisPreparationError("synthesis-integrity", {
              cause: error,
            });
        }
      } else {
        try {
          await session.verifyMaterial(material);
        } catch (error) {
          if (error instanceof SynthesisReadError) throw error;
          if (
            error instanceof DocumentReadError &&
            ["document-cancelled", "document-closed"].includes(error.code)
          )
            throw error;
          throw new SynthesisPreparationError("synthesis-integrity", {
            cause: error,
          });
        }
        documentGaps.push("document-missing");
      }
      if (documentGaps.length)
        gaps.push({ input_id: selection.input_id, code: documentGaps[0]! });
      else usable++;
      items.push({
        kind: "document",
        input_id: selection.input_id,
        literature_id: selection.literature_id,
        material,
        document,
        capabilities,
        gaps: documentGaps,
      });
    }
    if (signal?.aborted) fail("synthesis-cancelled");
    const manifest = await createSynthesisInputManifest(items);
    return Object.freeze({
      manifest,
      policy,
      ready: policy === "require-all" ? gaps.length === 0 : usable > 0,
      gaps: Object.freeze(gaps),
    });
  }
}
