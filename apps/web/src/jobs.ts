import {
  parseProcessingTaskRequest,
  parseStrictJsonValue,
} from "@sciretriever/contracts";
import {
  envelopeList,
  jobRecord,
  jobStatus,
  record,
  type JsonRecord as Json,
} from "./wire.js";
import {
  currentWorkspace,
  navigateWorkspace,
  onWorkspace,
} from "./navigation.js";
import { mountOverview } from "./overview.js";
import {
  taskElement,
  taskStatusLabel,
  taskTitle,
  taskLiteratureId,
  parseTaskDetail,
  operationLabels,
  type TaskDetail,
} from "./task-view.js";

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`missing tasks element: ${id}`);
  return value as T;
}

function action(
  label: string,
  run: () => void,
  className?: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", run);
  return button;
}

function failureText(value: Json): string {
  const failure =
    value.failure && typeof value.failure === "object"
      ? record(value.failure, "failure")
      : value;
  return (
    [failure.reason, failure.code, failure.action, value.skipped_reason]
      .filter((item) => typeof item === "string")
      .join(" · ") || "未完成；请查看活动记录。"
  );
}

export function mountJobs(options: {
  read(path: string): Promise<Json>;
  request(path: string, body: unknown): Promise<Json>;
  openBrowserArticle?(id: string): Promise<void>;
}): void {
  let selected: string | null = null;
  let selectedTab: "execution" | "results" | "activity" = "execution";
  let refreshRevision = 0;
  let detailRevision = 0;
  let detailFingerprint = "";
  let currentDetail: TaskDetail | null = null;
  let jobs: readonly Json[] = [];
  let loadedPages = 1;
  let loadedFilter = "all";
  let nextCursor: string | null = null;
  const listNote = taskElement("p", "", "library-meta");
  listNote.id = "jobs-range";
  const moreJobs = action("加载更早任务", () => {
    if (moreJobs.disabled || !nextCursor) return;
    loadedPages += 1;
    void refresh();
  });
  moreJobs.id = "jobs-more";
  moreJobs.hidden = true;
  node("jobs-list").after(listNote, moreJobs);
  let busy = false;
  let submitting = false;
  let createKey = `workbench-${crypto.randomUUID()}`;
  const overview = mountOverview({
    read: options.read,
    openTask: (id) => navigateWorkspace("jobs", { job: id }),
    openTasks: (filter) =>
      navigateWorkspace("jobs", { job: null, task_filter: filter }),
  });
  const root = node("job-detail");
  const notify = (message: string) => {
    let status = root.querySelector<HTMLElement>(".job-command-status");
    if (!status) {
      status = taskElement("p", "", "job-command-status");
      status.setAttribute("role", "status");
      root.prepend(status);
    }
    status.textContent = message;
  };

  const renderList = () => {
    const list = node("jobs-list");
    const filter =
      document.querySelector<HTMLSelectElement>("#jobs-filter")?.value ?? "all";
    const query =
      document
        .querySelector<HTMLInputElement>("#jobs-search")
        ?.value.trim()
        .toLocaleLowerCase() ?? "";
    const visible = jobs.filter((job) => {
      const status = jobStatus(job);
      return (
        (filter === "all" ||
          (filter === "active" && ["queued", "running"].includes(status)) ||
          (filter === "attention" &&
            ["paused", "failed", "interrupted"].includes(status)) ||
          (filter === "completed" && status === "completed") ||
          (filter === "ended" &&
            ["completed", "cancelled", "failed"].includes(status))) &&
        (!query ||
          `${taskTitle(job)} ${String(job.job_id)}`
            .toLocaleLowerCase()
            .includes(query))
      );
    });
    list.replaceChildren();
    if (!visible.length)
      list.append(
        taskElement(
          "p",
          jobs.length
            ? "没有符合筛选条件的任务。"
            : "还没有任务。选择范围并确认后，创建第一个任务。",
          "library-empty",
        ),
      );
    for (const job of visible) {
      const status = jobStatus(job);
      const button = action(
        "",
        () => navigateWorkspace("jobs", { job: String(job.job_id) }),
        "job-list-item",
      );
      button.dataset.status = status;
      button.setAttribute("aria-pressed", String(job.job_id === selected));
      button.append(
        taskElement("strong", taskTitle(job)),
        taskElement("span", taskStatusLabel[status] ?? status, "task-state"),
        taskElement("small", String(job.job_id), "library-meta"),
      );
      list.append(button);
    }
  };

  const openLiterature = (id: string) =>
    navigateWorkspace("library", {
      literature: id,
      job: selected,
      knowledge: null,
      synthesis: null,
      document: null,
    });
  const targetLine = (task: TaskDetail, target: Json, browser: boolean) => {
    const item = document.createElement("div");
    item.className = "task-target-row";
    const id = taskLiteratureId(task.job, target);
    item.append(
      taskElement("strong", id ?? `集合操作 ${Number(target.ordinal) + 1}`),
      taskElement(
        "span",
        taskStatusLabel[String(target.stage)] ?? String(target.stage),
        "task-state",
      ),
    );
    if (id) {
      item.append(action("查看文献与结果", () => openLiterature(id)));
      if (browser && options.openBrowserArticle) {
        const button = action("Browser 协助", () => {
          if (button.disabled) return;
          button.disabled = true;
          void options.openBrowserArticle!(id)
            .then(() =>
              navigateWorkspace("browser", { literature: id, job: selected }),
            )
            .catch(() =>
              notify("Browser 暂不可用；请检查运行配置或等待当前操作结束。"),
            )
            .finally(() => {
              button.disabled = false;
            });
        });
        item.append(button);
      }
    }
    return item;
  };

  const command = async (jobId: string, kind: string) => {
    if (busy) return;
    busy = true;
    renderDetail(currentDetail!);
    try {
      await options.request(
        `/api/tasks/${encodeURIComponent(jobId)}/${kind}`,
        {},
      );
      detailFingerprint = "";
      await refresh();
      if (selected === jobId) await detail(jobId);
    } catch {
      if (selected === jobId)
        notify(
          kind === "start"
            ? "执行未能开始；可以重试，已保存的任务与结果保留。"
            : "操作未被接受；已保存结果保留，请刷新任务后重试。",
        );
    } finally {
      busy = false;
      for (const button of root.querySelectorAll<HTMLButtonElement>(
        ".job-actions > button",
      ))
        if (button.dataset.available === "true") button.disabled = false;
    }
  };

  function renderDetail(task: TaskDetail): void {
    const jobId = String(task.job.job_id);
    const status = jobStatus(task.job);
    const completed = task.targets.filter(
      (target) => target.stage === "completed",
    ).length;
    const incomplete = task.targets.filter((target) =>
      ["failed", "skipped", "interrupted"].includes(String(target.stage)),
    ).length;
    root.replaceChildren(
      taskElement("p", taskStatusLabel[status] ?? status, "live-eyebrow"),
      taskElement("h2", taskTitle(task.job)),
      taskElement("p", jobId, "library-meta"),
      taskElement(
        "p",
        `${completed}/${task.targets.length} 项已完成 · ${task.results.length} 条加工结果 · ${incomplete} 项失败、跳过或中断。已提交的材料与结果会保留。`,
        "task-summary",
      ),
    );
    if (task.budget && task.policy) {
      const mode = {
        never: "自动处理",
        notify: "通知并继续",
        pause: "等待人工处理",
      }[String(task.policy.mode)];
      root.append(
        taskElement(
          "p",
          `策略：${mode ?? String(task.policy.mode)} · 已尝试 ${String(task.budget.attempts)}/${String(task.budget.max_attempts)} · 模型调用 ${String(task.budget.model_calls)}/${String(task.budget.max_model_calls)}`,
          "job-policy-summary",
        ),
      );
    }
    if (task.runtime_failure)
      root.append(
        taskElement(
          "p",
          `执行服务报告：${task.runtime_failure}。检查配置后可尝试恢复。`,
          "task-warning",
        ),
      );
    const actions = document.createElement("div");
    actions.className = "job-actions";
    const canRetry =
      status === "failed" ||
      status === "interrupted" ||
      (status === "completed" &&
        task.failures.length > 0 &&
        task.targets.some((target) => target.stage === "skipped"));
    for (const [kind, label, enabled] of [
      ["start", "执行", status === "queued"],
      ["pause", "暂停", ["queued", "running"].includes(status)],
      ["resume", "继续", ["paused", "interrupted"].includes(status)],
      ["retry", "重试未完成项", canRetry],
      ["cancel", "取消", !["completed", "cancelled"].includes(status)],
    ] as const) {
      const button = action(label, () => void command(jobId, kind));
      button.dataset.available = String(enabled);
      button.disabled = busy || !enabled;
      actions.append(button);
    }
    root.append(actions);
    const tabs = document.createElement("div");
    tabs.className = "task-detail-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "任务详情");
    for (const [tab, label] of [
      ["execution", "执行过程"],
      ["results", "结果与材料"],
      ["activity", "活动记录"],
    ] as const) {
      const button = action(label, () => {
        selectedTab = tab;
        renderDetail(task);
      });
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab === selectedTab));
      button.setAttribute("aria-controls", "task-detail-panel");
      tabs.append(button);
    }
    root.append(tabs);
    const panel = document.createElement("section");
    panel.id = "task-detail-panel";
    panel.setAttribute("role", "tabpanel");
    root.append(panel);
    if (selectedTab === "execution") {
      panel.append(taskElement("h3", `处理目标（${task.targets.length}）`));
      for (const target of task.targets)
        panel.append(targetLine(task, target, true));
      if (!task.targets.length)
        panel.append(
          taskElement("p", "本次范围没有处理目标。", "library-empty"),
        );
      const open = task.interventions.filter((item) => item.status === "open");
      panel.append(taskElement("h3", `需要处理（${open.length}）`));
      if (!open.length)
        panel.append(
          taskElement("p", "没有等待你处理的事项。", "library-empty"),
        );
      for (const intervention of open) {
        const card = document.createElement("section");
        card.className = "intervention-card";
        card.append(taskElement("p", failureText(intervention)));
        const controls = document.createElement("div");
        controls.className = "job-actions";
        for (const [resolution, label] of [
          ["continue", "继续任务"],
          ["skip", "跳过此项"],
          ["cancel", "取消任务"],
        ] as const) {
          const button = action(label, () => {
            if (button.disabled) return;
            for (const control of controls.querySelectorAll<HTMLButtonElement>(
              "button",
            ))
              control.disabled = true;
            void options
              .request(
                `/api/v1/jobs/${encodeURIComponent(jobId)}/interventions/${encodeURIComponent(String(intervention.intervention_id))}/resolve`,
                { resolution },
              )
              .then(async () => {
                detailFingerprint = "";
                if (selected === jobId) await detail(jobId);
                await refresh();
              })
              .catch(() => {
                if (selected === jobId)
                  notify("协助处理未被接受，请刷新任务后重试。");
                for (const control of controls.querySelectorAll<HTMLButtonElement>(
                  "button",
                ))
                  control.disabled = false;
              });
          });
          controls.append(button);
        }
        card.append(controls);
        panel.append(card);
      }
    } else if (selectedTab === "results") {
      panel.append(taskElement("h3", "已保存的材料与结果"));
      for (const target of task.targets)
        panel.append(targetLine(task, target, false));
      for (const result of task.results) {
        const details = document.createElement("details");
        details.className = "task-result-record";
        const saved = record(result.result, "processing result");
        const target = task.targets.find(
          (item) => item.target_id === result.target_id,
        );
        const literature = target ? taskLiteratureId(task.job, target) : null;
        if (
          typeof saved.artifact_id === "string" ||
          (literature && typeof saved.document_version_id === "string")
        ) {
          const parameters = {
            literature,
            job: jobId,
            knowledge:
              result.operation === "analyze" ||
              result.operation === "analyze-long"
                ? String(saved.artifact_id)
                : null,
            synthesis:
              result.operation === "synthesize"
                ? String(saved.artifact_id)
                : null,
            document:
              result.operation === "parse-documents"
                ? String(saved.document_version_id)
                : null,
          };
          panel.append(
            action(
              `打开${operationLabels[String(result.operation)] ?? "加工"}结果`,
              () => navigateWorkspace("library", parameters),
            ),
          );
        }
        details.append(
          taskElement(
            "summary",
            `${operationLabels[String(result.operation)] ?? String(result.operation)} · ${result.disposition === "skipped" ? "未生成新结果" : "结果已保存"}`,
          ),
          taskElement("pre", JSON.stringify(result.result, null, 2)),
        );
        panel.append(details);
      }
      if (!task.results.length)
        panel.append(
          taskElement(
            "p",
            "没有已发布的加工产物；PDF 获取结果可从对应文献查看。",
            "library-empty",
          ),
        );
      panel.append(taskElement("h3", `失败与缺口（${task.failures.length}）`));
      for (const failure of task.failures)
        panel.append(taskElement("p", failureText(failure), "task-warning"));
      if (!task.failures.length)
        panel.append(taskElement("p", "没有记录失败。", "library-empty"));
      panel.append(taskElement("h3", `跳过记录（${task.skipped.length}）`));
      for (const skipped of task.skipped)
        panel.append(taskElement("p", failureText(skipped), "library-meta"));
    } else {
      panel.append(taskElement("h3", "执行活动"));
      if (task.events_truncated)
        panel.append(
          taskElement(
            "p",
            "此处展示最近 1000 条活动；更早的记录仍保存在任务中。",
            "library-meta",
          ),
        );
      const events = document.createElement("ol");
      events.className = "job-facts";
      for (const event of task.events) {
        const item = document.createElement("li");
        item.append(
          taskElement("strong", String(event.kind)),
          taskElement(
            "span",
            typeof event.created_at === "string" ? event.created_at : "",
            "library-meta",
          ),
        );
        const disclosure = document.createElement("details");
        disclosure.append(
          taskElement("summary", "查看记录"),
          taskElement("pre", JSON.stringify(event.payload, null, 2)),
        );
        item.append(disclosure);
        events.append(item);
      }
      panel.append(events);
      if (!task.events.length)
        panel.append(taskElement("p", "尚无执行活动。", "library-empty"));
    }
  }

  async function detail(jobId: string): Promise<void> {
    const revision = ++detailRevision;
    if (selected !== jobId) {
      selected = jobId;
      selectedTab = "execution";
      detailFingerprint = "";
      currentDetail = null;
      root.replaceChildren(taskElement("p", "正在读取任务…", "library-empty"));
      renderList();
    }
    try {
      const task = parseTaskDetail(
        await options.read(`/api/tasks/${encodeURIComponent(jobId)}`),
      );
      if (revision !== detailRevision || selected !== jobId) return;
      if (task.job.job_id !== jobId) throw new Error("task response mismatch");
      currentDetail = task;
      const fingerprint = JSON.stringify(task);
      if (fingerprint !== detailFingerprint) {
        detailFingerprint = fingerprint;
        renderDetail(task);
      }
    } catch {
      if (revision !== detailRevision || selected !== jobId) return;
      notify("任务详情暂时不可用；已显示内容可能过期，请刷新重试。");
    }
  }

  async function refresh(): Promise<void> {
    const revision = ++refreshRevision;
    const list = node("jobs-list");
    list.setAttribute("aria-busy", "true");
    moreJobs.disabled = true;
    try {
      const next = new Map<string, Json>();
      let cursor: string | null = null;
      const filter =
        document.querySelector<HTMLSelectElement>("#jobs-filter")?.value ??
        "all";
      if (loadedFilter !== filter) {
        loadedFilter = filter;
        loadedPages = 1;
      }
      const group = filter === "completed" ? "ended" : filter;
      const scope = ["active", "attention", "ended"].includes(group)
        ? `&status_group=${group}`
        : "";
      for (let page = 0; page < loadedPages; page += 1) {
        const result = await options.read(
          `/api/tasks?limit=100${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (revision !== refreshRevision) return;
        const items = envelopeList(result, "tasks").map(jobRecord);
        if (
          result.next_cursor !== null &&
          typeof result.next_cursor !== "string"
        )
          throw new Error("invalid task cursor");
        for (const job of items) {
          jobStatus(job);
          taskTitle(job);
          next.set(String(job.job_id), job);
        }
        const following = result.next_cursor as string | null;
        if (following !== null && (following === cursor || !items.length))
          throw new Error("task cursor did not advance");
        cursor = following;
        if (!cursor) break;
      }
      if (revision !== refreshRevision) return;
      nextCursor = cursor;
      moreJobs.hidden = nextCursor === null;
      listNote.textContent = `已加载 ${next.size} 个任务，按新到旧排列。搜索与筛选应用于已加载范围${nextCursor ? "；可继续加载更早记录。" : "；已到最早记录。"}`;
      jobs = [...next.values()].sort(
        (left, right) =>
          String(right.created_at ?? "").localeCompare(
            String(left.created_at ?? ""),
          ) || String(right.job_id).localeCompare(String(left.job_id)),
      );
      renderList();
      if (currentWorkspace() === "overview") await overview.render();
    } catch {
      if (revision !== refreshRevision) return;
      list.replaceChildren(
        taskElement(
          "p",
          "无法读取任务队列。请检查连接后重试。",
          "library-empty",
        ),
      );
      overview.error("任务数据暂不可用。请检查本地服务后刷新。");
    } finally {
      if (revision === refreshRevision) {
        list.removeAttribute("aria-busy");
        moreJobs.disabled = false;
      }
    }
  }

  const policySummary = () => {
    const mode = node<HTMLSelectElement>("job-assistance").value;
    const behavior =
      mode === "pause"
        ? "需要人工判断时暂停任务"
        : mode === "notify"
          ? "记录协助通知并继续"
          : "跳过无法自动完成的目标";
    node("job-policy-summary").textContent =
      `${behavior}；最多尝试 ${node<HTMLInputElement>("job-attempts").value} 次，每项最多重试 ${node<HTMLInputElement>("job-retries").value} 次。重启不会重置已用预算。`;
    const processing =
      node<HTMLSelectElement>("job-goal").value === "processing";
    if (processing)
      node("job-policy-summary").textContent =
        "任务只处理请求中固定的已保存材料；解析、身份核验、知识分析和集合综合按各自请求执行，不会自动补齐缺少的前序材料。可在任务详情暂停、取消或重试未完成项。";
    const policyFields = document.getElementById("job-policy-fields");
    if (policyFields) policyFields.hidden = processing;
    const pdf = document.getElementById("job-pdf-fields");
    if (pdf) pdf.hidden = processing;
    const fields = document.getElementById("job-processing-fields");
    if (fields) fields.hidden = !processing;
  };
  for (const id of [
    "job-assistance",
    "job-attempts",
    "job-retries",
    "job-goal",
  ])
    node(id).addEventListener("change", policySummary);
  const filterControl =
    document.querySelector<HTMLSelectElement>("#jobs-filter");
  if (filterControl && !filterControl.querySelector('option[value="ended"]')) {
    const option = document.createElement("option");
    option.value = "ended";
    option.textContent = "已结束";
    filterControl.append(option);
  }
  filterControl?.addEventListener("change", () =>
    navigateWorkspace("jobs", {
      task_filter: filterControl.value,
      job: selected,
    }),
  );
  document.getElementById("jobs-search")?.addEventListener("input", renderList);
  node("jobs-refresh").addEventListener("click", () => {
    void refresh();
    if (selected) void detail(selected);
  });
  document
    .getElementById("overview-refresh")
    ?.addEventListener("click", () => void refresh());
  const form = node<HTMLFormElement>("job-form");
  form.addEventListener("input", () => {
    createKey = `workbench-${crypto.randomUUID()}`;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;
    const confirm = node<HTMLInputElement>("job-confirm");
    if (!confirm.checked) {
      node("job-create-status").textContent = "请先确认任务范围、策略与预算。";
      confirm.focus();
      return;
    }
    submitting = true;
    const submit = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (submit) submit.disabled = true;
    node("job-create-status").textContent = "正在创建任务…";
    void (async () => {
      let input: unknown;
      if (node<HTMLSelectElement>("job-goal").value === "processing") {
        const bytes = new TextEncoder().encode(
          node<HTMLTextAreaElement>("job-processing-json").value,
        );
        if (bytes.byteLength > 1024 * 1024)
          throw new Error("processing input too large");
        input = {
          kind: "processing",
          request: await parseProcessingTaskRequest(
            parseStrictJsonValue(bytes),
          ),
        };
      } else {
        const text = node<HTMLInputElement>("job-query").value.trim() || null;
        const ids = [
          ...new Set(
            (
              document.querySelector<HTMLTextAreaElement>("#job-literature-ids")
                ?.value ?? ""
            )
              .split(/[\s,，]+/u)
              .filter(Boolean),
          ),
        ];
        if (text && ids.length) throw new Error("choose one selector");
        input = {
          kind: "acquire-pdf",
          idempotency_key: createKey,
          selector: ids.length
            ? { kind: "literatures", literature_ids: ids }
            : {
                kind: "query",
                query: {
                  text,
                  title: null,
                  author: null,
                  author_orcids: [],
                  identifiers: [],
                  publication_year_from: null,
                  publication_year_to: null,
                  venue: null,
                  publisher: null,
                  document_types: [],
                  languages: [],
                  keywords: [],
                  version_roles: [],
                  statuses: [],
                  missing_steps: [],
                  needs_manual_pdf: null,
                  discovery_run_ids: [],
                },
              },
          policy: {
            mode: node<HTMLSelectElement>("job-assistance").value,
            max_retries: Number(node<HTMLInputElement>("job-retries").value),
            max_attempts: Number(node<HTMLInputElement>("job-attempts").value),
          },
        };
      }
      const job = jobRecord((await options.request("/api/tasks", input)).task);
      createKey = `workbench-${crypto.randomUUID()}`;
      confirm.checked = false;
      node("job-create-status").textContent =
        "任务已持久保存。点击执行开始处理。";
      const createPanel =
        document.querySelector<HTMLDetailsElement>("#task-create-panel");
      if (createPanel) createPanel.open = false;
      navigateWorkspace("jobs", { job: String(job.job_id) });
    })()
      .catch(() => {
        node("job-create-status").textContent =
          "任务创建失败。请核对范围或固定材料请求后重试；查询与指定文献不能同时填写。";
      })
      .finally(() => {
        submitting = false;
        if (submit) submit.disabled = false;
      });
  });
  onWorkspace((workspace) => {
    if (workspace !== "jobs" && workspace !== "overview") return;
    if (workspace === "jobs" && filterControl) {
      const filter = new URL(window.location.href).searchParams.get(
        "task_filter",
      );
      filterControl.value =
        filter &&
        ["all", "active", "attention", "completed", "ended"].includes(filter)
          ? filter
          : "all";
    }
    void refresh();
    if (workspace === "jobs") {
      const jobId = new URL(window.location.href).searchParams.get("job");
      if (jobId) void detail(jobId);
      else {
        selected = null;
        detailRevision += 1;
        currentDetail = null;
        root.replaceChildren(
          taskElement(
            "p",
            "选择一个任务，查看执行进展、已保存结果和需要处理的事项。",
            "library-empty",
          ),
        );
      }
    }
  });
  let polling = false;
  const timer = setInterval(() => {
    if (
      polling ||
      document.hidden ||
      !["overview", "jobs"].includes(currentWorkspace())
    )
      return;
    polling = true;
    void (async () => {
      await refresh();
      if (currentWorkspace() === "jobs" && selected && !busy)
        await detail(selected);
    })().finally(() => {
      polling = false;
    });
  }, 5000);
  window.addEventListener("pagehide", () => clearInterval(timer), {
    once: true,
  });
  policySummary();
}
