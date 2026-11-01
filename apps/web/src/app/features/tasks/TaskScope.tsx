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
        ? `入库批次：${single ? (batch.data?.label ?? "…") : `${query.intake_batch_ids.length} 批`}`
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
