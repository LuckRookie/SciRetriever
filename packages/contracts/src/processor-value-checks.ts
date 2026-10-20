import { ContractValidationError, canonicalJsonBytes } from "./index.js";
import {
  processorExact,
  processorText,
  processorPointer,
  parseProcessorCitation,
  type ProcessorContent,
  type ProcessorCitation,
  type ProcessorJson,
} from "./processors.js";
export type ProcessorCheckStatus = "text-layer" | "image-checked" | "uncertain";
export interface ProcessorValueCheck {
  readonly record_id: string;
  readonly pointer: string;
  readonly status: ProcessorCheckStatus;
  readonly reason: string;
  readonly sources: readonly {
    readonly citation: ProcessorCitation;
    readonly status: ProcessorCheckStatus;
    readonly reason: string;
  }[];
}
export function processorValues(content: ProcessorContent) {
  const targets: {
    record_id: string;
    pointer: string;
    value: ProcessorJson;
    sources: readonly ProcessorCitation[];
  }[] = [];
  if (content.kind === "report")
    return content.claims.map((c) => ({
      record_id: c.record_id,
      pointer: "",
      value: c.text,
      sources: c.sources,
    }));
  for (const r of content.records) {
    const visit = (value: ProcessorJson, pointer: string) => {
      if (Array.isArray(value) && value.length) {
        value.forEach((item, index) => visit(item, `${pointer}/${index}`));
        return;
      }
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !("raw" in value && "value" in value)
      ) {
        const entries = Object.entries(value);
        if (entries.length) {
          for (const [key, v] of entries)
            visit(
              v,
              `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
            );
          return;
        }
      }
      targets.push({
        record_id: r.record_id,
        pointer,
        value,
        sources: r.evidence
          .filter(
            (e) =>
              e.pointer === "" ||
              pointer === e.pointer ||
              pointer.startsWith(`${e.pointer}/`),
          )
          .flatMap((e) => e.sources),
      });
    };
    visit(r.payload, "");
  }
  return targets;
}
export function uncheckedProcessorValues(
  content: ProcessorContent,
  reason: string,
): ProcessorValueCheck[] {
  return processorValues(content).map((v) => ({
    record_id: v.record_id,
    pointer: v.pointer,
    status: "uncertain",
    reason,
    sources: v.sources.map((citation) => ({
      citation,
      status: "uncertain",
      reason,
    })),
  }));
}
export function parseProcessorValueChecks(
  value: unknown,
  content: ProcessorContent,
): readonly ProcessorValueCheck[] {
  const fail = (): never => {
    throw new ContractValidationError();
  };
  if (!Array.isArray(value) || value.length > 10000) return fail();
  const status = (v: unknown): ProcessorCheckStatus =>
    ["text-layer", "image-checked", "uncertain"].includes(String(v))
      ? (v as ProcessorCheckStatus)
      : fail();
  const expected = processorValues(content),
    seen = new Set<string>();
  const checks = value.map((v) => {
    const r = processorExact(v, [
        "record_id",
        "pointer",
        "status",
        "reason",
        "sources",
      ]),
      id = processorText(r.record_id, 256);
    if (typeof r.pointer !== "string" || !Array.isArray(r.sources))
      return fail();
    const target = expected.find(
        (t) => t.record_id === id && t.pointer === r.pointer,
      ),
      key = JSON.stringify([id, r.pointer]);
    if (!target || seen.has(key)) return fail();
    seen.add(key);
    if (content.kind === "records")
      processorPointer(
        content.records.find((r) => r.record_id === id)!.payload,
        r.pointer,
      );
    const citationKey = (citation: ProcessorCitation) =>
      new TextDecoder().decode(canonicalJsonBytes(citation));
    const remaining = target.sources.map(citationKey);
    const sources = r.sources.map((s) => {
      const item = processorExact(s, ["citation", "status", "reason"]);
      const citation = parseProcessorCitation(item.citation);
      const index = remaining.indexOf(citationKey(citation));
      if (index < 0) return fail();
      remaining.splice(index, 1);
      return {
        citation,
        status: status(item.status),
        reason: processorText(item.reason, 4096),
      };
    });
    if (sources.length !== target.sources.length) return fail();
    const result = {
      record_id: id,
      pointer: r.pointer,
      status: status(r.status),
      reason: processorText(r.reason, 4096),
      sources,
    };
    if (
      result.status !== "uncertain" &&
      (!sources.length || sources.some((s) => s.status === "uncertain"))
    )
      return fail();
    return result;
  });
  if (checks.length !== expected.length) return fail();
  return checks;
}
