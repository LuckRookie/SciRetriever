import { parseAcquisitionAttempts } from "@sciretriever/contracts";
import type { OperatorInput } from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type {
  BrowserArticleExecution,
  BrowserArticleSessionIdentity,
} from "./article-session.js";
import { verifyInstalledCloakRuntime } from "../configuration/cloak-runtime.js";
import { BrowserHost, type BrowserHostOptions } from "./host.js";
import {
  browserRefused,
  type BrowserArticleFlowFactory,
  type BrowserArticleFlow,
  type BrowserDeliveryRequest,
  type BrowserDeliveryResult,
  type BrowserHostFactory,
  type BrowserHostRuntimeSeam,
  type BrowserSessionHost,
} from "./boundary.js";

/**
 * The production BrowserHost construction factory.
 *
 * `apps/server/src/browser/boundary.ts` defines the ownership contract; this module
 * is the only factory used by the production Application object graph. The synthetic
 * workbench has a separate offline construction path for fixture wiring and is not a
 * second production Browser owner.
 *
 * Construction is lazy and side-effect free: `new BrowserHost(...)` validates its
 * options and resolves the profile path but does not create the profile directory,
 * acquire the profile lock, open a Network connection or launch Chromium. Those
 * happen only in `start()`, behind the operator's explicit switch. Tests therefore
 * exercise the real object graph without touching a Browser, and an unconfigured
 * process reports `unavailable` instead of pretending to be wired.
 */
export interface ProductionBrowserCapability {
  readonly available: boolean;
  /** Stable reason when unavailable, safe for a target report. */
  readonly reason: "browser-runtime-unavailable" | null;
}

/**
 * Structural capability probe for the production Browser owner. It answers whether
 * this process holds a verified runtime at all, without verifying a bundle again,
 * creating a profile, taking the profile lock or launching Chromium. Bootstrap uses it
 * so `controlled_delivery` is never admitted for a process that cannot deliver.
 */
export function productionBrowserCapability(options: {
  /**
   * The verified runtime Bootstrap resolved for this process. A raw bundle path is
   * deliberately not accepted here: admission may never be granted from an
   * unverified string, and a missing runtime must not fall back to the default
   * Playwright Chromium.
   */
  readonly runtime: BrowserHostOptions["runtime"] | undefined;
}): ProductionBrowserCapability {
  return options.runtime === undefined
    ? Object.freeze({
        available: false as const,
        reason: "browser-runtime-unavailable" as const,
      })
    : Object.freeze({ available: true as const, reason: null });
}

/**
 * Builds the production host factory.
 *
 * The runtime can only come from `resolveVerifiedCloakRuntime`, which delegates to
 * `verifyInstalledCloakRuntime`; that function registers its own frozen result in a
 * module-private `WeakSet` that `BrowserHost`'s constructor re-checks through
 * `assertVerifiedCloakRuntime`. A verified runtime therefore cannot be forged, and no
 * offline fixture can exercise the real
 * `verifyInstalledCloakRuntime -> new BrowserHost -> start -> openPage -> deliver` chain:
 * that chain stays an explicitly documented, unrun residual (T20-F16 / T23-F03) and is
 * never reported as covered. `host_seam` covers only this factory's own wiring
 * (start/openPage -> navigation admission -> article flow -> refusal -> close) with an
 * injected offline host.
 */
