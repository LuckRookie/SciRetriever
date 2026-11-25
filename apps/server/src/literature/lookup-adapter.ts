import {
  ContractValidationError,
  EMPTY_METADATA,
  IMPORT_LIMITS,
  parseIdentifier,
  parseLiteratureMetadata,
  type Identifier,
  type ImportAdapter,
  type ImportAdapterResult,
  type IntakeLookupKind,
} from "@sciretriever/contracts";
import { clueDois, normalizeRecognitionTitle } from "./import-clues.js";

/** One non-empty line of a `lookup` text, classified without any lookup. */
export interface LookupLine {
  /** 1-based number in the submitted text, blank lines included. */
  readonly line: number;
  /** The line, trimmed, control characters replaced by spaces. */
  readonly text: string;
  /** null when the line is refused or repeats an earlier one. */
  readonly kind: IntakeLookupKind | null;
  readonly identifier: Identifier | null;
  readonly title: string | null;
  readonly reason:
    | "lookup-unsupported-url"
    | "lookup-too-short"
    | "lookup-too-long"
    | "duplicate-line"
    | null;
}
export class LookupLinesError extends Error {
  readonly code = "intake-lookup-too-many";
  constructor() {
    super("Too many lookup lines");
  }
}
const ARXIV =
  /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)((?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)/iu;
const PMID =
  /(?:(?<![a-z0-9])pmid\s*[:：]?\s*|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{1,12})(?!\d)/iu;
function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function parsed(namespace: string, value: string): Identifier | null {
  try {
    return parseIdentifier({ namespace, value });
  } catch (error) {
    if (error instanceof ContractValidationError) return null;
    throw error;
  }
}
function classify(
  text: string,
): Pick<LookupLine, "kind" | "identifier" | "title" | "reason"> {
  const doi = clueDois(text)[0];
  if (doi) return { kind: "doi", identifier: doi, title: null, reason: null };
  const source = decoded(text).normalize("NFKC");
  const arxiv = ARXIV.exec(source),
    arxivId = arxiv ? parsed("arxiv", arxiv[1]!.toLowerCase()) : null;
  if (arxivId)
    return { kind: "arxiv", identifier: arxivId, title: null, reason: null };
  const pmid = PMID.exec(source),
    pmidId = pmid ? parsed("pmid", pmid[1]!) : null;
  if (pmidId)
    return { kind: "pmid", identifier: pmidId, title: null, reason: null };
  if (/^https?:\/\//iu.test(text))
    return {
      kind: null,
      identifier: null,
      title: null,
      reason: "lookup-unsupported-url",
    };
  const length = [...normalizeRecognitionTitle(text)].length;
  if (length < 10 || length > IMPORT_LIMITS.lookup_title_codepoints)
    return {
      kind: null,
      identifier: null,
      title: null,
      reason: length < 10 ? "lookup-too-short" : "lookup-too-long",
    };
  return { kind: "title", identifier: null, title: text, reason: null };
}
/**
 * Split and classify a `lookup` text (literature materials 6.4.12): DOI, then
 * arXiv, then PMID, then an unsupported address, then a title of 10–500
 * normalized code points. Repeats of an
 * identifier or normalized title keep the first line.
 */
export function lookupLines(value: unknown): LookupLine[] {
  if (typeof value !== "string") throw new ContractValidationError();
  const lines: LookupLine[] = [],
    seen = new Set<string>();
  for (const [index, raw] of value.split(/\r\n|\r|\n/u).entries()) {
    const text = raw
      .replace(/[\p{Cc}\p{Cs}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!text) continue;
    if (lines.length >= IMPORT_LIMITS.lookup_lines)
      throw new LookupLinesError();
    const line = { line: index + 1, text, ...classify(text) };
    if (line.reason) {
      lines.push(line);
      continue;
    }
    const key = line.identifier
      ? `${line.identifier.namespace}:${line.identifier.value}`
      : `title:${normalizeRecognitionTitle(line.title!)}`;
    if (seen.has(key))
      lines.push({
        ...line,
        kind: null,
        identifier: null,
        title: null,
        reason: "duplicate-line",
      });
    else {
      seen.add(key);
      lines.push(line);
    }
  }
  return lines;
}
/**
 * Pure `lookup` adapter. Every non-empty line becomes one item at
 * record_index = line − 1 with external_id = its text; refused and repeated
 * lines have no record. The item only carries the given identifier or title.
 */
export const lookupAdapter: ImportAdapter = {
  format: "lookup",
  decode(value): ImportAdapterResult {
    const lines = lookupLines(value),
      duplicates = lines.filter((l) => l.reason === "duplicate-line").length;
    return {
      groups: [],
      excluded: duplicates
        ? [{ kind: "duplicate-line", count: duplicates }]
        : [],
      items: lines.map((l) => ({
        external_id: l.text,
        record_index: l.line - 1,
        reason: l.reason,
        record: l.reason
          ? null
          : {
              external_id: l.text,
              metadata: parseLiteratureMetadata({
                ...EMPTY_METADATA,
                title: l.title,
                identifiers: l.identifier ? [l.identifier] : [],
              }),
              source_type: null,
              groups: [],
              user_tags: [],
              files: [],
              annotations: [],
            },
      })),
    };
  },
};
