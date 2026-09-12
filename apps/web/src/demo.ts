/** Presentation-only fixture state. Never represents a backend fact or receipt. */
export type DemoScenario = "normal" | "uncertain" | "blocked";
export type DemoPhase =
  | "idle"
  | "running"
  | "paused"
  | "ready"
  | "uncertain"
  | "blocked"
  | "published"
  | "cancelled";

export interface DemoEvent {
  readonly label: string;
  readonly time: string;
}

export interface DemoState {
  scenario: DemoScenario;
  phase: DemoPhase;
  operator: boolean;
  revision: number;
  events: DemoEvent[];
}

export function createDemoState(scenario: DemoScenario = "normal"): DemoState {
  return {
    scenario,
    phase: "idle",
    operator: false,
    revision: 1,
    events: [
      { label: "已打开合成文章页面", time: "00:00" },
      { label: "已识别文章信息与 PDF 入口", time: "00:01" },
    ],
  };
}

export function hasCandidate(phase: DemoPhase): boolean {
  return phase === "ready" || phase === "uncertain" || phase === "published";
}

export function canPublish(phase: DemoPhase): boolean {
  return phase === "ready";
}

export function completeDemoCapture(state: DemoState): void {
  if (state.phase !== "running") return;
  state.phase =
    state.scenario === "normal"
      ? "ready"
      : state.scenario === "uncertain"
        ? "uncertain"
        : "blocked";
  state.revision += 1;
}
