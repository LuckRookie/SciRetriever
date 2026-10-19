import { record, jobRecord, type JsonRecord } from "../wire.js";
import {
  parseTaskDetail,
  taskTitle,
  taskStatusLabel,
  taskLiteratureId,
  operationLabels,
} from "../task-view.js";
import {
  escape as e,
  node,
  click,
  button,
  failure,
  toast,
  message,
} from "./dom.js";
import type { AppContext } from "./types.js";
export async function taskList(
  ctx: AppContext,
  group = "",
  cursor: string | null = null,
): Promise<{ items: JsonRecord[]; cursor: string | null }> {
  const value = await ctx.api.read(
    `/api/tasks?limit=100${group ? `&status_group=${encodeURIComponent(group)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  if (!Array.isArray(value.tasks)) throw new Error("任务列表回执无效");
  return {
    items: value.tasks.map(jobRecord),
    cursor: typeof value.next_cursor === "string" ? value.next_cursor : null,
  };
}
export function taskBadge(job: JsonRecord): string {
  const status = String(job.status);
  return `<span class="tag ${status === "running" ? "blue run" : status === "completed" ? "green" : ["failed", "interrupted"].includes(status) ? "red" : "gray"}">${e(taskStatusLabel[status] ?? status)}</span>`;
}
const detailTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
export async function renderTasks(ctx: AppContext): Promise<void> {
  const linked = new URL(location.href).searchParams.get("task");
  let group = "",
    cursor: string | null = null,
    items: JsonRecord[] = [],
    loadedPages = 1;
  ctx.root.innerHTML =
    '<div class="libwrap"><div class="pg"><div class="pgin"><h1 class="ptitle">任务</h1><p class="pdesc">查看已明确启动的操作、结果与失败。已接纳的材料会保留在文献库。</p><div class="vtabs"><button class="vt on" data-filter="">全部</button><button class="vt" data-filter="active">进行中</button><button class="vt" data-filter="attention">待处理</button><button class="vt" data-filter="ended">已结束</button><div class="vtools"><button class="btn q sm" id="tasks-refresh">刷新</button></div></div><input id="tasks-search" aria-label="筛选任务" placeholder="按任务名称或 ID 筛选"><p id="tasks-status" role="status"></p><div class="tw" id="tasks-list"></div><button class="btn q sm" id="tasks-more" hidden>加载更多</button></div></div><div id="task-peek"></div></div>';
  const rows = node("#tasks-list", ctx.root);
  const paint = () => {
    rows.innerHTML = `<table class="nt"><thead><tr><th>任务</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${items
      .filter((job) =>
        `${taskTitle(job)} ${String(job.job_id)}`
          .toLocaleLowerCase()
          .includes(
            node<HTMLInputElement>(
              "#tasks-search",
              ctx.root,
            ).value.toLocaleLowerCase(),
          ),
      )
      .map(
        (job) =>
          `<tr class="r" data-task="${e(job.job_id)}" data-status="${e(job.status)}"><td><button class="lk">${e(taskTitle(job))}</button></td><td>${taskBadge(job)}</td><td class="mono f2">${e(job.created_at)}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table>${!items.length ? '<div class="empty">当前没有任务</div>' : ""}`;
    node("#tasks-more", ctx.root).hidden = !cursor;
    node("#tasks-status", ctx.root).textContent =
      `已显示 ${items.length} 个任务`;
    click("[data-task]", (el) => showTask(ctx, el.dataset.task!), rows);
  };
  node<HTMLInputElement>("#tasks-search", ctx.root).oninput = paint;
  let generation = 0;
  const load = async (append = false) => {
    const revision = ++generation;
    try {
      if (append) loadedPages += 1;
      const collected: JsonRecord[] = [];
      let next: string | null = null;
      for (let i = 0; i < loadedPages; i += 1) {
        const page = await taskList(ctx, group, next);
        collected.push(...page.items);
        next = page.cursor;
        if (!next) break;
      }
      const page = {
        items: [
          ...new Map(collected.map((item) => [item.job_id, item])).values(),
        ],
        cursor: next,
      };
      if (ctx.signal.aborted || revision !== generation) return;
      items = page.items;
      cursor = page.cursor;
      paint();
    } catch (error) {
      if (!ctx.signal.aborted && revision === generation)
        failure(rows, error, () => load());
    }
  };
  click(
    "[data-filter]",
    async (el) => {
      group = el.dataset.filter!;
      loadedPages = 1;
      for (const tab of ctx.root.querySelectorAll("[data-filter]"))
        tab.classList.toggle("on", tab === el);
      await load();
    },
    ctx.root,
  );
  click("#tasks-refresh", () => load(), ctx.root);
  click("#tasks-more", () => load(true), ctx.root);
  await load();
  if (linked && !ctx.signal.aborted) await showTask(ctx, linked);
  const timer = setInterval(() => {
    if (!ctx.signal.aborted && document.visibilityState === "visible")
      void load();
  }, 5000);
  ctx.signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      clearTimeout(detailTimers.get(node("#task-peek", ctx.root)));
    },
    {
      once: true,
    },
  );
}
export async function showTask(
  ctx: AppContext,
  id: string,
  polling = false,
): Promise<void> {
  const host = node("#task-peek", ctx.root);
  clearTimeout(detailTimers.get(host));
  if (!polling) {
    host.dataset.selection = crypto.randomUUID();
    delete host.dataset.publicationAttempts;
    const url = new URL(location.href);
    url.searchParams.set("task", id);
    history.replaceState(history.state, "", url);
  }
  const selection = host.dataset.selection;
  host.className = "peekp";
  node(".libwrap", ctx.root).classList.add("peek");
  if (!polling)
    host.innerHTML =
      '<div class="peekbar"><button class="btn q sm" id="close-task">关闭</button></div><div class="peekin" id="task-content">正在读取任务…</div>';
  click(
    "#close-task",
    () => {
      clearTimeout(detailTimers.get(host));
      delete host.dataset.selection;
      host.replaceChildren();
      host.className = "";
      node(".libwrap", ctx.root).classList.remove("peek");
    },
    host,
  );
  try {
    const task = parseTaskDetail(
      await ctx.api.read(`/api/tasks/${encodeURIComponent(id)}`),
    );
    if (
      ctx.signal.aborted ||
      selection !== host.dataset.selection ||
      !host.childNodes.length
    )
      return;
    const content = node("#task-content", host);
    const processorTask =
      record(task.job.selector, "selector").schema_version === 3 &&
      record(record(task.job.selector, "selector").request, "request")
        .schema_version === 2;
    const terminal = [
      "completed",
      "cancelled",
      "failed",
      "paused",
      "interrupted",
    ].includes(String(task.job.status));
    const waitingForCollection =
      processorTask && terminal && task.collections.length === 0;
    const attempts =
      Number(host.dataset.publicationAttempts ?? "0") +
      (waitingForCollection ? 1 : 0);
    host.dataset.publicationAttempts = waitingForCollection
      ? String(attempts)
      : "0";
    const shouldPoll = !terminal || (waitingForCollection && attempts < 5);
    const fingerprint = JSON.stringify(task);
    if (host.dataset.fingerprint === fingerprint && polling && attempts !== 5) {
      if (shouldPoll)
        detailTimers.set(
          host,
          setTimeout(() => {
            void showTask(ctx, id, true);
          }, 2000),
        );
      return;
    }
    host.dataset.fingerprint = fingerprint;
    content.innerHTML = `<h2>${e(taskTitle(task.job))}</h2>${taskBadge(task.job)}<p class="code-id">${e(id)}</p><div class="acts" id="task-controls"></div><p>${task.targets.filter((target) => target.stage === "completed").length}/${task.targets.length} 项已完成</p><h4 class="h">处理结果</h4><div id="task-results"></div><details class="tg"><summary>活动记录${task.events_truncated ? "（较早记录已省略）" : ""}</summary><ol class="tl">${task.events.map((event) => `<li>${e(event.created_at ?? event.timestamp)} ${e(event.kind ?? event.type)}<pre>${e(JSON.stringify(event.payload ?? event, null, 2))}</pre></li>`).join("")}</ol></details>`;
    const controls = node("#task-controls", host),
      status = String(task.job.status);
    const actions = [
      ...(status === "queued" ? ["start"] : []),
      ...(["queued", "running"].includes(status) ? ["pause"] : []),
      ...(["paused", "interrupted"].includes(status) ? ["resume"] : []),
      ...(["failed", "interrupted"].includes(status) ||
      (status === "completed" &&
        task.failures.length > 0 &&
        task.targets.some((target) => target.stage === "skipped"))
        ? ["retry"]
        : []),
      ...(!["completed", "cancelled"].includes(status) ? ["cancel"] : []),
    ];
    const labels: Record<string, string> = {
      pause: "暂停",
      cancel: "取消",
      start: "启动",
      resume: "继续",
      retry: "重试",
    };
    for (const action of actions)
      controls.append(
        button(labels[action]!, async () => {
          await ctx.api.request(
            `/api/tasks/${encodeURIComponent(id)}/${action}`,
            {},
          );
          ctx.onTasksChanged();
          await showTask(ctx, id);
        }),
      );
    if (!processorTask && task.budget && task.policy) {
      const policy = document.createElement("p");
      policy.className = "job-policy-summary";
      policy.textContent = `策略：${String(task.policy.mode)} · 已尝试 ${String(task.budget.attempts)}/${String(task.budget.max_attempts)} · 模型调用 ${String(task.budget.model_calls)}/${String(task.budget.max_model_calls)}`;
      controls.after(policy);
    }
    const results = node("#task-results", host);
    if (processorTask) {
      const summary = task.collections.at(-1);
      if (summary && typeof summary.collection_id === "string") {
        const count = (key: string) => {
          const value = summary[key];
          if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 0
          )
            throw new Error("处理结果计数无效");
          return value;
        };
        const text = document.createElement("p");
        text.textContent = `新生成 ${count("computed")} 项 / 复用 ${count("reused")} 项 · 部分覆盖 ${count("partial")} 项 · 未形成结果 ${count("failed")} 项`;
        results.append(
          text,
          button("查看本次结果", () =>
            ctx.navigate("ext", { collection: String(summary.collection_id) }),
          ),
        );
      } else if (terminal) {
        const note = document.createElement("p");
        note.textContent =
          attempts < 5
            ? "执行状态已更新，正在等待结果集合发布…"
            : "暂未取得结果集合。可刷新任务核对，已保存的逐项结果仍可读取。";
        results.append(note);
      }
    }
    for (const intervention of task.interventions.filter(
      (item) => item.status === "open",
    )) {
      const card = document.createElement("div");
      card.className = "intervention-card";
      card.innerHTML = `<p>${e(JSON.stringify(intervention))}</p>`;
      for (const [resolution, label] of [
        ["continue", "继续任务"],
        ["skip", "跳过此项"],
        ["cancel", "取消任务"],
      ])
        card.append(
          button(label!, async () => {
            await ctx.api.request(
              `/api/v1/jobs/${encodeURIComponent(id)}/interventions/${encodeURIComponent(String(intervention.intervention_id))}/resolve`,
              { resolution },
            );
            ctx.onTasksChanged();
            await showTask(ctx, id);
          }),
        );
      results.append(card);
    }
    if (task.runtime_failure)
      results.insertAdjacentHTML(
        "beforeend",
        `<p role="alert">${e(task.runtime_failure)}</p>`,
      );
    for (const target of task.targets) {
      const row = document.createElement("div");
      row.className = "task";
      const lit = taskLiteratureId(task.job, target);
      row.innerHTML = `<b>${e(lit ?? target.target_id ?? "加工产物")}</b><p>${e(taskStatusLabel[String(target.stage ?? target.status)] ?? target.stage ?? target.status)}</p>`;
      if (lit) {
        row.append(
          button("打开文献", () => ctx.openPaper(lit, "pdf", { task: id })),
        );
        if (ctx.api.view?.sessions?.some((s) => s.article_id === lit))
          row.append(
            button("观看 Agent", () =>
              ctx.navigate("web", { literature: lit }),
            ),
          );
      }
      results.append(row);
    }
    for (const result of task.results) {
      const saved = record(result.result, "processing result");
      const target = task.targets.find(
        (item) => item.target_id === result.target_id,
      );
      const literature = target ? taskLiteratureId(task.job, target) : null;
      if (
        result.operation === "run-processor" &&
        typeof saved.result_id === "string" &&
        typeof saved.content_sha256 === "string"
      ) {
        results.append(
          button("打开处理结果摘要", () =>
            ctx.navigate("ext", {
              result: String(saved.result_id),
              resultHash: String(saved.content_sha256),
              task: id,
            }),
          ),
        );
        continue;
      }
      if (
        typeof saved.artifact_id === "string" ||
        (literature && typeof saved.document_version_id === "string")
      )
        results.append(
          button(
            `打开${operationLabels[String(result.operation)] ?? "加工"}结果`,
            () => {
              if (result.operation === "synthesize")
                ctx.navigate("syn", { artifact: String(saved.artifact_id) });
              else if (literature)
                ctx.openPaper(
                  literature,
                  result.operation === "parse-documents" ? "doc" : "know",
                  {
                    task: id,
                    ...(result.operation === "parse-documents"
                      ? { document: String(saved.document_version_id) }
                      : { knowledge: String(saved.artifact_id) }),
                  },
                );
            },
          ),
        );
    }
    for (const [label, values] of [
      ["结果", task.results],
      ["未处理", task.skipped],
      ["失败", task.failures],
    ] as const) {
      if (!values.length) continue;
      const section = document.createElement("details");
      section.open = label === "失败";
      section.innerHTML = `<summary>${label} ${values.length} 项</summary>`;
      for (const value of values) {
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(value, null, 2);
        section.append(pre);
      }
      results.append(section);
    }
    if (!task.targets.length && !task.results.length)
      results.append("任务尚未形成逐项结果。");
    if (
      !ctx.signal.aborted &&
      host.dataset.selection === selection &&
      shouldPoll
    )
      detailTimers.set(
        host,
        setTimeout(() => {
          void showTask(ctx, id, true);
        }, 2000),
      );
  } catch (error) {
    if (
      !ctx.signal.aborted &&
      host.dataset.selection === selection &&
      host.querySelector("#task-content")
    )
      failure(node("#task-content", host), error, () => showTask(ctx, id));
  }
}
export async function openActivity(ctx: AppContext): Promise<void> {
  const overlay = node("#overlay");
  overlay.innerHTML =
    '<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-label="活动"><div class="dh"><h3>活动</h3><button class="btn q sm" data-close aria-label="关闭">✕</button></div><div class="db" id="activity-list">正在读取…</div><div class="dfoot"><button class="btn" id="all-tasks">打开任务页</button></div></aside>';
  click("[data-close]", () => overlay.replaceChildren(), overlay);
  click(
    "#all-tasks",
    () => {
      overlay.replaceChildren();
      ctx.navigate("task");
    },
    overlay,
  );
  try {
    const [active, ended] = await Promise.all([
      taskList(ctx, "active"),
      taskList(ctx, "ended"),
    ]);
    const root = overlay.querySelector("#activity-list");
    if (!root) return;
    root.innerHTML = [
      ["进行中", active.items],
      ["最近结束", ended.items.slice(0, 5)],
    ]
      .map(
        ([label, raw]) =>
          `<h4 class="h">${label}</h4>${(raw as JsonRecord[]).map((job) => `<div class="task"><button class="lk" data-task="${e(job.job_id)}">${e(taskTitle(job))}</button> ${taskBadge(job)}</div>`).join("") || '<p class="f3">没有任务</p>'}`,
      )
      .join("");
    click(
      "[data-task]",
      (el) => {
        overlay.replaceChildren();
        ctx.navigate("task", { task: el.dataset.task! });
      },
      overlay,
    );
  } catch (error) {
    toast(message(error));
  }
}
