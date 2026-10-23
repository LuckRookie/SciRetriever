import {
  canonicalJsonBytes,
  sha256,
  type ArchiveState,
} from "@sciretriever/contracts";
import type { FileStore } from "../storage/files/store.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { SqliteProofreadStorage } from "../storage/proofread.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import type { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import { LiteratureMetadataService } from "../literature/metadata-service.js";
import type { TagService } from "../tags/service.js";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import { proofreadMethod } from "../proofread/engine.js";
import { PDF_PAGES_METHOD } from "../proofread/pdf-pages.js";
import { CORRECTION_METHOD } from "../proofread/correction.js";
import { structureMethod } from "../document/annotations.js";
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
  ) {}
  async reusable(state: ArchiveState, signal: AbortSignal) {
    const proof = new SqliteProofreadStorage(this.db, this.files),
      annotations = new SqliteAnnotationStorage(this.db, this.files),
      fields = new LiteratureMetadataService(this.db);
    const ready = this.models.readiness("proofreading"),
      corrector =
        ready.configured && !ready.missing.length
          ? {
              method: CORRECTION_METHOD,
              model_config_sha256: await sha256(
                canonicalJsonBytes(
                  this.models.effectiveIdentity("proofreading"),
                ),
              ),
            }
          : null;
    const expected = proofreadMethod(this.pagesMethod, corrector),
      configured = this.models.readiness("analysis").configured,
      identity = configured ? this.models.effectiveIdentity("analysis") : null;
    const classifier = identity
      ? {
          provider: identity.provider,
          model: identity.model,
          reasoning: identity.reasoning,
          stream: identity.stream,
          configuration_sha256: await sha256(canonicalJsonBytes(identity)),
        }
      : null;
    if (!state.parts.some((p) => p.part === "main")) return false;
    for (const part of state.parts) {
      const raw = await this.raw.current(part.asset_id, signal);
      const source =
        raw.find((r) => r.profile === this.profile)?.result ??
        raw.find((r) => r.profile === "vlm-engine-markdown-only")?.result;
      if (!source || !part.proofread_id || !part.document_version_id)
        return false;
      const current = await proof.state(part.asset_id, signal),
        saved = await proof.byId(part.proofread_id, signal);
      if (
        !saved ||
        saved.status !== "complete" ||
        saved.draft_input.raw_parse_id !== source.raw_parse_id ||
        JSON.stringify(saved.method) !== JSON.stringify(expected) ||
        JSON.stringify([...saved.manual_decision_ids].sort()) !==
          JSON.stringify(current.decisions.map((d) => d.decision_id).sort())
      )
        return false;
      const roles = await annotations.state(part.document_version_id, signal);
      if (
        !(await annotations.find(
          part.document_version_id,
          await sha256(canonicalJsonBytes(structureMethod(1024, classifier))),
          roles.manual_revision,
          signal,
        ))
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
      }
    }
    return true;
  }
}
