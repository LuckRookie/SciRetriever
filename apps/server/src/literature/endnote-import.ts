import { clueDois } from "./import-clues.js";
import {
  readXml,
  xmlChildren,
  xmlPath,
  xmlText,
  type XmlElement,
} from "./small-xml.js";

/*
 * EndNote tagged (`.enw`), NoteExpress (`.net`) and EndNote XML exports as
 * bibliography fields (literature materials 6.4.14). The fields are the ones
 * bibliography-import.ts already turns into metadata; author and keyword
 * lists travel as JSON (`__authors`, `__keywords`) so their own splitting
 * rules apply. Written from the published format descriptions; no real
 * export file has been checked.
 */
export interface EndnoteRecord {
  readonly fields: Readonly<Record<string, string>>;
  readonly attachment_fields: readonly string[];
}
type Values = Map<string, string[]>;

const LIST = /[;；\n]/u;
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
function list(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((v) => v.split(LIST))
        .map(clean)
        .filter(Boolean),
    ),
  ];
}
const firstOf = (values: Values, ...tags: readonly string[]) => {
  for (const tag of tags)
    for (const value of values.get(tag) ?? []) {
      const v = clean(value);
      if (v) return v;
    }
  return null;
};
/** One field set from the common shape of the three formats. */
function record(input: {
  type: string | null;
  title: string | null;
  authors: readonly string[];
  venue: string | null;
  year: string | null;
  date: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  doi: string | null;
  serials: readonly string[];
  isbn?: string | null;
  issn?: string | null;
  urls: readonly string[];
  abstract: string | null;
  keywords: readonly string[];
  language: string | null;
  attachments: readonly string[];
}): EndnoteRecord {
  const fields: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined) => {
    const v = value ? clean(value) : "";
    if (v) fields[key] = v;
  };
  put("source_type", input.type);
  put("type", input.type);
  put("title", input.title);
  put("journal", input.venue);
  put("year", input.year);
  put("date", input.date);
  put("volume", input.volume);
  put("issue", input.issue);
  put("pages", input.pages);
  put("publisher", input.publisher);
  put("abstract", input.abstract);
  put("language", input.language);
  // DOI as 6.4.6 normalizes it; a URL that names a DOI gives it too.
  const doi =
    clueDois(input.doi ?? "")[0] ?? input.urls.flatMap((u) => clueDois(u))[0];
  if (doi) fields.doi = doi.value;
  put("isbn", input.isbn);
  put("issn", input.issn);
  for (const serial of input.serials) {
    const compact = serial.replace(/[-\s]/gu, "");
    if (/^(?:\d{9}[\dXx]|\d{13})$/u.test(compact))
      fields.isbn ??= clean(serial);
    else if (/^\d{7}[\dXx]$/u.test(compact)) fields.issn ??= clean(serial);
  }
  const authors = list(input.authors);
  if (authors.length) fields.__authors = JSON.stringify(authors);
  const keywords = list(input.keywords);
  if (keywords.length) fields.__keywords = JSON.stringify(keywords);
  return {
    fields,
    attachment_fields: input.attachments.map(clean).filter(Boolean),
  };
}

/**
 * Lines grouped into records: `start` begins a record, `tag` reads a field;
 * a line that is not a field continues the previous field on a new line.
 */
function taggedRecords(
  source: string,
  tag: (line: string) => readonly [string, string] | null,
  start: string,
): (Values | null)[] {
  const out: (Values | null)[] = [];
  let current: Values | null = null,
    last: { tag: string; index: number } | null = null,
    orphan = false;
  for (const raw of source.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (!raw.trim()) continue;
    const field = tag(raw);
    if (field && field[0] === start) {
      if (current) out.push(current);
      else if (orphan) out.push(null);
      current = new Map([[start, [field[1]]]]);
      last = { tag: start, index: 0 };
      orphan = false;
    } else if (!current) orphan = true;
    else if (field) {
      const values = current.get(field[0]) ?? [];
      values.push(field[1]);
      current.set(field[0], values);
      last = { tag: field[0], index: values.length - 1 };
    } else if (last) {
      const values = current.get(last.tag)!;
      values[last.index] = `${values[last.index]}\n${raw.trim()}`;
    }
  }
  if (current) out.push(current);
  else if (orphan) out.push(null);
  return out;
}

