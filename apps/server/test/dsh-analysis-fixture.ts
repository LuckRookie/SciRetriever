import { randomUUID } from "node:crypto";
import { type AgentAdapter, type AgentResult } from "../src/agents/protocol.js";
import type {
  ModelRequest,
  ModelResponse,
} from "../src/agents/model-protocol.js";

/** Synthetic model policy: navigate the real DSH tools, then use the test's answer generator. */
export function dshAnalysisAdapter(adapter: AgentAdapter): AgentAdapter {
  return {
    ...adapter,
    executeModel: async (request, options, signal, lifecycle) => {
      lifecycle?.onDispatched();
      const first = request.messages
        .find((m) => m.role === "user")
        ?.parts.find((p) => "text" in p);
      if (!first || !("text" in first))
        throw new Error("Missing synthetic task input");
      const initial = JSON.parse(first.text) as Record<string, unknown>;
      const history = request.messages.filter((m) => m.role === "tool");
      if (history.some((m) => m.name === "submit_result"))
        return {
          message: {
            role: "assistant",
            parts: [
              {
                media_type: "text/plain",
                text: "Synthetic invalid result remains rejected.",
              },
            ],
          },
          stop_reason: "complete",
          provenance: {
            provider: adapter.provider,
            model: adapter.model,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
      const invoke = (
        name: string,
        args: Record<string, unknown>,
      ): ModelResponse => ({
        message: {
          role: "assistant",
          parts: [],
          tool_calls: [{ id: randomUUID(), name, arguments: args }],
        },
        stop_reason: "tool_calls",
        provenance: {
          provider: adapter.provider,
          model: adapter.model,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      const pages = history
        .filter((m) => m.name === "read_document")
        .map(
          (m) =>
            JSON.parse(
              m.parts
                .filter((p) => "text" in p)
                .map((p) => p.text)
                .join(""),
            ) as {
              segments: {
                segment_id: string;
                text: string;
                start_utf8: number;
                end_utf8: number;
              }[];
              next_start_utf8: number | null;
            },
        );
      if (request.tools?.some((t) => t.name === "read_document")) {
        const next = pages.length ? pages.at(-1)!.next_start_utf8 : 0;
        if (next !== null) return invoke("read_document", { start_utf8: next });
      }
      if (initial.image_input === true && Array.isArray(initial.resources)) {
        const viewed = new Set(
          request.messages.flatMap((m) =>
            m.role === "assistant"
              ? (m.tool_calls ?? [])
                  .filter((c) => c.name === "view_image")
                  .map((c) => c.arguments.resource_id)
              : [],
          ),
        );
        const unread = (
          initial.resources as {
            resource_id: string;
            artifact: { media_type: string };
          }[]
        ).find(
          (r) =>
            /^image\/(png|jpeg|webp)$/.test(r.artifact.media_type) &&
            !viewed.has(r.resource_id),
        );
        if (unread)
          return invoke("view_image", { resource_id: unread.resource_id });
      }
      const segments = new Map<string, string>();
      for (const page of pages)
        for (const s of page.segments)
          segments.set(
            s.segment_id,
            (segments.get(s.segment_id) ?? "") + s.text,
          );
      const values = [...segments].map(([segment_id, text]) => ({
        segment_id,
        text,
      }));
      const input = {
        ...initial,
        ...(pages.length
          ? { segments: values, core: values, before: [], after: [] }
          : {}),
      };
      const result: AgentResult = await adapter.execute(
        {
          role: request.role,
          required_capabilities: ["structured_text"],
          input_sha256: request.input_sha256,
          messages: [
            {
              role: "system",
              parts: request.messages
                .filter((m) => m.role === "system")
                .flatMap((m) => m.parts),
            },
            {
              role: "user",
              parts: [
                { media_type: "application/json", text: JSON.stringify(input) },
              ],
            },
          ],
          response_schema: request.tools!.find(
            (t) => t.name === "submit_result",
          )!.parameters,
        },
        options,
        signal,
      );
      if (result.kind !== "structured")
        throw new Error("Synthetic answer must be structured");
      return {
        ...invoke("submit_result", result.value),
        provenance: result.provenance,
      };
    },
  };
}

/** Chat-completions wire facade used by production-object-graph fixtures. */
export async function dshChatReply(
  wire: {
    messages: readonly {
      role: string;
      content: unknown;
      tool_call_id?: string;
      tool_calls?: readonly {
        id: string;
        function: { name: string; arguments: string };
      }[];
    }[];
    tools?: readonly {
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }[];
  },
  answer: (input: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const tools = wire.tools?.map((t) => t.function);
  const names = new Map(
    wire.messages
      .flatMap((m) => m.tool_calls ?? [])
      .map((t) => [t.id, t.function.name]),
  );
  const messages = wire.messages.map((m) => {
    const parts = [
      {
        media_type: "text/plain" as const,
        text:
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("")
              : "",
      },
    ];
    if (m.role === "tool") {
      const envelope = JSON.parse(parts[0]!.text) as {
        status: "success";
        content: string[];
      };
      return {
        role: "tool" as const,
        tool_call_id: m.tool_call_id!,
        name: names.get(m.tool_call_id!)!,
        status: "success" as const,
        parts: [
          {
            media_type: "application/json" as const,
            text: envelope.content.join(""),
          },
        ],
      };
    }
    if (m.role === "assistant")
      return {
        role: "assistant" as const,
        parts,
        tool_calls: (m.tool_calls ?? []).map((t) => ({
          id: t.id,
          name: t.function.name,
          arguments: JSON.parse(t.function.arguments) as Record<
            string,
            unknown
          >,
        })),
      };
    return { role: m.role as "system" | "user", parts };
  });
  const adapter = dshAnalysisAdapter({
    provider: "fixture",
    model: "model",
    execute: async (call) => ({
      kind: "structured",
      value: (await answer(
        JSON.parse(
          (call.messages[1]!.parts[0] as { text: string }).text,
        ) as Record<string, unknown>,
      )) as Record<string, unknown>,
      provenance: {
        provider: "fixture",
        model: "model",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
  });
  const result = await adapter.executeModel!(
    {
      role: "analysis",
      input_sha256: "a".repeat(64),
      required_capabilities: ["tool_decision"],
      messages,
      ...(tools ? { tools } : {}),
    } as ModelRequest,
    { reasoning: "default", stream: false },
  );
  return {
    model: "model",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: result.message.tool_calls!.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.arguments) },
          })),
        },
      },
    ],
    usage: {
      prompt_tokens: result.provenance.usage.input_tokens,
      completion_tokens: result.provenance.usage.output_tokens,
    },
  };
}
