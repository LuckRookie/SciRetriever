import {
  markKeyTerms,
  type DocumentLayersOverviewResult,
  type LayersPointKind,
  type LayersReadBasis,
  type LayersReadEvidence,
  type LayersReadPoint,
  type LayersReadSection,
  type LayersRelationWord,
} from "@sciretriever/contracts";
import type { DocumentTextMode } from "../contract.js";
import { escape } from "../dom.js";
import { markdown } from "../markdown.js";
import type { ReadLayers, ReadLayersPoint } from "./read.js";

/**
 * The reading layers as the four views draw them (reading-experience 3,
 * ADR 0070): the read result, which language each text is shown in, and the
 * small pieces every view writes the same way. In the interface a point is a
 * 批语 (note); the code keeps the contract's name.
 */
export type ReadingLayer = "map" | "overview" | "outline" | "full";
export const READING_LAYERS: readonly ReadingLayer[] = [
  "overview",
  "outline",
  "full",
];
export const KIND_NAMES: Record<LayersPointKind, string> = {
  context: "背景",
  question: "问题",
  method: "方法",
  result: "结果",
  analysis: "分析",
  claim: "结论",
  limit: "局限",
};
export const RELATION_NAMES: Record<LayersRelationWord, string> = {
  see: "见",
  follows: "承接",
  based_on: "依据",
  explains: "解释",
  sums_up: "总结",
  extends: "引申自",
};

/** A figure, scheme or table as the full-text engine knows it. */
export interface LayerFigure {
  readonly segment_id: string;
  readonly kind: "figure" | "scheme" | "table";
  /** “图 3”, “Table 1”: the caption's own lead, else a name by kind. */
  readonly label: string;
  /** Every picture of its figure group in text order, itself among them: “Fig. 8” is (a) and (b). */
  readonly panels: readonly string[];
  /** The caption without its lead, in the reading's language when it has one. */
  caption(mode: DocumentTextMode): string | null;
  /** Its name as the reading writes it (`figureNameIn`): “Fig. 8” as printed, “图 8” in Chinese. */
  name(mode: DocumentTextMode): string;
  /** UTF-8 start of the object in the text. */
  readonly start: number;
  /** An object URL of the picture; null for a table or a picture not kept. */
  image(): Promise<string | null>;
}
/** What the full-text engine gives the layers (set once its text is laid out). */
export interface LayersPort {
  /** The sheet: the page header, the article and the layers' own leaves are its children. */
  readonly sheet: HTMLElement;
  readonly article: HTMLElement;
  /** The scroll container of the desk. */
  readonly body: HTMLElement;
  /** The page header that stays over the text; places are measured below it. */
  readonly header: HTMLElement | null;
  readonly title: string | null;
  /** The rendered blocks, in text order. */
  blocks(): readonly HTMLElement[];
  /** The block holding a UTF-8 offset. */
  blockAt(offset: number): HTMLElement | undefined;
  /** Reads the text up to the end, so every block is there. */
  loadAll(): Promise<void>;
  /** A titled section: its heading's place, level and translation. */
  section(
    id: string,
  ): { start: number; level: number; translation: string | null } | null;
  figure(segmentId: string): LayerFigure | null;
  /** While another layer shows, the full text keeps no reading place. */
  away(on: boolean): void;
  /** The reading place of the full text: the UTF-8 start of its anchor block. */
  place(): number;
  /** Opens a picture enlarged. */
  enlarge(url: string, label: string): void;
  /** Marks find their places again after the text's nodes were split. */
  repainted(): void;
  reducedMotion(): boolean;
}

