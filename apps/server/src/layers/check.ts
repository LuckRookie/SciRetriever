import {
  LAYERS_ADVICE_MAX,
  LAYERS_DATA_MAX,
  LAYERS_DIGEST_UNITS,
  LAYERS_EVIDENCE_SENTENCES,
  LAYERS_EVIDENCE_SENTENCES_LONG,
  LAYERS_KEY_TERM_MAX,
  LAYERS_KEY_TERMS_PER_ITEM,
  LAYERS_LIMIT_TEXT_MAX,
  LAYERS_LIMITS_MAX,
  LAYERS_LONG_PARAGRAPH_SENTENCES,
  LAYERS_NOT_GIVEN_MAX,
  LAYERS_PART_CODE_POINTS,
  LAYERS_PART_UNITS,
  LAYERS_PLACE_TEXT_MAX,
  LAYERS_PLACES_MAX,
  LAYERS_POINT_KINDS,
  LAYERS_PRIMARY_MAX,
  LAYERS_QUANTITY_MAX,
  LAYERS_RELATION_TARGETS,
  LAYERS_RELATION_WORDS,
  LAYERS_RELATIONS_PER_POINT,
  LAYERS_SEE_MAX,
  LAYERS_STATEMENT_MAX_CJK,
  LAYERS_STATEMENT_MAX_WORDS,
  LAYERS_SUMMARY_MAX,
  LAYERS_TRANSLATION_TEXT_MAX,
  LAYERS_VALUE_MAX,
  layersLabelFits,
  layersLabelInStatement,
  layersReasonFits,
  layersStatementFits,
  layersTextFits,
  matchKeyTerm,
  splitSentences,
  utf8Offset,
  type DocumentLayout,
  type LayersDataRow,
  type LayersDigest,
  type LayersEvidence,
  type LayersPlace,
  type LayersPoint,
  type LayersPointKind,
  type LayersRelation,
  type LayersRelationWord,
  type LayersSectionLine,
  type LayersTranslatedPoint,
} from "@sciretriever/contracts";
import { unitSpan, type documentUnits } from "../translation/document.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
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
export interface LayersStructure {
  readonly segments: readonly Segment[];
  readonly sections: readonly Section[];
  readonly layout?: DocumentLayout;
  readonly long_document?: unknown;
}

type Sentence = {
  readonly start: number;
  readonly end: number;
  readonly start_utf8: number;
  readonly end_utf8: number;
};
/** A paragraph (spec 10.2): a translation unit of the body that is not a heading. */
export interface LayersParagraph {
  /** `pN`, unique in the document. */
  readonly short: string;
  readonly unit_id: string;
  readonly source: string;
  /** UTF-8 position of the unit's text in the fixed Markdown. */
  readonly start_utf8: number;
  readonly kind: "paragraph" | "list item" | "caption" | "footnote";
  /** The figure group a caption belongs to. */
  readonly figure: LayersFigure | null;
  /** Sentences as JavaScript indices of `source` and UTF-8 offsets from `start_utf8`. */
  readonly sentences: readonly Sentence[];
  /** Its section; null when the paper has no titled section. */
  readonly section_id: string | null;
  /** Longer than a note: counted for coverage (spec 10.3). */
  readonly annotatable: boolean;
}
export interface LayersFigure {
  readonly short: string;
  readonly segment_id: string;
  readonly kind: "figure" | "scheme" | "table";
  readonly start_utf8: number;
  readonly caption: string | null;
  /** The group's own text (a table's cells) and its captions, for data rows. */
  readonly text: string;
  readonly section_id: string | null;
}
/** A heading, named in the inputs as `sN`. */
export interface LayersHeading {
  readonly short: string;
  readonly segment_id: string;
  readonly section_id: string | null;
  readonly line: string;
  readonly level: number;
}
/** The paragraphs of one section, asked together or in parts. */
export interface LayersGroup {
  readonly section_id: string | null;
  readonly heading: LayersHeading | null;
  readonly paragraphs: readonly LayersParagraph[];
  readonly figures: readonly LayersFigure[];
  /** Runs of paragraphs, one call each; one run unless the section is long. */
  readonly parts: readonly (readonly LayersParagraph[])[];
}
export interface LayersPlan {
  readonly title: string | null;
  readonly abstract: string;
  readonly headings: ReadonlyMap<string, LayersHeading>;
  readonly paragraphs: ReadonlyMap<string, LayersParagraph>;
  readonly units: ReadonlyMap<string, LayersParagraph>;
  readonly figures: ReadonlyMap<string, LayersFigure>;
  readonly groups: readonly LayersGroup[];
  readonly body_code_points: number;
  readonly annotatable: number;
}

