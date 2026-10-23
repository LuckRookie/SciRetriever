import { AsyncLocalStorage } from "node:async_hooks";
import { userInfo } from "node:os";

/** Request attribution only; no credentials, user payloads, or business decisions. */
export interface ActivityContext {
  readonly actor: string;
  readonly operation?: string;
  readonly job_id?: string;
  readonly target_id?: string;
  readonly literature_id?: string;
}
const activity = new AsyncLocalStorage<ActivityContext>();
export function activityContext(): ActivityContext {
  return activity.getStore() ?? { actor: `system:${process.pid}` };
}
export function withActivity<T>(
  context: Partial<ActivityContext>,
  action: () => T,
): T {
  return activity.run({ ...activityContext(), ...context }, action);
}
export function machineActor(entry: "cli" | "mcp") {
  return `${entry}:${userInfo().username}`;
}
