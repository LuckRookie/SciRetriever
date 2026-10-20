import {
  ContractValidationError,
  parseEvidenceRef,
  type EvidenceRef,
} from "./index.js";
import { extractionCanonicalJsonBytes } from "./extraction.js";
const SUMMARY_MAX_CONTENT_BYTES = 512 * 1024;
export interface SummaryStatement {
  readonly statement_id: string;
  readonly category:
    | "finding"
    | "method"
    | "result"
    | "limitation"
    | "disagreement";
  readonly epistemic: "reported" | "inference";
  readonly text: string;
  readonly conditions: readonly string[];
  readonly quantity: null | {
    readonly value: string;
    readonly unit: string;
    readonly comparison_basis: string | null;
  };
  readonly evidence: readonly EvidenceRef[];
}
export interface SummaryContent {
  readonly schema_version: 1;
  readonly title: string;
  readonly statements: readonly SummaryStatement[];
}
function fail(): never {
  throw new ContractValidationError();
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, maxBytes: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code <= 31 && ![9, 10, 13].includes(code)) ||
        (code >= 127 && code <= 159)
      );
    }) ||
    (!allowEmpty && !value.trim()) ||
    new TextEncoder().encode(value).length > maxBytes
  )
    fail();
  return value;
}
function boundedSnapshot(value: unknown, limit: number): unknown {
  return JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, limit, {
        maxDepth: 32,
        maxNodes: 20480,
        maxArrayLength: 20480,
      }),
    ),
  ) as unknown;
}
export function parseSummaryContent(value: unknown): SummaryContent {
  const r = exact(boundedSnapshot(value, SUMMARY_MAX_CONTENT_BYTES), [
    "schema_version",
    "title",
    "statements",
  ]);
  if (
    r.schema_version !== 1 ||
    !Array.isArray(r.statements) ||
    r.statements.length < 1
  )
    fail();
  const ids = new Set<string>();
  const statements: SummaryStatement[] = r.statements.map((entry) => {
    const s = exact(entry, [
      "statement_id",
      "category",
      "epistemic",
      "text",
      "conditions",
      "quantity",
      "evidence",
    ]);
    const id = string(s.statement_id, 128);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id) ||
      ids.has(id) ||
      !["finding", "method", "result", "limitation", "disagreement"].includes(
        s.category as string,
      ) ||
      !["reported", "inference"].includes(s.epistemic as string) ||
      !Array.isArray(s.conditions) ||
      !Array.isArray(s.evidence) ||
      s.evidence.length < 1
    )
      fail();
    ids.add(id);
    const quantity =
      s.quantity === null
        ? null
        : exact(s.quantity, ["value", "unit", "comparison_basis"]);
    return Object.freeze({
      statement_id: id,
      category: s.category as SummaryStatement["category"],
      epistemic: s.epistemic as SummaryStatement["epistemic"],
      text: string(s.text, SUMMARY_MAX_CONTENT_BYTES),
      conditions: Object.freeze(
        s.conditions.map((item) => string(item, SUMMARY_MAX_CONTENT_BYTES)),
      ),
      quantity:
        quantity === null
          ? null
          : Object.freeze({
              value: string(quantity.value, SUMMARY_MAX_CONTENT_BYTES),
              unit: string(quantity.unit, SUMMARY_MAX_CONTENT_BYTES),
              comparison_basis:
                quantity.comparison_basis === null
                  ? null
                  : string(
                      quantity.comparison_basis,
                      SUMMARY_MAX_CONTENT_BYTES,
                    ),
            }),
      evidence: Object.freeze(s.evidence.map((item) => parseEvidenceRef(item))),
    });
  });
  return Object.freeze({
    schema_version: 1,
    title: string(r.title, SUMMARY_MAX_CONTENT_BYTES),
    statements: Object.freeze(statements),
  });
}
export function summaryContentBytes(value: SummaryContent): Uint8Array {
  return extractionCanonicalJsonBytes(
    parseSummaryContent(value),
    SUMMARY_MAX_CONTENT_BYTES,
    { maxDepth: 32, maxNodes: 20480, maxArrayLength: 20480 },
  );
}
