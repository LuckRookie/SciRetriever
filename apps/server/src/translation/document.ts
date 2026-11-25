import { createHash } from "node:crypto";
import {
  DOCUMENT_TRANSLATION_PROMPT_VERSION,
  TRANSLATION_BATCH_MAX_CODE_POINTS,
  TRANSLATION_BATCH_MAX_UNITS,
  archiveContentVersion,
  canonicalJsonBytes,
  parseArtifactRef,
  parseDocumentTranslationFile,
  type ArchiveTextBundleV2,
  type DocumentRef,
  type DocumentTranslationFile,
  type DocumentTranslationState,
  type DocumentTranslationUnit,
  type TranslationLanguage,
} from "@sciretriever/contracts";
import { arrangeSourceLayout } from "../archive/source-layout.js";
import {
  LEGACY_ARRANGED_DOCUMENT_BUILDER,
  isArrangedBuilder,
} from "../archive/render.js";
import type { VerifiedDocumentStructure } from "../document/verification-cache.js";
import { SqliteDocumentStorage } from "../document/storage.js";
import { artifactReference } from "../storage/artifact-layout.js";
import { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import type { FileStore } from "../storage/files/store.js";
import type { DocumentTranslationRow } from "../storage/sqlite/document-translation-engine.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import {
  TranslationError,
  mathSpans,
  type TranslationService,
  type UnitTranslationUsage,
} from "./service.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Leaf types translated (spec 9.2); formulas, tables, images and references keep the print. */
export const TRANSLATED_UNIT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "title",
  "caption",
  "list",
  "footnote",
]);
const KEPT_ROLES: ReadonlySet<string> = new Set(["authors", "references"]);

export interface SourceUnit {
  readonly unit_id: string;
  readonly segment_ids: readonly string[];
  readonly source: string;
  readonly source_sha256: string;
  readonly section_id: string | null;
}
interface Segment {
  readonly segment_id: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
  readonly section_id?: string | null;
  readonly page?: number;
}

/**
 * Where a unit's text lies in the fixed Markdown: from its first segment to
 * its last, joiners included. A heading segment begins with its marker, which
 * stays structure. null when the bytes are not the unit's source.
 */
export function unitSpan(
  markdown: Uint8Array,
  segments: readonly Pick<Segment, "start_utf8" | "end_utf8">[],
  sourceSha256: string,
): { start: number; payload: number; end: number } | null {
  const start = segments[0]?.start_utf8,
    end = segments.at(-1)?.end_utf8;
  if (start === undefined || end === undefined || end <= start) return null;
  let text: string;
  try {
    text = decoder.decode(markdown.subarray(start, end));
  } catch {
    return null;
  }
  if (sha(text) === sourceSha256) return { start, payload: start, end };
  const marker = /^#{1,6} /u.exec(text);
  if (marker && sha(text.slice(marker[0].length)) === sourceSha256)
    return { start, payload: start + Buffer.byteLength(marker[0]), end };
  return null;
}

/**
 * The translation units of a fixed proofread document (spec 9.2): each
 * rendered paragraph, a merged paragraph being one unit whose text joins its
 * leaves with the render joiners. Authors, references and the first-page
 * article information (affiliations, correspondence, dates) keep the print.
 */
