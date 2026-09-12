import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  parseBrowserAction,
  type BrowserAction,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import type { AgentRuntime } from "../agents/runtime.js";

const actionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: [
        "click-element",
        "click-point",
        "scroll-surface",
        "go-back",
        "wait-for-change",
        "stop",
      ],
    },
    element_id: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    revision: { type: "integer" },
    viewport_version: { type: "integer" },
    delta_x: { type: "number" },
    delta_y: { type: "number" },
    timeout_ms: { type: "integer" },
    reason: { type: "string", enum: ["user", "budget", "cancel"] },
  },
  required: ["kind"],
} as const;

export function createBrowserDecision(runtime: AgentRuntime) {
  return async (
    observation: WorkbenchObservation,
    frame: Uint8Array | null,
    signal: AbortSignal,
  ): Promise<BrowserAction> => {
    const digest = createHash("sha256")
      .update(canonicalJsonBytes(observation))
      .update(frame ?? new Uint8Array())
      .digest("hex");
    const result = await runtime.execute(
      {
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
                text: "Choose exactly one declared Browser action. Never request text entry, keys, selectors, scripts, files, credentials, or a new URL. Use the current observation revision and viewport version.",
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                media_type: "application/json",
                text: new TextDecoder().decode(canonicalJsonBytes(observation)),
              },
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
      },
      signal,
    );
    if (result.kind !== "tool" || result.name !== "browser_action")
      throw new Error("Browser model returned no action");
    return parseBrowserAction(result.arguments);
  };
}
