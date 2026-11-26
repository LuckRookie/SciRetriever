import {
  LAYERS_DIGEST_ITEMS,
  LAYERS_MACHINE_NOTE,
  LAYERS_MACHINE_TRANSLATION_NOTE,
  sentenceNumbers,
  type DocumentLayersFile,
  type DocumentLayersRequest,
  type DocumentLayout,
  type DocumentTranslationFile,
  type LayersDigestItemName,
  type LayersReadDigestItem,
  type LayersReadEvidence,
  type LayersReadPoint,
} from "@sciretriever/contracts";
import { figureCaption, unitSentences } from "./document.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_LABELS: Readonly<Record<LayersDigestItemName, string>> = {
  nature: "这是一份什么资料",
  limits: "局限与未决事项",
  advice: "精读建议",
};
const BLOCK_LABELS = { figure: "图", scheme: "示意图", table: "表" } as const;

interface Segment {
  readonly segment_id: string;
  readonly kind: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
  readonly section_id?: string | null;
}
export interface LayersReadContext {
  readonly mode: DocumentLayersRequest["text"];
  readonly markdown: Uint8Array;
  readonly structure: {
    readonly segments: readonly Segment[];
    readonly sections: readonly {
      readonly section_id: string;
      readonly title: string | null;
    }[];
    readonly layout?: DocumentLayout;
  };
  readonly file: DocumentLayersFile;
  /** The stored translation in the translation part's language, for evidence. */
  readonly translation: DocumentTranslationFile | null;
  /** Whether the part's evidence positions rest on that translation file. */
  readonly aligned: boolean;
}

/**
 * Reading a stored layers file against its fixed document (spec 10.7). Only
 * stored content is read; positions stay original UTF-8 positions.
 */
export class LayersReader {
  private readonly index = new Map<string, number>();
  private readonly segments = new Map<string, Segment>();
  private readonly titles = new Map<string, string | null>();
  private readonly unitTranslations = new Map<string, string>();
  untranslated = 0;
  constructor(private readonly c: LayersReadContext) {
    c.structure.segments.forEach((s, i) => {
      this.index.set(s.segment_id, i + 1);
      this.segments.set(s.segment_id, s);
    });
    for (const s of c.structure.sections)
      this.titles.set(s.section_id, s.title);
    for (const u of c.translation?.units ?? [])
      if (u.translation !== null)
        this.unitTranslations.set(u.unit_id, u.translation);
  }
  private text(start: number, end: number) {
    return decoder.decode(this.c.markdown.subarray(start, end));
  }
  sectionTitle(section_id: string | null) {
    return section_id === null ? null : (this.titles.get(section_id) ?? null);
  }
  /** One translated text with the mode's fields; counts what has no translation. */
  private translated<T extends Record<string, unknown>>(
    original: T,
    field: "text" | "statement",
    translation: {
      text: string | null;
      key_terms: readonly (string | null)[];
    } | null,
  ) {
    const mode = this.c.mode;
    if (mode === "original") return original;
    const text = translation?.text ?? null;
    const key_terms = (translation?.key_terms ?? []).filter(
      (k): k is string => k !== null,
    );
    if (text === null) this.untranslated++;
    if (mode === "translation")
      return text === null
        ? { ...original, translated: false }
        : { ...original, [field]: text, key_terms, translated: true };
    return {
      ...original,
      translation: { [field]: text, key_terms },
    };
  }
  digest(): LayersReadDigestItem[] {
    const part = this.c.file.translation;
    return LAYERS_DIGEST_ITEMS.map((name) => {
      const d = this.c.file.digest[name];
      const item = {
        name,
        text: d.text,
        not_given: d.not_given,
        key_terms: [...d.key_terms],
        units: d.units.map((unit_id) => ({
          unit_id,
          paragraph: this.index.get(unit_id) ?? 1,
        })),
      };
      // A digest item the paper does not give has nothing to translate.
      if (d.text === null)
        return this.c.mode === "original"
          ? item
          : this.c.mode === "translation"
            ? { ...item, translated: false }
            : { ...item, translation: { text: null, key_terms: [] } };
      return this.translated(
        item,
        "text",
        part?.digest[name] ?? null,
      ) as LayersReadDigestItem;
    });
  }
  point(index: number): LayersReadPoint {
    const p = this.c.file.points[index]!;
    return this.translated(
      {
        number: p.number,
        statement: p.statement,
        key_terms: [...p.key_terms],
        section_id: p.section_id,
        section_title: this.sectionTitle(p.section_id),
      },
      "statement",
      this.c.file.translation?.points[index] ?? null,
    ) as LayersReadPoint;
  }
  evidence(index: number): LayersReadEvidence[] {
    const p = this.c.file.points[index]!;
    const part = this.c.file.translation?.points[index];
    return p.evidence.map((e, i): LayersReadEvidence => {
      if (e.kind === "block") {
        const group = this.c.structure.layout?.figure_groups.find((g) =>
          g.objects.some((o) => o.segment_id === e.segment_id),
        );
        return {
          kind: "block",
          segment_id: e.segment_id,
          block_kind: group?.kind ?? "figure",
          caption: group ? figureCaption(this.c.markdown, group) : null,
          paragraph: this.index.get(e.segment_id) ?? 1,
        };
      }
      const unit = this.segments.get(e.unit_id)!;
      const prefix = this.text(unit.start_utf8, e.end_utf8);
      const sentences = sentenceNumbers(
        unitSentences(prefix, unit.kind),
        e.start_utf8 - unit.start_utf8,
        e.end_utf8 - unit.start_utf8,
      );
      const original = {
        kind: "sentence" as const,
        unit_id: e.unit_id,
        segment_ids: this.c.structure.segments
          .filter((s) => s.start_utf8 < e.end_utf8 && s.end_utf8 > e.start_utf8)
          .map((s) => s.segment_id),
        start_utf8: e.start_utf8,
        end_utf8: e.end_utf8,
        paragraph: this.index.get(e.unit_id) ?? 1,
        sentences,
        text: this.text(e.start_utf8, e.end_utf8),
      };
      if (this.c.mode === "original") return original;
      // The translated evidence: the confirmed sentences, else the whole
      // unit's translation (aligned false), else the original.
      const whole = this.unitTranslations.get(e.unit_id) ?? null;
      const at = this.c.aligned ? (part?.evidence[i] ?? null) : null;
      let text: string | null = whole,
        aligned = false;
      if (whole !== null && at) {
        const bytes = Buffer.from(whole, "utf8");
        if (at.end_utf8 <= bytes.length) {
          try {
            text = decoder.decode(bytes.subarray(at.start_utf8, at.end_utf8));
            aligned = true;
          } catch {
            text = whole;
          }
        }
      }
      if (this.c.mode === "translation")
        return text === null
          ? { ...original, translated: false, aligned: false }
          : { ...original, text, translated: true, aligned };
      return { ...original, translation: { text, aligned } };
    });
  }
  /** Points of the overview grouped by their section, in order. */
  sections() {
    const groups: {
      section_id: string | null;
      title: string | null;
      points: LayersReadPoint[];
    }[] = [];
    this.c.file.points.forEach((p, i) => {
      const last = groups.at(-1);
      const point = this.point(i);
      if (last && last.section_id === p.section_id) last.points.push(point);
      else
        groups.push({
          section_id: p.section_id,
          title: this.sectionTitle(p.section_id),
          points: [point],
        });
    });
    return groups;
  }
}

