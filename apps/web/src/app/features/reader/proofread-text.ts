import type { ApiClient } from "../../data/api.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { record } from "../../data/wire.js";

/** One editable stretch of the reading text; a page can return after a merge or a moved figure. */
export interface EditorSegment {
  page: number;
  repeat: number;
  text: string;
}
export interface EditorText {
  format: "arranged-v2" | "legacy-v1";
  proofread: string;
  arrangement: string | null;
  manualRevision: number;
  pageCount: number;
  segments: EditorSegment[];
}

const MAX_BYTES = 8 * 1024 * 1024;

/** Reads the whole fixed text in bounded windows and splits it where leaf pages change. */
export async function readProofreadText(
  api: ApiClient,
  asset: string,
  version: string | null,
  signal?: AbortSignal,
): Promise<EditorText> {
  let start = 0,
    proofread: string | null = version,
    total = 0,
    first: Record<string, unknown> | null = null,
    text = "";
  const ranges: Record<string, unknown>[] = [];
  for (;;) {
    const chunk = record(
      await archiveQuery(
        api,
        "proofread-text",
        { asset_id: asset, proofread_id: proofread, start, max_bytes: 65536 },
        signal,
      ),
      "editor text",
    );
    if (
      chunk.asset_id !== asset ||
      typeof chunk.proofread_id !== "string" ||
      (proofread && proofread !== chunk.proofread_id) ||
      chunk.start !== start ||
      typeof chunk.text !== "string" ||
      typeof chunk.end !== "number" ||
      chunk.end < start ||
      new TextEncoder().encode(chunk.text).length !== chunk.end - start ||
      Number(chunk.total_bytes) > MAX_BYTES
    )
      throw new Error("全文分块不一致，请重新读取。");
    first ??= chunk;
    proofread = chunk.proofread_id;
    text += chunk.text;
    total = Number(chunk.total_bytes);
    ranges.push(...rows(chunk, "ranges"));
    if (chunk.end >= total) break;
    if (chunk.end === start) throw new Error("全文续读位置无效。");
    start = chunk.end;
  }
  const bytes = new TextEncoder().encode(text),
    pageCount = Number(first.page_count);
  if (
    bytes.length !== total ||
    !proofread ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > 10000
  )
    throw new Error("全文未完整读取。");
  const arranged = first.format === "arranged-v2";
  return {
    format: arranged ? "arranged-v2" : "legacy-v1",
    proofread,
    arrangement:
      typeof first.arrangement_id === "string" ? first.arrangement_id : null,
    manualRevision: Number(first.manual_revision ?? 0),
    pageCount,
    segments: arranged
      ? arrangedSegments(bytes, ranges, pageCount)
      : legacySegments(bytes, ranges, pageCount),
  };
}

/** Leaf ranges cover payload only; structural bytes go with the leaf that follows them. */
function arrangedSegments(
  bytes: Uint8Array,
  ranges: Record<string, unknown>[],
  pageCount: number,
): EditorSegment[] {
  const decode = (from: number, to: number) =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(from, to));
  const sorted = ranges
    .map((r) => ({
      page: Number(r.page),
      start: Number(r.start_utf8),
      end: Number(r.end_utf8),
    }))
    .sort((a, b) => a.start - b.start);
  for (const r of sorted)
    if (
      !Number.isSafeInteger(r.page) ||
      r.page < 0 ||
      r.page >= pageCount ||
      r.start < 0 ||
      r.end > bytes.length ||
      r.end < r.start
    )
      throw new Error("全文页定位无效。");
  const cuts: { page: number; from: number }[] = [];
  let previousEnd = 0;
  for (const r of sorted) {
    if (!cuts.length) cuts.push({ page: r.page, from: 0 });
    else if (cuts[cuts.length - 1]!.page !== r.page)
      cuts.push({ page: r.page, from: previousEnd });
    previousEnd = r.end;
  }
  if (!cuts.length) cuts.push({ page: 0, from: 0 });
  const seen = new Map<number, number>();
  const segments = cuts.map((c, i) => {
    const repeat = seen.get(c.page) ?? 0;
    seen.set(c.page, repeat + 1);
    return {
      page: c.page,
      repeat,
      text: decode(c.from, cuts[i + 1]?.from ?? bytes.length),
    };
  });
  if (segments.map((s) => s.text).join("") !== decode(0, bytes.length))
    throw new Error("全文页内容不完整，未打开编辑。");
  return segments;
}

/** Old proofread drafts carried one range per page that covered every byte. */
function legacySegments(
  bytes: Uint8Array,
  ranges: Record<string, unknown>[],
  pageCount: number,
): EditorSegment[] {
  const pages = Array.from({ length: pageCount }, () => "");
  for (const r of ranges) {
    const n = Number(r.page),
      from = Number(r.start_utf8),
      to = Number(r.end_utf8);
    if (
      !Number.isSafeInteger(n) ||
      n < 0 ||
      n >= pageCount ||
      from < 0 ||
      to > bytes.length ||
      to < from
    )
      throw new Error("全文页定位无效。");
    pages[n] += new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(from, to),
    );
  }
  const text = new TextDecoder().decode(bytes);
  if (!ranges.length) pages[0] = text;
  return pages.map((t, page) => ({ page, repeat: 0, text: t }));
}
