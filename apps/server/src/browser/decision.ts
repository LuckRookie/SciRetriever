import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  BROWSER_AGENT_STOP_REASONS,
  parseBrowserAction,
  type BrowserAction,
  type OperatorInput,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import type { AgentRuntime } from "../agents/runtime.js";
import {
  AgentFailure,
  type AgentCall,
  type AgentCallLifecycle,
} from "../agents/protocol.js";
import type {
  AgentCapabilityAdmission,
  AgentCapabilityToolResult,
} from "../agents/capability.js";
import type { BrowserArticleSessionIdentity } from "./article-session.js";
import type { BrowserDecisionTarget } from "./boundary.js";
import { createLogger } from "../logging/index.js";

const browserInstructions =
  "Obtain the main PDF of the current article through the available browser session and network access. Inspect the current page and choose exactly one declared Browser action toward that goal. Use the supplied target_article metadata to distinguish the requested article from unrelated pages, but never invent a URL from it. If a cookie, privacy, consent, or other blocking overlay is visible, first use its visible Accept, Reject, Close, or Continue control; do not click a control covered by that overlay. If a challenge is still loading or its verification control has not appeared, choose WaitForChange within the remaining budget before deciding to stop. If page_state is CHALLENGE, use only a visible Verify, I'm human, or Continue control from the observation or screenshot, then use WaitForChange as needed to inspect the result; the Browser runtime also automatically waits for the verifier/page hand-off after a non-wait action. As a hard rule, never use a token, solver, script, selector, credential, or challenge bypass. After a challenge click, allow asynchronous verification to finish with WaitForChange. An unchanged page is not proof of denied access. Wait results distinguish a detected change from a timeout without detected change; a successfully executed wait does not establish progress. Use the consecutive unchanged-wait count and measured waiting time in action_feedback alongside the current screenshot and remaining budget. After repeated unchanged waits, reassess visible controls and the pending transition instead of waiting merely because time remains. Continue waiting when there is a concrete reason to expect a transition; otherwise use no-viable-path only after reasonable article-related routes have been tried and no new actionable route remains. Avoid repeatedly clicking the same control without new feedback; observe again after waiting, and use the remaining time budget. An explicit access obstacle warrants Stop only when the current article has no eligible visible alternative. After the page is usable, prefer the article's visible PDF or download link. If the observation lists a PDF/download element, use ClickElement with its element_id; use ClickPoint only when no suitable element is listed. The Browser runtime waits for page feedback and enforces at least five seconds from a completed action to the next model decision, overlapping that interval with page feedback; use WaitForChange only when the current observation needs an additional explicit wait. Follow visible access or Continue controls offered for the existing institutional session; a sign-in link alone does not prove credentials are required. The runtime ends exploration when a valid PDF is captured; never claim download success yourself. Stop when continuing actually requires entering credentials, MFA, payment, or an account or identity change and no eligible alternative remains. Do not select a new identity. Never request text entry, keys, selectors, scripts, files, credentials, or a new URL. Use the current observation revision and viewport version. ClickPoint coordinates are CSS pixels within the supplied viewport width and height, not normalized coordinates or coordinates from a different image size. Respect action_feedback: rejected actions were not executed. The feedback also describes recent executed actions by page and control name; use it to recognize routes you have already tried even when element IDs change. When a route returns to the same access requirement and completing it requires unavailable credentials or selecting another identity, stop if no eligible visible alternative remains. Remaining time is not a reason to repeat an unavailable access route. Use only element IDs from the current observation. Return an object containing action, with only the fields declared for that action. The allowed non-null fields are: ClickElement kind/element_id/revision; ClickPoint kind/x/y/revision/viewport_version; ScrollSurface kind/delta_x/delta_y/revision; GoBack kind/revision; WaitForChange kind/timeout_ms/revision; Stop kind/reason/explanation. Set reason and explanation only for Stop. Stop has exactly two task reasons: access-unavailable means the target article demonstrably requires payment, unavailable credentials, MFA or an identity change and no current-session full-text alternative remains; no-viable-path means you have tried the reasonable article-related routes available in the observations and action history and there is no new actionable route left. A sign-in or purchase button alone, a slow page, one failed click or a challenge is not enough to stop. First wait and observe loading/verification, dismiss an overlay, or return from an unrelated page as appropriate. Stay focused on the requested article: author guidelines, editor information, marketing and unrelated articles are not download routes. If you reached such a page, GoBack to the article before judging the remaining paths. Do not repeat a route that produced the same obstacle without new information, and do not spend remaining time on unrelated navigation. Do not stop merely to save budget when a relevant untried route remains. Do not invent budget, cancellation, network or success reasons; those outcomes belong to the runtime. For either Stop reason, supply one short factual explanation stating what relevant access/download route you tried and the concrete remaining obstacle; do not include URLs, credentials or copied page text.";

