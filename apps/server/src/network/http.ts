import { Agent, request } from "node:http";
import type { AgentTransport } from "../agents/protocol.js";

import {
  connectVerified,
  NetworkConnectionError,
  type ConnectionDependencies,
} from "./connection.js";
import {
  createBudgetUsage,
  NetworkBudgetCoordinator,
  type BudgetLimits,
  type BudgetPermit,
  type BudgetUsage,
} from "./budget.js";
import {
  assertResolvedDestination,
  evaluateRedirect,
  resolveDestination,
  type DestinationPolicy,
  type Resolver,
  type ResolvedDestination,
} from "./policy.js";

export class NetworkHttpError extends Error {
  readonly code = "network-http" as const;
  constructor() {
    super("network HTTP operation failed");
    this.name = "NetworkHttpError";
  }
}
export interface HttpResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}
export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly credentialQuery?: readonly (readonly [string, string])[];
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly connection?: ConnectionDependencies;
  readonly signal?: AbortSignal;
  readonly budget?: {
    readonly coordinator: NetworkBudgetCoordinator;
    readonly scope: string;
    readonly limits: BudgetLimits;
    readonly signal?: AbortSignal;
    readonly usage?: BudgetUsage;
  };
}
export interface AgentTransportOptions {
  readonly resolver: Resolver;
  readonly policy: DestinationPolicy;
  readonly coordinator: NetworkBudgetCoordinator;
  readonly scope: string;
  readonly limits: BudgetLimits;
  readonly connection?: ConnectionDependencies;
  readonly maxRedirects?: number;
  readonly maxRetries?: number;
}
const NETWORK_HEADERS = new Set([
  "connection",
  "contentlength",
  "host",
  "transferencoding",
  "keepalive",
  "proxyauthenticate",
  "proxyauthorization",
  "proxyconnection",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);
function invalid(): never {
  throw new NetworkHttpError();
}
function validateOptions(options: HttpRequestOptions): void {
  if (typeof options !== "object" || options === null) invalid();
  const method = options.method ?? "GET";
  const headers = options.headers ?? [];
  const credentialQuery = options.credentialQuery ?? [];
  if (
    typeof method !== "string" ||
    !/^[A-Z][A-Z0-9-]{0,31}$/u.test(method) ||
    method === "CONNECT" ||
    !Array.isArray(headers) ||
    headers.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string" ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(pair[0]) ||
        NETWORK_HEADERS.has(
          pair[0].toLowerCase().replaceAll(/[^a-z0-9]/gu, ""),
        ) ||
        /[\p{Cc}\p{Cf}]/u.test(pair[1]),
    ) ||
    !Array.isArray(credentialQuery) ||
    credentialQuery.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(pair[0]) ||
        !pair[1] ||
        pair[1].length > 16_384 ||
        /[\p{Cc}\p{Cf}]/u.test(pair[1]),
    ) ||
    (options.body !== undefined && !(options.body instanceof Uint8Array)) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    invalid();
  const timeout = options.timeoutMs ?? 10_000;
  const limit = options.maxResponseBytes ?? 1_048_576;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 120_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 67_108_864
  )
    invalid();
  if (
    options.budget !== undefined &&
    (!options.budget ||
      !(options.budget.coordinator instanceof NetworkBudgetCoordinator))
  )
    invalid();
}

