import {
  contentCanonicalJsonBytes,
  parseLiteratureMetadata,
  type LiteratureMetadata,
  type LiteratureSection,
  type LiteratureSubsection,
  type ParserResult,
  type Sha256,
} from "@sciretriever/contracts";
import { createHash } from "node:crypto";

export class AnalysisRuleError extends Error {
  constructor(readonly code: string) {
    super("analysis result violates the closed contract");
  }
}

const MISSING = "未提供";
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MAX_FACTS = 16_384;
const MAX_REFERENCES = 4_096;
const MAX_REFERENCE_CHARACTERS = 65_536;
const MAX_REFERENCE_TOTAL_CHARACTERS = 4 * 1024 * 1024;
const MAX_FORMULA_CHARACTERS = 4_096;
const FIXED: readonly [string, LiteratureSection["role"]][] = [
  ["研究背景与目标", "background-and-objectives"],
  ["研究方法", "methods"],
  ["数据", "data"],
  ["结论与局限性", "conclusions-and-limitations"],
];
const RESERVED = new Set([
  "元数据",
  "摘要",
  "参考文献",
  ...FIXED.map(([title]) => title),
]);
const PARALLEL = new Set([
  "abstract",
  "authors",
  "document type",
  "doi",
  "issue",
  "keywords",
  "language",
  "metadata",
  "other identifiers",
  "pages",
  "publication date",
  "publisher",
  "title",
  "venue",
  "volume",
  "year",
  "作者",
  "出版商",
  "出版日期",
  "卷",
  "年份",
  "摘要",
  "文献类型",
  "期",
  "期刊",
  "标题",
  "语言",
  "其他标识符",
  "页码",
  "关键词",
]);
const MISSING_EXPRESSIONS = new Set([
  "n/a",
  "na",
  "none",
  "not available",
  "not provided",
  "null",
  "unknown",
  "无",
  "无相关信息",
  "暂无",
  "未知",
  "未提及",
  MISSING,
]);
const WRAPPERS: readonly [string, string][] = [
  ["**", "**"],
  ["__", "__"],
  ["~~", "~~"],
  ["`", "`"],
  ["*", "*"],
  ["_", "_"],
];
const DOI = /(?<![A-Za-z0-9])10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu;
const ARXIV =
  /\barxiv[ \t]*:[ \t]*(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?\b/giu;
const PMID = /\bpmid[ \t]*:?[ \t]*\d{1,9}\b/giu;
const PMCID = /\b(?:pmcid[ \t]*:?[ \t]*)?PMC\d{1,9}\b/giu;
const NUMBER_WITH_UNIT =
  /(?<![\d.])(?:[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)[ \t]*(?:%|‰|ppm|ppb|ppt|°[CFK]?|Å|kg|mg|[µμu]g|ng|pg|km|cm|mm|[µμu]m|nm|pm|m|kL|mL|[µμu]L|L|ms|[µμu]s|ns|min|h|Hz|kHz|MHz|GHz|Pa|kPa|MPa|GPa|mol|mmol|[µμu]mol|mM|[µμu]M|M|mV|V|mA|A|mW|kW|W|mJ|kJ|J|meV|keV|eV)(?:[²³23]|\^[+-]?\d+)?(?:[/·](?:kg|mg|g|mL|L|mol|m|cm|mm|s|min|h|K))?(?![A-Za-z0-9_µμ])/gu;
const STANDALONE_NUMBER =
  /(?<![A-Za-z0-9_])[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(?![A-Za-z0-9_])/gu;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/u;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const HTML_RAW_OPEN = /^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)/iu;
const HTML_COMMENT_OPEN = /^ {0,3}<!--/u;
const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>\n]{0,1024}>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

function decodeHtml(value: string): string {
  return value.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|amp|lt|gt|quot|apos);/giu,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const code = Number.parseInt(
          decimal ?? hexadecimal!,
          hexadecimal ? 16 : 10,
        );
        return Number.isSafeInteger(code) && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity;
      }
      return (
        {
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
        } as Record<string, string>
      )[entity.toLocaleLowerCase()]!;
    },
  );
}

