import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type OperatorInput,
  type SourceProblem,
  type WorkbenchObservation,
  type WorkbenchActionRecord,
  type WorkbenchArticleSession,
  type WorkbenchView,
} from "@sciretriever/contracts";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorNotice,
  Icon,
  PageNote,
  Skeleton,
  TechDetails,
  TextArea,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { TaskPage } from "../tasks/TaskPage.js";
import { registerNavigationGuard, useUrlState } from "../../data/url.js";
import {
  errorMessage,
  localTime,
  serviceMessage,
  shortTime,
  statusLabels,
} from "../../strings.js";
import { ProblemDetails, problemText } from "../sources/problem.js";
import { randomId } from "../../../browser-platform.js";
import { candidateStatus } from "../../data/candidate-status.js";
import {
  ScreencastStage,
  type ScreencastStageHandle,
} from "./ScreencastStage.js";
import type { ScreencastState } from "./screencast-client.js";
import { readLiterature } from "../../data/library.js";
import {
  attemptsDetail,
  attemptsLine,
} from "../../data/acquisition-wording.js";
import "./browser.css";

const states: Readonly<Record<string, string>> = {
  watching: "页面可观看",
  "agent-running": "Agent 正在操作",
  "needs-assistance": "自动操作受阻",
  paused: "已暂停",
  cancelled: "已取消",
  finished: "已结束",
  failed: "未能继续",
};
const phases: Readonly<Record<string, string>> = {
  queued: statusLabels.queued!,
  ready: "等待观察",
  deciding: "Agent 推理中",
  waiting: "等待页面或控制权",
  downloading: "下载中",
  validating: "验收文件中",
  "candidate-ready": "等待入库",
  closing: "结清资源中",
  closed: "已结束",
};
const IDLE_RETURN_MS = 10_000;
const actors: Readonly<Record<WorkbenchActionRecord["actor"], string>> = {
  agent: "Agent",
  human: "你",
  platform: "平台",
};
/** Publisher titles may carry inline markup such as <sub>; show it as text. */
const plain = (text: string) =>
  text.replace(/<\/?(?:sub|sup|i|b|em|strong|span)\b[^>]*>/giu, "");
/** One line for an action that actually happened; no guessed intent. */
function actionText(action: WorkbenchActionRecord) {
  const label = plain(action.label ?? "");
  switch (action.kind) {
    case "click-element":
    case "click-point":
      return label ? `点击 ${label}` : "点击页面";
    case "scroll-surface":
      return "滚动页面";
    case "type-text":
      return label ? `在 ${label} 输入` : "输入文字";
    case "press-key":
      return `按 ${label || "键"}`;
    case "go-back":
      return "返回上一页";
    case "wait-for-change":
      return "等待页面变化";
    case "tab-switch":
      return label ? `切换到 ${label}` : "切换页签";
    case "navigation-failed":
      // The label repeats the platform code; the sentence is enough here.
      return "跳转未完成，Agent 重新观察页面";
    case "navigation":
      return `进入 ${label || action.url || "新页面"}`;
    case "download-started":
      return "开始下载";
    case "download-failed":
      return `下载失败${label ? `：${reasonText(label)}` : ""}`;
    case "validation-passed":
      return "文件验收通过";
    case "validation-failed":
      return `文件验收未通过${label ? `：${reasonText(label)}` : ""}`;
    case "flow-stopped":
      return "流程停止";
    default:
      return label || action.kind;
  }
}
const ended = (view: WorkbenchView) =>
  ["finished", "failed", "cancelled"].includes(view.state);
type Session = WorkbenchArticleSession;
/**
 * Phase badge (rule 5): work in progress is grey with a ring, waiting is grey,
 * a paper taken in is green, a failed fetch is red.
 */
function PhaseBadge({ session }: { session: Session }) {
  if (session.phase === "closed")
    return session.outcome?.kind === "published" ? (
      <span className="browser-badge-icon">
        <Badge status="completed">
          <Icon name="check" />
          已入库
        </Badge>
      </span>
    ) : (
      <Badge status="failed">未获取</Badge>
    );
  if (session.phase === "queued")
    return <Badge status="metadata">{statusLabels.queued}</Badge>;
  return (
    <Badge status="running">{phases[session.phase] ?? session.phase}</Badge>
  );
}
/**
 * Platform failures read “错误”; only the three problems a person can act on get a
 * name, and the code itself stays in the technical details. Non-failure reasons
 * (a person stopped the session, say) keep their own words.
 */
