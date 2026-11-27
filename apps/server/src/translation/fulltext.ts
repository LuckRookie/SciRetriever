import { rm } from "node:fs/promises";
import {
  TranslationInputError,
  isTranslationLanguage,
  parseFullTextPageRequest,
  type DocumentRef,
  type DocumentTranslationFile,
  type DocumentTranslationState,
  type FullTextBlock,
  type FullTextPage,
  type FullTextSummary,
  type TranslationLanguage,
} from "@sciretriever/contracts";
import { TranslationError } from "./service.js";

/** Block types translated in place; others keep the print (ADR 0051 §2). */
const TRANSLATED_TYPES = new Set([
  "text",
  "title",
  "caption",
  "list",
  "footnote",
]);
/** Roles that keep the print even when their blocks are text. */
const KEPT_ROLES = new Set(["references", "authors"]);
export interface FullTextSource {
  readonly page_count: number;
  readonly blocks: readonly (Omit<
    FullTextBlock,
    "translation" | "placement"
  > & {
    readonly page_index: number;
  })[];
  /** The fixed default version the blocks come from. */
  readonly document?: DocumentRef;
}
type Region = readonly [number, number, number, number];
/** The share of a's area that b covers. */
const covered = ([a0, b0, a1, b1]: Region, [c0, d0, c1, d1]: Region) =>
  (Math.max(0, Math.min(a1, c1) - Math.max(a0, c0)) *
    Math.max(0, Math.min(b1, d1) - Math.max(b0, d0))) /
  Math.max(1, (a1 - a0) * (b1 - b0));
/** The blocks of one page that are translated, in reading order. */
export function translatedBlocks(
  source: FullTextSource,
  page: number,
): FullTextSource["blocks"] {
  return source.blocks.filter(
    (b) =>
      b.page_index === page &&
      TRANSLATED_TYPES.has(b.type) &&
      !KEPT_ROLES.has(b.role) &&
      b.source.trim().length > 0,
  );
}
const BREAK = /[\s.,;:!?。，、；：！？）)」』]/u;
/**
 * Split a unit's translation over the page regions of its leaves (spec 9.6):
 * by each leaf's share of the source characters, at the punctuation nearest
 * to each cut; without punctuation nearby the cut falls where the share says.
 */
export function splitTranslation(
  translation: string,
  weights: readonly number[],
): string[] {
  if (weights.length <= 1) return [translation];
  const chars = [...translation],
    total = weights.reduce((a, b) => a + Math.max(0, b), 0) || 1,
    window = Math.max(1, Math.floor(chars.length / weights.length / 2));
  const parts: string[] = [];
  let at = 0,
    share = 0;
  for (const weight of weights.slice(0, -1)) {
    share += Math.max(0, weight);
    const target = Math.round((chars.length * share) / total);
    let cut = Math.min(chars.length, Math.max(at, target));
    for (let d = 0; d <= window; d++) {
      const after = target + d,
        before = target - d;
      if (
        after > at &&
        after <= chars.length &&
        BREAK.test(chars[after - 1]!)
      ) {
        cut = after;
        break;
      }
      if (
        before > at &&
        before <= chars.length &&
        BREAK.test(chars[before - 1]!)
      ) {
        cut = before;
        break;
      }
    }
    parts.push(chars.slice(at, cut).join(""));
    at = cut;
  }
  parts.push(chars.slice(at).join(""));
  return parts;
}
/** Where the stored translation of a default version is read (ADR 0068). */
export type StoredTranslation = (
  document: DocumentRef,
  language: TranslationLanguage,
  signal?: AbortSignal,
) => Promise<{
  readonly state: DocumentTranslationState;
  readonly file: DocumentTranslationFile | null;
}>;
/**
 * The PDF view's in-place translation (ADR 0051 §3, ADR 0068 §1): blocks of
 * the primary PDF's default version with the stored translation of the units
 * they belong to. It never asks a model; `force` is accepted and ignored.
 */
