import {
  parseDocumentReadingRef,
  type DocumentReadingRef,
} from "@sciretriever/contracts";

/**
 * The reading layers' read contract as the page reads it (technical 04
 * §10.7): `describe.layers` and the operation `layers`. The service's own
 * contract is not merged yet; until it is, the page parses the replies here,
 * against the shapes 10.7 describes. Replace with the contracts package's
 * parsers once they are there (待换成 contracts 的实现).
 */
export type LayersState = "none" | "complete" | "stale" | "not-applicable";
export type LayersReason = "long-document" | "too-short";
export interface LayersSummary {
  readonly state: LayersState;
  readonly points: number;
  /** Set when the layers have a translation part built on the current translation. */
  readonly target_language: string | null;
  readonly reason: LayersReason | null;
}
export type LayersText = "original" | "translation" | "bilingual";
export type LayersPart = "overview" | "outline";
export interface LayersRequest {
  readonly document_version_id: string;
  readonly part: LayersPart;
  readonly text: LayersText;
  readonly format: "json";
  readonly limit: number;
  readonly cursor: string | null;
}
/** Machine words in the library's translation language (10.5); empty when none. */
export interface LayerWords {
  readonly text: string | null;
  readonly key_terms: readonly string[];
}
export type DigestKind = "nature" | "limits" | "advice";
export interface LayerDigestItem {
  readonly kind: DigestKind;
  readonly text: string | null;
  /** One sentence, what the paper does not give; set when `text` is null. */
  readonly not_given: string | null;
  /** The units (translation units, 9.2) it rests on. */
  readonly units: readonly string[];
  readonly key_terms: readonly string[];
  /** `bilingual` only. */
  readonly translation?: LayerWords;
}
export interface LayerPointHead {
  readonly number: number;
  readonly statement: string;
  readonly key_terms: readonly string[];
  readonly section_id: string | null;
  /** `bilingual` only: the statement in the translation language. */
  readonly translation?: LayerWords;
}
export interface LayerSection {
  readonly section_id: string | null;
  readonly title: string | null;
  readonly points: readonly LayerPointHead[];
}
export interface LayersOverview {
  readonly document: DocumentReadingRef;
  readonly digest: readonly LayerDigestItem[];
  readonly sections: readonly LayerSection[];
  readonly machine_translation: boolean;
  readonly target_language: string | null;
  readonly untranslated: number;
}
export interface SentenceEvidence {
  readonly kind: "sentence";
  readonly unit_id: string;
  readonly segment_ids: readonly string[];
  /** UTF-8 half-open range in the proofread text (the version's text). */
  readonly start_utf8: number;
  readonly end_utf8: number;
  readonly text: string;
  /**
   * `translation` and `bilingual`: those sentences of the unit's stored
   * translation (`aligned`), else the whole unit's (`aligned: false`); null
   * where the unit has no translation.
   */
  readonly translation?: {
    readonly text: string;
    readonly aligned: boolean;
  } | null;
}
export interface BlockEvidence {
  readonly kind: "block";
  readonly segment_id: string;
  readonly category: "figure" | "table";
  readonly caption: string | null;
}
export type LayerEvidence = SentenceEvidence | BlockEvidence;
export interface LayerPoint extends LayerPointHead {
  readonly evidence: readonly LayerEvidence[];
}
export interface LayersOutlinePage {
  readonly document: DocumentReadingRef;
  readonly points: readonly LayerPoint[];
  readonly total: number;
  readonly next_cursor: string | null;
}
/** A refused read (HTTP 409): no layers, or no translation part. */
export class LayersUnavailable extends Error {
  constructor(
    readonly code: "layers-unavailable" | "translation-unavailable",
    readonly state: LayersState | null,
    readonly reason: LayersReason | null,
  ) {
    super(code);
  }
}

const fail = (what: string): never => {
  throw new Error(`阅读层回执无效：${what}`);
};
type Raw = Record<string, unknown>;
const record = (value: unknown, what: string): Raw =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : fail(what);
const text = (value: unknown, what: string, max = 4000): string =>
  typeof value === "string" && value.length <= max ? value : fail(what);
