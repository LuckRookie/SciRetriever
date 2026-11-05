import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import {
  NetworkConfigurationError,
  type OutboundNetworkConfiguration,
} from "@sciretriever/contracts";
import { classifyAddress, type Resolver } from "../network/policy.js";

interface Services {
  readonly providers: Readonly<Record<string, { readonly base_url: string }>>;
  readonly parsing: {
    readonly base_url: string | null;
    readonly connection_mode: "loopback" | "remote" | null;
  };
}
function targets(
  network: OutboundNetworkConfiguration,
  services: Services,
): readonly string[] {
  const result: string[] = [];
  for (const provider of network.via_proxy.providers) {
    const service = services.providers[provider];
    if (!service)
      throw new NetworkConfigurationError("network-provider-unknown");
    result.push(service.base_url);
  }
  if (network.via_proxy.mineru) {
    if (
      services.parsing.connection_mode !== "remote" ||
      !services.parsing.base_url
    )
      throw new NetworkConfigurationError("network-local-target");
    result.push(services.parsing.base_url);
  }
  return result;
}
export function validateNetworkServices(
  network: OutboundNetworkConfiguration,
  services: Services,
): void {
  for (const target of targets(network, services)) {
    const host = new URL(target).hostname.replace(/^\[|\]$/gu, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      (isIP(host) && classifyAddress(host) !== "public")
    )
      throw new NetworkConfigurationError("network-local-target");
  }
}
export async function validateNetworkServiceDns(
  network: OutboundNetworkConfiguration,
  services: Services,
  resolver: Resolver = async (host) =>
    (await lookup(host, { all: true })).map((a) => a.address),
): Promise<void> {
  validateNetworkServices(network, services);
  for (const target of targets(network, services)) {
    const host = new URL(target).hostname.replace(/^\[|\]$/gu, "");
    if (isIP(host)) continue;
    let addresses: readonly string[];
    try {
      addresses = await resolver(host);
    } catch {
      throw new NetworkConfigurationError("network-target-unresolved");
    }
    if (!addresses.length)
      throw new NetworkConfigurationError("network-target-unresolved");
    let privateAddress: boolean;
    try {
      privateAddress = addresses.some((a) => classifyAddress(a) !== "public");
    } catch {
      throw new NetworkConfigurationError("network-target-unresolved");
    }
    if (privateAddress)
      throw new NetworkConfigurationError("network-local-target");
  }
}