function unwrapVisible(value: string): string {
  let candidate = decodeHtml(value)
    .normalize("NFKC")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<\/?[A-Za-z][^>\n]{0,1024}>/gu, "")
    .trim();
  let changed = true;
  while (changed && candidate) {
    changed = false;
    for (const [opening, closing] of WRAPPERS)
      if (
        candidate.startsWith(opening) &&
        candidate.endsWith(closing) &&
        candidate.length >= opening.length + closing.length
      ) {
        candidate = candidate
          .slice(opening.length, candidate.length - closing.length)
          .trim();
        changed = true;
        break;
      }
  }
  return candidate;
}

function isMissingExpression(value: string): boolean {
  return (
    MISSING_EXPRESSIONS.has(value.trim().toLocaleLowerCase()) ||
    MISSING_EXPRESSIONS.has(unwrapVisible(value).toLocaleLowerCase())
  );
}

function hasVisibleContent(value: string): boolean {
  return Boolean(value.replace(/<!--[\s\S]*?-->/gu, "").trim());
}

function hasEvidence(source: string, value: unknown): boolean {
  const candidate = normalize(decodeHtml(String(value))).toLocaleLowerCase();
  if (!candidate) return false;
  return normalize(decodeHtml(source)).toLocaleLowerCase().includes(candidate);
}

function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function metadataHash(metadata: LiteratureMetadata): Sha256 {
  return createHash("sha256")
    .update(contentCanonicalJsonBytes(metadata))
    .digest("hex") as Sha256;
}

