import { mountLibrary } from "./library.js";
import { mountJobs } from "./jobs.js";
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
let clientId = "",
  csrf = "",
  busy = false,
  loadingFrame = false;
let shown: WorkbenchObservation | undefined;
let frameUrl: string | undefined;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let stream: EventSource | undefined;
let tabsTimer: ReturnType<typeof setInterval> | undefined;
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
  const result = (await response.json()) as Record<string, unknown>;
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
  const result = (await response.json()) as Record<string, unknown>;
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
  view = parseWorkbenchView(value);
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
    request("/api/control", { kind, control_epoch: view!.control.epoch }),
  );
}
function action(
  input: OperatorInput,
  observation: WorkbenchObservation | undefined,
): void {
  if (!view || !observation || !mine()) {
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
    observation.frame_seq === shown?.frame_seq ||
    loadingFrame ||
    busy
  )
    return;
  loadingFrame = true;
  let nextUrl: string | undefined;
  try {
    const response = await fetch(
      `/api/frame${query()}&frame_seq=${observation.frame_seq}`,
    );
    if (!response.ok) return;
    nextUrl = URL.createObjectURL(await response.blob());
    const next = new Image();
    next.src = nextUrl;
    await next.decode();
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
function render(): void {
  if (!view) return;
  const observation = view.observation;
  const terminal = ["cancelled", "finished", "failed"].includes(view.state);
  const canInput = mine() && !busy && !terminal && view.state !== "paused";
  image.dataset.control = String(canInput);
  node("session-status").textContent = labels[view.state];
  node("owner").textContent = mine()
    ? "你正在控制页面"
    : view.control.controller_id
      ? "另一个操作者正在控制"
      : "等待人工接管";
  node("owner-note").textContent =
    `${view.control.viewers} 个观看者 · 同一页面只有一个控制者`;
  node<HTMLButtonElement>("takeover").textContent = mine()
    ? "释放控制"
    : "人工接管";
  node<HTMLButtonElement>("takeover").disabled =
    busy || (terminal && !view.candidates.length);
  node<HTMLButtonElement>("pause").textContent =
    view.state === "paused" ? "继续会话" : "暂停";
  node<HTMLButtonElement>("pause").disabled = !mine() || busy || terminal;
  node<HTMLButtonElement>("cancel").disabled = !mine() || terminal || busy;
  node<HTMLButtonElement>("agent").disabled = !canInput;
  node("agent").textContent = view.model_ready
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
      title.textContent = candidate.publication
        ? "已发布到当前文献"
        : candidate.disposition === "accepted"
          ? "身份与版本已核验"
          : "候选已保存，身份待确认";
      const [detail, hash] = item.querySelectorAll("p");
      detail!.textContent = `PDF · ${candidate.page_count} 页 · ${(candidate.size_bytes / 1024).toFixed(1)} KB`;
      hash!.textContent = `SHA256 ${candidate.sha256.slice(0, 16)}…`;
      const acceptButton = item.querySelector<HTMLButtonElement>(
        '[data-action="accept"]',
      )!;
      acceptButton.textContent = candidate.publication
        ? "已入库"
        : "发布到当前文献";
      acceptButton.disabled =
        !!candidate.publication ||
        candidate.disposition !== "accepted" ||
        busy ||
        !mine();
      const abandonButton = item.querySelector<HTMLButtonElement>(
        '[data-action="abandon"]',
      )!;
      abandonButton.disabled = !!candidate.publication || busy || !mine();
    }
  }
  if (!observation) return;
  node("page-title").textContent = observation.title;
  node("page-url").textContent = observation.url;
  node("frame-status").textContent =
    view.error === "browser-failed"
      ? "画面暂未更新"
      : view.state === "paused"
        ? "会话暂停"
        : "真实浏览器";
  node("budget").textContent =
    `剩余 ${observation.remaining.actions} 次操作 · ${Math.ceil(observation.remaining.deadline_ms / 60000)} 分钟`;
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
  mountLibrary({
    request,
    currentArticle: () => view?.article_id,
    selectArticle: async (id) => {
      if (!view) throw new Error("workbench unavailable");
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
  });
  mountJobs({ read, request });
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
