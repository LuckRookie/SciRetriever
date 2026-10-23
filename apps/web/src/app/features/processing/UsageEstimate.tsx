import { useQuery } from "@tanstack/react-query";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { estimateStageName } from "../../strings.js";

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
  const formatted = (range: unknown) =>
    Array.isArray(range)
      ? range.map((n) => Number(n).toLocaleString()).join("–")
      : "无法预估";
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
          {estimateStageName(String(c.kind))}：输入 {formatted(c.input_tokens)}{" "}
          / 输出 {formatted(c.output_tokens)} token{" "}
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
