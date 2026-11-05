import { ContractValidationError } from "./index.js";
import { LITERATURE_SOURCE_IDS } from "./source-configuration.js";

export type NetworkEgress = "direct" | "proxy";
export interface NetworkProxySelection {
  readonly sources: readonly string[];
  readonly doi_resolution: boolean;
  readonly providers: readonly string[];
  readonly mineru: boolean;
  readonly browser: boolean;
}
export interface OutboundNetworkConfiguration {
  readonly proxy: string | null;
  readonly via_proxy: NetworkProxySelection;
}
export interface NetworkReadiness {
  readonly proxy_configured: boolean;
  readonly proxy_authentication: boolean;
  readonly via_proxy: NetworkProxySelection;
}
export type NetworkConfigurationCode =
  | "network-proxy-invalid"
  | "network-proxy-required"
  | "network-source-unknown"
  | "network-provider-unknown"
  | "network-local-target"
  | "network-target-unresolved";
export class NetworkConfigurationError extends Error {
  constructor(readonly code: NetworkConfigurationCode) {
    super("network configuration is invalid");
    this.name = "NetworkConfigurationError";
  }
}
export function parseNetworkEgress(value: unknown): NetworkEgress {
  if (value !== "direct" && value !== "proxy")
    throw new ContractValidationError();
  return value;
}
export function normalizeNetworkProxy(value: unknown): string {
  const invalid = (): never => {
    throw new NetworkConfigurationError("network-proxy-invalid");
  };
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\p{Cc}\p{Cf}]/u.test(value)
  )
    invalid();
  const match = /^http:\/\/(\[[0-9a-f:]+\]|[^/:@?#]+):([0-9]+)$/iu.exec(
    value as string,
  );
  if (
    !match ||
    !Number.isSafeInteger(Number(match[2])) ||
    Number(match[2]) < 1 ||
    Number(match[2]) > 65535
  )
    invalid();
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "http:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    invalid();
  return `http://${url.hostname}:${Number(match![2])}`;
}
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new NetworkConfigurationError("network-proxy-invalid");
  return value as Record<string, unknown>;
}
function flag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw new NetworkConfigurationError("network-proxy-invalid");
  return value;
}
function names(value: unknown, kind: "source" | "provider"): readonly string[] {
  const code =
    kind === "source" ? "network-source-unknown" : "network-provider-unknown";
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (v) => typeof v !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/u.test(v),
    ) ||
    new Set(value).size !== value.length
  )
    throw new NetworkConfigurationError(code);
  if (
    kind === "source" &&
    value.some((v) => !(LITERATURE_SOURCE_IDS as readonly string[]).includes(v))
  )
    throw new NetworkConfigurationError(code);
  return Object.freeze([...value]) as readonly string[];
}
export function parseOutboundNetworkConfiguration(
  value: unknown = {},
): OutboundNetworkConfiguration {
  const r = fields(value, ["proxy", "via_proxy"]),
    v = fields(r.via_proxy ?? {}, [
      "sources",
      "doi_resolution",
      "providers",
      "mineru",
      "browser",
    ]);
  const proxy =
    r.proxy === undefined || r.proxy === null
      ? null
      : normalizeNetworkProxy(r.proxy);
  const via_proxy = Object.freeze({
    sources: names(v.sources, "source"),
    doi_resolution: flag(v.doi_resolution),
    providers: names(v.providers, "provider"),
    mineru: flag(v.mineru),
    browser: flag(v.browser),
  });
  if (
    !proxy &&
    (via_proxy.sources.length ||
      via_proxy.providers.length ||
      via_proxy.doi_resolution ||
      via_proxy.mineru ||
      via_proxy.browser)
  )
    throw new NetworkConfigurationError("network-proxy-required");
  return Object.freeze({ proxy, via_proxy });
}
export function parseNetworkReadiness(value: unknown): NetworkReadiness {
  const r = fields(value, [
    "proxy_configured",
    "proxy_authentication",
    "via_proxy",
  ]);
  if (
    typeof r.proxy_configured !== "boolean" ||
    typeof r.proxy_authentication !== "boolean" ||
    r.via_proxy === undefined
  )
    throw new ContractValidationError();
  const selection = parseOutboundNetworkConfiguration({
    proxy: r.proxy_configured ? "http://127.0.0.1:80" : null,
    via_proxy: r.via_proxy,
  }).via_proxy;
  if (!r.proxy_configured && r.proxy_authentication)
    throw new ContractValidationError();
  return Object.freeze({
    proxy_configured: r.proxy_configured,
    proxy_authentication: r.proxy_authentication,
    via_proxy: selection,
  });
}