/** A figure group's captions as one line of text. */
export function figureCaption(
  markdown: Uint8Array,
  group: DocumentLayout["figure_groups"][number],
): string | null {
  return flat(rangesText(markdown, group.captions)) || null;
}
function rangesText(
  markdown: Uint8Array,
  ranges: readonly { start_utf8: number; end_utf8: number }[],
) {
  return ranges
    .map((c) => {
      try {
        return decoder.decode(markdown.subarray(c.start_utf8, c.end_utf8));
      } catch {
        return "";
      }
    })
    .join(" ");
}
/** Sentences of a unit (spec 3.5); captions are one sentence. */
export function unitSentences(source: string, kind: string) {
  return splitSentences(source, { whole: kind === "caption" }).map((s) => ({
    ...s,
    start_utf8: utf8Offset(source, s.start),
    end_utf8: utf8Offset(source, s.end),
  }));
}
const KINDS: Readonly<Record<string, LayersParagraph["kind"]>> = {
  list: "list item",
  caption: "caption",
  footnote: "footnote",
};
const ABSTRACT_TITLE = /^(?:abstract|summary|摘要|要旨|초록)$/iu;
/** Runs of at most 40 paragraphs and 12,000 code points, of about equal size. */
export function layersParts<T>(
  items: readonly T[],
  text: (item: T) => string,
): T[][] {
  const size = items.reduce((n, p) => n + codePoints(text(p)), 0);
  const k = Math.min(
    Math.max(1, items.length),
    Math.max(
      1,
      Math.ceil(items.length / LAYERS_PART_UNITS),
      Math.ceil(size / LAYERS_PART_CODE_POINTS),
    ),
  );
  const n = Math.max(1, Math.ceil(items.length / k));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * What the calls are given (spec 10.3): the paragraphs in reading order with
 * short ids `pN` and numbered sentences, the headings `sN`, the figures,
 * schemes and tables `fN`, grouped by section. Units are those of the
 * translation (spec 9.2); a caption is a paragraph of its own and also names
 * its figure.
 */
export function layersPlan(
  units: ReturnType<typeof documentUnits>["units"],
  structure: LayersStructure,
  markdown: Uint8Array,
  roles: ReadonlyMap<string, string>,
  title: string | null,
): LayersPlan {
  const segments = new Map(structure.segments.map((s) => [s.segment_id, s]));
  const sections = new Map(structure.sections.map((s) => [s.section_id, s]));
  const titled = structure.sections.some((s) => s.title !== null);
  const groups = structure.layout?.figure_groups ?? [];
  const figureList: Omit<LayersFigure, "short">[] = [];
  for (const g of groups) {
    const object = g.objects[0];
    if (!object) continue;
    figureList.push({
      segment_id: object.segment_id,
      kind: g.kind,
      start_utf8: object.start_utf8,
      caption: figureCaption(markdown, g),
      text: `${rangesText(markdown, g.objects)} ${rangesText(markdown, g.captions)}`,
      section_id: titled
        ? (segments.get(object.segment_id)?.section_id ?? null)
        : null,
    });
  }
  figureList.sort((a, b) => a.start_utf8 - b.start_utf8);
  const figures = new Map<string, LayersFigure>();
  const figureOf = new Map<string, LayersFigure>();
  for (const f of figureList) {
    const short = `f${figures.size + 1}`;
    const figure = { short, ...f };
    figures.set(short, figure);
  }
  for (const g of groups) {
    const f = [...figures.values()].find(
      (x) => x.segment_id === g.objects[0]?.segment_id,
    );
    if (f) for (const c of g.captions) figureOf.set(c.segment_id, f);
  }
  type Item =
    | { at: number; heading: Omit<LayersHeading, "short"> }
    | { at: number; paragraph: Omit<LayersParagraph, "short"> };
  const items: Item[] = [];
  let body = 0;
  const abstractParts: string[] = [];
  for (const u of units) {
    const found = u.segment_ids.map((id) => segments.get(id)!);
    const first = found[0]!;
    const span = unitSpan(markdown, found, u.source_sha256);
    if (!span) continue;
    if (first.kind === "heading") {
      const level = sections.get(first.section_id ?? "")?.level ?? 1;
      items.push({
        at: span.start,
        heading: {
          segment_id: first.segment_id,
          section_id: titled ? (first.section_id ?? null) : null,
          line: flat(u.source),
          level: Math.min(6, Math.max(1, level)),
        },
      });
      continue;
    }
    body += codePoints(u.source);
    if (roles.get(u.unit_id) === "abstract") abstractParts.push(flat(u.source));
    const kind = KINDS[first.kind] ?? "paragraph";
    items.push({
      at: span.payload,
      paragraph: {
        unit_id: u.unit_id,
        source: u.source,
        start_utf8: span.payload,
        kind,
        figure: figureOf.get(u.unit_id) ?? null,
        sentences: unitSentences(u.source, first.kind),
        section_id: titled ? (first.section_id ?? null) : null,
        annotatable: !layersTextFits(
          flat(u.source),
          LAYERS_STATEMENT_MAX_CJK,
          LAYERS_STATEMENT_MAX_WORDS,
          Number.MAX_SAFE_INTEGER,
        ),
      },
    });
  }
  items.sort((a, b) => a.at - b.at);
  const headings = new Map<string, LayersHeading>(),
    paragraphs = new Map<string, LayersParagraph>(),
    byUnit = new Map<string, LayersParagraph>();
  const grouped = new Map<string | null, LayersParagraph[]>();
  for (const item of items) {
    if ("heading" in item) {
      const short = `s${headings.size + 1}`;
      headings.set(short, { short, ...item.heading });
      continue;
    }
    const short = `p${paragraphs.size + 1}`;
    const p = { short, ...item.paragraph };
    paragraphs.set(short, p);
    byUnit.set(p.unit_id, p);
    const list = grouped.get(p.section_id) ?? [];
    if (!grouped.has(p.section_id)) grouped.set(p.section_id, list);
    list.push(p);
  }
  const headingOf = (section_id: string | null) =>
    section_id === null
      ? null
      : ([...headings.values()].find((h) => h.section_id === section_id) ??
        null);
  const sectionGroups: LayersGroup[] = [...grouped].map(([section_id, ps]) => ({
    section_id,
    heading: headingOf(section_id),
    paragraphs: ps,
    figures: [...figures.values()].filter((f) => f.section_id === section_id),
    parts: layersParts(ps, (p) => p.source),
  }));
  // No abstract role: the paragraphs under a heading named like one.
  let abstract = abstractParts.join(" ");
  if (!abstract) {
    const g = sectionGroups.find(
      (x) => x.heading && ABSTRACT_TITLE.test(x.heading.line),
    );
    abstract = g ? g.paragraphs.map((p) => flat(p.source)).join(" ") : "";
  }
  return {
    title: title ? flat(title) : null,
    abstract,
    headings,
    paragraphs,
    units: byUnit,
    figures,
    groups: sectionGroups,
    body_code_points: body,
    annotatable: [...paragraphs.values()].filter((p) => p.annotatable).length,
  };
}

/** The headings, indented by level below the highest one. */
function outline(plan: LayersPlan, here: LayersHeading | null) {
  const headings = [...plan.headings.values()];
  const top = Math.min(...headings.map((h) => h.level));
  return headings
    .map(
      (h) =>
        `${"  ".repeat(h.level - top)}${h === here ? "▶ " : ""}[${h.short}] ${h.line}`,
    )
    .join("\n");
}
const kindLine = (p: LayersParagraph) =>
  p.kind === "caption" && p.figure ? `caption of ${p.figure.short}` : p.kind;
const figureLine = (f: LayersFigure) =>
  `[${f.short}] ${f.kind}: ${f.caption ?? "(no caption)"}`;
function context(plan: LayersPlan, group: LayersGroup) {
  return [
    `Title: ${plan.title ?? "(none)"}`,
    "",
    "Abstract, for context:",
    plan.abstract || "(none)",
    "",
    "Outline (▶ marks this section):",
    outline(plan, group.heading) || "(the document has no headings)",
    "",
    `This section: ${group.heading ? `[${group.heading.short}] ${group.heading.line}` : "(no heading)"}`,
  ];
}

/** The input of one section call (spec 10.3); `part` when the section is asked in parts. */
export function sectionInput(
  plan: LayersPlan,
  group: LayersGroup,
  paragraphs: readonly LayersParagraph[],
  part: { readonly index: number; readonly of: number } | null,
): string {
  const lines = context(plan, group);
  if (part)
    lines.push(
      `This is part ${part.index} of ${part.of} of this section: paragraphs ${paragraphs[0]!.short} to ${paragraphs.at(-1)!.short}.`,
    );
  lines.push("", "Paragraphs:");
  for (const p of paragraphs) {
    lines.push("", `[${p.short}] ${kindLine(p)}`);
    p.sentences.forEach((s, i) =>
      lines.push(`<${i + 1}> ${flat(p.source.slice(s.start, s.end))}`),
    );
  }
  if (group.figures.length)
    lines.push(
      "",
      "Figures, schemes and tables of this section:",
      ...group.figures.map(figureLine),
    );
  return lines.join("\n") + "\n";
}
/**
 * The input of a section-line call: the notes of a section asked in parts.
 * For the translation part (`heading` given) only the title, the heading's
 * translation and the notes: the context would be in the original language.
 */
export function sectionLineInput(
  plan: LayersPlan,
  group: LayersGroup,
  notes: readonly { readonly short: string; readonly statement: string }[],
  heading?: string | null,
): string {
  return (
    [
      ...(heading === undefined
        ? context(plan, group)
        : [
            `Title: ${plan.title ?? "(none)"}`,
            "",
            `This section: ${heading ?? "(no heading)"}`,
          ]),
      "",
      "Notes of its paragraphs:",
      ...notes.map((n) => `[${n.short}] ${n.statement}`),
    ].join("\n") + "\n"
  );
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
const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRecord) : [];
const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Key terms kept: found in their text by key-term-match-v1, at most two. */
export function keepTerms(text: string, terms: readonly string[]) {
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

/** The counters of spec 10.3's checks; see `LayersDropped`. */
export function emptyDropped() {
  return {
    unanswered: 0,
    points: 0,
    evidence: 0,
    key_terms: 0,
    kinds: 0,
    labels: 0,
    reasons: 0,
    see: 0,
    sections: 0,
    relations: 0,
    primary: 0,
    digest_units: 0,
    data: 0,
    places: 0,
    limits: 0,
  };
}
export type Dropped = ReturnType<typeof emptyDropped>;

/** A paragraph's checked note, before the whole-document call numbers it. */
export interface LayersNote {
  readonly paragraph: LayersParagraph;
  readonly statement: string;
  readonly reason: string | null;
  readonly label: string | null;
  readonly kind: LayersPointKind | null;
  readonly key_terms: readonly string[];
  readonly evidence: readonly LayersEvidence[];
  /** Segment ids of the figures it names (`see`). */
  readonly see: readonly string[];
}
/** The evidence sentence numbers kept: existing, ascending, 1 to 2 (3 in a long paragraph). */
function sentenceNumbers(
  v: unknown,
  count: number,
  dropped: { evidence: number },
) {
  const asked = Array.isArray(v) ? v : [];
  const kept: number[] = [];
  for (const n of asked)
    if (
      Number.isSafeInteger(n) &&
      (n as number) >= 1 &&
      (n as number) <= count &&
      !kept.includes(n as number)
    )
      kept.push(n as number);
    else dropped.evidence++;
  kept.sort((a, b) => a - b);
  const max =
    count >= LAYERS_LONG_PARAGRAPH_SENTENCES
      ? LAYERS_EVIDENCE_SENTENCES_LONG
      : LAYERS_EVIDENCE_SENTENCES;
  dropped.evidence += Math.max(0, kept.length - max);
  return kept.slice(0, max);
}
/** Consecutive sentence numbers as UTF-8 ranges in `base + sentences`. */
function ranges(numbers: readonly number[], sentences: readonly Sentence[]) {
  const out: { start_utf8: number; end_utf8: number }[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push({
      start_utf8: sentences[run[0]! - 1]!.start_utf8,
      end_utf8: sentences[run.at(-1)! - 1]!.end_utf8,
    });
    run = [];
  };
  for (const n of numbers) {
    if (run.length && n !== run.at(-1)! + 1) flush();
    run.push(n);
  }
  flush();
  return out;
}
function lineOf(v: unknown, dropped: { sections: number; labels: number }) {
  const r = isRecord(v) ? v : {};
  const statement = trimmed(r.statement);
  if (!statement || !layersStatementFits(statement)) {
    dropped.sections++;
    return null;
  }
  const asked = trimmed(r.label);
  const label =
    asked && layersLabelFits(asked) && layersLabelInStatement(statement, asked)
      ? asked
      : null;
  if (asked && !label) dropped.labels++;
  return { statement, label };
}
/** A label kept: fits and is found in its statement. */
function labelOf(statement: string, v: unknown, dropped: { labels: number }) {
  const asked = trimmed(v);
  const label =
    asked && layersLabelFits(asked) && layersLabelInStatement(statement, asked)
      ? asked
      : null;
  if (asked && !label) dropped.labels++;
  return label;
}
function reasonOf(v: unknown, dropped: { reasons: number }) {
  const asked = trimmed(v);
  if (asked && !layersReasonFits(asked)) dropped.reasons++;
  return asked && layersReasonFits(asked) ? asked : null;
}
/**
 * The answer's entries for the asked paragraphs, by id. Throws
 * LayersAnswerError when it is not the structure asked for or names fewer
 * than half of them (it is asked again, spec 10.3).
 */
function entries(
  value: unknown,
  asked: readonly LayersParagraph[],
): Map<LayersParagraph, Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.units))
    throw new LayersAnswerError();
  const byShort = new Map(asked.map((p) => [p.short, p]));
  const out = new Map<LayersParagraph, Record<string, unknown>>();
  for (const raw of value.units) {
    if (!isRecord(raw) || typeof raw.statement !== "string")
      throw new LayersAnswerError();
    const p = byShort.get(trimmed(raw.id).toLowerCase());
    if (p && !out.has(p)) out.set(p, raw);
  }
  if (out.size * 2 < asked.length) throw new LayersAnswerError();
  return out;
}

