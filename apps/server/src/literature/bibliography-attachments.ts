import {
  ContractValidationError,
  EMPTY_METADATA,
  importString,
  parseImportData,
  type ImportExcluded,
  type ImportFile,
} from "@sciretriever/contracts";

/** Keep escapes until both the attachment and field separators are identified. */
function splitEscaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\") i++;
    else if (value[i] === separator) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}
const unescape = (value: string) => value.replace(/\\([\\:;{}])/gu, "$1");

function bibAttachment(value: string) {
  const parts = splitEscaped(value, ":"),
    last = unescape(parts.at(-1)!).trim();
  if (
    parts.length < 2 ||
    !/^(?:[a-z][a-z0-9+-]*|[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+)?$/iu.test(last)
  )
    return { path: unescape(value), type: "" };
  parts.pop();
  // A drive or URI at the start belongs to the path, not an attachment label.
  if (
    parts.length > 1 &&
    !/^(?:[a-z]|file|internal-pdf)$/iu.test(unescape(parts[0]!).trim())
  )
    parts.shift();
  return { path: unescape(parts.join(":")), type: last.toLowerCase() };
}

function fileReference(path: string, position: string): ImportFile | null {
  try {
    path = importString(path);
    const uri = /^(?:file|internal-pdf):\/\//iu.exec(path);
    let local = uri !== null;
    if (uri) {
      if (/[?#]/u.test(path)) return null;
      try {
        path = decodeURIComponent(path.slice(uri[0].length));
      } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
      }
      if (/[?#]/u.test(path)) return null;
    } else if (/^[a-z][a-z0-9+.-]*:/iu.test(path) && !/^[a-z]:/iu.test(path))
      return null;
    path = importString(path).replaceAll("\\", "/");
    const parts = path.split("/");
    if (parts.some((part) => part === "." || part === "..")) return null;
    local ||= /^(?:\/|[a-z]:|~[^/]*\/)/iu.test(path);
    const file_name = parts.at(-1)!;
    const external_id = local ? `local-file:${position}:${file_name}` : path;
    // Use the same contract as neutral records; a bad attachment never rejects
    // the bibliography record that contains it.
    return parseImportData({
      records: [
        {
          external_id: "attachment",
          metadata: EMPTY_METADATA,
          files: [
            {
              external_id,
              file_name,
              media_type: "application/pdf",
              preferred: true,
            },
          ],
        },
      ],
    }).records[0]!.files[0]!;
  } catch (error) {
    if (error instanceof ContractValidationError) return null;
    throw error;
  }
}

/** Pure conversion. L1 is a whole path; BibTeX file uses escaped : / ; fields. */
export function bibliographyAttachments(
  fields: readonly string[],
  bibtex: boolean,
  sequence: number,
  recordIndex: number,
): { files: readonly ImportFile[]; excluded: readonly ImportExcluded[] } {
  const files: ImportFile[] = [],
    counts = new Map<string, number>();
  const exclude = (kind: string) =>
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let index = 0;
  for (const field of fields)
    for (const value of bibtex ? splitEscaped(field, ";") : [field]) {
      if (!value.trim()) continue;
      const attachment = bibtex
        ? bibAttachment(value.trim())
        : { path: value, type: "" };
      const file = fileReference(
        attachment.path,
        `${sequence}:${recordIndex}:${index++}`,
      );
      if (!file) exclude("invalid-file-reference");
      else if (
        attachment.type !== "pdf" &&
        attachment.type !== "application/pdf" &&
        !/\.pdf$/iu.test(file.file_name)
      )
        exclude("non-pdf-file");
      else if (files.length) exclude("additional-file");
      else files.push(file);
    }
  return {
    files,
    excluded: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}
