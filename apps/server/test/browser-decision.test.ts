import { expect, it } from "vitest";
import type { AgentCall, AgentResult } from "../src/agents/protocol.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { createBrowserDecision } from "../src/browser/decision.js";
import { parseWorkbenchObservation } from "@sciretriever/contracts";

const observation = parseWorkbenchObservation({
  session_id: "session-1",
  article_id: "article-1",
  page_id: "page-1",
  document_generation: 1,
  observation_revision: 2,
  viewport_revision: 3,
  control_epoch: 4,
  frame_seq: 2,
  frame_available: true,
  frame_dropped: false,
  observed_at: "2026-09-10T00:00:00Z",
  url: "http://127.0.0.1/article",
  title: "Fixture",
  text: "Download PDF",
  loading: false,
  partial: false,
  page_state: "NORMAL",
  capture_state: "NONE",
  viewport: { width: 800, height: 600, device_scale_factor: 1 },
  elements: [
    {
      element_id: "element-1",
      role: "link",
      name: "Download PDF",
      editable: false,
    },
  ],
  remaining: { actions: 5, model_calls: 2, bytes: 1000, deadline_ms: 5000 },
});

function runtime(result: (call: AgentCall) => AgentResult): AgentRuntime {
  return new AgentRuntime([
    {
      role: "browser",
      provider: "fixture-provider",
      model: "fixture-model",
      capabilities: ["image_input", "tool_decision"],
      reasoning: "default",
      stream: false,
      context_window_tokens: 4096,
      max_output_tokens: 512,
      adapter: {
        provider: "fixture-provider",
        model: "fixture-model",
        execute: async (call) => result(call),
      },
    },
  ]);
}

it("composes an image-bound Browser decision and admits only the six closed actions", async () => {
  let captured: AgentCall | undefined;
  const agents = runtime((call) => {
    captured = call;
    return {
      kind: "tool",
      name: "browser_action",
      arguments: {
        kind: "click-element",
        element_id: "element-1",
        revision: 2,
      },
      provenance: {
        provider: "fixture-provider",
        model: "fixture-model",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  });
  await expect(
    createBrowserDecision(agents)(
      observation,
      new Uint8Array([1, 2]),
      new AbortController().signal,
    ),
  ).resolves.toEqual({
    kind: "click-element",
    element_id: "element-1",
    revision: 2,
  });
  expect(captured?.required_capabilities).toEqual([
    "image_input",
    "tool_decision",
  ]);
  expect(
    captured?.messages[1]?.parts.some(
      (part) => part.media_type === "image/jpeg",
    ),
  ).toBe(true);

  const unsafe = runtime(() => ({
    kind: "tool",
    name: "browser_action",
    arguments: {
      kind: "type-text",
      element_id: "element-1",
      text: "secret",
      revision: 2,
    },
    provenance: {
      provider: "fixture-provider",
      model: "fixture-model",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  await expect(
    createBrowserDecision(unsafe)(
      observation,
      null,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
