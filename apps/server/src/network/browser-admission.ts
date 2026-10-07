import {
  resolveBrowserDestination,
  type DestinationPolicy,
  type Resolver,
} from "./policy.js";
import { systemResolver } from "./probe.js";
import { BrowserNetworkProxy } from "./browser-proxy.js";
import type { NetworkBudgetCoordinator } from "./budget.js";

/** Shared Network admission for a production Browser and an explicit Site probe. */
export function createBrowserNetworkAdmission(options: {
  readonly budget: NetworkBudgetCoordinator;
  readonly resolver?: Resolver;
  readonly policy?: DestinationPolicy;
}) {
  const resolver = options.resolver ?? systemResolver();
  const policy: DestinationPolicy = options.policy ?? {
    allowed_schemes: ["http", "https"],
    allowed_classes: ["public"],
  };
  const proxy = new BrowserNetworkProxy({
    resolver,
    policy,
    coordinator: options.budget,
    limits: {
      maxConcurrency: 4,
      maxHostConcurrency: 4,
      maxResponseBytes: Number.MAX_SAFE_INTEGER,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  return {
    proxy,
    admitNavigation: async (url: string): Promise<string> =>
      (await resolveBrowserDestination(url, resolver, policy)).url.url,
  };
}
