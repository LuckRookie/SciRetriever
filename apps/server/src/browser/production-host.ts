import type { OperatorInput } from "@sciretriever/contracts";
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
  ) => Pick<BrowserHost, "start" | "openPage" | "close">;
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
    let activeOrigin: string | null = null;
    const admitNavigation: NonNullable<
      BrowserHostOptions["admitNavigation"]
    > = async (url) => {
      // Network owns DNS/address/transport policy. This article-local gate only
      // narrows it to the admitted landing origin; a redirect or subresource from
      // another origin cannot become an implicit source grant.
      if (activeOrigin === null || new URL(url).origin !== activeOrigin)
        throw new TypeError("Browser destination outside article origin");
      return networkAdmission(url);
    };
    const hostOptions: BrowserHostOptions = {
      profile: seam.profile,
      ...(runtime ? { runtime } : {}),
      ...(proxy
        ? { proxy: proxy as NonNullable<BrowserHostOptions["proxy"]> }
        : {}),
      ...(options.transfers ? { transfers: options.transfers } : {}),
      admitNavigation,
    };
    // Either the real trusted construction, which re-checks the verified-runtime WeakSet
    // inside `BrowserHost`, or the explicitly injected offline substitute for wiring tests.
    const host =
      options.host_seam === undefined
        ? new BrowserHost(hostOptions)
        : options.host_seam(hostOptions);
    const close = (): Promise<void> => host.close();
    return Object.freeze({
      // The bounded article flow is supplied by Bootstrap: either a ready driver or a
      // factory that builds one around the page source this factory owns. Without one
      // (no Browser decision model, no verified runtime) the tier refuses with a stable
      // `browser-flow-unavailable` instead of inventing a delivery. It must never return
      // an empty list or a bare transfer id: an empty result reads as a normal route end
      // and can be committed as a durable exhaustion fact, and an id cannot prove the
      // bytes were fetched, attributed and spooled through the Intake boundary.
      deliverCandidate: async (
        request: BrowserDeliveryRequest,
      ): Promise<BrowserDeliveryResult> => {
        // The factory owns this raw host, so it — not Bootstrap — supplies the page
        // source. That keeps `BrowserSessionHost` free of start/openPage while the real
        // flow can still reach them.
        let flow = options.article_flow ?? seam.article_flow;
        const flowFactory =
          options.article_flow_factory ?? seam.article_flow_factory;
        if (flow === undefined && flowFactory !== undefined) {
          // Resolved on first delivery, at which point the factory-owned page source can
          // reach the raw host it holds.
          flow = flowFactory({
            // The seam is request-shaped end to end: the driver owner binds the
            // delivery context before the page opens, and this closure unwraps the
            // already-admitted start URL onto the raw host.
            openPage: async (request) => {
              await host.start();
              const page = await host.openPage(request.start_url ?? undefined);
              return { page, close: () => page.close() };
            },
          });
        }
        if (flow === undefined)
          return browserRefused(
            "browser-flow-unavailable",
            "The controlled Browser article flow is not wired in this process.",
          );
        const admitted = admitBrowserArticleRequest(request);
        if (!admitted.ok) return admitted.refusal;
        if (activeOrigin !== null)
          return browserRefused(
            "browser-flow-busy",
            "Another article is active in the controlled Browser.",
          );
        activeOrigin = new URL(admitted.request.start_url!).origin;
        try {
          return await flow.deliver(admitted.request);
        } finally {
          activeOrigin = null;
        }
      },
      // The host exposes `apply` on a page handle, not on itself: an action only has
      // meaning inside an open, admitted page.
      applyAction: async (
        input: OperatorInput,
        documentGeneration: number,
        current: () => boolean,
      ) => {
        const page = await host.openPage();
        const applied = await page.apply(input, documentGeneration, current);
        await page.close();
        return applied;
      },
      close,
    });
  };
}

/**
 * Validates one delivery request against the admitted-driver contract: a driver may
 * only navigate to one already-admitted landing page. Missing, non-HTTPS,
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
  let target: URL;
  try {
    target = new URL(start);
  } catch {
    return {
      ok: false,
      refusal: browserRefused(
        "browser-start-url-invalid",
        "The Browser article start URL is not a valid URL.",
      ),
    };
  }
  // Literal loopback HTTP is syntactically accepted only for an explicitly injected
  // Network fixture admission. The production HTTPS/public-IP policy still refuses it.
  if (
    (target.protocol !== "https:" &&
      !(target.protocol === "http:" && target.hostname === "127.0.0.1")) ||
    target.username ||
    target.password ||
    target.hash
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
    request: Object.freeze({ ...request, start_url: target.toString() }),
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
