import {
  LAYERS_ADVICE_MAX,
  LAYERS_DATA_MAX,
  LAYERS_DIGEST_UNITS,
  LAYERS_EVIDENCE_PER_POINT,
  LAYERS_EVIDENCE_SENTENCES,
  LAYERS_KEY_TERM_MAX,
  LAYERS_KEY_TERMS_PER_ITEM,
  LAYERS_LIMIT_TEXT_MAX,
  LAYERS_LIMITS_MAX,
  LAYERS_NOT_GIVEN_MAX,
  LAYERS_PLACE_TEXT_MAX,
  LAYERS_PLACES_MAX,
  LAYERS_POINT_KINDS,
  LAYERS_POINTS_MAX,
  LAYERS_PRIMARY_MAX,
  LAYERS_QUANTITY_MAX,
  LAYERS_RELATION_TARGETS,
  LAYERS_RELATION_WORDS,
  LAYERS_RELATIONS_PER_POINT,
  LAYERS_STATEMENT_MAX,
  LAYERS_SUMMARY_MAX,
  LAYERS_VALUE_MAX,
  layersLabelFits,
  matchKeyTerm,
  splitSentences,
  utf8Offset,
  type DocumentLayout,
  type LayersDataRow,
  type LayersDigest,
  type LayersDropped,
  type LayersEvidence,
  type LayersPlace,
  type LayersPoint,
  type LayersPointKind,
  type LayersRelation,
  type LayersRelationTarget,
  type LayersRelationWord,
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
  /** The group's own text (a table's cells) and its captions, for data rows. */
  readonly text: string;
}
/** A titled section: its heading segment, named in the input as `sN`. */
export interface LayersHeading {
  readonly short: string;
  readonly segment_id: string;
}
export interface LayersInput {
  readonly text: string;
  readonly units: ReadonlyMap<string, LayersUnit>;
  readonly figures: ReadonlyMap<string, LayersFigure>;
  readonly headings: ReadonlyMap<string, LayersHeading>;
  readonly body_code_points: number;
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

/**
 * The first call's input (spec 10.3): the readable content in order, each
 * heading with a short id `sN`, each paragraph with a short id `pN` and
 * numbered sentences, each figure, scheme or table one line `fN` with its
 * caption. Units are those of the translation (spec 9.2); a caption of a
 * figure group is given with its figure, not as a paragraph.
 */
export function layersInput(
  units: ReturnType<typeof documentUnits>["units"],
  structure: LayersStructure,
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
    | {
        at: number;
        heading: { segment_id: string; line: string; level: number };
      }
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
        heading: {
          segment_id: first.segment_id,
          line: flat(u.source),
          level: Math.min(6, Math.max(1, level)),
        },
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
        text: `${rangesText(markdown, g.objects)} ${rangesText(markdown, g.captions)}`,
      },
    });
  }
  items.sort((a, b) => a.at - b.at);
  const unitMap = new Map<string, LayersUnit>(),
    figureMap = new Map<string, LayersFigure>(),
    headingMap = new Map<string, LayersHeading>();
  const lines = [
    `Maximum number of points: ${maxPoints}`,
    "",
    `Title: ${title ? flat(title) : "(none)"}`,
    "",
  ];
  for (const item of items) {
    if ("heading" in item) {
      const short = `s${headingMap.size + 1}`;
      headingMap.set(short, { short, segment_id: item.heading.segment_id });
      lines.push(
        "",
        `${"#".repeat(item.heading.level)} [${short}] ${item.heading.line}`,
        "",
      );
    } else if ("unit" in item) {
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
    headings: headingMap,
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
type Located = LayersEvidence & {
  at: number;
  unit?: LayersUnit;
  numbers?: number[];
};
/** One "pN.S-T" or "fN" of the input, or null when it names nothing valid. */
function locate(spec: string, input: LayersInput): Located | null {
  const sentence = /^\s*(p\d+)\s*[.:·]\s*([\d,\s–-]+?)\s*$/iu.exec(spec);
  const figure = /^\s*(f\d+)\s*$/iu.exec(spec);
  if (sentence) {
    const unit = input.units.get(sentence[1]!.toLowerCase());
    const numbers = sentenceList(sentence[2]!);
    if (
      !unit ||
      !numbers ||
      numbers.length < 1 ||
      numbers.length > LAYERS_EVIDENCE_SENTENCES ||
      !numbers.every((n, k) => k === 0 || n === numbers[k - 1]! + 1) ||
      numbers[0]! < 1 ||
      numbers.at(-1)! > unit.sentences.length
    )
      return null;
    const a = unit.sentences[numbers[0]! - 1]!,
      b = unit.sentences[numbers.at(-1)! - 1]!;
    return {
      kind: "sentence",
      unit_id: unit.unit_id,
      start_utf8: unit.start_utf8 + a.start_utf8,
      end_utf8: unit.start_utf8 + b.end_utf8,
      at: unit.start_utf8 + a.start_utf8,
      unit,
      numbers,
    };
  }
  if (figure) {
    const f = input.figures.get(figure[1]!.toLowerCase());
    if (f) return { kind: "block", segment_id: f.segment_id, at: f.start_utf8 };
  }
  return null;
}
const plain = (e: Located): LayersEvidence =>
  e.kind === "block"
    ? { kind: "block", segment_id: e.segment_id }
    : {
        kind: "sentence",
        unit_id: e.unit_id,
        start_utf8: e.start_utf8,
        end_utf8: e.end_utf8,
      };
/** Where `quote` lies in `text` (JavaScript indices): verbatim, else up to whitespace. */
function findQuote(text: string, quote: string): [number, number] | null {
  const at = text.indexOf(quote);
  if (at >= 0) return [at, at + quote.length];
  const parts = quote.split(/\s+/u).filter(Boolean);
  if (!parts.length) return null;
  const re = new RegExp(
    parts.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")).join("\\s+"),
    "u",
  );
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
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

export interface CheckedLayers {
  readonly digest: LayersDigest;
  readonly points: readonly LayersPoint[];
  readonly data: readonly LayersDataRow[];
  readonly given: number;
  /** Points left before the cap of 40; the success rule compares this with `given`. */
  readonly valid: number;
  readonly dropped: LayersDropped;
  readonly summary_missing: boolean;
  /** Primary points left, before the cap of five. */
  readonly primary: number;
}

/**
 * The program check of the first call's answer (spec 10.3, 10.2.1).
 * Evidence that names nothing, or more than four or non-consecutive
 * sentences, is dropped; a point without evidence, or with an empty or
 * overlong statement, is dropped; the rest are ordered by their first
 * evidence and numbered again. Of the ADR 0070 content, a kind, label,
 * relation, basis, data row, place or limitation that fails its check is
 * dropped alone and counted; the point stays. Throws LayersAnswerError when
 * the answer is not the structure asked for.
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
    !isRecord(value.digest.summary) ||
    !Array.isArray(value.points)
  )
    throw new LayersAnswerError();
  const dropped = {
    evidence: 0,
    points: 0,
    key_terms: 0,
    digest_units: 0,
    kinds: 0,
    labels: 0,
    relations: 0,
    basis: 0,
    data: 0,
    places: 0,
    limits: 0,
    primary: 0,
  };
  const unitsOf = (v: unknown) => {
    const asked = strings(v),
      ids: string[] = [];
    for (const short of asked) {
      const unit = input.units.get(short.trim().toLowerCase());
      if (
        unit &&
        !ids.includes(unit.unit_id) &&
        ids.length < LAYERS_DIGEST_UNITS
      )
        ids.push(unit.unit_id);
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
  // Digest.
  const answerDigest = value.digest;
  const summaryRaw = answerDigest.summary as Record<string, unknown>;
  const summaryText = trimmed(summaryRaw.text);
  const summaryOk =
    !!summaryText && codePoints(summaryText) <= LAYERS_SUMMARY_MAX;
  const limits: { text: string; units: string[] }[] = [];
  for (const l of records(answerDigest.limits)) {
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
  const adviceRaw = isRecord(answerDigest.advice) ? answerDigest.advice : {};
  const adviceAsked = trimmed(adviceRaw.text);
  // An overlong item is left empty, not a failure (spec 10.3).
  const adviceText =
    adviceAsked && codePoints(adviceAsked) <= LAYERS_ADVICE_MAX
      ? adviceAsked
      : null;
  const notGiven = trimmed(adviceRaw.not_given);
  const places: LayersPlace[] = [];
  for (const p of records(adviceRaw.places)) {
    const text = trimmed(p.text);
    const target = trimmed(p.target).toLowerCase();
    const heading = input.headings.get(target),
      figure = input.figures.get(target);
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
    const unit = input.units.get(source),
      table = input.figures.get(source);
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
  // Points.
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
  interface Kept {
    answer: number;
    at: number;
    statement: string;
    evidence: Located[];
    key_terms: string[];
    section_id: string | null;
    primary: boolean;
    label: string | null;
    kind: LayersPointKind | null;
    raw: Record<string, unknown>;
  }
  const kept: Kept[] = [];
  value.points.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.statement !== "string")
      throw new LayersAnswerError();
    const statement = raw.statement.trim();
    const evidence: Located[] = [];
    for (const spec of strings(raw.evidence)) {
      const found = locate(spec, input);
      const identity = (e: LayersEvidence) =>
        e.kind === "block"
          ? `b:${e.segment_id}`
          : `s:${e.start_utf8}:${e.end_utf8}`;
      if (
        !found ||
        evidence.some((e) => identity(e) === identity(found)) ||
        evidence.length >= LAYERS_EVIDENCE_PER_POINT
      ) {
        dropped.evidence++;
        continue;
      }
      evidence.push(found);
    }
    // Evidence of a dropped point is not counted again.
    if (
      !evidence.length ||
      !statement ||
      codePoints(statement) > LAYERS_STATEMENT_MAX
    )
      return;
    evidence.sort((a, b) => a.at - b.at);
    const labelAsked = trimmed(raw.label);
    const label = labelAsked && layersLabelFits(labelAsked) ? labelAsked : null;
    if (labelAsked && !label) dropped.labels++;
    const kind = LAYERS_POINT_KINDS.includes(raw.kind as LayersPointKind)
      ? (raw.kind as LayersPointKind)
      : null;
    if (raw.kind !== null && raw.kind !== undefined && !kind) dropped.kinds++;
    kept.push({
      answer: index + 1,
      at: evidence[0]!.at,
      statement,
      evidence,
      key_terms: termsOf(statement, raw.key_terms),
      section_id: sectionAt(evidence[0]!.at),
      primary: raw.primary === true,
      label,
      kind,
      raw,
    });
  });
  kept.sort((a, b) => a.at - b.at);
  const valid = kept.length;
  const capped = kept.slice(0, LAYERS_POINTS_MAX);
  const numberOf = new Map(capped.map((k, i) => [k.answer, i + 1]));
  // Primary points: the first five by number stay primary.
  let primaries = 0;
  for (const k of capped)
    if (k.primary) {
      primaries++;
      if (primaries > LAYERS_PRIMARY_MAX) {
        k.primary = false;
        dropped.primary++;
      }
    }
  const points: LayersPoint[] = capped.map((k, i) => {
    const number = i + 1;
    const relations: LayersRelation[] = [];
    for (const rel of records(k.raw.relations)) {
      const word = rel.word as LayersRelationWord;
      const targets: LayersRelationTarget[] = [];
      let ok = LAYERS_RELATION_WORDS.includes(word);
      const asked = strings(rel.targets);
      if (!asked.length || asked.length > LAYERS_RELATION_TARGETS) ok = false;
      for (const t of ok ? asked : []) {
        const point = /^\s*k(\d+)\s*$/iu.exec(t);
        const figure = input.figures.get(t.trim().toLowerCase());
        const target = point ? numberOf.get(Number(point[1])) : undefined;
        if (
          point &&
          target !== undefined &&
          target !== number &&
          word !== "see"
        )
          targets.push({ kind: "point", number: target });
        else if (figure)
          targets.push({ kind: "block", segment_id: figure.segment_id });
        else ok = false;
      }
      if (!ok || relations.length >= LAYERS_RELATIONS_PER_POINT) {
        dropped.relations++;
        continue;
      }
      relations.push({ word, targets });
    }
    // The basis lies inside one of the point's evidence.
    let basis: LayersEvidence | null = null;
    if (isRecord(k.raw.basis)) {
      const spec = trimmed(k.raw.basis.evidence);
      const quote = trimmed(k.raw.basis.quote);
      const at = spec ? locate(spec, input) : null;
      let found: LayersEvidence | null = null;
      if (at?.kind === "block") {
        if (
          k.evidence.some(
            (e) => e.kind === "block" && e.segment_id === at.segment_id,
          )
        )
          found = plain(at);
      } else if (at?.kind === "sentence" && at.unit) {
        const within = k.evidence.some(
          (e) =>
            e.kind === "sentence" &&
            e.unit_id === at.unit_id &&
            e.start_utf8 <= at.start_utf8 &&
            at.end_utf8 <= e.end_utf8,
        );
        if (within) {
          const unit = at.unit,
            first = unit.sentences[at.numbers![0]! - 1]!,
            last = unit.sentences[at.numbers!.at(-1)! - 1]!;
          const span = unit.source.slice(first.start, last.end);
          const hit: [number, number] | null = quote
            ? findQuote(span, quote)
            : [0, span.length];
          if (hit)
            found = {
              kind: "sentence",
              unit_id: unit.unit_id,
              start_utf8:
                unit.start_utf8 + utf8Offset(unit.source, first.start + hit[0]),
              end_utf8:
                unit.start_utf8 + utf8Offset(unit.source, first.start + hit[1]),
            };
        }
      }
      if (found && k.primary) basis = found;
      else dropped.basis++;
    }
    return {
      number,
      statement: k.statement,
      evidence: k.evidence.map(plain),
      key_terms: k.key_terms,
      section_id: k.section_id,
      primary: k.primary,
      label: k.label,
      kind: k.kind,
      relations,
      basis,
    };
  });
  dropped.points = given - points.length;
  return {
    digest,
    points,
    data,
    given,
    valid,
    dropped,
    summary_missing: !summaryOk,
    primary: Math.min(primaries, LAYERS_PRIMARY_MAX),
  };
}
