import {
  canPublish,
  completeDemoCapture,
  createDemoState,
  hasCandidate,
  type DemoPhase,
} from "./demo.js";
import { renderIcons } from "./icons.js";

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error("workbench element is missing");
  return result;
}

let state = createDemoState();
let captureTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let detailsOpen = false;

const statusLabels: Record<DemoPhase, string> = {
  idle: "示例页面已就绪",
  running: "正在演示 PDF 获取…",
  paused: "演示已暂停",
  ready: "候选已就绪，等待确认",
  uncertain: "候选已保留，身份待确认",
  blocked: "示例请求被网络策略拒绝",
  published: "演示入库完成",
  cancelled: "会话已取消",
};

function stopCapture(): void {
  generation += 1;
  if (captureTimer !== undefined) clearTimeout(captureTimer);
  captureTimer = undefined;
}

function toast(message: string): void {
  const node = element("#toast");
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.add("visible");
  toastTimer = setTimeout(() => node.classList.remove("visible"), 4500);
}

function event(label: string): void {
  const seconds = String(state.events.length + 1).padStart(2, "0");
  state.events.push({ label, time: `00:${seconds}` });
  // The fixture keeps only a short presentation history, never a durable log.
  if (state.events.length > 10) state.events.shift();
}

function update(): void {
  const candidate = hasCandidate(state.phase);
  const finished = state.phase === "published";
  const cancelled = state.phase === "cancelled";
  const running = state.phase === "running";
  const uncertain = state.phase === "uncertain";
  element("#candidate-empty").hidden = candidate;
  element("#candidate-result").hidden = !candidate;
  element("#candidate-count").textContent = candidate ? "1" : "0";
  element("#library-count").textContent = finished ? "1" : "0";
  element("#view-caption").textContent = statusLabels[state.phase];
  element("#screen-status").textContent = cancelled ? "已结束" : "模拟画面";
  element("#mobile-detail-state").textContent = candidate
    ? uncertain
      ? "待确认 · 1"
      : "候选 · 1"
    : running
      ? "获取中"
      : "等待获取";
  element("#observation-revision").textContent =
    `观察 ${String(state.revision).padStart(2, "0")}`;
  element("#owner-title").textContent = cancelled
    ? "会话已结束"
    : state.operator
      ? "你正在控制页面"
      : running
        ? "正在演示自动获取"
        : finished
          ? "本次演示已完成"
          : "等待你的操作";
  element("#owner-description").textContent = state.operator
    ? "可操作示例页面中的 View PDF"
    : state.phase === "paused"
      ? "继续演示，或人工接管"
      : "接管页面，或演示自动获取";
  element("#takeover-label").textContent = state.operator
    ? "释放控制"
    : "人工接管";
  element<HTMLButtonElement>("#takeover-button").disabled =
    cancelled || finished;
  element<HTMLButtonElement>("#pause-button").disabled = !running;
  element<HTMLButtonElement>("#pdf-button").disabled =
    !state.operator || candidate || cancelled || running;
  element<HTMLButtonElement>("#run-button").disabled =
    running || candidate || cancelled || state.operator;
  element("#run-label").textContent = running
    ? "获取中…"
    : state.phase === "paused"
      ? "继续演示"
      : state.phase === "blocked"
        ? "重试获取"
        : "演示获取";
  element<HTMLButtonElement>("#cancel-button").disabled = cancelled || finished;
  element("#takeover-button").setAttribute(
    "aria-pressed",
    String(state.operator),
  );
  element("#verdict-banner").classList.toggle("uncertain", uncertain);
  element("#verdict-text").textContent = uncertain
    ? "版本证据不足，需要确认"
    : finished
      ? "演示入库完成"
      : "身份与版本匹配";
  element("#version-evidence").textContent = uncertain
    ? "缺少版本依据"
    : "发表版本";
  element("#candidate-explanation").textContent = uncertain
    ? "文章标题一致，但无法确认版本。候选暂留本次演示中，请补充依据后再入库，或放弃候选。"
    : finished
      ? "已展示入库后的状态。此操作仅改变样本界面，没有写入实际文献库。"
      : "示例证据已匹配。你可以预览确认入库后的界面。";
  const publish = element<HTMLButtonElement>("#publish-button");
  publish.disabled = !canPublish(state.phase);
  publish.textContent = finished
    ? "已收入示例文献库"
    : uncertain
      ? "等待身份与版本证据"
      : "确认入库（演示）";
  element<HTMLButtonElement>("#discard-button").disabled = finished;
  element("#step-capture").classList.toggle("complete", candidate);
  element("#step-capture").classList.toggle(
    "current",
    !candidate && !cancelled,
  );
  element("#step-verify").classList.toggle("current", candidate && !finished);
  element("#step-verify").classList.toggle("complete", finished);
  element("#observation-text").textContent =
    state.phase === "blocked"
      ? "示例目标地址未通过网络策略检查，尚未接收文件。可以切换其他样本场景后重试，或取消会话。"
      : uncertain
        ? "已获得示例 PDF。标题与目标匹配，但缺少版本证据，暂不允许正式发布。"
        : candidate
          ? "已获得示例 PDF，标题与版本证据匹配。等待你的确认，候选不会自动入库。"
          : running
            ? "正在演示从 PDF 入口获取候选。页面操作与文件接收进度会显示在会话动态中。"
            : cancelled
              ? "会话已取消，待执行的模拟操作已停止。点击重新演示，可从初始状态开始。"
              : "已定位文章详情页。页面包含标题、作者信息，以及一个可获取的 PDF 入口。";
  const timeline = element("#timeline");
  timeline.replaceChildren(
    ...state.events.slice(-4).map((entry) => {
      const item = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "event-dot";
      const label = document.createElement("span");
      label.textContent = entry.label;
      const time = document.createElement("time");
      time.textContent = entry.time;
      item.append(dot, label, time);
      return item;
    }),
  );
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-scenario]",
  )) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.scenario === state.scenario),
    );
  }
}

