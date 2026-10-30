import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  FULLTEXT_TRANSLATION_LIMIT,
  TranslationInputError,
  isTranslationLanguage,
  parseFullTextPageRequest,
  type FullTextBlock,
  type FullTextPage,
  type FullTextSummary,
  type TranslationLanguage,
} from "@sciretriever/contracts";
import {
  TRANSLATION_PROMPT_VERSION,
  TranslationError,
  type TranslationService,
} from "./service.js";

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
}
type Region = readonly [number, number, number, number];
/** The share of a's area that b covers. */
const covered = ([a0, b0, a1, b1]: Region, [c0, d0, c1, d1]: Region) =>
  (Math.max(0, Math.min(a1, c1) - Math.max(a0, c0)) *
    Math.max(0, Math.min(b1, d1) - Math.max(b0, d0))) /
  Math.max(1, (a1 - a0) * (b1 - b0));
interface SavedPage {
  readonly key: string;
  readonly model: string | null;
  readonly translations: Record<string, string>;
}
interface SavedFile {
  readonly schema_version: 1;
  readonly literature_id: string;
  readonly target_language: TranslationLanguage;
  readonly pages: Record<string, SavedPage>;
}
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
/** A page is reused only while its blocks, language and prompt are unchanged. */
export function pageKey(
  blocks: FullTextSource["blocks"],
  language: TranslationLanguage,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        TRANSLATION_PROMPT_VERSION,
        language,
        blocks.map((b) => [b.leaf_id, b.source]),
      ]),
    )
    .digest("hex");
}
/**
 * Full-text translation (ADR 0051): one request per page, kept per literature
 * and language as a file under the program's cache directory, at most 50 files
 * by last use. Pages whose blocks changed are translated again.
 */
export class FullTextTranslation {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(
    private readonly options: {
      readonly dir: string;
      readonly translation: Pick<TranslationService, "translateBlocks">;
      readonly source: (
        literatureId: string,
        signal?: AbortSignal,
      ) => Promise<FullTextSource | null>;
      readonly limit?: number;
    },
  ) {}
  private file(literatureId: string, language: TranslationLanguage) {
    return join(
      this.options.dir,
      `${createHash("sha256").update(`${literatureId}\u0000${language}`).digest("hex")}.json`,
    );
  }
  private async read(
    literatureId: string,
    language: TranslationLanguage,
  ): Promise<SavedFile> {
    const empty: SavedFile = {
      schema_version: 1,
      literature_id: literatureId,
      target_language: language,
      pages: {},
    };
    try {
      const path = this.file(literatureId, language);
      const value = JSON.parse(await readFile(path, "utf8")) as SavedFile;
      if (
        value.schema_version !== 1 ||
        value.literature_id !== literatureId ||
        value.target_language !== language ||
        !value.pages ||
        typeof value.pages !== "object"
      )
        return empty;
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return value;
    } catch {
      return empty;
    }
  }
  /** Writes of one file run one after another; each replaces the file whole. */
  private save(
    literatureId: string,
    language: TranslationLanguage,
    page: number,
    value: SavedPage,
  ): Promise<void> {
    const path = this.file(literatureId, language);
    const next = (this.writes.get(path) ?? Promise.resolve()).then(async () => {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      const current = await this.read(literatureId, language);
      const body: SavedFile = {
        ...current,
        pages: { ...current.pages, [String(page)]: value },
      };
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(body), { mode: 0o600 });
      await rename(temp, path);
      await this.prune(path);
    });
    this.writes.set(
      path,
      next.catch(() => {}),
    );
    return next;
  }
  private async prune(keep: string) {
    const limit = this.options.limit ?? FULLTEXT_TRANSLATION_LIMIT;
    const names = (await readdir(this.options.dir)).filter((n) =>
      n.endsWith(".json"),
    );
    if (names.length <= limit) return;
    const files = await Promise.all(
      names.map(async (name) => {
        const path = join(this.options.dir, name);
        return { path, used: (await stat(path)).mtimeMs };
      }),
    );
    files.sort((a, b) => a.used - b.used);
    for (const f of files.slice(0, files.length - limit))
      if (f.path !== keep) await rm(f.path, { force: true });
  }
  private async load(literatureId: string, signal?: AbortSignal) {
    const source = await this.options.source(literatureId, signal);
    if (!source) throw new TranslationError("translation-not-archived");
    return source;
  }
  async summary(
    literatureId: unknown,
    language: unknown,
    signal?: AbortSignal,
  ): Promise<FullTextSummary> {
    if (typeof literatureId !== "string" || !isTranslationLanguage(language))
      throw new TranslationInputError();
    const source = await this.load(literatureId, signal),
      saved = await this.read(literatureId, language);
    return {
      literature_id: literatureId,
      target_language: language,
      page_count: source.page_count,
      pages: Array.from({ length: source.page_count }, (_, page) => {
        const blocks = translatedBlocks(source, page);
        return {
          page_index: page,
          blocks: blocks.length,
          saved:
            !blocks.length ||
            saved.pages[String(page)]?.key === pageKey(blocks, language),
        };
      }),
    };
  }
  async page(value: unknown, signal?: AbortSignal): Promise<FullTextPage> {
    const request = parseFullTextPageRequest(value);
    const source = await this.load(request.literature_id, signal);
    if (request.page_index >= source.page_count)
      throw new TranslationInputError();
    const figures = source.blocks.flatMap((b) =>
      b.page_index === request.page_index && b.type === "image" && b.region
        ? [b.region]
        : [],
    );
    const blocks = translatedBlocks(source, request.page_index),
      key = pageKey(blocks, request.target_language),
      saved = (await this.read(request.literature_id, request.target_language))
        .pages[String(request.page_index)];
    const page = (
      translations: ReadonlyMap<string, string> | Record<string, string>,
      model: string | null,
      fromSaved: boolean,
    ): FullTextPage => {
      const get = (id: string) =>
        translations instanceof Map
          ? (translations.get(id) ?? null)
          : ((translations as Record<string, string>)[id] ?? null);
      return {
        literature_id: request.literature_id,
        page_index: request.page_index,
        target_language: request.target_language,
        model,
        saved: fromSaved,
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
          translation: get(b.leaf_id),
        })),
      };
    };
    if (!request.force && saved?.key === key)
      return page(saved.translations, saved.model, true);
    if (!blocks.length) return page({}, null, true);
    const result = await this.options.translation.translateBlocks(
      blocks.map((b) => ({ id: b.leaf_id, text: b.source })),
      request.target_language,
      request.model,
      signal,
    );
    // A page with blocks still missing is not saved, so opening it again asks again.
    if (result.translations.size === blocks.length)
      await this.save(
        request.literature_id,
        request.target_language,
        request.page_index,
        {
          key,
          model: result.model,
          translations: Object.fromEntries(result.translations),
        },
      );
    return page(result.translations, result.model, false);
  }
}
