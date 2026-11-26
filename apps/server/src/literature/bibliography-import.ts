import { startIntake, finishIntake, type IntakeOrigin } from "./intake.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import {
  mapSourceType,
  SOURCE_TYPE_MAPPING_VERSION,
} from "./metadata-types.js";
import { randomUUID } from "node:crypto";
import {
  parseMetadataObservation,
  type Author,
  type Identifier,
  type MetadataObservation,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import {
  parseEndnoteTagged,
  parseEndnoteXml,
  parseNoteExpress,
} from "./endnote-import.js";

export type BibliographyInputFormat =
  | "bibtex"
  | "biblatex"
  | "ris"
  | "csl-json"
  | "endnote-tagged"
  | "endnote-xml"
  | "noteexpress";
export type BibliographyItemStatus = "decoded" | "rejected";
export interface BibliographyDecodeItem {
  readonly record_index: number;
  readonly status: BibliographyItemStatus;
  readonly observation: MetadataObservation | null;
  readonly reason: string | null;
}
export interface BibliographyDecodeResult {
  readonly format: BibliographyInputFormat;
  readonly items: readonly BibliographyDecodeItem[];
}
export interface BibliographyIdentityPort {
  observe(
    value: MetadataObservation,
    options?: {
      readonly intake_batch_id?: import("@sciretriever/contracts").IntakeBatchId;
    },
  ): Promise<{
    readonly disposition: "accepted" | "rejected" | "uncertain";
    readonly literature_id?: string;
    readonly meta_literature_id?: string;
    readonly outcome?: "created" | "enriched" | "matched" | "restored";
    readonly created?: boolean;
    readonly reason?: string;
  }>;
}
export type BibliographyImportDisposition =
  | "created"
  | "enriched"
  | "matched"
  | "restored"
  | "rejected";
export interface BibliographyImportItem {
  readonly record_index: number;
  readonly disposition: BibliographyImportDisposition;
  readonly literature_id: string | null;
  readonly meta_literature_id: string | null;
  readonly reason: string | null;
}
export interface BibliographyImportResult {
  readonly intake_batch_id?: import("@sciretriever/contracts").IntakeBatchId;
  readonly format: BibliographyInputFormat;
  readonly items: readonly BibliographyImportItem[];
}
export interface BibliographyDecodeOptions {
  readonly observationId?: () => string;
  readonly provenanceId?: () => string;
  readonly observedAt?: () => string;
  readonly maxInputBytes?: number;
}

type Fields = Readonly<Record<string, string>>;
interface ParsedRecord {
  readonly fields: Fields;
  readonly attachment_fields: readonly string[];
}
type ParsedFields = ParsedRecord | null;

function assertUnicodeScalars(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff))
        throw new TypeError("text contains an unpaired Unicode surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("text contains an unpaired Unicode surrogate");
    }
  }
}

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  assertUnicodeScalars(value);
  const normalized = value.replace(/\s+/gu, " ").trim().normalize("NFC");
  return normalized || null;
};
const first = (...values: readonly unknown[]): string | null => {
  for (const value of values) {
    const normalized = text(value);
    if (normalized !== null) return normalized;
  }
  return null;
};
const year = (value: unknown): number | null => {
  const normalized = text(value);
  if (!normalized) return null;
  const match = /(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/u.exec(normalized);
  return match ? Number(match[1]) : null;
};
const splitKeywords = (value: unknown): readonly string[] => [
  ...new Set(
    (text(value) ?? "")
      .split(/[;,]/u)
      .map(text)
      .filter((item): item is string => item !== null),
  ),
];

function publicationDate(value: unknown): {
  readonly date: string | null;
  readonly year: number | null;
} {
  const normalized = text(value);
  if (normalized === null) return { date: null, year: null };
  const match = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/u.exec(
    normalized,
  );
  if (!match) return { date: normalized, year: year(normalized) };
  const parsedYear = Number(match[1]);
  if (parsedYear < 1 || parsedYear > 9999)
    return { date: normalized, year: null };
  if (match[2] === undefined) return { date: normalized, year: parsedYear };
  const month = Number(match[2]);
  if (month < 1 || month > 12) return { date: normalized, year: parsedYear };
  if (match[3] === undefined)
    return {
      date: `${String(parsedYear).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
      year: parsedYear,
    };
  const day = Number(match[3]);
  if (day < 1 || day > 31) return { date: normalized, year: parsedYear };
  return {
    date: `${String(parsedYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year: parsedYear,
  };
}

function author(value: string, organization = false): Author {
  const normalized = text(value);
  if (normalized === null) throw new TypeError("author is empty");
  if (organization)
    return {
      kind: "organization",
      display_name: normalized,
      given_name: null,
      family_name: null,
      orcid: null,
      affiliations: [],
    };
  const [family, given] = normalized.includes(",")
    ? normalized.split(",", 2).map((item) => text(item))
    : [null, null];
  return {
    kind: family && given ? "person" : "unknown",
    display_name: normalized,
    given_name: given ?? null,
    family_name: family ?? null,
    orcid: null,
    affiliations: [],
  };
}

function authors(value: unknown): readonly Author[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new TypeError("CSL author is invalid");
      const record = item as Record<string, unknown>;
      const family = text(record.family);
      const given = text(record.given);
      const literal = text(record.literal);
      if (!literal && !family && !given)
        throw new TypeError("CSL author has no name");
      const rawAffiliations = record.affiliation ?? [];
      if (!Array.isArray(rawAffiliations))
        throw new TypeError("CSL affiliations are invalid");
      const affiliations = rawAffiliations.map((affiliation) => {
        if (
          !affiliation ||
          typeof affiliation !== "object" ||
          Array.isArray(affiliation)
        )
          throw new TypeError("CSL affiliation is invalid");
        const fields = affiliation as Record<string, unknown>;
        const name = text(fields.name);
        if (name === null) throw new TypeError("CSL affiliation has no name");
        return { name, ror: text(fields.ROR ?? fields.ror) };
      });
      return {
        kind: literal ? "organization" : "person",
        display_name: literal ?? [given, family].filter(Boolean).join(" "),
        given_name: literal ? null : given,
        family_name: literal ? null : family,
        orcid: text(record.ORCID ?? record.orcid),
        affiliations,
      } satisfies Author;
    });
  }
  if (typeof value === "string" && value.trimStart().startsWith("[")) {
    return authors(JSON.parse(value));
  }
  const normalized = text(value);
  return normalized
    ? normalized.split(/\s+and\s+/iu).map((item) => {
        const candidate = text(item)!;
        const organization =
          candidate.startsWith("{") && candidate.endsWith("}");
        return author(
          organization ? candidate.slice(1, -1) : candidate,
          organization,
        );
      })
    : [];
}

