import {
  createInputManifest,
  parseExtractionPreparationRequest,
  parseExtractionPreparationResult,
  requiredPreparationCapabilities,
  type InputManifestItem,
  type ExtractionPreparationResult,
  type TextLevel,
} from "@sciretriever/contracts";
import {
  DocumentReadError,
  type DocumentReadService,
} from "../document/read.js";
import type { LiteratureQueryService } from "../literature/query.js";
import { validateExtractionSpec } from "./spec.js";

export class ExtractionPreparationError extends Error {
  constructor(
    readonly code:
      | "invalid-request"
      | "input-not-ready"
      | "input-missing"
      | "input-integrity"
      | "input-unsupported"
      | "stale-binding"
      | "preparation-cancelled",
    options?: ErrorOptions,
  ) {
    super("extraction input preparation refused", options);
  }
}
export type ExtractionPreparation = ExtractionPreparationResult;
function check(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ExtractionPreparationError("preparation-cancelled");
}
/** Read-only, explicit binding. No parser, provider, model, or catalog writer is reachable here. */
export class ExtractionPreparationService {
  private closed = false;
  private readonly stopping = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly documents: DocumentReadService,
    private readonly literature: Pick<LiteratureQueryService, "detail">,
  ) {}
  async prepare(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ExtractionPreparation> {
    if (this.closed)
      throw new ExtractionPreparationError("preparation-cancelled");
    const combined = signal
      ? AbortSignal.any([signal, this.stopping.signal])
      : this.stopping.signal;
    const work = this.prepareInner(value, combined);
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  private async prepareInner(
    value: unknown,
    signal: AbortSignal,
  ): Promise<ExtractionPreparation> {
    // Parse and copy the entire request before the first await. Later caller mutation
    // cannot change the specification or input order being validated.
    const request = await parseExtractionPreparationRequest(value);
    check(signal);
    const selections = request.inputs;
    const spec = await validateExtractionSpec(request.spec, signal);
    check(signal);
    const items: InputManifestItem[] = [];
    for (const selection of selections) {
      check(signal);
      const literatureId = selection.literature_id;
      const detail = await this.literature.detail(literatureId);
      if (selection.asset_id === null)
        throw new ExtractionPreparationError(
          detail.literature.status === "READY"
            ? "input-missing"
            : "input-not-ready",
        );
      let material;
      try {
        const result = await this.documents.materialEvidence(
          {
            literature_id: literatureId,
            asset_id: selection.asset_id,
          },
          signal,
        );
        if (result.evidence.target_kind !== "material")
          throw new ExtractionPreparationError("stale-binding");
        material = result.evidence.material;
      } catch (error) {
        check(signal);
        if (error instanceof ExtractionPreparationError) throw error;
        if (error instanceof DocumentReadError) {
          const code =
            error.code === "material-missing"
              ? "input-missing"
              : error.code === "document-unsupported"
                ? "input-unsupported"
                : "input-integrity";
          throw new ExtractionPreparationError(code, { cause: error });
        }
        throw error;
      }
      if (material.asset_sha256 !== selection.asset_sha256)
        throw new ExtractionPreparationError("stale-binding");
      const capabilities: InputManifestItem["capabilities"][number][] = [
        "material-file-v1",
      ];
      const gaps: InputManifestItem["gaps"][number][] = [];
      let versionId = selection.document_version_id;
      if (versionId === null) {
        try {
          const current = await this.documents.default(
            {
              literature_id: literatureId,
              asset_id: selection.asset_id,
              asset_sha256: selection.asset_sha256,
            },
            signal,
          );
          versionId = current.default?.document_version_id ?? null;
        } catch (error) {
          check(signal);
          if (error instanceof DocumentReadError) {
            throw new ExtractionPreparationError(
              error.code === "document-unsupported"
                ? "input-unsupported"
                : "input-integrity",
              { cause: error },
            );
          } else throw error;
        }
      }
      let document = null;
      let textLevel: TextLevel | undefined;
      if (versionId !== null) {
        try {
          const result = await this.documents.describe(
            { document_version_id: versionId },
            signal,
          );
          if (
            JSON.stringify(result.document.source_material_ref) !==
            JSON.stringify(material)
          )
            throw new ExtractionPreparationError("stale-binding");
          textLevel = await this.documents.withVerifiedTextVersion(
            versionId,
            async (version) =>
              version.schema_version === 3 ? "draft" : "proofread",
            signal,
          );
          document = result.document;
          capabilities.push("document-segment-v1");
          if (result.capabilities.text) capabilities.push("document-text-v1");
          if (result.capabilities.outline)
            capabilities.push("document-outline-v1");
          if (result.capabilities.resources)
            capabilities.push("document-resources-v1");
        } catch (error) {
          if (error instanceof ExtractionPreparationError) throw error;
          check(signal);
          if (
            error instanceof DocumentReadError &&
            error.code === "document-unsupported"
          ) {
            if (selection.document_version_id !== null)
              throw new ExtractionPreparationError("input-unsupported", {
                cause: error,
              });
            gaps.push("document-unsupported");
          } else if (
            error instanceof DocumentReadError &&
            error.code === "document-missing" &&
            selection.document_version_id !== null
          ) {
            throw new ExtractionPreparationError("stale-binding", {
              cause: error,
            });
          } else if (error instanceof DocumentReadError) {
            throw new ExtractionPreparationError("input-integrity", {
              cause: error,
            });
          } else throw error;
        }
      } else gaps.push("document-missing");
      // A readable draft is an explicit preparation input even before archive
      // readiness. Other not-ready inputs retain the existing refusal.
      if (detail.literature.status !== "READY" && textLevel !== "draft")
        throw new ExtractionPreparationError("input-not-ready");
      items.push({
        input_id: selection.input_id,
        literature_id: literatureId,
        material,
        document,
        ...(textLevel ? { text_level: textLevel } : {}),
        capabilities,
        gaps,
      });
    }
    check(signal);
    const manifest = await createInputManifest(items);
    check(signal);
    const required = requiredPreparationCapabilities(spec);
    const missing = manifest.items
      .map((item) => ({
        input_id: item.input_id,
        capabilities: required.filter(
          (capability) => !item.capabilities.includes(capability),
        ),
      }))
      .filter((item) => item.capabilities.length > 0);
    const result = await parseExtractionPreparationResult(
      {
        schema_version: 1,
        spec,
        manifest,
        missing_required_capabilities: missing,
        persistence: "requires-catalog-v5",
      },
      request,
    );
    check(signal);
    return result;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.stopping.abort();
      this.closing = Promise.allSettled([...this.active]).then(() => undefined);
    }
    return this.closing;
  }
}
