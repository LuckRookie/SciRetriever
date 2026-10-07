import { mountLibrary } from "./library.js";
import { mountJobs } from "./jobs.js";
import { mountConfiguration } from "./config.js";
import { record } from "./wire.js";
import { mountWorkspaceHistory } from "./navigation.js";
import { candidateStatus } from "./feedback.js";
import {
  parseWorkbenchView,
  parseConfigurationReadiness,
  type WorkbenchView,
  type WorkbenchObservation,
  type OperatorInput,
} from "@sciretriever/contracts";
function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("missing workbench element");
  return value as T;
}
let view: WorkbenchView | undefined;
let pendingArticleId: string | undefined;
let clientId = "",
  csrf = "",
  busy = false,
  loadingFrame = false;
let shown: WorkbenchObservation | undefined;
let frameUrl: string | undefined;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let stream: EventSource | undefined;
let tabsTimer: ReturnType<typeof setInterval> | undefined;
let openLibraryArticle: (id: string) => Promise<void> = async () => {};
interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly opener_id: string | null;
}
const image = node<HTMLImageElement>("browser-frame");
const labels: Record<WorkbenchView["state"], string> = {
  watching: "页面可观看",
  "agent-running": "Agent 正在观察与操作",
  "needs-assistance": "需要人工协助",
  paused: "会话已暂停",
  cancelled: "会话已取消，已保存候选仍可查看",
  finished: "页面操作已结束",
  failed: "会话未能继续",
};
const errors: Record<string, string> = {
  "stale-command": "页面或控制权已经变化。请查看最新画面后重试。",
  "session-busy": "页面正在更新。请稍后重试。",
  "session-closed": "会话已经结束。已保存的候选仍然保留。",
  "model-unavailable":
    "尚未配置可用的 Browser 模型。你仍可人工接管并获取文献。",
  "browser-failed": "暂时无法更新画面。保留最后一帧，等待页面恢复。",
  "command-rejected": "本次操作未被接受。请确认控制权和页面状态后重试。",
};
function feedback(message: string): void {
  node("feedback").textContent = message;
  node("feedback").hidden = false;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    node("feedback").hidden = true;
  }, 6000);
}
function mine(): boolean {
  return view?.control.controller_id === clientId;
}
function query(): string {
  return `?client_id=${encodeURIComponent(clientId)}`;
}
async function request(
  path: string,
  body: unknown,
  initial = false,
): Promise<Record<string, unknown>> {
  const response = await fetch(path + (initial ? "" : query()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(initial ? { "X-Workbench-Init": "1" } : { "X-Workbench-Csrf": csrf }),
    },
    body: JSON.stringify(body),
  });
  const result = await response
    .json()
    .then((value) => record(value, "workbench response"))
    .catch(() => ({ code: "invalid-response" }));
  if (result.code === "invalid-response") throw new Error("invalid-response");
  if (!response.ok)
    throw new Error(
      typeof result.code === "string" ? result.code : "command-rejected",
    );
  return result;
}
async function read(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${path}${path.includes("?") ? "&" : "?"}client_id=${encodeURIComponent(clientId)}`,
  );
  const result = await response
    .json()
    .then((value) => record(value, "workbench response"))
    .catch(() => ({ code: "invalid-response" }));
  if (result.code === "invalid-response") throw new Error("invalid-response");
  if (!response.ok)
    throw new Error(
      typeof result.code === "string" ? result.code : "command-rejected",
    );
  return result;
}
async function transact(
  operation: () => Promise<Record<string, unknown>>,
): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    const result = await operation();
    if (result.view) accept(result.view);
  } catch (error) {
    feedback(
      errors[error instanceof Error ? error.message : ""] ??
        "连接暂时中断。请等待重连后重试。",
    );
  } finally {
    busy = false;
    render();
  }
}
function accept(value: unknown): void {
  const next = parseWorkbenchView(value);
  if (
    next.session_id !== view?.session_id ||
    (next.sessions &&
      next.session_phase === undefined &&
      next.sessions.length > 1)
  ) {
    shown = undefined;
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = undefined;
    image.removeAttribute("src");
    node("frame-empty").hidden = false;
    node("element-actions").replaceChildren();
    node("candidates").replaceChildren();
  }
  if (next.mode === "production" && next.session_id !== view?.session_id) {
    pendingArticleId = next.article_id;
    node<HTMLInputElement>("acquisition-literature").value = next.article_id;
  }
  view = next;
  render();
  void loadFrame();
}
async function refreshTabs(): Promise<void> {
  if (!clientId) return;
  try {
    const result = await read("/api/tabs");
    const values = Array.isArray(result.tabs) ? result.tabs : [];
    const tabs = values.filter((value): value is BrowserTab => {
      if (!value || typeof value !== "object") return false;
      const tab = value as Record<string, unknown>;
      return (
        typeof tab.id === "string" &&
        typeof tab.url === "string" &&
        typeof tab.title === "string" &&
        typeof tab.active === "boolean" &&
        (typeof tab.opener_id === "string" || tab.opener_id === null)
      );
    });
    const root = node("browser-tabs");
    root.replaceChildren();
    if (!tabs.length) {
      root.textContent = "没有可用标签";
      return;
    }
    for (const tab of tabs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "live-tab";
      button.dataset.pageId = tab.id;
      button.disabled = tab.active || busy;
      button.setAttribute("aria-current", tab.active ? "page" : "false");
      button.textContent = tab.title || tab.url;
      button.title = tab.url;
      button.addEventListener("click", () => {
        void transact(async () => {
          const result = await request("/api/tabs/activate", {
            page_id: tab.id,
          });
          await refreshTabs();
          return result;
        });
      });
      root.append(button);
    }
  } catch {
    node("browser-tabs").textContent = "标签状态暂不可用";
  }
}
function control(kind: string): void {
  if (!view) return;
  void transact(() =>
    request("/api/control", {
      kind,
      control_epoch: view!.control.epoch,
      ...(view!.mode === "production"
        ? { session_id: view!.session_id, article_id: view!.article_id }
        : {}),
    }),
  );
}
function action(
  input: OperatorInput,
  observation: WorkbenchObservation | undefined,
): void {
  if (
    !view ||
    !observation ||
    observation.session_id !== view.session_id ||
    observation.article_id !== view.article_id ||
    !mine()
  ) {
    feedback("请先接管页面。");
    return;
  }
  const command = {
    session_id: observation.session_id,
    page_id: observation.page_id,
    document_generation: observation.document_generation,
    observation_revision: observation.observation_revision,
    viewport_revision: observation.viewport_revision,
    control_epoch: view.control.epoch,
    request_id: crypto.randomUUID(),
    input,
  };
  void transact(() => request("/api/action", command));
}
async function loadFrame(): Promise<void> {
  const observation = view?.observation;
  if (
    !observation ||
    !observation.frame_available ||
    (observation.session_id === shown?.session_id &&
      observation.page_id === shown?.page_id &&
      observation.frame_seq === shown?.frame_seq) ||
    loadingFrame ||
    busy
  )
    return;
  loadingFrame = true;
  let nextUrl: string | undefined;
  try {
    const response = await fetch(
      `/api/frame${query()}&session_id=${encodeURIComponent(observation.session_id)}&frame_seq=${observation.frame_seq}`,
    );
    if (!response.ok) return;
    nextUrl = URL.createObjectURL(await response.blob());
    const next = new Image();
    next.src = nextUrl;
    await next.decode();
    const current = view?.observation;
    if (
      !current ||
      current.session_id !== observation.session_id ||
      current.page_id !== observation.page_id ||
      current.frame_seq !== observation.frame_seq
    )
      return;
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = nextUrl;
    nextUrl = undefined;
    image.src = frameUrl;
    shown = observation;
    node("frame-empty").hidden = true;
    node("frame-time").textContent =
      `画面 ${new Date(observation.observed_at).toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch {
    node("frame-status").textContent = "等待下一帧";
  } finally {
    if (nextUrl) URL.revokeObjectURL(nextUrl);
    loadingFrame = false;
  }
}
function renderSessions(): void {
  let root = document.getElementById("browser-sessions");
  if (!root) {
    root = document.createElement("div");
    root.id = "browser-sessions";
    root.className = "live-tabs";
    root.setAttribute("aria-label", "文章会话");
    node("browser-tabs").before(root);
  }
  root.replaceChildren();
  root.hidden = !view?.sessions?.length;
  const phases = {
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
  for (const session of view?.sessions ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "live-tab";
    button.dataset.sessionId = session.session_id;
    const selected =
      view?.session_phase !== undefined &&
      session.session_id === view.session_id;
    button.disabled = busy || selected;
    button.setAttribute("aria-current", selected ? "page" : "false");
    button.textContent = `${session.article_id} · ${phases[session.phase]}`;
    button.addEventListener("click", () => {
      void transact(() =>
        request("/api/sessions/select", { session_id: session.session_id }),
      );
    });
    root.append(button);
  }
}
function render(): void {
  if (!view) return;
  const observation = view.observation;
  const production = view.mode === "production";
  renderSessions();
  if (production) {
    node("live-task-kind").textContent = "生产文献获取 · 由用户明确启动";
    node("live-task-title").textContent = view.article_id;
    node("live-task-detail").textContent = observation?.title || "等待获取操作";
    node("live-task-badge").textContent = "生产会话";
  }
  node("acquisition-form").hidden = !production;
  node("guidance-section").hidden = !production;
  const operation = view.operation_feedback;
  node("operation-feedback").hidden = !production || !operation;
  if (production && operation) {
    const phaseLabels = {
      idle: "等待你明确开始 PDF 获取。",
      acquiring: "正在执行已启动的获取操作；当前路线及总等待时间尚不可见。",
      browser:
        "文章会话已打开。推理、操作及页面反馈共用活跃时间预算；人工控制、排队和下载期间暂停计时。",
      settling: "页面流程已结束，正在结算候选与提交结果。",
      ended: "本次获取操作已结束。",
    };
    node("operation-phase").textContent = phaseLabels[operation.phase];
    const report = operation.report;
    const targets = operation.targets;
    node("operation-targets").textContent =
      targets.total === null
        ? operation.phase === "idle"
          ? "尚未冻结获取目标。"
          : "正在形成目标范围；实际目标数尚未确定。"
        : `冻结目标 ${targets.total}：当前 ${operation.current_target ?? "无运行中目标"}；运行中 ${targets.running}，未开始 ${targets.not_started}，已完成 ${targets.completed}，失败 ${targets.failed}，跳过 ${targets.skipped}，中断 ${targets.interrupted}。剩余未结算 ${targets.running + targets.not_started}。${report?.skipped.map((item) => item.reason).join("、") ?? ""}`;
    const failure = operation.failure;
    node("operation-failure").textContent = failure
      ? `${failure.code}：${failure.reason} ${failure.action}`
      : "";
    if (operation.primary_pdf_status === "unreadable")
      node("operation-failure").textContent +=
        " 已登记的主 PDF 文件未通过可读性校验；请检查已有资料。";
    node("operation-read").hidden = operation.primary_pdf === null;
    if (operation.primary_pdf)
      node("operation-phase").textContent +=
        ` Library 已保存主 PDF（文章身份未验证）：${operation.primary_pdf.sha256.slice(0, 16)}…（${(operation.primary_pdf.size_bytes / 1024).toFixed(1)} KB）。`;
  }
  node<HTMLButtonElement>("acquisition-start").disabled =
    busy ||
    !production ||
    view.state === "agent-running" ||
    (!!observation &&
      !["finished", "failed", "cancelled"].includes(view.state));
  const guidanceRoot = node("guidance-list");
  guidanceRoot.replaceChildren(
    ...(view.guidance ?? []).map((item) => {
      const line = document.createElement("p");
      const state = {
        accepted: "等待下次模型观察",
        consumed: "已交给模型",
        rejected: "未接纳",
        expired: "已过期",
        cancelled: "已撤销",
      }[item.state];
      line.textContent = `${item.text} · ${state}`;
      return line;
    }),
  );
  const terminal = ["cancelled", "finished", "failed"].includes(view.state);
  const canInput = mine() && !busy && !terminal && view.state !== "paused";
  image.dataset.control = String(canInput);
  const articlePhases = {
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
  const outcome = view.session_outcome;
  node("session-status").textContent =
    `${labels[view.state]}${view.session_phase ? ` · ${articlePhases[view.session_phase]}` : ""}${outcome?.kind === "published" ? " · PDF 已入库" : outcome?.kind === "retained" ? ` · 候选保留（${outcome.code}）` : ""}${view.session_cleanup_failure ? ` · 资源清理未完成（${view.session_cleanup_failure}）` : ""}`;
  node("owner").textContent = mine()
    ? "你正在控制页面"
    : view.control.controller_id
      ? view.control.controller_id.startsWith("agent-")
        ? "Agent 正在控制页面"
        : "另一个操作者正在控制"
      : "等待人工接管";
  node("owner-note").textContent =
    `${view.control.viewers} 个观看者 · 同一页面只有一个控制者`;
  node<HTMLButtonElement>("takeover").textContent = mine()
    ? "释放控制"
    : "人工接管";
  node<HTMLButtonElement>("takeover").disabled =
    busy || !observation || (terminal && !view.candidates.length);
  node<HTMLButtonElement>("pause").textContent =
    view.state === "paused" ? "继续会话" : "暂停";
  node<HTMLButtonElement>("pause").disabled = !mine() || busy || terminal;
  node<HTMLButtonElement>("cancel").disabled =
    terminal ||
    busy ||
    (production
      ? observation
        ? !mine()
        : view.state !== "agent-running"
      : !mine());
  node<HTMLButtonElement>("agent").disabled = production || !canInput;
  node("agent").textContent = production
    ? "自动流程中"
    : view.model_ready
      ? "让 Agent 执行一步"
      : "模型未配置";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".live-key-buttons button, #text-form button",
  ))
    button.disabled = !canInput;
  node("candidate-count").textContent = String(view.candidates.length);
  node("mobile-count").textContent = String(view.candidates.length);
  const candidateRoot = node("candidates");
  if (view.candidates.length) {
    if (!candidateRoot.querySelector("[data-transfer-id]"))
      candidateRoot.replaceChildren();
    const existingCandidates = new Map(
      [
        ...candidateRoot.querySelectorAll<HTMLDivElement>("[data-transfer-id]"),
      ].map((item) => [item.dataset.transferId, item]),
    );
    for (const candidate of view.candidates) {
      let item = existingCandidates.get(candidate.transfer_id);
      if (!item) {
        item = document.createElement("div");
        item.className = "live-candidate";
        item.dataset.transferId = candidate.transfer_id;
        const title = document.createElement("strong");
        const detail = document.createElement("p");
        const hash = document.createElement("p");
        const actions = document.createElement("div");
        actions.className = "live-candidate-actions";
        const acceptButton = document.createElement("button");
        acceptButton.dataset.action = "accept";
        acceptButton.addEventListener("click", () => {
          if (!view || !mine()) return;
          const command = {
            session_id: view.session_id,
            control_epoch: view.control.epoch,
            transfer_id: candidate.transfer_id,
            sha256: candidate.sha256,
          };
          void transact(async () => {
            const result = await request("/api/candidate/accept", command);
            feedback("PDF 已发布到当前文献，可从文献数据库继续处理。");
            return result;
          });
        });
        const abandonButton = document.createElement("button");
        abandonButton.dataset.action = "abandon";
        abandonButton.textContent = "放弃候选";
        abandonButton.addEventListener("click", () => {
          if (!view || !mine()) return;
          const command = {
            session_id: view.session_id,
            control_epoch: view.control.epoch,
            transfer_id: candidate.transfer_id,
            sha256: candidate.sha256,
          };
          void transact(async () => {
            const result = await request("/api/candidate/abandon", command);
            feedback("候选已放弃，未被其它事实使用的临时字节已回收。");
            return result;
          });
        });
        actions.append(acceptButton, abandonButton);
        item.append(title, detail, hash, actions);
        candidateRoot.append(item);
      }
      const title = item.querySelector("strong")!;
      title.textContent = candidateStatus(view, candidate);
      const [detail, hash] = item.querySelectorAll("p");
      detail!.textContent = `PDF · ${candidate.page_count} 页 · ${(candidate.size_bytes / 1024).toFixed(1)} KB`;
      hash!.textContent = `SHA256 ${candidate.sha256.slice(0, 16)}…`;
      const acceptButton = item.querySelector<HTMLButtonElement>(
        '[data-action="accept"]',
      )!;
      acceptButton.textContent = candidate.publication
        ? "已入库"
        : production
          ? "由获取操作验收"
          : "发布到当前文献";
      acceptButton.disabled =
        production ||
        !!candidate.publication ||
        candidate.disposition !== "accepted" ||
        busy ||
        !mine();
      const abandonButton = item.querySelector<HTMLButtonElement>(
        '[data-action="abandon"]',
      )!;
      abandonButton.disabled =
        production || !!candidate.publication || busy || !mine();
    }
  }
  if (!observation) {
    node("budget").textContent =
      production && operation?.phase !== "idle"
        ? "选定文章的活跃时间预算尚不可读。"
        : "";
    return;
  }
  node("page-title").textContent = observation.title;
  node("page-url").textContent = observation.url;
  node("frame-status").textContent =
    view.error === "browser-failed"
      ? "画面暂未更新"
      : view.state === "paused"
        ? "会话暂停"
        : "真实浏览器";
  node("budget").textContent =
    `本篇 Agent 剩余 ${observation.remaining.model_calls} 次模型调用 · ${observation.remaining.actions} 次动作 · ${Math.ceil(observation.remaining.deadline_ms / 1000)} 秒活跃时间。`;
  node("observation-info").textContent =
    `观察 ${observation.observation_revision} · ${observation.loading ? "页面加载中" : "页面已加载"}${observation.partial ? " · 摘要已截断" : ""}${
      observation.capture_state === "CANDIDATE"
        ? " · 正在接收候选 PDF"
        : observation.capture_state === "CAPTURED"
          ? " · 已捕获候选 PDF"
          : ""
    }`;
  node("page-text").textContent = observation.text;
  const actions = node("element-actions");
  const existing = new Map(
    [...actions.querySelectorAll<HTMLButtonElement>("button")].map((button) => [
      button.dataset.elementId,
      button,
    ]),
  );
  const retained = new Set<string>();
  for (const element of observation.elements
    .filter((e) => !e.editable)
    .slice(0, 12)) {
    retained.add(element.element_id);
    let button = existing.get(element.element_id);
    if (!button) {
      button = document.createElement("button");
      button.dataset.elementId = element.element_id;
      button.addEventListener("click", () => {
        const current = view?.observation;
        if (current)
          action(
            {
              kind: "click-element",
              element_id: element.element_id,
              revision: current.observation_revision,
            },
            current,
          );
      });
      actions.append(button);
    }
    button.textContent = element.name || element.role;
    button.disabled = !canInput;
  }
  for (const [id, button] of existing)
    if (!id || !retained.has(id)) button.remove();
  const select = node<HTMLSelectElement>("text-target");
  if (document.activeElement !== select) {
    const name = select.selectedOptions[0]?.textContent;
    select.replaceChildren(
      ...observation.elements
        .filter((element) => element.editable)
        .map((element) => {
          const option = document.createElement("option");
          option.value = element.element_id;
          option.textContent = element.name || "页面输入框";
          option.selected = option.textContent === name;
          return option;
        }),
    );
  }
  select.disabled = !canInput || !select.options.length;
  node<HTMLInputElement>("operator-text").disabled = select.disabled;
}
node("takeover").addEventListener("click", () =>
  control(mine() ? "release" : "takeover"),
);
node("acquisition-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const articleId = pendingArticleId?.trim();
  if (!articleId) return;
  void transact(() =>
    request("/api/acquisition/start", { article_id: articleId }),
  );
});
node("acquisition-literature").addEventListener("input", () => {
  pendingArticleId = node<HTMLInputElement>("acquisition-literature").value;
});
node("operation-read").addEventListener("click", () => {
  if (view?.operation_feedback?.primary_pdf)
    void openLibraryArticle(view.article_id);
});
node("guidance-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!view) return;
  const input = node<HTMLInputElement>("guidance-text");
  const text = input.value.trim();
  if (!text) return;
  void transact(async () => {
    const result = await request("/api/guidance", {
      guidance_id: crypto.randomUUID(),
      session_id: view!.session_id,
      article_id: view!.article_id,
      control_epoch: view!.control.epoch,
      text,
    });
    input.value = "";
    return result;
  });
});
node("pause").addEventListener("click", () =>
  control(view?.state === "paused" ? "resume" : "pause"),
);
node("cancel").addEventListener("click", () => control("cancel"));
node("agent").addEventListener("click", () => {
  if (!view?.model_ready) feedback(errors["model-unavailable"]!);
  else control("agent-step");
});
node("back").addEventListener("click", () => {
  const o = view?.observation;
  if (o) action({ kind: "go-back", revision: o.observation_revision }, o);
});
image.addEventListener("click", (event) => {
  if (!shown) return;
  const bounds = image.getBoundingClientRect();
  action(
    {
      kind: "click-point",
      x: ((event.clientX - bounds.left) * shown.viewport.width) / bounds.width,
      y: ((event.clientY - bounds.top) * shown.viewport.height) / bounds.height,
      revision: shown.observation_revision,
      viewport_version: shown.viewport_revision,
    },
    shown,
  );
});
image.addEventListener(
  "wheel",
  (event) => {
    if (!mine() || !shown) return;
    event.preventDefault();
    action(
      {
        kind: "scroll-surface",
        delta_x: Math.max(-2000, Math.min(2000, event.deltaX)),
        delta_y: Math.max(-2000, Math.min(2000, event.deltaY)),
        revision: shown.observation_revision,
      },
      shown,
    );
  },
  { passive: false },
);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-key]"))
  button.addEventListener("click", () => {
    const key = button.dataset.key;
    const o = view?.observation;
    if (o && (key === "Tab" || key === "Enter" || key === "Escape"))
      action({ kind: "press-key", key, revision: o.observation_revision }, o);
  });