function identifiers(fields: Fields): readonly Identifier[] {
  const result: Identifier[] = [];
  for (const namespace of [
    "doi",
    "arxiv",
    "pmid",
    "pmcid",
    "isbn",
    "issn",
  ] as const) {
    const value = text(fields[namespace]);
    if (value)
      result.push({
        namespace,
        value: value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, ""),
      });
  }
  const eprint = text(fields.eprint);
  const archive = first(fields.eprinttype, fields.archiveprefix);
  if (
    eprint &&
    archive?.toLowerCase() === "arxiv" &&
    !result.some((item) => item.namespace === "arxiv")
  )
    result.push({ namespace: "arxiv", value: eprint });
  return result;
}

/** EndNote-family lists (6.4.14): already split by their own rules. */
function listField(value: string | undefined): readonly string[] | null {
  if (value === undefined) return null;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string"))
    throw new TypeError("list field is invalid");
  return parsed.map((v) => text(v)).filter((v): v is string => v !== null);
}
function keywordsOf(fields: Fields): readonly string[] {
  return listField(fields.__keywords) ?? splitKeywords(fields.keywords);
}

function metadata(
  fields: Fields,
  sourceType: string | null,
  format: BibliographyInputFormat,
): LiteratureMetadata {
  const date = publicationDate(fields.date);
  const named = listField(fields.__authors);
  return {
    title: text(fields.title),
    // “姓, 名” is split at the comma; a name without one stays whole.
    authors: named ? named.map((name) => author(name)) : authors(fields.author),
    abstract: text(fields.abstract),
    publication_date: date.date,
    publication_year: year(fields.year) ?? date.year,
    publication_form: mapSourceType(format, sourceType).publication_form,
    article_kind: mapSourceType(format, sourceType).article_kind_hint,
    language: first(fields.language, fields.langid),
    venue: first(
      fields.journaltitle,
      fields.journal,
      fields.booktitle,
      fields.eventtitle,
    ),
    publisher: text(fields.publisher),
    volume: text(fields.volume),
    issue: first(fields.number, fields.issue),
    pages: text(fields.pages),
    identifiers: identifiers(fields),
    keywords: keywordsOf(fields),
    subject_terms: [],
  };
}

