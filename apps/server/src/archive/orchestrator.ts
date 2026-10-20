import { randomUUID } from "node:crypto";
import {
  ARCHIVE_STEPS,
  canonicalJsonBytes,
  parseArchiveBuildRequest,
  sha256,
  type ArchiveBuildRequest,
  type ArchiveState,
  type ArchivePart,
  type ArchiveStep,
  type ArchiveStepReceipt,
  type LiteratureStatus,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { ProofreadService } from "../proofread/service.js";
import type { ProofreadDocumentService } from "../document/proofread-publication.js";
import type { StructureAnnotationService } from "../document/annotations.js";
import type { ArchiveMetadataService } from "../literature/archive-metadata.js";
import type { ArchiveReferenceService } from "../literature/archive-references.js";
import type { TagService } from "../tags/service.js";
import type { LiteratureMetadataService } from "../literature/metadata-service.js";
import type { ExecutionRepository } from "../storage/execution/repository.js";
export class ArchiveError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("archive operation failed");
    this.name = "ArchiveError";
    this.code = code;
  }
}
export interface ArchiveRuntime {
  readonly proofread: Pick<ProofreadService, "build">;
  readonly documents: Pick<ProofreadDocumentService, "publish">;
  readonly structure: Pick<StructureAnnotationService, "build">;
  readonly metadata: Pick<ArchiveMetadataService, "build">;
  readonly references: Pick<ArchiveReferenceService, "build">;
  readonly tags: Pick<
    TagService,
    "build" | "state" | "assignment" | "consolidate"
  >;
  readonly metadataFields: Pick<LiteratureMetadataService, "read">;
  readonly method_sha256: string;
  readonly archiveProfile?: "pipeline" | "vlm-engine";
}
export type ArchiveStatus = ArchiveState & {
  status: LiteratureStatus;
  missing_step: string | null;
};
export class ArchiveOrchestrator {
  constructor(
    private readonly database: SqliteWorker,
    private readonly runtime: ArchiveRuntime,
  ) {}
  status(id: string, signal?: AbortSignal) {
    return this.database.archive<ArchiveStatus>(
      "state",
      { literature_id: id },
      signal,
    );
  }
  async build(
    value: unknown,
    signal?: AbortSignal,
    jobId: string | null = null,
  ): Promise<Record<string, unknown>> {
    const request = parseArchiveBuildRequest(value),
      id = request.literature_id,
      initial = await this.status(id, signal),
      main = initial.parts.find((p) => p.part === "main");
    if (!main) return { outcome: "needs-pdf", literature_id: id };
    const profiles =
      request.mode === "full"
        ? [
            this.runtime.archiveProfile ?? "vlm-engine",
            "vlm-engine-markdown-only",
          ]
        : ["vlm-engine-markdown-only"];
    if (!profiles.some((p) => main.raw_profiles.includes(p)))
      return { outcome: "needs-parse", literature_id: id };
    const runId = randomUUID(),
      before = (await this.runtime.tags.state(signal)).version;
    await this.database.archive(
      "begin",
      {
        literature_id: id,
        asset_id: main.asset_id,
        mode: request.mode,
        run_id: runId,
        job_id: jobId,
      },
      signal,
    );
    let interrupted = false;
    try {
      for (const part of [
        main,
        ...initial.parts.filter((p) => p.part !== "main"),
      ]) {
        if (signal?.aborted) throw new ArchiveError("archive-cancelled");
        if (!profiles.some((p) => part.raw_profiles.includes(p))) {
          await this.save(
            runId,
            id,
            part,
            "proofread",
            "unavailable",
            "",
            {},
            "needs-parse",
            0,
            false,
          );
          continue;
        }
        for (const step of ARCHIVE_STEPS) {
          if (
            part.part !== "main" &&
            ["metadata", "references", "tags"].includes(step)
          )
            continue;
          try {
            await this.step(runId, request, part, step, signal);
            if (
              step === "metadata" &&
              ["correction-or-editorial", "perspective-or-commentary"].includes(
                (await this.status(id, signal)).article_kind ?? "",
              )
            )
              break;
          } catch (error) {
            if (signal?.aborted) throw error;
            const state = await this.status(id);
            if (
              !state.issues.some(
                (i) =>
                  i.asset_id === part.asset_id &&
                  i.step === step &&
                  i.resolution === null,
              )
            ) {
              const reason =
                error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string"
                  ? error.code
                  : `${step}-failed`;
              await this.save(
                runId,
                id,
                part,
                step,
                part.part === "main" ? "failed" : "unavailable",
                "",
                {},
                reason,
                0,
                true,
              );
            }
            // Missing references are visible but do not block tags or readiness.
            if (step !== "references") break;
          }
        }
      }
      if (signal?.aborted) throw new ArchiveError("archive-cancelled");
    } catch (error) {
      interrupted = true;
      throw error;
    } finally {
      await this.database.archive("finish", {
        literature_id: id,
        run_id: runId,
        interrupted,
      });
    }
    const state = await this.status(id),
      after = (await this.runtime.tags.state()).version;
    return {
      outcome:
        state.status === "READY"
          ? "ready"
          : state.status === "EXCLUDED"
            ? "excluded"
            : state.issues.some(
                  (i) => i.reason === "needs-parse" && i.part === "main",
                )
              ? "needs-parse"
              : "failed",
      literature_id: id,
      status: state.status,
      issues: state.issues.filter((i) => i.resolution !== "continue"),
      created_tags: after > before,
      vocabulary_from: before,
      vocabulary_through: after,
    };
  }
  private async input(
    request: ArchiveBuildRequest,
    part: ArchivePart,
    step: ArchiveStep,
    signal?: AbortSignal,
  ) {
    const state = await this.status(request.literature_id, signal),
      current = state.parts.find((p) => p.asset_id === part.asset_id);
    if (!current || current.part !== part.part)
      throw new ArchiveError("archive-primary-stale");
    const metadata = ["metadata", "tags"].includes(step)
      ? await this.runtime.metadataFields.read(request.literature_id, signal)
      : null;
    const assignment =
      step === "tags"
        ? await this.runtime.tags.assignment(request.literature_id, signal)
        : null;
    const key = {
      method: this.runtime.method_sha256,
      step,
      mode: request.mode,
      asset: part.asset_id,
      proofread: current.proofread_id,
      document:
        step === "proofread" || step === "document"
          ? null
          : current.document_version_id,
      annotation: ["metadata", "references", "tags"].includes(step)
        ? current.structure_annotation_id
        : null,
      metadata: metadata
        ? [metadata.metadata_revision, metadata.metadata_sha256]
        : null,
      assignment: assignment?.assignment_sha256 ?? null,
    };
    return {
      state,
      current,
      metadata,
      sha256: await sha256(canonicalJsonBytes(key)),
    };
  }
  private async step(
    runId: string,
    request: ArchiveBuildRequest,
    part: ArchivePart,
    step: ArchiveStep,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new ArchiveError("archive-cancelled");
    const id = request.literature_id,
      input = await this.input(request, part, step, signal),
      prior = input.current.steps.find((s) => s.step === step),
      force =
        request.from_step !== null &&
        ARCHIVE_STEPS.indexOf(step) >= ARCHIVE_STEPS.indexOf(request.from_step);
    // Early stages validate their method/manual inputs in the existing publication services.
    if (
      !force &&
      ["metadata", "references", "tags"].includes(step) &&
      prior?.status === "done" &&
      prior.input_sha256 === input.sha256
    )
      return;
    const start = performance.now();
    let output: Record<string, unknown> = {};
    await this.save(
      runId,
      id,
      part,
      step,
      "running",
      input.sha256,
      {},
      null,
      0,
      false,
    );
    try {
      if (step === "proofread") {
        const result = await this.runtime.proofread.build(
          { asset_id: part.asset_id, mode: request.mode },
          signal,
        );
        output = {
          proofread_id: result.version.proofread_id,
          stats: result.version.stats,
          usage: result.usage,
          status: result.version.status,
          failure: result.version.failure,
          pending_pages: result.version.pages.filter((p) => !p.checked),
        };
        if (result.version.status !== "complete")
          throw new ArchiveError(
            result.version.status === "incomplete"
              ? "proofread-incomplete"
              : "proofread-failed",
          );
      } else if (step === "document") {
        if (!input.current.proofread_id || !input.current.proofread_complete)
          throw new ArchiveError("proofread-failed");
        const previous = await this.database.documentDefault(
          id,
          part.asset_id,
          part.asset_sha256,
        );
        output = {
          ...(await this.runtime.documents.publish(
            {
              literature_id: id,
              asset_id: part.asset_id,
              proofread_id: input.current.proofread_id,
              expected_default_revision: previous?.revision ?? null,
            },
            signal,
          )),
        };
      } else if (step === "structure") {
        output = {
          ...(await this.runtime.structure.build(
            {
              document_version_id: input.current.document_version_id,
              max_prefix_characters: 1024,
            },
            signal,
          )),
        };
        if (part.part === "main" && !output.structure_satisfied)
          throw new ArchiveError("structure-unsatisfied");
      } else {
        const reference = {
          literature_id: id,
          document_version_id: input.current.document_version_id,
          annotation_id: input.current.structure_annotation_id,
        };
        if (!reference.document_version_id || !reference.annotation_id)
          throw new ArchiveError("structure-unsatisfied");
        if (step === "metadata") {
          output = {
            ...reference,
            ...(await this.runtime.metadata.build(
              {
                ...reference,
                expected_revision: input.metadata!.metadata_revision,
              },
              signal,
            )),
          };
          if (output.status === "failed")
            throw new ArchiveError(
              String((output.missing as string[])[0] ?? "metadata-missing"),
            );
        } else if (step === "references") {
          output = {
            ...(await this.runtime.references.build(reference, signal)),
          };
          if (output.total === 0) throw new ArchiveError("references-missing");
        } else {
          output = {
            ...reference,
            ...(await this.runtime.tags.build(reference, signal)),
          };
          if (!(await this.runtime.tags.assignment(id, signal))?.items.length)
            throw new ArchiveError("tags-empty");
        }
      }
      // Record a successfully committed step even if cancellation arrived just after publication.
      const after = await this.input(request, part, step);
      await this.save(
        runId,
        id,
        part,
        step,
        "done",
        after.sha256,
        output,
        null,
        performance.now() - start,
        true,
      );
    } catch (error) {
      const originalCode = signal?.aborted
        ? "archive-cancelled"
        : error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
          ? error.code
          : `${step}-failed`;
      const code = [
        "proofread-needs-parse",
        "proofread-input-missing",
      ].includes(originalCode)
        ? "needs-parse"
        : step === "references" && !signal?.aborted
          ? "references-missing"
          : originalCode;
      if (code !== originalCode)
        output = { ...output, failure_code: originalCode };
      await this.save(
        runId,
        id,
        part,
        step,
        signal?.aborted
          ? "pending"
          : part.part === "main"
            ? "failed"
            : "unavailable",
        input.sha256,
        output,
        code,
        performance.now() - start,
        true,
      );
      throw error;
    }
  }
  private async save(
    run: string,
    id: string,
    part: ArchivePart,
    step: ArchiveStep,
    status: ArchiveStepReceipt["status"],
    input: string,
    output: Record<string, unknown>,
    reason: string | null,
    elapsed: number,
    record: boolean,
  ) {
    const usage = output.usage as
      | { calls?: number; input_tokens?: number; output_tokens?: number }
      | undefined;
    return this.database.archive("step", {
      run_id: run,
      record_attempt: record,
      receipt: {
        literature_id: id,
        asset_id: part.asset_id,
        step,
        status,
        input_sha256: input,
        output,
        reason,
        elapsed_ms: Math.round(elapsed),
        calls: usage?.calls ?? 0,
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
      },
    });
  }
  async finish(jobId: string, repository: ExecutionRepository) {
    // The job's vocabulary baseline is durable, so cancellation after tag creation still runs this hook.
    const events = await repository.listEvents(jobId, -1, 1000);
    const baseline = events.find((e) => e.kind === "archive-vocabulary-start")
      ?.payload as { version: number } | undefined;
    if (
      !baseline ||
      (await this.runtime.tags.state()).version <= baseline.version
    )
      return;
    if (
      !(
        await this.database.archive<{ claimed: boolean }>("hook", {
          job_id: jobId,
          state: "running",
        })
      ).claimed
    )
      return;
    try {
      const result = await this.runtime.tags.consolidate();
      await this.database.archive("hook", {
        job_id: jobId,
        state: "done",
        result,
      });
    } catch {
      await this.database.archive("hook", {
        job_id: jobId,
        state: "failed",
        result: { code: "tag-consolidation-failed" },
      });
    }
  }
  async beginBatch(jobId: string, repository: ExecutionRepository) {
    if (
      (await repository.listEvents(jobId, -1, 1000)).some(
        (e) => e.event_id === `${jobId}:archive-vocabulary-start`,
      )
    )
      return;
    const version = (await this.runtime.tags.state()).version;
    await repository.appendEvent({
      event_id: `${jobId}:archive-vocabulary-start`,
      job_id: jobId,
      sequence: -1,
      kind: "archive-vocabulary-start",
      payload: { version },
      created_at: new Date().toISOString(),
    });
  }
}