const maybeText = (value: unknown, what: string, max = 4000) =>
  value === null || value === undefined ? null : text(value, what, max);
const count = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail(what);
const list = (value: unknown, what: string): unknown[] =>
  Array.isArray(value) ? value : fail(what);
const terms = (value: unknown, what: string): string[] =>
  value === undefined
    ? []
    : list(value, what)
        .slice(0, 2)
        .map((term) => text(term, what, 160));
const STATES: readonly LayersState[] = [
  "none",
  "complete",
  "stale",
  "not-applicable",
];
const REASONS: readonly LayersReason[] = ["long-document", "too-short"];

/** `describe.layers` (10.7). */
export function parseLayersSummary(value: unknown): LayersSummary {
  const r = record(value, "describe.layers");
  const state = STATES.find((s) => s === r.state) ?? fail("state");
  const reason =
    r.reason === null || r.reason === undefined
      ? null
      : (REASONS.find((s) => s === r.reason) ?? fail("reason"));
  if (state === "not-applicable" && !reason) fail("reason");
  return Object.freeze({
    state,
    points: r.points === undefined ? 0 : count(r.points, "points"),
    target_language: maybeText(r.target_language, "target_language", 32),
    reason: state === "not-applicable" ? reason : null,
  });
}
/**
 * The describe reply without `layers`, and `layers` parsed: the contracts
 * package's describe parser takes only the keys it knows, and does not know
 * this one yet.
 */