function observation(
  fields: Fields,
  options: Required<
    Pick<
      BibliographyDecodeOptions,
      "observationId" | "provenanceId" | "observedAt"
    >
  >,
  sourceType: string | null,
  format: BibliographyInputFormat,
): MetadataObservation {
  const identifier = identifiers(fields)[0];
  return parseMetadataObservation({
    observation_id: options.observationId(),
    provenance: {
      provenance_id: options.provenanceId(),
      source_kind: "user",
      source_name: "bibliographic-import",
      source_record_id: null,
      observed_at: options.observedAt(),
      input_sha256: null,
      parameters_sha256: null,
    },
    source_type: sourceType,
    source_type_mapping_version: SOURCE_TYPE_MAPPING_VERSION,
    metadata: metadata(fields, sourceType, format),
    version_role: null,
    version_links: identifier
      ? [{ record_id: null, identifiers: [identifier] }]
      : [],
    declared_keywords: keywordsOf(fields),
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}

function skip(value: string, position: number, characters = " \t\r\n"): number {
  while (position < value.length && characters.includes(value[position]!))
    position += 1;
  return position;
}

function matchingClose(
  value: string,
  position: number,
  opening: string,
  closing: string,
): number {
  let depth = 1;
  let quoted = false;
  let escaped = false;
  for (let current = position + 1; current < value.length; current += 1) {
    const character = value[current]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) return current;
  }
  throw new Error("unbalanced value");
}

const unescapeBib = (value: string): string =>
  value.replaceAll("\\{", "{").replaceAll("\\}", "}").replaceAll("\\\\", "\\");

function readBibValue(
  body: string,
  position: number,
  preserveEscapes = false,
): readonly [string, number] {
  const decode = (value: string) =>
    preserveEscapes ? value : unescapeBib(value);
  if (position >= body.length) throw new Error("missing BibTeX value");
  const marker = body[position]!;
  if (marker === "{") {
    const end = matchingClose(body, position, "{", "}");
    return [decode(body.slice(position + 1, end)), end + 1];
  }
  if (marker === '"') {
    let escaped = false;
    for (let current = position + 1; current < body.length; current += 1) {
      const character = body[current]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"')
        return [decode(body.slice(position + 1, current)), current + 1];
    }
    throw new Error("unbalanced BibTeX quote");
  }
  let end = position;
  while (end < body.length && !",#".includes(body[end]!)) end += 1;
  const raw = body.slice(position, end);
  const value = preserveEscapes ? raw.trim() : text(raw);
  if (!value) throw new Error("empty BibTeX value");
  return [value, end];
}

function parseBibRecord(entryType: string, payload: string): Fields {
  const header = /^\s*@[A-Za-z][A-Za-z0-9_-]*\s*([{(])/u.exec(payload);
  if (!header) throw new Error("missing BibTeX entry");
  const openingPosition = header[0].length - 1;
  const opening = header[1]!;
  const closing = opening === "{" ? "}" : ")";
  const closingPosition = matchingClose(
    payload,
    openingPosition,
    opening,
    closing,
  );
  const body = payload.slice(openingPosition + 1, closingPosition);
  const keyEnd = body.indexOf(",");
  if (keyEnd <= 0 || text(body.slice(0, keyEnd)) === null)
    throw new Error("missing BibTeX key");
  const fields: Record<string, string> = { type: entryType.toLowerCase() };
  fields.__external_id = text(body.slice(0, keyEnd))!;
  let position = keyEnd + 1;
  while ((position = skip(body, position, " ,\t\r\n")) < body.length) {
    const match = /^[A-Za-z][A-Za-z0-9_-]*/u.exec(body.slice(position));
    if (!match) throw new Error("malformed BibTeX field");
    const name = match[0].toLowerCase();
    if (fields[name] !== undefined) throw new Error("duplicate BibTeX field");
    position = skip(body, position + match[0].length);
    if (body[position] !== "=") throw new Error("missing BibTeX equals");
    position = skip(body, position + 1);
    let [value, next] = readBibValue(body, position, name === "file");
    position = skip(body, next);
    while (body[position] === "#") {
      position = skip(body, position + 1);
      const component = readBibValue(body, position, name === "file");
      value += component[0];
      next = component[1];
      position = skip(body, next);
    }
    fields[name] = name === "file" ? value : (text(value) ?? "");
    if (position < body.length && body[position] !== ",")
      throw new Error("malformed BibTeX separator");
    if (position < body.length) position += 1;
  }
  return fields;
}

function parseBibtex(source: string): readonly ParsedFields[] {
  const starts = [
    ...source.matchAll(/^\s*@([A-Za-z][A-Za-z0-9_-]*)\s*[{(]/gmu),
  ];
  const records: ParsedFields[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]!;
    const entryType = match[1]!.toLowerCase();
    if (["comment", "preamble", "string"].includes(entryType)) continue;
    const payload = source.slice(
      match.index,
      starts[index + 1]?.index ?? source.length,
    );
    try {
      const fields = parseBibRecord(entryType, payload);
      records.push({
        fields,
        attachment_fields: fields.file === undefined ? [] : [fields.file],
      });
    } catch {
      records.push(null);
    }
  }
  return records;
}

interface RisGroup {
  readonly pairs: readonly (readonly [string, string])[];
  readonly complete: boolean;
}

function risGroups(source: string): readonly RisGroup[] {
  const groups: RisGroup[] = [];
  let current: Array<readonly [string, string]> | null = null;
  let malformedPrefix = false;
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z0-9]{2}) {2}- ?(.*)$/u.exec(line);
    if (!match) {
      if (!current?.length) {
        current = current ?? [];
        malformedPrefix = true;
      } else {
        const [tag, previous] = current.at(-1)!;
        current[current.length - 1] = [
          tag,
          `${previous} ${line.trim()}`.trim(),
        ];
      }
      continue;
    }
    const tag = match[1]!.toUpperCase();
    const value = match[2]!.trim();
    if (tag === "TY") {
      if (current !== null) groups.push({ pairs: current, complete: false });
      current = [[tag, value]];
      malformedPrefix = false;
      continue;
    }
    if (current === null) {
      current = [];
      malformedPrefix = true;
    }
    current.push([tag, value]);
    if (tag === "ER") {
      groups.push({
        pairs: current,
        complete:
          !malformedPrefix && current.length > 0 && current[0]![0] === "TY",
      });
      current = null;
      malformedPrefix = false;
    }
  }
  if (current !== null) groups.push({ pairs: current, complete: false });
  return groups;
}

function parseRisGroup(group: RisGroup): ParsedRecord {
  if (!group.complete) throw new Error("incomplete RIS record");
  const values = new Map<string, string[]>();
  for (const [tag, value] of group.pairs)
    values.set(tag, [...(values.get(tag) ?? []), value]);
  const firstTag = (...names: readonly string[]): string | null => {
    for (const name of names)
      for (const value of values.get(name) ?? []) {
        const normalized = text(value);
        if (normalized !== null) return normalized;
      }
    return null;
  };
  const type = firstTag("TY");
  if (type === null) throw new Error("RIS type is missing");
  const typeMap: Readonly<Record<string, string>> = {
    JOUR: "journal-article",
    EJOUR: "journal-article",
    BOOK: "book",
    CHAP: "book-chapter",
    CONF: "proceedings-article",
    THES: "thesis",
    RPRT: "report",
    GEN: "other",
  };
  const result: Record<string, string> = {
    type: typeMap[type] ?? type,
    source_type: type,
  };
  const externalId = firstTag("ID", "AN");
  if (externalId) result.__external_id = externalId;
  const put = (name: string, value: string | null) => {
    if (value !== null) result[name] = value;
  };
  put("title", firstTag("TI", "T1"));
  put("abstract", firstTag("AB", "N2"));
  put("date", firstTag("DA", "Y1"));
  put("year", firstTag("PY"));
  put("journal", firstTag("JO", "JF", "T2"));
  put("publisher", firstTag("PB"));
  put("language", firstTag("LA"));
  put("volume", firstTag("VL"));
  put("issue", firstTag("IS"));
  const start = firstTag("SP");
  const end = firstTag("EP");
  put(
    "pages",
    start && end ? `${start}-${end}` : (start ?? end ?? firstTag("PP")),
  );
  const authorValues = [
    ...(values.get("AU") ?? []),
    ...(values.get("A1") ?? []),
  ];
  if (authorValues.length) result.author = authorValues.join(" and ");
  const keywordValues = values.get("KW") ?? [];
  if (keywordValues.length) result.keywords = keywordValues.join("; ");
  put("doi", firstTag("DO"));
  for (const serial of values.get("SN") ?? []) {
    const compact = serial.replace(/[-\s]/gu, "");
    if (/^(?:\d{9}[\dXx]|\d{13})$/u.test(compact)) result.isbn ??= serial;
    else if (/^\d{7}[\dXx]$/u.test(compact)) result.issn ??= serial;
  }
  for (const accession of values.get("AN") ?? []) {
    const match = /^PMID:\s*(\d+)$/iu.exec(accession);
    if (match) result.pmid ??= match[1]!;
  }
  for (const note of values.get("N1") ?? []) {
    const match = /^(PMID|PMCID|arXiv):\s*(\S+)$/iu.exec(note);
    if (match) result[match[1]!.toLowerCase()] ??= match[2]!;
  }
  return { fields: result, attachment_fields: values.get("L1") ?? [] };
}

function parseRis(source: string): readonly ParsedFields[] {
  return risGroups(source).map((group) => {
    try {
      return parseRisGroup(group);
    } catch {
      return null;
    }
  });
}

class JsonKeyScanner {
  position = 0;
  constructor(
    readonly source: string,
    private readonly uniqueKeys: boolean,
  ) {}
  whitespace(): void {
    while (/\s/u.test(this.source[this.position] ?? "")) this.position += 1;
  }
  string(): string {
    const start = this.position;
    if (this.source[this.position++] !== '"')
      throw new Error("JSON string expected");
    let escaped = false;
    while (this.position < this.source.length) {
      const character = this.source[this.position++]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        const value: unknown = JSON.parse(
          this.source.slice(start, this.position),
        );
        if (typeof value !== "string") throw new Error("JSON key is invalid");
        assertUnicodeScalars(value);
        return value;
      }
    }
    throw new Error("unterminated JSON string");
  }
  value(): void {
    this.whitespace();
    const character = this.source[this.position];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') {
      this.string();
      return;
    }
    const match =
      /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        this.source.slice(this.position),
      );
    if (!match) throw new Error("JSON value is invalid");
    this.position += match[0].length;
  }
  object(): void {
    this.position += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return;
    }
    while (true) {
      const key = this.string();
      if (this.uniqueKeys && keys.has(key))
        throw new Error("duplicate JSON key");
      keys.add(key);
      this.whitespace();
      if (this.source[this.position++] !== ":")
        throw new Error("JSON colon expected");
      this.value();
      this.whitespace();
      const delimiter = this.source[this.position++]!;
      if (delimiter === "}") return;
      if (delimiter !== ",") throw new Error("JSON object delimiter expected");
      this.whitespace();
    }
  }
  array(): void {
    this.position += 1;
    this.whitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return;
    }
    while (true) {
      this.value();
      this.whitespace();
      const delimiter = this.source[this.position++]!;
      if (delimiter === "]") return;
      if (delimiter !== ",") throw new Error("JSON array delimiter expected");
    }
  }
  finish(): void {
    this.value();
    this.whitespace();
    if (this.position !== this.source.length)
      throw new Error("extra JSON data");
  }
}

