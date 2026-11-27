import {
  markKeyTerms,
  type DocumentLayersOverviewResult,
  type LayersPointKind,
  type LayersReadBasis,
  type LayersReadEvidence,
  type LayersReadPoint,
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

export interface LayersModel {
  readonly data: ReadLayers;
  readonly overview: DocumentLayersOverviewResult;
  readonly points: readonly ReadLayersPoint[];
  readonly byNumber: ReadonlyMap<number, ReadLayersPoint>;
  readonly primary: readonly (LayersReadPoint & { basis: LayersReadBasis })[];
  /** Sections in text order, each with its points' numbers. */
  readonly sections: readonly {
    readonly section_id: string | null;
    readonly title: string | null;
    readonly numbers: readonly number[];
  }[];
  /** Whether the layers carry a translation part. */
  readonly translated: boolean;
}
export function layersModel(data: ReadLayers): LayersModel {
  const byNumber = new Map(data.points.map((p) => [p.number, p]));
  return {
    data,
    overview: data.overview,
    points: data.points,
    byNumber,
    primary: data.overview.primary,
    sections: data.overview.sections.map((s) => ({
      section_id: s.section_id,
      title: s.title,
      numbers: s.points.map((p) => p.number),
    })),
    translated: data.text === "bilingual",
  };
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
/** A note's number in its ring; a primary note's ring is filled. */
export const numberHTML = (
  p: { number: number; primary: boolean },
  cls: string,
  piece = "",
) =>
  `<span class="${cls}${p.primary ? " rl-ring" : ""}" data-point="${p.number}"${
    piece ? ` data-f="${piece}"` : ""
  }>${p.number}</span>`;
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
 * A figure's name as the reading shows it: its caption's own lead in the
 * reading's language (“图 8” beside a translation, “Fig. 8” beside the
 * original), else the engine's label, else a name by kind.
 */
export function figureName(
  f: LayerFigure | null,
  kind: string,
  mode: DocumentTextMode,
): string {
  return (
    (f ? captionParts(f.caption(mode)).lead : null) ??
    f?.label ??
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
