import { ParsingFailure } from "./ports.js";

/** Shared resource rules for backend conversion and normalized-output admission. */
function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

export function canonicalParserResourceReference(value: string): string {
  if (!value || value !== value.trim() || value.length > 2048)
    throw new ParsingFailure("parser-structure");
  let candidate = value;
  for (let index = 0; index < 8 && candidate.includes("%"); index += 1) {
    if (/%(?![0-9a-f]{2})/iu.test(candidate))
      throw new ParsingFailure("parser-structure");
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      throw new ParsingFailure("parser-structure");
    }
  }
  if (
    candidate.includes("%") ||
    hasControl(candidate) ||
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    candidate.startsWith("~/") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(candidate)
  )
    throw new ParsingFailure("parser-structure");
  try {
    const parsed = new URL(candidate, "http://sciretriever.invalid/");
    if (
      parsed.origin !== "http://sciretriever.invalid" ||
      parsed.search ||
      parsed.hash ||
      decodeURIComponent(parsed.pathname) !== `/${candidate}`
    )
      throw new Error();
  } catch {
    throw new ParsingFailure("parser-structure");
  }
  const parts = candidate.split("/");
  if (parts.some((part) => part === "" || part === ".."))
    throw new ParsingFailure("parser-structure");
  const normalized = parts.filter((part) => part !== ".").join("/");
  if (!normalized || normalized !== candidate) {
    throw new ParsingFailure("parser-structure");
  }
  return normalized.normalize("NFC");
}

function maskMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (match) =>
      " ".repeat(match.length),
    )
    .replace(/<!--[\s\S]*?-->/gu, (match) => " ".repeat(match.length))
    .replace(/`[^`\r\n]*`/gu, (match) => " ".repeat(match.length));
}

export function parserMarkdownReferences(markdown: string): readonly string[] {
  const masked = maskMarkdown(markdown);
  const references = new Set<string>();
  const add = (raw: string): void => {
    const value = raw.trim();
    const unwrapped =
      value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
    references.add(canonicalParserResourceReference(unwrapped));
  };
  const definitions = new Map<string, string>();
  for (const match of masked.matchAll(
    /^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(<[^>\r\n]+>|[^\s]+)[ \t]*$/gmu,
  ))
    definitions.set(match[1]!.trim().toLocaleLowerCase(), match[2]!);
  for (const match of masked.matchAll(
    /!\[[^\]\r\n]*\]\((<[^>\r\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/gu,
  ))
    add(match[1]!);
  for (const match of masked.matchAll(/!\[([^\]\r\n]*)\]\[([^\]\r\n]*)\]/gu)) {
    const label = (match[2] || match[1])!.trim().toLocaleLowerCase();
    const destination = definitions.get(label);
    if (!destination) throw new ParsingFailure("parser-structure");
    add(destination);
  }
  for (const tag of masked.matchAll(/<(?:img|source)\b[^>]*>/giu)) {
    const value = tag[0]!;
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(value);
    if (src) add(src[1] ?? src[2] ?? src[3] ?? "");
    const srcset = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(
      value,
    );
    if (srcset)
      for (const item of (srcset[1] ?? srcset[2] ?? srcset[3] ?? "").split(","))
        add(item.trim().split(/\s+/u)[0] ?? "");
  }
  return [...references].sort((a, b) => a.localeCompare(b));
}