function cslFields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CSL record is invalid");
  const record = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  if (typeof record.id === "string" && text(record.id))
    result.__external_id = text(record.id)!;
  else if (typeof record.id === "number" && Number.isFinite(record.id))
    result.__external_id = String(record.id);
  const optional = (sourceName: string, targetName = sourceName) => {
    const raw = record[sourceName];
    if (raw === undefined || raw === null) return;
    if (typeof raw !== "string") throw new Error("CSL text field is invalid");
    const normalized = text(raw);
    if (normalized !== null) result[targetName] = normalized;
  };
  optional("title");
  optional("type");
  optional("abstract");
  optional("language");
  optional("container-title", "journal");
  optional("publisher");
  optional("volume");
  optional("issue");
  optional("page", "pages");
  for (const [sourceName, targetName] of [
    ["DOI", "doi"],
    ["PMID", "pmid"],
    ["PMCID", "pmcid"],
    ["ISBN", "isbn"],
    ["ISSN", "issn"],
  ] as const)
    optional(sourceName, targetName);
  const archive = record.archive;
  const archiveLocation = record.archive_location;
  if (archive !== undefined || archiveLocation !== undefined) {
    if (typeof archive !== "string" || typeof archiveLocation !== "string")
      throw new Error("CSL archive fields are invalid");
    if (archive.toLowerCase() === "arxiv") result.arxiv = archiveLocation;
  }
  if (record.author !== undefined) {
    if (!Array.isArray(record.author))
      throw new Error("CSL authors are invalid");
    result.author = JSON.stringify(record.author);
  }
  if (record.issued !== undefined) {
    if (
      !record.issued ||
      typeof record.issued !== "object" ||
      Array.isArray(record.issued)
    )
      throw new Error("CSL issued date is invalid");
    const parts = (record.issued as Record<string, unknown>)["date-parts"];
    if (
      !Array.isArray(parts) ||
      !Array.isArray(parts[0]) ||
      parts[0].length < 1 ||
      parts[0].length > 3
    )
      throw new Error("CSL date-parts are invalid");
    if (parts[0].some((item) => !Number.isSafeInteger(item)))
      throw new Error("CSL date-parts are invalid");
    const [dateYear, month, day] = parts[0] as number[];
    if (
      dateYear! < 1 ||
      dateYear! > 9999 ||
      (month !== undefined && (month < 1 || month > 12)) ||
      (day !== undefined && (day < 1 || day > 31))
    )
      throw new Error("CSL date-parts are invalid");
    result.date = [dateYear, month, day]
      .filter((item): item is number => item !== undefined)
      .map((item, index) =>
        index === 0
          ? String(item).padStart(4, "0")
          : String(item).padStart(2, "0"),
      )
      .join("-");
  }
  if (record.keyword !== undefined) {
    if (typeof record.keyword === "string") result.keywords = record.keyword;
    else if (
      Array.isArray(record.keyword) &&
      record.keyword.every((item) => typeof item === "string")
    )
      result.keywords = record.keyword.join("; ");
    else throw new Error("CSL keywords are invalid");
  }
  return result;
}

