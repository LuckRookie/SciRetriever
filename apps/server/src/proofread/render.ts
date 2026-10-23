import type { RawParseResource, ProofreadBlock } from "@sciretriever/contracts";
import { parserMarkdownReferences } from "../parsing/markdown-resources.js";
import { requireTableMarkup } from "./contract.js";
export const PROOFREAD_RENDER_VERSION = "proofread-render-v3";
export function renderBlocks(
  blocks: readonly Pick<
    ProofreadBlock,
    "block_id" | "type" | "title_level" | "text" | "html" | "image_ref"
  >[],
  resources: readonly RawParseResource[],
) {
  const available = new Map(resources.map((r) => [r.reference, r]));
  if (available.size !== resources.length)
    throw new Error("proofread-resource-conflict");
  const ranges: { block_id: string; start_utf8: number; end_utf8: number }[] =
    [];
  const parts: Uint8Array[] = [];
  const used = new Set<string>();
  const ids = new Set<string>();
  let offset = 0;
  for (const b of blocks) {
    if (ids.has(b.block_id)) throw new Error("proofread-duplicate-block");
    ids.add(b.block_id);
    let text: string;
    if (
      !b.text.trim() &&
      b.html === null &&
      !["header", "footer", "page-number", "discarded"].includes(b.type)
    ) {
      // No transcription is a valid outcome. Keep its image and block range,
      // without fabricating an empty table, heading or equation.
      text = b.image_ref ? `![](${b.image_ref})` : "";
    } else
      switch (b.type) {
        case "title":
          if (!b.title_level || b.title_level > 6)
            throw new Error("proofread-title-level");
          text = `${"#".repeat(b.title_level)} ${b.text}`;
          break;
        case "table":
          if (!b.html) throw new Error("proofread-table-missing");
          requireTableMarkup(b.html);
          text = b.html;
          // Chemical drawings and other non-text cells must remain available to readers.
          if (
            b.image_ref &&
            !parserMarkdownReferences(text).includes(b.image_ref)
          )
            text += `\n\n![](${b.image_ref})`;
          break;
        case "equation":
          text = `$$\n${b.text}\n$$`;
          break;
        case "image":
          text = b.image_ref
            ? `![](${b.image_ref})${b.text ? `\n\n${b.text}` : ""}`
            : b.text;
          break;
        case "header":
        case "footer":
        case "page-number":
        case "discarded":
          throw new Error("proofread-unclean-block");
        default:
          text = b.text;
      }
    for (const ref of [
      ...parserMarkdownReferences(text),
      ...(b.image_ref ? [b.image_ref] : []),
    ]) {
      if (!available.has(ref)) throw new Error("proofread-resource-missing");
      used.add(ref);
    }
    const bytes = Buffer.from(`${text}\n\n`, "utf8");
    ranges.push({
      block_id: b.block_id,
      start_utf8: offset,
      end_utf8: offset + bytes.length,
    });
    offset += bytes.length;
    parts.push(bytes);
    if (offset > 8 * 1024 * 1024) throw new Error("proofread-markdown-limit");
  }
  return {
    // An all-failed version has no readable blocks; keep a nonempty whitespace artifact.
    markdown: parts.length ? Buffer.concat(parts) : Buffer.from("\n"),
    ranges,
    resources: [...used].sort().map((r) => available.get(r)!),
  };
}