export function documentUnits(
  bundle: ArchiveTextBundleV2,
  structure: { readonly segments: readonly Segment[] },
  markdown: Uint8Array,
  roles: ReadonlyMap<string, string>,
): { units: SourceUnit[]; unmatched: number } {
  if (!bundle.arrangement)
    throw new TranslationError("translation-not-archived");
  const layout = arrangeSourceLayout(bundle),
    rows = new Map(bundle.leaves.map((r) => [r.leaf.leaf_id, r])),
    segments = new Map(structure.segments.map((s) => [s.segment_id, s]));
  const units: SourceUnit[] = [];
  let unmatched = 0;
  for (const node of layout.nodes) {
    const first = rows.get(node.leaf_ids[0]!)!;
    const role =
      roles.get(first.leaf.leaf_id) ??
      (first.destination.kind === "assigned"
        ? first.destination.target.role
        : "");
    if (
      !TRANSLATED_UNIT_TYPES.has(first.leaf.type) ||
      KEPT_ROLES.has(role) ||
      layout.article_info.has(first.leaf.leaf_id)
    )
      continue;
    const source = node.leaf_ids
      .map(
        (id, i) =>
          (i ? node.joiners[i - 1]! : "") + rows.get(id)!.corrected_text,
      )
      .join("");
    if (!source.trim()) continue;
    const found = node.leaf_ids.map((id) => segments.get(id));
    const source_sha256 = sha(source);
    if (
      found.some((s) => !s) ||
      !unitSpan(markdown, found as Segment[], source_sha256)
    ) {
      unmatched++;
      continue;
    }
    units.push({
      unit_id: node.leaf_ids[0]!,
      segment_ids: [...node.leaf_ids],
      source,
      source_sha256,
      section_id: found[0]!.section_id ?? null,
    });
  }
  return { units, unmatched };
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  english: "en",
  eng: "en",
  chinese: "zh",
  zho: "zh",
  chi: "zh",
  中文: "zh",
  japanese: "ja",
  jpn: "ja",
  korean: "ko",
  kor: "ko",
  german: "de",
  deu: "de",
  ger: "de",
  deutsch: "de",
  french: "fr",
  fra: "fr",
  fre: "fr",
  spanish: "es",
  spa: "es",
  russian: "ru",
  rus: "ru",
};
/** The primary language of a bibliographic value, or null when unrecognized. */
export function primaryLanguage(value: string | null): string | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  const head = v.split(/[-_\s]/u)[0]!;
  return (
    LANGUAGE_ALIASES[v] ??
    LANGUAGE_ALIASES[head] ??
    (/^[a-z]{2}$/u.test(head) ? head : null)
  );
}
type Script = "latin" | "cyrillic" | "han" | "kana" | "hangul" | "other";
function script(char: string): Script | null {
  if (/\p{Script=Han}/u.test(char)) return "han";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) return "kana";
  if (/\p{Script=Hangul}/u.test(char)) return "hangul";
  if (/\p{Script=Latin}/u.test(char)) return "latin";
  if (/\p{Script=Cyrillic}/u.test(char)) return "cyrillic";
  if (/\p{L}/u.test(char)) return "other";
  return null;
}
/** The writing system of a target language, as the text of units is counted. */
function writing(language: TranslationLanguage): string {
  return language.startsWith("zh")
    ? "chinese"
    : language === "ja"
      ? "japanese"
      : language === "ko"
        ? "hangul"
        : language === "ru"
          ? "cyrillic"
          : "latin";
}
/** Majority writing system of the units, formulas left out (spec 9.3 step 2). */
export function majorityWriting(texts: readonly string[]): string | null {
  const counts = new Map<Script, number>();
  for (const text of texts)
    for (const char of text.replace(/\$\$[\s\S]+?\$\$|\$[^$]+\$/gu, " ")) {
      const s = script(char);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  const han = counts.get("han") ?? 0,
    kana = counts.get("kana") ?? 0;
  // Japanese writes Han with kana; a tenth of kana tells it from Chinese.
  const cjk = han + kana;
  const merged = new Map<string, number>();
  for (const [s, n] of counts)
    if (s !== "han" && s !== "kana")
      merged.set(s === "hangul" ? "hangul" : s, n);
  if (cjk) merged.set(kana >= cjk * 0.1 ? "japanese" : "chinese", cjk);
  let best: string | null = null,
    most = 0;
  for (const [s, n] of merged)
    if (n > most) {
      best = s;
      most = n;
    }
  return best;
}
/** Spec 9.3: the bibliographic language first, then the majority writing system. */
export function alreadyInLanguage(
  target: TranslationLanguage,
  bibliographic: string | null,
  texts: readonly string[],
): boolean {
  const language = primaryLanguage(bibliographic);
  if (language) return language === target.split("-")[0];
  const found = majorityWriting(texts);
  return found !== null && found === writing(target);
}

export class TranslationStepError extends Error {
  constructor(
    readonly code: "translation-incomplete" | "translation-unavailable",
    readonly output: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "TranslationStepError";
  }
}

/** Catalog registration and immutable files of stored translations. */
export class DocumentTranslationStore {
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    /** `[translation].target_language` of this deployment. */
    readonly language: TranslationLanguage,
  ) {}
  row(
    document_version_id: string,
    content_version: string,
    target_language: TranslationLanguage = this.language,
    signal?: AbortSignal,
  ) {
    return this.database.archive<DocumentTranslationRow | null>(
      "translation",
      { document_version_id, content_version, target_language },
      signal,
    );
  }
  async latest(
    literature_id: string,
    target_language: TranslationLanguage = this.language,
    signal?: AbortSignal,
  ) {
    try {
      return await this.database.archive<DocumentTranslationRow | null>(
        "translation-latest",
        { literature_id, target_language },
        signal,
      );
    } catch {
      // A withdrawn literature has no translation to offer.
      return null;
    }
  }
  async load(
    row: DocumentTranslationRow,
    signal?: AbortSignal,
  ): Promise<DocumentTranslationFile> {
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
      { maxBytes: row.byte_size, ...(signal ? { signal } : {}) },
    );
    const file = parseDocumentTranslationFile(
      JSON.parse(decoder.decode(bytes)),
    );
    if (
      file.literature_id !== row.literature_id ||
      file.asset_id !== row.asset_id ||
      file.content_version !== row.content_version ||
      file.document_version_id !== row.document_version_id ||
      file.target_language !== row.target_language ||
      file.status !== row.status ||
      file.units.length !== row.unit_count
    )
      throw new Error("translation-integrity");
    return file;
  }
  /** Write the file, then register it; one row per combination, replaced. */
  async publish(
    file: DocumentTranslationFile,
    signal?: AbortSignal,
  ): Promise<DocumentTranslationRow> {
    const bytes = canonicalJsonBytes(parseDocumentTranslationFile(file));
    const ref = parseArtifactRef({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_size: bytes.length,
      media_type: "application/json",
    });
    return this.files.withWrite(async () => {
      signal?.throwIfAborted();
      const reference =
        (await this.database.locateArtifact(ref))?.reference ??
        artifactReference("document-translation", ref);
      const stage = await this.files.stage({ maxBytes: bytes.length });
      try {
        await stage.write(bytes);
        const saved = await this.files.publish(stage, reference);
        if (saved.sha256 !== ref.sha256)
          throw new Error("translation-integrity");
      } finally {
        await stage.discard();
      }
      const translated = file.units.filter(
        (u) => u.translation !== null,
      ).length;
      return this.database.archive<DocumentTranslationRow>(
        "translation-publish",
        {
          row: {
            literature_id: file.literature_id,
            asset_id: file.asset_id,
            content_version: file.content_version,
            target_language: file.target_language,
            document_version_id: file.document_version_id,
            annotation_id: file.annotation_id,
            artifact_reference: reference,
            sha256: ref.sha256,
            byte_size: ref.byte_size,
            media_type: "application/json",
            unit_count: file.units.length,
            translated_count: translated,
            status: file.status,
          },
        },
        signal,
      );
    }, signal);
  }
  /**
   * The translation of a fixed version in the configured language (spec 9.6):
   * a draft or a version without annotation has none; a version whose own
   * content version has no translation, while another one has, is `stale`.
   */
  async lookup(
    document: DocumentRef,
    annotation_id: string | null,
    signal?: AbortSignal,
    language: TranslationLanguage = this.language,
  ): Promise<{
    readonly state: DocumentTranslationState;
    readonly row: DocumentTranslationRow | null;
  }> {
    if (document.schema_version !== 2 || !annotation_id)
      return { state: "none", row: null };
    const row = await this.row(
      document.document_version_id,
      await archiveContentVersion(document.document_version_id, annotation_id),
      language,
      signal,
    );
    if (row) return { state: row.status, row };
    const other = await this.latest(
      document.source_material_ref.literature_id,
      language,
      signal,
    );
    return { state: other ? "stale" : "none", row: null };
  }
}