export interface CheckedSection {
  readonly notes: readonly LayersNote[];
  /** The section's line; null when not given (a part) or dropped. */
  readonly line: { statement: string; label: string | null } | null;
}
/**
 * The check of one section call's answer (spec 10.3, ADR 0073 §7): ids and
 * sentence numbers exist, consecutive sentences become one evidence, lengths
 * fit, label and key terms are found in the statement, `see` names figures of
 * this section. A failing item is dropped and counted; the text is never
 * rewritten. An empty statement means the paragraph has no note.
 */
export function checkSectionAnswer(
  value: unknown,
  group: LayersGroup,
  asked: readonly LayersParagraph[],
  part: boolean,
  dropped: Dropped,
): CheckedSection {
  const found = entries(value, asked);
  const figures = new Map(group.figures.map((f) => [f.short, f]));
  const notes: LayersNote[] = [];
  for (const p of asked) {
    const raw = found.get(p);
    if (!raw) {
      dropped.unanswered++;
      continue;
    }
    const statement = trimmed(raw.statement);
    if (!statement) continue;
    if (!layersStatementFits(statement)) {
      dropped.points++;
      continue;
    }
    const numbers = sentenceNumbers(raw.evidence, p.sentences.length, dropped);
    if (!numbers.length) {
      dropped.points++;
      continue;
    }
    const evidence: LayersEvidence[] = ranges(numbers, p.sentences).map(
      (r) => ({
        kind: "sentence",
        unit_id: p.unit_id,
        start_utf8: p.start_utf8 + r.start_utf8,
        end_utf8: p.start_utf8 + r.end_utf8,
      }),
    );
    // A caption's note also rests on its own figure or table (spec 10.2).
    if (p.figure)
      evidence.push({ kind: "block", segment_id: p.figure.segment_id });
    const kind = LAYERS_POINT_KINDS.includes(raw.kind as LayersPointKind)
      ? (raw.kind as LayersPointKind)
      : null;
    if (!kind && trimmed(raw.kind)) dropped.kinds++;
    const see: string[] = [];
    for (const s of strings(raw.see)) {
      const f = figures.get(s.trim().toLowerCase());
      if (
        !f ||
        f === p.figure ||
        see.includes(f.segment_id) ||
        see.length >= LAYERS_SEE_MAX
      ) {
        dropped.see++;
        continue;
      }
      see.push(f.segment_id);
    }
    const terms = keepTerms(statement, strings(raw.key_terms));
    dropped.key_terms += terms.dropped;
    notes.push({
      paragraph: p,
      statement,
      reason: reasonOf(raw.reason, dropped),
      label: labelOf(statement, raw.label, dropped),
      kind,
      key_terms: terms.kept,
      evidence,
      see,
    });
  }
  const section = isRecord(value) ? value.section : undefined;
  return { notes, line: part ? null : lineOf(section, dropped) };
}
/** The check of a section-line call's answer. Throws when not the structure. */
export function checkLineAnswer(
  value: unknown,
  dropped: { sections: number; labels: number },
) {
  if (!isRecord(value) || !isRecord(value.section))
    throw new LayersAnswerError();
  return lineOf(value.section, dropped);
}

