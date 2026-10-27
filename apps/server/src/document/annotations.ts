import {
  annotationRecord,
  annotationInteger,
  annotationToken,
  parseAssetId,
  parseSectionRole,
  structureAnnotationHash,
  canonicalJsonBytes,
  sha256,
  ContractValidationError,
  type StructureAnnotationV1 as StructureAnnotation,
  type SectionRole,
} from "@sciretriever/contracts";
import { SqliteDocumentStorage } from "./storage.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import {
  assignSectionRoles,
  SECTION_RULES_VERSION,
  type RoleModelInput,
} from "./section-rules.js";
import {
  segmentRoles,
  structureFigures,
  structureReferences,
  structureSatisfied,
} from "./structure-extract.js";
export class AnnotationError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super("structure annotation failed", options);
  }
}
export class StructureAnnotationService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly documents: SqliteDocumentStorage,
    private readonly storage: SqliteAnnotationStorage,
    private readonly classifier: {
      readonly identity: NonNullable<StructureAnnotation["method"]["model"]>;
      readonly classify: (
        input: RoleModelInput,
        signal?: AbortSignal,
        reportUsage?: (usage: {
          calls: number;
          input_tokens: number;
          output_tokens: number;
        }) => void,
      ) => Promise<unknown>;
    } | null,
  ) {}
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
  private run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const work = (async () => {
      if (active.aborted) throw new AnnotationError("annotation-cancelled");
      try {
        return await fn(active);
      } catch (e) {
        if (
          e instanceof ContractValidationError ||
          e instanceof AnnotationError
        )
          throw e;
        const code = active.aborted
          ? "annotation-cancelled"
          : e &&
              typeof e === "object" &&
              "code" in e &&
              typeof e.code === "string" &&
              e.code.startsWith("annotation-")
            ? e.code
            : "annotation-failed";
        throw new AnnotationError(code, { cause: e });
      }
    })();
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  build(value: unknown, signal?: AbortSignal) {
    const r = annotationRecord(value, [
      "document_version_id",
      "max_prefix_characters",
    ]);
    const id = parseAssetId(r.document_version_id),
      prefix = annotationInteger(r.max_prefix_characters, 0, 65536);
    return this.run((active) => this.perform(id, prefix, null, active), signal);
  }
  buildRules(value: unknown, signal?: AbortSignal) {
    const r = annotationRecord(value, ["document_version_id"]);
    return this.run(
      (active) =>
        this.perform(
          parseAssetId(r.document_version_id),
          0,
          null,
          active,
          true,
        ),
      signal,
    );
  }
  setRole(value: unknown, signal?: AbortSignal) {
    const r = annotationRecord(value, [
      "document_version_id",
      "section_id",
      "role",
      "expected_manual_revision",
      "actor",
    ]);
    const id = parseAssetId(r.document_version_id),
      section = annotationToken(r.section_id),
      revision = annotationInteger(r.expected_manual_revision);
    if (
      typeof r.actor !== "string" ||
      !r.actor.trim() ||
      r.actor.length > 256 ||
      r.actor.includes("\0")
    )
      throw new ContractValidationError();
    const edit = {
      section_id: section,
      role: r.role === null ? null : parseSectionRole(r.role),
      actor: r.actor,
      expected_manual_revision: revision,
    };
    return this.run(async (active) => {
      const current = await this.storage.current(id, active);
      if (!current || current.schema_version !== 1)
        throw new AnnotationError("annotation-missing");
      return this.perform(
        id,
        current.method.max_prefix_characters,
        edit,
        active,
      );
    }, signal);
  }
  private async perform(
    id: string,
    prefix: number,
    edit: {
      section_id: string;
      role: SectionRole | null;
      actor: string;
      expected_manual_revision: number;
    } | null,
    signal: AbortSignal,
    rulesOnly = false,
  ) {
    const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
    const state = await this.storage.state(id, signal);
    if (!state.part) throw new AnnotationError("annotation-proofread-required");
    if (edit && edit.expected_manual_revision !== state.manual_revision)
      throw new AnnotationError("annotation-manual-stale");
    const base =
      edit && state.current
        ? await this.storage.byId(state.current.annotation_id, signal)
        : null;
    if (base && base.schema_version !== 1)
      throw new AnnotationError("archive-contract-obsolete");
    if (edit && !base) throw new AnnotationError("annotation-missing");
    const method = structureMethod(
      prefix,
      edit
        ? base!.method.model
        : rulesOnly
          ? null
          : (this.classifier?.identity ?? null),
      edit ? base!.annotation_id : null,
    );
    const locks: Record<string, SectionRole> = Object.fromEntries(
      state.locks.map((l) => [l.section_id, l.role]),
    );
    if (edit) {
      if (edit.role === null) {
        if (!Object.hasOwn(locks, edit.section_id))
          throw new AnnotationError("annotation-lock-missing");
        delete locks[edit.section_id];
      } else locks[edit.section_id] = parseSectionRole(edit.role, state.part);
    }
    const revision = state.manual_revision + (edit ? 1 : 0),
      methodHash = await sha256(canonicalJsonBytes(method));
    let annotation = !edit
      ? await this.storage.find(id, methodHash, revision, signal)
      : null;
    if (!annotation)
      annotation = await this.documents.withVerifiedDocument(
        id,
        async (version, markdown, structure) => {
          if (version.schema_version !== 2 || structure.schema_version !== 2)
            throw new AnnotationError("annotation-proofread-required");
          const sections = await assignSectionRoles({
            structure,
            markdown,
            part: state.part!,
            max_prefix_characters: prefix,
            locked: locks,
            classify:
              edit || rulesOnly || !this.classifier
                ? null
                : (input, signal) =>
                    this.classifier!.classify(input, signal, (counts) => {
                      for (const key of [
                        "calls",
                        "input_tokens",
                        "output_tokens",
                      ] as const)
                        usage[key] += counts[key];
                    }),
            ...(base
              ? {
                  known: new Map(
                    base.sections
                      .filter((s) => !s.locked && s.inherited_from === null)
                      .map((s) => [s.section_id, s]),
                  ),
                  unavailable_code: "role-reclassification-needed",
                }
              : {}),
            signal,
          });
          const segment_roles = segmentRoles(
              structure,
              markdown,
              sections,
              state.part!,
            ),
            figures = structureFigures(structure, markdown),
            references = structureReferences(
              structure,
              markdown,
              segment_roles,
            );
          const body = {
            schema_version: 1 as const,
            document_version_id: id,
            part: state.part!,
            method,
            manual_revision: revision,
            sections,
            segment_roles,
            figures,
            references,
          };
          return {
            ...body,
            annotation_id: await structureAnnotationHash(body),
          };
        },
        signal,
      );
    if (annotation.schema_version !== 1)
      throw new AnnotationError("archive-contract-obsolete");
    const receipt = await this.storage.publish(
      annotation,
      {
        expected_manual_revision: state.manual_revision,
        expected_current_revision: state.current?.revision ?? null,
        edit: edit
          ? { section_id: edit.section_id, role: edit.role, actor: edit.actor }
          : null,
      },
      signal,
    );
    const published = await this.storage.byId(receipt.annotation_id, signal);
    if (!published || published.schema_version !== 1)
      throw new AnnotationError("annotation-integrity");
    return {
      ...receipt,
      usage,
      structure_satisfied: structureSatisfied(
        published.part,
        published.sections,
      ),
      section_count: published.sections.length,
      reference_count: published.references.length,
    };
  }
}

export function structureMethod(
  prefix: number,
  model: StructureAnnotation["method"]["model"],
  base: string | null = null,
): StructureAnnotation["method"] {
  return {
    mode: base ? "manual" : "automatic",
    base_annotation_id: base,
    rules_version: SECTION_RULES_VERSION,
    extraction_version: "structure-extract-v1",
    model_method_version: "section-role-dsh-v1",
    max_prefix_characters: prefix,
    model,
  };
}