export async function requestOnce(
  destination: ResolvedDestination,
  address: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  validateOptions(options);
  try {
    assertResolvedDestination(destination);
  } catch {
    invalid();
  }
  const signal = options.signal ?? options.budget?.signal;
  if (signal?.aborted) invalid();
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const remaining = (): number => {
    const value = Math.ceil(timeoutMs - (performance.now() - started));
    if (value < 1) invalid();
    return value;
  };
  let permit: BudgetPermit | undefined;
  let connection: Awaited<ReturnType<typeof connectVerified>>;
  try {
    if (options.budget)
      permit = await options.budget.coordinator.acquire(
        options.budget.scope,
        destination.url.hostname,
        options.budget.limits,
        {
          timeoutMs: remaining(),
          ...(signal ? { signal } : {}),
          ...(options.budget.usage ? { usage: options.budget.usage } : {}),
        },
      );
    connection = await connectVerified(
      destination,
      address,
      remaining(),
      options.connection,
      signal,
    );
  } catch (error) {
    permit?.release();
    if (error instanceof NetworkConnectionError) throw error;
    invalid();
  }
  const socket = connection.socket;
  const agent = new Agent({ keepAlive: false });
  // The Agent can only reuse this already connected, IP-pinned socket.
  agent.createConnection = () => socket;
  try {
    return await new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = (response?: HttpResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        agent.destroy();
        permit?.release();
        if (response) resolve(response);
        else reject(new NetworkHttpError());
      };
      const abort = (): void => finish();
      const timer = setTimeout(abort, remaining());
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) {
          finish();
          return;
        }
        const body = options.body ?? new Uint8Array();
        const host = destination.url.hostname.includes(":")
          ? `[${destination.url.hostname}]`
          : destination.url.hostname;
        const authority =
          destination.url.port ===
          (destination.url.scheme === "https" ? 443 : 80)
            ? host
            : `${host}:${destination.url.port}`;
        const rawHeaders = (options.headers ?? []).flatMap(([name, value]) => [
          name,
          value,
        ]);
        rawHeaders.push(
          "Host",
          authority,
          "Connection",
          "close",
          "Content-Length",
          String(body.byteLength),
        );
        const query = new URLSearchParams(destination.url.query);
        for (const [name, value] of options.credentialQuery ?? [])
          query.append(name, value);
        const req = request({
          agent,
          method: options.method ?? "GET",
          host: destination.url.hostname,
          port: destination.url.port,
          path: `${destination.url.path}${query.size ? `?${query.toString()}` : ""}`,
          headers: rawHeaders,
          maxHeaderSize: 65_536,
          insecureHTTPParser: false,
        });
        req.on("error", abort);
        req.on("upgrade", abort);
        req.on("response", (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("error", abort);
          res.on("aborted", abort);
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            try {
              size += chunk.byteLength;
              if (size > (options.maxResponseBytes ?? 1_048_576)) invalid();
              permit?.consumeResponse(chunk.byteLength);
              chunks.push(chunk);
            } catch {
              finish();
            }
          });
          res.on("end", () => {
            if (
              !res.complete ||
              !res.statusCode ||
              res.statusCode < 200 ||
              res.statusCode > 599
            ) {
              finish();
              return;
            }
            const headers: (readonly [string, string])[] = [];
            for (let index = 0; index < res.rawHeaders.length; index += 2)
              headers.push(
                Object.freeze([
                  res.rawHeaders[index]!.toLowerCase(),
                  res.rawHeaders[index + 1]!,
                ]),
              );
            finish(
              Object.freeze({
                status: res.statusCode,
                headers: Object.freeze(headers),
                body: new Uint8Array(Buffer.concat(chunks)),
              }),
            );
          });
          res.on("close", () => {
            if (!res.complete) finish();
          });
        });
        req.end(body);
      } catch {
        finish();
      }
    });
  } catch {
    return invalid();
  } finally {
    socket.destroy();
    agent.destroy();
    permit?.release();
  }
}

