import type { AgentCall, AgentResult } from "../src/agents/protocol.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import { dshAnalysisAdapter } from "./dsh-analysis-fixture.js";
export function longRuntime(
  options: {
    outputTokens?: number;
    invalidEvidence?: boolean;
    invalidQuantity?: boolean;
    notApplicable?: boolean;
    onModel?: (
      request: import("../src/agents/model-protocol.js").ModelRequest,
      index: number,
    ) => void;
  } = {},
) {
  const calls: AgentCall[] = [];
  const modelCalls: import("../src/agents/model-protocol.js").ModelRequest[] =
    [];
  const adapter = dshAnalysisAdapter({
    provider: "fixture",
    model: "synthetic",
    execute: async (call): Promise<AgentResult> => {
      calls.push(call);
      const part = call.messages[1]!.parts[0]!;
      if (!("text" in part)) throw new Error("Missing text");
      const input = JSON.parse(part.text) as {
        segments: { segment_id: string; text: string }[];
      };
      const markers = [
        ["DRY_RESULT_4.2_eV", "4.2 eV under dry conditions"],
        ["NEGATED_IMPROVEMENT", "The treatment did not improve yield"],
        [
          "WET_CONTRADICTION_5.1_eV",
          "5.1 eV under wet conditions contradicts dry result",
        ],
        ["CANNOT_REDUCE", "It cannot reduce energy"],
        ["CHINESE_NEGATION", "结果未显著改善"],
        ["AFFIRMATIVE_CONTROL", "The control improved yield"],
        ["measurement was 4.2 eV", "4.2 eV under dry conditions"],
        ["MEASURE_4.2_eV", "4.2 eV under dry-only conditions"],
      ];
      const statements = options.notApplicable
        ? []
        : markers.flatMap(([marker, text]) => {
            const segment = input.segments.find((s) =>
              s.text.includes(marker!),
            );
            if (!segment) return [];
            const condition = input.segments.find((s) =>
              s.text.includes("CONDITION_DRY_ONLY"),
            );
            return [
              {
                statement_id: `s${markers.findIndex((m) => m[0] === marker)}`,
                category: marker!.includes("WET") ? "disagreement" : "result",
                epistemic: "reported",
                text,
                conditions: condition ? ["dry only"] : [],
                quantity: options.invalidQuantity
                  ? { value: "4.2", unit: "eV" }
                  : null,
                evidence_segment_ids: options.invalidEvidence
                  ? ["forged"]
                  : [
                      ...new Set([
                        segment.segment_id,
                        ...(condition ? [condition.segment_id] : []),
                      ]),
                    ],
              },
            ];
          });
      return {
        kind: "structured",
        value: {
          outcome: statements.length ? "completed" : "not_applicable",
          title: "Synthetic analysis",
          statements,
        },
        provenance: {
          provider: "fixture",
          model: "synthetic",
          usage: {
            input_tokens: 100,
            output_tokens: options.outputTokens ?? 50,
          },
        },
      };
    },
  });
  return {
    calls,
    modelCalls,
    agent: new DshAgentRuntime([
      {
        role: "analysis",
        provider: "fixture",
        model: "synthetic",
        capabilities: ["structured_text", "tool_decision"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 1000000,
        max_output_tokens: 10000,
        adapter: {
          ...adapter,
          executeModel: async (request, ...args) => {
            modelCalls.push(request);
            options.onModel?.(request, modelCalls.length);
            return adapter.executeModel!(request, ...args);
          },
        },
      },
    ]),
  };
}