/** Protect accepted metadata and allow only values explicitly visible in parsed text. */
export function validateMetadataProposal(
  initial: LiteratureMetadata,
  proposal: LiteratureMetadata,
  markdown: string,
): void {
  const scalar = [
    "title",
    "abstract",
    "publication_date",
    "publication_year",
    "document_type",
    "language",
    "venue",
    "volume",
    "issue",
    "pages",
  ] as const;
  for (const key of scalar) {
    const before = initial[key];
    const after = proposal[key];
    if (before !== null && after !== before)
      throw new AnalysisRuleError("metadata-proposal");
    if (before === null && after !== null && !hasEvidence(markdown, after))
      throw new AnalysisRuleError("metadata-alignment");
  }
  if (initial.publisher !== null && proposal.publisher !== initial.publisher) {
    const stem = (value: string) =>
      normalize(value)
        .toLocaleLowerCase()
        .replace(
          /\b(?:limited|liability|company|corporation|incorporated|corp|inc|ltd|llc|plc|co|gmbh|sarl|pte|pty|sas|ag|bv|nv|sa)\.?\b/gu,
          "",
        )
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    if (stem(initial.publisher) !== stem(proposal.publisher ?? ""))
      throw new AnalysisRuleError("metadata-proposal");
  } else if (
    initial.publisher === null &&
    proposal.publisher !== null &&
    !hasEvidence(markdown, proposal.publisher)
  ) {
    throw new AnalysisRuleError("metadata-alignment");
  }
  if (initial.authors.length) {
    if (proposal.authors.length !== initial.authors.length)
      throw new AnalysisRuleError("metadata-proposal");
    for (let i = 0; i < initial.authors.length; i += 1) {
      const before = initial.authors[i]!,
        after = proposal.authors[i]!;
      if (
        before.kind !== after.kind ||
        before.display_name !== after.display_name
      )
        throw new AnalysisRuleError("metadata-proposal");
      for (const key of ["given_name", "family_name", "orcid"] as const) {
        if (before[key] !== null && after[key] !== before[key])
          throw new AnalysisRuleError("metadata-proposal");
        if (
          before[key] === null &&
          after[key] !== null &&
          !hasEvidence(markdown, after[key])
        )
          throw new AnalysisRuleError("metadata-alignment");
      }
      if (after.affiliations.length < before.affiliations.length)
        throw new AnalysisRuleError("metadata-proposal");
      for (let j = 0; j < before.affiliations.length; j += 1) {
        const ba = before.affiliations[j]!,
          aa = after.affiliations[j]!;
        if (ba.name !== aa.name || (ba.ror !== null && ba.ror !== aa.ror))
          throw new AnalysisRuleError("metadata-proposal");
      }
      for (const affiliation of after.affiliations.slice(
        before.affiliations.length,
      )) {
        if (
          !hasEvidence(markdown, affiliation.name) ||
          (affiliation.ror !== null && !hasEvidence(markdown, affiliation.ror))
        )
          throw new AnalysisRuleError("metadata-alignment");
      }
    }
  } else {
    for (const author of proposal.authors) {
      if (!hasEvidence(markdown, author.display_name))
        throw new AnalysisRuleError("metadata-alignment");
      for (const value of [author.given_name, author.family_name, author.orcid])
        if (value !== null && !hasEvidence(markdown, value))
          throw new AnalysisRuleError("metadata-alignment");
      for (const affiliation of author.affiliations)
        if (
          !hasEvidence(markdown, affiliation.name) ||
          (affiliation.ror !== null && !hasEvidence(markdown, affiliation.ror))
        )
          throw new AnalysisRuleError("metadata-alignment");
    }
  }
  if (
    proposal.identifiers.length < initial.identifiers.length ||
    !sameArray(
      proposal.identifiers.slice(0, initial.identifiers.length),
      initial.identifiers,
    )
  )
    throw new AnalysisRuleError("metadata-proposal");
  const singleton = new Set(["doi", "arxiv", "pmid", "pmcid"]);
  for (const item of proposal.identifiers.slice(initial.identifiers.length)) {
    if (!hasEvidence(markdown, item.value))
      throw new AnalysisRuleError("metadata-alignment");
    if (
      singleton.has(item.namespace) &&
      initial.identifiers.some(
        (i) => i.namespace === item.namespace && i.value !== item.value,
      )
    )
      throw new AnalysisRuleError("metadata-proposal");
  }
  const seen = new Set<string>();
  for (const keyword of proposal.keywords) {
    const key = normalize(keyword).toLocaleLowerCase();
    if (seen.has(key) || !hasEvidence(markdown, keyword))
      throw new AnalysisRuleError("metadata-alignment");
    seen.add(key);
  }
  if (
    proposal.title === null &&
    !proposal.identifiers.some((i) => i.namespace === "doi")
  )
    throw new AnalysisRuleError("metadata-proposal");
}

function visibleTitle(title: string): string {
  let candidate = normalize(decodeHtml(title));
  let changed = true;
  while (changed) {
    changed = false;
    const link = /^\[([^\]\n]{1,1024})\]\([^\n]{0,2048}\)$/u.exec(candidate);
    if (link) {
      candidate = normalize(link[1]!);
      changed = true;
    }
    for (const [opening, closing] of WRAPPERS)
      if (
        candidate.startsWith(opening) &&
        candidate.endsWith(closing) &&
        candidate.length >= opening.length + closing.length
      ) {
        candidate = candidate
          .slice(opening.length, candidate.length - closing.length)
          .trim();
        changed = true;
        break;
      }
  }
  return candidate;
}

function trimLines(lines: readonly string[]): string {
  let start = 0,
    end = lines.length;
  while (start < end && !lines[start]!.trim()) start += 1;
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  return lines.slice(start, end).join("\n");
}

export interface ParsedDraft {
  readonly sections: readonly LiteratureSection[];
  readonly references: readonly string[];
}

function mark(mask: Uint8Array, start: number, end: number): void {
  if (end > start) mask.fill(1, start, end);
}

function fenceClose(line: string, character: string, minimum: number): boolean {
  const candidate = line.replace(/^ +/u, "");
  if (line.length - candidate.length > 3) return false;
  const marker = candidate.match(new RegExp(`^${character}+`, "u"))?.[0] ?? "";
  return marker.length >= minimum && !candidate.slice(marker.length).trim();
}

