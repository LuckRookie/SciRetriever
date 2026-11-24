import {
  parseAcquirePdfScope,
  type AcquirePdfScope,
  type LibraryQuery,
} from "@sciretriever/contracts";
import { useIntakeBatch } from "../../data/intake-batches.js";
import { SORT_LABELS } from "../../data/library.js";
import { skippedText } from "../library/AcquireDialog.js";
import { statusLabels } from "../../strings.js";

function readScope(value: unknown): AcquirePdfScope | null {
  if (value === null || value === undefined) return null;
  try {
    return parseAcquirePdfScope(value);
  } catch {
    return null;
  }
}

/** The filter in words; batch names come from the batch itself. */
function useQueryText(query: LibraryQuery | null) {
  const single =
    query?.intake_batch_ids.length === 1 ? query.intake_batch_ids[0]! : null;
  const batch = useIntakeBatch(single);
  if (!query) return "";
  return (
    [
      query.intake_batch_ids.length
        ? `批次：${single ? (batch.data?.label ?? "…") : `${query.intake_batch_ids.length} 批`}`
        : "",
      query.text ? `搜索：${query.text}` : "",
      query.keywords.length ? `作者关键词：${query.keywords.join("、")}` : "",
      query.subject_terms.length
        ? `主题词：${query.subject_terms.join("、")}`
        : "",
      query.publication_year_from || query.publication_year_to
        ? `年份：${query.publication_year_from ?? ""}–${query.publication_year_to ?? ""}`
        : "",
      query.statuses.length
        ? `状态：${query.statuses.map((s) => statusLabels[s] ?? s).join("、")}`
        : "",
      query.venue ? `期刊：${query.venue}` : "",
      query.author ? `作者：${query.author}` : "",
    ]
      .filter(Boolean)
      .join("；") || "全部文献"
  );
}

/** What a scoped PDF task was asked to cover, as fixed when it was created. */
export function TaskScope({ value }: { value: unknown }) {
  const scope = readScope(value);
  const query = scope?.selector.kind === "query" ? scope.selector.query : null;
  const text = useQueryText(query);
  if (!scope) return null;
  const s = scope.selector,
    c = scope.counts;
  return (
    <dl className="task-scope">
      <dt>范围</dt>
      <dd>
        {s.kind === "literatures"
          ? `${s.literature_ids.length.toLocaleString()} 篇指定文献`
          : text}
        {s.kind === "query" && s.limit !== null
          ? `；最多 ${s.limit.toLocaleString()} 篇，按“${SORT_LABELS[s.sort]}”`
          : ""}
      </dd>
      <dt>处理</dt>
      <dd>{c.process.toLocaleString()} 篇</dd>
      <dt>跳过</dt>
      <dd>{skippedText(c)}</dd>
    </dl>
  );
}

const limitText = (value: unknown) =>
  typeof value === "number" ? value.toLocaleString() : "不限";

/**
 * A citation expansion's bounds as it was asked (ADR 0064): its depth, and a
 * null result or scan limit reads “不限”.
 */
export function CitationScope({ selector }: { selector: unknown }) {
  const request =
    selector && typeof selector === "object"
      ? (selector as { request?: { operations?: unknown } }).request
      : null;
  const operations = Array.isArray(request?.operations)
    ? (request.operations as unknown[])
    : [];
  const citations = operations.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const operation = item as { operation?: unknown; request?: unknown };
    const value = operation.request as
      | {
          kind?: unknown;
          max_depth?: unknown;
          result_limit?: unknown;
          providers?: unknown;
        }
      | undefined;
    return operation.operation === "acquire-metadata" &&
      value?.kind === "citation"
      ? [value]
      : [];
  });
  if (citations.length !== 1) return null;
  const citation = citations[0]!;
  const providers = Array.isArray(citation.providers)
    ? (citation.providers as { source?: unknown; scan_limit?: unknown }[])
    : [];
  const scans = [...new Set(providers.map((p) => limitText(p.scan_limit)))];
  return (
    <dl className="task-scope" aria-label="扩展范围">
      <dt>层数</dt>
      <dd>
        {typeof citation.max_depth === "number"
          ? `${citation.max_depth} 层`
          : "—"}
      </dd>
      <dt>结果上限</dt>
      <dd>{limitText(citation.result_limit)}</dd>
      <dt>扫描上限</dt>
      <dd>
        {scans.length <= 1
          ? (scans[0] ?? "不限")
          : providers
              .map((p) => `${String(p.source)} ${limitText(p.scan_limit)}`)
              .join("；")}
      </dd>
    </dl>
  );
}
