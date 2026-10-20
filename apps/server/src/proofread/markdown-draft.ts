import type { RawBlockType } from "@sciretriever/contracts";
import type { DraftCandidate } from "./contract.js";
import { hasKnownTextDefect } from "./clean.js";
export function markdownDraft(markdown: string): readonly DraftCandidate[] {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n"),
    out: DraftCandidate[] = [];
  const definitions = new Map<string, string>();
  const referenceKey = (value: string) =>
    value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  const definition = /^\s{0,3}\[([^\]\n]+)\]:\s*<?([^\s>]+)>?(?:\s+["'(].*)?$/u;
  let definitionFence: string | null = null;
  for (const line of lines) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (!definitionFence) definitionFence = fence;
      else if (
        fence[0] === definitionFence[0] &&
        fence.length >= definitionFence.length
      )
        definitionFence = null;
      continue;
    }
    if (definitionFence) continue;
    const match = definition.exec(line);
    if (match && !definitions.has(referenceKey(match[1]!)))
      definitions.set(referenceKey(match[1]!), match[2]!);
  }
  const tableDelimiter = (line: string) =>
    /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u.test(line.trim());
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/gu, "")
      .split(/(?<!\\)\|/u)
      .map((c) => c.trim().replace(/\\\|/gu, "|"));
  const escape = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const add = (
    type: RawBlockType,
    text: string,
    level: number | null = null,
    html: string | null = null,
    image: string | null = null,
  ) =>
    out.push({
      page: -1,
      region: null,
      locate: "page",
      text_source: "parser",
      page_text: [],
      continuation_regions: [],
      type,
      title_level: level,
      text,
      html,
      image_ref: image,
      raw_ref: [[0, out.length]],
      known_defect: hasKnownTextDefect(text),
    });
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    if (definition.test(line)) {
      i++;
      continue;
    }
    if (
      i + 1 < lines.length &&
      line.includes("|") &&
      tableDelimiter(lines[i + 1]!)
    ) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"))
        rows.push(cells(lines[i++]!));
      const row = (values: string[], tag: string) =>
        `<tr>${header.map((_, j) => `<${tag}>${escape(values[j] ?? "")}</${tag}>`).join("")}</tr>`;
      add(
        "table",
        "",
        null,
        `<table><thead>${row(header, "th")}</thead><tbody>${rows.map((r) => row(r, "td")).join("")}</tbody></table>`,
      );
      continue;
    }
    const referenceImage = /^!\[([^\]]*)\](?:\[([^\]]*)\])?$/u.exec(line);
    if (referenceImage) {
      const reference = definitions.get(
        referenceKey(referenceImage[2] || referenceImage[1]!),
      );
      if (reference) {
        add("image", "", null, null, reference);
        i++;
        continue;
      }
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      add("title", heading[2]!, heading[1]!.length);
      i++;
      continue;
    }
    const image = /^!\[[^\]]*\]\(([^\s)]+)\)$/u.exec(line);
    if (image) {
      add("image", "", null, null, image[1]!);
      i++;
      continue;
    }
    if (line.startsWith("$$")) {
      const parts = [lines[i++]!];
      while (
        i < lines.length &&
        !(parts.length === 1 && /\$\$.+\$\$$/u.test(parts[0]!))
      ) {
        const next = lines[i++]!;
        parts.push(next);
        if (next.includes("$$")) break;
      }
      add(
        "equation",
        parts
          .join("\n")
          .replace(/^\s*\$\$|\$\$\s*$/gu, "")
          .trim(),
      );
      continue;
    }
    if (/^<table\b/iu.test(line)) {
      const parts = [lines[i++]!];
      while (i < lines.length && !parts.at(-1)!.includes("</table>"))
        parts.push(lines[i++]!);
      add("table", "", null, parts.join("\n"));
      continue;
    }
    // Fenced code is kept as one text candidate, never interpreted as headings.
    const fence = /^(`{3,}|~{3,})/u.exec(line);
    const parts = [lines[i++]!];
    if (fence) {
      while (i < lines.length) {
        const next = lines[i++]!;
        parts.push(next);
        if (next.trim().startsWith(fence[1]!)) break;
      }
    } else
      while (
        i < lines.length &&
        lines[i]!.trim() &&
        !definition.test(lines[i]!) &&
        !(
          i + 1 < lines.length &&
          lines[i]!.includes("|") &&
          tableDelimiter(lines[i + 1]!)
        ) &&
        !/^(?:#{1,6}\s|!\[|\$\$|<table\b)/iu.test(lines[i]!.trim())
      )
        parts.push(lines[i++]!);
    add(
      /^\s*(?:[-*+] |\d+[.)] )/u.test(parts[0]!) ? "list" : "text",
      parts.join("\n"),
    );
  }
  return out;
}
