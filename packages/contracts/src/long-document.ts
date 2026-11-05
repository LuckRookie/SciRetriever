import { ContractValidationError } from "./index.js";

export const ARRANGE_INPUT_MAX_BYTES = 384 * 1024;
export const LONG_DOCUMENT_MAX_PAGES = 50;
export interface ArchiveDocumentClassification {
  readonly pages: number;
  readonly arrange_input_bytes: number;
  readonly reasons: readonly ("pages" | "arrange-input")[];
}
export type LongDocumentInfo = ArchiveDocumentClassification;
export function classifyArchiveDocument(
  pages: number,
  arrange_input_bytes: number,
): ArchiveDocumentClassification {
  if (
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    pages > 10000 ||
    !Number.isSafeInteger(arrange_input_bytes) ||
    arrange_input_bytes < 0
  )
    throw new ContractValidationError();
  return {
    pages,
    arrange_input_bytes,
    reasons: [
      ...(pages > LONG_DOCUMENT_MAX_PAGES ? ["pages" as const] : []),
      ...(arrange_input_bytes > ARRANGE_INPUT_MAX_BYTES
        ? ["arrange-input" as const]
        : []),
    ],
  };
}
export function parseArchiveDocumentClassification(
  value: unknown,
): ArchiveDocumentClassification {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "arrange_input_bytes,pages,reasons"
  )
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  const classification = classifyArchiveDocument(
    r.pages as number,
    r.arrange_input_bytes as number,
  );
  if (
    !Array.isArray(r.reasons) ||
    JSON.stringify(r.reasons) !== JSON.stringify(classification.reasons)
  )
    throw new ContractValidationError();
  return classification;
}
export function longDocumentInfo(
  value?: ArchiveDocumentClassification,
): LongDocumentInfo | null {
  return value?.reasons.length ? value : null;
}
export function parseLongDocumentInfo(value: unknown): LongDocumentInfo {
  const info = parseArchiveDocumentClassification(value);
  if (!info.reasons.length) throw new ContractValidationError();
  return info;
}
