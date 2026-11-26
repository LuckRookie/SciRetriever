/*
 * Bibliography file formats an intake batch accepts as one text segment, and
 * the shared rules for recognizing a file and decoding its bytes (literature
 * materials 6.4.14). Pure: Web and server use the same functions.
 */
export const INTAKE_BIBLIOGRAPHY_FORMATS = [
  "bibtex",
  "biblatex",
  "ris",
  "csl-json",
  "endnote-tagged",
  "endnote-xml",
  "noteexpress",
] as const;
export type IntakeBibliographyFormat =
  (typeof INTAKE_BIBLIOGRAPHY_FORMATS)[number];
export function isIntakeBibliographyFormat(
  value: unknown,
): value is IntakeBibliographyFormat {
  return (INTAKE_BIBLIOGRAPHY_FORMATS as readonly unknown[]).includes(value);
}

const EXTENSIONS: Readonly<Record<string, IntakeBibliographyFormat>> = {
  bibtex: "bibtex",
  biblatex: "biblatex",
  ris: "ris",
  enw: "endnote-tagged",
  net: "noteexpress",
};

/** The first non-empty line, without a byte order mark. */
function firstLine(text: string): string {
  const source = text.replace(/^\uFEFF/u, "");
  let start = 0;
  while (start < source.length) {
    let end = source.indexOf("\n", start);
    if (end < 0) end = source.length;
    const line = source.slice(start, end).replace(/\r$/u, "");
    if (line.trim()) return line;
    start = end + 1;
  }
  return "";
}
/** Root element `xml` with a `records` child, read from the first 64 KiB. */
function looksLikeEndnoteXml(text: string): boolean {
  const head = text.slice(0, 65536).replace(/^\uFEFF/u, "");
  let i = 0;
  // Skip the declaration, comments and whitespace before the root element.
  for (;;) {
    while (i < head.length && /\s/u.test(head[i]!)) i++;
    if (head.startsWith("<?", i)) {
      const end = head.indexOf("?>", i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else if (head.startsWith("<!--", i)) {
      const end = head.indexOf("-->", i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else break;
  }
  if (!/^<xml[\s>]/u.test(head.slice(i, i + 5))) return false;
  const close = head.indexOf(">", i);
  return close > 0 && /^\s*<records[\s>]/u.test(head.slice(close + 1));
}
/**
 * BibTeX or BibLaTeX: the first non-empty line that is not a `%` comment
 * starts with `@` and an entry type; BibLaTeX when the first 64 KiB use one of
 * its entry types or fields (the Web's former rule).
 */
function bibtexFlavour(text: string): "bibtex" | "biblatex" {
  return /@(?:online|mvbook|thesis|report)\s*[{(]|\b(?:date|journaltitle|location)\s*=/iu.test(
    text.slice(0, 65536),
  )
    ? "biblatex"
    : "bibtex";
}
function looksLikeBibtex(text: string): boolean {
  const source = text.slice(0, 65536).replace(/^\uFEFF/u, "");
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || (line.startsWith("%") && !line.startsWith("%0 "))) continue;
    return /^@[A-Za-z]+\s*[{(]/u.test(line);
  }
  return false;
}
/** A JSON array or object whose first 64 KiB name a CSL field. */
function looksLikeCslJson(text: string): boolean {
  const head = text
    .slice(0, 65536)
    .replace(/^\uFEFF/u, "")
    .trimStart();
  return (
    (head.startsWith("[") || head.startsWith("{")) &&
    /"(?:type|title|author|editor|issued|container-title|DOI|ISBN|ISSN|URL|page|volume|issue|publisher)"\s*:/u.test(
      head,
    )
  );
}
/** Which format the content's beginning names, or null. */
export function bibliographyFormatOfContent(
  text: string,
): IntakeBibliographyFormat | null {
  const line = firstLine(text);
  if (/^%0 /u.test(line)) return "endnote-tagged";
  if (line.startsWith("{Reference Type}:")) return "noteexpress";
  if (line.trimStart().startsWith("<") && looksLikeEndnoteXml(text))
    return "endnote-xml";
  if (/^TY {2}-/u.test(line)) return "ris";
  if (looksLikeBibtex(text)) return bibtexFlavour(text);
  if (looksLikeCslJson(text)) return "csl-json";
  return null;
}
/**
 * 6.4.14 “认格式”: the extension first; `.txt`, `.xml` or an unknown
 * extension is decided by the content's beginning. `.bib` is BibTeX or
 * BibLaTeX by its content; a `.json` that is not CSL JSON is not recognized,
 * so the user chooses. null: not recognized.
 */
export function detectBibliographyFormat(
  fileName: string | null,
  text: string,
): IntakeBibliographyFormat | null {
  const extension = /\.([A-Za-z0-9]+)$/u
    .exec(fileName ?? "")?.[1]
    ?.toLowerCase();
  if (extension === "bib") return bibtexFlavour(text);
  if (extension === "json") return looksLikeCslJson(text) ? "csl-json" : null;
  const named = extension ? EXTENSIONS[extension] : undefined;
  return named ?? bibliographyFormatOfContent(text);
}
/**
 * Whether a decoded file may be read in this format: GB18030 applies to the
 * text formats alike; CSL JSON is UTF-8 (or a UTF-16 BOM, as before) only.
 */
export function bibliographyEncodingAccepted(
  format: IntakeBibliographyFormat,
  encoding: ReturnType<typeof decodeBibliographyBytes>["encoding"],
): boolean {
  return encoding !== "gb18030" || format !== "csl-json";
}
/**
 * 6.4.14 “编码”: UTF-8 without its BOM; bytes that are not valid UTF-8 are
 * read as GB18030. A UTF-16 BOM is honoured as before.
 */
export function decodeBibliographyBytes(bytes: Uint8Array): {
  readonly text: string;
  readonly encoding: "utf-8" | "utf-16le" | "utf-16be" | "gb18030";
} {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? ("utf-16le" as const)
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? ("utf-16be" as const)
        : null;
  if (utf16)
    return {
      text: new TextDecoder(utf16, { fatal: true }).decode(bytes),
      encoding: utf16,
    };
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
    };
  } catch {
    return {
      text: new TextDecoder("gb18030", { fatal: true }).decode(bytes),
      encoding: "gb18030",
    };
  }
}
