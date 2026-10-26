import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type OperatorInput,
  type WorkbenchObservation,
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
  PageHeader,
  PageNote,
  Select,
  Skeleton,
  TechDetails,
  TextArea,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { registerNavigationGuard, useUrlState } from "../../data/url.js";
import { errorMessage } from "../../strings.js";
import { randomId } from "../../../browser-platform.js";
import { candidateStatus } from "../../data/candidate-status.js";
import { readLiterature } from "../../data/library.js";
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
  queued: "等待执行",
  ready: "等待观察",
  deciding: "Agent 推理中",
  waiting: "等待页面或控制权",
  downloading: "下载中",
  validating: "验收文件中",
  "candidate-ready": "等待入库",
  closing: "结清资源中",
  closed: "已结束",
};
const ended = (view: WorkbenchView) =>
  ["finished", "failed", "cancelled"].includes(view.state);
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
  const sessions =
    view.data?.sessions ??
    (view.data?.article_id
      ? [
          {
            session_id: view.data.session_id,
            article_id: view.data.article_id,
            phase: view.data.state,
          },
        ]
      : []);
  return (
    <section className="browser-page">
      <PageHeader
        title="浏览器"
        action={
          <Button
            onPress={async () => {
              await view.refetch();
            }}
          >
            刷新会话
          </Button>
        }
      />
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
      <div className="browser-sessions">
        {sessions.map((session) => (
          <div key={session.session_id} data-session={session.session_id}>
            <SessionCard
              session={session}
              onOpen={() => select(session.session_id)}
            />
          </div>
        ))}
      </div>
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
        只显示当前服务持有的会话，其他进程的 Agent
        会话不会因共享文献库而出现在这里。需要帮助时，直接点击画面即可接手。
      </PageNote>
    </section>
  );
}
function SessionCard({
  session,
  onOpen,
}: {
  session: { session_id: string; article_id: string; phase: string };
  onOpen: () => Promise<void>;
}) {
  const api = useApi();
  const detail = useQuery({
    queryKey: ["literature", session.article_id],
    queryFn: ({ signal }) => readLiterature(api, session.article_id, signal),
    enabled:
      api.workspace.capabilities.library === true ||
      api.workspace.capabilities.query === true,
  });
  return (
    <Card title={detail.data?.literature.metadata.title ?? "文献获取会话"}>
      <div className="browser-session-status">
        <Badge status="running">
          {phases[session.phase] ?? states[session.phase] ?? session.phase}
        </Badge>
        <Button onPress={onOpen}>观看 Agent</Button>
      </div>
      <TechDetails copyText={session.session_id}>
        <p>会话编号：{session.session_id}</p>
        <p>文献编号：{session.article_id}</p>
      </TechDetails>
    </Card>
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
  const [logs, setLogs] = useState<string[]>([]),
    [text, setText] = useState(""),
    [target, setTarget] = useState(""),
    [guidance, setGuidance] = useState("");
  const [frame, setFrame] = useState<{
      url: string;
      observed: WorkbenchObservation;
    } | null>(null),
    frameUrl = useRef<string | null>(null),
    image = useRef<HTMLImageElement>(null);
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
  const human = active && view.control.controller_id === api.clientId;
  const observed = active ? view.observation : null;
  const log = (message: string) =>
    setLogs((items) => [
      ...items.slice(-99),
      `${new Date().toLocaleTimeString()} ${message}`,
    ]);
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
      if (mine()) {
        setFeedback("正在交还控制权…");
        try {
          await control("release");
          if (mine()) throw new Error("交还未确认");
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
          if (
            api.view?.session_id === sessionId &&
            api.view.article_id === articleId &&
            api.view.control.controller_id === api.clientId
          ) {
            setFeedback("正在交还控制权…");
            await control("release");
            if (api.view.control.controller_id === api.clientId)
              throw new Error("交还未确认");
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
  const frameData = useQuery({
    queryKey: [
      "browser",
      "frame",
      sessionId,
      observed?.frame_seq,
      observed?.page_id,
    ],
    queryFn: async ({ signal }) => {
      const observation = observed;
      if (!observation) throw new Error("尚无画面");
      const response = await api.fetch(
        `/api/frame?session_id=${encodeURIComponent(sessionId)}&frame_seq=${observation.frame_seq}`,
        { signal },
      );
      if (!response.ok) throw new Error("画面暂不可用");
      return { blob: await response.blob(), observation };
    },
    enabled: active && !!observed?.frame_available && !busy,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    const data = frameData.data;
    if (!data) return;
    let disposed = false;
    const url = URL.createObjectURL(data.blob),
      next = new Image();
    next.src = url;
    void next
      .decode()
      .then(() => {
        const latest = api.view?.observation;
        if (
          disposed ||
          latest?.session_id !== sessionId ||
          latest.page_id !== data.observation.page_id ||
          latest.frame_seq !== data.observation.frame_seq
        ) {
          URL.revokeObjectURL(url);
          return;
        }
        const old = frameUrl.current;
        frameUrl.current = url;
        setFrame({ url, observed: data.observation });
        if (old) URL.revokeObjectURL(old);
      })
      .catch((error) => {
        URL.revokeObjectURL(url);
        if (!disposed) setFeedback(`等待画面更新：${errorMessage(error)}`);
      });
    return () => {
      disposed = true;
      if (frameUrl.current !== url) URL.revokeObjectURL(url);
    };
  }, [api, frameData.data, sessionId]);
  useEffect(
    () => () => {
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = null;
    },
    [],
  );
  const input = async (
    action: OperatorInput,
    observation: WorkbenchObservation,
  ) =>
    run(async () => {
      bound();
      if (
        observation.session_id !== sessionId ||
        observation.article_id !== articleId
      )
        throw new Error("画面已经过期");
      if (!mine()) {
        await control("takeover");
        log("人工接手，Agent 后续旧决定已失效");
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
      log(`人工操作：${action.kind}`);
      if (action.kind === "type-text") setText("");
    });
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    const node = image.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!frame || api.view?.control.controller_id !== api.clientId) return;
      event.preventDefault();
      void inputRef.current(
        {
          kind: "scroll-surface",
          delta_x: Math.max(-2000, Math.min(2000, event.deltaX)),
          delta_y: Math.max(-2000, Math.min(2000, event.deltaY)),
          revision: frame.observed.observation_revision,
        },
        frame.observed,
      );
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [api, frame]);
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
    enabled: active,
    refetchInterval: 2000,
  });
  const editable =
      observed?.elements.filter((element) => element.editable) ?? [],
    selectedTarget = editable.some((element) => element.element_id === target)
      ? target
      : (editable[0]?.element_id ?? "");
  const status = !active
    ? "文章会话已切换"
    : human
      ? "你正在操作 · Agent 已暂停"
      : view.control.controller_id &&
          !view.control.controller_id.startsWith("agent-")
        ? "另一个操作者正在控制"
        : (states[view.state] ?? view.state);
  return (
    <Dialog
      title="Agent 操作界面"
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
        <Badge status={human ? "partial" : "running"}>{status}</Badge>
        {human ? (
          <Button
            onPress={() =>
              run(async () => {
                await control("release");
                if (mine()) throw new Error("交还未确认");
                log("已交还，Agent 将重新观察页面");
              })
            }
          >
            交还给 Agent
          </Button>
        ) : null}
        <Button onPress={close} isDisabled={busy}>
          返回会话列表
        </Button>
      </div>
      <div className="browser-watch-layout">
        <div className="browser-stage">
          <h2 className="browser-document-title">
            {observed?.title ?? "等待当前页面"}
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
            <p className="ui-description">标签状态暂不可用</p>
          ) : null}
          {!active ? (
            <ErrorNotice message="文章会话已经切换；旧画面已停止接受输入。" />
          ) : frame ? (
            <img
              ref={image}
              className="browser-frame"
              src={frame.url}
              alt="真实 Browser 页面"
              tabIndex={0}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect(),
                  observation = frame.observed;
                if (bounds.width && bounds.height)
                  void input(
                    {
                      kind: "click-point",
                      x:
                        ((event.clientX - bounds.left) *
                          observation.viewport.width) /
                        bounds.width,
                      y:
                        ((event.clientY - bounds.top) *
                          observation.viewport.height) /
                        bounds.height,
                      revision: observation.observation_revision,
                      viewport_version: observation.viewport_revision,
                    },
                    observation,
                  );
              }}
              onKeyDown={(event) => {
                if (human && ["Enter", "Tab", "Escape"].includes(event.key)) {
                  event.preventDefault();
                  void input(
                    {
                      kind: "press-key",
                      key: event.key as "Enter" | "Tab" | "Escape",
                      revision: frame.observed.observation_revision,
                    },
                    frame.observed,
                  );
                }
              }}
            />
          ) : (
            <Skeleton label="等待当前会话画面" />
          )}
          {frameData.isError ? (
            <ErrorNotice
              message="画面暂不可用"
              retained={frame ? "上次画面仍保留，点击时会再次核对版本。" : ""}
              onRetry={async () => {
                await frameData.refetch();
              }}
            />
          ) : null}
          <p className="browser-feedback" role="status" aria-live="polite">
            {feedback}
          </p>
          {human ? (
            <form
              className="browser-input"
              onSubmit={(event) => {
                event.preventDefault();
                if (frame && selectedTarget && text)
                  void input(
                    {
                      kind: "type-text",
                      element_id: selectedTarget,
                      text,
                      revision: frame.observed.observation_revision,
                    },
                    frame.observed,
                  );
              }}
            >
              <Select
                label="页面输入框"
                value={selectedTarget}
                onChange={setTarget}
                options={editable.map((element) => ({
                  value: element.element_id,
                  label: element.name || element.element_id,
                }))}
              />
              <TextField
                label="输入文字"
                value={text}
                onChange={setText}
                autoComplete="off"
              />
              <Button
                type="submit"
                isDisabled={busy || !selectedTarget || !text}
              >
                输入
              </Button>
              {(["Enter", "Tab", "Escape"] as const).map((key) => (
                <Button
                  key={key}
                  isDisabled={busy || !frame}
                  onPress={async () => {
                    if (frame)
                      await input(
                        {
                          kind: "press-key",
                          key,
                          revision: frame.observed.observation_revision,
                        },
                        frame.observed,
                      );
                  }}
                >
                  {key}
                </Button>
              ))}
            </form>
          ) : null}
        </div>
        <aside className="browser-log" aria-label="步骤与结果">
          <h2>步骤与结果</h2>
          {observed?.capture_state === "CAPTURED" ? (
            <p>已捕获候选 PDF</p>
          ) : null}
          <p>
            {states[view.state] ?? view.state}
            {view.session_phase
              ? ` · ${phases[view.session_phase] ?? view.session_phase}`
              : ""}
          </p>
          {view.session_outcome?.kind === "published" ? (
            <p>PDF 已入库</p>
          ) : view.session_outcome?.kind === "retained" ? (
            <p>
              候选已保留：{errorMessage(new Error(view.session_outcome.code))}
            </p>
          ) : null}
          {view.session_cleanup_failure ? (
            <ErrorNotice
              message={`资源清理未完成：${errorMessage(new Error(view.session_cleanup_failure))}`}
            />
          ) : null}
          {observed ? (
            <p className="ui-description">
              本篇 Agent 剩余 {observed.remaining.model_calls} 次模型调用 ·{" "}
              {Math.ceil(observed.remaining.deadline_ms / 1000)} 秒活跃时间
            </p>
          ) : null}
          <ol>
            {logs.map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ol>
          <Disclosure title="页面文字与可选指导">
            <div className="browser-controls">
              <Button
                isDisabled={
                  busy ||
                  human ||
                  !observed ||
                  (ended(view) && !view.candidates.length)
                }
                onPress={() => run(() => control("takeover"))}
              >
                人工接管
              </Button>
              <Button
                isDisabled={busy || !human || ended(view)}
                onPress={() =>
                  run(() =>
                    control(view.state === "paused" ? "resume" : "pause"),
                  )
                }
              >
                {view.state === "paused" ? "继续会话" : "暂停"}
              </Button>
              <Button
                variant="danger"
                isDisabled={busy || !human || ended(view)}
                confirm={{
                  title: "取消当前浏览器会话？",
                  description: "该会话将停止；已经接纳的 PDF 会保留。",
                  confirmLabel: "取消会话",
                }}
                onPress={() => run(() => control("cancel"))}
              >
                取消会话
              </Button>
            </div>
            <div className="browser-elements">
              {observed?.elements
                .filter((element) => !element.editable)
                .map((element) => (
                  <Button
                    key={element.element_id}
                    size="compact"
                    isDisabled={
                      busy || !human || ended(view) || view.state === "paused"
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
                  log("指导已提交，按当前会话状态确认消费");
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