export function takeLayers(result: Record<string, unknown>): {
  rest: Record<string, unknown>;
  layers: LayersSummary | null;
} {
  if (!Object.hasOwn(result, "layers")) return { rest: result, layers: null };
  const { layers, ...rest } = result;
  let summary: LayersSummary | null = null;
  try {
    summary = layers === null ? null : parseLayersSummary(layers);
  } catch {
    // A summary the page cannot read never stops the full text: no layers.
  }
  return { rest, layers: summary };
}
const words = (value: unknown, what: string): LayerWords => {
  const r = record(value, what);
  return Object.freeze({
    text: maybeText(r.text ?? r.statement, `${what}.text`, 2400),
    key_terms: terms(r.key_terms, `${what}.key_terms`),
  });
};
const head = (value: unknown, what: string): LayerPointHead => {
  const r = record(value, what);
  const number = count(r.number, `${what}.number`);
  if (number < 1) fail(`${what}.number`);
  return Object.freeze({
    number,
    statement: text(r.statement, `${what}.statement`, 1200),
    key_terms: terms(r.key_terms, `${what}.key_terms`),
    section_id: maybeText(r.section_id, `${what}.section_id`, 200),
    ...(r.translation === undefined || r.translation === null
      ? {}
      : { translation: words(r.translation, `${what}.translation`) }),
  });
};
const KINDS: readonly DigestKind[] = ["nature", "limits", "advice"];
function matchVersion(document: DocumentReadingRef, version: string) {
  if (document.document_version_id !== version) fail("文档版本与请求不一致");
}
/** The `overview` part: the 提要's three items and the points by section. */
export function parseLayersOverview(
  value: unknown,
  request: LayersRequest,
): LayersOverview {
  const r = record(value, "overview");
  const document = parseDocumentReadingRef(r.document);
  matchVersion(document, request.document_version_id);
  const digest = list(r.digest, "digest").map((item, i) => {
    const d = record(item, "digest");
    const kind = KINDS[i];
    // The service names an item `name`; `kind` is read as well.
    if (!kind || (d.name ?? d.kind) !== kind) fail("digest.name");
    const value = maybeText(d.text, "digest.text", 2400);
    return Object.freeze({
      kind: kind!,
      text: value,
      not_given:
        value === null ? text(d.not_given, "digest.not_given", 600) : null,
      // Units as `{unit_id, paragraph}` (the service) or as bare ids.
      units:
        d.units === undefined
          ? []
          : list(d.units, "digest.units")
              .slice(0, 6)
              .map((u) =>
                typeof u === "string"
                  ? text(u, "digest.units", 200)
                  : text(record(u, "digest.unit").unit_id, "digest.units", 200),
              ),
      key_terms: terms(d.key_terms, "digest.key_terms"),
      ...(d.translation === undefined || d.translation === null
        ? {}
        : { translation: words(d.translation, "digest.translation") }),
    });
  });
  if (digest.length !== 3 || digest[0]!.text === null) fail("digest");
  const sections = list(r.sections, "sections").map((item) => {
    const s = record(item, "section");
    return Object.freeze({
      section_id: maybeText(s.section_id, "section_id", 200),
      title: maybeText(s.title, "section.title", 600),
      points: list(s.points, "section.points").map((p) => head(p, "point")),
    });
  });
  return Object.freeze({
    document,
    digest,
    sections,
    machine_translation: r.machine_translation === true,
    target_language: maybeText(r.target_language, "target_language", 32),
    untranslated:
      r.untranslated === undefined ? 0 : count(r.untranslated, "untranslated"),
  });
}
const evidence = (value: unknown): LayerEvidence => {
  const r = record(value, "evidence");
  if (r.kind === "block")
    return Object.freeze({
      kind: "block" as const,
      segment_id: text(r.segment_id, "evidence.segment_id", 200),
      category:
        (r.block_kind ?? r.category) === "table"
          ? ("table" as const)
          : ("figure" as const),
      caption: maybeText(r.caption, "evidence.caption", 4000),
    });
  if (r.kind !== "sentence") fail("evidence.kind");
  const start = count(r.start_utf8, "evidence.start_utf8"),
    end = count(r.end_utf8, "evidence.end_utf8");
  if (end <= start) fail("evidence range");
  const t = r.translation;
  return Object.freeze({
    kind: "sentence" as const,
    unit_id: text(r.unit_id, "evidence.unit_id", 200),
    segment_ids: list(r.segment_ids ?? [], "evidence.segment_ids").map((s) =>
      text(s, "evidence.segment_ids", 200),
    ),
    start_utf8: start,
    end_utf8: end,
    text: text(r.text, "evidence.text", 8000),
    ...(t === undefined
      ? {}
      : {
          // A unit without a translation keeps its original (text null).
          translation:
            t === null || record(t, "translation").text === null
              ? null
              : Object.freeze({
                  text: text(record(t, "translation").text, "tr.text", 8000),
                  aligned: record(t, "translation").aligned !== false,
                }),
        }),
  });
};
/** One page of the `outline` part: points with their evidence (at most 50). */
export function parseLayersOutline(
  value: unknown,
  request: LayersRequest,
): LayersOutlinePage {
  const r = record(value, "outline");
  const document = parseDocumentReadingRef(r.document);
  matchVersion(document, request.document_version_id);
  const points = list(r.points, "points").map((item) => {
    const p = record(item, "point");
    const ev = list(p.evidence, "point.evidence").map(evidence);
    if (!ev.length || ev.length > 3) fail("point.evidence");
    return Object.freeze({ ...head(p, "point"), evidence: ev });
  });
  if (points.length > Math.max(1, request.limit)) fail("page size");
  return Object.freeze({
    document,
    points,
    total: count(r.total ?? points.length, "total"),
    next_cursor: maybeText(r.next_cursor, "next_cursor", 2000),
  });
}
/** A 409 reply's error body, when it is one of the layers' refusals. */
export function layersRefusal(body: unknown): LayersUnavailable | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as Raw).error;
  const r = e && typeof e === "object" ? (e as Raw) : (body as Raw);
  const code = r.code;
  if (code !== "layers-unavailable" && code !== "translation-unavailable")
    return null;
  const details =
    r.details && typeof r.details === "object" ? (r.details as Raw) : r;
  return new LayersUnavailable(
    code,
    STATES.find((s) => s === details.state) ?? null,
    REASONS.find((s) => s === details.reason) ?? null,
  );
}
