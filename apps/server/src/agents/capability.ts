import type {
  AgentCallLifecycle,
  AgentCapability,
  AgentPart,
  AgentRole,
  AgentToolDeclaration,
} from "./protocol.js";
import type {
  ModelAssistantMessage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelToolMessage,
} from "./model-protocol.js";

/** Ephemeral capability execution; all business state remains with the caller. */
export interface AgentCapabilityRequest {
  readonly session_id: string;
  readonly request_id: string;
  readonly purpose: "inference" | "compaction";
}

export interface AgentCapabilityRequestLifecycle extends AgentCallLifecycle {
  readonly onSettled?: () => void;
}

export interface AgentCapabilityAdmission {
  readonly signal?: AbortSignal;
  readonly admitRequest: (
    request: AgentCapabilityRequest,
    signal: AbortSignal,
  ) =>
    | AgentCapabilityRequestLifecycle
    | Promise<AgentCapabilityRequestLifecycle>;
}

export interface AgentCapabilityToolResult {
  readonly status: ModelToolMessage["status"];
  readonly parts: readonly AgentPart[];
}

export interface AgentCapabilityRunOptions extends AgentCapabilityAdmission {
  readonly executeTool: (
    call: ModelToolCall,
    context: {
      readonly signal: AbortSignal;
      /** Yield after the complete current tool batch has recorded its outcomes. */
      readonly concludeTurn: () => void;
    },
  ) => Promise<AgentCapabilityToolResult>;
}

export interface AgentCapabilityInput {
  readonly parts: readonly AgentPart[];
  readonly source?: "observation" | "human" | "transfer" | "context";
}

export interface AgentCapabilityResult {
  readonly status: "completed" | "cancelled" | "failed";
  readonly message: ModelAssistantMessage | null;
  readonly tool_results: readonly ModelToolMessage[];
  readonly error_code?: string;
}

export interface AgentCapabilitySessionOptions {
  readonly id: string;
  readonly system: string;
  readonly role: AgentRole;
  readonly input_sha256: string;
  readonly tools: readonly AgentToolDeclaration[];
  /** Default keeps every supplied image. Browser explicitly chooses latest. */
  readonly image_policy?: "all" | "latest";
  readonly tool_choice?: "auto" | "required" | "none";
  readonly max_output_tokens?: number;
  readonly modelContext: {
    readonly provider: string;
    readonly model: string;
    readonly context_window_tokens: number;
    readonly max_output_tokens: number;
    readonly capabilities?: readonly AgentCapability[];
  };
  readonly modelCall: (
    request: ModelRequest,
    signal: AbortSignal,
    lifecycle: AgentCallLifecycle,
  ) => Promise<ModelResponse>;
}

/** Production callers select a configured role; the shared foundation owns transport. */
export type AgentSessionRequest = Omit<
  AgentCapabilitySessionOptions,
  "modelContext" | "modelCall"
>;

export interface AgentCapabilitySession {
  readonly id: string;
  /** Record external context without waking the model or splitting a tool batch. */
  append(input: AgentCapabilityInput): void;
  run(
    input: AgentCapabilityInput,
    options: AgentCapabilityRunOptions,
  ): Promise<AgentCapabilityResult>;
  /** Explicit idle-session compaction uses the same admission as ordinary calls. */
  compact(options: AgentCapabilityAdmission): Promise<boolean>;
  /** Detached complete conversation, including messages shadowed by compaction. */
  history(): readonly ModelMessage[];
  close(): Promise<void>;
}

export interface AgentCapabilityRuntime {
  createSession(
    options: AgentCapabilitySessionOptions,
  ): Promise<AgentCapabilitySession>;
  close(): Promise<void>;
}
