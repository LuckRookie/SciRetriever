import { createHash } from "node:crypto";
import {
  LAYERS_DIGEST_ITEMS,
  LAYERS_DIGEST_TEXT_MAX,
  LAYERS_DIGEST_UNITS,
  LAYERS_EVIDENCE_PER_POINT,
  LAYERS_EVIDENCE_SENTENCES,
  LAYERS_KEY_TERM_MAX,
  LAYERS_KEY_TERMS_PER_ITEM,
  LAYERS_MIN_CODE_POINTS,
  LAYERS_NOT_GIVEN_MAX,
  LAYERS_POINTS_MAX,
  LAYERS_POINTS_MIN,
  LAYERS_STATEMENT_MAX,
  LAYERS_TRANSLATION_TEXT_MAX,
  READING_LAYERS_PROMPT_VERSION,
  READING_LAYERS_TRANSLATION_PROMPT_VERSION,
  SENTENCE_SPLIT_RULE,
  archiveContentVersion,
  canonicalJsonBytes,
  matchKeyTerm,
  parseArtifactRef,
  parseDocumentLayersFile,
  splitSentences,
  utf8Offset,
  type DocumentLayout,
  type DocumentLayersFile,
  type DocumentLayersState,
  type DocumentLayersSummary,
  type DocumentRef,
  type DocumentTranslationFile,
  type LayersDigest,
  type LayersDigestItem,
  type LayersDigestItemName,
  type LayersEvidence,
  type LayersNotApplicableReason,
  type LayersPoint,
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
  unitSpan,
  type DocumentTranslationStore,
} from "../translation/document.js";
import {
  TranslationError,
  type TranslationService,
  type UnitTranslationUsage,
} from "../translation/service.js";
import {
  LAYERS_SCHEMA,
  LAYERS_SYSTEM,
  LAYERS_TRANSLATION_SCHEMA,
  layersTranslationSystem,
} from "./prompt.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const codePoints = (s: string) => [...s].length;
const flat = (s: string) => s.replace(/\s+/gu, " ").trim();

interface Segment {
  readonly segment_id: string;
  readonly kind: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
  readonly section_id?: string | null;
}
interface Section {
  readonly section_id: string;
  readonly title: string | null;
  readonly level: number;
}
interface Structure {
  readonly segments: readonly Segment[];
  readonly sections: readonly Section[];
  readonly layout?: DocumentLayout;
  readonly long_document?: unknown;
}

/** A paragraph of the first call's input: a translation unit that is not a heading. */
export interface LayersUnit {
  readonly short: string;
  readonly unit_id: string;
  readonly source: string;
  /** UTF-8 position of the unit's text in the fixed Markdown. */
  readonly start_utf8: number;
  /** Sentences as JavaScript indices of `source` and UTF-8 offsets from `start_utf8`. */
  readonly sentences: readonly {
    readonly start: number;
    readonly end: number;
    readonly start_utf8: number;
    readonly end_utf8: number;
  }[];
}
export interface LayersFigure {
  readonly short: string;
  readonly segment_id: string;
  readonly kind: "figure" | "scheme" | "table";
  readonly start_utf8: number;
  readonly caption: string | null;
}
export interface LayersInput {
  readonly text: string;
  readonly units: ReadonlyMap<string, LayersUnit>;
  readonly figures: ReadonlyMap<string, LayersFigure>;
  readonly body_code_points: number;
}

/** A figure group's captions as one line of text. */
export function figureCaption(
  markdown: Uint8Array,
  group: DocumentLayout["figure_groups"][number],
): string | null {
  const text = group.captions
    .map((c) => {
      try {
        return decoder.decode(markdown.subarray(c.start_utf8, c.end_utf8));
      } catch {
        return "";
      }
    })
    .join(" ");
  return flat(text) || null;
}
/** Sentences of a unit (spec 3.5); captions are one sentence. */
export function unitSentences(source: string, kind: string) {
  return splitSentences(source, { whole: kind === "caption" }).map((s) => ({
    ...s,
    start_utf8: utf8Offset(source, s.start),
    end_utf8: utf8Offset(source, s.end),
  }));
}

