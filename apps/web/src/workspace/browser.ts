import type {
  WorkbenchView,
  WorkbenchObservation,
  OperatorInput,
} from "@sciretriever/contracts";
import { escape as e, node, click, message, button } from "./dom.js";
import { candidateStatus } from "../feedback.js";
import type { AppContext } from "./types.js";
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
let closeCurrent: (() => Promise<void>) | null = null;
export async function closeWatch(): Promise<void> {
  await closeCurrent?.();
}
export async function renderBrowser(ctx: AppContext): Promise<void> {
  ctx.root.innerHTML =
    '<div class="pg"><div class="pgin"><h1 class="ptitle">浏览器</h1><p class="pdesc">获取 PDF 时 Agent 操作的真实浏览器。点开会话可以观看；想帮忙时直接点画面。</p><div class="vtabs"><span class="vt on">当前会话</span><div class="vtools"><button class="btn q sm" id="browser-refresh">刷新</button></div></div><div class="gal" id="browser-sessions"></div><p class="f3">这里仅展示当前服务持有的会话。其他进程的 Agent 会话不会因共享文献库而自动出现在这里。</p></div></div>';
  const render = (view: WorkbenchView) => {
    if (ctx.signal.aborted) return;
    const sessions =
      view.sessions ??
      (view.article_id
        ? [
            {
              session_id: view.session_id,
              article_id: view.article_id,
              phase: view.state,
            },
          ]
        : []);
    const root = node("#browser-sessions", ctx.root);
    root.innerHTML =
      sessions
        .map(
          (s) =>
            `<button class="card" data-session="${e(s.session_id)}"><div class="thumb session-preview"><span class="tag blue">${e(phases[s.phase] ?? s.phase)}</span><span>打开真实页面</span></div><div class="cb"><span class="ct">${e(ctx.details.get(s.article_id)?.literature.metadata.title ?? s.article_id)}</span><span class="f2">${e(s.session_id)}</span></div></button>`,
        )
        .join("") ||
      '<div class="empty"><b>没有正在使用的会话</b><p>获取任务进入 Browser 阶段后，会话会显示在这里。</p></div>';
    click("[data-session]", (el) => openWatch(ctx, el.dataset.session!), root);
  };
  ctx.api.listeners.add(render);
  ctx.signal.addEventListener("abort", () => ctx.api.listeners.delete(render), {
    once: true,
  });
  click("#browser-refresh", () => ctx.api.refreshView(), ctx.root);
  await ctx.api.refreshView();
  if (ctx.api.view) render(ctx.api.view);
  const article = new URL(location.href).searchParams.get("literature");
  const selected = ctx.api.view?.sessions?.find(
    (s) => s.article_id === article,
  );
  if (selected) await openWatch(ctx, selected.session_id);
}
export async function openWatch(
  ctx: AppContext,
  sessionId: string,
): Promise<void> {
  await closeWatch();
  if (ctx.api.view?.mode === "production") {
    const selected = await ctx.api.request("/api/sessions/select", {
      session_id: sessionId,
    });
    ctx.api.accept(selected.view);
  }
  const initial = ctx.api.view;
  if (!initial || initial.session_id !== sessionId)
    throw new Error("会话已经变化，请刷新后重试");
  const articleId = initial.article_id;
  const overlay = node("#overlay");
  overlay.innerHTML = `<div class="watch" role="dialog" aria-label="Agent 操作界面"><div class="wh"><button class="btn q sm" id="watch-close" aria-label="返回">✕</button><div class="wt">${e(ctx.details.get(articleId ?? "")?.literature.metadata.title ?? articleId ?? "Browser")}</div><span class="tag blue" id="watch-control">${e(states[initial.state])}</span><button class="btn blue sm" id="watch-release" hidden>交还给 Agent</button></div><div class="wb"><div class="stage"><div class="frame" id="watch-frame"><div class="url" id="watch-url"></div><div id="watch-tabs" class="acts"></div><p id="watch-empty" class="empty">等待当前会话画面…</p><img id="browser-frame" alt="真实 Browser 页面" tabindex="0" hidden></div><form id="watch-input" class="browser-input" hidden><label>页面输入框<select id="watch-target" aria-label="页面输入框"></select></label><label>输入文字<input id="watch-text" autocomplete="off"></label><button class="btn sm" type="submit">输入</button><button class="btn q sm" type="button" data-key="Enter">Enter</button><button class="btn q sm" type="button" data-key="Tab">Tab</button><button class="btn q sm" type="button" data-key="Escape">Esc</button></form><p id="watch-feedback" role="status"></p></div><aside class="log"><b>步骤与结果</b><p id="watch-state"></p><p id="watch-budget"></p><p id="watch-observation"></p><ol id="watch-log"></ol><details class="tg"><summary>页面文字与可选指导</summary><div class="acts" id="watch-controls"><button class="btn sm" id="watch-takeover">人工接管</button><button class="btn sm" id="watch-pause">暂停</button><button class="btn sm" id="watch-cancel">取消会话</button></div><div id="watch-elements" class="acts"></div><pre id="watch-page-text"></pre><form id="watch-guidance"><textarea id="watch-guidance-text" maxlength="4096" placeholder="仅针对当前文章的指导"></textarea><button class="btn sm">提交指导</button></form><div id="watch-guidance-status"></div></details><details class="tg"><summary>下载与接纳 <span id="watch-candidate-count">0</span></summary><div id="watch-candidates"></div></details></aside></div></div>`;
  const image = node<HTMLImageElement>("#browser-frame", overlay),
    feedback = node("#watch-feedback", overlay),
    logs = node("#watch-log", overlay);
  let shown: WorkbenchObservation | null = null,
    frameUrl: string | null = null,
    loading = false,
    busy = false,
    disposed = false,
    lastState = "";
  const stop = new AbortController();
  const bound = (): WorkbenchView => {
    const view = ctx.api.view;
    if (!view || view.session_id !== sessionId || view.article_id !== articleId)
      throw new Error("当前文章或会话已经变化");
    return view;
  };
  const mine = () => ctx.api.view?.control.controller_id === ctx.api.clientId;
  const log = (text: string) => {
    const li = document.createElement("li");
    li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    logs.append(li);
    while (logs.children.length > 100) logs.firstChild?.remove();
  };
  const control = async (kind: string) => {
    const view = bound();
    const reply = await ctx.api.request("/api/control", {
      kind,
      control_epoch: view.control.epoch,
      ...(view.mode === "production"
        ? { session_id: sessionId, article_id: articleId }
        : {}),
    });
    ctx.api.accept(reply.view);
  };
  const cleanup = () => {
    clearInterval(tabTimer);
    window.removeEventListener("pagehide", cleanup);
    disposed = true;
    stop.abort();
    ctx.api.listeners.delete(render);
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = null;
    shown = null;
    overlay.replaceChildren();
    closeCurrent = null;
  };
  const close = async () => {
    if (busy) throw new Error("页面操作正在确认，请稍后关闭");
    if (disposed) return;
    try {
      if (mine()) {
        busy = true;
        feedback.textContent = "正在交还控制权…";
        await control("release");
        if (mine()) throw new Error("交还未确认");
      }
      cleanup();
    } catch (error) {
      feedback.textContent = `交还未完成：${message(error)}。请重试，或保留页面。`;
      throw error;
    } finally {
      busy = false;
      if (!disposed && ctx.api.view) render(ctx.api.view);
    }
  };
  closeCurrent = close;
  click("#watch-close", close, overlay);
  click(
    "#watch-release",
    async () => {
      if (busy) return;
      busy = true;
      try {
        await control("release");
        log("已交还，Agent 将重新观察页面");
      } finally {
        busy = false;
        if (!disposed && ctx.api.view) render(ctx.api.view);
      }
    },
    overlay,
  );
  for (const [selector, kind] of [
    ["#watch-takeover", "takeover"],
    ["#watch-pause", "pause"],
    ["#watch-cancel", "cancel"],
  ])
    click(
      selector!,
      async () => {
        if (busy) return;
        busy = true;
        try {
          await control(
            kind === "pause" && bound().state === "paused" ? "resume" : kind!,
          );
        } finally {
          busy = false;
        }
      },
      overlay,
    );
  const refreshTabs = async () => {
    if (disposed) return;
    try {
      bound();
      const response = await ctx.api.read("/api/tabs");
      if (disposed || ctx.api.view?.session_id !== sessionId) return;
      const host = node("#watch-tabs", overlay);
      host.replaceChildren();
      for (const raw of Array.isArray(response.tabs) ? response.tabs : []) {
        if (!raw || typeof raw !== "object") continue;
        const tab = raw as Record<string, unknown>;
        if (typeof tab.id !== "string" || typeof tab.title !== "string")
          continue;
        const item = button(tab.title || String(tab.url), async () => {
          if (busy || !mine()) return;
          busy = true;
          try {
            bound();
            const result = await ctx.api.request("/api/tabs/activate", {
              page_id: tab.id,
            });
            ctx.api.accept(result.view);
          } finally {
            busy = false;
          }
          await refreshTabs();
        });
        item.disabled = tab.active === true || !mine() || busy;
        host.append(item);
      }
    } catch {
      if (!disposed)
        node("#watch-tabs", overlay).textContent = "标签状态暂不可用";
    }
  };
  const tabTimer = setInterval(() => {
    void refreshTabs();
  }, 2000);
  void refreshTabs();
  const input = async (
    action: OperatorInput,
    observed: WorkbenchObservation,
  ) => {
    if (busy || disposed) return;
    busy = true;
    try {
      const before = bound();
      if (
        observed.session_id !== sessionId ||
        observed.article_id !== articleId
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
        live.page_id !== observed.page_id ||
        live.document_generation !== observed.document_generation ||
        live.observation_revision !== observed.observation_revision ||
        live.viewport_revision !== observed.viewport_revision
      )
        throw new Error("接手期间页面发生变化，请查看新画面后再次操作");
      if (before.session_id !== current.session_id)
        throw new Error("会话已变化");
      const reply = await ctx.api.request("/api/action", {
        session_id: sessionId,
        page_id: observed.page_id,
        document_generation: observed.document_generation,
        observation_revision: observed.observation_revision,
        viewport_revision: observed.viewport_revision,
        control_epoch: current.control.epoch,
        request_id: crypto.randomUUID(),
        input: action,
      });
      ctx.api.accept(reply.view);
      feedback.textContent = "页面操作已受理";
      log(`人工操作：${action.kind}`);
    } catch (error) {
      feedback.textContent = message(error);
      void ctx.api.refreshView().catch(() => {});
    } finally {
      busy = false;
      if (!disposed && ctx.api.view) render(ctx.api.view);
    }
  };
  image.onclick = (event) => {
    if (!shown) return;
    const bounds = image.getBoundingClientRect();
    const observation = shown;
    void input(
      {
        kind: "click-point",
        x:
          ((event.clientX - bounds.left) * observation.viewport.width) /
          bounds.width,
        y:
          ((event.clientY - bounds.top) * observation.viewport.height) /
          bounds.height,
        revision: observation.observation_revision,
        viewport_version: observation.viewport_revision,
      },
      observation,
    );
  };
  image.addEventListener(
    "wheel",
    (event) => {
      if (!shown || !mine()) return;
      event.preventDefault();
      void input(
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
  click(
    "[data-key]",
    async (el) => {
      if (shown)
        await input(
          {
            kind: "press-key",
            key: el.dataset.key as "Enter" | "Tab" | "Escape",
            revision: shown.observation_revision,
          },
          shown,
        );
    },
    overlay,
  );
  node<HTMLFormElement>("#watch-input", overlay).onsubmit = (event) => {
    event.preventDefault();
    const text = node<HTMLInputElement>("#watch-text", overlay),
      target = node<HTMLSelectElement>("#watch-target", overlay);
    if (shown && target.value && text.value) {
      void input(
        {
          kind: "type-text",
          element_id: target.value,
          text: text.value,
          revision: shown.observation_revision,
        },
        shown,
      );
      text.value = "";
    }
  };
  node<HTMLFormElement>("#watch-guidance", overlay).onsubmit = (event) => {
    event.preventDefault();
    const text = node<HTMLTextAreaElement>("#watch-guidance-text", overlay);
    if (!text.value.trim()) return;
    void ctx.api
      .request("/api/guidance", {
        guidance_id: crypto.randomUUID(),
        session_id: sessionId,
        article_id: articleId,
        control_epoch: bound().control.epoch,
        text: text.value,
      })
      .then((reply) => {
        if (reply.view) ctx.api.accept(reply.view);
        text.value = "";
        log("指导已提交，按当前会话状态确认消费");
      })
      .catch((error) => {
        feedback.textContent = message(error);
      });
  };
  const loadFrame = async (view: WorkbenchView) => {
    const observation = view.observation;
    if (
      !observation?.frame_available ||
      loading ||
      disposed ||
      busy ||
      observation.frame_seq === shown?.frame_seq
    )
      return;
    loading = true;
    let url: string | null = null;
    try {
      const response = await ctx.api.fetch(
        `/api/frame?session_id=${encodeURIComponent(sessionId)}&frame_seq=${observation.frame_seq}`,
        { signal: stop.signal },
      );
      if (!response.ok) throw new Error("画面暂不可用");
      url = URL.createObjectURL(await response.blob());
      const next = new Image();
      next.src = url;
      await next.decode();
      const latest = ctx.api.view?.observation;
      if (
        disposed ||
        latest?.session_id !== sessionId ||
        latest.page_id !== observation.page_id ||
        latest.frame_seq !== observation.frame_seq
      )
        return;
      if (frameUrl) URL.revokeObjectURL(frameUrl);
      frameUrl = url;
      url = null;
      shown = observation;
      image.src = frameUrl;
      image.hidden = false;
      node("#watch-empty", overlay).hidden = true;
    } catch (error) {
      if (!disposed) feedback.textContent = `等待画面更新：${message(error)}`;
    } finally {
      if (url) URL.revokeObjectURL(url);
      loading = false;
    }
  };
  const render = (view: WorkbenchView) => {
    if (disposed) return;
    if (view.session_id !== sessionId || view.article_id !== articleId) {
      feedback.textContent = "文章会话已经切换；旧画面已停止接受输入。";
      shown = null;
      image.hidden = true;
      return;
    }
    const human = mine();
    node("#watch-control", overlay).textContent = human
      ? "你正在操作 · Agent 已暂停"
      : view.control.controller_id &&
          !view.control.controller_id.startsWith("agent-")
        ? "另一个操作者正在控制"
        : (states[view.state] ?? view.state);
    node("#watch-release", overlay).hidden = !human;
    node("#watch-input", overlay).hidden = !human;
    node("#watch-url", overlay).textContent = view.observation?.url ?? "";
    const outcome = view.session_outcome;
    node("#watch-state", overlay).textContent =
      `${states[view.state] ?? view.state}${view.session_phase ? ` · ${phases[view.session_phase]}` : ""}${outcome?.kind === "published" ? " · PDF 已入库" : outcome?.kind === "retained" ? ` · 候选保留（${outcome.code}）` : ""}${view.session_cleanup_failure ? ` · 资源清理未完成（${view.session_cleanup_failure}）` : ""}`;
    node(".wt", overlay).textContent =
      view.observation?.title ?? articleId ?? "Browser";
    node("#watch-budget", overlay).textContent = view.observation
      ? `本篇 Agent 剩余 ${view.observation.remaining.model_calls} 次模型调用 · ${Math.ceil(view.observation.remaining.deadline_ms / 1000)} 秒活跃时间`
      : "";
    node("#watch-observation", overlay).textContent = view.observation
      ? `观察 ${view.observation.observation_revision} · ${view.observation.capture_state === "CAPTURED" ? "已捕获候选 PDF" : view.observation.capture_state}`
      : "";
    const terminal = ["finished", "failed", "cancelled"].includes(view.state);
    node<HTMLButtonElement>("#watch-takeover", overlay).disabled =
      busy ||
      human ||
      !view.observation ||
      (terminal && !view.candidates.length);
    node<HTMLButtonElement>("#watch-pause", overlay).disabled =
      busy || !human || terminal;
    node<HTMLButtonElement>("#watch-cancel", overlay).disabled =
      busy || !human || terminal;
    node("#watch-pause", overlay).textContent =
      view.state === "paused" ? "继续会话" : "暂停";
    const elements = node("#watch-elements", overlay);
    elements.replaceChildren();
    for (const element of view.observation?.elements.filter(
      (value) => !value.editable,
    ) ?? []) {
      const observed = view.observation!;
      const action = button(element.name || element.element_id, () =>
        input(
          {
            kind: "click-element",
            element_id: element.element_id,
            revision: observed.observation_revision,
          },
          observed,
        ),
      );
      action.disabled = busy || !human || terminal || view.state === "paused";
      elements.append(action);
    }
    node("#watch-page-text", overlay).textContent =
      view.observation?.text ?? "暂无可读页面";
    const state = `${view.state}:${view.session_phase ?? ""}:${view.observation?.page_state ?? ""}`;
    if (state !== lastState) {
      log(
        `${states[view.state] ?? view.state} ${view.session_phase ?? ""} ${view.observation?.page_state ?? ""}`,
      );
      lastState = state;
    }
    const target = node<HTMLSelectElement>("#watch-target", overlay);
    const selected = target.value;
    target.innerHTML = (view.observation?.elements ?? [])
      .filter((v) => v.editable)
      .map(
        (el) =>
          `<option value="${e(el.element_id)}">${e(el.name || el.element_id)}</option>`,
      )
      .join("");
    if ([...target.options].some((v) => v.value === selected))
      target.value = selected;
    node("#watch-guidance-status", overlay).innerHTML = (view.guidance ?? [])
      .map((g) => `<p>${e(JSON.stringify(g))}</p>`)
      .join("");
    node("#watch-candidate-count", overlay).textContent = String(
      view.candidates.length,
    );
    const candidates = node("#watch-candidates", overlay);
    candidates.replaceChildren();
    for (const candidate of view.candidates) {
      const card = document.createElement("div");
      card.className = "browser-candidate";
      card.innerHTML = `<b>${e(candidateStatus(view, candidate))}</b><p>${candidate.page_count} 页 · ${candidate.size_bytes} 字节</p><p class="code-id">SHA-256 ${e(candidate.sha256)}</p>`;
      if (view.mode !== "production")
        for (const [action, label] of [
          ["accept", "发布到当前文献"],
          ["abandon", "放弃候选"],
        ]) {
          const control = button(label!, async () => {
            if (busy || !mine()) return;
            busy = true;
            try {
              const current = bound();
              const response = await ctx.api.request(
                `/api/candidate/${action}`,
                {
                  session_id: sessionId,
                  control_epoch: current.control.epoch,
                  transfer_id: candidate.transfer_id,
                  sha256: candidate.sha256,
                },
              );
              ctx.api.accept(response.view);
            } finally {
              busy = false;
              render(bound());
            }
          });
          control.disabled =
            busy ||
            !human ||
            !!candidate.publication ||
            (action === "accept" && candidate.disposition !== "accepted");
          card.append(control);
        }
      candidates.append(card);
    }
    if (!view.candidates.length) candidates.textContent = "尚无候选文件";
    void loadFrame(view);
  };
  ctx.api.listeners.add(render);
  render(initial);
  window.addEventListener("pagehide", cleanup, { once: true });
}
