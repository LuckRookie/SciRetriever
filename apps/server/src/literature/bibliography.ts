import type {
  LiteratureDetail,
  LiteratureSearchItem,
} from "@sciretriever/contracts";

export type BibliographyFormat = "bibtex" | "biblatex" | "ris" | "csl-json";
export type BibliographySource =
  | Pick<LiteratureDetail, "literature">
  | LiteratureSearchItem;

function oneLine(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function authorName(
  author: LiteratureDetail["literature"]["metadata"]["authors"][number],
): string {
  return oneLine(
    author.display_name ||
      [author.family_name, author.given_name].filter(Boolean).join(", "),
  );
}

function bibValue(value: string): string {
  return oneLine(value)
    .replaceAll("\\", "\\textbackslash{}")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll('"', '\\"');
}

function citationKey(detail: BibliographySource): string {
  const metadata = detail.literature.metadata;
  const author = metadata.authors[0];
  const stem = oneLine(
    author?.family_name ?? author?.display_name ?? "sciretriever",
  )
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "")
    .slice(0, 32);
  const year = metadata.publication_year ?? "nd";
  return `${stem || "sciretriever"}${year}${detail.literature.literature_id.slice(-8)}`;
}

export function exportBibliography(
  detail: BibliographySource,
  format: BibliographyFormat,
): Uint8Array {
  const metadata = detail.literature.metadata;
  if (format === "bibtex" || format === "biblatex") {
    const fields: [string, string | null][] = [
      ["title", metadata.title],
      [
        "author",
        metadata.authors.map(authorName).filter(Boolean).join(" and ") || null,
      ],
      ["year", metadata.publication_year?.toString() ?? null],
      ["journal", metadata.venue],
      ["publisher", metadata.publisher],
      ["volume", metadata.volume],
      ["number", metadata.issue],
      ["pages", metadata.pages],
      [
        "doi",
        metadata.identifiers.find((item) => item.namespace === "doi")?.value ??
          null,
      ],
      ["abstract", metadata.abstract],
      ["keywords", metadata.keywords.join(", ") || null],
    ];
    const body = fields
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([key, value]) => `  ${key} = {${bibValue(value)}},`)
      .join("\n");
    return new TextEncoder().encode(
      `@article{${citationKey(detail)},\n${body}\n}\n`,
    );
  }
  if (format === "csl-json") {
    const identifiers = Object.fromEntries(
      metadata.identifiers.map((item) => [item.namespace, item.value]),
    );
    const primaryAuthor = metadata.authors.map((author) => {
      const family = author.family_name ?? null;
      const given = author.given_name ?? null;
      return author.kind === "organization"
        ? { literal: author.display_name }
        : {
            ...(given ? { given } : {}),
            ...(family ? { family } : {}),
            ...(!given && !family ? { literal: author.display_name } : {}),
          };
    });
    const value = {
      id: detail.literature.literature_id,
      type: metadata.document_type ?? "article-journal",
      ...(metadata.title ? { title: metadata.title } : {}),
      ...(primaryAuthor.length ? { author: primaryAuthor } : {}),
      ...(metadata.publication_year !== null
        ? { issued: { "date-parts": [[metadata.publication_year]] } }
        : {}),
      ...(metadata.venue ? { "container-title": metadata.venue } : {}),
      ...(metadata.publisher ? { publisher: metadata.publisher } : {}),
      ...(metadata.volume ? { volume: metadata.volume } : {}),
      ...(metadata.issue ? { issue: metadata.issue } : {}),
      ...(metadata.pages ? { page: metadata.pages } : {}),
      ...(identifiers.doi ? { DOI: identifiers.doi } : {}),
      ...(metadata.abstract ? { abstract: metadata.abstract } : {}),
      ...(metadata.keywords.length
        ? { keyword: metadata.keywords.join(", ") }
        : {}),
    };
    return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  }
  if (format !== "ris") throw new Error("unsupported bibliography format");
  const lines = ["TY  - JOUR"];
  const add = (tag: string, value: string | null | undefined) => {
    if (value && oneLine(value)) lines.push(`${tag}  - ${oneLine(value)}`);
  };
  add("TI", metadata.title);
  for (const author of metadata.authors) add("AU", authorName(author));
  add("PY", metadata.publication_year?.toString());
  add("JO", metadata.venue);
  add("PB", metadata.publisher);
  add("VL", metadata.volume);
  add("IS", metadata.issue);
  add("SP", metadata.pages);
  add(
    "DO",
    metadata.identifiers.find((item) => item.namespace === "doi")?.value,
  );
  add("AB", metadata.abstract);
  for (const keyword of metadata.keywords) add("KW", keyword);
  lines.push("ID  - " + detail.literature.literature_id, "ER  - ", "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

/** Encode one already-frozen selection without performing further catalog reads. */
export function exportBibliographyBatch(
  records: readonly BibliographySource[],
  format: BibliographyFormat,
): Uint8Array {
  if (!Array.isArray(records) || records.length === 0)
    throw new TypeError("bibliography export selection is empty");
  if (format === "csl-json") {
    const values = records.map((record) =>
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          exportBibliography(record, format),
        ),
      ),
    );
    return new TextEncoder().encode(`${JSON.stringify(values, null, 2)}\n`);
  }
  return new Uint8Array(
    Buffer.from(
      records
        .map((record) =>
          new TextDecoder("utf-8", { fatal: true }).decode(
            exportBibliography(record, format),
          ),
        )
        .join(""),
    ),
  );
}
