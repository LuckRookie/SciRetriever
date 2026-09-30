import {
  resolveDestination,
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
    allowed_schemes: ["https"],
    allowed_classes: ["public"],
  };
  const proxy = new BrowserNetworkProxy({
    resolver,
    policy,
    coordinator: options.budget,
    limits: {
      maxConcurrency: 4,
      maxHostConcurrency: 4,
      maxResponseBytes: 16 * 1024 * 1024,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  return {
    proxy,
    admitNavigation: async (url: string): Promise<string> =>
      (await resolveDestination(url, resolver, policy)).url.url,
  };
}