/** A section as the views show it: its title, its line (节旨) and its notes' numbers. */
export interface LayersModelSection {
  readonly section_id: string | null;
  readonly title: string | null;
  readonly line: LayersReadSection;
  readonly numbers: readonly number[];
}
export interface LayersModel {
  readonly data: ReadLayers;
  readonly overview: DocumentLayersOverviewResult;
  readonly points: readonly ReadLayersPoint[];
  readonly byNumber: ReadonlyMap<number, ReadLayersPoint>;
  readonly primary: readonly (LayersReadPoint & { basis: LayersReadBasis })[];
  /** Sections in text order (ADR 0073: every one with a note or a line). */
  readonly sections: readonly LayersModelSection[];
  /** Whether the layers carry a translation part. */
  readonly translated: boolean;
  /**
   * The paragraph number a note is named by (“¶41”, ADR 0073), keyed by the
   * note's number: the one the full text shows beside its paragraph, else
   * the read's own.
   */
  readonly paragraphs?: ReadonlyMap<number, number>;
}
export function layersModel(
  data: ReadLayers,
  shown?: (p: ReadLayersPoint) => number,
): LayersModel {
  const byNumber = new Map(data.points.map((p) => [p.number, p]));
  return {
    data,
    overview: data.overview,
    points: data.points,
    byNumber,
    primary: data.overview.primary,
    sections: data.overview.sections.map(({ points, ...line }) => ({
      section_id: line.section_id,
      title: line.title,
      line,
      numbers: points.map((p) => p.number),
    })),
    translated: data.text === "bilingual",
    ...(shown
      ? { paragraphs: new Map(data.points.map((p) => [p.number, shown(p)])) }
      : {}),
  };
}
/** The paragraph number of a note (by its number), as the views write it. */
export function paragraphNo(
  model: LayersModel,
  number: number,
  fallback?: number,
): number {
  return (
    model.paragraphs?.get(number) ??
    model.byNumber.get(number)?.paragraph ??
    fallback ??
    number
  );
}
/** A note's reason in the reading shown: the translation's beside a translated note. */
export function reasonWords(
  p: LayersReadPoint,
  mode: DocumentTextMode,
): string | null {
  return mode !== "original" && p.translation?.statement
    ? (p.translation.reason ?? null)
    : p.reason;
}
/** A section's line (节旨) in the reading shown; null when it has none. */
export function sectionLine(
  s: LayersReadSection,
  mode: DocumentTextMode,
): string | null {
  return (mode !== "original" && s.translation?.statement) || s.statement;
}
/** A section line's label (导图). */
export function sectionLabel(
  s: LayersReadSection,
  mode: DocumentTextMode,
): string | null {
  return (
    (mode !== "original" && s.translation?.statement
      ? s.translation.label
      : null) ??
    s.label ??
    null
  );
}

/** A machine text in the reading shown: the translation when there is one. */
export function words(
  mode: DocumentTextMode,
  original: string,
  terms: readonly string[],
  translation:
    | {
        text?: string | null;
        statement?: string | null;
        key_terms: readonly string[];
      }
    | undefined,
): { text: string; terms: readonly string[]; translated: boolean } {
  const translated = translation?.text ?? translation?.statement ?? null;
  return mode !== "original" && translated
    ? { text: translated, terms: translation!.key_terms, translated: true }
    : { text: original, terms, translated: false };
}
export const pointWords = (p: LayersReadPoint, mode: DocumentTextMode) =>
  words(mode, p.statement, p.key_terms, p.translation);
export const pointLabel = (p: LayersReadPoint, mode: DocumentTextMode) =>
  (mode !== "original" && p.translation?.label) || p.label || p.statement;
/** A sentence evidence's words in the reading shown. */
export function sentenceWords(
  e: Extract<LayersReadEvidence, { kind: "sentence" }>,
  mode: DocumentTextMode,
): { text: string; translated: boolean } {
  const t = e.translation?.text ?? null;
  return mode !== "original" && t
    ? { text: t, translated: true }
    : { text: e.text, translated: false };
}
export const langOf = (text: string) =>
  /[㐀-鿿]/u.test(text) ? "zh-Hans" : "en";

/**
 * Inline text as the page prints it: the document's safe Markdown (formulas,
 * emphasis), with the key terms wrapped. Terms are marked in text nodes, so a
 * term never crosses a formula or an emphasis.
 */
