import { UsageEstimate } from "../processing/UsageEstimate.js";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
  Disclosure,
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
  const stepName = (step: string) =>
    archiveStrings.steps[step as keyof typeof archiveStrings.steps] ?? step;
  const byReason = [
    ...issues
      .reduce((map, issue) => {
        const key = String(issue.reason);
        map.set(key, [...(map.get(key) ?? []), issue]);
        return map;
      }, new Map<string, typeof issues>())
      .entries(),
  ];
  const paging = offset > 0 || query.data?.next_offset != null;
  return (
    <div className="feature-page archive-page">
      <PageHeader
        title={archiveStrings.title}
        description={archiveStrings.description}
      />
      {query.error || action.error ? (
        <ErrorNotice
          message={errorMessage(query.error ?? action.error)}
          onRetry={() => query.refetch().then(() => {})}
        />
      ) : null}
      {query.isPending ? (
        <Skeleton label="正在读取建档问题" />
      ) : !issues.length && !reason && offset === 0 ? (
        <p className="archive-empty">{archiveStrings.empty}。</p>
      ) : (
        <>
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
            <span role="status" className="ui-description">
              待处理 {Number(query.data?.total_count ?? 0)} 项
            </span>
            {selected.size ? (
              <Button
                isDisabled={action.isPending}
                onPress={() => void resolve().catch(() => {})}
              >
                确认已处理（{selected.size}）
              </Button>
            ) : null}
          </div>
          {selected.size ? (
            <UsageEstimate
              request={{
                kind: "archive-issues",
                request: { issue_ids: [...selected] },
              }}
            />
          ) : null}
          <div className="archive-issues" aria-label="建档问题列表">
            {byReason.map(([group, items]) => (
              <section key={group} className="archive-group">
                <h2>
                  {archiveReason(group)}
                  <span>{items.length}</span>
                </h2>
                {items.map((issue) => {
                  const key = String(issue.issue_id),
                    id = String(issue.literature_id);
                  return (
                    <IssueRow
                      key={key}
                      issue={issue}
                      stepName={stepName(String(issue.step))}
                      selected={selected.has(key)}
                      onSelect={(checked) =>
                        setSelected((prior) => {
                          const next = new Set(prior);
                          if (checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                      editing={editing === id}
                      pending={action.isPending}
                      onEdit={() => setEditing(editing === id ? null : id)}
                      onRetryParse={() => setRetryParse(id)}
                      onResume={() =>
                        action.mutate({
                          name: "archive",
                          request: {
                            operation: "resume",
                            request: { literature_id: id },
                          },
                        })
                      }
                    />
                  );
                })}
              </section>
            ))}
            {!issues.length ? (
              <p className="archive-empty">此原因下没有待处理的问题。</p>
            ) : null}
          </div>
          {paging ? (
            <div className="form-actions archive-paging">
              <Button
                variant="text"
                isDisabled={offset === 0}
                onPress={() => {
                  setOffset(Math.max(0, offset - 50));
                  setSelected(new Set());
                }}
              >
                上一页
              </Button>
              <Button
                variant="text"
                isDisabled={query.data?.next_offset == null}
                onPress={() => {
                  setOffset(Number(query.data?.next_offset));
                  setSelected(new Set());
                }}
              >
                下一页
              </Button>
            </div>
          ) : null}
        </>
      )}
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
/** One issue as a row: what failed, and the actions that resolve it, without leaving the list. */
function IssueRow({
  issue,
  stepName,
  selected,
  onSelect,
  editing,
  pending,
  onEdit,
  onRetryParse,
  onResume,
}: {
  issue: Record<string, unknown>;
  stepName: string;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  editing: boolean;
  pending: boolean;
  onEdit: () => void;
  onRetryParse: () => void;
  onResume: () => void;
}) {
  const id = String(issue.literature_id),
    step = String(issue.step),
    reason = String(issue.reason);
  return (
    <article className="archive-issue" data-selected={selected || undefined}>
      <Checkbox
        aria-label="选择此问题"
        isSelected={selected}
        onChange={onSelect}
      />
      <div className="archive-issue-text">
        <h3>
          <PaperName id={id} />
        </h3>
        <p className="ui-description">
          {stepName} ·{" "}
          {issue.affects_readiness === false
            ? issue.part === "supplementary"
              ? "补充材料，不影响正文就绪"
              : "不影响就绪，可稍后处理"
            : "正文"}
        </p>
      </div>
      <div className="archive-issue-actions">
        {reason === "needs-parse" ||
        reason.includes("raw-parse") ||
        reason.includes("parse-failed") ? (
          <Button variant="text" size="compact" onPress={onRetryParse}>
            重试解析
          </Button>
        ) : null}
        <Button
          variant="text"
          size="compact"
          onPress={() =>
            step === "metadata" || step === "tags"
              ? onEdit()
              : navigate({
                  view: "lib",
                  literature: id,
                  reader: "edit",
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
        <Button size="compact" isPending={pending} onPress={onResume}>
          {archiveStrings.continue}
        </Button>
      </div>
      {editing ? (
        <div className="archive-issue-editor">
          {step === "tags" ? (
            <Assignment id={id} />
          ) : (
            <MetadataFields id={id} />
          )}
        </div>
      ) : null}
    </article>
  );
}
