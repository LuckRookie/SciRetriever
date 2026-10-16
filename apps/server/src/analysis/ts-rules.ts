import {
  contentCanonicalJsonBytes,
  parseLiteratureMetadata,
  type LiteratureMetadata,
  type LiteratureSection,
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
const FIXED: readonly [string, LiteratureSection["role"]][] = [
  ["研究背景与目标", "background-and-objectives"],
  ["研究方法", "methods"],
  ["数据", "data"],
  ["结论与局限性", "conclusions-and-limitations"],
];
const WRAPPERS: readonly [string, string][] = [
  ["**", "**"],
  ["__", "__"],
  ["~~", "~~"],
  ["`", "`"],
  ["*", "*"],
  ["_", "_"],
];
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

export function metadataHash(metadata: LiteratureMetadata): Sha256 {
  return createHash("sha256")
    .update(contentCanonicalJsonBytes(metadata))
    .digest("hex") as Sha256;
}

/** Analysis fills gaps; accepted metadata remains owned by Literature. */
export function mergeMetadataProposal(
  initial: LiteratureMetadata,
  proposal: LiteratureMetadata,
): LiteratureMetadata {
  const accepted = Object.fromEntries(
    Object.entries(initial).filter(
      ([, value]) =>
        value !== null && (!Array.isArray(value) || value.length > 0),
    ),
  );
  return parseLiteratureMetadata({ ...proposal, ...accepted });
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
        tokens.push(heading.level <= 2 ? heading : line);
      } else if (SETEXT_UNDERLINE.test(line)) {
        const previous = tokens.at(-1);
        if (typeof previous === "string" && previous.trim()) {
          tokens.pop();
          tokens.push({
            level: line.trimStart().startsWith("=") ? 1 : 2,
            title: previous.trim(),
          });
        } else tokens.push(line);
      } else tokens.push(line);
    }
    offset += lineWithEnding.length;
  }
  return tokens;
}

/** Read Markdown structure without trying to prove the model's scientific claims. */
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
  type Section = {
    role: LiteratureSection["role"];
    title: string | null;
    direct: string[];
    subs: { title: string; lines: string[] }[];
  };
  const sections: Section[] = [];
  const references: string[] = [];
  let current: Section | undefined;
  let sub: Section["subs"][number] | undefined;
  let inReferences = false;
  const section = (title: string): Section => {
    const role = FIXED.find(([name]) => name === title)?.[1] ?? "additional";
    const existing = sections.find((s) =>
      role === "additional" ? s.title === title : s.role === role,
    );
    if (existing) return existing;
    const value: Section = {
      role,
      title: role === "additional" ? title : null,
      direct: [],
      subs: [],
    };
    sections.push(value);
    return value;
  };
  for (const token of scanMarkdown(
    markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  )) {
    if (typeof token !== "string" && token.level === 1) {
      const title = visibleTitle(token.title);
      inReferences = title === "参考文献";
      sub = undefined;
      if (!inReferences) current = section(title);
      continue;
    }
    const raw =
      typeof token === "string"
        ? token
        : `${"#".repeat(token.level)} ${token.title}`;
    if (inReferences) {
      const line = raw.trim();
      if (!line || line === MISSING) continue;
      const item = /^(?:\d+[.)]|[-*+])\s+(.+)$/u.exec(line);
      if (item) references.push(item[1]!);
      else if (references.length)
        references[references.length - 1] += `\n${line}`;
      else references.push(line);
      continue;
    }
    current ??= section("总结");
    if (typeof token !== "string" && token.level === 2) {
      sub = { title: visibleTitle(token.title), lines: [] };
      current.subs.push(sub);
    } else (sub?.lines ?? current.direct).push(raw);
  }
  if (
    !sections.some(
      (s) =>
        s.direct.some((line) => line.trim()) ||
        s.subs.some((sub) => sub.lines.some((line) => line.trim())),
    )
  )
    throw new AnalysisRuleError("content-draft");
  const convert = (s: Section): LiteratureSection => ({
    role: s.role,
    title: s.title,
    markdown: trimLines(s.direct),
    subsections: s.subs
      .map((v) => ({ title: v.title, markdown: trimLines(v.lines) }))
      .filter((v) => v.markdown.trim()),
  });
  // Keep the published legacy shape while accepting missing/reordered headings.
  const fixed = FIXED.map(([title]) => {
    const value = convert(section(title));
    return !value.markdown && !value.subsections.length
      ? { ...value, markdown: MISSING }
      : value;
  });
  const additional = sections
    .filter((s) => s.role === "additional")
    .map(convert)
    .filter((s) => s.markdown.trim() || s.subsections.length);
  return { sections: [...fixed, ...additional], references };
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