/** The input of the whole-document call (spec 10.3): titles, lines and notes, never the full text. */
export function documentInput(
  plan: LayersPlan,
  lines: ReadonlyMap<string | null, { statement: string }>,
  notes: ReadonlyMap<string, LayersNote>,
): string {
  const out = [
    `Title: ${plan.title ?? "(none)"}`,
    "",
    "Abstract:",
    plan.abstract || "(none)",
    "",
    "Sections and the notes of their paragraphs:",
  ];
  for (const g of plan.groups) {
    const line = lines.get(g.section_id)?.statement;
    out.push(
      "",
      `${g.heading ? `[${g.heading.short}] ${g.heading.line}` : "(no heading)"}${line ? `: ${line}` : ""}`,
    );
    for (const p of g.paragraphs) {
      const n = notes.get(p.unit_id);
      if (n) out.push(`[${p.short}] ${n.kind ?? "note"}: ${n.statement}`);
    }
  }
  if (plan.figures.size)
    out.push(
      "",
      "Figures, schemes and tables:",
      ...[...plan.figures.values()].map(figureLine),
    );
  return out.join("\n") + "\n";
}

/** Every number in a value appears in the source text, not inside a longer number. */
function numbersFound(value: string, source: string): boolean {
  const numbers = value.match(/\d+(?:[.,]\d+)*/gu);
  if (!numbers) return false;
  return numbers.every((n) =>
    new RegExp(
      `(?<![\\d.,])${n.replace(/\./gu, "\\.")}(?![\\d]|[.,]\\d)`,
      "u",
    ).test(source),
  );
}