node("text-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const o = view?.observation;
  const input = node<HTMLInputElement>("operator-text");
  if (!o || !input.value) return;
  action(
    {
      kind: "type-text",
      element_id: node<HTMLSelectElement>("text-target").value,
      text: input.value,
      revision: o.observation_revision,
    },
    o,
  );
  input.value = "";
});
function drawer(open: boolean): void {
  node("live-details").dataset.open = String(open);
  node("details-backdrop").hidden = !open;
  node("open-details").setAttribute("aria-expanded", String(open));
  node("live-details").setAttribute("role", open ? "dialog" : "complementary");
  if (open) node("live-details").setAttribute("aria-modal", "true");
  else node("live-details").removeAttribute("aria-modal");
  node(open ? "close-details" : "open-details").focus();
}
node("open-details").addEventListener("click", () => drawer(true));
node("close-details").addEventListener("click", () => drawer(false));
node("details-backdrop").addEventListener("click", () => drawer(false));
document.addEventListener("keydown", (event) => {
  if (node("live-details").dataset.open !== "true") return;
  if (event.key === "Escape") {
    event.preventDefault();
    drawer(false);
  }
  if (event.key === "Tab") {
    const focusable = [
      ...node("live-details").querySelectorAll<HTMLElement>(
        "button:not(:disabled),input:not(:disabled),select:not(:disabled),summary",
      ),
    ].filter((element) => element.getClientRects().length);
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});
async function connect(): Promise<void> {
  const grant = await request("/api/clients", {}, true);
  if (typeof grant.client_id !== "string" || typeof grant.csrf !== "string")
    throw new Error("invalid grant");
  clientId = grant.client_id;
  csrf = grant.csrf;
  accept(grant.view);
  void request("/api/configuration/status", {})
    .then((result) => {
      const status = parseConfigurationReadiness(result.status);
      const ready = status.items.filter(
        (item) => item.state === "ready",
      ).length;
      const blocked = status.items.filter(
        (item) => item.state === "blocked" || item.state === "unavailable",
      ).length;
      node("config-status").textContent = blocked
        ? `配置 ${ready}/${status.items.length} 就绪 · ${blocked} 项需处理`
        : `配置 ${ready}/${status.items.length} 就绪`;
    })
    .catch(() => {
      node("config-status").textContent = "配置状态不可用";
    });
  openLibraryArticle = mountLibrary({
    request,
    currentArticle: () => view?.article_id,
    selectArticle: async (id) => {
      if (!view) throw new Error("workbench unavailable");
      if (view.mode === "production") {
        pendingArticleId = id;
        node<HTMLInputElement>("acquisition-literature").value = id;
        feedback("已选中文献。点击“获取这篇文献的 PDF”后才会启动获取。");
        return;
      }
      if (!mine()) {
        const takeover = await request("/api/control", {
          kind: "takeover",
          control_epoch: view.control.epoch,
        });
        if (takeover.view) accept(takeover.view);
      }
      if (!view || !mine()) throw new Error("control unavailable");
      const result = await request("/api/target", {
        article_id: id,
        control_epoch: view.control.epoch,
      });
      if (result.view) accept(result.view);
    },
    bibliography: async (id, format) => {
      const response = await fetch(`/api/library/bibliography${query()}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workbench-Csrf": csrf,
        },
        body: JSON.stringify({ literature_id: id, format }),
      });
      if (!response.ok) throw new Error("bibliography download failed");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}.${format === "bibtex" ? "bib" : "ris"}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    download: async (id, kind) => {
      const response = await fetch(`/api/library/artifact${query()}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workbench-Csrf": csrf,
        },
        body: JSON.stringify({ literature_id: id, kind }),
      });
      if (!response.ok) throw new Error("artifact download failed");
      const blob = await response.blob(),
        url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}.${kind === "primary-pdf" ? "pdf" : "md"}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
  }).openArticle;
  node<HTMLFormElement>("manual-pdf-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const file = node<HTMLInputElement>("manual-pdf-file").files?.[0];
      const id = node<HTMLInputElement>(
        "manual-pdf-literature-id",
      ).value.trim();
      const status = node("manual-pdf-status");
      if (!file || !id) return;
      if (file.size < 1 || file.size > 16 * 1024 * 1024) {
        status.textContent = "文件必须为不超过 16 MiB 的非空 PDF。";
        return;
      }
      status.textContent = "正在检查并接纳 PDF…";
      void fetch(`/api/v1/maintenance/ingest-pdf${query()}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "X-Workbench-Csrf": csrf,
          "X-Sciretriever-Protocol-Version": "1",
          "X-Literature-Id": id,
        },
        body: file,
      })
        .then(async (response) => {
          const value = record(await response.json(), "PDF 接纳响应");
          if (!response.ok) throw new Error(String(value.code ?? "接纳失败"));
          status.textContent = "PDF 已接纳。文献资料可刷新查看。";
        })
        .catch((error: unknown) => {
          status.textContent = `PDF 未接纳：${error instanceof Error ? error.message : "未知错误"}`;
        });
    },
  );
  mountJobs({ read, request });
  mountConfiguration({ read, request });
  mountWorkspaceHistory();
  await refreshTabs();
  tabsTimer = setInterval(() => void refreshTabs(), 1000);
  stream = new EventSource(`/api/events${query()}`);
  stream.addEventListener("view", (event: MessageEvent<string>) => {
    try {
      accept(JSON.parse(event.data));
      node("connection").textContent = "本地连接正常";
    } catch {
      feedback("会话数据暂不可用，请刷新重试。");
    }
  });
  stream.onerror = () => {
    node("connection").textContent = "连接中断，正在重连";
  };
}
window.addEventListener("pagehide", () => {
  stream?.close();
  if (tabsTimer) clearInterval(tabsTimer);
  if (frameUrl) URL.revokeObjectURL(frameUrl);
});
void connect().catch(() => {
  node("connection").textContent = "连接失败";
  feedback("无法连接本地工作台，请确认服务运行后刷新页面。");
});