/**
 * The first call's input (spec 10.3): the readable content in order, each
 * paragraph with a short id and numbered sentences, each figure, scheme or
 * table one line with its caption, headings kept as heading lines. Units
 * are those of the translation (spec 9.2); a caption of a figure group is
 * given with its figure, not as a paragraph.
 */
export function layersInput(
  units: ReturnType<typeof documentUnits>["units"],
  structure: Structure,
  markdown: Uint8Array,
  title: string | null,
  maxPoints: number,
): LayersInput {
  const segments = new Map(structure.segments.map((s) => [s.segment_id, s]));
  const sections = new Map(structure.sections.map((s) => [s.section_id, s]));
  const groups = structure.layout?.figure_groups ?? [];
  const captions = new Set(
    groups.flatMap((g) => g.captions.map((c) => c.segment_id)),
  );
  type Item =
    | { at: number; heading: string }
    | { at: number; unit: Omit<LayersUnit, "short"> }
    | { at: number; figure: Omit<LayersFigure, "short"> };
  const items: Item[] = [];
  let body = 0;
  for (const u of units) {
    const found = u.segment_ids.map((id) => segments.get(id)!);
    const first = found[0]!;
    const span = unitSpan(markdown, found, u.source_sha256);
    if (!span) continue;
    if (first.kind === "heading") {
      const level = sections.get(first.section_id ?? "")?.level ?? 1;
      items.push({
        at: span.start,
        heading: `${"#".repeat(Math.min(6, Math.max(1, level)))} ${flat(u.source)}`,
      });
      continue;
    }
    body += codePoints(u.source);
    if (captions.has(u.unit_id)) continue;
    items.push({
      at: span.payload,
      unit: {
        unit_id: u.unit_id,
        source: u.source,
        start_utf8: span.payload,
        sentences: unitSentences(u.source, first.kind),
      },
    });
  }
  for (const g of groups) {
    const object = g.objects[0];
    if (!object) continue;
    items.push({
      at: object.start_utf8,
      figure: {
        segment_id: object.segment_id,
        kind: g.kind,
        start_utf8: object.start_utf8,
        caption: figureCaption(markdown, g),
      },
    });
  }
  items.sort((a, b) => a.at - b.at);
  const unitMap = new Map<string, LayersUnit>(),
    figureMap = new Map<string, LayersFigure>();
  const lines = [
    `Maximum number of points: ${maxPoints}`,
    "",
    `Title: ${title ? flat(title) : "(none)"}`,
    "",
  ];
  for (const item of items) {
    if ("heading" in item) lines.push("", item.heading, "");
    else if ("unit" in item) {
      const short = `p${unitMap.size + 1}`;
      unitMap.set(short, { short, ...item.unit });
      lines.push(
        `[${short}] ${item.unit.sentences
          .map(
            (s, i) =>
              `<${i + 1}> ${flat(item.unit.source.slice(s.start, s.end))}`,
          )
          .join(" ")}`,
      );
    } else {
      const short = `f${figureMap.size + 1}`;
      figureMap.set(short, { short, ...item.figure });
      lines.push(
        `[${short}] ${item.figure.kind}: ${item.figure.caption ?? "(no caption)"}`,
      );
    }
  }
  return {
    text:
      lines
        .join("\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim() + "\n",
    units: unitMap,
    figures: figureMap,
    body_code_points: body,
  };
}

export class LayersAnswerError extends Error {
  constructor() {
    super("layers-answer-invalid");
  }
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Key terms kept: found in their text by key-term-match-v1, at most two. */
function keepTerms(text: string, terms: readonly string[]) {
  const kept: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (
      !term ||
      codePoints(term) > LAYERS_KEY_TERM_MAX ||
      kept.some((k) => k.toLowerCase() === term.toLowerCase()) ||
      !matchKeyTerm(text, term).length
    )
      continue;
    if (kept.length < LAYERS_KEY_TERMS_PER_ITEM) kept.push(term);
  }
  return { kept, dropped: terms.length - kept.length };
}
/** Sentence numbers of "pN.S", "pN.S-T" or "pN.S,T": consecutive, 1 to 4. */
function sentenceList(spec: string): number[] | null {
  const numbers: number[] = [];
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/u.exec(part);
    if (!m) return null;
    const a = Number(m[1]),
      b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b - a > 10) return null;
    for (let n = a; n <= b; n++) numbers.push(n);
  }
  return numbers;
}
export interface CheckedLayers {
  readonly digest: LayersDigest;
  readonly points: readonly LayersPoint[];
  readonly given: number;
  /** Points left before the cap of 40; the success rule compares this with `given`. */
  readonly valid: number;
  readonly dropped: DocumentLayersFile["dropped"];
  readonly nature_missing: boolean;
}

