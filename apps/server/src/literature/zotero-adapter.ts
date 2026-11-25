import {
  ContractValidationError,
  EMPTY_METADATA,
  parseIdentifier,
  parseLiteratureMetadata,
  type Identifier,
  type ImportAdapter,
  type ImportAdapterItem,
  type ImportAdapterResult,
  type ImportFile,
  type ImportGroup,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import { decodeBibliography } from "./bibliography-import.js";
import { uniqueIdentifiers } from "./import-clues.js";

/*
 * Zotero API data (format `zotero-api`, literature materials 6.4.9).
 *
 * One data segment is `{items?: ZoteroItem[], collections?: ZoteroCollection[]}`:
 * the objects exactly as a Zotero API returned them (`/items` with
 * `include=data,csljson`, `/collections`), pages concatenated. A parent item and
 * all its children (attachments, notes, annotations) travel in the same segment;
 * collections may travel in any segment of the batch. A membership in a
 * collection the batch never received is dropped (`optional_group_references`).
 *
 * The shapes follow the Web API v3 as probed on 2026-11-10. The local API is
 * assumed to share them; the few places that read a link, a size or an ID are
 * kept in `ZoteroShape` below so that a local-API sample can confirm or change
 * them in one place.
 */
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const KEY = /^[A-Z0-9]{8}$/u;

/** Everything this adapter assumes about where Zotero puts IDs, links and sizes. */
const ZoteroShape = {
  /** `key` on the object, else `data.key`. */
  key(item: Json): string | null {
    const key =
      string(item.key) ?? string((item.data as Json | undefined)?.key);
    return key && KEY.test(key) ? key : null;
  },
  /**
   * The parent's preferred attachment: `links.attachment.href` ends in
   * `/items/<key>` (Web API: https://api.zotero.org/users/<id>/items/<key>).
   * Assumed the same path ending in the local API.
   */
  preferredKey(item: Json): string | null {
    const href = string(
      ((item.links as Json | undefined)?.attachment as Json | undefined)?.href,
    );
    const key = href ? /\/items\/([A-Z0-9]{8})$/u.exec(href)?.[1] : undefined;
    return key ?? null;
  },
  /**
   * The file size when Zotero states it: the parent's
   * `links.attachment.attachmentSize`, else the attachment's
   * `links.enclosure.length` (Web API, files in Zotero storage only).
   */
  size(parent: Json, attachment: Json): number | null {
    const preferred = (parent.links as Json | undefined)?.attachment as
      | Json
      | undefined;
    const enclosure = (attachment.links as Json | undefined)?.enclosure as
      | Json
      | undefined;
    for (const value of [
      ZoteroShape.preferredKey(parent) === ZoteroShape.key(attachment)
        ? preferred?.attachmentSize
        : undefined,
      enclosure?.length,
    ])
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        return value;
    return null;
  },
};

/** Zotero item types and the CSL types Zotero itself exports them as. */
const CSL_TYPES: Readonly<Record<string, string>> = {
  journalArticle: "article-journal",
  magazineArticle: "article-magazine",
  newspaperArticle: "article-newspaper",
  preprint: "article",
  book: "book",
  bookSection: "chapter",
  conferencePaper: "paper-conference",
  thesis: "thesis",
  report: "report",
  patent: "patent",
  manuscript: "manuscript",
  webpage: "webpage",
  blogPost: "post-weblog",
  dataset: "dataset",
  standard: "standard",
  document: "document",
  encyclopediaArticle: "entry-encyclopedia",
  dictionaryEntry: "entry-dictionary",
};
/** A CSL JSON record from Zotero fields, for items without (usable) `csljson`. */
function cslFromFields(data: Json): Json {
  const csl: Json = {};
  const put = (target: string, ...sources: string[]) => {
    for (const source of sources) {
      const value = string(data[source]);
      if (value) {
        csl[target] = value;
        return;
      }
    }
  };
  const itemType = string(data.itemType);
  if (itemType) csl.type = CSL_TYPES[itemType] ?? itemType;
  put("title", "title");
  put("abstract", "abstractNote");
  put("language", "language");
  put(
    "container-title",
    "publicationTitle",
    "bookTitle",
    "proceedingsTitle",
    "websiteTitle",
    "blogTitle",
    "encyclopediaTitle",
    "dictionaryTitle",
  );
  put("publisher", "publisher", "institution", "university", "repository");
  put("volume", "volume");
  put("issue", "issue");
  put("page", "pages");
  put("DOI", "DOI");
  put("ISBN", "ISBN");
  put("ISSN", "ISSN");
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const authors = creators
    .filter((c): c is Json => isObject(c) && c.creatorType === "author")
    .map((c) =>
      string(c.name)
        ? { literal: string(c.name) }
        : { family: string(c.lastName), given: string(c.firstName) },
    )
    .filter((a) => "literal" in a || a.family || a.given);
  if (authors.length) csl.author = authors;
  const date = string(data.date);
  const parts = date
    ? (/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/u.exec(date) ??
      /(?:^|\D)(\d{4})(?:\D|$)/u.exec(date))
    : null;
  if (parts) {
    const values = parts
      .slice(1)
      .filter((v): v is string => v !== undefined)
      .map(Number);
    if (
      values[0]! >= 1 &&
      (values[1] === undefined || (values[1] >= 1 && values[1] <= 12)) &&
      (values[2] === undefined || (values[2] >= 1 && values[2] <= 31))
    )
      csl.issued = { "date-parts": [values] };
  }
  return csl;
}
/** DOI, arXiv ID and PMID written in Extra as `Key: value` lines. */
export function zoteroExtraIdentifiers(extra: unknown): Identifier[] {
  if (typeof extra !== "string") return [];
  const found: Identifier[] = [];
  for (const line of extra.split(/\r\n|\r|\n/u)) {
    const match = /^\s*(doi|arxiv|pmid)\s*:\s*(\S+)\s*$/iu.exec(line);
    if (!match) continue;
    try {
      found.push(
        parseIdentifier({
          namespace: match[1]!.toLowerCase(),
          value: match[2]!.replace(/[.,;]+$/u, ""),
        }),
      );
    } catch (error) {
      if (!(error instanceof ContractValidationError)) throw error;
    }
  }
  return found;
}
/** Decode CSL records with the existing CSL JSON rules; null for each one they refuse. */
function decodeCsl(records: readonly Json[]) {
  if (!records.length) return [];
  let id = 0;
  const deterministic = () =>
    `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const decoded = decodeBibliography(
    Buffer.from(JSON.stringify(records)),
    "csl-json",
    {
      observationId: deterministic,
      provenanceId: deterministic,
      observedAt: () => "1970-01-01T00:00:00Z",
    },
  );
  return records.map((_, index) => {
    const observation = decoded.items[index]?.observation;
    return observation
      ? { metadata: observation.metadata, source_type: observation.source_type }
      : null;
  });
}
const linkMode = (data: Json) => string(data.linkMode);
const isPdf = (data: Json) =>
  string(data.contentType)?.toLowerCase() === "application/pdf";
/** Only stored copies are files Zotero can hand over. */
const isStoredPdf = (data: Json) =>
  isPdf(data) &&
  (linkMode(data) === "imported_file" || linkMode(data) === "imported_url");

function fileOf(parent: Json, attachment: Json): ImportFile | null {
  const data = attachment.data as Json,
    key = ZoteroShape.key(attachment)!,
    name = string(data.filename);
  if (
    !name ||
    /[/\\]/u.test(name) ||
    name === "." ||
    name === ".." ||
    name.length > 1024
  )
    return null;
  const md5 = string(data.md5);
  return {
    external_id: key,
    file_name: name,
    media_type: "application/pdf",
    preferred: true,
    size_bytes: ZoteroShape.size(parent, attachment),
    sha256: null,
    md5: md5 && /^[0-9a-f]{32}$/u.test(md5) ? md5 : null,
  };
}

export const zoteroAdapter: ImportAdapter = {
  format: "zotero-api",
  decode(value): ImportAdapterResult {
    if (!isObject(value)) throw new ContractValidationError();
    for (const key of Object.keys(value))
      if (key !== "items" && key !== "collections")
        throw new ContractValidationError();
    const items = value.items ?? [],
      collections = value.collections ?? [];
    if (!Array.isArray(items) || !Array.isArray(collections))
      throw new ContractValidationError();
    const excluded = new Map<string, number>();
    const count = (kind: string) =>
      excluded.set(kind, (excluded.get(kind) ?? 0) + 1);

    const groups: ImportGroup[] = [];
    for (const collection of collections) {
      const data = isObject(collection) ? collection.data : null,
        key = isObject(collection) ? ZoteroShape.key(collection) : null;
      const name = isObject(data) ? string(data.name) : null;
      if (!key || !isObject(data) || !name) throw new ContractValidationError();
      const parent = data.parentCollection;
      groups.push({
        external_id: key,
        parent_external_id:
          typeof parent === "string" && KEY.test(parent) ? parent : null,
        name,
      });
    }

    // Classify every object once; children are looked up by their parent key.
    const regular = new Map<string, { index: number; item: Json }>(),
      children = new Map<string, Json[]>(),
      standalone: { index: number; item: Json }[] = [],
      malformed: { index: number; key: string | null }[] = [],
      trashed = new Set<string>();
    items.forEach((item, index) => {
      const key = isObject(item) ? ZoteroShape.key(item) : null;
      if (!isObject(item) || !key || !isObject(item.data)) {
        malformed.push({ index, key });
        return;
      }
      const data = item.data,
        type = string(data.itemType),
        parent = string(data.parentItem);
      // `data.deleted` marks an item in Zotero's trash (Web API documentation).
      if (data.deleted === true || data.deleted === 1) {
        trashed.add(key);
        count("trashed-item");
        return;
      }
      if (type === "annotation") count("annotation");
      else if (parent)
        children.set(parent, [...(children.get(parent) ?? []), item]);
      else if (type === "note") count("note");
      else if (type === "attachment") standalone.push({ index, item });
      else regular.set(key, { index, item });
    });

    const result: ImportAdapterItem[] = malformed.map((m) => ({
      ...(m.key ? { external_id: m.key } : {}),
      record_index: m.index,
      record: null,
      reason: "malformed-record",
    }));
    for (const [parent, list] of children)
      if (!regular.has(parent))
        list.forEach(() =>
          count(trashed.has(parent) ? "trashed-item" : "child-without-parent"),
        );

    // Bibliography: the item's own CSL JSON when the CSL rules accept it,
    // otherwise its Zotero fields through the same rules.
    const entries = [...regular.values()];
    const fromCsl = decodeCsl(
      entries.map(({ item }) => (isObject(item.csljson) ? item.csljson : {})),
    );
    const fromFields = decodeCsl(
      entries.map(({ item }) => cslFromFields(item.data as Json)),
    );
    entries.forEach(({ index, item }, position) => {
      const key = ZoteroShape.key(item)!,
        data = item.data as Json,
        decoded =
          (isObject(item.csljson) ? fromCsl[position] : null) ??
          fromFields[position];
      if (!decoded) {
        result.push({
          external_id: key,
          record_index: index,
          record: null,
          reason: "malformed-record",
        });
        return;
      }
      const tags = (Array.isArray(data.tags) ? data.tags : []).filter(isObject);
      const automatic = tags
        .filter((t) => t.type === 1)
        .map((t) => string(t.tag))
        .filter((t): t is string => !!t);
      const manual = tags
        .filter((t) => t.type !== 1)
        .map((t) => string(t.tag))
        .filter((t): t is string => !!t);
      let metadata: LiteratureMetadata;
      try {
        metadata = parseLiteratureMetadata({
          ...decoded.metadata,
          identifiers: uniqueIdentifiers([
            ...decoded.metadata.identifiers,
            ...zoteroExtraIdentifiers(data.extra),
          ]),
          keywords: [...new Set([...decoded.metadata.keywords, ...automatic])],
        });
      } catch (error) {
        if (!(error instanceof ContractValidationError)) throw error;
        result.push({
          external_id: key,
          record_index: index,
          record: null,
          reason: "malformed-record",
        });
        return;
      }
      if (
        metadata.title === null &&
        !metadata.identifiers.some((i) => i.namespace === "doi")
      ) {
        result.push({
          external_id: key,
          record_index: index,
          record: null,
          reason: "missing-title-or-doi",
        });
        return;
      }
      // Files: Zotero's preferred attachment, else the first stored PDF by
      // dateAdded and key; other PDFs and the rest are only counted.
      const own = children.get(key) ?? [];
      const pdfs: Json[] = [];
      for (const child of own) {
        const c = child.data as Json,
          type = string(c.itemType);
        if (type === "note") count("note");
        else if (type !== "attachment") count("child-without-parent");
        else if (linkMode(c) === "linked_file") count("linked-file");
        else if (linkMode(c) === "linked_url") count("linked-url");
        else if (!isStoredPdf(c)) count("non-pdf-file");
        else pdfs.push(child);
      }
      const wanted = ZoteroShape.preferredKey(item);
      const ordered = [...pdfs].sort(
        (a, b) =>
          Number(ZoteroShape.key(b) === wanted) -
            Number(ZoteroShape.key(a) === wanted) ||
          String((a.data as Json).dateAdded ?? "").localeCompare(
            String((b.data as Json).dateAdded ?? ""),
          ) ||
          ZoteroShape.key(a)!.localeCompare(ZoteroShape.key(b)!),
      );
      const file = ordered[0] ? fileOf(item, ordered[0]) : null;
      if (ordered[0] && !file) count("invalid-file-reference");
      for (let i = 1; i < ordered.length; i++) count("additional-file");
      result.push({
        external_id: key,
        record_index: index,
        reason: null,
        record: {
          external_id: key,
          metadata,
          source_type: decoded.source_type,
          groups: [
            ...new Set(
              (Array.isArray(data.collections) ? data.collections : []).filter(
                (c): c is string => typeof c === "string" && KEY.test(c),
              ),
            ),
          ],
          user_tags: [...new Set(manual)],
          files: file ? [file] : [],
          annotations: [],
        },
      });
    });
    // A standalone stored PDF is only its file (ADR 0063 section 2).
    for (const { index, item } of standalone) {
      const data = item.data as Json,
        key = ZoteroShape.key(item)!;
      if (linkMode(data) === "linked_file") count("linked-file");
      else if (linkMode(data) === "linked_url") count("linked-url");
      else if (!isStoredPdf(data)) count("non-pdf-file");
      else {
        const file = fileOf(item, item);
        if (!file) count("invalid-file-reference");
        else
          result.push({
            external_id: key,
            record_index: index,
            reason: null,
            record: {
              external_id: key,
              metadata: parseLiteratureMetadata(EMPTY_METADATA),
              source_type: null,
              groups: [],
              user_tags: [],
              files: [file],
              annotations: [],
              file_only: true,
            },
          });
      }
    }
    return {
      optional_group_references: true,
      groups,
      excluded: [...excluded].map(([kind, n]) => ({ kind, count: n })),
      items: result.sort((a, b) => a.record_index - b.record_index),
    };
  },
};
