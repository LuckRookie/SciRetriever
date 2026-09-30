import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifiedCloakRuntime } from "../configuration/cloak-runtime.js";
import type { ConfigurationProbeBrowserSite } from "../configuration/owner.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import { createBrowserNetworkAdmission } from "../network/browser-admission.js";
import { BrowserHost, type BrowserHostOptions } from "./host.js";

/** Reviewed, explicit homepage probes. These keys never create download routes. */
const SITE_HOMES = Object.freeze({
  "acs-publications": "https://pubs.acs.org/",
  "aip-publishing": "https://pubs.aip.org/",
  "elsevier-sciencedirect": "https://www.sciencedirect.com/",
  iopscience: "https://iopscience.iop.org/",
  "oxford-academic": "https://academic.oup.com/",
  "rsc-publishing": "https://pubs.rsc.org/",
  "science-aaas": "https://www.science.org/",
  springerlink: "https://link.springer.com/",
  "wiley-online-library": "https://onlinelibrary.wiley.com/",
});
export const PRODUCTION_BROWSER_SITE_ACCESS_KEYS = Object.freeze(
  Object.keys(SITE_HOMES),
);

export class BrowserSiteProbeError extends Error {
  readonly code = "browser-site-probe-failed" as const;
  constructor(
    readonly browser_launched: boolean,
    readonly network_performed: boolean,
    cause: unknown,
  ) {
    super("Browser Site probe failed", { cause });
  }
}

/** One bounded, reachability-only use of the same verified Browser/Network owners. */
export function createProductionBrowserSiteProbe(
  runtime: VerifiedCloakRuntime,
  profile: string,
): ConfigurationProbeBrowserSite {
  return createBrowserSiteProbe(runtime, SITE_HOMES, profile);
}

/** Internal fixture seam: production always calls the fixed HTTPS map above. */
export function createBrowserSiteProbe(
  runtime: VerifiedCloakRuntime,
  homes: Readonly<Record<string, string>>,
  profile?: string,
  hostFactory: (
    options: BrowserHostOptions,
  ) => Pick<BrowserHost, "start" | "openPage" | "close"> = (options) =>
    new BrowserHost(options),
): ConfigurationProbeBrowserSite {
  return Object.freeze({
    access_keys: Object.freeze(Object.keys(homes)),
    probe: async (accessKey: string, signal?: AbortSignal): Promise<void> => {
      const target = homes[accessKey];
      if (!target || signal?.aborted) throw new Error("site probe unavailable");
      const url = new URL(target);
      const fixtureLoopback =
        url.protocol === "http:" && url.hostname === "127.0.0.1";
      if (!fixtureLoopback && (url.protocol !== "https:" || url.port))
        throw new Error("site probe target is invalid");
      const budget = new NetworkBudgetCoordinator();
      const network = createBrowserNetworkAdmission({
        budget,
        policy: {
          allowed_schemes: fixtureLoopback ? ["http"] : ["https"],
          allowed_classes: fixtureLoopback ? ["loopback"] : ["public"],
          ...(fixtureLoopback ? { allowed_addresses: ["127.0.0.1"] } : {}),
          allowed_origins: [
            {
              scheme: fixtureLoopback ? "http" : "https",
              hostname: url.hostname,
              port: fixtureLoopback ? Number(url.port) : 443,
            },
          ],
          allowed_ports: [
            {
              scheme: fixtureLoopback ? "http" : "https",
              port: fixtureLoopback ? Number(url.port) : 443,
            },
          ],
        },
      });
      const directory = profile
        ? null
        : await mkdtemp(join(tmpdir(), "sciretriever-site-probe-"));
      let host: Pick<BrowserHost, "start" | "openPage" | "close"> | undefined;
      let hostClose: Promise<void> | undefined;
      const closeHost = (): Promise<void> =>
        (hostClose ??= Promise.resolve().then(() => host?.close()));
      let failure: unknown;
      let browserLaunched = false;
      let networkPerformed = false;
      try {
        const connection = await network.proxy.start();
        host = hostFactory({
          runtime,
          profile: profile ?? join(directory!, "profile"),
          proxy: connection,
          probeDocumentUrl: url.toString(),
          admitNavigation: async (requested) => {
            if (requested !== url.toString())
              throw new Error("site probe changed target");
            return network.admitNavigation(requested);
          },
          // The host admits only this top-level document, with JavaScript and
          // downloads disabled. No transfer receiver is supplied either.
        });
        let timedOut = false;
        const cancel = () => {
          void closeHost().catch(() => undefined);
        };
        const timeout = setTimeout(() => {
          timedOut = true;
          cancel();
        }, 10_000);
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          if (signal?.aborted) throw new Error("site probe cancelled");
          await host.start();
          browserLaunched = true;
          networkPerformed = true;
          const page = await host.openPage(target);
          try {
            if (
              new URL(page.url()).origin !== url.origin ||
              signal?.aborted ||
              timedOut
            )
              throw new Error("site probe did not reach target");
          } finally {
            await page.close();
          }
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", cancel);
          if (hostClose) await hostClose;
        }
      } catch (error) {
        failure = error;
      }
      const cleanup: unknown[] = [];
      for (const release of [
        closeHost,
        () => network.proxy.close(),
        () => budget.close(),
        () =>
          directory === null
            ? Promise.resolve()
            : rm(directory, { recursive: true, force: true }),
      ]) {
        try {
          await release();
        } catch (error) {
          cleanup.push(error);
        }
      }
      if (failure !== undefined || cleanup.length)
        throw new BrowserSiteProbeError(
          browserLaunched,
          networkPerformed,
          new AggregateError(
            failure === undefined ? cleanup : [failure, ...cleanup],
            "site probe failed",
          ),
        );
    },
  });
}