const quote = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
const units = (item: LayersReadDigestItem) =>
  item.units.length
    ? `（${item.units.map((u) => `¶${u.paragraph}`).join("，")}）`
    : "";
const location = (e: LayersReadEvidence) =>
  e.kind === "block"
    ? `¶${e.paragraph}`
    : `¶${e.paragraph}·${e.sentences.join(",")}`;

/** The Markdown header: the machine note, the title and the digest. */
export function layersMarkdownHeader(
  title: string | null,
  digest: readonly LayersReadDigestItem[],
  mode: DocumentLayersRequest["text"],
): string {
  const out = [
    `> ${LAYERS_MACHINE_NOTE}${mode === "original" ? "" : LAYERS_MACHINE_TRANSLATION_NOTE}`,
    "",
  ];
  if (title) out.push(`# ${title.replace(/\s+/gu, " ").trim()}`, "");
  out.push("## 提要", "");
  for (const item of digest) {
    const label = `**${DIGEST_LABELS[item.name]}**：`;
    if (item.text === null) {
      out.push(`${label}原文未给出。${item.not_given ?? ""}`.trim(), "");
      continue;
    }
    out.push(`${label}${item.text}${units(item)}`, "");
    if (item.translation?.text) out.push(item.translation.text, "");
  }
  // A blank line before the first section heading.
  return out.join("\n") + "\n";
}
/** One point, with its evidence as quotes when given. */
export function layersMarkdownPoint(
  point: LayersReadPoint,
  evidence: readonly LayersReadEvidence[] | null,
): string {
  const out = [`**${point.number}.** ${point.statement}`, ""];
  if (point.translation?.statement) out.push(point.translation.statement, "");
  for (const e of evidence ?? []) {
    if (e.kind === "block") {
      out.push(
        quote(`［${BLOCK_LABELS[e.block_kind]}］${e.caption ?? ""}`),
        `> — ${location(e)}`,
        "",
      );
      continue;
    }
    out.push(quote(e.text.replace(/\s+/gu, " ").trim()));
    if (e.translation?.text)
      out.push(">", quote(e.translation.text.replace(/\s+/gu, " ").trim()));
    out.push(`> — ${location(e)}`, "");
  }
  return out.join("\n");
}
/** A section heading line when the section changes; untitled sections get none. */
export function layersMarkdownSection(title: string | null): string {
  return title ? `## ${title.replace(/\s+/gu, " ").trim()}\n\n` : "";
}
