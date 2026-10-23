import {
  canonicalJsonBytes,
  sha256,
  processorValues,
  type ProcessorContent,
  type ProcessorValueCheck,
  type ProcessorCheckStatus,
  type ProcessorCitation,
  type ProcessorResult,
  type ProcessorJson,
  type ProofreadBasis,
} from "@sciretriever/contracts";
import {
  DocumentReadError,
  type DocumentReadService,
} from "../document/read.js";
import {
  NORMALIZE_VERSION,
  normalizeForComparison,
  semanticTokens,
} from "../proofread/normalize.js";
const METHOD = "value-evidence-text-check-v2";
interface Evidence {
  text: string;
  basis: ProofreadBasis;
}
const REASONS: Readonly<Record<ProcessorCheckStatus, string>> = {
  found: "cited-values-present",
  "not-found": "cited-value-missing",
  "value-null": "value-not-reported",
  "no-citation": "value-evidence-missing",
  "citation-unavailable": "corrected-fragment-unavailable",
  derived: "synthesis-requires-interpretation",
};
/** Deterministic transcription comparison, never a judgement about scientific truth. */
export function valueInFragments(
  value: ProcessorJson,
  fragments: readonly string[],
): boolean {
  const texts = fragments.map(normalizeForComparison);
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.raw === "string"
  ) {
    const wanted = semanticTokens(normalizeForComparison(value.raw)).numbers;
    const visible = texts.flatMap((t) => semanticTokens(t).numbers);
    const unit =
      typeof value.unit === "string"
        ? normalizeForComparison(value.unit)
        : null;
    return (
      wanted.length > 0 &&
      wanted.every((n) => visible.includes(n)) &&
      (unit === null ||
        texts.some((t) =>
          new RegExp(
            `(?<![\\p{L}_])${unit.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\d_])`,
            "u",
          ).test(t),
        ))
    );
  }
  if (typeof value === "number") {
    const wanted = semanticTokens(String(value)).numbers;
    return (
      wanted.length > 0 &&
      wanted.every((n) =>
        texts.some((t) => semanticTokens(t).numbers.includes(n)),
      )
    );
  }
  // Text without digits must be checked too; empty arrays/objects are not automatically found.
  const text = normalizeForComparison(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return text.length > 0 && texts.some((t) => t.includes(text));
}
export class ProcessorValueVerifier {
  constructor(private readonly documents: DocumentReadService) {}
  identity() {
    return valueVerificationIdentity();
  }
  async check(
    content: ProcessorContent,
    _mapped: readonly ProcessorResult[],
    signal: AbortSignal,
  ) {
    const checks: ProcessorValueCheck[] = [],
      memo = new Map<string, Promise<Evidence | null>>();
    const source = (citation: ProcessorCitation) => {
      const key = JSON.stringify(citation);
      let result = memo.get(key);
      if (!result) {
        result = this.evidence(citation, signal);
        memo.set(key, result);
      }
      return result;
    };
    for (const target of processorValues(content)) {
      signal.throwIfAborted();
      const fragments = await Promise.all(target.sources.map(source));
      const sources = target.sources.map((citation, i) => {
        const e = fragments[i];
        const status: ProcessorCheckStatus =
          citation.kind === "result"
            ? "derived"
            : target.value === null
              ? "value-null"
              : !e
                ? "citation-unavailable"
                : valueInFragments(target.value, [e.text])
                  ? "found"
                  : "not-found";
        return {
          citation,
          basis: e?.basis ?? null,
          status,
          reason: REASONS[status],
        };
      });
      const status: ProcessorCheckStatus =
        target.value === null
          ? "value-null"
          : !sources.length
            ? "no-citation"
            : sources.some((s) => s.status === "derived")
              ? "derived"
              : fragments.some((e) => e === null)
                ? "citation-unavailable"
                : valueInFragments(
                      target.value,
                      fragments.map((e) => e!.text),
                    )
                  ? "found"
                  : "not-found";
      checks.push({
        record_id: target.record_id,
        pointer: target.pointer,
        status,
        reason: REASONS[status],
        sources,
      });
    }
    return { checks, usage: { calls: 0, input_tokens: 0, output_tokens: 0 } };
  }
  private async evidence(
    citation: ProcessorCitation,
    signal: AbortSignal,
  ): Promise<Evidence | null> {
    if (
      citation.kind !== "document" ||
      citation.evidence.target_kind !== "document" ||
      citation.evidence.locator.kind !== "segment"
    )
      return null;
    const ref = citation.evidence;
    try {
      await this.documents.resolveEvidence(ref, signal);
      return await this.documents.withVerifiedVersion(
        ref.document_version_id,
        async (version, bytes, structure) => {
          if (version.schema_version !== 2 || structure.schema_version !== 2)
            return null;
          const segment = structure.segments.find(
            (s) => s.segment_id === ref.locator.segment_id,
          );
          if (!segment) return null;
          return {
            text: new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(segment.start_utf8, segment.end_utf8),
            ),
            basis: segment.basis,
          };
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof DocumentReadError &&
        [
          "document-missing",
          "material-missing",
          "document-invalid",
          "document-evidence-missing",
        ].includes(error.code)
      )
        return null;
      throw error;
    }
  }
}
export async function valueVerificationIdentity() {
  return sha256(
    canonicalJsonBytes({
      method: METHOD,
      normalization: NORMALIZE_VERSION,
      text_match: "normalized-nonempty-substring",
      numeric_match: "semantic-tokens-and-unit",
    }),
  );
}
