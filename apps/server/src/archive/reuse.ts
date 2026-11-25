import { type ArchiveState, type ArchivePart } from "@sciretriever/contracts";
import type { FileStore } from "../storage/files/store.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import type { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import { LiteratureMetadataService } from "../literature/metadata-service.js";
import type { TagService } from "../tags/service.js";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import { ARRANGEMENT_WORKFLOW } from "./arrangement-service.js";
import { LEAF_CORRECTION_METHOD } from "../proofread/leaf-corrections.js";
import { PAGE_REVIEW_METHOD } from "../proofread/page-review.js";
import { textHash } from "./text-source.js";
import { archiveTextModelIdentity } from "./text-session.js";
import { PDF_PAGES_METHOD } from "../proofread/pdf-pages.js";
import { archiveStepKey } from "./input-key.js";

/** Counts only fully reusable papers; partial step reuse remains in execution's authority. */
export class ArchiveReusePreview {
  constructor(
    private readonly db: SqliteWorker,
    private readonly files: FileStore,
    private readonly raw: Pick<SqliteRawParseStorage, "current">,
    private readonly tags: TagService,
    private readonly models: Pick<
      DshAgentRuntime,
      "readiness" | "effectiveIdentity"
    >,
    private readonly method: string,
    private readonly profile: string,
    private readonly pagesMethod = PDF_PAGES_METHOD,
    /** `[translation].target_language`; null leaves the translate step out. */
    private readonly language: string | null = null,
  ) {}
  /** The main PDF still needs the translate step for its current content (spec 9.3). */
  async translationPending(part: ArchivePart): Promise<boolean> {
    if (this.language === null || part.part !== "main") return false;
    const before = part.steps.find((s) => s.step === "translate");
    return (
      before?.status !== "done" ||
      before.input_sha256 !==
        (await archiveStepKey(
          this.method,
          "full",
          part,
          "translate",
          null,
          null,
          this.language,
        ))
    );
  }
  private textMethod() {
    return {
      arrange: ARRANGEMENT_WORKFLOW,
      page_classify: this.pagesMethod,
      // The key keeps its name; ADR 0047 pages are reviewed by the guarded single request.
      suspects: PAGE_REVIEW_METHOD,
      correction: LEAF_CORRECTION_METHOD,
      model_config_sha256: textHash(archiveTextModelIdentity(this.models)),
    };
  }
  /** Read-only work units. An accepted page is reusable only with the exact raw/method/manual inputs. */
  async textWork(part: ArchivePart, signal: AbortSignal) {
    const proof = new SqliteArchiveTextStorage(this.db, this.files),
      raw = await this.raw.current(part.asset_id, signal),
      source =
        raw.find((r) => r.profile === this.profile)?.result ??
        raw.find((r) => r.profile === "vlm-engine-markdown-only")?.result;
    const current = await proof.state(part.asset_id, signal),
      output = part.proofread_id
        ? await proof.load(part.proofread_id, signal)
        : null;
    const accepted =
      source &&
      output?.bundle.arrangement &&
      current.current?.proofread_id === part.proofread_id &&
      output.version.draft_input.result_sha256 === source.result_sha256 &&
      textHash(output.version.method) === textHash(this.textMethod()) &&
      textHash([...output.version.manual_decision_ids].sort()) ===
        textHash(current.decisions.map((d) => String(d.decision_id)).sort());
    return {
      arrange_required: !accepted,
      total_pdf_pages: source?.page_count ?? null,
      expected_proofread_pages: accepted
        ? output.version.pages.filter(
            (p) =>
              !["accepted", "not-required", "unreviewed"].includes(p.status),
          ).length
        : (source?.page_count ?? null),
      page_basis: accepted
        ? ("accepted-arrangement" as const)
        : source
          ? ("all-pdf-pages" as const)
          : ("unknown" as const),
    };
  }
  async reusable(state: ArchiveState, signal: AbortSignal) {
    const proof = new SqliteArchiveTextStorage(this.db, this.files),
      annotations = new SqliteAnnotationStorage(this.db, this.files),
      fields = new LiteratureMetadataService(this.db);
    const expected = this.textMethod();
    if (!state.parts.some((p) => p.part === "main")) return false;
    for (const part of state.parts) {
      const raw = await this.raw.current(part.asset_id, signal);
      const source =
        raw.find((r) => r.profile === this.profile)?.result ??
        raw.find((r) => r.profile === "vlm-engine-markdown-only")?.result;
      if (!source || !part.proofread_id || !part.document_version_id)
        return false;
      const current = await proof.state(part.asset_id, signal),
        output = await proof.load(part.proofread_id, signal),
        saved = output?.version;
      if (
        !saved ||
        saved.status !== "complete" ||
        saved.draft_input.raw_parse_id !== source.raw_parse_id ||
        textHash(saved.method) !== textHash(expected) ||
        JSON.stringify([...saved.manual_decision_ids].sort()) !==
          JSON.stringify(
            current.decisions.map((d) => String(d.decision_id)).sort(),
          )
      )
        return false;
      const document = await this.db.documentVersion(part.document_version_id),
        annotation = await annotations.current(
          part.document_version_id,
          signal,
        );
      if (
        document?.version.schema_version !== 2 ||
        document.version.proofread_id !== part.proofread_id ||
        annotation?.schema_version !== 2 ||
        annotation.arrangement_id !== saved.arrangement_id
      )
        return false;
      if (part.part === "main") {
        const metadata = await fields.read(state.literature_id, signal),
          assignment = await this.tags.assignment(state.literature_id, signal);
        for (const step of ["metadata", "references", "tags"] as const) {
          const before = part.steps.find((s) => s.step === step);
          if (
            before?.status !== "done" ||
            before.input_sha256 !==
              (await archiveStepKey(
                this.method,
                "full",
                part,
                step,
                step === "references" ? null : metadata,
                step === "tags"
                  ? (assignment?.assignment_sha256 ?? null)
                  : null,
              ))
          )
            return false;
        }
        if (await this.translationPending(part)) return false;
      }
    }
    return true;
  }
}