export interface CheckedDocument {
  readonly digest: LayersDigest;
  readonly data: readonly LayersDataRow[];
  /** Point numbers of the trunk, at most five, by number. */
  readonly primary: ReadonlySet<number>;
  /** Relations by point number, after the note's own `see`. */
  readonly relations: ReadonlyMap<number, readonly LayersRelation[]>;
  readonly summary_missing: boolean;
}
/**
 * The check of the whole-document call's answer (spec 10.3). `numbers` maps
 * a paragraph's `pN` to the number of its note; `see` how many relations a
 * note already has. Throws LayersAnswerError when it is not the structure.
 */
export function checkDocumentAnswer(
  value: unknown,
  plan: LayersPlan,
  numbers: ReadonlyMap<string, number>,
  seeCount: ReadonlyMap<number, number>,
  dropped: Dropped,
): CheckedDocument {
  if (
    !isRecord(value) ||
    !isRecord(value.digest) ||
    !isRecord(value.digest.summary)
  )
    throw new LayersAnswerError();
  const unitsOf = (v: unknown) => {
    const asked = strings(v),
      ids: string[] = [];
    for (const short of asked) {
      const p = plan.paragraphs.get(short.trim().toLowerCase());
      if (p && !ids.includes(p.unit_id) && ids.length < LAYERS_DIGEST_UNITS)
        ids.push(p.unit_id);
    }
    dropped.digest_units += asked.length - ids.length;
    return ids;
  };
  const termsOf = (text: string | null, v: unknown) => {
    const asked = strings(v);
    const t = text
      ? keepTerms(text, asked)
      : { kept: [], dropped: asked.length };
    dropped.key_terms += t.dropped;
    return t.kept;
  };
  const d = value.digest;
  const summaryRaw = d.summary as Record<string, unknown>;
  const summaryText = trimmed(summaryRaw.text);
  const summaryOk =
    !!summaryText && codePoints(summaryText) <= LAYERS_SUMMARY_MAX;
  const limits: { text: string; units: string[] }[] = [];
  for (const l of records(d.limits)) {
    const text = trimmed(l.text);
    if (
      !text ||
      codePoints(text) > LAYERS_LIMIT_TEXT_MAX ||
      limits.length >= LAYERS_LIMITS_MAX
    ) {
      dropped.limits++;
      continue;
    }
    limits.push({ text, units: unitsOf(l.units) });
  }
  const adviceRaw = isRecord(d.advice) ? d.advice : {};
  const adviceAsked = trimmed(adviceRaw.text);
  // An overlong advice is left empty, not a failure.
  const adviceText =
    adviceAsked && codePoints(adviceAsked) <= LAYERS_ADVICE_MAX
      ? adviceAsked
      : null;
  const notGiven = trimmed(adviceRaw.not_given);
  const places: LayersPlace[] = [];
  for (const p of records(adviceRaw.places)) {
    const text = trimmed(p.text);
    const target = trimmed(p.target).toLowerCase();
    const heading = plan.headings.get(target),
      figure = plan.figures.get(target);
    if (
      !adviceText ||
      !text ||
      codePoints(text) > LAYERS_PLACE_TEXT_MAX ||
      !adviceText.includes(text) ||
      (!heading && !figure) ||
      places.length >= LAYERS_PLACES_MAX
    ) {
      dropped.places++;
      continue;
    }
    places.push({
      text,
      target: heading
        ? { kind: "section", segment_id: heading.segment_id }
        : { kind: "block", segment_id: figure!.segment_id },
    });
  }
  const digest: LayersDigest = {
    summary: {
      text: summaryOk ? summaryText : "",
      units: unitsOf(summaryRaw.units),
      key_terms: termsOf(summaryOk ? summaryText : null, summaryRaw.key_terms),
    },
    limits,
    advice: {
      text: adviceText,
      not_given:
        adviceText === null &&
        notGiven &&
        codePoints(notGiven) <= LAYERS_NOT_GIVEN_MAX
          ? notGiven
          : null,
      units: adviceText === null ? [] : unitsOf(adviceRaw.units),
      key_terms: termsOf(adviceText, adviceRaw.key_terms),
      places,
    },
  };
  // Data rows: a value's numbers must appear in its source's text.
  const data: LayersDataRow[] = [];
  for (const row of records(value.data)) {
    const quantity = trimmed(row.quantity),
      v = trimmed(row.value),
      source = trimmed(row.source).toLowerCase();
    const unit = plan.paragraphs.get(source),
      table = plan.figures.get(source);
    const text = unit?.source ?? (table?.kind === "table" ? table.text : null);
    if (
      !quantity ||
      codePoints(quantity) > LAYERS_QUANTITY_MAX ||
      !v ||
      codePoints(v) > LAYERS_VALUE_MAX ||
      text === null ||
      !numbersFound(v, text) ||
      data.length >= LAYERS_DATA_MAX
    ) {
      dropped.data++;
      continue;
    }
    data.push({
      quantity,
      value: v,
      source: unit
        ? { kind: "unit", unit_id: unit.unit_id }
        : { kind: "block", segment_id: table!.segment_id },
    });
  }
  const numberOf = (short: string) =>
    numbers.get(short.trim().toLowerCase()) ?? null;
  // The trunk: notes only, the first five by number.
  const asked: number[] = [];
  for (const short of strings(value.primary)) {
    const n = numberOf(short);
    if (n === null || asked.includes(n)) dropped.primary++;
    else asked.push(n);
  }
  asked.sort((a, b) => a - b);
  dropped.primary += Math.max(0, asked.length - LAYERS_PRIMARY_MAX);
  const primary = new Set(asked.slice(0, LAYERS_PRIMARY_MAX));
  // Relations between notes; `see` came with the section calls.
  const relations = new Map<number, LayersRelation[]>();
  for (const rel of records(value.relations)) {
    const from = numberOf(trimmed(rel.from));
    const word = rel.word as LayersRelationWord;
    const targetsAsked = strings(rel.targets);
    const targets = targetsAsked.map(numberOf);
    const own = from === null ? [] : (relations.get(from) ?? []);
    if (
      from === null ||
      word === "see" ||
      !LAYERS_RELATION_WORDS.includes(word) ||
      !targets.length ||
      targets.length > LAYERS_RELATION_TARGETS ||
      targets.some((t) => t === null || t === from) ||
      new Set(targets).size !== targets.length ||
      own.length + (seeCount.get(from) ?? 0) >= LAYERS_RELATIONS_PER_POINT
    ) {
      dropped.relations++;
      continue;
    }
    own.push({
      word,
      targets: (targets as number[]).map((number) => ({
        kind: "point",
        number,
      })),
    });
    relations.set(from, own);
  }
  return {
    digest,
    data,
    primary,
    relations,
    summary_missing: !summaryOk,
  };
}