function protectedMask(value: string): Uint8Array {
  const mask = new Uint8Array(value.length);
  let offset = 0;
  let fence: { character: string; length: number } | undefined;
  let raw: string | undefined;
  for (const lineWithEnding of value.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    const line = lineWithEnding.replace(/[\r\n]+$/u, "");
    const end = offset + lineWithEnding.length;
    if (fence) {
      mark(mask, offset, end);
      if (fenceClose(line, fence.character, fence.length)) fence = undefined;
      offset = end;
      continue;
    }
    if (raw) {
      mark(mask, offset, end);
      if (
        raw === "__comment__"
          ? line.includes("-->")
          : line.toLocaleLowerCase().includes(`</${raw}>`)
      )
        raw = undefined;
      offset = end;
      continue;
    }
    const opened = FENCE_OPEN.exec(line);
    if (opened && !(opened[1]![0] === "`" && opened[2]!.includes("`"))) {
      fence = { character: opened[1]![0]!, length: opened[1]!.length };
      mark(mask, offset, end);
      offset = end;
      continue;
    }
    const rawOpen = HTML_RAW_OPEN.exec(line);
    if (rawOpen) {
      raw = rawOpen[1]!.toLocaleLowerCase();
      mark(mask, offset, end);
      if (line.toLocaleLowerCase().includes(`</${raw}>`)) raw = undefined;
      offset = end;
      continue;
    }
    if (HTML_COMMENT_OPEN.test(line)) {
      mark(mask, offset, end);
      if (!line.includes("-->")) raw = "__comment__";
      offset = end;
      continue;
    }
    const indentation = line.length - line.replace(/^ */u, "").length;
    if (line.startsWith("\t") || indentation >= 4) mark(mask, offset, end);
    // Pair inline backtick runs on this line. Unmatched runs stay visible.
    const pending = new Map<number, number>();
    let index = offset;
    const lineEnd = offset + line.length;
    while (index < lineEnd) {
      if (mask[index] || value[index] !== "`") {
        index += 1;
        continue;
      }
      let runEnd = index + 1;
      while (runEnd < lineEnd && !mask[runEnd] && value[runEnd] === "`")
        runEnd += 1;
      const runLength = runEnd - index;
      const opening = pending.get(runLength);
      if (opening === undefined) pending.set(runLength, index);
      else {
        pending.delete(runLength);
        mark(mask, opening, runEnd);
      }
      index = runEnd;
    }
    offset = end;
  }
  return mask;
}

function rejectHtmlHeadings(value: string, mask: Uint8Array): void {
  let index = 0;
  while ((index = value.indexOf("<", index)) >= 0) {
    if (mask[index]) {
      index += 1;
      continue;
    }
    const match = /^<\/?h([1-6])(?:[\t />]|$)/iu.exec(value.slice(index));
    if (match) throw new AnalysisRuleError("html-heading");
    index += 1;
  }
}

function parseHeading(line: string): { level: number; title: string } | null {
  const match = ATX_HEADING.exec(line);
  if (!match) return null;
  const title = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/u, "").trim();
  if (!title) throw new AnalysisRuleError("content-draft");
  return { level: match[1]!.length, title };
}

function scanMarkdown(
  value: string,
): readonly (string | { level: number; title: string })[] {
  const mask = protectedMask(value);
  rejectHtmlHeadings(value, mask);
  const tokens: (string | { level: number; title: string })[] = [];
  let offset = 0;
  for (const lineWithEnding of value.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    const line = lineWithEnding.replace(/[\r\n]+$/u, "");
    const first = line.search(/\S/u);
    const marker = first < 0 ? -1 : offset + first;
    if (marker >= 0 && mask[marker]) {
      tokens.push(line);
    } else {
      const heading = parseHeading(line);
      if (heading) {
        if (heading.level > 2) throw new AnalysisRuleError("heading-depth");
        tokens.push(heading);
      } else if (SETEXT_UNDERLINE.test(line)) {
        const previous = tokens.at(-1);
        if (typeof previous === "string" && previous.trim())
          throw new AnalysisRuleError("heading-syntax");
        tokens.push(line);
      } else tokens.push(line);
    }
    offset += lineWithEnding.length;
  }
  return tokens;
}