function reasonText(code: string, problem?: SourceProblem) {
  if (problem) return problemText(problem.display);
  const known = serviceMessage(code);
  if (code !== "error" && known !== serviceMessage("")) return known;
  return { user: "已由人工停止", cancelled: "已取消" }[code] ?? "错误";
}
const stopProblem = (session: Session) =>
  session.stop?.problem ?? session.outcome?.problem ?? null;
/** The Agent's own stop explanation, or the platform reason. */
function stopText(session: Session) {
  if (session.stop?.explanation) return session.stop.explanation;
  const code = session.stop?.reason ?? session.outcome?.code;
  return code ? reasonText(code, stopProblem(session) ?? undefined) : "";
}
interface SessionGroup {
  id: string;
  started: string | undefined;
  members: Session[];
}
/** Sessions of one acquisition task belong together; newest task first. */
function groupSessions(sessions: readonly Session[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const id = session.operation_id ?? session.session_id;
    const group = groups.get(id) ?? { id, started: undefined, members: [] };
    group.members.push(session);
    if (
      session.queued_at &&
      (!group.started || session.queued_at < group.started)
    )
      group.started = session.queued_at;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) =>
    (b.started ?? "").localeCompare(a.started ?? ""),
  );
}
/** Rule 6: the one way a time is written. */
const clock = (iso: string | undefined) => (iso ? shortTime(iso) : "");
function groupSummary(group: SessionGroup, active: boolean) {
  const count = (test: (s: Session) => boolean) =>
    group.members.filter(test).length;
  const closed = (s: Session) => s.phase === "closed";
  const parts = [
    clock(group.started) || "获取任务",
    `${group.members.length} 篇`,
  ];
  if (active) {
    parts.push(
      `${count((s) => !closed(s) && s.phase !== "queued")} 进行中`,
      `${count((s) => s.phase === "queued")} ${statusLabels.queued}`,
      `${count(closed)} 已结束`,
    );
  } else {
    parts.push(
      `已入库 ${count((s) => closed(s) && s.outcome?.kind === "published")}`,
      `未获取 ${count((s) => closed(s) && s.outcome?.kind !== "published")}`,
    );
  }
  return parts.join(" · ");
}
export default function Browser() {
  const api = useApi(),
    route = useUrlState();
  const [selected, setSelected] = useState<{
    session: string;
    article: string | null;
  } | null>(null);
  const view = useQuery({
    queryKey: ["browser", "view"],
    queryFn: ({ signal }) => api.refreshView(signal),
    initialData: api.view ?? undefined,
    refetchInterval: 5000,
    enabled: api.kind === "workspace",
  });
  const select = useCallback(
    async (session: string) => {
      if (api.view?.mode === "production")
        api.accept(
          (await api.request("/api/sessions/select", { session_id: session }))
            .view,
        );
      const current = api.view;
      if (!current || current.session_id !== session)
        throw new Error("会话已经变化，请刷新后重试。");
      setSelected({ session, article: current.article_id });
    },
    [api],
  );
  const requested = route.parameters.get("session"),
    article = route.parameters.get("article") ?? route.literature;
  const autoOpened = useRef<string | null>(null),
    [selectionError, setSelectionError] = useState("");
  useEffect(() => {
    const target =
      requested ??
      view.data?.sessions?.find((session) => session.article_id === article)
        ?.session_id;
    if (!target || autoOpened.current === target) return;
    autoOpened.current = target;
    void select(target).catch((error) =>
      setSelectionError(errorMessage(error)),
    );
  }, [article, requested, select, view.data?.sessions]);
  if (api.kind !== "workspace")
    return (
      <EmptyState
        title="此入口不提供浏览器会话"
        description="请使用完整 Web 工作台观看 Agent。"
      />
    );
  // Older single-session workbenches report no list; show their one article.
  const sessions: readonly Session[] =
    view.data?.sessions ??
    (view.data?.article_id
      ? [
          {
            session_id: view.data.session_id,
            article_id: view.data.article_id,
            generation: 0,
            phase: ended(view.data) ? "closed" : "ready",
          },
        ]
      : []);
  const groups = groupSessions(sessions);
  return (
    <TaskPage
      tab="web"
      className="browser-page"
      action={
        <Button
          onPress={async () => {
            await view.refetch();
          }}
        >
          刷新会话
        </Button>
      }
    >
      {view.isPending ? <Skeleton label="正在读取浏览器会话" /> : null}
      {view.isError ? (
        <ErrorNotice
          message={errorMessage(view.error)}
          onRetry={async () => {
            await view.refetch();
          }}
        />
      ) : null}
      {selectionError ? <ErrorNotice message={selectionError} /> : null}
      {groups.some((g) => g.members.some((m) => m.phase !== "closed")) ? (
        <section className="browser-section" aria-label="进行中">
          <h2>进行中</h2>
          {groups
            .filter((g) => g.members.some((m) => m.phase !== "closed"))
            .map((group) => (
              <div key={group.id} className="browser-group">
                <h3
                  title={group.started ? localTime(group.started) : undefined}
                >
                  {groupSummary(group, true)}
                </h3>
                <div className="browser-sessions">
                  {group.members
                    .filter((m) => m.phase !== "closed")
                    .map((session) => (
                      <div
                        key={session.session_id}
                        data-session={session.session_id}
                      >
                        <SessionCard
                          session={session}
                          onOpen={() => select(session.session_id)}
                        />
                      </div>
                    ))}
                </div>
              </div>
            ))}
        </section>
      ) : null}
      {groups.some((g) => g.members.some((m) => m.phase === "closed")) ? (
        <section className="browser-section" aria-label="已结束">
          <h2>已结束</h2>
          {groups
            .filter((g) => g.members.some((m) => m.phase === "closed"))
            .map((group) => (
              <Disclosure
                key={group.id}
                title={groupSummary(
                  {
                    ...group,
                    members: group.members.filter((m) => m.phase === "closed"),
                  },
                  false,
                )}
              >
                <ul className="browser-finished">
                  {group.members
                    .filter((m) => m.phase === "closed")
                    .map((session) => (
                      <FinishedRow
                        key={session.session_id}
                        session={session}
                        onOpen={() => select(session.session_id)}
                      />
                    ))}
                </ul>
              </Disclosure>
            ))}
        </section>
      ) : null}
      {!view.isPending && !sessions.length ? (
        <EmptyState title="没有正在使用的会话。获取任务进入浏览器阶段后，会话会显示在这里。" />
      ) : null}
      {selected && view.data ? (
        <Viewer
          key={selected.session}
          sessionId={selected.session}
          articleId={selected.article}
          view={view.data}
          onClose={() => setSelected(null)}
        />
      ) : null}
      <PageNote>
        只显示当前服务持有的会话，服务重启后清空；更早的记录在任务页。点开会话可以看
        Agent 操作页面，直接点击画面即可操作，停手 10 秒后 Agent 继续。
      </PageNote>
    </TaskPage>
  );
}
function SessionCard({
  session,
  onOpen,
}: {
  session: Session;
  onOpen: () => Promise<void>;
}) {
  const title = useSessionTitle(session);
  return (
    <Card title={title}>
      <div className="browser-session-status">
        <PhaseBadge session={session} />
        <Button onPress={onOpen}>观看 Agent</Button>
      </div>
      <PriorAttempts session={session} />
      <TechDetails copyText={session.session_id}>
        <p>会话编号：{session.session_id}</p>
        <p>文献编号：{session.article_id}</p>
      </TechDetails>
    </Card>
  );
}
function FinishedRow({
  session,
  onOpen,
}: {
  session: Session;
  onOpen: () => Promise<void>;
}) {
  const title = useSessionTitle(session),
    reason = session.outcome?.kind === "published" ? "" : stopText(session);
  return (
    <li data-session={session.session_id}>
      <div className="browser-finished-main">
        <span className="browser-finished-title">{title}</span>
        <PhaseBadge session={session} />
        <Button variant="text" size="compact" onPress={onOpen}>
          查看
        </Button>
      </div>
      <PriorAttempts session={session} />
      {reason ? <p className="browser-finished-reason">{reason}</p> : null}
      {reason && !session.stop?.explanation ? (
        <ProblemDetails problem={stopProblem(session)} />
      ) : null}
    </li>
  );
}
/** Why this paper reached the Agent: the sources tried before it. */
function PriorAttempts({ session }: { session: Session }) {
  const attempts = session.prior_attempts?.filter(
    (attempt) => attempt.stage !== "browser",
  );
  if (!attempts?.length) return null;
  return (
    <p className="browser-prior" title={attemptsDetail(attempts)}>
      已尝试：{attemptsLine(attempts)} → 交给 Agent
    </p>
  );
}
/** Title from the session itself; older servers omit it, so read the literature. */
function useSessionTitle(session: Session) {
  const api = useApi();
  const detail = useQuery({
    queryKey: ["literature", session.article_id],
    queryFn: ({ signal }) => readLiterature(api, session.article_id, signal),
    enabled:
      !session.title &&
      (api.workspace.capabilities.library === true ||
        api.workspace.capabilities.query === true),
  });
  return plain(
    session.title ?? detail.data?.literature.metadata.title ?? "文献获取会话",
  );
}
function Viewer({
  sessionId,
  articleId,
  view,
  onClose,
}: {
  sessionId: string;
  articleId: string | null;
  view: WorkbenchView;
  onClose: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false),
    lock = useRef(false),
    [feedback, setFeedback] = useState("");
  const lastInput = useRef(0);
  const [guidance, setGuidance] = useState("");
  const stage = useRef<ScreencastStageHandle>(null),
    [cast, setCast] = useState<ScreencastState | null>(null);
  const bound = useCallback(() => {
    const current = api.view;
    if (
      !current ||
      current.session_id !== sessionId ||
      current.article_id !== articleId
    )
      throw new Error("当前文章或会话已经变化，旧画面已停止接受输入。");
    return current;
  }, [api, articleId, sessionId]);
  const mine = () =>
    api.view?.session_id === sessionId &&
    api.view.article_id === articleId &&
    api.view.control.controller_id === api.clientId;
  const active = view.session_id === sessionId && view.article_id === articleId;
  // The screencast answers first: its control state changes before the next view arrives.
  const human =
    cast?.control === "controlling" ||
    (active &&
      cast?.control !== "watching" &&
      view.control.controller_id === api.clientId);
  const observed = active ? view.observation : null;
  const current = view.sessions?.find((s) => s.session_id === sessionId);
  const actions: readonly WorkbenchActionRecord[] = active
    ? (view.actions ?? [])
    : [];
  const actionList = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = actionList.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [actions.length]);
  const control = useCallback(
    async (kind: string) => {
      const current = bound();
      const reply = await api.request("/api/control", {
        kind,
        control_epoch: current.control.epoch,
        ...(current.mode === "production"
          ? { session_id: sessionId, article_id: articleId }
          : {}),
      });
      api.accept(reply.view);
    },
    [api, articleId, bound, sessionId],
  );
  /**
   * Hands the page back: through the screencast when this window controls it there,
   * otherwise through the control endpoint (the Agent was paused without input).
   */
  const releaseControl = async () => {
    if (stage.current?.state.control === "controlling")
      await stage.current.release();
    else if (mine()) await control("release");
  };
  const stillMine = () =>
    stage.current?.state.control === "controlling" ||
    (stage.current?.state.control !== "watching" && mine());
  // The navigation guard is registered once; it reads the current hand-back functions.
  const handback = useRef({ releaseControl, stillMine });
  handback.current = { releaseControl, stillMine };
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const close = async () => {
    if (lock.current) return;
    await run(async () => {
      if (stillMine()) {
        setFeedback("正在交还控制权…");
        try {
          await releaseControl();
          if (stillMine()) throw new Error("交还未确认");
        } catch (error) {
          throw new Error(
            `交还未完成：${errorMessage(error)}。请重试，或保留页面。`,
            { cause: error },
          );
        }
      }
      onClose();
    });
  };
  useEffect(
    () =>
      registerNavigationGuard(async () => {
        if (lock.current) {
          setFeedback("页面操作正在确认，请稍后离开。");
          return false;
        }
        lock.current = true;
        setBusy(true);
        try {
          if (handback.current.stillMine()) {
            setFeedback("正在交还控制权…");
            await handback.current.releaseControl();
            if (handback.current.stillMine()) throw new Error("交还未确认");
          }
          onClose();
          return true;
        } catch (error) {
          setFeedback(
            `交还未完成：${errorMessage(error)}。请重试，或保留页面。`,
          );
          return false;
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }),
    [api, articleId, control, onClose, sessionId],
  );
  const input = async (
    action: OperatorInput,
    observation: WorkbenchObservation,
  ) =>
    run(async () => {
      lastInput.current = Date.now();
      bound();
      if (
        observation.session_id !== sessionId ||
        observation.article_id !== articleId
      )
        throw new Error("画面已经过期");
      if (!mine()) {
        await control("takeover");
      }
      const current = bound(),
        live = current.observation;
      if (
        !mine() ||
        !live ||
        live.page_id !== observation.page_id ||
        live.document_generation !== observation.document_generation ||
        live.observation_revision !== observation.observation_revision ||
        live.viewport_revision !== observation.viewport_revision
      )
        throw new Error("接手期间页面发生变化，请查看新画面后再次操作");
      const reply = await api.request("/api/action", {
        session_id: sessionId,
        page_id: observation.page_id,
        document_generation: observation.document_generation,
        observation_revision: observation.observation_revision,
        viewport_revision: observation.viewport_revision,
        control_epoch: current.control.epoch,
        request_id: randomId(),
        input: action,
      });
      api.accept(reply.view);
      setFeedback("页面操作已受理");
    });
  const tabs = useQuery({
    queryKey: ["browser", "tabs", sessionId],
    queryFn: async ({ signal }) => {
      bound();
      const value = await api.read("/api/tabs", signal);
      return (Array.isArray(value.tabs) ? value.tabs : []).filter(
        (
          tab,
        ): tab is { id: string; title: string; url: string; active: boolean } =>
          !!tab &&
          typeof tab === "object" &&
          typeof tab.id === "string" &&
          typeof tab.title === "string",
      );
    },
    // Production sessions do not expose a page list; only the synthetic
    // workbench serves /api/tabs.
    enabled: active && view.mode !== "production",
    refetchInterval: 2000,
  });
  // A finished flow keeps its last frame for review; input would be refused.
  const readOnly = ended(view) || current?.phase === "closed";
  // The screencast reports a takeover before the next view does.
  const otherController =
    cast?.control === "taken-over" ||
    (!human &&
      !!view.control.controller_id &&
      !view.control.controller_id.startsWith("agent-"));
  const status = !active
    ? "文章会话已切换"
    : otherController
      ? "另一个窗口正在操作"
      : current
        ? ""
        : (states[view.state] ?? view.state);
  // The Agent's pointer: its latest located action on the page now shown.
  const pointer = observed
    ? [...actions]
        .reverse()
        .find(
          (action) =>
            action.actor === "agent" &&
            action.point &&
            action.viewport &&
            (action.page_id === undefined ||
              action.page_id === observed.page_id) &&
            (action.document_generation === undefined ||
              action.document_generation === observed.document_generation),
        )
    : undefined;
  // Pressing the page pauses the Agent; it resumes after the person stops.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!human) {
      lastInput.current = 0;
      return;
    }
    if (!lastInput.current) lastInput.current = Date.now();
    // The clock stood still while someone else had control; restart it now.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [human]);
  const secondsLeft = Math.max(
    0,
    Math.ceil((lastInput.current + IDLE_RETURN_MS - now) / 1000),
  );
  useEffect(() => {
    if (
      human &&
      view.state !== "paused" &&
      lastInput.current &&
      now - lastInput.current >= IDLE_RETURN_MS &&
      !lock.current
    ) {
      lastInput.current = now;
      void run(releaseControl);
    }
  });
  return (
    <Dialog
      title="观看 Agent"
      isOpen
      onOpenChange={(open) => {
        if (!open) void close();
      }}
      isDismissable={!busy}
      className="browser-watch"
    >
      <div
        className="browser-watch-header"
        data-observation-revision={observed?.observation_revision}
      >
        {current ? <PhaseBadge session={current} /> : null}
        {human ? (
          <>
            <p className="browser-control-note" role="status">
              你在操作 · Agent 已暂停 · 停手 {secondsLeft} 秒后继续
            </p>
            <Button
              onPress={() =>
                run(async () => {
                  await releaseControl();
                  if (stillMine()) throw new Error("交还未确认");
                })
              }
            >
              现在继续
            </Button>
          </>
        ) : cast?.control === "returning" ? (
          <p className="browser-control-note" role="status">
            正在交还 Agent…
          </p>
        ) : cast?.control === "taken-over" ? (
          <p className="browser-control-note">另一个窗口正在操作</p>
        ) : status ? (
          <p className="browser-control-note">{status}</p>
        ) : null}
        <Button onPress={close} isDisabled={busy}>
          返回会话列表
        </Button>
      </div>
      <div className="browser-watch-layout">
        <div className="browser-stage">
          <h2 className="browser-document-title">
            {observed ? plain(observed.title) : "等待当前页面"}
          </h2>
          <p className="browser-address">
            {observed?.url ?? "等待当前会话页面"}
          </p>
          <div
            className="browser-page-tabs"
            role="group"
            aria-label="浏览器页面"
          >
            {tabs.data?.map((tab) => (
              <Button
                key={tab.id}
                size="compact"
                isDisabled={!human || busy || tab.active}
                onPress={() =>
                  run(async () => {
                    bound();
                    api.accept(
                      (
                        await api.request("/api/tabs/activate", {
                          page_id: tab.id,
                        })
                      ).view,
                    );
                    await tabs.refetch();
                  })
                }
              >
                {tab.title || tab.url}
              </Button>
            ))}
          </div>
          {tabs.isError ? (
            <p className="ui-description">页签列表暂不可用</p>
          ) : null}
          {!active ? (
            <ErrorNotice message="文章会话已经切换；旧画面已停止接受输入。" />
          ) : (
            <ScreencastStage
              ref={stage}
              sessionId={sessionId}
              readOnly={readOnly}
              onActivity={() => {
                lastInput.current = Date.now();
              }}
              onFeedback={setFeedback}
              onState={setCast}
            >
              {pointer && pointer.point && pointer.viewport ? (
                <div
                  className="browser-pointer"
                  aria-hidden="true"
                  style={{
                    left: `${(pointer.point.x / pointer.viewport.width) * 100}%`,
                    top: `${(pointer.point.y / pointer.viewport.height) * 100}%`,
                  }}
                >
                  <svg viewBox="0 0 16 20" width="16" height="20">
                    <path d="M1 1v15l4-4 3 7 3-1.4-3-6.6h6z" />
                  </svg>
                  {pointer.kind.startsWith("click") ? (
                    <span
                      key={pointer.seq}
                      className="browser-pointer-ripple"
                    />
                  ) : null}
                  <span className="browser-pointer-label">
                    {actionText(pointer)}
                  </span>
                </div>
              ) : null}
            </ScreencastStage>
          )}
          <p className="browser-feedback" role="status" aria-live="polite">
            {feedback}
          </p>
        </div>
        <aside className="browser-log" aria-label="动作记录">
          <h2>动作记录</h2>
          <p>
            {states[view.state] ?? view.state}
            {view.session_phase
              ? ` · ${phases[view.session_phase] ?? view.session_phase}`
              : ""}
            {observed?.capture_state === "CAPTURED" ? " · 已捕获候选 PDF" : ""}
          </p>
          {observed ? (
            <p className="ui-description">
              剩余 {observed.remaining.model_calls} 次模型调用 ·{" "}
              {Math.ceil(observed.remaining.deadline_ms / 1000)} 秒
            </p>
          ) : null}
          {actions.length ? (
            <ol className="browser-actions" ref={actionList}>
              {actions.map((action) => (
                <li key={action.seq} data-actor={action.actor}>
                  <time dateTime={action.at}>
                    {new Date(action.at).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                  <span className="browser-actor">{actors[action.actor]}</span>
                  <span>{actionText(action)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="ui-description">还没有动作。</p>
          )}
          {current?.phase === "closed" &&
          current.outcome?.kind !== "published" ? (
            <>
              <p className="browser-stop">
                流程停止：{stopText(current) || "没有获取到 PDF"}
              </p>
              {current.stop?.explanation ? null : (
                <ProblemDetails problem={stopProblem(current)} />
              )}
            </>
          ) : null}
          {view.session_outcome?.kind === "published" ? (
            <p>PDF 已入库</p>
          ) : null}
          {view.session_cleanup_failure ? (
            <>
              <ErrorNotice message="浏览器资源清理未完成" />
              <ProblemDetails problem={view.problem ?? null} />
            </>
          ) : null}
          <Disclosure title="更多操作">
            <div className="browser-controls">
              <Button
                isDisabled={busy || human || ended(view)}
                onPress={() =>
                  run(async () => {
                    lastInput.current = Date.now();
                    await control("takeover");
                  })
                }
              >
                暂停 Agent
              </Button>
              <Button
                isDisabled={busy || !human || ended(view)}
                onPress={() =>
                  run(() =>
                    control(view.state === "paused" ? "resume" : "pause"),
                  )
                }
              >
                {view.state === "paused" ? "继续会话" : "暂停会话"}
              </Button>
            </div>
            <p className="ui-description">
              页面上的链接与按钮（键盘可用，点击即操作页面）
            </p>
            <div className="browser-elements">
              {observed?.elements
                .filter((element) => !element.editable)
                .map((element) => (
                  <Button
                    key={element.element_id}
                    size="compact"
                    isDisabled={
                      busy ||
                      ended(view) ||
                      view.state === "paused" ||
                      otherController
                    }
                    onPress={() =>
                      input(
                        {
                          kind: "click-element",
                          element_id: element.element_id,
                          revision: observed.observation_revision,
                        },
                        observed,
                      )
                    }
                  >
                    {element.name || element.element_id}
                  </Button>
                ))}
            </div>
            <p className="browser-page-text">
              {observed?.text ?? "暂无可读页面"}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!guidance.trim()) return;
                void run(async () => {
                  api.accept(
                    (
                      await api.request("/api/guidance", {
                        guidance_id: randomId(),
                        session_id: sessionId,
                        article_id: articleId,
                        control_epoch: bound().control.epoch,
                        text: guidance,
                      })
                    ).view,
                  );
                  setGuidance("");
                  setFeedback("指导已提交");
                });
              }}
            >
              <TextArea
                label="给当前文章的指导"
                value={guidance}
                onChange={setGuidance}
                maxLength={4096}
              />
              <Button type="submit" isDisabled={!guidance.trim() || busy}>
                提交指导
              </Button>
            </form>
            <TechDetails>
              <pre>{JSON.stringify(view.guidance ?? [], null, 2)}</pre>
            </TechDetails>
            <Button
              variant="danger"
              isDisabled={busy || ended(view)}
              confirm={{
                title: "取消当前浏览器会话？",
                description: "该会话将停止；已经接纳的 PDF 会保留。",
                confirmLabel: "取消会话",
              }}
              onPress={() =>
                run(async () => {
                  if (!mine()) await control("takeover");
                  await control("cancel");
                })
              }
            >
              取消会话
            </Button>
          </Disclosure>
          <Disclosure title={`下载与接纳 · ${view.candidates.length}`}>
            {view.candidates.length ? (
              view.candidates.map((candidate) => (
                <Card
                  key={candidate.transfer_id}
                  title={candidateStatus(view, candidate)}
                >
                  <p>
                    {candidate.page_count} 页 ·{" "}
                    {Math.ceil(candidate.size_bytes / 1024)} KB
                  </p>
                  {view.mode !== "production" ? (
                    <div className="browser-controls">
                      {(
                        [
                          ["accept", "发布到当前文献"],
                          ["abandon", "放弃候选"],
                        ] as const
                      ).map(([action, label]) => (
                        <Button
                          key={action}
                          isDisabled={
                            busy ||
                            !human ||
                            !!candidate.publication ||
                            (action === "accept" &&
                              candidate.disposition !== "accepted")
                          }
                          onPress={() =>
                            run(async () => {
                              api.accept(
                                (
                                  await api.request(
                                    `/api/candidate/${action}`,
                                    {
                                      session_id: sessionId,
                                      control_epoch: bound().control.epoch,
                                      transfer_id: candidate.transfer_id,
                                      sha256: candidate.sha256,
                                    },
                                  )
                                ).view,
                              );
                            })
                          }
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <TechDetails copyText={candidate.sha256}>
                    <p>SHA-256 {candidate.sha256}</p>
                  </TechDetails>
                </Card>
              ))
            ) : (
              <p>尚无候选文件</p>
            )}
          </Disclosure>
        </aside>
      </div>
    </Dialog>
  );
}