export function parseEndnoteTagged(source: string): (EndnoteRecord | null)[] {
  return taggedRecords(
    source,
    (line) => {
      const m = /^%(\S)(?: (.*))?$/u.exec(line);
      return m ? [m[1]!, m[2] ?? ""] : null;
    },
    "0",
  ).map((v) =>
    v === null
      ? null
      : record({
          type: firstOf(v, "0"),
          title: firstOf(v, "T"),
          authors: v.get("A") ?? [],
          venue: firstOf(v, "J") ?? firstOf(v, "B"),
          year: firstOf(v, "D"),
          date: firstOf(v, "8"),
          volume: firstOf(v, "V"),
          issue: firstOf(v, "N"),
          pages: firstOf(v, "P"),
          publisher: firstOf(v, "I"),
          doi: firstOf(v, "R"),
          serials: v.get("@") ?? [],
          urls: v.get("U") ?? [],
          abstract: firstOf(v, "X"),
          keywords: v.get("K") ?? [],
          language: firstOf(v, "G"),
          attachments: v.get(">") ?? [],
        }),
  );
}

export function parseNoteExpress(source: string): (EndnoteRecord | null)[] {
  return taggedRecords(
    source,
    (line) => {
      const m = /^\{([^{}\n]{1,64})\}:[ \t]?(.*)$/u.exec(line);
      return m ? [m[1]!.trim(), m[2] ?? ""] : null;
    },
    "Reference Type",
  ).map((v) =>
    v === null
      ? null
      : record({
          type: firstOf(v, "Reference Type"),
          title: firstOf(v, "Title"),
          authors: v.get("Author") ?? [],
          venue: firstOf(v, "Journal") ?? firstOf(v, "Secondary Title"),
          year: firstOf(v, "Year"),
          date: firstOf(v, "Date"),
          volume: firstOf(v, "Volume"),
          issue: firstOf(v, "Issue"),
          pages: firstOf(v, "Pages"),
          publisher: firstOf(v, "Publisher"),
          doi: firstOf(v, "DOI"),
          // CNKI writes one `{ISBN/ISSN}` field; it is told apart like `%@`.
          serials: v.get("ISBN/ISSN") ?? [],
          issn: firstOf(v, "ISSN"),
          isbn: firstOf(v, "ISBN"),
          urls: v.get("URL") ?? [],
          abstract: firstOf(v, "Abstract"),
          keywords: v.get("Keywords") ?? [],
          language: firstOf(v, "Language"),
          // NoteExpress attachments are not read (6.4.14).
          attachments: [],
        }),
  );
}

/** `<xml><records><record>…` ; throws when the document is not that shape. */
export function parseEndnoteXml(source: string): (EndnoteRecord | null)[] {
  const root = readXml(source);
  const records = root.name === "xml" ? xmlPath(root, "records") : undefined;
  if (!records) throw new Error("EndNote XML has no records");
  const text = (element: XmlElement | undefined) => {
    const v = clean(xmlText(element));
    return v || null;
  };
  const texts = (elements: readonly XmlElement[]) =>
    elements.map((e) => xmlText(e)).filter((v) => v.trim());
  return xmlChildren(records, "record").map((r) => {
    try {
      const titles = xmlPath(r, "titles");
      const dates = xmlPath(r, "dates");
      const urls = xmlPath(r, "urls");
      return record({
        type: xmlPath(r, "ref-type")?.attributes.name ?? null,
        title: text(xmlPath(titles, "title")),
        authors: texts(
          xmlChildren(xmlPath(r, "contributors", "authors"), "author"),
        ),
        venue:
          text(xmlPath(r, "periodical", "full-title")) ??
          text(xmlPath(titles, "secondary-title")),
        year: text(xmlPath(dates, "year")),
        date: text(xmlPath(dates, "pub-dates", "date")),
        volume: text(xmlPath(r, "volume")),
        issue: text(xmlPath(r, "number")),
        pages: text(xmlPath(r, "pages")),
        publisher: text(xmlPath(r, "publisher")),
        doi: text(xmlPath(r, "electronic-resource-num")),
        serials: texts(xmlChildren(r, "isbn")),
        urls: texts(xmlChildren(xmlPath(urls, "related-urls"), "url")),
        abstract: text(xmlPath(r, "abstract")),
        keywords: texts(xmlChildren(xmlPath(r, "keywords"), "keyword")),
        language: text(xmlPath(r, "language")),
        attachments: texts(xmlChildren(xmlPath(urls, "pdf-urls"), "url")),
      });
    } catch {
      return null;
    }
  });
}