export interface TranslateStepInput {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  /** `from_step: translate`: translate every unit again, cache included. */
  readonly force: boolean;
}

/** The archive step `translate` (ADR 0068, spec 9.3). */
export class DocumentTranslationService {
  constructor(
    private readonly options: {
      readonly database: SqliteWorker;
      readonly files: FileStore;
      readonly store: DocumentTranslationStore;
      readonly translation: Pick<TranslationService, "translateUnits">;
      /** `[proofread].max_concurrent_pages`: requests in flight at once. */
      readonly concurrency: number;
      readonly metadata: (
        literatureId: string,
        signal?: AbortSignal,
      ) => Promise<{
        readonly title: string | null;
        readonly language: string | null;
      }>;
      readonly limits?: {
        readonly code_points: number;
        readonly units: number;
      };
    },
  ) {}
  get language() {
    return this.options.store.language;
  }
  async build(input: TranslateStepInput, signal?: AbortSignal) {
    const { database, files, store } = this.options,
      language = store.language;
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
    const { version } = fixed;
    if (
      version.schema_version !== 2 ||
      !isArrangedBuilder(version.builder_version) ||
      version.builder_version === LEGACY_ARRANGED_DOCUMENT_BUILDER ||
      version.source_material_ref.literature_id !== input.literature_id ||
      version.source_material_ref.asset_id !== input.asset_id
    )
      throw new TranslationStepError("translation-unavailable", {
        failure_code: "translation-not-archived",
      });
    const text = await new SqliteArchiveTextStorage(database, files).load(
      version.proofread_id,
      signal,
    );
    const annotation = await new SqliteAnnotationStorage(database, files).byId(
      input.annotation_id,
      signal,
    );
    if (
      !text ||
      !annotation ||
      annotation.document_version_id !== version.document_version_id
    )
      throw new TranslationStepError("translation-unavailable", {
        failure_code: "translation-not-archived",
      });
    const roles = new Map(
      annotation.segment_roles.map((s) => [s.segment_id, String(s.role)]),
    );
    const { units, unmatched } = documentUnits(
      text.bundle,
      fixed.structure as VerifiedDocumentStructure & {
        segments: readonly Segment[];
      },
      fixed.markdown,
      roles,
    );
    const content_version = await archiveContentVersion(
      version.document_version_id,
      annotation.annotation_id,
    );
    const metadata = await this.options.metadata(input.literature_id, signal);
    const base = {
      schema_version: 1 as const,
      literature_id: input.literature_id,
      asset_id: input.asset_id,
      document_version_id: version.document_version_id,
      annotation_id: annotation.annotation_id,
      content_version,
      target_language: language,
    };
    const summary = (
      status: DocumentTranslationFile["status"],
      out: readonly DocumentTranslationUnit[],
      extra: {
        reused: number;
        requested: number;
        batches: number;
        usage: UnitTranslationUsage;
        sha256: string | null;
      },
    ) => {
      const translated = out.filter((u) => u.translation !== null).length;
      return {
        document_version_id: version.document_version_id,
        annotation_id: annotation.annotation_id,
        content_version,
        target_language: language,
        translation: {
          status,
          units: out.length,
          translated,
          missing: status === "same-language" ? 0 : out.length - translated,
          reused: extra.reused,
          requested: extra.requested,
          batches: extra.batches,
          sha256: extra.sha256,
        },
        usage: {
          calls: extra.usage.calls,
          input_tokens: extra.usage.input_tokens,
          output_tokens: extra.usage.output_tokens,
          usage_complete:
            extra.usage.input_tokens !== null &&
            extra.usage.output_tokens !== null,
        },
        stats: {
          pages: text.bundle.page_count,
          units: out.length,
          translated,
          reused: extra.reused,
          requested_units: extra.requested,
          batches: extra.batches,
          unmatched_units: unmatched,
          same_language: status === "same-language",
        },
      };
    };
    const none = { calls: 0, input_tokens: 0, output_tokens: 0 };
    if (
      alreadyInLanguage(
        language,
        metadata.language,
        units.map((u) => u.source),
      )
    ) {
      const out = units.map((u) => ({
        unit_id: u.unit_id,
        segment_ids: u.segment_ids,
        source_sha256: u.source_sha256,
        translation: null,
        model: null,
        prompt_version: null,
      }));
      const row = await store.publish(
        { ...base, status: "same-language", units: out },
        signal,
      );
      return summary("same-language", out, {
        reused: 0,
        requested: 0,
        batches: 0,
        usage: none,
        sha256: row.sha256,
      });
    }
    // Reuse: the latest translation in this language, matched by source text.
    const reuse = new Map<string, DocumentTranslationUnit>();
    if (!input.force) {
      const latest = await store.latest(input.literature_id, language, signal);
      if (latest) {
        try {
          for (const unit of (await store.load(latest, signal)).units)
            if (unit.translation !== null) reuse.set(unit.source_sha256, unit);
        } catch {
          // An unreadable earlier file is not reused; its units are asked again.
        }
      }
    }
    const done = new Map<string, DocumentTranslationUnit>();
    for (const u of units) {
      const old = reuse.get(u.source_sha256);
      if (old)
        done.set(u.unit_id, {
          ...old,
          unit_id: u.unit_id,
          segment_ids: u.segment_ids,
        });
    }
    const reused = done.size;
    const wanted = units.filter((u) => !done.has(u.unit_id));
    const limits = this.options.limits ?? {
      code_points: TRANSLATION_BATCH_MAX_CODE_POINTS,
      units: TRANSLATION_BATCH_MAX_UNITS,
    };
    const batches: SourceUnit[][] = [];
    let size = 0;
    for (const u of wanted) {
      const n = [...u.source].length,
        last = batches.at(-1);
      if (
        last &&
        last.length < limits.units &&
        size + n <= limits.code_points
      ) {
        last.push(u);
        size += n;
      } else {
        batches.push([u]);
        size = n;
      }
    }
    const titles = new Map(
      (
        fixed.structure.sections as readonly {
          section_id: string;
          title: string | null;
        }[]
      ).map((s) => [s.section_id, s.title]),
    );
    let calls = 0,
      inputTokens: number | null = 0,
      outputTokens: number | null = 0,
      unavailable: unknown = null,
      next = 0;
    const work = async () => {
      while (next < batches.length && unavailable === null) {
        const batch = batches[next++]!;
        const sections = [
          ...new Set(
            batch.flatMap((u) => {
              const t = u.section_id ? titles.get(u.section_id) : null;
              return t ? [t] : [];
            }),
          ),
        ];
        let result;
        try {
          result = await this.options.translation.translateUnits(
            {
              title: metadata.title,
              sections,
              units: batch.map((u) => ({ id: u.unit_id, text: u.source })),
            },
            language,
            { force: input.force, ...(signal ? { signal } : {}) },
          );
        } catch (error) {
          const used = (error as { usage?: UnitTranslationUsage }).usage;
          if (used) {
            calls += used.calls;
            inputTokens = null;
            outputTokens = null;
          }
          if (
            error instanceof TranslationError &&
            error.code === "translation-model-unavailable"
          ) {
            unavailable = error;
            return;
          }
          throw error;
        }
        calls += result.usage.calls;
        inputTokens =
          inputTokens === null || result.usage.input_tokens === null
            ? null
            : inputTokens + result.usage.input_tokens;
        outputTokens =
          outputTokens === null || result.usage.output_tokens === null
            ? null
            : outputTokens + result.usage.output_tokens;
        for (const u of batch) {
          const hit = result.translations.get(u.unit_id);
          // The service checked formulas against the normalized text; recheck the stored source.
          if (
            hit &&
            JSON.stringify(mathSpans(hit.translation)) ===
              JSON.stringify(mathSpans(u.source))
          )
            done.set(u.unit_id, {
              unit_id: u.unit_id,
              segment_ids: u.segment_ids,
              source_sha256: u.source_sha256,
              translation: hit.translation,
              model: hit.model,
              prompt_version: DOCUMENT_TRANSLATION_PROMPT_VERSION,
            });
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.max(
            1,
            Math.min(this.options.concurrency, batches.length),
          ),
        },
        work,
      ),
    );
    const out = units.map(
      (u) =>
        done.get(u.unit_id) ?? {
          unit_id: u.unit_id,
          segment_ids: u.segment_ids,
          source_sha256: u.source_sha256,
          translation: null,
          model: null,
          prompt_version: null,
        },
    );
    const translated = out.filter((u) => u.translation !== null).length,
      status = translated === out.length ? "complete" : "partial";
    // Finished units are published even when others are missing (spec 9.3).
    const row =
      translated > 0 || out.length === 0
        ? await store.publish({ ...base, status, units: out }, signal)
        : null;
    const output = summary(status, out, {
      reused,
      requested: wanted.length,
      batches: batches.length,
      usage: {
        calls,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
      sha256: row?.sha256 ?? null,
    });
    if (unavailable !== null)
      throw new TranslationStepError("translation-unavailable", output, {
        cause: unavailable,
      });
    if (status === "partial")
      throw new TranslationStepError("translation-incomplete", output);
    return output;
  }
}
