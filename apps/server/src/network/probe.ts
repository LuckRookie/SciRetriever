import { ProxyUnavailableError, type OutboundEgress } from "./egress.js";
import { lookup } from "node:dns/promises";
import { NetworkBudgetCoordinator, type BudgetLimits } from "./budget.js";
import type { ConnectionDependencies } from "./connection.js";
import { NetworkHttpError, requestOnce, type HttpResponse } from "./http.js";
import {
  NetworkPolicyError,
  normalizeUrl,
  resolveDestination,
  type DestinationPolicy,
  type Resolver,
} from "./policy.js";

/**
 * Bounded, single-shot, read-only probe transport.
 *
 * A configuration probe must never redirect, retry, stream a body, or reach a
 * destination the caller did not configure: this module is the only place that
 * turns one already-validated URL into exactly one GET through the shared
 * Network policy and budget. Callers supply the resolved destination policy
 * indirectly by giving one exact URL; credentials are only admitted through the
 * explicit `credential_headers` slot.
 */
export class ProbeRequestError extends Error {
  readonly code = "probe-request" as const;
  constructor() {
    super("probe request failed");
    this.name = "ProbeRequestError";
  }
}

export const PROBE_SCOPE = "configuration-probe";
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_LIMITS: BudgetLimits = Object.freeze({
  maxConcurrency: 1,
  maxHostConcurrency: 1,
  maxResponseBytes: 65_536,
  maxRedirects: 0,
  maxRetries: 0,
});
/** Closed set: a probe may never attach an arbitrary secret-bearing header. */
const PROBE_CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"]);

function invalid(): never {
  throw new ProbeRequestError();
}

/** The production resolver: ordinary system resolution, no probe-specific path. */
export function systemResolver(): Resolver {
  return async (hostname) =>
    (await lookup(hostname, { all: true })).map((item) => item.address);
}

function loopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}

interface ProbeTarget {
  readonly scheme: "http" | "https";
  readonly hostname: string;
  readonly port: number;
}

/**
 * Bind the policy to the single configured destination. Loopback stays an
 * explicit `http` + literal address case; every other probe is `https` only.
 */
function probePolicy(url: ProbeTarget): DestinationPolicy {
  if (url.scheme === "http") {
    if (!loopbackHostname(url.hostname)) invalid();
    return {
      allowed_schemes: ["http"],
      allowed_classes: ["loopback"],
      allowed_addresses:
        url.hostname === "localhost"
          ? ["127.0.0.1", "::1"]
          : [url.hostname.replace(/^\[|\]$/gu, "")],
      allowed_ports: [{ scheme: "http", port: url.port }],
    };
  }
  return {
    allowed_schemes: ["https"],
    allowed_classes: ["public"],
    allowed_origins: [
      { scheme: "https", hostname: url.hostname, port: url.port },
    ],
    allowed_ports: [{ scheme: "https", port: url.port }],
  };
}

function checkHeaders(
  headers: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  if (!Array.isArray(headers) || headers.length > 8) invalid();
  for (const pair of headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(pair[0]) ||
      /[\p{Cc}\p{Cf}]/u.test(pair[1]) ||
      /authorization|cookie|token|secret|key|bearer/iu.test(pair[0])
    )
      invalid();
  }
  return Object.freeze(
    headers.map((pair) => Object.freeze([pair[0], pair[1]] as const)),
  );
}

function checkCredentialHeaders(
  headers: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  if (!Array.isArray(headers) || headers.length > 2) invalid();
  for (const pair of headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      !PROBE_CREDENTIAL_HEADERS.has(pair[0].toLowerCase()) ||
      !pair[1].trim() ||
      /[\p{Cc}\p{Cf}]/u.test(pair[1])
    )
      invalid();
  }
  return Object.freeze(
    headers.map((pair) => Object.freeze([pair[0], pair[1]] as const)),
  );
}

export interface ReadOnlyProbeRequest {
  readonly egress?: OutboundEgress;
  readonly url: string;
  readonly headers?: readonly (readonly [string, string])[];
  /**
   * The only admitted credential slot. Values never enter results, logs or
   * messages; the closed header set keeps a probe from spreading secrets.
   */
  readonly credential_headers?: readonly (readonly [string, string])[];
  readonly coordinator: NetworkBudgetCoordinator;
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Bounded body size; a larger response fails closed instead of streaming. */
  readonly maxResponseBytes?: number;
}

/**
 * Perform exactly one bounded GET against one configured destination. There is
 * no redirect following and no retry: a redirect response is returned to the
 * caller as-is and classified there.
 */
export async function readOnlyProbeRequest(
  request: ReadOnlyProbeRequest,
): Promise<HttpResponse> {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.url !== "string" ||
    !(request.coordinator instanceof NetworkBudgetCoordinator) ||
    (request.signal !== undefined && !(request.signal instanceof AbortSignal))
  )
    invalid();
  const timeoutMs = request.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    invalid();
  // A probe URL is one configured service endpoint: no embedded credentials,
  // no query string and no fragment that could carry a signature or secret.
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return invalid();
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  )
    invalid();
  const scheme = parsed.protocol === "http:" ? "http" : "https";
  const policy = probePolicy({
    scheme,
    hostname: parsed.hostname,
    port: Number(parsed.port || (scheme === "http" ? 80 : 443)),
  });
  const url = normalizeUrl(request.url, policy);
  const maxResponseBytes =
    request.maxResponseBytes ?? PROBE_LIMITS.maxResponseBytes;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 1_048_576
  )
    invalid();
  const limits: BudgetLimits = Object.freeze({
    ...PROBE_LIMITS,
    maxResponseBytes,
  });
  const headers = [
    ...checkHeaders(request.headers ?? []),
    ...checkCredentialHeaders(request.credential_headers ?? []),
  ];
  const resolver = request.resolver ?? systemResolver();
  try {
    const destination = await resolveDestination(url, resolver, policy);
    return await requestOnce(destination, destination.addresses[0]!, {
      method: "GET",
      ...(request.egress ? { egress: request.egress } : {}),
      headers,
      timeoutMs,
      maxResponseBytes,
      ...(request.connection ? { connection: request.connection } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      budget: {
        coordinator: request.coordinator,
        scope: PROBE_SCOPE,
        limits,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    });
  } catch (error) {
    if (
      error instanceof ProxyUnavailableError ||
      error instanceof NetworkHttpError ||
      error instanceof NetworkPolicyError
    )
      throw error;
    invalid();
  }
  return invalid();
}