function maskText(value: string): string {
  const mask = protectedMask(value);
  const chars = value.split("");
  for (let i = 0; i < chars.length; i += 1) if (mask[i]) chars[i] = " ";
  return chars.join("");
}

function boundedMatches(pattern: RegExp, value: string): string[] {
  const result: string[] = [];
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    result.push(match[0]!);
    if (result.length > MAX_FACTS)
      throw new AnalysisRuleError("alignment-budget");
  }
  return result;
}

function identifiers(value: string): Set<string> {
  const normalized = decodeHtml(value).normalize("NFKC");
  const result = new Set<string>();
  for (const raw of boundedMatches(DOI, normalized)) {
    let item = raw.replace(/[.,;:]+$/u, "");
    while (
      item.endsWith(")") &&
      (item.match(/\)/gu)?.length ?? 0) > (item.match(/\(/gu)?.length ?? 0)
    )
      item = item.slice(0, -1);
    result.add(`doi:${item.toLocaleLowerCase()}`);
  }
  for (const raw of boundedMatches(ARXIV, normalized))
    result.add(`arxiv:${raw.replace(/[ \t]/gu, "").toLocaleLowerCase()}`);
  for (const raw of boundedMatches(PMID, normalized))
    result.add(`pmid:${raw.match(/\d{1,9}$/u)?.[0] ?? ""}`);
  for (const raw of boundedMatches(PMCID, normalized))
    result.add(
      `pmcid:${raw.match(/PMC\d{1,9}$/iu)?.[0]?.toLocaleLowerCase() ?? ""}`,
    );
  return result;
}

function measurements(value: string): Set<string> {
  const result = new Set<string>();
  for (const raw of boundedMatches(
    NUMBER_WITH_UNIT,
    decodeHtml(value).normalize("NFKC"),
  ))
    result.add(raw.replace(/[ \t,]/gu, "").replace(/[µμ]/gu, "u"));
  return result;
}

function formulas(value: string): Set<string> {
  const result = new Set<string>();
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const opening = value.startsWith("$$", index)
      ? ["$$", "$$"]
      : value.startsWith("\\(", index)
        ? ["\\(", "\\)"]
        : value.startsWith("\\[", index)
          ? ["\\[", "\\]"]
          : value[index] === "$" && value[index - 1] !== "\\"
            ? ["$", "$"]
            : null;
    if (!opening) continue;
    const end = value.indexOf(opening[1]!, index + opening[0]!.length);
    if (end < 0) continue;
    const content = value.slice(index + opening[0]!.length, end);
    if (opening[0] === "$" && content.includes("\n")) {
      index = end;
      continue;
    }
    if (content.length > MAX_FORMULA_CHARACTERS)
      throw new AnalysisRuleError("alignment-budget");
    const normalized = decodeHtml(content)
      .normalize("NFKC")
      .replace(/\s+/gu, "");
    if (normalized) {
      count += 1;
      if (count > MAX_FACTS) throw new AnalysisRuleError("alignment-budget");
      result.add(normalized);
    }
    index = end + opening[1]!.length - 1;
  }
  return result;
}

function standaloneNumbers(value: string): Set<string> {
  let text = maskText(decodeHtml(value).normalize("NFKC"));
  text = text.replace(/<[^>\n]{0,4096}>/gu, " ");
  text = text
    .replace(DOI, " ")
    .replace(ARXIV, " ")
    .replace(PMID, " ")
    .replace(PMCID, " ");
  text = text.replace(NUMBER_WITH_UNIT, " ");
  text = text.replace(
    /\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|(?<!\\)\$[^$\n]*\$/gu,
    " ",
  );
  text = text
    .replace(/^ {0,3}#{1,6}/gmu, " ")
    .replace(/^(?: {0,3})\d{1,9}(?=[.)][ \t]+)/gmu, " ");
  const result = new Set<string>();
  for (const raw of boundedMatches(STANDALONE_NUMBER, text))
    result.add(raw.replace(/,/gu, "").replace("E", "e"));
  return result;
}