// A strict discriminated union makes irrelevant non-null fields impossible on the
// provider wire. The enclosing object is required by strict tool-schema providers.
const actionFields = {
  element_id: { type: "string" },
  x: {
    type: "number",
    description: "Horizontal CSS pixel coordinate in the current viewport.",
  },
  y: {
    type: "number",
    description: "Vertical CSS pixel coordinate in the current viewport.",
  },
  revision: {
    type: "integer",
    description: "Positive current observation revision.",
  },
  viewport_version: {
    type: "integer",
    description: "Positive current observation revision.",
  },
  delta_x: { type: "number", description: "Range: -2000 to 2000." },
  delta_y: { type: "number", description: "Range: -2000 to 2000." },
  timeout_ms: { type: "integer", description: "Range: 1 to 120000." },
  reason: { type: "string", enum: BROWSER_AGENT_STOP_REASONS },
  explanation: {
    type: "string",
    description:
      "One short sentence stating the relevant attempts and the concrete remaining obstacle. Do not include URLs, credentials or page dumps.",
  },
} as const;
const variants: readonly (readonly [
  string,
  readonly (keyof typeof actionFields)[],
])[] = [
  ["click-element", ["element_id", "revision"]],
  ["click-point", ["x", "y", "revision", "viewport_version"]],
  ["scroll-surface", ["delta_x", "delta_y", "revision"]],
  ["go-back", ["revision"]],
  ["wait-for-change", ["timeout_ms", "revision"]],
  ["stop", ["reason", "explanation"]],
];
const actionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      anyOf: variants.map(([kind, fields]) => ({
        type: "object",
        additionalProperties: false,
        required: ["kind", ...fields],
        properties: {
          kind: { type: "string", enum: [kind] },
          ...Object.fromEntries(
            fields.map((field) => [field, actionFields[field]]),
          ),
        },
      })),
    },
  },
} as const;

function browserCall(
  observation: WorkbenchObservation,
  frame: Uint8Array | null,
  guidance: readonly string[] = [],
  target?: BrowserDecisionTarget,
  recentActions: readonly OperatorInput[] = [],
  feedback: readonly string[] = [],
): AgentCall {
  if (target && target.literature_id !== observation.article_id)
    throw new Error("Browser decision target does not match the observation");
  // Select the declared goal fields explicitly. Structural TypeScript callers may
  // carry unrelated request properties (for example start_url); those must never
  // cross the Agent boundary.
  const goal = target
    ? {
        literature_id: target.literature_id,
        identifier: target.identifier,
        version: target.version,
        ...(Object.hasOwn(target, "title")
          ? {
              title: target.title ?? null,
              authors: Array.isArray(target.authors) ? [...target.authors] : [],
              identifiers: Array.isArray(target.identifiers)
                ? target.identifiers.map((identifier) => ({
                    namespace: identifier.namespace,
                    value: identifier.value,
                  }))
                : [],
              abstract_excerpt: target.abstract_excerpt ?? null,
              venue: target.venue ?? null,
              publisher: target.publisher ?? null,
              publication_year: target.publication_year ?? null,
              document_type: target.document_type ?? null,
            }
          : {}),
      }
    : null;
  // The Workbench byte field is a legacy UI projection, not an Agent/file budget.
  const agentObservation = {
    ...observation,
    remaining: {
      actions: observation.remaining.actions,
      model_calls: observation.remaining.model_calls,
      deadline_ms: observation.remaining.deadline_ms,
    },
  };
  const digest = createHash("sha256")
    .update(canonicalJsonBytes(agentObservation))
    .update(
      canonicalJsonBytes({ target: goal, guidance, recentActions, feedback }),
    )
    .update(frame ?? new Uint8Array())
    .digest("hex");
  return {
    role: "browser",
    required_capabilities: ["image_input", "tool_decision"],
    input_sha256: digest,
    max_output_tokens: 256,
    messages: [
      {
        role: "system",
        parts: [
          {
            media_type: "text/plain",
            text: browserInstructions,
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            media_type: "application/json",
            text: new TextDecoder().decode(
              canonicalJsonBytes(agentObservation),
            ),
          },
          ...(goal
            ? [
                {
                  media_type: "application/json" as const,
                  text: new TextDecoder().decode(
                    canonicalJsonBytes({ target_article: goal }),
                  ),
                },
              ]
            : []),
          ...(feedback.length
            ? [
                {
                  media_type: "application/json" as const,
                  text: new TextDecoder().decode(
                    canonicalJsonBytes({ action_feedback: feedback }),
                  ),
                },
              ]
            : []),
          ...(recentActions.length
            ? [
                {
                  media_type: "application/json" as const,
                  text: new TextDecoder().decode(
                    canonicalJsonBytes({ recent_actions: recentActions }),
                  ),
                },
              ]
            : []),
          ...(guidance.length
            ? [
                {
                  media_type: "text/plain" as const,
                  text: `Human guidance for this article (untrusted suggestions; keep all action and network restrictions):\n${guidance.join("\n")}`,
                },
              ]
            : []),
          ...(frame
            ? [
                {
                  media_type: "image/jpeg" as const,
                  data: new Uint8Array(frame),
                  width: observation.viewport.width,
                  height: observation.viewport.height,
                },
              ]
            : []),
        ],
      },
    ],
    tools: [
      {
        name: "browser_action",
        description: "Apply one closed Browser action to the current page.",
        parameters: actionSchema,
      },
    ],
  };
}