/** Build the only transport an Agent adapter should receive. */
export function createAgentTransport(
  options: AgentTransportOptions,
): AgentTransport {
  return async (input) => {
    const response = await requestFollowingRedirects(
      input.endpoint,
      options.resolver,
      options.policy,
      {
        headers: input.headers,
        ...(input.credential_query
          ? { credentialQuery: input.credential_query }
          : {}),
        body: input.body,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(options.connection ? { connection: options.connection } : {}),
        ...(options.maxRedirects !== undefined
          ? { maxRedirects: options.maxRedirects }
          : {}),
        ...(options.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
        budget: {
          coordinator: options.coordinator,
          scope: options.scope,
          limits: options.limits,
        },
      },
    );
    return response;
  };
}

/** Follow only bounded redirects, re-admitting each target before any socket opens. */
export async function requestFollowingRedirects(
  url: string,
  resolver: Resolver,
  policy: DestinationPolicy,
  options: HttpRequestOptions & {
    readonly maxRedirects?: number;
    readonly maxRetries?: number;
  } = {},
): Promise<HttpResponse> {
  validateOptions(options);
  const limit = options.maxRedirects ?? 5;
  const budgetLimit = options.budget?.limits.maxRedirects ?? limit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 20 ||
    !Number.isSafeInteger(budgetLimit) ||
    budgetLimit < 0
  )
    invalid();
  const redirectLimit = Math.min(limit, budgetLimit);
  const retryLimit = Math.min(
    options.maxRetries ?? options.budget?.limits.maxRetries ?? 0,
    options.budget?.limits.maxRetries ?? options.maxRetries ?? 0,
  );
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 0 || retryLimit > 20)
    invalid();
  const usage = options.budget
    ? (options.budget.usage ??
      createBudgetUsage({
        ...options.budget.limits,
        maxRedirects: redirectLimit,
        maxRetries: retryLimit,
      }))
    : undefined;
  let retries = 0;
  let destination = await resolveDestination(url, resolver, policy);
  let headers = options.headers ?? [];
  let credentialQuery = options.credentialQuery ?? [];
  let method = options.method ?? "GET";
  let body = options.body ?? new Uint8Array();
  for (let hops = 0; ; hops += 1) {
    const response = await requestOnce(destination, destination.addresses[0]!, {
      ...options,
      method,
      headers,
      credentialQuery,
      body,
      ...(options.budget && usage
        ? { budget: { ...options.budget, usage } }
        : {}),
    });
    if (
      [408, 425, 429, 500, 502, 503, 504].includes(response.status) &&
      retries < retryLimit
    ) {
      if (usage) usage.consumeRetry();
      else retries += 1;
      if (usage) retries += 1;
      const retryAfter = response.headers.find(
        ([name]) => name === "retry-after",
      )?.[1];
      if (retryAfter !== undefined) {
        const parser =
          options.budget?.coordinator ?? new NetworkBudgetCoordinator();
        const delay = parser.retryAfterMilliseconds(
          retryAfter,
          usage?.limits ?? {
            maxConcurrency: 1,
            maxResponseBytes: options.maxResponseBytes ?? 1_048_576,
            maxRedirects: redirectLimit,
            maxRetries: retryLimit,
          },
        );
        if (options.budget) {
          options.budget.coordinator.applyRetryAfter(
            options.budget.scope,
            destination.url.hostname,
            delay / 1000,
            usage?.limits ?? options.budget.limits,
          );
        } else await waitForRetry(delay, options.signal);
      }
      continue;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (usage) usage.consumeRedirect();
    else if (hops >= redirectLimit) invalid();
    const locations = response.headers
      .filter(([name]) => name === "location")
      .map(([, value]) => value);
    if (locations.length !== 1) invalid();
    const redirect = await evaluateRedirect(
      destination,
      locations[0]!,
      resolver,
      policy,
    );
    if (!redirect.forward_credentials) {
      headers = [];
      credentialQuery = [];
      if (body.byteLength > 0) invalid();
    }
    if (response.status === 303 && method !== "HEAD") {
      method = "GET";
      body = new Uint8Array();
    }
    if (
      [301, 302].includes(response.status) &&
      method !== "GET" &&
      method !== "HEAD"
    )
      invalid();
    destination = redirect.destination;
  }
}

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: NetworkHttpError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => finish(new NetworkHttpError());
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