/**
 * The program check of the first call's answer (spec 10.3): evidence that
 * names a missing paragraph, sentence or figure, or more than four or
 * non-consecutive sentences, is dropped; a point left without evidence, or
 * with an empty or overlong statement, is dropped; the rest are ordered by
 * their first evidence and numbered again. Throws LayersAnswerError when the
 * answer is not the structure asked for.
 */
export function checkLayersAnswer(
  value: unknown,
  input: LayersInput,
  segments: readonly Segment[],
  titled: boolean,
): CheckedLayers {
  if (
    !isRecord(value) ||
    !isRecord(value.digest) ||
    !Array.isArray(value.points)
  )
    throw new LayersAnswerError();
  const answerDigest = value.digest;
  if (!LAYERS_DIGEST_ITEMS.every((n) => isRecord(answerDigest[n])))
    throw new LayersAnswerError();
  let droppedEvidence = 0,
    droppedTerms = 0,
    droppedUnits = 0;
  const digest = Object.fromEntries(
    LAYERS_DIGEST_ITEMS.map(
      (name): [LayersDigestItemName, LayersDigestItem] => {
        const item = answerDigest[name] as Record<string, unknown>;
        const raw = typeof item.text === "string" ? item.text.trim() : "";
        const text =
          raw && codePoints(raw) <= LAYERS_DIGEST_TEXT_MAX ? raw : null;
        const notGiven =
          typeof item.not_given === "string" ? item.not_given.trim() : "";
        const unitIds: string[] = [];
        const askedUnits = strings(item.units);
        for (const short of askedUnits) {
          const unit = input.units.get(short.trim());
          if (
            unit &&
            !unitIds.includes(unit.unit_id) &&
            unitIds.length < LAYERS_DIGEST_UNITS
          )
            unitIds.push(unit.unit_id);
        }
        droppedUnits += askedUnits.length - unitIds.length;
        const askedTerms = strings(item.key_terms);
        const terms = text
          ? keepTerms(text, askedTerms)
          : { kept: [], dropped: askedTerms.length };
        droppedTerms += terms.dropped;
        return [
          name,
          {
            text,
            not_given:
              text === null &&
              notGiven &&
              codePoints(notGiven) <= LAYERS_NOT_GIVEN_MAX
                ? notGiven
                : null,
            units: text === null ? [] : unitIds,
            key_terms: terms.kept,
          },
        ];
      },
    ),
  ) as unknown as LayersDigest;
  const sorted = [...segments].sort((a, b) => a.start_utf8 - b.start_utf8);
  const sectionAt = (at: number) => {
    if (!titled) return null;
    let found: Segment | undefined;
    for (const s of sorted) {
      if (s.start_utf8 > at) break;
      found = s;
    }
    return found?.section_id ?? null;
  };
  const given = value.points.length;
  const kept: (Omit<LayersPoint, "number"> & { at: number })[] = [];
  for (const raw of value.points) {
    if (!isRecord(raw) || typeof raw.statement !== "string")
      throw new LayersAnswerError();
    const statement = raw.statement.trim();
    const asked = strings(raw.evidence);
    const evidence: (LayersEvidence & { at: number })[] = [];
    for (const spec of asked) {
      const sentence = /^\s*(p\d+)\s*[.:·]\s*([\d,\s–-]+?)\s*$/iu.exec(spec);
      const figure = /^\s*(f\d+)\s*$/iu.exec(spec);
      let found: (LayersEvidence & { at: number }) | null = null;
      if (sentence) {
        const unit = input.units.get(sentence[1]!.toLowerCase());
        const numbers = sentenceList(sentence[2]!);
        if (
          unit &&
          numbers &&
          numbers.length >= 1 &&
          numbers.length <= LAYERS_EVIDENCE_SENTENCES &&
          numbers.every((n, k) => k === 0 || n === numbers[k - 1]! + 1) &&
          numbers[0]! >= 1 &&
          numbers.at(-1)! <= unit.sentences.length
        ) {
          const a = unit.sentences[numbers[0]! - 1]!,
            b = unit.sentences[numbers.at(-1)! - 1]!;
          found = {
            kind: "sentence",
            unit_id: unit.unit_id,
            start_utf8: unit.start_utf8 + a.start_utf8,
            end_utf8: unit.start_utf8 + b.end_utf8,
            at: unit.start_utf8 + a.start_utf8,
          };
        }
      } else if (figure) {
        const f = input.figures.get(figure[1]!.toLowerCase());
        if (f)
          found = { kind: "block", segment_id: f.segment_id, at: f.start_utf8 };
      }
      const identity = (e: LayersEvidence) =>
        e.kind === "block"
          ? `b:${e.segment_id}`
          : `s:${e.start_utf8}:${e.end_utf8}`;
      if (
        !found ||
        evidence.some((e) => identity(e) === identity(found)) ||
        evidence.length >= LAYERS_EVIDENCE_PER_POINT
      ) {
        droppedEvidence++;
        continue;
      }
      evidence.push(found);
    }
    if (
      !evidence.length ||
      !statement ||
      codePoints(statement) > LAYERS_STATEMENT_MAX
    ) {
      // Evidence of a dropped point is not counted again.
      continue;
    }
    evidence.sort((a, b) => a.at - b.at);
    const terms = keepTerms(statement, strings(raw.key_terms));
    droppedTerms += terms.dropped;
    kept.push({
      statement,
      evidence: evidence.map(
        (e): LayersEvidence =>
          e.kind === "block"
            ? { kind: "block", segment_id: e.segment_id }
            : {
                kind: "sentence",
                unit_id: e.unit_id,
                start_utf8: e.start_utf8,
                end_utf8: e.end_utf8,
              },
      ),
      key_terms: terms.kept,
      section_id: sectionAt(evidence[0]!.at),
      at: evidence[0]!.at,
    });
  }
  kept.sort((a, b) => a.at - b.at);
  const valid = kept.length;
  const points = kept.slice(0, LAYERS_POINTS_MAX).map((p, i) => ({
    number: i + 1,
    statement: p.statement,
    evidence: p.evidence,
    key_terms: p.key_terms,
    section_id: p.section_id,
  }));
  return {
    digest,
    points,
    given,
    valid,
    dropped: {
      evidence: droppedEvidence,
      points: given - points.length,
      key_terms: droppedTerms,
      digest_units: droppedUnits,
    },
    nature_missing: digest.nature.text === null,
  };
}

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
  async load(
    row: DocumentLayersRow,
    signal?: AbortSignal,
  ): Promise<DocumentLayersFile> {
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
    if (row) return { state: row.status, row, content_version };
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

/** The archive step `layers` (ADR 0069, spec 10.3 to 10.5). */
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
    const prepared = layersInput(
      units,
      structure,
      markdown,
      metadata.title,
      LAYERS_POINTS_MAX,
    );
    const base = {
      document_version_id: version.document_version_id,
      annotation_id: annotation.annotation_id,
      content_version,
    };
    const stats = {
      pages: text.bundle.page_count,
      units: prepared.units.size,
      figures: prepared.figures.size,
      body_code_points: prepared.body_code_points,
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
      : prepared.body_code_points < LAYERS_MIN_CODE_POINTS
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
    let checked: CheckedLayers | null = null,
      model = "unknown";
    if (file) {
      const wanted = translationFile ? translationRow!.sha256 : null;
      if (
        (file.translation?.translation_sha256 ?? null) === wanted &&
        (wanted === null || file.translation?.target_language === language)
      )
        redone = "none";
      else redone = "translation";
    } else {
      const first = await this.firstCall(prepared, structure, usage, signal);
      checked = first.checked;
      model = first.model ?? model;
      if (first.unavailable)
        throw new LayersStepError(
          "layers-unavailable",
          result({
            status: "failed",
            reason: null,
            redone,
            given: 0,
            points: 0,
            sha256: null,
            translation: null,
          }),
        );
      const failed =
        checked.nature_missing ||
        checked.valid < LAYERS_POINTS_MIN ||
        checked.valid * 2 < checked.given;
      const counts = {
        given: checked.given,
        points: checked.points.length,
        dropped: checked.dropped,
      };
      if (failed)
        throw new LayersStepError(
          "layers-incomplete",
          result({
            status: "failed",
            reason: null,
            redone,
            ...counts,
            nature_missing: checked.nature_missing,
            sha256: null,
            translation: null,
          }),
        );
      file = {
        schema_version: 1,
        literature_id: input.literature_id,
        asset_id: input.asset_id,
        document_version_id: version.document_version_id,
        annotation_id: annotation.annotation_id,
        content_version,
        sentence_rule: SENTENCE_SPLIT_RULE,
        digest: checked.digest,
        points: checked.points,
        model,
        prompt_version: READING_LAYERS_PROMPT_VERSION,
        dropped: checked.dropped,
        translation: null,
      };
    }
    let translationSummary: Record<string, unknown> = {
      status: "not-needed",
      target_language: null,
    };
    if (redone !== "none") {
      let part: LayersTranslationPart | null = null;
      if (translationFile) {
        const made = await this.translationPart(
          file,
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
        given: checked?.given ?? file.points.length,
        points: file.points.length,
        dropped: file.dropped,
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
      given: file.points.length,
      points: file.points.length,
      dropped: file.dropped,
      sha256: existing!.sha256,
      translation: file.translation
        ? {
            status: "done",
            target_language: file.translation.target_language,
          }
        : translationSummary,
    });
  }
  /**
   * Two attempts at most: an invalid structure or a cut-off answer is asked
   * once more, a cut-off one for half the points. `unavailable` when no
   * attempt got any answer at all.
   */
  private async firstCall(
    prepared: LayersInput,
    structure: Structure,
    usage: Usage,
    signal?: AbortSignal,
  ): Promise<{
    checked: CheckedLayers;
    model: string | null;
    unavailable: boolean;
  }> {
    let max = LAYERS_POINTS_MAX,
      input = prepared.text,
      model: string | null = null,
      answered = false;
    const titled = structure.sections.some((s) => s.title !== null);
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer;
      try {
        answer = await this.options.model.structured(
          {
            system: LAYERS_SYSTEM,
            user: input,
            media_type: "text/plain",
            schema: LAYERS_SCHEMA,
            input_sha256: sha(
              JSON.stringify([READING_LAYERS_PROMPT_VERSION, input]),
            ),
          },
          signal,
        );
      } catch (error) {
        if (
          error instanceof TranslationError &&
          error.code === "translation-model-unavailable"
        )
          throw new LayersStepError(
            "layers-unavailable",
            { usage: { ...usage } },
            { cause: error },
          );
        throw error;
      }
      addUsage(usage, answer.usage);
      model = answer.model;
      if (answer.kind !== "failed") answered = true;
      if (answer.kind === "answer") {
        try {
          return {
            checked: checkLayersAnswer(
              answer.value,
              prepared,
              structure.segments,
              titled,
            ),
            model,
            unavailable: false,
          };
        } catch (error) {
          if (!(error instanceof LayersAnswerError)) throw error;
        }
      } else if (answer.kind === "truncated" && attempt === 0) {
        // Asked once more for half the points (spec 10.3).
        max = Math.max(LAYERS_POINTS_MIN, Math.floor(max / 2));
        input = input.replace(
          /^Maximum number of points: \d+/u,
          `Maximum number of points: ${max}`,
        );
      }
    }
    return {
      checked: {
        digest: emptyDigest,
        points: [],
        given: 0,
        valid: 0,
        dropped: { evidence: 0, points: 0, key_terms: 0, digest_units: 0 },
        nature_missing: true,
      },
      model,
      unavailable: !answered,
    };
  }
  /**
   * The second call (spec 10.5): the machine-written texts translated,
   * their key terms' renderings found in the translation, and each sentence
   * evidence aligned with sentences of its unit's stored translation.
   */
  private async translationPart(
    file: DocumentLayersFile,
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
    const unitText = new Map(
      stored.units
        .filter((u) => u.translation !== null)
        .map((u) => [u.unit_id, u.translation!]),
    );
    const shortUnits = new Map<string, string>();
    const unitSentenceCache = new Map<
      string,
      ReturnType<typeof unitSentences>
    >();
    const sentencesOf = (unit_id: string) => {
      let s = unitSentenceCache.get(unit_id);
      if (!s) {
        s = unitSentences(unitText.get(unit_id)!, "text");
        unitSentenceCache.set(unit_id, s);
      }
      return s;
    };
    const items: Record<string, unknown>[] = [];
    for (const name of LAYERS_DIGEST_ITEMS) {
      const d = file.digest[name];
      if (d.text !== null)
        items.push({ id: `d-${name}`, text: d.text, key_terms: d.key_terms });
    }
    let evidenceTotal = 0;
    for (const p of file.points) {
      const evidence: Record<string, unknown>[] = [];
      p.evidence.forEach((e, i) => {
        if (e.kind !== "sentence") return;
        evidenceTotal++;
        if (!unitText.has(e.unit_id)) return;
        let short = shortUnits.get(e.unit_id);
        if (!short) {
          short = `u${shortUnits.size + 1}`;
          shortUnits.set(e.unit_id, short);
        }
        evidence.push({
          id: `e${p.number}-${i + 1}`,
          unit: short,
          original: flat(
            decoder.decode(markdown.subarray(e.start_utf8, e.end_utf8)),
          ),
        });
      });
      items.push({
        id: `k${p.number}`,
        text: p.statement,
        key_terms: p.key_terms,
        evidence,
      });
    }
    const body = {
      items,
      units: [...shortUnits].map(([unit_id, short]) => ({
        id: short,
        sentences: sentencesOf(unit_id).map((s, i) => ({
          n: i + 1,
          text: flat(unitText.get(unit_id)!.slice(s.start, s.end)),
        })),
      })),
    };
    const user = JSON.stringify(body);
    let answer: Map<string, Record<string, unknown>> | null = null;
    let model: string | null = null;
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      let reply;
      try {
        reply = await this.options.model.structured(
          {
            system: layersTranslationSystem(language),
            user,
            media_type: "application/json",
            schema: LAYERS_TRANSLATION_SCHEMA,
            input_sha256: sha(
              JSON.stringify([
                READING_LAYERS_TRANSLATION_PROMPT_VERSION,
                language,
                user,
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
          break;
        throw error;
      }
      addUsage(usage, reply.usage);
      model = reply.model;
      if (
        reply.kind === "answer" &&
        isRecord(reply.value) &&
        Array.isArray(reply.value.items)
      ) {
        answer = new Map();
        for (const item of reply.value.items)
          if (
            isRecord(item) &&
            typeof item.id === "string" &&
            !answer.has(item.id)
          )
            answer.set(item.id, item);
      }
    }
    let droppedTerms = 0,
      droppedEvidence = 0,
      aligned = 0,
      translated = 0;
    const translate = (
      id: string,
      terms: readonly string[],
    ): { text: string | null; key_terms: (string | null)[] } => {
      const item = answer?.get(id);
      const raw =
        typeof item?.translation === "string" ? item.translation.trim() : "";
      const text =
        raw && codePoints(raw) <= LAYERS_TRANSLATION_TEXT_MAX ? raw : null;
      if (text) translated++;
      const given = Array.isArray(item?.key_terms) ? item.key_terms : [];
      const key_terms = terms.map((term) => {
        const hit = given.find(
          (g): g is Record<string, unknown> =>
            isRecord(g) &&
            typeof g.term === "string" &&
            g.term.trim().toLowerCase() === term.toLowerCase(),
        );
        const target =
          typeof hit?.translation === "string" ? hit.translation.trim() : "";
        if (
          text &&
          target &&
          codePoints(target) <= LAYERS_KEY_TERM_MAX &&
          matchKeyTerm(text, target).length
        )
          return target;
        droppedTerms++;
        return null;
      });
      return { text, key_terms };
    };
    const digest = Object.fromEntries(
      LAYERS_DIGEST_ITEMS.map((name) => [
        name,
        file.digest[name].text === null
          ? { text: null, key_terms: [] }
          : translate(`d-${name}`, file.digest[name].key_terms),
      ]),
    ) as unknown as LayersTranslationPart["digest"];
    const points = file.points.map((p) => {
      const t = translate(`k${p.number}`, p.key_terms);
      const item = answer?.get(`k${p.number}`);
      const given = Array.isArray(item?.evidence) ? item.evidence : [];
      const evidence = p.evidence.map((e, i) => {
        if (e.kind !== "sentence" || !unitText.has(e.unit_id)) return null;
        const hit = given.find(
          (g): g is Record<string, unknown> =>
            isRecord(g) && g.id === `e${p.number}-${i + 1}`,
        );
        const numbers = Array.isArray(hit?.sentences)
          ? hit.sentences.filter((n): n is number => Number.isSafeInteger(n))
          : [];
        const sentences = sentencesOf(e.unit_id);
        const ok =
          numbers.length >= 1 &&
          numbers.length ===
            (Array.isArray(hit?.sentences) ? hit.sentences.length : 0) &&
          numbers.every((n, k) => k === 0 || n === numbers[k - 1]! + 1) &&
          numbers[0]! >= 1 &&
          numbers.at(-1)! <= sentences.length;
        if (!ok) {
          droppedEvidence++;
          return null;
        }
        aligned++;
        return {
          start_utf8: sentences[numbers[0]! - 1]!.start_utf8,
          end_utf8: sentences[numbers.at(-1)! - 1]!.end_utf8,
        };
      });
      return { ...t, evidence };
    });
    const total = items.length;
    const summary = {
      status: translated ? "done" : "incomplete",
      target_language: language,
      translation_sha256: storedSha256,
      items: total,
      translated,
      key_terms_dropped: droppedTerms,
      evidence: evidenceTotal,
      aligned,
      evidence_dropped: droppedEvidence,
    };
    // A part where nothing was translated is not made (spec 10.5).
    if (!translated || !model) return { part: null, summary };
    return {
      part: {
        target_language: language,
        translation_sha256: storedSha256,
        model,
        prompt_version: READING_LAYERS_TRANSLATION_PROMPT_VERSION,
        digest,
        points,
        dropped: { key_terms: droppedTerms, evidence: droppedEvidence },
      },
      summary,
    };
  }
}
const emptyDigest = Object.fromEntries(
  LAYERS_DIGEST_ITEMS.map((n) => [
    n,
    { text: null, not_given: null, units: [], key_terms: [] },
  ]),
) as unknown as LayersDigest;
