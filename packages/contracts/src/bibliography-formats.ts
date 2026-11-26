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
/** EndNote and NoteExpress exports, the formats 6.4.14 added. */
export const ENDNOTE_FAMILY_FORMATS = [
  "endnote-tagged",
  "endnote-xml",
  "noteexpress",
] as const;
export function isIntakeBibliographyFormat(
  value: unknown,
): value is IntakeBibliographyFormat {
  return (INTAKE_BIBLIOGRAPHY_FORMATS as readonly unknown[]).includes(value);
}

const EXTENSIONS: Readonly<Record<string, IntakeBibliographyFormat>> = {
  bib: "bibtex",
  bibtex: "bibtex",
  biblatex: "biblatex",
  ris: "ris",
  json: "csl-json",
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
  return null;
}
/**
 * 6.4.14 “认格式”: the extension first; `.txt`, `.xml` or an unknown
 * extension is decided by the content's beginning. null: not recognized.
 */
export function detectBibliographyFormat(
  fileName: string | null,
  text: string,
): IntakeBibliographyFormat | null {
  const extension = /\.([A-Za-z0-9]+)$/u
    .exec(fileName ?? "")?.[1]
    ?.toLowerCase();
  const named = extension ? EXTENSIONS[extension] : undefined;
  return named ?? bibliographyFormatOfContent(text);
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
