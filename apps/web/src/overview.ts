import {
  envelopeList,
  jobRecord,
  jobStatus,
  type JsonRecord as Json,
} from "./wire.js";
import {
  parseTaskDetail,
  taskElement,
  taskStatusLabel,
  taskTitle,
  type TaskDetail,
} from "./task-view.js";

/** Reads each queue before its display limit, so old active tasks are not hidden by recent history. */
export function mountOverview(options: {
  read(path: string): Promise<Json>;
  openTask(id: string): void;
  openTasks(filter: "active" | "attention" | "ended"): void;
}): { render(): Promise<void>; error(message: string): void } {
  let revision = 0;
  const root = document.getElementById("overview-workspace");
  const active = document.getElementById("overview-active");
  const attention = document.getElementById("overview-attention");
  const recent = document.getElementById("overview-recent");
  const error = (message: string) => {
    if (!root) return;
    let status = root.querySelector<HTMLElement>("#overview-status");
    if (!status) {
      status = taskElement("p", "", "library-meta");
      status.id = "overview-status";
      status.setAttribute("role", "status");
      root.prepend(status);
    }
    status.textContent = message;
  };
  const row = (job: Json, detail?: TaskDetail, reason?: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overview-task-row";
    button.dataset.status = jobStatus(job);
    button.append(
      taskElement("strong", taskTitle(job)),
      taskElement(
        "span",
        taskStatusLabel[jobStatus(job)] ?? jobStatus(job),
        "task-state",
      ),
    );
    if (detail) {
      const done = detail.targets.filter(
        (target) => target.stage === "completed",
      ).length;
      button.append(
        taskElement(
          "small",
          `${done}/${detail.targets.length} 项完成 · ${detail.results.length} 条加工产物${detail.failures.length ? ` · ${detail.failures.length} 条失败记录` : ""}`,
          "library-meta",
        ),
      );
    }
    if (reason) button.append(taskElement("small", reason, "library-meta"));
    button.addEventListener("click", () =>
      options.openTask(String(job.job_id)),
    );
    return button;
  };
  const queues = [
    {
      group: "active",
      label: "活动任务",
      limit: 8,
      container: active,
      empty: "当前没有运行中的任务。创建任务后可在这里跟踪进展。",
    },
    {
      group: "attention",
      label: "待处理任务",
      limit: 8,
      container: attention,
      empty: "当前没有暂停、失败或中断的任务。",
    },
    {
      group: "ended",
      label: "结束任务",
      limit: 5,
      container: recent,
      empty: "尚无结束的任务；已完成、失败和取消任务的有效结果都会保留。",
    },
  ] as const;
  return {
    error,
    render: async () => {
      if (!root || !active || !attention || !recent) return;
      const current = ++revision;
      const lists = await Promise.allSettled(
        queues.map(async (queue) => {
          const result = await options.read(
            `/api/tasks?limit=${queue.limit}&status_group=${queue.group}`,
          );
          const jobs = envelopeList(result, "tasks").map(jobRecord);
          for (const job of jobs) {
            jobStatus(job);
            taskTitle(job);
          }
          if (
            result.next_cursor !== null &&
            typeof result.next_cursor !== "string"
          )
            throw new Error("invalid task cursor");
          return { jobs, more: result.next_cursor !== null };
        }),
      );
      if (current !== revision) return;
      const displayed = [
        ...new Map(
          lists
            .flatMap((result) =>
              result.status === "fulfilled" ? result.value.jobs : [],
            )
            .map((job) => [String(job.job_id), job]),
        ).values(),
      ];
      const results = await Promise.allSettled(
        displayed.map(async (job) =>
          parseTaskDetail(
            await options.read(
              `/api/tasks/${encodeURIComponent(String(job.job_id))}`,
            ),
          ),
        ),
      );
      if (current !== revision) return;
      const details = new Map<string, TaskDetail>();
      for (const result of results)
        if (result.status === "fulfilled")
          details.set(String(result.value.job.job_id), result.value);
      for (const [index, queue] of queues.entries()) {
        const container = queue.container!;
        const result = lists[index]!;
        if (result.status === "rejected") {
          container.replaceChildren(
            taskElement(
              "p",
              `${queue.label}暂时不可用，请刷新重试。`,
              "library-empty",
            ),
          );
          continue;
        }
        container.replaceChildren(
          ...result.value.jobs.map((job) =>
            row(job, details.get(String(job.job_id))),
          ),
        );
        if (!result.value.jobs.length)
          container.append(taskElement("p", queue.empty, "library-empty"));
        const more = document.createElement("button");
        more.type = "button";
        more.className = "overview-more";
        more.textContent = `查看${result.value.more ? "全部" : "这些"}${queue.label}`;
        more.addEventListener("click", () => options.openTasks(queue.group));
        container.append(more);
      }
      const activeJobs = lists[0];
      if (activeJobs?.status === "fulfilled") {
        for (const job of activeJobs.value.jobs) {
          const detail = details.get(String(job.job_id));
          const requests =
            detail?.interventions.filter((item) => item.status === "open") ??
            [];
          if (requests.length)
            attention.append(
              row(job, detail, `${requests.length} 项协助请求等待处理`),
            );
        }
      }
      error(
        lists.some((result) => result.status === "rejected") ||
          results.some((result) => result.status === "rejected")
          ? "部分任务数据暂不可用；已显示内容来自最近成功读取，请刷新重试。"
          : "按全库状态分别读取：最多展示最近 8 个活动任务、8 个待处理任务、5 个结束任务。可进入对应队列查看和加载更早记录。",
      );
    },
  };
}
