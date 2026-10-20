import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
  Disclosure,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Select,
  Skeleton,
} from "../../components/index.js";
import { archiveQuery, rows, useArchiveAction } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { readLiterature, paperTitle } from "../../data/library.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import { archiveReason, archiveStrings, errorMessage } from "../../strings.js";
import { Assignment } from "../tags/Assignment.js";
import { OperationDialog } from "../library/OperationDialog.js";
import { MetadataFields } from "./MetadataFields.js";
import "./archive.css";
function PaperName({ id }: { id: string }) {
  const api = useApi();
  const q = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id, signal),
  });
  return <span>{q.data ? paperTitle(q.data) : "文献记录"}</span>;
}
export default function Archive() {
  const api = useApi(),
    action = useArchiveAction();
  const [offset, setOffset] = useState(0),
    [reason, setReason] = useState(""),
    [selected, setSelected] = useState<ReadonlySet<string>>(new Set()),
    [editing, setEditing] = useState<string | null>(null),
    [retryParse, setRetryParse] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["archive", "issues", reason, offset],
    queryFn: async ({ signal }) =>
      record(
        await archiveQuery(
          api,
          "archive",
          {
            operation: "issues",
            request: { offset, limit: 50, ...(reason ? { reason } : {}) },
          },
          signal,
        ),
        "archive issues",
      ),
    refetchInterval: 10000,
  });
  const stats = useQuery({
    queryKey: ["archive", "stats"],
    queryFn: async ({ signal }) =>
      record(
        await archiveQuery(
          api,
          "archive",
          { operation: "stats", request: {} },
          signal,
        ),
        "archive stats",
      ),
  });
  const issues = query.data ? rows(query.data) : [],
    groups = query.data ? rows(query.data, "groups") : [],
    reasons = groups.map((g) => String(g.reason));
  const resolve = async () => {
    await action.mutateAsync({
      name: "archive",
      request: {
        operation: "resolve",
        request: { issue_ids: [...selected], resolution: "continue" },
      },
    });
    setSelected(new Set());
  };
  return (
    <div className="feature-page archive-page">
      <PageHeader
        title={archiveStrings.title}
        description={archiveStrings.description}
      />
      <div className="archive-toolbar">
        <Select
          label="问题原因"
          value={reason}
          onChange={(v) => {
            setReason(v);
            setOffset(0);
            setSelected(new Set());
          }}
          options={[
            { value: "", label: "全部原因" },
            ...[...new Set([reason, ...reasons])]
              .filter(Boolean)
              .map((value) => ({
                value,
                label: `${archiveReason(value)} · ${groups.find((g) => g.reason === value)?.count ?? 0}`,
              })),
          ]}
        />
        <span>
          {query.data ? `待处理 ${query.data.total_count} 项` : "正在读取…"}
        </span>
        <Button
          isDisabled={!selected.size || action.isPending}
          onPress={() => void resolve().catch(() => {})}
        >
          确认已处理（{selected.size}）
        </Button>
      </div>
      {query.error || action.error ? (
        <ErrorNotice
          message={errorMessage(query.error ?? action.error)}
          onRetry={() => query.refetch().then(() => {})}
        />
      ) : null}
      {query.isPending ? (
        <Skeleton label="正在读取建档问题" />
      ) : !issues.length ? (
        <EmptyState
          title={archiveStrings.empty}
          description="可以返回文献库选择已有 PDF，分别发起解析和建档。"
        />
      ) : null}
      <div className="archive-issues">
        {issues.map((issue) => {
          const id = String(issue.literature_id),
            key = String(issue.issue_id),
            step = String(issue.step);
          return (
            <article key={key} className="archive-issue">
              <Checkbox
                label="选择此问题"
                isSelected={selected.has(key)}
                onChange={(checked) =>
                  setSelected((prior) => {
                    const next = new Set(prior);
                    if (checked) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
              />
              <div>
                <h3>
                  <PaperName id={id} />
                </h3>
                <p>
                  {archiveStrings.steps[
                    step as keyof typeof archiveStrings.steps
                  ] ?? step}{" "}
                  · {archiveReason(String(issue.reason))}
                </p>
                <p className="ui-description">
                  {issue.affects_readiness === false
                    ? issue.part === "supplementary"
                      ? "补充材料；不影响正文就绪"
                      : "不影响就绪，可稍后处理"
                    : "正文"}
                </p>
                <div className="form-actions">
                  {String(issue.reason) === "needs-parse" ||
                  String(issue.reason).includes("raw-parse") ||
                  String(issue.reason).includes("parse-failed") ? (
                    <Button onPress={() => setRetryParse(id)}>重试解析</Button>
                  ) : null}
                  <Button
                    variant="text"
                    onPress={() =>
                      step === "metadata" || step === "tags"
                        ? setEditing(editing === id ? null : id)
                        : navigate({
                            view: "lib",
                            literature: id,
                            reader: "doc",
                            inspect: "1",
                            asset: String(issue.asset_id),
                          })
                    }
                  >
                    {step === "metadata"
                      ? "编辑缺失字段"
                      : step === "tags"
                        ? "编辑文献标签"
                        : "查看并修正"}
                  </Button>
                  <Button
                    isPending={action.isPending}
                    onPress={() =>
                      action.mutate({
                        name: "archive",
                        request: {
                          operation: "resume",
                          request: { literature_id: id },
                        },
                      })
                    }
                  >
                    {archiveStrings.continue}
                  </Button>
                </div>
                {editing === id ? (
                  step === "tags" ? (
                    <Assignment id={id} />
                  ) : (
                    <MetadataFields id={id} />
                  )
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      <div className="form-actions">
        <Button
          isDisabled={offset === 0}
          onPress={() => {
            setOffset(Math.max(0, offset - 50));
            setSelected(new Set());
          }}
        >
          上一页
        </Button>
        <Button
          isDisabled={query.data?.next_offset == null}
          onPress={() => {
            setOffset(Number(query.data?.next_offset));
            setSelected(new Set());
          }}
        >
          下一页
        </Button>
      </div>
      <Disclosure title={archiveStrings.stats}>
        {stats.error ? (
          <ErrorNotice message={errorMessage(stats.error)} />
        ) : stats.data ? (
          <>
            <table className="archive-table">
              <caption>各步骤实际执行用量</caption>
              <thead>
                <tr>
                  <th>步骤</th>
                  <th>执行次数</th>
                  <th>耗时</th>
                  <th>模型调用</th>
                  <th>输入 / 输出 token</th>
                </tr>
              </thead>
              <tbody>
                {rows(stats.data, "steps").map((s) => (
                  <tr key={String(s.step)}>
                    <th>
                      {archiveStrings.steps[
                        String(s.step) as keyof typeof archiveStrings.steps
                      ] ?? String(s.step)}
                    </th>
                    <td>{Number(s.executions)}</td>
                    <td>{(Number(s.elapsed_ms) / 1000).toFixed(1)} 秒</td>
                    <td>{Number(s.calls)}</td>
                    <td>
                      {Number(s.input_tokens).toLocaleString()} /{" "}
                      {Number(s.output_tokens).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows(stats.data, "parsing").map((p, i) => (
              <p key={i}>
                {String(p.profile)} · {Number(p.pages)} 页 ·{" "}
                {(Number(p.elapsed_ms) / 1000).toFixed(1)} 秒 ·{" "}
                {Number(p.executions)} 次
              </p>
            ))}
          </>
        ) : (
          <Skeleton label="正在读取建档统计" />
        )}
      </Disclosure>
      {retryParse ? (
        <OperationDialog
          kind="parse"
          ids={[retryParse]}
          onClose={() => setRetryParse(null)}
        />
      ) : null}
    </div>
  );
}
