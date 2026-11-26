import {
  LAYERS_NOT_APPLICABLE_REASONS,
  type DocumentLayersState,
  type LayersNotApplicableReason,
} from "@sciretriever/contracts";

/**
 * The reading layers' read (technical 04 §10.7) is parsed by the contracts
 * package: `describe.layers` by the describe parser, the operation `layers`
 * by `parseDocumentLayersResult`. What is left here is the refusal, which
 * arrives as an HTTP 409 body and not as a result.
 */
export class LayersUnavailable extends Error {
  constructor(
    readonly code: "layers-unavailable" | "translation-unavailable",
    readonly state: DocumentLayersState | null,
    readonly reason: LayersNotApplicableReason | null,
  ) {
    super(code);
  }
}

type Raw = Record<string, unknown>;
const STATES: readonly DocumentLayersState[] = [
  "none",
  "complete",
  "stale",
  "not-applicable",
];
/** A 409 reply's error body, when it is one of the layers' refusals. */
export function layersRefusal(body: unknown): LayersUnavailable | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as Raw).error;
  const r = e && typeof e === "object" ? (e as Raw) : (body as Raw);
  const code = r.code;
  if (code !== "layers-unavailable" && code !== "translation-unavailable")
    return null;
  const details =
    r.details && typeof r.details === "object" ? (r.details as Raw) : r;
  return new LayersUnavailable(
    code,
    STATES.find((s) => s === details.state) ?? null,
    LAYERS_NOT_APPLICABLE_REASONS.find((s) => s === details.reason) ?? null,
  );
}
