import type {
  ArrangementLeaf,
  ArrangementOperation,
  ArrangementSourceBlock,
  CorrectOperation,
} from "@sciretriever/contracts";
import { arrangementLeafSpans } from "./arrangement.js";
import type { ArchiveTextSource } from "./text-source.js";

/** ADR 0074 §2: one notation for sub- and superscripts; no period inside a formula. */
export const FORMAT_RULE = "format-normalize-v1";
export const TABLE_NOTE_RULE = `${FORMAT_RULE}/table-note`;
/** Body-type blocks; table HTML, images and display equations keep their text. */
const BODY_TYPES = new Set([
  "title",
  "text",
  "list",
  "caption",
  "footnote",
  "reference",
]);
export interface FormatEdit {
  /** Code-point half-open range in the text the edit was computed on. */
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
  readonly rule: string;
}
const REASONS: Record<string, string> = {
  [`${FORMAT_RULE}/superscript`]: "superscript written in LaTeX",
  [`${FORMAT_RULE}/subscript`]: "subscript written in LaTeX",
  [`${FORMAT_RULE}/formula-period`]: "sentence period moved out of the formula",
};
/** Inline formula spans `$…$` as UTF-16 [start, end); display `$$…$$` is skipped. */
function inlineFormulas(text: string) {
  const spans: { start: number; end: number }[] = [],
    display: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || (i > 0 && text[i - 1] === "\\")) continue;
    if (text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close < 0) break;
      display.push({ start: i, end: close + 2 });
      i = close + 1;
      continue;
    }
    let close = i + 1;
    while (
      close < text.length &&
      (text[close] !== "$" || text[close - 1] === "\\")
    )
      close++;
    if (close >= text.length) break;
    spans.push({ start: i, end: close + 1 });
    i = close;
  }
  return { spans, math: [...spans, ...display] };
}
const balanced = (s: string) => {
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}" && --depth < 0) return false;
  }
  return depth === 0;
};
/**
 * The program's notation edits for one leaf or block text, in code points. Nothing
 * else changes: tags whose content cannot be written as a LaTeX script stay as they are.
 */
export function formatEdits(text: string, type: string): FormatEdit[] {
  if (!BODY_TYPES.has(type) || (!text.includes("<su") && !text.includes("$")))
    return [];
  const { spans, math } = inlineFormulas(text),
    inMath = (at: number) => math.some((m) => at >= m.start && at < m.end),
    found: { at: number; length: number; replacement: string; rule: string }[] =
      [];
  for (const m of text.matchAll(/<(sup|sub)>([^<>\n]*?)<\/\1>/giu)) {
    const content = m[2]!,
      at = m.index;
    if (!content.trim() || /[$%#&]/u.test(content) || !balanced(content))
      continue;
    if (inMath(at)) continue;
    const sup = m[1]!.toLowerCase() === "sup";
    found.push({
      at,
      length: m[0].length,
      replacement: `$${sup ? "^" : "_"}{${content}}$`,
      rule: `${FORMAT_RULE}/${sup ? "superscript" : "subscript"}`,
    });
  }
  for (const s of spans) {
    const body = text.slice(s.start + 1, s.end - 1),
      next = text[s.end];
    if (
      body.endsWith(".") &&
      !body.endsWith("..") &&
      !body.endsWith("\\.") &&
      // `\right.` and `\left.` are LaTeX's empty delimiter, not a sentence period.
      !/\\[A-Za-z]+\s*\.$/u.test(body) &&
      body.trim() !== "." &&
      (next === undefined || /\s/u.test(next) || next === "$")
    )
      found.push({
        at: s.end - 2,
        length: 2,
        replacement: "$.",
        rule: `${FORMAT_RULE}/formula-period`,
      });
  }
  found.sort((a, b) => a.at - b.at);
  const cp = (i: number) => [...text.slice(0, i)].length;
  return found.map((f) => {
    const original = text.slice(f.at, f.at + f.length),
      start = cp(f.at);
    return {
      start,
      end: start + [...original].length,
      original,
      replacement: f.replacement,
      rule: f.rule,
    };
  });
}
export function applyFormatEdits(text: string, edits: readonly FormatEdit[]) {
  let chars = [...text];
  for (const e of [...edits].reverse())
    chars = [
      ...chars.slice(0, e.start),
      ...e.replacement,
      ...chars.slice(e.end),
    ];
  return chars.join("");
}
/** The unified text the arrangement requests send for one leaf or block slice. */
export const unifiedText = (text: string, type: string) =>
  applyFormatEdits(text, formatEdits(text, type));
/**
 * A code-point offset in unified text mapped back to the original text. An offset
 * inside a replacement maps to the start of that edit, so a cut never splits it.
 */
export function originalOffset(
  edits: readonly FormatEdit[],
  unified: number,
): number {
  let shift = 0;
  for (const e of edits) {
    const at = e.start + shift,
      length = [...e.replacement].length;
    if (unified < at) break;
    if (unified < at + length) return e.start;
    shift += length - (e.end - e.start);
  }
  return unified - shift;
}
/** Program corrections of one retained leaf, recorded like page corrections. */
export function formatCorrections(
  leaf: ArrangementLeaf,
  page: number,
): (CorrectOperation & { readonly rule: string })[] {
  return formatEdits(leaf.original_text, leaf.type).map((e) => ({
    kind: "correct",
    leaf_id: leaf.leaf_id,
    start: e.start,
    end: e.end,
    original: e.original,
    replacement: e.replacement,
    basis_page_index: page,
    reason: REASONS[e.rule]!,
    rule: e.rule,
  }));
}
/**
 * The program's table-note attachments over a set of operations: every retained leaf
 * of a note root goes to the first retained leaf of its table. A dropped table, or a
 * note the arrangement dropped, attaches nothing; the note then stays a footnote.
 */
export function tableNoteOperations(
  source: ArchiveTextSource,
  operations: readonly ArrangementOperation[],
): ArrangementOperation[] {
  if (!source.table_notes?.size) return [];
  const roots = new Map(source.blocks.map((b) => [b.root_block_id, b]));
  const cuts = new Map(
      operations.flatMap((o) =>
        o.kind === "split" ? [[o.root_block_id, o.cuts] as const] : [],
      ),
    ),
    assigned = new Set(
      operations.flatMap((o) => (o.kind === "assign" ? [o.leaf_id] : [])),
    ),
    dropped = new Set(
      operations.flatMap((o) => (o.kind === "drop" ? [o.leaf_id] : [])),
    );
  const kept = (root: ArrangementSourceBlock) =>
    arrangementLeafSpans(
      root,
      source.raw.result_sha256,
      cuts.get(root.root_block_id),
    )
      .map((l) => l.leaf_id)
      .filter((id) => assigned.has(id) && !dropped.has(id));
  const byTable = new Map<string, string[]>();
  for (const [noteRoot, tableRoot] of source.table_notes) {
    const note = roots.get(noteRoot),
      table = roots.get(tableRoot);
    if (!note || !table || note.type !== "footnote" || table.type !== "table")
      continue;
    const object = kept(table)[0],
      ids = kept(note);
    if (!object || !ids.length) continue;
    byTable.set(object, [...(byTable.get(object) ?? []), ...ids]);
  }
  return [...byTable].map(([object, ids]) => ({
    kind: "caption",
    object_leaf_id: object,
    caption_leaf_ids: ids,
    object_kind: "table",
    relation: "table-note",
    source: "program",
    rule: TABLE_NOTE_RULE,
  }));
}
