import type {
  DurableCandidate,
  MetadataSnapshot,
  OperatorInput,
} from "@sciretriever/contracts";
import type { BrowserNavigationAdmission } from "./host.js";
import type { FlowPageHandle } from "./article-flow.js";

/**
 * One bounded Browser acquisition attempt for a concrete Literature.
 *
 * The Browser session needs the same identity context the other acquisition tiers
 * use: which Literature, which identifier/version the delivered bytes must belong to,
 * the metadata snapshot the receipt will be bound to, and the caller's cancellation
 * signal. It never receives a credential, Cookie, arbitrary URL or selector.
 */
export interface BrowserDeliveryRequest {
  readonly literature_id: string;
  readonly identifier: string;
  /**
   * The concrete version of the frozen target, never a defaulted or guessed role.
   * Entry always passes `detail.literature.version_role`; the field stays a string
   * because this module is outside the current repair's declared file scope.
   */
  readonly version: string;
  /**
   * The one already-admitted landing page this delivery may start from, selected by
   * Entry from the target's own `asset_hints` (never an arbitrary or guessed URL).
   * `null` means no admissible page exists, which the tier reports as unavailable.
   */
  readonly start_url: string | null;
  readonly metadata_snapshot: MetadataSnapshot;
  readonly signal: AbortSignal;
  /** Operation-local generation used to reject stale queued deliveries. */
  readonly generation?: number;
  readonly operation_id?: string;
}

/**
 * The bounded article driver owned by the Browser tier.
 *
 * A driver receives exactly the validated request above: it may navigate only to
 * `start_url`, observe within the admitted session and deliver through the
 * Intake-owned collector. It cannot be reached without an owned host, and an
 * unconfigured process has no driver at all, so the tier stays stably unavailable
 * instead of pretending a flow exists.
 */
export interface BrowserArticleFlow {
  deliver(request: BrowserDeliveryRequest): Promise<BrowserDeliveryResult>;
}

/**
 * A Browser delivery is either a spooled, identity-assessed candidate that the
 * ordinary acceptance path can consume, or a stable, non-retryable refusal.
 *
 * It is deliberately never expressed as an empty candidate list or a bare transfer
 * id. An empty list reads as "this route ended normally" and can become a durable
 * exhaustion fact for an article that was never attempted, and a bare id cannot
 * prove that bytes were fetched, attributed and spooled.
 */
export type BrowserDeliveryResult =
  | {
      readonly kind: "delivered";
      /** Bytes already spooled by the Intake-owned collector. */
      readonly candidate: DurableCandidate;
      /** Identity/version assessment produced by the Intake boundary. */
      readonly accepted: boolean;
    }
  /** A real article flow ended without a captured primary PDF. */
  | { readonly kind: "exhausted" }
  | {
      readonly kind: "refused";
      /** Stable reason code; never carries a URL, path, Cookie or page text. */
      readonly code: string;
      readonly reason: string;
      readonly retryable: false;
    };

/**
 * The browser ownership boundary.
 *
 * Application (Bootstrap) is the only owner allowed to construct a Browser host, and
 * it owns that host's lifetime. Callers never receive a `BrowserHost`, a Page, a
 * Context or a CDP handle: they receive this deliberately narrow session view, which
 * cannot navigate to an arbitrary URL, read Cookies, or publish facts.
 *
 * Keeping the boundary here means every other module (including Acquisition) stays
 * free of vendor objects while still being able to ask one bounded question: "did the
 * controlled Browser deliver an accepted primary PDF for this article?".
 */
export interface BrowserSessionHost {
  /**
   * Run one bounded article flow inside the admitted Browser session and return the
   * spooled, identity-assessed candidate for the caller's acceptance step. The bytes
   * are produced by the Browser's own Network stack and spooled by the Intake owner;
   * no URL is ever handed back for another transport to fetch.
   */
  deliverCandidate(
    request: BrowserDeliveryRequest,
  ): Promise<BrowserDeliveryResult>;
  /**
   * Apply one already-parsed operator action inside the current session. Optional:
   * only an enabled, available runtime exposes it.
   */
  applyAction?(
    input: OperatorInput,
    documentGeneration: number,
    current: () => boolean,
  ): Promise<unknown>;
  /** Release the owned process, context, profile lock and staging resources. */
  close(): Promise<void>;
}

/**
 * Everything Bootstrap needs to build one controlled Browser host. `runtime` and
 * `proxy` are injectable seams: a real run supplies the operator-verified Cloak
 * runtime and the Network-owned proxy connection, while tests supply fakes so the
 * object graph can be exercised without launching a Browser.
 */
/**
 * Builds the bounded article driver around the raw Browser host the factory owns.
 *
 * The factory is the only place that holds a `BrowserHost`, so it — not Bootstrap and
 * not the narrow `BrowserSessionHost` wrapper — must supply the page source. This keeps
 * `BrowserSessionHost` free of `start`/`openPage` while still letting the real flow
 * reach them.
 */
export type BrowserArticleFlowFactory = (
  pages: BrowserArticleFlowPageSource,
) => BrowserArticleFlow;

/** One page per delivery attempt, opened and closed by the flow owner. */
export interface BrowserArticleFlowPageSource {
  openPage(request: BrowserDeliveryRequest): Promise<{
    readonly page: FlowPageHandle;
    readonly close: () => Promise<void>;
  }>;
}

export interface BrowserHostRuntimeSeam {
  readonly profile: string;
  readonly runtime?: unknown;
  readonly proxy?: unknown;
  readonly executablePath?: string;
  readonly admitNavigation?: BrowserNavigationAdmission;
  /**
   * The bounded article driver. When absent the tier has an owned host but no flow,
   * which is reported as a stable `browser-flow-unavailable` refusal.
   */
  readonly article_flow?: BrowserArticleFlow;
  /** Preferred over `article_flow`: receives the factory-owned page source. */
  readonly article_flow_factory?: BrowserArticleFlowFactory;
}

/**
 * Builds the owned session host. Returning `null` means "this process cannot provide
 * a controlled Browser", which the caller must surface as a stable unavailable state
 * rather than as a delivered document.
 */
export type BrowserHostFactory = (
  seam: BrowserHostRuntimeSeam,
) => BrowserSessionHost | null;

export type BrowserHostAvailability = "available" | "unavailable";

/** Stable refusal used whenever the tier cannot honestly attempt a delivery. */
export function browserRefused(
  code: string,
  reason: string,
): BrowserDeliveryResult {
  return Object.freeze({
    kind: "refused" as const,
    code,
    reason,
    retryable: false as const,
  });
}

/**
 * The single source of truth for "can this process provide a controlled Browser?".
 * It answers without touching a profile, a proxy or a Browser: a missing factory or a
 * missing profile is immediately unavailable, so a caller cannot mistake an unwired
 * tier for a working one.
 */
export function resolveBrowserHost(
  seam: BrowserHostRuntimeSeam | null,
  factory: BrowserHostFactory | null,
): {
  readonly availability: BrowserHostAvailability;
  readonly reason: string | null;
  readonly create: () => BrowserSessionHost;
} {
  if (seam === null || factory === null || !seam.profile)
    return Object.freeze({
      availability: "unavailable" as const,
      reason: "browser-host-not-wired",
      create: () => {
        throw new TypeError("browser host is not available");
      },
    });
  return Object.freeze({
    availability: "available" as const,
    reason: null,
    // Built lazily: an idle tier must never start a Browser, hold a profile lock or
    // open a Network connection.
    create: () => {
      const host = factory(seam);
      if (host === null) throw new TypeError("browser host is not available");
      return host;
    },
  });
}