/** The notes numbered in reading order, with the whole-document call's marks (spec 10.2). */
export function numberedPoints(
  notes: readonly LayersNote[],
  document: CheckedDocument | null,
): LayersPoint[] {
  return notes.map((n, i) => {
    const number = i + 1;
    const primary = document?.primary.has(number) ?? false;
    return {
      number,
      unit_id: n.paragraph.unit_id,
      statement: n.statement,
      reason: n.reason,
      evidence: n.evidence,
      key_terms: n.key_terms,
      section_id: n.paragraph.section_id,
      primary,
      label: n.label,
      kind: n.kind,
      relations: [
        ...(n.see.length
          ? [
              {
                word: "see" as const,
                targets: n.see.map((segment_id) => ({
                  kind: "block" as const,
                  segment_id,
                })),
              },
            ]
          : []),
        ...(document?.relations.get(number) ?? []),
      ],
      basis: primary ? n.evidence[0]! : null,
    };
  });
}

/** A paragraph of the translation part: its stored translation in numbered sentences. */
export interface TranslatedParagraph {
  readonly paragraph: LayersParagraph;
  readonly point: LayersPoint;
  readonly translation: string;
  readonly sentences: readonly Sentence[];
  /** Indices of the point's sentence evidence, named `e1`, `e2`… in the input. */
  readonly evidence: readonly number[];
}
/** The JSON input of one translation section call (spec 10.5). */
export function translationSectionInput(
  plan: LayersPlan,
  heading: string | null,
  paragraphs: readonly TranslatedParagraph[],
  markdown: Uint8Array,
  part: { readonly index: number; readonly of: number } | null,
): string {
  return JSON.stringify({
    title: plan.title,
    section: heading,
    part,
    paragraphs: paragraphs.map((t) => ({
      id: t.paragraph.short,
      kind: t.point.kind,
      sentences: t.sentences.map((s, i) => ({
        n: i + 1,
        text: flat(t.translation.slice(s.start, s.end)),
      })),
      evidence: t.evidence.map((index, k) => {
        const e = t.point.evidence[index]!;
        return {
          id: `e${k + 1}`,
          original:
            e.kind === "sentence"
              ? flat(
                  decoder.decode(markdown.subarray(e.start_utf8, e.end_utf8)),
                )
              : "",
        };
      }),
    })),
  });
}
type PartDropped = {
  points: number;
  sections: number;
  reasons: number;
  labels: number;
  key_terms: number;
  evidence: number;
  places: number;
};
/**
 * The check of a translation section answer (spec 10.5): the same rules as
 * the original's; evidence sentence numbers exist and are consecutive, or
 * that evidence's translated position is null. Throws LayersAnswerError when
 * it is not the structure or names fewer than half the paragraphs.
 */