function parseCsl(source: string): readonly ParsedFields[] {
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object"))
    throw new Error("CSL root is invalid");
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (!values.length) return [];
  const rawItems: string[] = [];
  const trimmed = source.trim();
  if (Array.isArray(parsed)) {
    const scanner = new JsonKeyScanner(trimmed, false);
    scanner.whitespace();
    if (scanner.source[scanner.position++] !== "[")
      throw new Error("CSL array expected");
    scanner.whitespace();
    if (scanner.source[scanner.position] !== "]") {
      while (true) {
        const start = scanner.position;
        scanner.value();
        rawItems.push(scanner.source.slice(start, scanner.position));
        scanner.whitespace();
        const delimiter = scanner.source[scanner.position++]!;
        if (delimiter === "]") break;
        if (delimiter !== ",") throw new Error("CSL array delimiter expected");
        scanner.whitespace();
      }
    } else scanner.position += 1;
    scanner.whitespace();
    if (scanner.position !== scanner.source.length)
      throw new Error("extra CSL JSON data");
  } else rawItems.push(trimmed);
  return values.map((value, index) => {
    try {
      const scanner = new JsonKeyScanner(rawItems[index]!, true);
      scanner.finish();
      return { fields: cslFields(value), attachment_fields: [] };
    } catch {
      return null;
    }
  });
}