export function richHTML(text: string, terms: readonly string[] = []): string {
  const html = markdown.parseInline(text, { async: false }) as string;
  if (!terms.length) return html;
  const box = document.createElement("span");
  box.innerHTML = html;
  markTerms(box, terms);
  return box.innerHTML;
}
/** Wraps each key term found in the text nodes under `root` (rule key-term-match-v1). */
export function markTerms(
  root: Node,
  terms: readonly string[],
  skip: (node: Text) => boolean = () => false,
): void {
  if (!terms.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (
      !skip(n as Text) &&
      !(n as Text).parentElement?.closest(".katex, .rl-kt")
    )
      nodes.push(n as Text);
  for (const node of nodes) {
    const hits = markKeyTerms(node.data, terms);
    // From the end, so earlier offsets stay true while the node is split.
    for (const hit of hits.reverse()) {
      const range = document.createRange();
      range.setStart(node, hit.start);
      range.setEnd(node, hit.end);
      const mark = document.createElement("b");
      mark.className = "rl-kt";
      range.surroundContents(mark);
    }
  }
}
/**
 * A note's name, its paragraph's number (“¶41”, ADR 0073); a primary note's
 * stands in a filled ring.
 */
export const numberHTML = (
  p: { number: number; primary: boolean },
  paragraph: number,
  cls: string,
  piece = "",
) =>
  `<span class="${cls}${p.primary ? " rl-ring" : ""}" data-point="${p.number}"${
    piece ? ` data-f="${piece}"` : ""
  }>¶${paragraph}</span>`;
const LEAD = String.raw`(?:表|图|式|方案|Table|Fig\.?|Figure|Scheme|Chart)\s*S?\d+[a-z]?`;
const AT_START = new RegExp(
  String.raw`^\s*(${LEAD})\s*[.:：。]?\s*([\s\S]*)$`,
  "iu",
);
// A parser sometimes runs the labels inside a picture into its caption
// (“C1 C3Fig. 1. Molecular structures…”): the lead after a few such short
// labels, with its own stop after it, is still the caption's lead.
const AFTER_LABELS = new RegExp(
  String.raw`^(?:\s*[A-Z0-9(][\w+()\-]{0,5}){1,6}?\s*(${LEAD})\s*[.:：。]\s*([\s\S]*)$`,
  "u",
);
/** A caption's lead (“图 3.”, “Table 1”) apart from the rest. */
export function captionParts(caption: string | null): {
  lead: string | null;
  rest: string;
} {
  const m = AT_START.exec(caption ?? "") ?? AFTER_LABELS.exec(caption ?? "");
  return m ? { lead: m[1]!, rest: m[2]! } : { lead: null, rest: caption ?? "" };
}
/**
 * A figure's name in a reading, as its caption writes it: the original's
 * lead (“Fig. 8”), or in a translated reading the translation's own
 * (“图 8”). Nothing is rewritten: the translation prompt decides how a
 * label reads (technical 04 §9); without a lead of its own, the original's.
 */
export function figureNameIn(
  original: string | null,
  translated: string | null,
  mode: DocumentTextMode,
): string | null {
  return mode === "original" ? original : (translated ?? original);
}
/** A figure's name as the reading shows it; without the figure, a name by kind. */
export function figureName(
  f: LayerFigure | null,
  kind: string,
  mode: DocumentTextMode,
): string {
  return (
    f?.name(mode) ??
    (kind === "table" ? "表" : kind === "scheme" ? "方案" : "图")
  );
}
export const captionHTML = (lead: string, rest: string) =>
  `<b>${escape(lead)}</b>${richHTML(rest)}`;
/** A heading's own number apart from its words. */
export function headingHTML(title: string): string {
  const t = title.replace(/[.。]$/u, "");
  const m = /^\s*((?:\d+(?:\.\d+)*\.?|[IVX]+\.))\s+([\s\S]*)$/u.exec(t);
  return m
    ? `<span class="rl-hno">${escape(m[1]!.replace(/\.$/u, ""))}</span>${richHTML(m[2]!)}`
    : richHTML(t);
}
export { escape };
