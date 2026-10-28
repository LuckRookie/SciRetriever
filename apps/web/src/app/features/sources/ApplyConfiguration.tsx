import { randomId } from "../../../browser-platform.js";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseConfigurationApplyState } from "@sciretriever/contracts";
import { Button } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { errorMessage } from "../../strings.js";
import { ProblemLabel } from "./problem.js";
import { readSourceDirectory, sourceDirectoryKey } from "./SourceDirectory.js";
import "./sources.css";

const moving = ["waiting", "draining", "stopping", "starting"];

/** Page-header control: applies saved configuration by restarting the service once work allows. */
export function ApplyConfiguration() {
  const api = useApi(),
    queries = useQueryClient(),
    [failure, setFailure] = useState("");
  const directory = useQuery({
    queryKey: sourceDirectoryKey,
    queryFn: ({ signal }) => readSourceDirectory(api, signal),
  });
  const apply = useQuery({
    queryKey: ["configuration", "apply"],
    queryFn: async ({ signal }) =>
      parseConfigurationApplyState(
        (await api.read("/api/configuration/apply", signal)).result,
      ),
    refetchInterval: (query) =>
      moving.includes(query.state.data?.state ?? "") ? 1000 : false,
  });
  const state = apply.data,
    required = directory.data?.restart_required === true;
  if (!state || !directory.data) return null;
  const post = async (path: string, body: unknown) => {
    setFailure("");
    try {
      await api.request(path, body);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      await queries.invalidateQueries({ queryKey: ["configuration"] });
    }
  };
  if (!state.managed)
    return required ? (
      <span className="apply-configuration" role="status">
        重启服务后生效
      </span>
    ) : null;
  const work =
    state.blockers.queued +
    state.blockers.running +
    state.blockers.foreground +
    state.blockers.probes +
    state.blockers.browser_transfers;
  return (
    <span className="apply-configuration">
      {state.state === "waiting" ? (
        <>
          <span role="status">
            将在任务结束后生效{work ? `（还有 ${work} 项）` : ""}
          </span>
          {state.can_cancel ? (
            <Button
              size="compact"
              onPress={() =>
                void post("/api/configuration/apply-cancel", {
                  request_id: state.request_id,
                  runtime_id: state.runtime_id,
                })
              }
            >
              取消
            </Button>
          ) : null}
        </>
      ) : moving.includes(state.state) ? (
        <span role="status">正在重启，完成后需要重新登录…</span>
      ) : required ? (
        <>
          {state.state === "failed" && state.problem ? (
            <ProblemLabel display={state.problem.display} />
          ) : null}
          <Button
            variant="primary"
            onPress={() =>
              void post("/api/configuration/apply", {
                request_id: randomId(),
                target_binding_revision: directory.data.binding_revision,
                runtime_id: state.runtime_id,
              })
            }
          >
            应用配置
          </Button>
        </>
      ) : null}
      {failure ? <span className="problem-label">{failure}</span> : null}
    </span>
  );
}
