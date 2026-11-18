import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, Tabs } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";
import { runningTaskCount } from "../../data/tasks.js";
import "./tasks.css";

/** Shares the shell's activity query, so this adds no extra polling. */
export function useActiveTaskCount() {
  const api = useApi();
  const tasks = useQuery({
    queryKey: ["tasks", "activity"],
    queryFn: ({ signal }) =>
      api.read("/api/tasks?limit=100&status_group=active", signal),
    enabled: api.kind === "workspace",
    refetchInterval: 5000,
  });
  return runningTaskCount(tasks.data);
}

/**
 * The task page's tabs (page specs “整体信息架构”). Each is its own `view`,
 * so the old addresses `view=archive`, `view=web` and `view=agent` open their
 * tab, and every switch is a history entry the back button returns through.
 */
export const TASK_TABS = [
  { id: "task", label: "任务" },
  { id: "archive", label: "需处理" },
  { id: "web", label: "浏览器" },
  { id: "agent", label: "Agent 会话" },
  { id: "stats", label: "来源统计" },
] as const;
export type TaskTab = (typeof TASK_TABS)[number]["id"];
export const taskTabs: readonly string[] = TASK_TABS.map((tab) => tab.id);

/**
 * “任务” with its running count, the five tabs and the current tab's content
 * as their panel; the tabs' content is what each page showed on its own.
 */
export function TaskPage({
  tab,
  className,
  action,
  panel,
  children,
}: {
  tab: TaskTab;
  className: string;
  /** The tab's own action, such as “刷新任务”, at the header's right. */
  action?: ReactNode;
  /** Marks the section while the task detail panel is open. */
  panel?: "open";
  children: ReactNode;
}) {
  const running = useActiveTaskCount();
  return (
    <section className={`task-page ${className}`} data-panel={panel}>
      <PageHeader
        title="任务"
        count={running ? `${running} 个进行中` : undefined}
        action={action}
      />
      <Tabs
        label="任务视图"
        value={tab}
        onChange={(next) =>
          navigate(
            { view: next, literature: null, session: null, article: null },
            { clearSource: true },
          )
        }
        items={TASK_TABS}
      >
        {children}
      </Tabs>
    </section>
  );
}