function validateAlignment(
  draftMarkdown: string,
  source: string,
  references: readonly string[],
): void {
  if (
    Buffer.byteLength(draftMarkdown, "utf8") > MAX_DRAFT_BYTES ||
    Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
  )
    throw new AnalysisRuleError("alignment-budget");
  if (references.length > MAX_REFERENCES)
    throw new AnalysisRuleError("alignment-budget");
  let total = 0;
  const sourceText = normalize(decodeHtml(source));
  for (const reference of references) {
    if (
      reference.length > MAX_REFERENCE_CHARACTERS ||
      (total += reference.length) > MAX_REFERENCE_TOTAL_CHARACTERS
    )
      throw new AnalysisRuleError("alignment-budget");
    if (
      !normalize(decodeHtml(reference)) ||
      !sourceText.includes(normalize(decodeHtml(reference)))
    )
      throw new AnalysisRuleError("reference-alignment");
  }
  const checks: readonly [Set<string>, Set<string>, string][] = [
    [identifiers(source), identifiers(draftMarkdown), "identifier-alignment"],
    [
      measurements(source),
      measurements(draftMarkdown),
      "measurement-alignment",
    ],
    [formulas(source), formulas(draftMarkdown), "formula-alignment"],
    [
      standaloneNumbers(source),
      standaloneNumbers(draftMarkdown),
      "number-alignment",
    ],
  ];
  for (const [available, used, code] of checks)
    for (const item of used)
      if (!available.has(item)) throw new AnalysisRuleError(code);
}