export function createProductionBrowserHostFactory(options: {
  /**
   * The verified runtime Bootstrap resolved. The factory refuses to build without one,
   * so an unverified bundle can never reach a host that would silently launch the
   * default Playwright Chromium.
   */
  readonly runtime: BrowserHostOptions["runtime"] | undefined;
  /** Network-owned proxy connection, required once a Browser actually runs. */
  readonly proxy?: BrowserHostOptions["proxy"];
  /** Intake-owned capture callbacks; this factory never interprets bytes itself. */
  readonly transfers?: BrowserHostOptions["transfers"];
  readonly admitNavigation?: BrowserHostOptions["admitNavigation"];
  readonly beforeRequest?: BrowserHostOptions["beforeRequest"];
  readonly navigationRetryFailed?: BrowserHostOptions["navigationRetryFailed"];
  readonly requestEnded?: BrowserHostOptions["requestEnded"];
  readonly documentCommitted?: BrowserHostOptions["documentCommitted"];
  readonly resumeDocument?: BrowserHostOptions["resumeDocument"];
  readonly onRuntimeLost?: BrowserHostOptions["onRuntimeLost"];
  readonly rateLimited?: BrowserHostOptions["rateLimited"];
  readonly maxSessions?: BrowserHostOptions["maxSessions"];
  /**
   * The bounded article driver. Unconfigured processes have none: the host then
   * reports a stable flow-unavailable refusal instead of a fake delivery.
   */
  readonly article_flow?: BrowserArticleFlow;
  readonly article_flow_factory?: BrowserArticleFlowFactory;
  /**
   * Explicit offline wiring seam for direct tests that must exercise this factory's
   * host -> flow wiring without a Cloak bundle. Bootstrap never supplies it, and it
   * cannot fake a verified runtime: it replaces the raw host, not
   * `assertVerifiedCloakRuntime`. A process that passes it is provably not a verified
   * production Browser, so no test may present it as the production chain.
   */
  readonly host_seam?: (
    options: BrowserHostOptions,
  ) => Pick<BrowserHost, "start" | "openPage" | "close"> &
    Partial<
      Pick<BrowserHost, "setSessionNetworkAccess" | "stopSessionNetwork">
    >;
}): BrowserHostFactory {
  return (seam: BrowserHostRuntimeSeam): BrowserSessionHost | null => {
    // No verified runtime means this process cannot provide a controlled Browser at
    // all: report that instead of constructing a half-wired host. The single exception is
    // the explicit offline wiring seam above, which Bootstrap never supplies and which
    // cannot make this process a verified Browser.
    if (
      options.host_seam === undefined &&
      !productionBrowserCapability({ runtime: options.runtime }).available
    )
      return null;
    const runtime = options.runtime;
    const proxy = options.proxy ?? seam.proxy;
    // A host without an admitted navigation cannot legitimately deliver anything: every
    // request would be refused after the Browser started, so a direct factory call must
    // not be able to construct one either. Bootstrap only reaches this point when its own
    // admission is present, so this is the same fail-closed rule at the construction site.
    const networkAdmission = options.admitNavigation ?? seam.admitNavigation;
    if (networkAdmission === undefined) return null;
    const hostOptions: BrowserHostOptions = {
      profile: seam.profile,
      ...(runtime ? { runtime } : {}),
      ...(proxy
        ? { proxy: proxy as NonNullable<BrowserHostOptions["proxy"]> }
        : {}),
      ...(options.transfers ? { transfers: options.transfers } : {}),
      admitNavigation: networkAdmission,
      ...(options.beforeRequest
        ? { beforeRequest: options.beforeRequest }
        : {}),
      ...(options.navigationRetryFailed
        ? { navigationRetryFailed: options.navigationRetryFailed }
        : {}),
      ...(options.requestEnded ? { requestEnded: options.requestEnded } : {}),
      ...(options.documentCommitted
        ? { documentCommitted: options.documentCommitted }
        : {}),
      ...(options.resumeDocument
        ? { resumeDocument: options.resumeDocument }
        : {}),
      ...(options.onRuntimeLost
        ? { onRuntimeLost: options.onRuntimeLost }
        : {}),
      ...(options.rateLimited ? { rateLimited: options.rateLimited } : {}),
      ...(options.maxSessions !== undefined
        ? { maxSessions: options.maxSessions }
        : {}),
    };
    const host =
      options.host_seam === undefined
        ? new BrowserHost(hostOptions)
        : options.host_seam(hostOptions);
    const source = {
      openPage: async (request: BrowserDeliveryRequest) => {
        const identity = request.session_identity;
        if (!identity)
          throw new TypeError("Browser article identity is unavailable");
        await host.start();
        const page = await host.openPage(
          request.start_url ?? undefined,
          identity,
          request.signal,
          { retainNavigationFailure: true },
        );
        return {
          page,
          session_id: identity.session_id,
          setNetworkAccess: (allowed: boolean) =>
            host.setSessionNetworkAccess?.(identity.session_id, allowed),
          stopNetwork: () =>
            host.stopSessionNetwork?.(identity.session_id) ?? Promise.resolve(),
          close: () => page.close(),
        };
      },
    };
    const flowFactory =
      options.article_flow_factory ?? seam.article_flow_factory;
    const flow =
      options.article_flow ?? seam.article_flow ?? flowFactory?.(source);
    const prepare = (request: BrowserDeliveryRequest) => {
      const admitted = admitBrowserArticleRequest(request);
      if (!admitted.ok) return admitted;
      const identity: BrowserArticleSessionIdentity =
        request.session_identity ??
        Object.freeze({
          session_id: "browser-article-" + randomUUID(),
          operation_id:
            request.operation_id ?? "browser-operation-" + randomUUID(),
          generation: request.generation ?? 0,
          literature_id: request.literature_id,
          metadata_snapshot: Object.freeze({ ...request.metadata_snapshot }),
          ...(request.prior_attempts
            ? {
                prior_attempts: parseAcquisitionAttempts(
                  request.prior_attempts,
                  16,
                ),
              }
            : {}),
          ...(request.article_goal?.title
            ? { title: request.article_goal.title }
            : {}),
        });
      if (
        request.signal.aborted ||
        identity.literature_id !== request.literature_id ||
        identity.metadata_snapshot.revision !==
          request.metadata_snapshot.revision ||
        identity.metadata_snapshot.sha256 !==
          request.metadata_snapshot.sha256 ||
        (request.generation !== undefined &&
          identity.generation !== request.generation) ||
        (request.operation_id !== undefined &&
          identity.operation_id !== request.operation_id)
      )
        return {
          ok: false as const,
          refusal: browserRefused(
            "browser-stale-operation",
            "The Browser article ownership is no longer current.",
          ),
        };
      return {
        ok: true as const,
        request: Object.freeze({
          ...admitted.request,
          session_identity: Object.freeze({
            ...identity,
            metadata_snapshot: Object.freeze({ ...identity.metadata_snapshot }),
          }),
        }),
      };
    };
    const openArticle = flow?.open
      ? async (
          request: BrowserDeliveryRequest,
        ): Promise<BrowserArticleExecution> => {
          const admitted = prepare(request);
          if (!admitted.ok)
            throw new TypeError(
              admitted.refusal.kind === "refused"
                ? admitted.refusal.code
                : "browser-flow-unavailable",
            );
          return flow.open!(admitted.request);
        }
      : undefined;
    return Object.freeze({
      ...(openArticle ? { openArticle } : {}),
      deliverCandidate: async (
        request: BrowserDeliveryRequest,
      ): Promise<BrowserDeliveryResult> => {
        if (!flow)
          return browserRefused(
            "browser-flow-unavailable",
            "The controlled Browser article flow is not wired in this process.",
          );
        const admitted = prepare(request);
        if (!admitted.ok) return admitted.refusal;
        return flow.deliver(admitted.request);
      },
      applyAction: async (
        input: OperatorInput,
        documentGeneration: number,
        current: () => boolean,
      ) => {
        const page = await host.openPage();
        try {
          return await page.apply(input, documentGeneration, current);
        } finally {
          await page.close();
        }
      },
      close: () => host.close(),
    });
  };
}

