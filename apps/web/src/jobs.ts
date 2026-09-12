type Json = Record<string, unknown>;

const node = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error("missing jobs element");
  return value as T;
};

function element(tag: string, text: string, className?: string): HTMLElement {
  const value = document.createElement(tag);
  value.textContent = text;
  if (className) value.className = className;
  return value;
}

const statusLabel: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  paused: "等待处理",
  cancelled: "已取消",
  completed: "已完成",
  failed: "执行失败",
  interrupted: "上次运行中断",
  skipped: "已跳过",
  unknown: "结果待对账",
};

export function mountJobs(options: {
  read(path: string): Promise<Json>;
  request(path: string, body: unknown): Promise<Json>;
}): void {
  let selected: string | null = null;

  const show = (jobs: boolean) => {
    node("jobs-workspace").hidden = !jobs;
    if (jobs) {
      node("library-workspace").hidden = true;
      node("live-workspace").hidden = true;
      node("open-details").hidden = true;
      node("workspace-name").textContent = "任务";
      node("jobs-tab").setAttribute("aria-current", "page");
      node("browser-tab").removeAttribute("aria-current");
      node("library-tab").removeAttribute("aria-current");
      node("jobs-toggle").textContent = "Browser 工作台";
      const skip = document.querySelector<HTMLAnchorElement>(".skip-link");
      if (skip) {
        skip.href = "#jobs-workspace";
        skip.textContent = "跳到任务";
      }
      void refresh();
    } else {
      node("live-workspace").hidden = false;
      node("open-details").hidden = false;
      node("workspace-name").textContent = "Browser 工作台";
      node("browser-tab").setAttribute("aria-current", "page");
      node("jobs-tab").removeAttribute("aria-current");
      node("jobs-toggle").textContent = "任务";
    }
  };

  const policySummary = () => {
    const mode = node<HTMLSelectElement>("job-assistance").value;
    const attempts = node<HTMLInputElement>("job-attempts").value;
    const retries = node<HTMLInputElement>("job-retries").value;
    const behavior =
      mode === "pause"
        ? "遇到需要人工判断的目标时暂停任务"
        : mode === "notify"
          ? "记录通知并继续处理其余目标"
          : "跳过不能自动完成的目标并继续";
    node("job-policy-summary").textContent =
      `${behavior}；批次最多尝试 ${attempts} 次，每个目标最多重试 ${retries} 次。重启不会重置已用预算。`;
  };

  const command = async (jobId: string, action: string) => {
    await options.request(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/${action}`,
      {},
    );
    await refresh();
    await detail(jobId);
  };

  const renderCollection = (
    root: HTMLElement,
    title: string,
    values: readonly unknown[],
    describe: (value: Json) => string,
  ) => {
    root.append(element("h3", title));
    if (!values.length) {
      root.append(element("p", "暂无记录。", "library-empty"));
      return;
    }
    const list = document.createElement("ul");
    list.className = "job-facts";
    for (const raw of values) {
      const item = raw as Json;
      list.append(element("li", describe(item)));
    }
    root.append(list);
  };

  const detail = async (jobId: string) => {
    selected = jobId;
    const root = node("job-detail");
    root.replaceChildren(element("p", "正在读取任务…", "library-empty"));
    try {
      const [
        jobResult,
        policyResult,
        budgetResult,
        targetsResult,
        eventsResult,
        interventionsResult,
      ] = await Promise.all([
        options.read(`/api/v1/jobs/${encodeURIComponent(jobId)}`),
        options.read(`/api/v1/jobs/${encodeURIComponent(jobId)}/policy`),
        options.read(`/api/v1/jobs/${encodeURIComponent(jobId)}/budget`),
        options.read(
          `/api/v1/jobs/${encodeURIComponent(jobId)}/targets?limit=1000`,
        ),
        options.read(
          `/api/v1/jobs/${encodeURIComponent(jobId)}/events?after=-1&limit=1000`,
        ),
        options.read(
          `/api/v1/jobs/${encodeURIComponent(jobId)}/interventions?limit=1000`,
        ),
      ]);
      if (selected !== jobId) return;
      const job = jobResult.job as Json;
      const policy = policyResult.policy as Json;
      const budget = budgetResult.budget as Json;
      const targets = (targetsResult.targets ?? []) as readonly unknown[];
      const events = (eventsResult.events ?? []) as readonly unknown[];
      const interventions = (interventionsResult.interventions ??
        []) as readonly unknown[];
      root.replaceChildren(
        element(
          "p",
          statusLabel[String(job.status)] ?? String(job.status),
          "live-eyebrow",
        ),
        element("h2", String(job.job_id)),
        element(
          "p",
          `策略：${String(policy.mode)} · 已尝试 ${String(budget.attempts)}/${String(budget.max_attempts)} · 模型调用 ${String(budget.model_calls)}/${String(budget.max_model_calls)}`,
          "job-policy-summary",
        ),
      );
      const actions = document.createElement("div");
      actions.className = "job-actions";
      const runButton = document.createElement("button");
      runButton.textContent = "执行";
      runButton.disabled = ["cancelled", "completed", "failed"].includes(
        String(job.status),
      );
      runButton.addEventListener("click", () => {
        runButton.disabled = true;
        void options
          .request(`/api/v1/jobs/${encodeURIComponent(jobId)}/run`, {})
          .then(() => detail(jobId))
          .catch(() => {
            runButton.disabled = false;
          });
      });
      actions.append(runButton);
      for (const [action, label] of [
        ["pause", "暂停"],
        ["resume", "继续"],
        ["cancel", "取消"],
      ] as const) {
        const button = document.createElement("button");
        button.textContent = label;
        button.disabled = ["cancelled", "completed", "failed"].includes(
          String(job.status),
        );
        button.addEventListener("click", () => void command(jobId, action));
        actions.append(button);
      }
      root.append(actions);
      renderCollection(
        root,
        `目标（${targets.length}）`,
        targets,
        (target) =>
          `${String(target.literature_id ?? "未绑定文献")} · ${statusLabel[String(target.stage)] ?? String(target.stage)}`,
      );
      renderCollection(
        root,
        "最近事件",
        events.slice(-20),
        (event) => `${String(event.sequence)} · ${String(event.kind)}`,
      );
      root.append(element("h3", `协助请求（${interventions.length}）`));
      if (!interventions.length)
        root.append(element("p", "没有等待你处理的事项。", "library-empty"));
      for (const raw of interventions) {
        const intervention = raw as Json;
        const failure = intervention.failure as Json;
        const card = document.createElement("section");
        card.className = "intervention-card";
        card.append(
          element(
            "strong",
            statusLabel[String(intervention.status)] ??
              String(intervention.status),
          ),
          element("p", String(failure.reason ?? "任务需要处理")),
          element(
            "p",
            String(failure.action ?? "查看任务记录"),
            "library-meta",
          ),
        );
        if (intervention.status === "open") {
          const controls = document.createElement("div");
          controls.className = "job-actions";
          for (const [resolution, label] of [
            ["continue", "继续任务"],
            ["skip", "跳过此项"],
            ["cancel", "取消任务"],
          ] as const) {
            const button = document.createElement("button");
            button.textContent = label;
            button.addEventListener("click", () => {
              void options
                .request(
                  `/api/v1/jobs/${encodeURIComponent(jobId)}/interventions/${encodeURIComponent(String(intervention.intervention_id))}/resolve`,
                  { resolution },
                )
                .then(() => detail(jobId));
            });
            controls.append(button);
          }
          card.append(controls);
        }
        root.append(card);
      }
    } catch {
      root.replaceChildren(
        element("p", "任务详情暂时不可用，请刷新重试。", "library-empty"),
      );
    }
  };

  const refresh = async () => {
    const root = node("jobs-list");
    try {
      const result = await options.read("/api/v1/jobs?limit=100");
      const jobs = (result.jobs ?? []) as readonly unknown[];
      root.replaceChildren();
      if (!jobs.length)
        root.append(
          element(
            "p",
            "还没有任务。先确认策略，再创建一个批次。",
            "library-empty",
          ),
        );
      for (const raw of jobs) {
        const job = raw as Json;
        const button = document.createElement("button");
        button.className = "job-list-item";
        button.setAttribute("aria-pressed", String(job.job_id === selected));
        button.append(
          element("strong", String(job.job_id)),
          element(
            "span",
            statusLabel[String(job.status)] ?? String(job.status),
          ),
        );
        button.addEventListener("click", () => void detail(String(job.job_id)));
        root.append(button);
      }
    } catch {
      root.replaceChildren(element("p", "无法读取任务队列。", "library-empty"));
    }
  };

  node("jobs-tab").addEventListener("click", (event) => {
    event.preventDefault();
    show(true);
  });
  node("jobs-toggle").addEventListener("click", () =>
    show(node("jobs-workspace").hidden),
  );
  node("jobs-refresh").addEventListener("click", () => void refresh());
  for (const id of ["job-assistance", "job-attempts", "job-retries"])
    node(id).addEventListener("change", policySummary);
  node("job-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const confirm = node<HTMLInputElement>("job-confirm");
    if (!confirm.checked) {
      node("job-create-status").textContent = "请先确认策略与预算。";
      confirm.focus();
      return;
    }
    const text = node<HTMLInputElement>("job-query").value.trim() || null;
    const mode = node<HTMLSelectElement>("job-assistance").value as
      | "never"
      | "notify"
      | "pause";
    const maxAttempts = Number(node<HTMLInputElement>("job-attempts").value);
    const maxRetries = Number(node<HTMLInputElement>("job-retries").value);
    const goal = node<HTMLSelectElement>("job-goal").value as "content" | "pdf";
    node("job-create-status").textContent = "正在创建任务…";
    void options
      .request("/api/v1/jobs", {
        target_kind: "selector",
        goal,
        selector: {
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
        policy_version: `policy-${crypto.randomUUID()}`,
        policy: {
          mode,
          max_retries: maxRetries,
          max_attempts: maxAttempts,
        },
        idempotency_key: `workbench-${crypto.randomUUID()}`,
      })
      .then(async (result) => {
        const job = result.job as Json;
        confirm.checked = false;
        node("job-create-status").textContent = "任务已持久保存。";
        await refresh();
        await detail(String(job.job_id));
      })
      .catch(() => {
        node("job-create-status").textContent = "任务创建失败，请检查输入。";
      });
  });
  policySummary();
}