export class FullTextTranslation {
  constructor(
    private readonly options: {
      readonly source: (
        literatureId: string,
        signal?: AbortSignal,
      ) => Promise<FullTextSource | null>;
      readonly stored: StoredTranslation;
      /** The library default language, read when a request names none (ADR 0072). */
      readonly language?: TranslationLanguage;
    },
  ) {}
  private language(value: unknown): TranslationLanguage {
    if (value === null || value === undefined) {
      if (!this.options.language) throw new TranslationInputError();
      return this.options.language;
    }
    if (!isTranslationLanguage(value)) throw new TranslationInputError();
    return value;
  }
  private async load(literatureId: string, signal?: AbortSignal) {
    const source = await this.options.source(literatureId, signal);
    if (!source) throw new TranslationError("translation-not-archived");
    return source;
  }
  /** Each leaf's piece of its unit's translation; null for leaves left untranslated. */
  private async pieces(
    source: FullTextSource,
    language: TranslationLanguage,
    signal?: AbortSignal,
  ) {
    const found = source.document
      ? await this.options.stored(source.document, language, signal)
      : { state: "none" as const, file: null };
    const pieces = new Map<string, string | null>(),
      model = found.file?.units.find((u) => u.model)?.model ?? null;
    if (found.file) {
      const text = new Map(source.blocks.map((b) => [b.leaf_id, b.source]));
      for (const unit of found.file.units) {
        if (unit.translation === null) {
          for (const id of unit.segment_ids) pieces.set(id, null);
          continue;
        }
        const split = splitTranslation(
          unit.translation,
          unit.segment_ids.map((id) => [...(text.get(id) ?? "")].length),
        );
        unit.segment_ids.forEach((id, i) => pieces.set(id, split[i] ?? ""));
      }
    }
    return { state: found.state, file: found.file, pieces, model };
  }
  private blocks(
    source: FullTextSource,
    page: number,
    stored: Awaited<ReturnType<FullTextTranslation["pieces"]>>,
  ) {
    const blocks = translatedBlocks(source, page);
    // With a stored file its units decide; article information is not one.
    return stored.file
      ? blocks.filter((b) => stored.pieces.has(b.leaf_id))
      : blocks;
  }
  async summary(
    literatureId: unknown,
    language: unknown,
    signal?: AbortSignal,
  ): Promise<FullTextSummary> {
    if (typeof literatureId !== "string") throw new TranslationInputError();
    const target = this.language(language);
    const source = await this.load(literatureId, signal),
      stored = await this.pieces(source, target, signal);
    return {
      literature_id: literatureId,
      target_language: target,
      page_count: source.page_count,
      pages: Array.from({ length: source.page_count }, (_, page) => {
        const blocks = this.blocks(source, page, stored);
        return {
          page_index: page,
          blocks: blocks.length,
          saved: blocks.every((b) => stored.pieces.get(b.leaf_id) != null),
        };
      }),
      state: stored.state,
    };
  }
  async page(value: unknown, signal?: AbortSignal): Promise<FullTextPage> {
    const request = parseFullTextPageRequest(value),
      language = this.language(request.target_language);
    const source = await this.load(request.literature_id, signal);
    if (request.page_index >= source.page_count)
      throw new TranslationInputError();
    const figures = source.blocks.flatMap((b) =>
      b.page_index === request.page_index && b.type === "image" && b.region
        ? [b.region]
        : [],
    );
    const stored = await this.pieces(source, language, signal),
      blocks = this.blocks(source, request.page_index, stored);
    return {
      literature_id: request.literature_id,
      page_index: request.page_index,
      target_language: language,
      model: stored.model,
      saved: blocks.every((b) => stored.pieces.get(b.leaf_id) != null),
      blocks: blocks.map((b) => ({
        leaf_id: b.leaf_id,
        type: b.type,
        role: b.role,
        region: b.region,
        source: b.source,
        placement:
          b.region && !figures.some((f) => covered(b.region!, f) > 0.5)
            ? ("region" as const)
            : ("text-layer" as const),
        translation: stored.pieces.get(b.leaf_id) ?? null,
      })),
      state: stored.state,
    };
  }
}
/** ADR 0051's per-page translation files are no longer read or written (ADR 0068 §3). */
export async function removeRetiredFullTextCache(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
