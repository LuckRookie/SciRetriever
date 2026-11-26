import {
  LAYERS_MACHINE_NOTE,
  LAYERS_MACHINE_TRANSLATION_NOTE,
  sentenceNumbers,
  type DocumentLayersFile,
  type DocumentLayersRequest,
  type DocumentLayout,
  type DocumentTranslationFile,
  type LayersEvidence,
  type LayersPointKind,
  type LayersReadAdvice,
  type LayersReadBasis,
  type LayersReadBlockRef,
  type LayersReadDataRow,
  type LayersReadEvidence,
  type LayersReadLimit,
  type LayersReadPoint,
  type LayersReadSummary,
  type LayersReadUnitRef,
  type LayersRelationWord,
} from "@sciretriever/contracts";
import { figureCaption, unitSentences } from "./check.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const BLOCK_LABELS = { figure: "图", scheme: "示意图", table: "表" } as const;
/** Chinese names of the kinds and relation words, for the Markdown export. */
export const LAYERS_KIND_LABELS: Readonly<Record<LayersPointKind, string>> = {
  context: "背景",
  question: "问题",
  method: "方法",
  result: "结果",
  analysis: "分析",
  claim: "结论",
  limit: "局限",
};
export const LAYERS_RELATION_LABELS: Readonly<
  Record<LayersRelationWord, string>