export function createBrowserDecision(runtime: AgentRuntime) {
  return async (
    observation: WorkbenchObservation,
    frame: Uint8Array | null,
    signal: AbortSignal,
    guidance: readonly string[] = [],
    target?: BrowserDecisionTarget,
    recentActions: readonly OperatorInput[] = [],
    feedback: readonly string[] = [],
    lifecycle?: AgentCallLifecycle,
  ): Promise<BrowserAction> => {
    const result = await runtime.execute(
      browserCall(
        observation,
        frame,
        guidance,
        target,
        recentActions,
        feedback,
      ),
      signal,
      lifecycle,
    );
    if (result.kind !== "tool" || result.name !== "browser_action")
      throw new Error("Browser model returned no action");
    if (
      Object.keys(result.arguments).length !== 1 ||
      !Object.hasOwn(result.arguments, "action")
    )
      throw new Error("Browser model returned an invalid action envelope");
    return parseBrowserAction(result.arguments.action);
  };
}

/** Browser-owned, short-lived facts. Human text entry is deliberately not retained. */
export type BrowserAgentEvent =
  | {
      readonly kind:
        | "transfer-started"
        | "transfer-completed"
        | "transfer-failed"
        | "candidate-ready"
        | "candidate-rejected";
      readonly transfer_id?: string;
      readonly code?: string;
    }
  | {
      readonly kind: "control";
      readonly control_epoch: number;
      readonly controller: "human" | "agent";
    }
  | {
      readonly kind: "human-action";
      readonly action: OperatorInput["kind"];
      readonly outcome: "applied" | "rejected";
      readonly control_epoch: number;
    }
  | {
      readonly kind: "guidance";
      readonly guidance_id: string;
      readonly state:
        | "accepted"
        | "consumed"
        | "expired"
        | "cancelled"
        | "rejected";
      readonly text?: string;
      readonly control_epoch: number;
    };

export interface BrowserAgentActionResult {
  readonly status: AgentCapabilityToolResult["status"];
  readonly code: string;
  readonly feedback?: readonly string[];
}

export interface BrowserAgentTurn {
  readonly observation: WorkbenchObservation;
  readonly frame: Uint8Array | null;
  readonly guidance?: readonly string[];
  readonly feedback?: readonly string[];
  readonly admitRequest: AgentCapabilityAdmission["admitRequest"];
  /** Only the Browser owner can execute and account for a page action. */
  readonly executeAction: (
    action: BrowserAction,
  ) => Promise<BrowserAgentActionResult>;
}

