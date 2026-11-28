import { createHash } from "node:crypto";
import {
  LAYERS_FILE_SCHEMA_VERSION,
  LAYERS_MIN_CODE_POINTS,
  LAYERS_PRIMARY_MIN,
  READING_LAYERS_PROMPT_VERSION,
  READING_LAYERS_SECTION_PROMPT_VERSION,
  READING_LAYERS_TRANSLATION_PROMPT_VERSION,
  SENTENCE_SPLIT_RULE,
  archiveContentVersion,
  canonicalJsonBytes,
  documentLayersFileVersion,
  parseArtifactRef,
  parseDocumentLayersFile,
  type DocumentLayersFile,
  type DocumentLayersState,
  type DocumentLayersSummary,
  type DocumentRef,
  type DocumentTranslationFile,
  type LayersNotApplicableReason,
  type LayersTranslatedLine,
  type LayersTranslatedPoint,
  type LayersTranslationPart,
  type TranslationLanguage,
} from "@sciretriever/contracts";
import {
  LEGACY_ARRANGED_DOCUMENT_BUILDER,
  isArrangedBuilder,
} from "../archive/render.js";
import { SqliteDocumentStorage } from "../document/storage.js";
import { artifactReference } from "../storage/artifact-layout.js";
import { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import type { FileStore } from "../storage/files/store.js";
import type { DocumentLayersRow } from "../storage/sqlite/document-layers-engine.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import {
  documentUnits,
  type DocumentTranslationStore,
} from "../translation/document.js";
import {
  TranslationError,
  type TranslationService,
  type UnitTranslationUsage,
} from "../translation/service.js";
import {
  LayersAnswerError,
  checkDocumentAnswer,
  checkLineAnswer,
  checkSectionAnswer,
  checkTranslationDocumentAnswer,
  checkTranslationSectionAnswer,
  documentInput,
  emptyDropped,
  layersParts,
  layersPlan,
  numberedPoints,
  sectionInput,
  sectionLineInput,
  translationDocumentInput,
  translationSectionInput,
  type CheckedDocument,
  type Dropped,
  type LayersGroup,
  type LayersNote,
  type LayersParagraph,
  type LayersPlan,
  type LayersStructure,
  type TranslatedParagraph,
} from "./check.js";
import {
  LAYERS_DOCUMENT_SCHEMA,
  LAYERS_DOCUMENT_SYSTEM,
  LAYERS_SECTION_LINE_SCHEMA,
  LAYERS_SECTION_LINE_SYSTEM,
  LAYERS_SECTION_SCHEMA,
  LAYERS_SECTION_SYSTEM,
  LAYERS_TRANSLATION_DOCUMENT_SCHEMA,
  LAYERS_TRANSLATION_SECTION_SCHEMA,
  layersTranslationDocumentSystem,
  layersTranslationSectionSystem,
} from "./prompt.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

type Structure = LayersStructure;
export {
  LayersAnswerError,
  checkDocumentAnswer,
  checkSectionAnswer,
  figureCaption,
  layersPlan,
  unitSentences,
  type LayersPlan,
} from "./check.js";

export class LayersStepError extends Error {
  constructor(
    readonly code:
      | "layers-incomplete"
      | "layers-unavailable"
      | "layers-translation-incomplete",
    readonly output: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "LayersStepError";
  }
}

