import {
  parseAssetId,
  parseProcessorCitation,
  processorJson,
  type ProcessorJson,
  type ProcessorRecord,
} from "@sciretriever/contracts";
import { record, listField, stringField } from "../../data/wire.js";
export type ResultRow = ProcessorRecord & { result_id: string };
export function display(value: ProcessorJson): string {
  if (value === null) return "无法判断 / 未报告";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "object") {
    const text = String(value);
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  }
  if (!Array.isArray(value) && typeof value.raw === "string")
    return `${value.raw}${typeof value.unit === "string" ? ` ${value.unit}` : ""}`;
  return JSON.stringify(value);
}
export const rowKey = (row: ResultRow) =>
  JSON.stringify([row.result_id, row.record_id]);
export const pointerFor = (field: string) =>
  field.startsWith("/")
    ? field
    : `/${field.replace(/~/g, "~0").replace(/\//g, "~1")}`;
export function parseRow(value: unknown): ResultRow {
  const row = record(value, "result row");
  const missing = record(row.missing, "missing fields");
  if (Object.values(missing).some((v) => typeof v !== "string"))
    throw new Error("缺失字段说明无效");
  return {
    result_id: String(parseAssetId(row.result_id)),
    record_id: stringField(row, "record_id"),
    payload: processorJson(row.payload, 8 * 1024 * 1024),
    missing: missing as Record<string, string>,
    evidence: listField(row, "evidence").map((value) => {
      const source = record(value, "field evidence");
      return {
        pointer: stringField(source, "pointer"),
        sources: listField(source, "sources").map(parseProcessorCitation),
      };
    }),
  };
}
export function schemaFor(
  schema: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const keys = field.startsWith("/")
    ? field
        .slice(1)
        .split("/")
        .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
    : [field];
  let current = schema;
  for (const key of keys) {
    const variants = [
      current,
      ...(Array.isArray(current.anyOf) ? current.anyOf : []),
    ];
    let next: Record<string, unknown> | null = null;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant))
        continue;
      const properties = (variant as Record<string, unknown>).properties;
      if (
        !properties ||
        typeof properties !== "object" ||
        Array.isArray(properties)
      )
        continue;
      const value = (properties as Record<string, unknown>)[key];
      if (value && typeof value === "object" && !Array.isArray(value))
        next = value as Record<string, unknown>;
    }
    if (!next) return {};
    current = next;
  }
  return current;
}
export function fieldType(schema: Record<string, unknown>): string {
  const values = [schema, ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])];
  for (const raw of values) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const type = (raw as Record<string, unknown>).type;
    const types = Array.isArray(type) ? type : [type];
    for (const t of [
      "number",
      "integer",
      "boolean",
      "string",
      "object",
      "array",
    ])
      if (types.includes(t)) return t;
  }
  return "string";
}
