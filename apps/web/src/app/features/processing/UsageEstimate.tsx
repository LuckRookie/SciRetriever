import { useQuery } from "@tanstack/react-query";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { estimateStageName } from "../../strings.js";
import "./usage-estimate.css";

const formatted = (range: unknown) =>
  Array.isArray(range)
    ? range.map((n) => Number(n).toLocaleString()).join("–")
    : range && typeof range === "object" && "median" in range && "p90" in range
      ? [range.median, range.p90]
          .map((n) => Number(n).toLocaleString())
          .filter((n, i, all) => i === 0 || n !== all[0])
          .join("–")
      : null;
const unknownReasons: Readonly<Record<string, string>> = {
  "no-matching-history": "没有同方法、同模型的历史",
  "pages-unknown": "页数未知",
  "source-missing": "缺少原始解析",
  "model-unavailable": "模型未配置",
  "partial-reuse-unknown": "部分复用无法核算",
};
/** Archive V2: per-step calls and tokens, with no hard limit on calls. */
function ArchiveEstimate({ value }: { value: Record<string, unknown> }) {
  const total = record(value.total, "estimate total"),
    pages =
      typeof value.expected_proofread_pages === "number"
        ? value.page_basis === "accepted-arrangement"
          ? `预计校订 ${value.expected_proofread_pages} 页`
          : `按全部 ${value.expected_proofread_pages} 页估计`
        : "页数将在执行时核对";
  return (
    <section className="usage-estimate" aria-label="启动前用量预估">
      <p>
        {Number(value.count)} 篇文献 · 可整篇复用 {Number(value.reused_count)}{" "}
        篇 · {pages}
      </p>
      <p className="usage-estimate-total">
        {formatted(total.calls) === null
          ? "合计暂无法预估"
          : `合计约 ${formatted(total.calls)} 次模型调用 · 输入 ${formatted(total.input_tokens) ?? "未知"} / 输出 ${formatted(total.output_tokens) ?? "未知"} token`}
      </p>
      <table className="usage-estimate-table">
        <thead>
          <tr>
            <th scope="col">步骤</th>
            <th scope="col">模型调用</th>
            <th scope="col">输入 / 输出 token</th>
          </tr>
        </thead>
        <tbody>
          {rows(value, "components").map((c) => {
            const calls = formatted(c.calls);
            return (
              <tr key={String(c.step)}>
                <th scope="row">{estimateStageName(String(c.step))}</th>
                {c.basis === "deterministic" ? (
                  <td colSpan={2}>不调用模型</td>
                ) : calls === null ? (
                  <td colSpan={2} className="ui-description">
                    无法预估：
                    {unknownReasons[String(c.unknown_code)] ?? "缺少历史样本"}
                  </td>
                ) : (
                  <>
                    <td>{calls}</td>
                    <td>
                      {formatted(c.input_tokens) ?? "未知"} /{" "}
                      {formatted(c.output_tokens) ?? "未知"}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="ui-description">
        范围取同方法、同模型成功历史的中位数至第 90
        百分位。不设调用上限：整理与校订在同一校验错误连续出现 3 次，或连续 8
        次调用没有进展时停下。
      </p>
    </section>
  );
}

/** Informational estimate only; execution still needs the enclosing explicit confirmation. */
export function UsageEstimate({ request }: { request: unknown }) {
  const api = useApi();
  const normalized = JSON.stringify(request, (key, value) =>
    ["idempotency_key", "name"].includes(key) ? undefined : value,
  );
  const query = useQuery({
    queryKey: ["usage-estimate", normalized],
    enabled: !!request,
    retry: false,
    staleTime: 30000,
    queryFn: ({ signal }) =>
      archiveQuery(api, "usage-estimate", request, signal).then((v) =>
        record(v, "usage estimate"),
      ),
  });
  if (!request) return null;
  if (query.isPending) return <p role="status">正在核对历史用量与复用情况…</p>;
  if (query.error || !query.data)
    return (
      <p className="ui-description">
        当前无法预估 token。仍可确认启动，实际用量记录在任务中。
      </p>
    );
  const value = query.data;
  if (value.schema_version === 2 && value.kind === "archive")
    return <ArchiveEstimate value={value} />;
  return (
    <section className="usage-estimate" aria-label="启动前用量预估">
      <p>
        {typeof value.operation_count === "number"
          ? `${value.operation_count} 项处理 · `
          : ""}
        {typeof value.count === "number" ? `${value.count} 篇文献 · ` : ""}
        {typeof value.reused_count === "number"
          ? `可复用 ${value.reused_count} 篇`
          : "各步复用将在执行时核对"}
      </p>
      {rows(value, "components").map((c, i) => (
        <p key={i}>
          {estimateStageName(String(c.kind))}：输入{" "}
          {formatted(c.input_tokens) ?? "无法预估"} / 输出{" "}
          {formatted(c.output_tokens) ?? "无法预估"} token{" "}
          <span className="ui-description">
            （{Number(c.sample_count)} 个历史样本）
          </span>
        </p>
      ))}
      <p className="ui-description">
        范围采用历史中位数至第 90
        百分位；无样本时无法预估。只供确认参考，不设用量或完成时限。
      </p>
    </section>
  );
}
