export interface KnowledgeCallAccounting {
  readonly calls_dispatched: number;
  readonly canonical_call_bytes: number;
  readonly reported_calls: number;
  readonly reported_input_tokens: number;
  readonly reported_output_tokens: number;
  readonly usage_complete: boolean;
}

export class KnowledgeAnalysisFailure extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions & {
      readonly reason?: string;
      readonly retryable?: boolean;
      readonly accounting?: KnowledgeCallAccounting;
    },
  ) {
    super("knowledge analysis failed", options);
    this.reason = options?.reason ?? null;
    this.retryable = options?.retryable ?? false;
    this.accounting = options?.accounting ?? null;
  }
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly accounting: KnowledgeCallAccounting | null;
}
export function knowledgeResponseSchema(): Record<string, unknown> {
  const string = { type: "string" };
  const nullableString = { anyOf: [string, { type: "null" }] };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: { type: "string", enum: ["completed", "not_applicable"] },
      title: string,
      statements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            statement_id: string,
            category: {
              type: "string",
              enum: [
                "finding",
                "method",
                "result",
                "limitation",
                "disagreement",
              ],
            },
            epistemic: { type: "string", enum: ["reported", "inference"] },
            text: string,
            conditions: { type: "array", items: string },
            quantity: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    value: string,
                    unit: string,
                    comparison_basis: nullableString,
                  },
                  required: ["value", "unit", "comparison_basis"],
                },
              ],
            },
            evidence_segment_ids: { type: "array", items: string },
          },
          required: [
            "statement_id",
            "category",
            "epistemic",
            "text",
            "conditions",
            "quantity",
            "evidence_segment_ids",
          ],
        },
      },
    },
    required: ["outcome", "title", "statements"],
  };
}