> = {
  see: "见",
  follows: "承接",
  based_on: "依据",
  explains: "解释",
  sums_up: "总结",
  extends: "引申自",
};

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
  private get part() {
    return this.c.file.translation;
  }
  private text(start: number, end: number) {
    return decoder.decode(this.c.markdown.subarray(start, end));
  }
  sectionTitle(section_id: string | null) {
    return section_id === null ? null : (this.titles.get(section_id) ?? null);
  }
  private paragraph(segment_id: string) {
    return this.index.get(segment_id) ?? 1;
  }
  private unitRefs(ids: readonly string[]): LayersReadUnitRef[] {
    return ids.map((unit_id) => ({
      unit_id,
      paragraph: this.paragraph(unit_id),
    }));
  }
  private block(segment_id: string): LayersReadBlockRef {
    const group = this.group(segment_id);
    return {
      kind: "block",
      segment_id,
      block_kind: group?.kind ?? "figure",
      paragraph: this.paragraph(segment_id),
    };
  }
  private group(segment_id: string) {
    return this.c.structure.layout?.figure_groups.find((g) =>
      g.objects.some((o) => o.segment_id === segment_id),
    );
  }
  /**
   * The mode's fields of one translatable text: in `translation` the
   * fields are replaced and `translated` says whether they could be; in
   * `bilingual` `translation` sits beside the original. Counts the texts
   * that have no translation.
   */
  private mode<T extends Record<string, unknown>>(
    original: T,
    replaced: Partial<T> | null,
    beside: Record<string, unknown>,
  ) {
    if (this.c.mode === "original") return original;
    if (replaced === null) this.untranslated++;
    if (this.c.mode === "translation")
      return replaced === null
        ? { ...original, translated: false }
        : { ...original, ...replaced, translated: true };
    return { ...original, translation: beside };
  }
  private terms(keys: readonly (string | null)[] | undefined) {
    return (keys ?? []).filter((k): k is string => k !== null);
  }
  summary(): LayersReadSummary {
    const s = this.c.file.digest.summary,
      t = this.part?.digest.summary;
    return this.mode(
      {
        text: s.text,
        key_terms: [...s.key_terms],
        units: this.unitRefs(s.units),
      },
      t?.text ? { text: t.text, key_terms: this.terms(t.key_terms) } : null,
      { text: t?.text ?? null, key_terms: this.terms(t?.key_terms) },
    ) as LayersReadSummary;
  }
  limits(): LayersReadLimit[] {
    return this.c.file.digest.limits.map((l, i) => {
      const t = this.part?.digest.limits[i] ?? null;
      return this.mode(
        { text: l.text, units: this.unitRefs(l.units) },
        t ? { text: t } : null,
        { text: t },
      ) as LayersReadLimit;
    });
  }
  advice(): LayersReadAdvice {
    const a = this.c.file.digest.advice,
      t = this.part?.digest.advice;
    const places = a.places.map((p) => ({
      text: p.text,
      target:
        p.target.kind === "block"
          ? this.block(p.target.segment_id)
          : {
              kind: "section" as const,
              segment_id: p.target.segment_id,
              section_id:
                this.segments.get(p.target.segment_id)?.section_id ?? null,
              title: this.sectionTitle(
                this.segments.get(p.target.segment_id)?.section_id ?? null,
              ),
              paragraph: this.paragraph(p.target.segment_id),
            },
    }));
    const original = {
      text: a.text,
      not_given: a.not_given,
      key_terms: [...a.key_terms],
      units: this.unitRefs(a.units),
      places,
    };
    // Advice the document does not give has nothing to translate.
    if (a.text === null)
      return (
        this.c.mode === "original"
          ? original
          : this.c.mode === "translation"
            ? { ...original, translated: false }
            : {
                ...original,
                translation: { text: null, key_terms: [], places: [] },
              }
      ) as LayersReadAdvice;
    return this.mode(
      original,
      t?.text
        ? {
            text: t.text,
            key_terms: this.terms(t.key_terms),
            // In the translation, a place is kept only where its words were found.
            places: places.flatMap((p, i) =>
              t.places[i] ? [{ ...p, text: t.places[i]! }] : [],
            ),
          }
        : null,
      {
        text: t?.text ?? null,
        key_terms: this.terms(t?.key_terms),
        places: [...(t?.places ?? a.places.map(() => null))],
      },
    ) as LayersReadAdvice;
  }
  data(): LayersReadDataRow[] {
    return this.c.file.data.map((d, i) => {
      const t = this.part?.data[i] ?? null;
      return this.mode(
        {
          quantity: d.quantity,
          value: d.value,
          source:
            d.source.kind === "unit"
              ? {
                  kind: "unit" as const,
                  ...this.unitRefs([d.source.unit_id])[0]!,
                }
              : this.block(d.source.segment_id),
        },
        t ? { quantity: t } : null,
        { quantity: t },
      ) as LayersReadDataRow;
    });
  }
  point(index: number): LayersReadPoint {
    const p = this.c.file.points[index]!;
    const t = this.part?.points[index];
    return this.mode(
      {
        number: p.number,
        statement: p.statement,
        key_terms: [...p.key_terms],
        section_id: p.section_id,
        section_title: this.sectionTitle(p.section_id),
        primary: p.primary,
        label: p.label,
        kind: p.kind,
        relations: p.relations.map((r) => ({
          word: r.word,
          targets: r.targets.map((x) =>
            x.kind === "point" ? x : this.block(x.segment_id),
          ),
        })),
      },
      t?.text
        ? {
            statement: t.text,
            key_terms: this.terms(t.key_terms),
            label: t.label ?? p.label,
          }
        : null,
      {
        statement: t?.text ?? null,
        key_terms: this.terms(t?.key_terms),
        label: t?.label ?? null,
      },
    ) as LayersReadPoint;
  }
  /** One evidence (or basis) as the original gives it. */
  private original(e: LayersEvidence) {
    if (e.kind === "block") {
      const group = this.group(e.segment_id);
      return {
        kind: "block" as const,
        segment_id: e.segment_id,
        block_kind: group?.kind ?? "figure",
        caption: group ? figureCaption(this.c.markdown, group) : null,
        paragraph: this.paragraph(e.segment_id),
      };
    }
    const unit = this.segments.get(e.unit_id)!;
    const prefix = this.text(unit.start_utf8, e.end_utf8);
    return {
      kind: "sentence" as const,
      unit_id: e.unit_id,
      segment_ids: this.c.structure.segments
        .filter((s) => s.start_utf8 < e.end_utf8 && s.end_utf8 > e.start_utf8)
        .map((s) => s.segment_id),
      start_utf8: e.start_utf8,
      end_utf8: e.end_utf8,
      paragraph: this.paragraph(e.unit_id),
      sentences: sentenceNumbers(
        unitSentences(prefix, unit.kind),
        e.start_utf8 - unit.start_utf8,
        e.end_utf8 - unit.start_utf8,
      ),
      text: this.text(e.start_utf8, e.end_utf8),
    };
  }
  /** What a primary point rests on; its first evidence when it has no basis. */
  basis(index: number): LayersReadBasis {
    const p = this.c.file.points[index]!;
    return {
      ...this.original(p.basis ?? p.evidence[0]!),
      fallback: p.basis === null,
    };
  }
  evidence(index: number): LayersReadEvidence[] {
    const p = this.c.file.points[index]!;
    const part = this.part?.points[index];
    return p.evidence.map((e, i): LayersReadEvidence => {
      const original = this.original(e);
      if (original.kind === "block" || this.c.mode === "original")
        return original;
      // The translated evidence: the confirmed sentences, else the whole
      // unit's translation (aligned false), else the original.
      const whole =
        e.kind === "sentence"
          ? (this.unitTranslations.get(e.unit_id) ?? null)
          : null;
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
  /**
   * The 3 to 5 primary points with their basis, for the overview. They are
   * also among the points, so their untranslated texts are counted there.
   */
  primary() {
    const counted = this.untranslated;
    const out = this.c.file.points.flatMap((p, i) =>
      p.primary ? [{ ...this.point(i), basis: this.basis(i) }] : [],
    );
    this.untranslated = counted;
    return out;
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

const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
const quote = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
const units = (refs: readonly LayersReadUnitRef[]) =>
  refs.length ? `（${refs.map((u) => `¶${u.paragraph}`).join("，")}）` : "";
const location = (
  e: Pick<LayersReadEvidence, "kind" | "paragraph"> & {
    sentences?: readonly number[];
  },
) =>
  e.kind === "block" || !e.sentences
    ? `¶${e.paragraph}`
    : `¶${e.paragraph}·${e.sentences.join(",")}`;
const cell = (text: string) =>
  text.replace(/\|/gu, "\\|").replace(/\s+/gu, " ");

/**
 * The Markdown header: the machine note, the title and the digest (summary,
 * the trunk with what each rests on, data, limits, advice).
 */
export function layersMarkdownHeader(
  title: string | null,
  reader: LayersReader,
  mode: DocumentLayersRequest["text"],
): string {
  const out = [
    `> ${LAYERS_MACHINE_NOTE}${mode === "original" ? "" : LAYERS_MACHINE_TRANSLATION_NOTE}`,
    "",
  ];
  if (title) out.push(`# ${flat(title)}`, "");
  const summary = reader.summary();
  out.push("## 提要", "", `${summary.text}${units(summary.units)}`, "");
  if (summary.translation?.text) out.push(summary.translation.text, "");
  out.push("## 主干", "");
  for (const p of reader.primary()) {
    out.push(`**${p.number}.** ${p.statement}`);
    if (p.translation?.statement) out.push("", p.translation.statement);
    const b = p.basis;
    out.push(
      "",
      quote(
        b.kind === "block"
          ? `［${BLOCK_LABELS[b.block_kind]}］${b.caption ?? ""}`
          : flat(b.text),
      ),
      `> — ${location(b)}`,
      "",
    );
  }
  const data = reader.data();
  if (data.length) {
    out.push("## 数据", "", "| 量 | 数值 | 出处 |", "| --- | --- | --- |");
    for (const d of data)
      out.push(
        `| ${cell(d.quantity)}${d.translation?.quantity ? `（${cell(d.translation.quantity)}）` : ""} | ${cell(d.value)} | ¶${d.source.paragraph} |`,
      );
    out.push("");
  }
  out.push("## 局限", "");
  const limits = reader.limits();
  if (!limits.length) out.push("原文未给出。", "");
  for (const l of limits) {
    out.push(`- ${l.text}${units(l.units)}`);
    if (l.translation?.text) out.push(`  ${l.translation.text}`);
  }
  if (limits.length) out.push("");
  out.push("## 精读建议", "");
  const advice = reader.advice();
  if (advice.text === null)
    out.push(`原文未给出。${advice.not_given ?? ""}`.trim(), "");
  else {
    const places = advice.places
      .map((p) => `${p.text} → ¶${p.target.paragraph}`)
      .join("；");
    out.push(`${advice.text}${units(advice.units)}`, "");
    if (places) out.push(`去处：${places}`, "");
    if (advice.translation?.text) out.push(advice.translation.text, "");
  }
  // A blank line before the first section heading.
  return out.join("\n") + "\n";
}
/** One point: its kind and relations, then its evidence as quotes when given. */
export function layersMarkdownPoint(
  point: LayersReadPoint,
  evidence: readonly LayersReadEvidence[] | null,
): string {
  const out = [
    `**${point.number}.** ${point.kind ? `〔${LAYERS_KIND_LABELS[point.kind]}〕` : ""}${point.statement}`,
    "",
  ];
  if (point.translation?.statement) out.push(point.translation.statement, "");
  const relations = point.relations
    .map(
      (r) =>
        `${LAYERS_RELATION_LABELS[r.word]} ${r.targets
          .map((t) => (t.kind === "point" ? `${t.number}` : `¶${t.paragraph}`))
          .join("、")}`,
    )
    .join("；");
  if (relations) out.push(`（${relations}）`, "");
  for (const e of evidence ?? []) {
    if (e.kind === "block") {
      out.push(
        quote(`［${BLOCK_LABELS[e.block_kind]}］${e.caption ?? ""}`),
        `> — ${location(e)}`,
        "",
      );
      continue;
    }
    out.push(quote(flat(e.text)));
    if (e.translation?.text) out.push(">", quote(flat(e.translation.text)));
    out.push(`> — ${location(e)}`, "");
  }
  return out.join("\n");
}
/** A section heading line when the section changes; untitled sections get none. */
export function layersMarkdownSection(title: string | null): string {
  return title ? `## ${flat(title)}\n\n` : "";
}