export function checkTranslationSectionAnswer(
  value: unknown,
  asked: readonly TranslatedParagraph[],
  part: boolean,
  dropped: PartDropped,
): {
  readonly points: ReadonlyMap<string, LayersTranslatedPoint>;
  readonly line: { statement: string; label: string | null } | null;
} {
  const found = entries(
    value,
    asked.map((t) => t.paragraph),
  );
  const points = new Map<string, LayersTranslatedPoint>();
  for (const t of asked) {
    const raw = found.get(t.paragraph);
    const statement = trimmed(raw?.statement);
    if (!raw || !statement || !layersStatementFits(statement)) {
      dropped.points++;
      continue;
    }
    const given = records(raw.evidence);
    const evidence = t.point.evidence.map((_, index) => {
      const k = t.evidence.indexOf(index);
      if (k < 0) return null;
      const hit = given.find((g) => trimmed(g.id) === `e${k + 1}`);
      const numbers = Array.isArray(hit?.sentences) ? hit.sentences : [];
      const ok =
        numbers.length >= 1 &&
        numbers.every(
          (n, i) =>
            Number.isSafeInteger(n) &&
            (i === 0 || n === (numbers[i - 1] as number) + 1),
        ) &&
        (numbers[0] as number) >= 1 &&
        (numbers.at(-1) as number) <= t.sentences.length;
      if (!ok) {
        dropped.evidence++;
        return null;
      }
      return {
        start_utf8: t.sentences[(numbers[0] as number) - 1]!.start_utf8,
        end_utf8: t.sentences[(numbers.at(-1) as number) - 1]!.end_utf8,
      };
    });
    const terms = keepTerms(statement, strings(raw.key_terms));
    dropped.key_terms += terms.dropped;
    points.set(t.paragraph.unit_id, {
      statement,
      reason: reasonOf(raw.reason, dropped),
      label: labelOf(statement, raw.label, dropped),
      key_terms: terms.kept,
      evidence,
    });
  }
  const section = isRecord(value) ? value.section : undefined;
  return { points, line: part ? null : lineOf(section, dropped) };
}