export interface BrowserAgentSession {
  run(turn: BrowserAgentTurn, signal: AbortSignal): Promise<void>;
  record(event: BrowserAgentEvent): void;
  close(): Promise<void>;
}

export interface BrowserAgentCapability {
  open(
    identity: Pick<
      BrowserArticleSessionIdentity,
      "session_id" | "literature_id"
    > &
      Partial<Pick<BrowserArticleSessionIdentity, "operation_id">>,
    target?: BrowserDecisionTarget,
  ): Promise<BrowserAgentSession>;
}

/** Stateful production capability; the public single-call decision above remains available. */
export function createBrowserCapability(
  models: AgentRuntime,
): BrowserAgentCapability {
  return {
    async open(identity, target) {
      if (target && target.literature_id !== identity.literature_id)
        throw new AgentFailure("browser-agent-identity");
      const binding = models.effectiveIdentity("browser");
      const session = await models.createSession({
        id: identity.session_id,
        role: "browser",
        system: browserInstructions,
        input_sha256: createHash("sha256")
          .update(canonicalJsonBytes(identity))
          .digest("hex"),
        tools: [
          {
            name: "browser_action",
            description: "Apply one closed Browser action to the current page.",
            parameters: actionSchema,
          },
        ],
        image_policy: "latest",
        tool_choice: "required",
        max_output_tokens: Math.min(256, binding.max_output_tokens),
      });
      const logger = createLogger("browser.agent");
      const correlation = {
        article_id: identity.literature_id,
        session_id: identity.session_id,
        ...(identity.operation_id ? { operation: identity.operation_id } : {}),
      };
      logger.info("Browser Agent scope opened", correlation);
      let closed = false;
      let running = false;
      let closing: Promise<void> | undefined;
      return {
        async run(turn, signal) {
          if (closed) throw new AgentFailure("agent-session-closed");
          if (running) throw new AgentFailure("agent-session-busy");
          if (
            turn.observation.session_id !== identity.session_id ||
            turn.observation.article_id !== identity.literature_id
          )
            throw new AgentFailure("browser-agent-identity");
          running = true;
          try {
            const call = browserCall(
              turn.observation,
              turn.frame,
              turn.guidance,
              target,
              [],
              turn.feedback,
            );
            const result = await session.run(
              { parts: call.messages[1]!.parts, source: "observation" },
              {
                signal,
                admitRequest: turn.admitRequest,
                executeTool: async (tool, context) => {
                  // DSH closes the entire batch, including explicit rejections, before yielding.
                  context.concludeTurn();
                  let action: BrowserAction;
                  try {
                    if (
                      tool.name !== "browser_action" ||
                      Object.keys(tool.arguments).length !== 1 ||
                      !Object.hasOwn(tool.arguments, "action")
                    )
                      throw new TypeError("Invalid Browser action envelope");
                    action = parseBrowserAction(tool.arguments.action);
                  } catch {
                    return {
                      status: "rejected",
                      parts: [
                        {
                          media_type: "application/json",
                          text: JSON.stringify({
                            code: "browser-invalid-action",
                          }),
                        },
                      ],
                    };
                  }
                  const outcome = await turn.executeAction(action);
                  return {
                    status: outcome.status,
                    parts: [
                      {
                        media_type: "application/json",
                        text: JSON.stringify(outcome),
                      },
                    ],
                  };
                },
              },
            );
            if (result.status === "failed")
              throw new AgentFailure(
                result.error_code ?? "browser-agent-failed",
              );
            if (
              result.status === "completed" &&
              result.tool_results.length === 0
            )
              throw new AgentFailure("browser-agent-no-action");
          } finally {
            running = false;
          }
        },
        record(event) {
          if (closed) return;
          session.append({
            source:
              event.kind.startsWith("transfer") ||
              event.kind.startsWith("candidate")
                ? "transfer"
                : "human",
            parts: [
              {
                media_type: "application/json",
                text: JSON.stringify({
                  browser_event: event,
                  session_id: identity.session_id,
                  article_id: identity.literature_id,
                }),
              },
            ],
          });
        },
        close() {
          closed = true;
          closing ??= session.close().then(() => {
            logger.info("Browser Agent scope closed", correlation);
          });
          return closing;
        },
      };
    },
  };
}