/** Parse the deliberately small H1/H2 Markdown dialect used by Analysis. */
export function parseContentDraft(
  markdown: string,
  parser: ParserResult,
  source: string,
): ParsedDraft {
  if (!markdown.trim() || markdown.includes("\u0000"))
    throw new AnalysisRuleError("content-draft");
  if (
    Buffer.byteLength(source) !== parser.markdown.byte_size ||
    createHash("sha256").update(source).digest("hex") !== parser.markdown.sha256
  )
    throw new AnalysisRuleError("content-input");
  if (
    Buffer.byteLength(markdown, "utf8") > MAX_DRAFT_BYTES ||
    Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
  )
    throw new AnalysisRuleError("alignment-budget");
  const sections: {
    role: LiteratureSection["role"];
    title: string | null;
    direct: string[];
    subs: { title: string; lines: string[] }[];
  }[] = [];
  let current: (typeof sections)[number] | undefined;
  let sub: { title: string; lines: string[] } | undefined;
  let references = false;
  const refs: string[] = [];
  let expectedFixed = 0;
  const seen = new Set<string>();
  const tokens = scanMarkdown(
    markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  );
  for (const token of tokens) {
    const raw = typeof token === "string" ? token : "";
    const h1 = typeof token !== "string" && token.level === 1 ? token : null;
    const h2 = typeof token !== "string" && token.level === 2 ? token : null;
    if (h1) {
      const title = visibleTitle(h1.title);
      const key = title.toLocaleLowerCase();
      if (!title || seen.has(key)) throw new AnalysisRuleError("content-draft");
      seen.add(key);
      sub = undefined;
      if (references) throw new AnalysisRuleError("content-draft");
      if (title === "参考文献") {
        if (expectedFixed !== FIXED.length)
          throw new AnalysisRuleError("content-draft");
        references = true;
        current = undefined;
        continue;
      }
      const fixed = FIXED.findIndex(([name]) => name === title);
      if (fixed >= 0) {
        if (fixed !== expectedFixed)
          throw new AnalysisRuleError("content-draft");
        expectedFixed += 1;
        current = { role: FIXED[fixed]![1], title: null, direct: [], subs: [] };
      } else {
        if (RESERVED.has(title) || PARALLEL.has(key))
          throw new AnalysisRuleError("content-draft");
        if (expectedFixed === 0 || title === "参考文献")
          throw new AnalysisRuleError("content-draft");
        current = { role: "additional", title, direct: [], subs: [] };
      }
      sections.push(current);
      continue;
    }
    if (h2) {
      if (
        !current ||
        references ||
        PARALLEL.has(visibleTitle(h2.title).toLocaleLowerCase())
      )
        throw new AnalysisRuleError("content-draft");
      sub = { title: visibleTitle(h2.title), lines: [] };
      current.subs.push(sub);
      continue;
    }
    if (references) {
      if (!raw.trim()) continue;
      const item = /^ {0,3}(\d{1,9})\.[ \t]+(.+?)[ \t]*$/u.exec(raw);
      if (item) {
        if (Number(item[1]) !== refs.length + 1)
          throw new AnalysisRuleError("content-draft");
        refs.push(item[2]!.trim());
      } else if (refs.length && /^ {3,}\S/u.test(raw))
        refs[refs.length - 1] += `\n${raw.trim()}`;
      else if (raw.trim() !== MISSING)
        throw new AnalysisRuleError("content-draft");
      continue;
    }
    if (sub) sub.lines.push(raw);
    else if (current) current.direct.push(raw);
    else if (raw.trim()) throw new AnalysisRuleError("content-draft");
  }
  if (
    !references ||
    expectedFixed !== FIXED.length ||
    (!refs.length && !markdown.includes(MISSING))
  )
    throw new AnalysisRuleError("content-draft");
  const result = sections.map((s) => {
    const direct = trimLines(s.direct);
    const subsections: LiteratureSubsection[] = s.subs
      .map((item) => ({
        title: item.title.trim(),
        markdown: trimLines(item.lines),
      }))
      .filter((item) => item.markdown);
    if (s.role !== "additional" && !direct && !subsections.length)
      return { role: s.role, title: null, markdown: MISSING, subsections };
    if (direct === MISSING && subsections.length)
      throw new AnalysisRuleError("missing-marker");
    if (s.role === "additional" && !direct && !subsections.length)
      throw new AnalysisRuleError("content-draft");
    if (direct !== MISSING && isMissingExpression(direct))
      throw new AnalysisRuleError("missing-marker");
    if (
      subsections.some(
        (item) =>
          isMissingExpression(item.markdown) ||
          !hasVisibleContent(item.markdown),
      )
    )
      throw new AnalysisRuleError("empty-subsection");
    return {
      role: s.role,
      title: s.title,
      markdown: direct || "",
      subsections,
    };
  });
  validateAlignment(markdown, source, refs);
  return { sections: result, references: refs };
}

function metadataValue(metadata: LiteratureMetadata, key: string): string {
  if (key === "doi")
    return (
      metadata.identifiers
        .filter((i) => i.namespace === "doi")
        .map((i) => i.value)
        .join(", ") || MISSING
    );
  if (key === "other_identifiers")
    return (
      metadata.identifiers
        .filter((i) => i.namespace !== "doi")
        .map((i) => `${i.namespace}:${i.value}`)
        .join(", ") || MISSING
    );
  if (key === "keywords") return metadata.keywords.join(", ") || MISSING;
  const value = metadata[key as keyof LiteratureMetadata];
  return value === null ||
    value === undefined ||
    (Array.isArray(value) && !value.length)
    ? MISSING
    : String(value);
}

