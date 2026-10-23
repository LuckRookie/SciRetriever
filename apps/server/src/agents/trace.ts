import type { ActivityContext } from "../logging/activity.js";

export interface AgentTraceSubject {
  readonly literature_id?: string;
  readonly asset_id?: string;
  readonly asset_sha256?: string;
  readonly document_version_id?: string;
  /** Zero-based fixed PDF page. */
  readonly page?: number;
  readonly page_count?: number;
  readonly region?: readonly number[] | null;
  readonly kind?: string;
}
export interface AgentTraceInfo {
  readonly session_id: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly context: ActivityContext;
  readonly subject: AgentTraceSubject;
}
export interface AgentTraceSink {
  event(kind: string, value: unknown): void;
  usage(calls: number, input: number, output: number): void;
  flush(): Promise<void>;
  finish(status: string): Promise<void>;
}
export interface AgentTraceRecorder {
  start(info: AgentTraceInfo): Promise<AgentTraceSink>;
}