function parseFields(
  format: BibliographyInputFormat,
  source: string,
): readonly ParsedFields[] {
  if (format === "bibtex" || format === "biblatex") return parseBibtex(source);
  if (format === "ris") return parseRis(source);
  if (format === "endnote-tagged") return parseEndnoteTagged(source);
  if (format === "noteexpress") return parseNoteExpress(source);
  if (format === "endnote-xml") return parseEndnoteXml(source);
  return parseCsl(source);
}

/** Preserve the bibliography codec's BOM-aware, strict text decoding for local entry wrappers. */
export function bibliographyText(source: Uint8Array): string {
  const encoding =
    source[0] === 0xff && source[1] === 0xfe
      ? "utf-16le"
      : source[0] === 0xfe && source[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(source);
}

/** Raw source-local fields for the pure adapter, not public paths or identities. */
export function bibliographyRecordInputs(
  source: Uint8Array,
  format: BibliographyInputFormat,
): readonly {
  external_id: string | null;
  attachment_fields: readonly string[];
}[] {
  try {
    return parseFields(format, bibliographyText(source)).map((record) => ({
      external_id: record?.fields.__external_id ?? null,
      attachment_fields: record?.attachment_fields ?? [],
    }));
  } catch {
    return [];
  }
}

export function decodeBibliography(
  source: Uint8Array,
  format: BibliographyInputFormat,
  options: BibliographyDecodeOptions = {},
): BibliographyDecodeResult {
  const max = options.maxInputBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 1)
    throw new TypeError("bibliography input limit is invalid");
  if (!(source instanceof Uint8Array))
    throw new TypeError("bibliography input must be bytes");
  if (source.byteLength > max)
    return {
      format,
      items: [
        {
          record_index: 0,
          status: "rejected",
          observation: null,
          reason: "input-too-large",
        },
      ],
    };
  const ids = {
    observationId: options.observationId ?? randomUUID,
    provenanceId: options.provenanceId ?? randomUUID,
    observedAt: options.observedAt ?? (() => new Date().toISOString()),
  };
  let fields: readonly ParsedFields[];
  try {
    fields = parseFields(format, bibliographyText(source));
  } catch {
    return {
      format,
      items: [
        {
          record_index: 0,
          status: "rejected",
          observation: null,
          reason: "malformed-document",
        },
      ],
    };
  }
  if (!fields.length)
    return {
      format,
      items: [
        {
          record_index: 0,
          status: "rejected",
          observation: null,
          reason: "empty-document",
        },
      ],
    };
  const items = fields.map((value, record_index) => {
    if (value === null)
      return {
        record_index,
        status: "rejected" as const,
        observation: null,
        reason: "malformed-record",
      };
    try {
      return {
        record_index,
        status: "decoded" as const,
        observation: observation(
          value.fields,
          ids,
          text(value.fields.source_type ?? value.fields.type),
          format,
        ),
        reason: null,
      };
    } catch {
      return {
        record_index,
        status: "rejected" as const,
        observation: null,
        reason: "malformed-record",
      };
    }
  });
  return { format, items };
}