function safeBodyText(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  let fence: { character: string; length: number } | undefined;
  let raw: string | undefined;
  return lines
    .map((line) => {
      if (fence) {
        if (fenceClose(line, fence.character, fence.length)) fence = undefined;
        return line;
      }
      if (raw) {
        if (
          raw === "__comment__"
            ? line.includes("-->")
            : line.toLocaleLowerCase().includes(`</${raw}>`)
        )
          raw = undefined;
        return line;
      }
      const opened = FENCE_OPEN.exec(line);
      if (opened && !(opened[1]![0] === "`" && opened[2]!.includes("`"))) {
        fence = { character: opened[1]![0]!, length: opened[1]!.length };
        return line;
      }
      const rawOpen = HTML_RAW_OPEN.exec(line);
      if (rawOpen) {
        raw = rawOpen[1]!.toLocaleLowerCase();
        if (line.toLocaleLowerCase().includes(`</${raw}>`)) raw = undefined;
        return line;
      }
      if (HTML_COMMENT_OPEN.test(line)) {
        if (!line.includes("-->")) raw = "__comment__";
        return line;
      }
      if (
        ATX_HEADING.test(line) ||
        SETEXT_UNDERLINE.test(line) ||
        /^ {0,3}<\/?h[1-6](?:[\t />]|$)/iu.test(line)
      )
        return `${line.slice(0, line.length - line.trimStart().length)}\\${line.trimStart()}`;
      return line;
    })
    .join("\n");
}

export function renderCanonicalMarkdown(
  metadata: LiteratureMetadata,
  sections: readonly LiteratureSection[],
  references: readonly string[],
): Uint8Array {
  const labels: readonly [string, string][] = [
    ["Title", "title"],
    ["Authors", "authors"],
    ["DOI", "doi"],
    ["Other Identifiers", "other_identifiers"],
    ["Publication Date", "publication_date"],
    ["Year", "publication_year"],
    ["Document Type", "document_type"],
    ["Language", "language"],
    ["Venue", "venue"],
    ["Publisher", "publisher"],
    ["Volume", "volume"],
    ["Issue", "issue"],
    ["Pages", "pages"],
    ["Keywords", "keywords"],
  ];
  const lines = ["# 元数据", ""];
  for (const [label, key] of labels) {
    if (key !== "authors")
      lines.push(`+ ${label}: ${safeBodyText(metadataValue(metadata, key))}`);
    else if (!metadata.authors.length) lines.push(`+ Authors: ${MISSING}`);
    else {
      lines.push("+ Authors:");
      metadata.authors.forEach((a, i) =>
        lines.push(
          `  ${i + 1}. ${safeBodyText(a.display_name)}`,
          `     + Kind: ${a.kind}`,
          ...(a.given_name
            ? [`     + Given Name: ${safeBodyText(a.given_name)}`]
            : []),
          ...(a.family_name
            ? [`     + Family Name: ${safeBodyText(a.family_name)}`]
            : []),
          ...(a.orcid ? [`     + ORCID: ${a.orcid}`] : []),
          ...(a.affiliations.length
            ? [
                "     + Affiliations:",
                ...a.affiliations.flatMap((affiliation, affiliationIndex) => [
                  `       ${affiliationIndex + 1}. ${safeBodyText(affiliation.name)}`,
                  ...(affiliation.ror
                    ? [`          + ROR: ${affiliation.ror}`]
                    : []),
                ]),
              ]
            : []),
        ),
      );
    }
  }
  lines.push("", "# 摘要", "", safeBodyText(metadata.abstract ?? MISSING));
  const titleByRole = new Map(FIXED.map(([title, role]) => [role, title]));
  for (const section of sections) {
    lines.push("", `# ${titleByRole.get(section.role) ?? section.title}`, "");
    if (section.markdown) lines.push(safeBodyText(section.markdown));
    for (const item of section.subsections)
      lines.push("", `## ${item.title}`, "", safeBodyText(item.markdown));
    if (!section.markdown && !section.subsections.length) lines.push(MISSING);
  }
  lines.push("", "# 参考文献", "");
  if (references.length)
    references.forEach((ref, i) => {
      const rendered = safeBodyText(ref);
      const [first, ...rest] = rendered.split("\n");
      lines.push(`${i + 1}. ${first}`, ...rest.map((line) => `   ${line}`));
    });
  else lines.push(MISSING);
  return new TextEncoder().encode(`${lines.join("\n").trimEnd()}\n`);
}

export function parseMetadata(value: unknown): LiteratureMetadata {
  return parseLiteratureMetadata(value);
}
