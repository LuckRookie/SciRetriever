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

export type NetworkHttpFailureReason =
  | "invalid-request"
  | "cancelled"
  | "timeout"
  | "response-limit"
  | "response-protocol"
  | "response-incomplete"
  | "request-failed"
  | "budget"
  | "redirect-limit";

export class NetworkHttpError extends Error {
  readonly code = "network-http" as const;
  readonly retry_after_ms?: number;
  constructor(
    readonly reason: NetworkHttpFailureReason = "request-failed",
    options: { readonly cause?: unknown; readonly retryAfterMs?: number } = {},
  ) {
    super("network HTTP operation failed", { cause: options.cause });
    this.name = "NetworkHttpError";
    if (options.retryAfterMs !== undefined)
      this.retry_after_ms = options.retryAfterMs;
  }
}
export interface HttpResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  /** Final admitted URL, without transport-only credential query parameters. */
  readonly final_url?: string;
  /** Bounded Retry-After observed on this request, including earlier hops. */
  readonly retry_after_ms?: number;
}
export interface HttpResponseSink {
  readonly headers: (
    response: Pick<HttpResponse, "status" | "headers">,
  ) => void;
  /** Awaited before reading the next chunk, preserving backpressure. */
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly idleTimeoutMs: number;
  readonly lifetimeMs: number;
}
export interface HttpRequestOptions {
  readonly responseSink?: HttpResponseSink;
  /** Runs after permit/connection acquisition, immediately before sending. */
  readonly onDispatched?: () => void;
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
    readonly resolveAccess?: AccessResolver;
  };
}
export type AccessResolver = (url: string) => {
  readonly scope: string;
  readonly limits: Partial<BudgetLimits>;
};
export interface AgentTransportOptions {
  readonly resolver: Resolver;
  readonly policy: DestinationPolicy;
  readonly coordinator: NetworkBudgetCoordinator;
  readonly scope: string;
  readonly limits: BudgetLimits;
  readonly connection?: ConnectionDependencies;
  readonly maxRedirects?: number;
  readonly maxRetries?: number;
  readonly resolveAccess?: AccessResolver;
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
function invalid(
  reason: NetworkHttpFailureReason = "invalid-request",
  cause?: unknown,
): never {
  throw new NetworkHttpError(reason, { cause });
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
    // MinerU's existing bounded archive contract permits 128 MiB. Each caller's
    // smaller declared allowance is still enforced while consuming the response.
    limit > (options.responseSink ? Number.MAX_SAFE_INTEGER : 128 * 1024 * 1024)
  )
    invalid();
  if (
    options.responseSink &&
    [options.responseSink.idleTimeoutMs, options.responseSink.lifetimeMs].some(
      (value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 86_400_000,
    )
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
  if (signal?.aborted) invalid("cancelled");
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const remaining = (): number => {
    const value = Math.ceil(timeoutMs - (performance.now() - started));
    if (value < 1) invalid("timeout");
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
    if (signal?.aborted) invalid("cancelled", error);
    if (error instanceof NetworkConnectionError) throw error;
    if (error instanceof NetworkHttpError) throw error;
    invalid("budget", error);
  }
  const socket = connection.socket;
  const agent = new Agent({ keepAlive: false });
  // The Agent can only reuse this already connected, IP-pinned socket.
  agent.createConnection = () => socket;
  let dispatchFailure: { readonly error: unknown } | undefined;
  try {
    return await new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        response?: HttpResponse,
        failure = new NetworkHttpError(),
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(idleTimer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        agent.destroy();
        permit?.release();
        if (response) resolve(response);
        else reject(failure);
      };
      const fail = (reason: NetworkHttpFailureReason, cause?: unknown): void =>
        finish(undefined, new NetworkHttpError(reason, { cause }));
      const abort = (): void => fail("cancelled");
      const timeout = (): void => fail("timeout");
      const responseFailure = (cause?: unknown): void =>
        fail("response-incomplete", cause);
      const consumeResponse = (bytes: number): void => {
        try {
          permit?.consumeResponse(bytes);
        } catch (error) {
          invalid("response-limit", error);
        }
      };
      let timer = setTimeout(timeout, remaining());
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) {
          abort();
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
        // Preserve browser-issued signed query encoding unless credentials must be
        // appended by the explicit API credential owner.
        let query = destination.url.query;
        if (options.credentialQuery?.length) {
          const parameters = new URLSearchParams(query);
          for (const [name, value] of options.credentialQuery)
            parameters.append(name, value);
          query = parameters.toString();
        }
        const req = request({
          agent,
          method: options.method ?? "GET",
          host: destination.url.hostname,
          port: destination.url.port,
          path: `${destination.url.path}${query ? `?${query}` : ""}`,
          headers: rawHeaders,
          maxHeaderSize: 65_536,
          insecureHTTPParser: false,
        });
        req.on("error", (error) => fail("request-failed", error));
        req.on("upgrade", () => fail("response-protocol"));
        req.on("response", (res) => {
          // Apply feedback while this request still owns its permit. A queued
          // sibling must not slip through between release and response handling.
          if (options.budget) {
            try {
              const budget = options.budget;
              const value = res.headers["retry-after"];
              const delay =
                typeof value === "string"
                  ? budget.coordinator.retryAfterMilliseconds(
                      value,
                      budget.limits,
                    )
                  : res.statusCode === 429
                    ? budget.limits.rateLimitBackoffMs
                    : undefined;
              if (delay !== undefined)
                budget.coordinator.applyRetryAfter(
                  budget.scope,
                  destination.url.hostname,
                  delay / 1000,
                  budget.limits,
                );
            } catch (error) {
              fail("response-protocol", error);
              res.destroy();
              return;
            }
          }
          if (options.responseSink) {
            const sink = options.responseSink;
            clearTimeout(timer);
            timer = setTimeout(timeout, sink.lifetimeMs);
            const resetIdle = () => {
              clearTimeout(idleTimer);
              idleTimer = setTimeout(timeout, sink.idleTimeoutMs);
            };
            resetIdle();
            res.on("error", responseFailure);
            res.on("aborted", responseFailure);
            void (async () => {
              if (
                !res.statusCode ||
                res.statusCode < 200 ||
                res.statusCode > 599
              )
                invalid("response-protocol");
              const headers: (readonly [string, string])[] = [];
              for (let i = 0; i < res.rawHeaders.length; i += 2)
                headers.push([
                  res.rawHeaders[i]!.toLowerCase(),
                  res.rawHeaders[i + 1]!,
                ]);
              const declared = res.headers["content-length"];
              if (declared !== undefined && !/^\d+$/u.test(declared))
                invalid("response-protocol");
              if (
                declared !== undefined &&
                Number(declared) > (options.maxResponseBytes ?? 1_048_576)
              )
                invalid("response-limit");
              sink.headers({ status: res.statusCode, headers });
              let size = 0;
              for await (const bytes of res) {
                if (settled) return;
                const chunk = bytes as Buffer;
                size += chunk.byteLength;
                if (size > (options.maxResponseBytes ?? 1_048_576))
                  invalid("response-limit");
                consumeResponse(chunk.byteLength);
                if (chunk.byteLength > 0) resetIdle();
                await sink.write(chunk);
              }
              if (!res.complete || settled) {
                responseFailure();
                return;
              }
              finish(
                Object.freeze({
                  status: res.statusCode,
                  headers: Object.freeze(headers),
                  body: new Uint8Array(),
                }),
              );
            })().catch((error: unknown) =>
              finish(
                undefined,
                error instanceof NetworkHttpError
                  ? error
                  : new NetworkHttpError("request-failed", { cause: error }),
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("error", responseFailure);
          res.on("aborted", responseFailure);
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            try {
              size += chunk.byteLength;
              if (size > (options.maxResponseBytes ?? 1_048_576))
                invalid("response-limit");
              consumeResponse(chunk.byteLength);
              chunks.push(chunk);
            } catch (error) {
              finish(
                undefined,
                error instanceof NetworkHttpError
                  ? error
                  : new NetworkHttpError("request-failed", { cause: error }),
              );
            }
          });
          res.on("end", () => {
            if (
              !res.complete ||
              !res.statusCode ||
              res.statusCode < 200 ||
              res.statusCode > 599
            ) {
              fail(res.complete ? "response-protocol" : "response-incomplete");
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
            if (!res.complete) responseFailure();
          });
        });
        try {
          options.onDispatched?.();
        } catch (error) {
          dispatchFailure = { error };
          req.destroy();
          finish();
          return;
        }
        req.end(body);
      } catch (error) {
        finish(
          undefined,
          error instanceof NetworkHttpError
            ? error
            : new NetworkHttpError("request-failed", { cause: error }),
        );
      }
    });
  } catch (error) {
    if (dispatchFailure) throw dispatchFailure.error;
    if (error instanceof NetworkHttpError) throw error;
    return invalid("request-failed", error);
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
        ...(input.method !== undefined ? { method: input.method } : {}),
        ...(input.timeout_ms !== undefined
          ? { timeoutMs: input.timeout_ms }
          : {}),
        maxResponseBytes: options.limits.maxResponseBytes,
        headers: input.headers,
        ...(input.credential_query
          ? { credentialQuery: input.credential_query }
          : {}),
        body: input.body,
        ...(input.onDispatched ? { onDispatched: input.onDispatched } : {}),
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
          ...(options.resolveAccess
            ? { resolveAccess: options.resolveAccess }
            : {}),
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
  let observedRetryAfterMs: number | undefined;
  let redirects = 0;
  try {
    for (;;) {
      const access = options.budget?.resolveAccess?.(destination.url.url);
      const budget = options.budget
        ? {
            ...options.budget,
            ...(access
              ? {
                  scope: access.scope,
                  limits: { ...options.budget.limits, ...access.limits },
                }
              : {}),
            ...(usage ? { usage } : {}),
          }
        : undefined;
      const response = await requestOnce(
        destination,
        destination.addresses[0]!,
        {
          ...options,
          method,
          headers,
          credentialQuery,
          body,
          ...(budget ? { budget } : {}),
        },
      );
      const retryAfter = response.headers.find(
        ([name]) => name === "retry-after",
      )?.[1];
      let retryDelayMs: number | undefined;
      if (retryAfter !== undefined) {
        const parser = budget?.coordinator ?? new NetworkBudgetCoordinator();
        retryDelayMs = parser.retryAfterMilliseconds(
          retryAfter,
          budget?.limits ?? {
            maxConcurrency: 1,
            maxResponseBytes: options.maxResponseBytes ?? 1_048_576,
            maxRedirects: redirectLimit,
            maxRetries: retryLimit,
          },
        );
        observedRetryAfterMs = Math.max(
          observedRetryAfterMs ?? 0,
          retryDelayMs,
        );
      }
      if (
        response.status === 429 &&
        retryDelayMs === undefined &&
        budget?.limits.rateLimitBackoffMs !== undefined
      ) {
        retryDelayMs = Math.min(
          budget.limits.rateLimitBackoffMs,
          budget.limits.maxRetryAfterMs ?? 120_000,
        );
        observedRetryAfterMs = Math.max(
          observedRetryAfterMs ?? 0,
          retryDelayMs,
        );
      }
      if (
        [408, 425, 429, 500, 502, 503, 504].includes(response.status) &&
        retries < retryLimit &&
        (retryDelayMs === undefined ||
          retryDelayMs < (options.timeoutMs ?? 10_000))
      ) {
        if (usage) usage.consumeRetry();
        retries += 1;
        if (retryDelayMs !== undefined && !options.budget)
          await waitForRetry(retryDelayMs, options.signal);
        continue;
      }
      if (![301, 302, 303, 307, 308].includes(response.status))
        return Object.freeze({
          ...response,
          final_url: destination.url.url,
          ...(observedRetryAfterMs === undefined
            ? {}
            : { retry_after_ms: observedRetryAfterMs }),
        });
      if (redirects >= redirectLimit) invalid("redirect-limit");
      try {
        usage?.consumeRedirect();
      } catch (error) {
        invalid("redirect-limit", error);
      }
      redirects += 1;
      const locations = response.headers
        .filter(([name]) => name === "location")
        .map(([, value]) => value);
      if (locations.length !== 1) invalid("response-protocol");
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
      // Retry-After on a redirect also postpones following a different host;
      // releasing the old host's permit must not bypass the announced delay.
      if (retryDelayMs !== undefined)
        await waitForRetry(
          retryDelayMs,
          options.signal ?? options.budget?.signal,
        );
      destination = redirect.destination;
    }
  } catch (error) {
    if (error instanceof NetworkHttpError && observedRetryAfterMs !== undefined)
      throw new NetworkHttpError(error.reason, {
        cause: error,
        retryAfterMs: observedRetryAfterMs,
      });
    throw error;
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
    const abort = (): void => finish(new NetworkHttpError("cancelled"));
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