/** Catalog registration and immutable files of reading layers. */
export class DocumentLayersStore {
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
  ) {}
  row(
    key: {
      readonly literature_id: string;
      readonly asset_id: string;
      readonly document_version_id: string;
      readonly content_version: string;
    },
    signal?: AbortSignal,
  ) {
    return this.database.archive<DocumentLayersRow | null>(
      "layers",
      key,
      signal,
    );
  }
  async latest(literature_id: string, signal?: AbortSignal) {
    try {
      return await this.database.archive<DocumentLayersRow | null>(
        "layers-latest",
        { literature_id },
        signal,
      );
    } catch {
      // A withdrawn literature has no layers to offer.
      return null;
    }
  }
  /** File versions by sha256: a stored file never changes. */
  private readonly versions = new Map<string, number | null>();
  /**
   * Whether a complete row's file has the current layout. A file written by
   * an earlier version reads as stale (spec 10.2.1, 10.6); it is not migrated.
   */
  async current(row: DocumentLayersRow, signal?: AbortSignal) {
    if (row.status !== "complete" || !row.sha256) return true;
    let version = this.versions.get(row.sha256);
    if (version === undefined) {
      try {
        version = documentLayersFileVersion(
          JSON.parse(decoder.decode(await this.bytes(row, signal))),
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      if (this.versions.size >= 4096) this.versions.clear();
      this.versions.set(row.sha256, version);
    }
    return version === LAYERS_FILE_SCHEMA_VERSION;
  }
  private async bytes(row: DocumentLayersRow, signal?: AbortSignal) {
    if (row.status !== "complete" || !row.artifact_reference || !row.sha256)
      throw new Error("layers-integrity");
    const ref = parseArtifactRef({
      sha256: row.sha256,
      byte_size: row.byte_size,
      media_type: row.media_type,
    });
    const bytes = await this.files.withVerified(
      row.artifact_reference,
      ref,
      async (chunks) => {
        const all: Uint8Array[] = [];
        for await (const b of chunks) {
          signal?.throwIfAborted();
          all.push(b);
        }
        return Buffer.concat(all);
      },
      { maxBytes: row.byte_size!, ...(signal ? { signal } : {}) },
    );
    return bytes;
  }
  async load(
    row: DocumentLayersRow,
    signal?: AbortSignal,
  ): Promise<DocumentLayersFile> {
    const bytes = await this.bytes(row, signal);
    const file = parseDocumentLayersFile(JSON.parse(decoder.decode(bytes)));
    if (
      file.literature_id !== row.literature_id ||
      file.asset_id !== row.asset_id ||
      file.content_version !== row.content_version ||
      file.document_version_id !== row.document_version_id ||
      file.points.length !== row.point_count ||
      (file.translation?.target_language ?? null) !== row.target_language ||
      (file.translation?.translation_sha256 ?? null) !== row.translation_sha256
    )
      throw new Error("layers-integrity");
    return file;
  }
  /** Write the file, then register it; one row per combination, replaced. */
  async publish(
    file: DocumentLayersFile,
    signal?: AbortSignal,
  ): Promise<DocumentLayersRow> {
    const bytes = canonicalJsonBytes(parseDocumentLayersFile(file));
    const ref = parseArtifactRef({
      sha256: sha(bytes),
      byte_size: bytes.length,
      media_type: "application/json",
    });
    return this.files.withWrite(async () => {
      signal?.throwIfAborted();
      const reference =
        (await this.database.locateArtifact(ref))?.reference ??
        artifactReference("document-layers", ref);
      const stage = await this.files.stage({ maxBytes: bytes.length });
      try {
        await stage.write(bytes);
        const saved = await this.files.publish(stage, reference);
        if (saved.sha256 !== ref.sha256) throw new Error("layers-integrity");
      } finally {
        await stage.discard();
      }
      return this.database.archive<DocumentLayersRow>(
        "layers-publish",
        {
          row: {
            literature_id: file.literature_id,
            asset_id: file.asset_id,
            content_version: file.content_version,
            document_version_id: file.document_version_id,
            annotation_id: file.annotation_id,
            status: "complete",
            reason: null,
            artifact_reference: reference,
            sha256: ref.sha256,
            byte_size: ref.byte_size,
            media_type: "application/json",
            point_count: file.points.length,
            target_language: file.translation?.target_language ?? null,
            translation_sha256: file.translation?.translation_sha256 ?? null,
          },
        },
        signal,
      );
    }, signal);
  }
  /** A not-applicable result has a row and no file. */
  publishNotApplicable(
    key: {
      readonly literature_id: string;
      readonly asset_id: string;
      readonly document_version_id: string;
      readonly annotation_id: string;
      readonly content_version: string;
    },
    reason: LayersNotApplicableReason,
    signal?: AbortSignal,
  ) {
    return this.database.archive<DocumentLayersRow>(
      "layers-publish",
      {
        row: {
          ...key,
          status: "not-applicable",
          reason,
          artifact_reference: null,
          sha256: null,
          byte_size: null,
          media_type: null,
          point_count: 0,
          target_language: null,
          translation_sha256: null,
        },
      },
      signal,
    );
  }
  /**
   * The layers of a fixed version (spec 10.7): a draft or a version without
   * annotation has none; a version whose content version has no layers,
   * while another content version of the literature has, is `stale`.
   */
  async lookup(
    document: DocumentRef,
    annotation_id: string | null,
    signal?: AbortSignal,
  ): Promise<{
    readonly state: DocumentLayersState;
    readonly row: DocumentLayersRow | null;
    readonly content_version: string | null;
  }> {
    if (document.schema_version !== 2 || !annotation_id)
      return { state: "none", row: null, content_version: null };
    const content_version = await archiveContentVersion(
      document.document_version_id,
      annotation_id,
    );
    const row = await this.row(
      {
        literature_id: document.source_material_ref.literature_id,
        asset_id: document.source_material_ref.asset_id,
        document_version_id: document.document_version_id,
        content_version,
      },
      signal,
    );
    if (row && (await this.current(row, signal)))
      return { state: row.status, row, content_version };
    // Layers of an earlier file version are stale, like another content version's.
    if (row) return { state: "stale", row: null, content_version };
    const other = await this.latest(
      document.source_material_ref.literature_id,
      signal,
    );
    return { state: other ? "stale" : "none", row: null, content_version };
  }
  /** `describe.layers`: the language of the translation part, if any. */
  async summary(
    document: DocumentRef,
    annotation_id: string | null,
    signal?: AbortSignal,
  ): Promise<DocumentLayersSummary> {
    const found = await this.lookup(document, annotation_id, signal);
    const row = found.row;
    // Given whenever the layers have a translation part; a superseded
    // translation file only makes the evidence positions fall back on read.
    const target =
      row?.status === "complete"
        ? (row.target_language as TranslationLanguage | null)
        : null;
    return {
      state: found.state,
      points: row?.status === "complete" ? row.point_count : 0,
      target_language: target,
      reason: row?.status === "not-applicable" ? row.reason : null,
    };
  }
}

export interface LayersStepInput {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  /** `from_step: layers`: redo everything. */
  readonly force: boolean;
}
type Usage = {
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
};
const addUsage = (a: Usage, b: UnitTranslationUsage) => {
  a.calls += b.calls;
  a.input_tokens =
    a.input_tokens === null || b.input_tokens === null
      ? null
      : a.input_tokens + b.input_tokens;
  a.output_tokens =
    a.output_tokens === null || b.output_tokens === null
      ? null
      : a.output_tokens + b.output_tokens;
};
/** The model is not configured: no call can be made (spec 10.3). */
class ModelUnavailable extends Error {
  constructor(options: ErrorOptions) {
    super("translation-model-unavailable", options);
  }
}
/** The calls of one build: usage, the model that answered, answers received. */
interface Calls {
  readonly usage: Usage;
  model: string | null;
  answered: number;
}
type Reply = Awaited<ReturnType<TranslationService["structured"]>>;
const halves = <T>(items: readonly T[]) => {
  const n = Math.ceil(items.length / 2);
  return [items.slice(0, n), items.slice(n)] as const;
};
type Part = { readonly index: number; readonly of: number } | null;
type Line = { statement: string; label: string | null };
type PartDropped = LayersTranslationPart["dropped"] extends infer D
  ? { -readonly [K in keyof D]: number }
  : never;

/** What the original calls made (spec 10.3), before the file is written. */
interface Original {
  readonly notes: readonly LayersNote[];
  readonly lines: ReadonlyMap<string | null, Line>;
  readonly document: CheckedDocument | null;
  readonly dropped: Dropped;
  readonly annotated: number;
  readonly primary: number;
  readonly summary_missing: boolean;
  readonly failed: boolean;
  readonly unavailable: boolean;
}

/** The archive step `layers` (ADR 0073, spec 10.3 to 10.5). */
export class DocumentLayersService {
  constructor(
    private readonly options: {
      readonly database: SqliteWorker;
      readonly files: FileStore;
      readonly store: DocumentLayersStore;
      readonly translations: DocumentTranslationStore;
      readonly model: Pick<TranslationService, "structured">;
      readonly metadata: (
        literatureId: string,
        signal?: AbortSignal,
      ) => Promise<{ readonly title: string | null }>;
    },
  ) {}
  get language() {
    return this.options.translations.language;
  }
  /** The current translation file of a content version, as the step's input key sees it. */
  async translationSha256(
    document_version_id: string,
    content_version: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return (
      (
        await this.options.translations.row(
          document_version_id,
          content_version,
          this.language,
          signal,
        )
      )?.sha256 ?? null
    );
  }
  async build(input: LayersStepInput, signal?: AbortSignal) {
    const { database, files, store, translations } = this.options;
    const language = translations.language;
    const fixed = await new SqliteDocumentStorage(
      database,
      files,
    ).withVerifiedDocument(
      input.document_version_id,
      async (version, markdown, structure) => ({
        version,
        markdown,
        structure,
      }),
      signal,
    );
    const { version, markdown } = fixed;
    const structure = fixed.structure as unknown as Structure;
    const unavailable = () =>
      new LayersStepError("layers-unavailable", {
        failure_code: "layers-not-archived",
      });
    if (
      version.schema_version !== 2 ||
      !isArrangedBuilder(version.builder_version) ||
      version.builder_version === LEGACY_ARRANGED_DOCUMENT_BUILDER ||
      version.source_material_ref.literature_id !== input.literature_id ||
      version.source_material_ref.asset_id !== input.asset_id
    )
      throw unavailable();
    const text = await new SqliteArchiveTextStorage(database, files).load(
      version.proofread_id,
      signal,
    );
    const annotation = await new SqliteAnnotationStorage(database, files).byId(
      input.annotation_id,
      signal,
    );
    if (
      !text?.bundle.arrangement ||
      !annotation ||
      annotation.document_version_id !== version.document_version_id
    )
      throw unavailable();
    const content_version = await archiveContentVersion(
      version.document_version_id,
      annotation.annotation_id,
    );
    const key = {
      literature_id: input.literature_id,
      asset_id: input.asset_id,
      document_version_id: version.document_version_id,
      annotation_id: annotation.annotation_id,
      content_version,
    };
    const usage: Usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
    const roles = new Map(
      annotation.segment_roles.map((s) => [s.segment_id, String(s.role)]),
    );
    const { units } = documentUnits(
      text.bundle,
      structure as never,
      markdown,
      roles,
    );
    const metadata = await this.options.metadata(input.literature_id, signal);
    const plan = layersPlan(units, structure, markdown, roles, metadata.title);
    const base = {
      document_version_id: version.document_version_id,
      annotation_id: annotation.annotation_id,
      content_version,
    };
    const stats = {
      pages: text.bundle.page_count,
      units: plan.paragraphs.size,
      annotatable: plan.annotatable,
      sections: plan.groups.length,
      figures: plan.figures.size,
      body_code_points: plan.body_code_points,
    };
    const result = (layers: Record<string, unknown>) => ({
      ...base,
      layers,
      usage: {
        ...usage,
        usage_complete:
          usage.input_tokens !== null && usage.output_tokens !== null,
      },
      stats: { ...stats, requested: usage.calls > 0 },
    });
    // Not applicable (spec 10.1): long documents first, then short papers.
    const reason: LayersNotApplicableReason | null = structure.long_document
      ? "long-document"
      : plan.body_code_points < LAYERS_MIN_CODE_POINTS
        ? "too-short"
        : null;
    if (reason) {
      await store.publishNotApplicable(key, reason, signal);
      return result({
        status: "not-applicable",
        reason,
        redone: "all",
        points: 0,
        sha256: null,
        translation: null,
      });
    }
    // The translation part needs the current translation of this content
    // version in another language than the paper's (spec 10.5).
    const translationRow = await translations.row(
      version.document_version_id,
      content_version,
      language,
      signal,
    );
    let translationFile: DocumentTranslationFile | null = null;
    if (translationRow && translationRow.status !== "same-language") {
      try {
        translationFile = await translations.load(translationRow, signal);
      } catch {
        translationFile = null;
      }
    }
    const existing = input.force ? null : await store.row(key, signal);
    let file: DocumentLayersFile | null = null;
    if (existing?.status === "complete") {
      try {
        file = await store.load(existing, signal);
      } catch {
        file = null;
      }
    }
    let redone: "all" | "translation" | "none" = "all";
    const calls: Calls = { usage, model: null, answered: 0 };
    if (file) {
      const wanted = translationFile ? translationRow!.sha256 : null;
      if (
        (file.translation?.translation_sha256 ?? null) === wanted &&
        (wanted === null || file.translation?.target_language === language)
      )
        redone = "none";
      else redone = "translation";
    } else {
      const failure = (made: Original | null) =>
        result({
          status: "failed",
          reason: null,
          redone,
          annotatable: plan.annotatable,
          annotated: made?.annotated ?? 0,
          points: made?.notes.length ?? 0,
          primary: made?.primary ?? 0,
          summary_missing: made?.summary_missing ?? true,
          ...(made ? { dropped: made.dropped } : {}),
          sha256: null,
          translation: null,
        });
      let made: Original;
      try {
        made = await this.original(plan, calls, signal);
      } catch (error) {
        if (error instanceof ModelUnavailable)
          throw new LayersStepError(
            "layers-unavailable",
            {
              ...failure(null),
              failure_code: "translation-model-unavailable",
            },
            { cause: error.cause },
          );
        throw error;
      }
      if (made.unavailable)
        throw new LayersStepError("layers-unavailable", failure(made));
      if (made.failed)
        throw new LayersStepError("layers-incomplete", failure(made));
      file = {
        schema_version: LAYERS_FILE_SCHEMA_VERSION,
        literature_id: input.literature_id,
        asset_id: input.asset_id,
        document_version_id: version.document_version_id,
        annotation_id: annotation.annotation_id,
        content_version,
        sentence_rule: SENTENCE_SPLIT_RULE,
        digest: made.document!.digest,
        sections: plan.groups.flatMap((g) => {
          const line = made.lines.get(g.section_id);
          return line ? [{ section_id: g.section_id, ...line }] : [];
        }),
        points: numberedPoints(made.notes, made.document),
        data: made.document!.data,
        model: calls.model ?? "unknown",
        prompt_version: READING_LAYERS_PROMPT_VERSION,
        dropped: made.dropped,
        translation: null,
      };
    }
    let translationSummary: Record<string, unknown> = {
      status: "not-needed",
      target_language: null,
    };
    const counts = (f: DocumentLayersFile) => ({
      annotatable: plan.annotatable,
      points: f.points.length,
      sections: f.sections.length,
      primary: f.points.filter((p) => p.primary).length,
      dropped: f.dropped,
    });
    if (redone !== "none") {
      let part: LayersTranslationPart | null = null;
      if (translationFile) {
        const made = await this.translationPart(
          file,
          plan,
          translationFile,
          translationRow!.sha256,
          markdown,
          usage,
          signal,
        );
        part = made.part;
        translationSummary = made.summary;
      }
      file = { ...file, translation: part };
      const row = await store.publish(file, signal);
      const output = result({
        status: "complete",
        reason: null,
        redone,
        ...counts(file),
        sha256: row.sha256,
        translation: translationSummary,
      });
      if (translationSummary.status === "incomplete")
        throw new LayersStepError("layers-translation-incomplete", output);
      return output;
    }
    return result({
      status: "complete",
      reason: null,
      redone,
      ...counts(file),
      sha256: existing!.sha256,
      translation: file.translation
        ? {
            status: "done",
            target_language: file.translation.target_language,
          }
        : translationSummary,
    });
  }
  /** One request; `ModelUnavailable` when no model can be asked at all. */
  private async call(
    request: {
      readonly system: string;
      readonly user: string;
      readonly media_type: "text/plain" | "application/json";
      readonly schema: Record<string, unknown>;
      readonly version: string;
      readonly language?: TranslationLanguage;
    },
    calls: Calls,
    signal?: AbortSignal,
  ): Promise<Reply> {
    let reply: Reply;
    try {
      reply = await this.options.model.structured(
        {
          system: request.system,
          user: request.user,
          media_type: request.media_type,
          schema: request.schema,
          input_sha256: sha(
            JSON.stringify([
              request.version,
              request.language ?? null,
              request.user,
            ]),
          ),
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof TranslationError &&
        error.code === "translation-model-unavailable"
      )
        throw new ModelUnavailable({ cause: error });
      throw error;
    }
    addUsage(calls.usage, reply.usage);
    calls.model = reply.model;
    if (reply.kind !== "failed") calls.answered++;
    return reply;
  }
  /** A section line from the notes of a section asked in parts: two attempts. */
  private async line(
    user: string,
    version: string,
    language: TranslationLanguage | undefined,
    dropped: { sections: number; labels: number },
    calls: Calls,
    signal?: AbortSignal,
  ): Promise<Line | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.call(
        {
          system: LAYERS_SECTION_LINE_SYSTEM,
          user,
          media_type: "text/plain",
          schema: LAYERS_SECTION_LINE_SCHEMA,
          version,
          ...(language ? { language } : {}),
        },
        calls,
        signal,
      );
      if (reply.kind !== "answer") continue;
      try {
        return checkLineAnswer(reply.value, dropped);
      } catch (error) {
        if (!(error instanceof LayersAnswerError)) throw error;
      }
    }
    dropped.sections++;
    return null;
  }
  /**
   * One run of a section (spec 10.3): an invalid answer is asked once more;
   * a cut-off one is split in halves, each asked as a part. A run that gets
   * no valid answer leaves its paragraphs without notes.
   */
  private async sectionRun(
    plan: LayersPlan,
    group: LayersGroup,
    paragraphs: readonly LayersParagraph[],
    part: Part,
    retries: number,
    dropped: Dropped,
    calls: Calls,
    signal?: AbortSignal,
  ): Promise<{ notes: LayersNote[]; line: Line | null; split: boolean }> {
    const reply = await this.call(
      {
        system: LAYERS_SECTION_SYSTEM,
        user: sectionInput(plan, group, paragraphs, part),
        media_type: "text/plain",
        schema: LAYERS_SECTION_SCHEMA,
        version: READING_LAYERS_SECTION_PROMPT_VERSION,
      },
      calls,
      signal,
    );
    if (reply.kind === "answer") {
      try {
        const checked = checkSectionAnswer(
          reply.value,
          group,
          paragraphs,
          part !== null,
          dropped,
        );
        return { notes: [...checked.notes], line: checked.line, split: false };
      } catch (error) {
        if (!(error instanceof LayersAnswerError)) throw error;
      }
    } else if (reply.kind === "truncated" && paragraphs.length > 1) {
      const runs = await Promise.all(
        halves(paragraphs).map((half, i) =>
          this.sectionRun(
            plan,
            group,
            half,
            part ?? { index: i + 1, of: 2 },
            1,
            dropped,
            calls,
            signal,
          ),
        ),
      );
      return { notes: runs.flatMap((r) => r.notes), line: null, split: true };
    }
    if (retries > 0)
      return this.sectionRun(
        plan,
        group,
        paragraphs,
        part,
        retries - 1,
        dropped,
        calls,
        signal,
      );
    dropped.unanswered += paragraphs.length;
    return { notes: [], line: null, split: false };
  }
  /**
   * The original version (spec 10.3): every section in parallel, then the
   * whole-document call over titles, lines and notes. The document call is
   * not made when the notes already cover less than two thirds.
   */
  private async original(
    plan: LayersPlan,
    calls: Calls,
    signal?: AbortSignal,
  ): Promise<Original> {
    const dropped = emptyDropped();
    const groups = await Promise.all(
      plan.groups.map(async (group) => {
        const split = group.parts.length > 1;
        const runs = await Promise.all(
          group.parts.map((paragraphs, i) =>
            this.sectionRun(
              plan,
              group,
              paragraphs,
              split ? { index: i + 1, of: group.parts.length } : null,
              1,
              dropped,
              calls,
              signal,
            ),
          ),
        );
        const notes = runs.flatMap((r) => r.notes);
        let line = !split && !runs[0]!.split ? runs[0]!.line : null;
        if ((split || runs[0]!.split) && notes.length)
          line = await this.line(
            sectionLineInput(
              plan,
              group,
              notes.map((n) => ({
                short: n.paragraph.short,
                statement: n.statement,
              })),
            ),
            READING_LAYERS_SECTION_PROMPT_VERSION,
            undefined,
            dropped,
            calls,
            signal,
          );
        return { section_id: group.section_id, notes, line };
      }),
    );
    const notes = groups
      .flatMap((g) => g.notes)
      .sort((a, b) => a.paragraph.start_utf8 - b.paragraph.start_utf8);
    const lines = new Map<string | null, Line>();
    for (const g of groups) if (g.line) lines.set(g.section_id, g.line);
    const annotated = notes.filter((n) => n.paragraph.annotatable).length;
    const covered = annotated * 3 >= plan.annotatable * 2 && notes.length > 0;
    const outcome = (
      document: CheckedDocument | null,
      unavailable: boolean,
    ): Original => {
      const primary = document?.primary.size ?? 0;
      const summary_missing = document?.summary_missing ?? true;
      return {
        notes,
        lines,
        document,
        dropped,
        annotated,
        primary,
        summary_missing,
        failed: !covered || summary_missing || primary < LAYERS_PRIMARY_MIN,
        unavailable,
      };
    };
    // No section call got any answer at all: the model is not reachable.
    if (!calls.answered) return outcome(null, true);
    if (!covered) return outcome(null, false);
    const numbers = new Map(notes.map((n, i) => [n.paragraph.short, i + 1]));
    const see = new Map(notes.map((n, i) => [i + 1, n.see.length ? 1 : 0]));
    const user = documentInput(
      plan,
      lines,
      new Map(notes.map((n) => [n.paragraph.unit_id, n])),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.call(
        {
          system: LAYERS_DOCUMENT_SYSTEM,
          user,
          media_type: "text/plain",
          schema: LAYERS_DOCUMENT_SCHEMA,
          version: READING_LAYERS_PROMPT_VERSION,
        },
        calls,
        signal,
      );
      if (reply.kind !== "answer") continue;
      try {
        return outcome(
          checkDocumentAnswer(reply.value, plan, numbers, see, dropped),
          false,
        );
      } catch (error) {
        if (!(error instanceof LayersAnswerError)) throw error;
      }
    }
    // The sections were answered: a digest that fails twice is incomplete.
    return outcome(null, false);
  }
  /**
   * The translation part (spec 10.5): each section's notes written directly
   * in the target language from the stored translation of its paragraphs,
   * then the digest from those notes. Kinds, the trunk, relations and data
   * values stay the original's. Evidence is aligned by a quote located in
   * the unit's stored translation.
   */
  private async translationPart(
    file: DocumentLayersFile,
    plan: LayersPlan,
    stored: DocumentTranslationFile,
    storedSha256: string,
    markdown: Uint8Array,
    usage: Usage,
    signal?: AbortSignal,
  ): Promise<{
    part: LayersTranslationPart | null;
    summary: Record<string, unknown>;
  }> {
    const language = stored.target_language;
    const calls: Calls = { usage, model: null, answered: 0 };
    const dropped: PartDropped = {
      points: 0,
      sections: 0,
      reasons: 0,
      labels: 0,
      key_terms: 0,
      evidence: 0,
      places: 0,
    };
    const unitText = new Map(
      stored.units
        .filter((u) => u.translation !== null)
        .map((u) => [u.unit_id, u.translation!]),
    );
    const pointOf = new Map(file.points.map((p) => [p.unit_id, p]));
    const notes = new Map<string, LayersTranslatedPoint>();
    const lines = new Map<string | null, LayersTranslatedLine>();
    const headings = new Map<string | null, string | null>();
    let unavailable = false;
    const ask = async (
      request: Parameters<DocumentLayersService["call"]>[0],
    ): Promise<Reply | null> => {
      if (unavailable) return null;
      try {
        return await this.call(request, calls, signal);
      } catch (error) {
        if (!(error instanceof ModelUnavailable)) throw error;
        unavailable = true;
        return null;
      }
    };
    const system = layersTranslationSectionSystem(language);
    const run = async (
      heading: string | null,
      asked: readonly TranslatedParagraph[],
      part: Part,
      retries: number,
    ): Promise<{ line: Line | null; split: boolean }> => {
      const reply = await ask({
        system,
        user: translationSectionInput(plan, heading, asked, markdown, part),
        media_type: "application/json",
        schema: LAYERS_TRANSLATION_SECTION_SCHEMA,
        version: READING_LAYERS_TRANSLATION_PROMPT_VERSION,
        language,
      });
      if (reply?.kind === "answer") {
        try {
          const checked = checkTranslationSectionAnswer(
            reply.value,
            asked,
            part !== null,
            dropped,
          );
          for (const [unit, point] of checked.points) notes.set(unit, point);
          return { line: checked.line, split: false };
        } catch (error) {
          if (!(error instanceof LayersAnswerError)) throw error;
        }
      } else if (reply?.kind === "truncated" && asked.length > 1) {
        await Promise.all(
          halves(asked).map((half, i) =>
            run(heading, half, part ?? { index: i + 1, of: 2 }, 1),
          ),
        );
        return { line: null, split: true };
      }
      if (reply && retries > 0) return run(heading, asked, part, retries - 1);
      dropped.points += asked.length;
      return { line: null, split: false };
    };
    await Promise.all(
      plan.groups.map(async (group) => {
        const heading = group.heading
          ? (unitText.get(group.heading.segment_id) ?? group.heading.line)
          : null;
        headings.set(group.section_id, heading);
        // A paragraph without a note, or missing in the stored translation, has none here.
        const asked: TranslatedParagraph[] = group.paragraphs.flatMap((p) => {
          const point = pointOf.get(p.unit_id),
            translation = unitText.get(p.unit_id);
          if (!point || !translation) return [];
          return [
            {
              paragraph: p,
              point,
              translation,
              evidence: point.evidence.flatMap((e, i) =>
                e.kind === "sentence" ? [i] : [],
              ),
            },
          ];
        });
        if (!asked.length) return;
        const parts = layersParts(asked, (t) => t.translation);
        const split = parts.length > 1;
        const runs = await Promise.all(
          parts.map((p, i) =>
            run(
              heading,
              p,
              split ? { index: i + 1, of: parts.length } : null,
              1,
            ),
          ),
        );
        let line = !split && !runs[0]!.split ? runs[0]!.line : null;
        if (split || runs[0]!.split) {
          const written = asked.flatMap((t) => {
            const n = notes.get(t.paragraph.unit_id);
            return n
              ? [{ short: t.paragraph.short, statement: n.statement }]
              : [];
          });
          if (written.length && !unavailable)
            try {
              line = await this.line(
                sectionLineInput(plan, group, written, heading),
                READING_LAYERS_TRANSLATION_PROMPT_VERSION,
                language,
                dropped,
                calls,
                signal,
              );
            } catch (error) {
              if (!(error instanceof ModelUnavailable)) throw error;
              unavailable = true;
            }
        }
        if (line) lines.set(group.section_id, line);
      }),
    );
    let document: ReturnType<typeof checkTranslationDocumentAnswer> | null =
      null;
    const user = translationDocumentInput(
      plan,
      file,
      plan.groups.flatMap((g) => {
        const written = g.paragraphs.flatMap((p) => {
          const n = notes.get(p.unit_id);
          return n ? [{ id: p.short, note: n.statement }] : [];
        });
        const line = lines.get(g.section_id)?.statement ?? null;
        return written.length || line
          ? [
              {
                heading: headings.get(g.section_id) ?? null,
                line,
                notes: written,
              },
            ]
          : [];
      }),
    );
    for (let attempt = 0; attempt < 2 && !document; attempt++) {
      const reply = await ask({
        system: layersTranslationDocumentSystem(language),
        user,
        media_type: "application/json",
        schema: LAYERS_TRANSLATION_DOCUMENT_SCHEMA,
        version: READING_LAYERS_TRANSLATION_PROMPT_VERSION,
        language,
      });
      if (reply?.kind !== "answer") continue;
      try {
        document = checkTranslationDocumentAnswer(reply.value, file, dropped);
      } catch (error) {
        if (!(error instanceof LayersAnswerError)) throw error;
      }
    }
    const digest: LayersTranslationPart["digest"] = document?.digest ?? {
      summary: { text: null, key_terms: [] },
      limits: file.digest.limits.map(() => null),
      advice: {
        text: null,
        key_terms: [],
        places: file.digest.advice.places.map(() => null),
      },
    };
    const data = document?.data ?? file.data.map(() => null);
    const points = file.points.map((p) => notes.get(p.unit_id) ?? null);
    const sections = file.sections.map((s) => lines.get(s.section_id) ?? null);
    const digestTexts = [
      digest.summary.text,
      ...digest.limits,
      ...(file.digest.advice.text === null ? [] : [digest.advice.text]),
      ...data,
    ];
    const translatedPoints = points.filter((p) => p !== null).length,
      translatedSections = sections.filter((s) => s !== null).length,
      translatedDigest = digestTexts.filter((t) => t !== null).length;
    const evidence = file.points.reduce(
      (n, p) => n + p.evidence.filter((e) => e.kind === "sentence").length,
      0,
    );
    const aligned = points.reduce(
      (n, p) => n + (p?.evidence.filter((e) => e !== null).length ?? 0),
      0,
    );
    const done =
      translatedPoints + translatedSections + translatedDigest > 0 &&
      calls.model !== null;
    const summary = {
      status: done ? "done" : "incomplete",
      target_language: language,
      translation_sha256: storedSha256,
      points: file.points.length,
      translated_points: translatedPoints,
      sections: file.sections.length,
      translated_sections: translatedSections,
      digest: digestTexts.length,
      translated_digest: translatedDigest,
      evidence,
      aligned,
      dropped,
    };
    // A part where nothing was written is not made (spec 10.5).
    if (!done) return { part: null, summary };
    return {
      part: {
        target_language: language,
        translation_sha256: storedSha256,
        model: calls.model!,
        prompt_version: READING_LAYERS_TRANSLATION_PROMPT_VERSION,
        digest,
        sections,
        points,
        data,
        dropped,
      },
      summary,
    };
  }
}
