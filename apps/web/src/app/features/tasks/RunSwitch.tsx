import { useQuery } from "@tanstack/react-query";
import { SegmentedControl } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";

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
  return Array.isArray(tasks.data?.tasks) ? tasks.data.tasks.length : 0;
}

/** Tasks and the Agent sessions they start share one page under 运行. */
export function RunSwitch({ value }: { value: "task" | "agent" }) {
  return (
    <SegmentedControl
      label="运行视图"
      value={value}
      onChange={(next) =>
        navigate({
          view: next === "agent" ? "agent" : "task",
          literature: null,
        })
      }
      items={[
        { id: "task", label: "任务" },
        { id: "agent", label: "Agent 会话" },
      ]}
    />
  );
}