/** The JSON input of the translation part's whole-document call. */
export function translationDocumentInput(
  plan: LayersPlan,
  file: {
    readonly digest: LayersDigest;
    readonly data: readonly LayersDataRow[];
  },
  sections: readonly {
    readonly heading: string | null;
    readonly line: string | null;
    readonly notes: readonly {
      readonly id: string;
      readonly note: string;
    }[];
  }[],
): string {
  const { summary, limits, advice } = file.digest;
  return JSON.stringify({
    title: plan.title,
    sections,
    write: {
      summary: summary.text,
      limits: limits.map((l, i) => ({ id: `L${i + 1}`, text: l.text })),
      advice:
        advice.text === null
          ? null
          : {
              text: advice.text,
              places: advice.places.map((p, i) => ({
                id: `P${i + 1}`,
                text: p.text,
              })),
            },
      data: file.data.map((d, i) => ({
        id: `Q${i + 1}`,
        quantity: d.quantity,
      })),
    },
  });
}
/** The check of the translation part's whole-document answer. Throws when not the structure. */
export function checkTranslationDocumentAnswer(
  value: unknown,
  file: {
    readonly digest: LayersDigest;
    readonly data: readonly LayersDataRow[];
  },
  dropped: PartDropped,
) {
  if (!isRecord(value) || !isRecord(value.summary))
    throw new LayersAnswerError();
  const text = (v: unknown) => {
    const t = trimmed(v);
    return t && codePoints(t) <= LAYERS_TRANSLATION_TEXT_MAX ? t : null;
  };
  const byId = (v: unknown, key: string) =>
    new Map(records(v).map((r) => [trimmed(r.id), r[key]]));
  const summaryText = text(value.summary.text);
  const summaryTerms = summaryText
    ? keepTerms(summaryText, strings(value.summary.key_terms))
    : { kept: [], dropped: strings(value.summary.key_terms).length };
  dropped.key_terms += summaryTerms.dropped;
  const limits = byId(value.limits, "text");
  const adviceRaw = isRecord(value.advice) ? value.advice : {};
  const adviceText =
    file.digest.advice.text === null ? null : text(adviceRaw.text);
  const adviceTerms = adviceText
    ? keepTerms(adviceText, strings(adviceRaw.key_terms))
    : { kept: [], dropped: 0 };
  dropped.key_terms += adviceTerms.dropped;
  const places = byId(adviceRaw.places, "text");
  const data = byId(value.data, "quantity");
  return {
    digest: {
      summary: { text: summaryText, key_terms: summaryTerms.kept },
      limits: file.digest.limits.map((_, i) => text(limits.get(`L${i + 1}`))),
      advice: {
        text: adviceText,
        key_terms: adviceTerms.kept,
        // A place's words count only when they are in the advice's version.
        places: file.digest.advice.places.map((_, i) => {
          const words = text(places.get(`P${i + 1}`));
          if (
            adviceText &&
            words &&
            codePoints(words) <= LAYERS_PLACE_TEXT_MAX * 2 &&
            adviceText.includes(words)
          )
            return words;
          dropped.places++;
          return null;
        }),
      },
    },
    data: file.data.map((_, i) => text(data.get(`Q${i + 1}`))),
  };
}
export type { LayersSectionLine };