/** Import decoded observations through the single Literature identity owner. */
export async function importBibliography(
  decoded: BibliographyDecodeResult,
  identity: BibliographyIdentityPort,
  options?: {
    readonly database: SqliteWorker;
    readonly file_name?: string | null;
    readonly origin?: IntakeOrigin;
  },
): Promise<BibliographyImportResult> {
  if (
    !decoded ||
    !Array.isArray(decoded.items) ||
    !identity ||
    typeof identity.observe !== "function"
  )
    throw new TypeError("invalid bibliography import input");
  const batchId = options
    ? await startIntake(
        options.database,
        "import",
        options.file_name ?? decoded.format,
        { format: decoded.format, file_name: options.file_name ?? null },
        options.origin,
      )
    : undefined;
  let settled = false;
  try {
    const items: BibliographyImportItem[] = [];
    for (const item of decoded.items) {
      if (item.status !== "decoded" || item.observation === null) {
        items.push({
          record_index: item.record_index,
          disposition: "rejected",
          literature_id: null,
          meta_literature_id: null,
          reason: item.reason ?? "malformed-record",
        });
        continue;
      }
      try {
        const decision = await identity.observe(
          item.observation,
          batchId ? { intake_batch_id: batchId } : {},
        );
        if (decision.disposition === "accepted") {
          items.push({
            record_index: item.record_index,
            disposition:
              decision.outcome ??
              (decision.created === true ? "created" : "matched"),
            literature_id: decision.literature_id ?? null,
            meta_literature_id: decision.meta_literature_id ?? null,
            reason: null,
          });
        } else {
          items.push({
            record_index: item.record_index,
            disposition: "rejected",
            literature_id: null,
            meta_literature_id: null,
            reason: decision.reason ?? "identity-rejected",
          });
        }
      } catch {
        items.push({
          record_index: item.record_index,
          disposition: "rejected",
          literature_id: null,
          meta_literature_id: null,
          reason: "identity-failed",
        });
      }
    }
    if (options && batchId)
      await finishIntake(
        options.database,
        batchId,
        items.every((i) => i.disposition === "rejected")
          ? "failed"
          : items.some((i) => i.disposition === "rejected")
            ? "partial"
            : "completed",
        null,
        0,
        items.filter((i) => i.disposition === "rejected").length,
      );
    settled = true;
    return {
      format: decoded.format,
      items: Object.freeze(items),
      ...(batchId ? { intake_batch_id: batchId } : {}),
    };
  } finally {
    if (options && batchId && !settled)
      await finishIntake(options.database, batchId, "interrupted");
  }
}