function capture(): void {
  if (
    state.phase === "running" ||
    hasCandidate(state.phase) ||
    state.phase === "cancelled"
  )
    return;
  stopCapture();
  const startedGeneration = generation;
  state.phase = "running";
  event(state.operator ? "人工点击示例 PDF 入口" : "开始演示受控 PDF 获取");
  update();
  captureTimer = setTimeout(() => {
    if (startedGeneration !== generation) return;
    completeDemoCapture(state);
    event(statusLabels[state.phase]);
    update();
    toast(
      state.phase === "blocked"
        ? "请求被拒绝，未生成候选。切换样本场景后可重试。"
        : state.phase === "uncertain"
          ? "候选已保留，但版本证据不足。请打开详情查看原因。"
          : "示例候选已就绪。查看证据后，你可以确认入库。",
    );
  }, 1000);
}

function setDetails(open: boolean): void {
  detailsOpen = open;
  element("#inspector").classList.toggle("open", open);
  element("#mobile-details-button").setAttribute("aria-expanded", String(open));
  if (window.matchMedia("(max-width: 700px)").matches) {
    element(open ? ".mobile-close" : "#mobile-details-button").focus();
  }
}

function reset(): void {
  stopCapture();
  state = createDemoState(state.scenario);
  element("#article-viewport").scrollTop = 0;
  update();
}

document.addEventListener("click", (click) => {
  if (!(click.target instanceof Element)) return;
  const button = click.target.closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  const scenario = button.dataset.scenario;
  if (
    scenario === "normal" ||
    scenario === "uncertain" ||
    scenario === "blocked"
  ) {
    stopCapture();
    state = createDemoState(scenario);
    setDetails(false);
    update();
    toast("已切换样本场景，点击「演示获取」体验结果。");
    return;
  }
  switch (button.dataset.action) {
    case "run":
      if (!state.operator) capture();
      break;
    case "capture":
      if (state.operator) capture();
      break;
    case "takeover":
      stopCapture();
      if (state.phase === "running") state.phase = "paused";
      state.operator = !state.operator;
      event(
        state.operator ? "你已接管页面，自动操作停止" : "你已释放页面控制权",
      );
      update();
      toast(
        state.operator
          ? "你已接管页面，可以点击画面中的 View PDF。"
          : "已释放控制权。点击演示获取可继续。",
      );
      break;
    case "pause":
      stopCapture();
      state.phase = "paused";
      event("获取演示已暂停");
      update();
      toast("演示已暂停，尚未完成的获取不会继续。");
      break;
    case "cancel":
      stopCapture();
      if (hasCandidate(state.phase)) {
        event("已停止页面操作，候选继续保留在本次演示中");
        toast("页面操作已停止，已有候选仍可确认或放弃。");
      } else {
        state.phase = "cancelled";
        event("会话已取消");
        toast("会话已取消。点击重新演示可再次开始。");
      }
      state.operator = false;
      update();
      break;
    case "publish":
      if (!canPublish(state.phase)) return;
      state.phase = "published";
      state.operator = false;
      event("已确认入库（仅演示状态）");
      update();
      toast("演示入库完成。没有写入真实数据库。");
      break;
    case "discard":
      if (!hasCandidate(state.phase) || state.phase === "published") return;
      state.phase = "idle";
      event("已放弃示例候选");
      update();
      toast("候选已从本次演示中移除，可以重新获取。");
      break;
    case "restart":
    case "reload":
      reset();
      toast("已重置本次演示。");
      break;
    case "details":
      setDetails(!detailsOpen);
      break;
    case "expand": {
      const expanded = element(".workspace").classList.toggle("expanded");
      button.setAttribute("aria-pressed", String(expanded));
      button.setAttribute(
        "aria-label",
        expanded ? "还原页面布局" : "展开页面画面",
      );
      break;
    }
    case "library":
      toast(
        state.phase === "published"
          ? "示例文献库中有 1 篇文献：Evidence-aware discovery of scientific literature。"
          : "示例文献库为空，确认候选后即可看到入库状态。",
      );
      break;
    case "help":
      element<HTMLDialogElement>("#help-dialog").showModal();
      break;
    case "close-help":
      element<HTMLDialogElement>("#help-dialog").close();
      break;
  }
});

document.addEventListener("keydown", (key) => {
  if (key.key === "Escape" && detailsOpen) setDetails(false);
});
window.addEventListener("pagehide", stopCapture);
renderIcons(document);
update();
