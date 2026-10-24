import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  parsePageRegion,
  type AgentConversationEvent,
} from "@sciretriever/contracts";
import {
  Button,
  Disclosure,
  EmptyState,
  ErrorNotice,
  MasterDetail,
  MasterItem,
  PageHeader,
  PageNote,
  Select,
  Skeleton,
  Switch,
  TechDetails,
} from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { readAgentConversation } from "../../data/agent-conversation.js";
import { RunSwitch, useActiveTaskCount } from "../tasks/RunSwitch.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { record } from "../../data/wire.js";
import {
  agentRoleName,
  agentEventName,
  errorMessage,
  localTime,
  statusLabels,
} from "../../strings.js";
import { RegionPreview } from "../archive/RegionPreview.js";
import "./agents.css";

export default function Agents() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const api = useApi(),
    route = useUrlState(),
    session = route.parameters.get("agentSession"),
    // A linked session may have ended; list everything so it stays visible.
    filter =
      route.parameters.get("agentStatus") ?? (session ? "all" : "running");
  const list = useInfiniteQuery({
    queryKey: ["agent-sessions", "list", filter],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      archiveQuery(
        api,
        "agent-sessions",
        {
          operation: "list",
          request: {
            limit: 30,
            ...(filter !== "all" ? { status: filter } : {}),
            ...(pageParam !== undefined ? { before: pageParam } : {}),
          },
        },
        signal,
      ).then((v) => record(v, "sessions")),
    getNextPageParam: (p) =>
      typeof p.next_before === "number" ? p.next_before : undefined,
  });
  const sessions = list.data?.pages.flatMap((p) => rows(p)) ?? [];
  const running = useActiveTaskCount();
  return (
    <section className="agent-monitor">
      <PageHeader
        title="任务"
        count={running ? `${running} 个进行中` : undefined}
      />
      <RunSwitch value="agent" />
      <MasterDetail
        label="Agent 会话"
        toolbar={
          <Select
            label="会话状态"
            value={filter}
            onChange={(v) => navigate({ agentStatus: v, agentSession: null })}
            options={[
              { value: "running", label: "正在运行" },
              { value: "all", label: "最近会话" },
              { value: "failed", label: "失败" },
            ]}
          />
        }
        list={
          <div className="agent-session-list">
            {list.isPending ? <Skeleton label="正在读取会话" /> : null}
            {list.error ? (
              <ErrorNotice message={errorMessage(list.error)} />
            ) : null}
            {sessions.map((s) => (
              <MasterItem
                key={String(s.session_id)}
                selected={session === s.session_id}
                onPress={() =>
                  navigate({
                    agentSession: String(s.session_id),
                    agentStatus: filter,
                  })
                }
                title={`${agentRoleName(
                  String(record(s.subject, "subject").kind ?? s.role),
                )} · ${String(s.title || "文献处理中")}`}
                meta={
                  <>
                    {statusLabels[String(s.status)] ?? "处理中"} · 已用{" "}
                    {Math.max(
                      0,
                      Math.floor(
                        ((s.finished_at
                          ? Date.parse(String(s.finished_at))
                          : now) -
                          Date.parse(String(s.started_at))) /
                          1000,
                      ),
                    )}{" "}
                    秒 ·{" "}
                    {(
                      Number(s.input_tokens) + Number(s.output_tokens)
                    ).toLocaleString()}{" "}
                    token
                    <br />
                    {localTime(s.started_at)}
                  </>
                }
              />
            ))}
            {list.data && !sessions.length ? (
              <EmptyState
                title={filter === "running" ? "没有正在运行的会话" : "没有会话"}
                description="发起需要模型的处理后，会话会出现在这里。"
              />
            ) : null}
          </div>
        }
        footer={
          list.hasNextPage ? (
            <Button
              variant="text"
              size="compact"
              isPending={list.isFetchingNextPage}
              onPress={() => list.fetchNextPage().then(() => {})}
            >
              更早的会话
            </Button>
          ) : undefined
        }
        detail={
          session ? (
            <SessionDetail key={session} id={session} />
          ) : (
            <EmptyState
              title="选择一个会话"
              description="查看它读了什么、提交了什么。"
            />
          )
        }
      />
      <PageNote>结束后的过程记录保留 7 天。</PageNote>
    </section>
  );
}
function SessionDetail({ id }: { id: string }) {
  const api = useApi();
  const [hooks, setHooks] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["agent-sessions", "detail", id],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      readAgentConversation(api, id, pageParam, signal),
    // The outer database sequence is the cursor, never the DSH message number.
    getNextPageParam: (p) => p?.next_after ?? undefined,
  });
  // The head is bounded and independently refreshed, even when older pages are loaded.
  const head = useQuery({
    queryKey: ["agent-sessions", "head", id],
    queryFn: ({ signal }) =>
      archiveQuery(
        api,
        "agent-sessions",
        { operation: "read", request: { session_id: id, limit: 1 } },
        signal,
      ),
  });
  if (query.isPending) return <Skeleton label="正在读取过程记录" />;
  if (query.error) return <ErrorNotice message={errorMessage(query.error)} />;
  const raw = head.data ?? null,
    first = query.data?.pages[0];
  if (!first)
    return (
      <EmptyState
        title="过程记录已到期或不存在"
        description="过程记录到期删除不影响已发布的文献和算子结果。"
      />
    );
  const h = raw ? record(raw, "session head") : {},
    s: Record<string, unknown> = {
      ...record(h.session ?? first.session, "session"),
      ...first.session,
    },
    subject = record(s.subject, "subject");
  const view = h.latest_view ? record(h.latest_view, "view") : subject;
  const page = Number(view.page ?? subject.page),
    region = view.region ?? subject.region ?? null;
  const events = query.data!.pages.flatMap((p) => p?.events ?? []);
  const messages = events.filter((e) => e.message),
    hookEvents = events.filter((e) => !e.message);
  // Sessions recorded before messages were kept only have hook events.
  const showHooks = hooks || !messages.length;
  return (
    <section className="agent-session-detail" aria-label="Agent 过程记录">
      <h2>
        {agentRoleName(String(subject.kind ?? s.role))} ·{" "}
        {String(s.title || "处理过程")}
      </h2>
      <p>
        {statusLabels[String(s.status)]} · {Number(s.calls)} 次调用 · 输入{" "}
        {Number(s.input_tokens).toLocaleString()} / 输出{" "}
        {Number(s.output_tokens).toLocaleString()} token
      </p>
      <p className="ui-description">
        发起会话：{first.session.actor_label} · {localTime(s.started_at)}
        {s.finished_at ? ` 至 ${localTime(s.finished_at)}` : " · 进行中"}
      </p>
      <div className="form-actions">
        {s.literature_id ? (
          <Button
            onPress={() =>
              navigate(
                {
                  view: "lib",
                  literature: String(s.literature_id),
                  reader: "doc",
                },
                { clearSource: true },
              )
            }
          >
            打开文献
          </Button>
        ) : null}
        {s.job_id ? (
          <Button
            onPress={() =>
              navigate(
                { view: "task", task: String(s.job_id), literature: null },
                { clearSource: true },
              )
            }
          >
            所属任务
          </Button>
        ) : null}
      </div>
      {s.literature_id &&
      subject.asset_id &&
      subject.asset_sha256 &&
      Number.isSafeInteger(page) &&
      page >= 0 ? (
        <div className="agent-current-page">
          <h3>正在核对的原文 · 第 {page + 1} 页</h3>
          <RegionPreview
            literature={String(s.literature_id)}
            asset={String(subject.asset_id)}
            hash={String(subject.asset_sha256)}
            page={page + 1}
            region={region ? parsePageRegion(region) : null}
          />
        </div>
      ) : null}
      {s.truncated ? (
        <p role="status">
          记录已达到保留上限，后续内容已截断；调用次数与 token 继续累计。
        </p>
      ) : null}
      {messages.length && hookEvents.length ? (
        <Switch isSelected={hooks} onChange={setHooks}>
          显示工具耗时记录（{hookEvents.length}）
        </Switch>
      ) : null}
      <ol className="agent-conversation" aria-label="会话记录">
        {events.map((e) =>
          e.message ? (
            <Message key={e.cursor} message={e.message} />
          ) : showHooks ? (
            <HookEvent key={e.cursor} kind={e.kind} value={e.value} />
          ) : null,
        )}
      </ol>
      {query.hasNextPage ? (
        <Button
          isPending={query.isFetchingNextPage}
          onPress={() => query.fetchNextPage().then(() => {})}
        >
          继续读取过程
        </Button>
      ) : null}
    </section>
  );
}
const ROLE_NAMES: Record<AgentConversationEvent["role"], string> = {
  system: "系统提示词",
  user: "输入",
  assistant: "模型",
  tool: "工具返回",
  context: "SciRetriever 上下文",
};
const TOOL_STATUS: Record<string, string> = {
  success: "成功",
  error: "出错",
  rejected: "被拒绝",
  cancelled: "已取消",
};
/** One DSH message, shown verbatim: no Markdown, no summary. */
function Message({ message }: { message: AgentConversationEvent }) {
  return (
    <li className="agent-message" data-role={message.role}>
      <header>
        <strong>{ROLE_NAMES[message.role]}</strong>
        <span className="ui-description">{localTime(message.timestamp)}</span>
        {message.truncated ? (
          <span className="ui-description">内容过长，已截断</span>
        ) : null}
      </header>
      {message.text ? (
        message.role === "system" ? (
          <Disclosure title={`系统提示词 · ${message.text.length} 字`}>
            <pre className="agent-text">{message.text}</pre>
          </Disclosure>
        ) : (
          <Raw text={message.text} />
        )
      ) : null}
      {message.images_omitted ? (
        <p className="agent-image-omitted">
          图片未保存 × {message.images_omitted}
        </p>
      ) : null}
      {message.tool_calls.map((call) => (
        <Raw key={call.id} title={`调用 ${call.name}`} text={call.arguments} />
      ))}
      {message.tool_results.map((result) => (
        <Raw
          key={result.id}
          title={`${result.name} 返回 · ${TOOL_STATUS[result.status] ?? result.status}`}
          text={result.text}
        />
      ))}
    </li>
  );
}
/** Long raw content folds; short content stays open. */
function Raw({ text, title }: { text: string; title?: string }) {
  const long = text.length > 1200 || text.split("\n").length > 24;
  if (!title && !long) return <pre className="agent-text">{text}</pre>;
  return (
    <details className="agent-raw" open={!long}>
      <summary>
        {title ?? "完整内容"}
        {long ? ` · ${text.length.toLocaleString()} 字` : ""}
      </summary>
      <pre className="agent-text">{text}</pre>
    </details>
  );
}
function HookEvent({ kind, value }: { kind: string; value: unknown }) {
  const v = record(value, "event");
  return (
    <li className="agent-hook">
      <span>
        {agentEventName(kind)}
        {typeof v.name === "string" ? ` · ${v.name}` : ""}
        {typeof v.elapsed_ms === "number" ? ` · ${v.elapsed_ms} ms` : ""}
      </span>
      <Disclosure title="参数与返回摘要">
        <TechDetails copyText={JSON.stringify(v, null, 2)}>
          <pre>{JSON.stringify(v, null, 2)}</pre>
        </TechDetails>
      </Disclosure>
    </li>
  );
}
