import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { createDshCapabilityRuntime } from "../src/agents/dsh/index.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import { AgentTraceService } from "../src/application/agent-traces.js";
import { conversationRecord } from "../src/application/conversation-record.js";
import {
  parseAgentConversationEvent,
  CONVERSATION_EVENTS,
  type AgentConversationEvent,
} from "@sciretriever/contracts";

it(
  "persists live verbatim DSH messages with ordered tools and image placeholders",
  { timeout: 0 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-conversation-")),
      app = await createApplication(home);
    const runtime = await createDshCapabilityRuntime(),
      traces = new AgentTraceService(app.database);
    let release: () => void = () => {},
      entered: () => void = () => {};
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    const trace = await traces.start({
      session_id: "conversation",
      role: "analysis",
      provider: "fixture",
      model: "fake",
      context: { actor: "cli:fixture" },
      subject: {},
    });
    let calls = 0;
    const session = await runtime.createSession({
      id: "conversation",
      role: "analysis",
      system: "System\n  preserved.",
      input_sha256: "a".repeat(64),
      tools: [
        {
          name: "inspect",
          description: "Synthetic inspection",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      modelContext: {
        provider: "fixture",
        model: "fake",
        context_window_tokens: 100000,
        max_output_tokens: 1000,
      },
      observeEvent: (e) => trace.event(e.event_type, e),
      modelCall: async () => {
        calls++;
        entered();
        if (calls === 1) await gate;
        return {
          message: {
            role: "assistant",
            parts: [
              {
                media_type: "text/plain",
                text: calls === 1 ? "Look\n  carefully." : "Complete.",
              },
            ],
            ...(calls === 1
              ? {
                  tool_calls: [
                    { id: "inspect-1", name: "inspect", arguments: {} },
                  ],
                }
              : {}),
          },
          stop_reason: calls === 1 ? "tool_calls" : "complete",
          provenance: {
            provider: "fixture",
            model: "fake",
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        };
      },
    });
    let running: Promise<unknown> | undefined;
    const read = () =>
      app.database.review<{
        events: { sequence: number; kind: string; value: unknown }[];
        next_after: number | null;
      }>("session-read", { session_id: "conversation", limit: 100 });
    try {
      session.append({
        parts: [{ media_type: "text/plain", text: "Extra\ncontext" }],
      });
      running = session.run(
        {
          parts: [
            { media_type: "text/plain", text: "Question\n  preserved." },
            {
              media_type: "image/png",
              data: new Uint8Array([1, 2, 3]),
              width: 1,
              height: 1,
            },
          ],
        },
        {
          admitRequest: () => ({ onDispatched() {} }),
          executeTool: async () => ({
            status: "success",
            parts: [
              { media_type: "application/json", text: '{ "answer": 42 }' },
            ],
          }),
        },
      );
      await started;
      await trace.flush();
      const live = await read();
      expect(live.events.some((e) => e.kind === "user/message")).toBe(true);
      expect(live.events.some((e) => e.kind === "system/message")).toBe(true);
      release();
      await running;
      await trace.finish("completed");
      const log = await read(),
        messages = log.events
          .filter((e) =>
            CONVERSATION_EVENTS.includes(
              e.kind as AgentConversationEvent["event_type"],
            ),
          )
          .map((e) => parseAgentConversationEvent(e.value));
      expect(
        messages.some(
          (m) => m.role === "context" && m.text === "Extra\ncontext",
        ),
      ).toBe(true);
      expect(
        messages.some(
          (m) =>
            m.role === "user" &&
            m.text === "Question\n  preserved.\n[图片未保存]" &&
            m.images_omitted === 1,
        ),
      ).toBe(true);
      expect(
        messages.some(
          (m) => m.role === "system" && m.text.includes("System\n  preserved."),
        ),
      ).toBe(true);
      const assistant = messages.find((m) => m.tool_calls.length)!;
      expect(assistant.text).toBe("Look\n  carefully.");
      expect(assistant.tool_calls).toEqual([
        { id: "inspect-1", name: "inspect", arguments: "{}" },
      ]);
      const result = messages.find((m) => m.role === "tool")!;
      expect(result.tool_results).toEqual([
        {
          id: "inspect-1",
          name: "inspect",
          text: '{ "answer": 42 }',
          status: "success",
        },
      ]);
      expect(
        messages.every(
          (m, n) => n === 0 || m.sequence > messages[n - 1]!.sequence,
        ),
      ).toBe(true);
      expect(JSON.stringify(log)).not.toContain("attachmentId");
    } finally {
      release();
      await running;
      await session.close();
      await runtime.close();
      await traces.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
it("bounds visible messages without parsing ordinary tool JSON and removes credential and hidden-reasoning fields", () => {
  const base: AgentConversationEvent = {
    event_type: "assistant/message",
    role: "assistant",
    timestamp: "2026-10-22T00:00:00.000Z",
    sequence: 1,
    text: "one\n two",
    tool_calls: [
      {
        id: "a",
        name: "inspect",
        arguments:
          '{ "value": 42, "token": "fixture-secret", "reasoning_content": "hidden-only" }',
      },
    ],
    tool_results: [],
    images_omitted: 0,
    truncated: false,
  };
  const clean = conversationRecord(base);
  expect(clean.summary.text).toBe(base.text);
  expect(JSON.parse(clean.summary.tool_calls[0]!.arguments)).toEqual({
    value: 42,
    token: "[redacted]",
    reasoning_content: "[redacted]",
  });
  expect(JSON.stringify(clean)).not.toMatch(/fixture-secret|hidden-only/);
  const raw = '{ "value": 42, "notes": "line\\nnext" }';
  expect(
    conversationRecord({
      ...base,
      tool_calls: [{ id: "b", name: "inspect", arguments: raw }],
    }).summary.tool_calls[0]!.arguments,
  ).toBe(raw);
  const nested = conversationRecord({
    ...base,
    text: JSON.stringify({
      payload: JSON.stringify({ api_key: "fixture-nested-secret", safe: 42 }),
      image_bytes: [1, 2, 3],
    }),
  });
  expect(JSON.stringify(nested)).not.toContain("fixture-nested-secret");
  expect(JSON.parse(JSON.parse(nested.summary.text).payload)).toEqual({
    api_key: "[redacted]",
    safe: 42,
  });
  expect(JSON.parse(nested.summary.text).image_bytes).toBe("[redacted]");
  let deep: unknown = { token: "fixture-deep-secret" };
  for (let n = 0; n < 40; n++) deep = { nested: deep };
  const bounded = conversationRecord({ ...base, text: JSON.stringify(deep) });
  expect(bounded.truncated).toBe(true);
  expect(bounded.summary.text).not.toContain("fixture-deep-secret");
  expect(bounded.summary.text).toContain("[nested content omitted]");
  const big = conversationRecord({ ...base, text: "汉".repeat(100000) });
  expect(big.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(big.summary))).toBeLessThanOrEqual(
    60000,
  );
});
it(
  "records visible input and output for direct calls through the DSH foundation",
  { timeout: 0 },
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-direct-conversation-"),
    );
    const app = await createApplication(home),
      traces = new AgentTraceService(app.database);
    const runtime = new DshAgentRuntime(
      [
        {
          role: "analysis",
          provider: "fixture",
          model: "fake",
          capabilities: ["structured_text"],
          reasoning: "default",
          stream: false,
          context_window_tokens: 100000,
          max_output_tokens: 1000,
          adapter: {
            provider: "fixture",
            model: "fake",
            execute: async (_call, _options, _signal, lifecycle) => {
              lifecycle?.onDispatched();
              return {
                kind: "structured",
                value: { answer: 42 },
                provenance: {
                  provider: "fixture",
                  model: "fake",
                  usage: { input_tokens: 10, output_tokens: 2 },
                },
              };
            },
          },
        },
      ],
      traces,
    );
    try {
      await runtime.execute({
        role: "analysis",
        messages: [
          {
            role: "system",
            parts: [{ media_type: "text/plain", text: "System\n  exact" }],
          },
          {
            role: "user",
            parts: [{ media_type: "text/plain", text: "Question\n  exact" }],
          },
        ],
        input_sha256: "b".repeat(64),
        required_capabilities: ["structured_text"],
        max_output_tokens: 100,
      });
      const list = await app.database.review<{
        items: { session_id: string; calls: number }[];
      }>("session-list", {});
      expect(list.items).toHaveLength(1);
      expect(list.items[0]!.calls).toBe(1);
      const log = await app.database.review<{
        events: { kind: string; value: unknown }[];
      }>("session-read", { session_id: list.items[0]!.session_id });
      const messages = log.events
        .filter((e) =>
          CONVERSATION_EVENTS.includes(
            e.kind as AgentConversationEvent["event_type"],
          ),
        )
        .map((e) => parseAgentConversationEvent(e.value));
      expect(messages.map((m) => [m.role, m.text])).toEqual([
        ["system", "System\n  exact"],
        ["user", "Question\n  exact"],
        ["assistant", '{"answer":42}'],
      ]);
      expect(messages.map((m) => m.sequence)).toEqual([0, 1, 2]);
    } finally {
      await runtime.close();
      await traces.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
