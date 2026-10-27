import {
  annotationRecord,
  parseSourceSpan,
  parseAssetId,
  archiveText,
  parseArtifactRef,
  canonicalJsonBytes,
  archiveProofreadHash,
  parseArchiveTextBundleV2,
  parseProofreadVersionV2,
  type ProofreadVersionV2,
  type ArrangementSnapshot,
  type PageProofreadRecord,
  type ArchiveModelUsage,
  type ArchiveTextStop,
} from "@sciretriever/contracts";
import type { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import { SqliteProofreadStorage } from "../storage/proofread.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import { SqliteDocumentStorage } from "../document/storage.js";
import { documentRepresentationHash } from "../document/contract.js";
import type { PdfPages } from "../proofread/contract.js";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import { ArchivePageProofreadService } from "../proofread/page-service.js";
import {
  applyLeafCorrections,
  LEAF_CORRECTION_METHOD,
  RETAINED_SUSPECT_METHOD,
} from "../proofread/leaf-corrections.js";
import { ArchiveArrangementService } from "./arrangement-service.js";
import { ARRANGEMENT_METHOD } from "./arrangement.js";
import {
  prepareArrangementSource,
  byteHash,
  textHash,
  textId,
  ArchiveTextError,
  type ArchiveTextSource,
} from "./text-source.js";
import {
  emptyArchiveUsage,
  archiveTextModelIdentity,
  archiveUsageFailure,
} from "./text-session.js";
import {
  renderArrangement,
  arrangementAnnotation,
  arrangedStructureSatisfied,
  ARRANGED_DOCUMENT_BUILDER,
} from "./render.js";

export function archiveStop(
  code: ArchiveTextStop["code"],
  step: ArchiveTextStop["step"],
  page: number | null = null,
): ArchiveTextStop {
  return {
    code,
    step,
    scope: page === null ? "part" : "page",
    page_index: page,
    retryable: true,
    cause_code: null,
    validation: null,
    progress: null,
  };
}
export async function archiveTextVersion(
  source: ArchiveTextSource,
  arrangement: ArrangementSnapshot | null,
  pages: readonly PageProofreadRecord[],
  usage: ArchiveModelUsage,
  method: ProofreadVersionV2["method"],
  manualIds: readonly string[],
  stop: ArchiveTextStop | null,
) {
  const destinations = new Map(
    arrangement?.destinations.map((d) => [d.leaf_id, d.destination]),
  );
  const texts = new Map<string, string>(),
    corrections = new Map<
      string,
      PageProofreadRecord["corrections"][number][]
    >();
  for (const p of pages) {
    const retained =
      arrangement?.leaves.filter(
        (l) =>
          l.page_index === p.page_index &&
          destinations.get(l.leaf_id)?.kind === "assigned",
      ) ?? [];
    const applied = applyLeafCorrections(
      retained,
      p.corrections.map((c) => c.operation),
      p.page_index,
      p.page_input_sha256,
    );
    for (const [id, t] of applied.texts) texts.set(id, t);
    for (const c of p.corrections)
      corrections.set(c.operation.leaf_id, [
        ...(corrections.get(c.operation.leaf_id) ?? []),
        c,
      ]);
  }
  const bundle = parseArchiveTextBundleV2({
    schema_version: 2,
    page_count: source.raw.page_count,
    source_blocks: source.blocks,
    arrangement,
    leaves:
      arrangement?.leaves.map((leaf) => {
        const records = corrections.get(leaf.leaf_id) ?? [];
        return {
          leaf,
          destination: destinations.get(leaf.leaf_id)!,
          corrected_text: texts.get(leaf.leaf_id) ?? leaf.original_text,
          correction_ids: records.map((c) => c.correction_id),
          text_source: records.some((c) => c.source === "manual")
            ? "manual"
            : records.length
              ? "agent"
              : "parser",
          basis: records.some((c) => c.source === "manual")
            ? "manual"
            : source.pages[leaf.page_index]!.kind === "text-layer"
              ? "text-layer"
              : "image-only",
        };
      }) ?? [],
  });
  const bytes = canonicalJsonBytes(bundle),
    body = {
      schema_version: 2 as const,
      part_asset_id: source.raw.source_asset_id,
      part_sha256: source.raw.source_sha256,
      draft_input: {
        profile: source.raw.profile,
        raw_parse_id: source.raw.raw_parse_id,
        result_sha256: source.raw.result_sha256,
      },
      method,
      manual_decision_ids: [...manualIds].sort(),
      status:
        arrangement &&
        pages.every((p) => ["accepted", "not-required"].includes(p.status))
          ? ("complete" as const)
          : stop
            ? ("failed" as const)
            : ("incomplete" as const),
      arrangement_id: arrangement?.arrangement_id ?? null,
      blocks: parseArtifactRef({
        sha256: byteHash(bytes),
        byte_size: bytes.length,
        media_type: "application/json",
      }),
      pages,
      resources: source.raw.resources.filter((r) =>
        bundle.leaves.some(
          (l) =>
            l.destination.kind === "assigned" &&
            (l.leaf.image_ref === r.reference ||
              l.corrected_text.includes(r.reference)),
        ),
      ),
      usage,
      stop,
    };
  const content_sha256 = await archiveProofreadHash(body),
    proofread_id = `${content_sha256.slice(0, 8)}-${content_sha256.slice(8, 12)}-${content_sha256.slice(12, 16)}-${content_sha256.slice(16, 20)}-${content_sha256.slice(20, 32)}`;
  return {
    bundle,
    version: await parseProofreadVersionV2({
      ...body,
      proofread_id,
      content_sha256,
    }),
  };
}
export function pendingArchivePages(
  source: ArchiveTextSource,
  snapshot: ArrangementSnapshot | null,
): PageProofreadRecord[] {
  return source.pages.map((p) => {
    const leaves =
        snapshot?.leaves.filter((l) => l.page_index === p.page) ?? [],
      retained = leaves.filter(
        (l) =>
          snapshot?.destinations.find((d) => d.leaf_id === l.leaf_id)
            ?.destination.kind === "assigned",
      );
    return {
      schema_version: 2,
      page_index: p.page,
      page_kind: p.kind,
      page_input_sha256: textHash([
        "pending",
        source.input_sha256,
        p.page,
        retained,
      ]),
      retained_leaf_ids: retained.map((l) => l.leaf_id),
      evidence: {
        read_leaf_ids: [],
        viewed_full_page: false,
        viewed_regions: [],
      },
      suspects: [],
      dispositions: [],
      corrections: [],
      usage: emptyArchiveUsage(),
      status: retained.length || !snapshot ? "pending" : "not-required",
      no_change: true,
      not_required_reason:
        retained.length || !snapshot
          ? null
          : p.kind === "blank"
            ? "blank"
            : "no-retained-content",
      classified_leaf_ids: leaves
        .filter((l) => !retained.includes(l))
        .map((l) => l.leaf_id),
      stop:
        retained.length || !snapshot
          ? archiveStop("interrupted", "proofread", p.page)
          : null,
    };
  });
}

export class ArchiveTextPipeline {
  constructor(
    readonly storage: SqliteArchiveTextStorage,
    readonly raw: SqliteRawParseStorage,
    readonly pdf: PdfPages,
    readonly runtime: DshAgentRuntime,
    readonly profile: "pipeline" | "vlm-engine",
    readonly refreshIndex: (signal: AbortSignal) => Promise<unknown>,
  ) {}
  async source(asset: string, mode: string, signal?: AbortSignal) {
    const choices = await this.raw.current(asset, signal),
      raw =
        choices.find(
          (r) =>
            r.profile ===
            (mode === "full" ? this.profile : "vlm-engine-markdown-only"),
        )?.result ??
        choices.find((r) => r.profile === "vlm-engine-markdown-only")?.result;
    if (!raw) throw new ArchiveTextError("input-missing");
    return prepareArrangementSource(
      raw,
      this.raw,
      await this.pdf.inspect(asset, raw.source_sha256, signal),
      signal,
    );
  }
  private method(): ProofreadVersionV2["method"] {
    return {
      arrange: ARRANGEMENT_METHOD,
      page_classify: this.pdf.method,
      suspects: RETAINED_SUSPECT_METHOD,
      correction: LEAF_CORRECTION_METHOD,
      model_config_sha256: textHash(archiveTextModelIdentity(this.runtime)),
    };
  }
  async annotate(document: string, arrangement: string, signal?: AbortSignal) {
    const fixed = await this.storage.database.documentVersion(document);
    if (
      !fixed ||
      fixed.version.schema_version !== 2 ||
      fixed.version.builder_version !== ARRANGED_DOCUMENT_BUILDER
    )
      throw new ArchiveTextError("archive-contract-obsolete");
    const output = await this.storage.load(fixed.version.proofread_id, signal);
    if (!output || output.version.arrangement_id !== arrangement)
      throw new ArchiveTextError("input-stale");
    const rendered = renderArrangement(output.bundle, output.version.resources);
    if (
      rendered.sha256 !== fixed.version.structure.sha256 ||
      byteHash(rendered.markdown) !== fixed.version.markdown.sha256
    )
      throw new ArchiveTextError("source-integrity");
    const storage = new SqliteAnnotationStorage(
        this.storage.database,
        this.storage.files,
      ),
      state = await storage.state(document, signal);
    if (!state.part) throw new ArchiveTextError("input-stale");
    const annotation = arrangementAnnotation(
        document,
        state.part,
        output.bundle,
        rendered,
      ),
      receipt = await storage.publish(
        annotation,
        {
          expected_manual_revision: state.manual_revision,
          expected_current_revision: state.current?.revision ?? null,
          edit: null,
        },
        signal,
      );
    return {
      ...receipt,
      structure_satisfied: arrangedStructureSatisfied(
        annotation,
        output.bundle,
      ),
      usage: emptyArchiveUsage(),
      section_count: annotation.sections.length,
      reference_count: annotation.references.length,
    };
  }
  async arrange(asset: string, mode: string, signal?: AbortSignal) {
    const state = await this.storage.decisions(asset, signal),
      source = await this.source(asset, mode, signal),
      old = state.current
        ? await this.storage.load(String(state.current.proofread_id), signal)
        : null;
    if (
      state.items.length &&
      (!old ||
        old.version.draft_input.result_sha256 !== source.raw.result_sha256)
    )
      throw new ArchiveTextError("manual-conflict");
    if (
      old &&
      old.bundle.arrangement &&
      old.version.draft_input.result_sha256 === source.raw.result_sha256 &&
      textHash(old.version.method) === textHash(this.method())
    )
      return {
        proofread_id: old.version.proofread_id,
        arrangement_id: old.version.arrangement_id,
        usage: emptyArchiveUsage(),
        reused: true,
      };
    const cache = new SqliteProofreadStorage(
        this.storage.database,
        this.storage.files,
      ),
      result = await new ArchiveArrangementService(
        this.runtime,
        this.pdf,
        cache,
      ).build(
        source,
        signal,
        old?.bundle.arrangement?.source_input_sha256 === source.input_sha256
          ? old.bundle.arrangement
          : undefined,
        state.items.flatMap((v) => {
          if (
            v &&
            typeof v === "object" &&
            "action" in v &&
            v.action === "leaf-text" &&
            "source_span" in v
          )
            return [parseSourceSpan(v.source_span)];
          return [];
        }),
      );
    try {
      const output = await archiveTextVersion(
        source,
        result.value,
        pendingArchivePages(source, result.value),
        result.usage,
        this.method(),
        old?.version.manual_decision_ids ?? [],
        result.stop,
      );
      await this.storage.publish(
        output.version,
        output.bundle,
        {
          current_revision: state.current
            ? Number(state.current.revision)
            : null,
          manual_revision: state.manual_revision,
        },
        signal?.aborted ? undefined : signal,
      );
      if (!result.value)
        throw Object.assign(
          new ArchiveTextError(result.stop?.code ?? "arrange-failed"),
          {
            output: {
              proofread_id: output.version.proofread_id,
              usage: result.usage,
              stop: result.stop,
            },
          },
        );
      return {
        proofread_id: output.version.proofread_id,
        arrangement_id: result.value.arrangement_id,
        usage: result.usage,
        stats: {
          dropped_count: result.value.destinations.filter(
            (d) => d.destination.kind === "dropped",
          ).length,
          source_blocks: source.blocks.length,
          classified_leaves: result.value.leaves.length,
          break_candidates: result.value.break_candidates.length,
        },
      };
    } catch (error) {
      throw archiveUsageFailure(error, result.usage);
    }
  }
  async proofread(
    asset: string,
    mode: string,
    retry: readonly number[] | null,
    signal?: AbortSignal,
    onPage?: (
      page: PageProofreadRecord,
      reused: boolean,
      usage: ArchiveModelUsage,
    ) => Promise<void>,
  ) {
    const state = await this.storage.decisions(asset, signal),
      old = state.current
        ? await this.storage.load(String(state.current.proofread_id), signal)
        : null;
    if (!old?.bundle.arrangement) throw new ArchiveTextError("input-missing");
    const source = await this.source(asset, mode, signal);
    if (source.input_sha256 !== old.bundle.arrangement.source_input_sha256)
      throw new ArchiveTextError("input-stale");
    if (
      retry?.some(
        (p) =>
          !old.version.pages[p] ||
          old.version.pages[p]!.status === "not-required",
      )
    )
      throw new ArchiveTextError("page-outside-session");
    if (retry && textHash(old.version.method) !== textHash(this.method()))
      throw new ArchiveTextError("input-stale");
    if (
      old.version.status === "complete" &&
      !retry &&
      textHash(old.version.method) === textHash(this.method())
    )
      return {
        proofread_id: old.version.proofread_id,
        arrangement_id: old.version.arrangement_id,
        usage: emptyArchiveUsage(),
        pages: old.version.pages.map((p) => ({
          page_index: p.page_index,
          status: p.status,
          stop: p.stop,
          reused: true,
        })),
        issues: [],
        stop: null,
      };
    const manualTexts = state.items.flatMap((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("action" in value) ||
        value.action !== "leaf-text"
      )
        return [];
      const fields = annotationRecord(value, [
        "schema_version",
        "action",
        "decision_id",
        "part_asset_id",
        "source_span",
        "replacement",
        "locked",
        "actor",
        "created_at",
      ]);
      if (
        fields.schema_version !== 2 ||
        fields.locked !== true ||
        fields.part_asset_id !== asset
      )
        throw new ArchiveTextError("manual-conflict");
      const q = {
        source_span: parseSourceSpan(fields.source_span),
        replacement: archiveText(fields.replacement),
        decision_id: parseAssetId(fields.decision_id),
      };
      const leaf = old.bundle.arrangement!.leaves.find(
        (l) => textHash(l.source) === textHash(q.source_span),
      );
      if (!leaf) throw new ArchiveTextError("manual-conflict");
      return [
        {
          leaf_id: leaf.leaf_id,
          replacement: q.replacement,
          decision_id: q.decision_id,
        },
      ];
    });
    const cache = new SqliteProofreadStorage(
        this.storage.database,
        this.storage.files,
      ),
      result = await new ArchivePageProofreadService(
        this.runtime,
        this.pdf,
        cache,
      ).build(
        source,
        old.bundle.arrangement,
        source.pages,
        signal,
        manualTexts,
        onPage,
        retry
          ? new Map(
              old.version.pages
                .filter((p) => !retry.includes(p.page_index))
                .map((p) => [p.page_index, p]),
            )
          : undefined,
      );
    try {
      const output = await archiveTextVersion(
        source,
        old.bundle.arrangement,
        result.pages,
        result.usage,
        this.method(),
        old.version.manual_decision_ids,
        result.pages.find((p) => p.stop)?.stop ?? null,
      );
      await this.storage.publish(
        output.version,
        output.bundle,
        {
          current_revision: Number(state.current!.revision),
          manual_revision: state.manual_revision,
        },
        signal?.aborted ? undefined : signal,
      );
      const receipt = {
        proofread_id: output.version.proofread_id,
        arrangement_id: output.version.arrangement_id,
        usage: result.usage,
        pages: result.pages.map((p) => ({
          page_index: p.page_index,
          status: p.status,
          stop: p.stop,
          reused: result.reused_page_indexes.includes(p.page_index),
          attempted:
            p.status !== "not-required" &&
            !result.reused_page_indexes.includes(p.page_index) &&
            !result.untouched_page_indexes.includes(p.page_index),
        })),
        issues: result.issues,
        stop: output.version.stop,
        stats: {
          executed_pages: result.pages.filter(
            (p) =>
              p.status !== "not-required" &&
              !result.reused_page_indexes.includes(p.page_index) &&
              !result.untouched_page_indexes.includes(p.page_index),
          ).length,
          correction_count: result.pages.reduce(
            (n, p) => n + p.corrections.length,
            0,
          ),
          required_pages: result.pages.filter(
            (p) => p.status !== "not-required",
          ).length,
        },
      };
      if (!result.complete)
        throw Object.assign(
          new ArchiveTextError(output.version.stop?.code ?? "proofread-failed"),
          { output: receipt },
        );
      return receipt;
    } catch (error) {
      throw archiveUsageFailure(error, result.usage);
    }
  }
  async render(
    literature: string,
    asset: string,
    signal?: AbortSignal,
    expected?: { proofread_id: string; default_revision: number | null },
  ) {
    const db = this.storage.database,
      files = this.storage.files,
      state = await this.storage.state(asset, signal),
      output = state.current
        ? await this.storage.load(String(state.current.proofread_id), signal)
        : null;
    if (!output || output.version.status !== "complete")
      throw new ArchiveTextError("input-missing");
    if (expected && expected.proofread_id !== output.version.proofread_id)
      throw new ArchiveTextError("publication-conflict");
    const v = output.version,
      material = await db.documentMaterial(literature, asset);
    if (!material || material.material.asset_sha256 !== v.part_sha256)
      throw new ArchiveTextError("input-stale");
    const raw = await this.raw.current(asset, signal);
    if (!raw.some((r) => r.result?.raw_parse_id === v.draft_input.raw_parse_id))
      throw new ArchiveTextError("input-stale");
    const rendered = renderArrangement(output.bundle, v.resources),
      documents = new SqliteDocumentStorage(db, files);
    await documents.withVerifiedArtifact(
      material.path,
      material.material.artifact,
      async (chunks) => {
        for await (const b of chunks) {
          void b;
          signal?.throwIfAborted();
        }
      },
      signal,
    );
    const artifact = (bytes: Uint8Array, media_type: string) =>
      parseArtifactRef({
        sha256: byteHash(bytes),
        byte_size: bytes.length,
        media_type,
      });
    const receipt = await files.withWrite(async () => {
      const markdown = await this.storage.write(
          "proofread-markdown",
          rendered.markdown,
          "text/markdown",
        ),
        structure = await this.storage.write(
          "document-structure",
          rendered.bytes,
        );
      const resources = rendered.resources.map((r, i) => ({
        resource_id: `r${i + 1}`,
        reference: r.reference,
        relation: "image" as const,
        artifact: r.artifact,
      }));
      const representation = {
        source_material_ref: material.material,
        proofread_id: v.proofread_id,
        proofread_content_sha256: v.content_sha256,
        builder_version:
          ARRANGED_DOCUMENT_BUILDER as typeof ARRANGED_DOCUMENT_BUILDER,
        locator_scheme: "utf8-segment-v1" as const,
        markdown: artifact(rendered.markdown, "text/markdown"),
        structure: artifact(rendered.bytes, "application/json"),
        resources,
      };
      const hash = await documentRepresentationHash(representation),
        document_id = textId(["document", literature, asset]),
        document = {
          schema_version: 2 as const,
          document_id,
          document_version_id: textId(["document-version", document_id, hash]),
          representation_sha256: hash,
          ...representation,
        };
      const paths: Record<string, string> = {};
      for (const r of rendered.resources) {
        const a = await db.locateArtifact(r.artifact);
        if (!a) throw new ArchiveTextError("source-integrity");
        paths[r.reference] = a.reference;
      }
      const derivedResources = [
        { ...markdown, kind: "markdown" as const, logical_reference: "" },
      ];
      const publishedResources: import("../storage/sqlite/proofread-engine.js").ProofreadPublication["resources"][number][] =
        [...derivedResources];
      for (const r of rendered.resources)
        publishedResources.push({
          ...r.artifact,
          reference: paths[r.reference]!,
          kind: "image",
          logical_reference: r.reference,
        });
      await db.proofread(
        "render-resources",
        {
          proofread_id: v.proofread_id,
          manual_revision: state.manual_revision,
          resources: publishedResources,
        },
        signal,
      );
      const previous = await db.documentDefault(
        literature,
        asset,
        v.part_sha256,
      );
      const result = await db.commitDocumentVersion(
        {
          version: document,
          source_artifact_path: material.path,
          markdown_artifact_path: markdown.reference,
          structure_artifact_path: structure.reference,
          resource_artifact_paths: paths,
          expected_default_revision: expected
            ? expected.default_revision
            : (previous?.revision ?? null),
          expected_manual_revision: state.manual_revision,
        },
        signal?.aborted ? undefined : signal,
      );
      const part = (
        await db.archive<{
          parts: { asset_id: string; part: "main" | "supplementary" }[];
        }>("state", { literature_id: literature }, signal)
      ).parts.find((p) => p.asset_id === asset)!.part;
      const annotations = new SqliteAnnotationStorage(db, files),
        before = await annotations.state(document.document_version_id, signal),
        annotation = arrangementAnnotation(
          document.document_version_id,
          part,
          output.bundle,
          rendered,
        );
      const published = await annotations.publish(
        annotation,
        {
          expected_manual_revision: before.manual_revision,
          expected_current_revision: before.current?.revision ?? null,
          edit: null,
        },
        signal,
      );
      return {
        ...result,
        document_version_id: document.document_version_id,
        annotation_id: published.annotation_id,
        proofread_id: v.proofread_id,
        arrangement_id: v.arrangement_id,
        structure_satisfied: arrangedStructureSatisfied(
          annotation,
          output.bundle,
        ),
        source_map: rendered.source_map.length,
        usage: emptyArchiveUsage(),
      };
    });
    // Indexing owns its short publication lock. Do not retain the archive
    // artifact admission across its read/compute work or block unrelated writes.
    let index_status = "unchanged";
    if (receipt.default_updated) {
      try {
        await this.refreshIndex(signal ?? new AbortController().signal);
        index_status = "updated";
      } catch {
        index_status = "failed";
      }
    }
    return { ...receipt, index_status };
  }
}