/**
 * Validates every entry against the admitted-driver contract. Missing, non-HTTP(S),
 * credentialed or fragmented targets are refused before the flow is asked, so no
 * arbitrary URL and no guessed locator can ever reach the Browser.
 */
export function admitBrowserArticleRequest(
  request: BrowserDeliveryRequest,
):
  | { readonly ok: true; readonly request: BrowserDeliveryRequest }
  | { readonly ok: false; readonly refusal: BrowserDeliveryResult } {
  const start = request.start_url;
  if (start === null)
    return {
      ok: false,
      refusal: browserRefused(
        "browser-flow-unavailable",
        "No admitted landing page is available for this article.",
      ),
    };
  let targets: URL[];
  let initialTarget: URL;
  try {
    initialTarget = new URL(start);
    targets = (request.start_urls ?? [start]).map((url) => new URL(url));
  } catch {
    return {
      ok: false,
      refusal: browserRefused(
        "browser-start-url-invalid",
        "The Browser article start URL is not a valid URL.",
      ),
    };
  }
  // Syntax is checked here. Network owns DNS, address classes and scheme policy.
  if (
    targets.length === 0 ||
    targets[0]!.toString() !== initialTarget.toString() ||
    targets.some(
      (target) =>
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password ||
        target.hash,
    )
  )
    return {
      ok: false,
      refusal: browserRefused(
        "browser-start-url-invalid",
        "The Browser article start URL is not an admitted landing page.",
      ),
    };
  return {
    ok: true,
    request: Object.freeze({
      ...request,
      start_url: targets[0]!.toString(),
      ...(request.start_urls
        ? {
            start_urls: Object.freeze([
              ...new Set(targets.map((target) => target.toString())),
            ]),
          }
        : {}),
    }),
  };
}

/**
 * Verifies an operator-installed Cloak bundle and returns the runtime Bootstrap may
 * hand to the host factory. Resolves to `undefined` when no bundle is configured or
 * verification fails, which keeps the tier stably unavailable.
 */
export async function resolveVerifiedCloakRuntime(
  bundle: string | undefined,
): Promise<BrowserHostOptions["runtime"] | undefined> {
  if (bundle === undefined || !bundle.startsWith("/")) return undefined;
  try {
    return await verifyInstalledCloakRuntime(bundle);
  } catch {
    return undefined;
  }
}
