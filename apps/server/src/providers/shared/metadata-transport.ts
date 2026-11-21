import { isProxyUnavailable } from "../../network/egress.js";
import {
  parseMetadataObservation,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import type { AgentTransport } from "../../agents/protocol.js";
import type {
  MetadataLookupPort,
  NeutralMetadataItem,
  RawItemSession,
  ReferenceQueryContext,
  ReferenceQueryPort,
  TopicSearchPort,
  TopicSearchQuery,
} from "../../metadata/ports.js";
import { MetadataProviderFailure } from "../../metadata/ports.js";
import {
  isQuotaRejection,
  NetworkBudgetError,
  retryAfterDelay,
  type AccessRatePolicy,
} from "../../network/budget.js";
import { NetworkConnectionError } from "../../network/connection.js";
import { NetworkHttpError } from "../../network/http.js";
import { NetworkPolicyError } from "../../network/policy.js";
export const METADATA_HTTP_TIMEOUT_MS = 30_000;

/** Convert only bounded Network facts; vendor messages and URLs stay private. */
export function metadataTransportFailure(
  error: unknown,
): MetadataProviderFailure {
  if (error instanceof MetadataProviderFailure) return error;
  if (isProxyUnavailable(error))
    return new MetadataProviderFailure(
      {
        code: "proxy-unavailable",
        reason: "The configured outbound proxy is unavailable.",
        action: "Check the configured proxy and its authentication.",
        retryable: true,
      },
      { cause: error },
    );
  const category =
    error instanceof NetworkHttpError
      ? error.reason
      : error instanceof NetworkConnectionError
        ? "connection"
        : error instanceof NetworkPolicyError
          ? "policy"
          : error instanceof NetworkBudgetError
            ? "budget"
            : "transport";
  const reasons: Readonly<Record<string, string>> = {
    timeout: "The metadata provider request timed out.",
    cancelled: "The metadata provider request was cancelled.",
    "response-limit":
      "The metadata provider response exceeded the response byte limit.",
    "response-protocol":
      "The metadata provider returned an invalid HTTP response.",
    "response-incomplete": "The metadata provider response was incomplete.",
    "invalid-request": "The metadata provider request was invalid.",
    "redirect-limit":
      "The metadata provider exceeded the allowed redirect limit.",
    connection: "The metadata provider connection could not be established.",
    policy: "The metadata provider destination was rejected by Network policy.",
    budget:
      "The metadata provider request could not obtain its Network budget.",
  };
  const retryAfter =
    error instanceof NetworkHttpError ? error.retry_after_ms : undefined;
  return new MetadataProviderFailure(
    {
      code: `metadata-network-${category}`,
      reason: `${reasons[category] ?? "The metadata provider request failed in transit."}${retryAfter === undefined ? "" : ` Retry-After is ${retryAfter} ms.`}`,
      action:
        category === "policy" || category === "invalid-request"
          ? "Review the provider adapter and Network policy before retrying."
          : "Retry the request after checking the provider and Network availability.",
      retryable: !["policy", "invalid-request", "cancelled"].includes(category),
    },
    { cause: error },
  );
}

/** Shared HTTP status and payload boundary for JSON and Atom metadata providers. */
export async function requestMetadataResponse(
  transport: AgentTransport,
  request: Parameters<AgentTransport>[0],
  format: "json" | "atom" = "json",
  quota?: AccessRatePolicy["quotaHeaders"],
): Promise<unknown> {
  let response: Awaited<ReturnType<AgentTransport>>;
  try {
    response = await transport(request);
  } catch (error) {
    throw metadataTransportFailure(error);
  }
  if (response.status < 200 || response.status >= 300) {
    const status = response.status;
    const header = (key: string) =>
      response.headers.find(([name]) => name.toLowerCase() === key)?.[1];
    const rateLimited = isQuotaRejection(status, header, quota);
    const category = rateLimited
      ? "rate-limited"
      : status === 401
        ? "authentication"
        : status === 403
          ? "authorization"
          : status >= 500
            ? "unavailable"
            : "http";
    // Network's delay may be a local fallback or capped. Only a response
    // header can replace the task's retry schedule.
    const retryHeader = rateLimited
      ? (header("retry-after") ?? (quota && header(quota.retryAfter)))
      : undefined;
    const declared =
      retryHeader === undefined ? undefined : retryAfterDelay(retryHeader);
    const retryAfter = declared ?? response.retry_after_ms;
    throw new MetadataProviderFailure(
      {
        code: `metadata-provider-${category}`,
        reason: `The metadata provider returned HTTP ${status}.${retryAfter === undefined ? "" : ` Retry-After is ${retryAfter} ms.`}`,
        action:
          category === "authentication" || category === "authorization"
            ? "Check the provider credential and permitted access before retrying."
            : category === "rate-limited"
              ? "Wait for the provider cooldown and retry the request."
              : "Check the provider request and availability before retrying.",
        retryable: rateLimited || status >= 500 || [408, 425].includes(status),
      },
      declared === undefined ? {} : { retry_after_ms: declared },
    );
  }
  if (format === "atom") return response.body;
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.body),
    ) as unknown;
  } catch (error) {
    throw new MetadataProviderFailure(
      {
        code: "metadata-provider-response-invalid",
        reason: "The metadata provider returned an invalid JSON response.",
        action: "Retry the request or update the provider response adapter.",
        retryable: true,
      },
      { cause: error },
    );
  }
}

export interface MetadataTransport {
  request(
    url: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
}

/**
 * Adapt the shared Network-owned AgentTransport to provider JSON. The adapter
 * owns status/body decoding; Network remains the only DNS, redirect, budget
 * and credential-forwarding boundary.
 */
export function createMetadataTransport(
  transport: AgentTransport,
  defaults: Readonly<Record<string, string>> = { accept: "application/json" },
): MetadataTransport {
  return {
    async request(url, options = {}) {
      const headers = Object.entries({
        ...defaults,
        ...(options.headers ?? {}),
      });
      return requestMetadataResponse(transport, {
        endpoint: url,
        method: "GET",
        timeout_ms: METADATA_HTTP_TIMEOUT_MS,
        headers,
        body: new Uint8Array(),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
  };
}
export type MetadataRecordDecoder = (
  value: unknown,
  provider: string,
) => MetadataObservation | null;

function defaultDecoder(
  value: unknown,
  provider: string,
): MetadataObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const observation = record.observation;
  if (observation === undefined) return null;
  try {
    const parsed = parseMetadataObservation(observation);
    if (parsed.provenance.source_name !== provider) return null;
    return parsed;
  } catch {
    return null;
  }
}
function page(value: unknown): {
  readonly items: readonly unknown[];
  readonly next: string | null;
  readonly exhausted: boolean;
} {
  if (Array.isArray(value))
    return { items: value, next: null, exhausted: true };
  if (!value || typeof value !== "object")
    throw new Error("metadata response is invalid");
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.results)
      ? record.results
      : null;
  if (!items) throw new Error("metadata response is invalid");
  const next = record.next_cursor;
  if (next !== undefined && next !== null && typeof next !== "string")
    throw new Error("metadata cursor is invalid");
  return {
    items,
    next: (next as string | null | undefined) ?? null,
    exhausted: next === null || next === undefined,
  };
}

/** Adapter shell shared by all providers; vendor payloads stop at decoder/session. */
export class JsonMetadataAdapter
  implements TopicSearchPort, MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name: string;
  constructor(
    provider_name: string,
    private readonly transport: MetadataTransport,
    private readonly base_url: string,
    private readonly decoder: MetadataRecordDecoder = defaultDecoder,
    private readonly headers: Readonly<Record<string, string>> = {},
  ) {
    if (!provider_name.trim() || !/^https?:\/\//u.test(base_url))
      throw new TypeError("invalid metadata adapter configuration");
    this.provider_name = provider_name;
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session("search", query.query, query.year_from, query.year_to);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const id = key.record_id ?? key.identifiers[0]?.value;
    if (!id) throw new TypeError("metadata lookup key is empty");
    return this.session("lookup", id, null, null);
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    const key = query.keys[0];
    const id = key?.record_id ?? key?.identifiers[0]?.value;
    if (!id) throw new TypeError("metadata reference key is empty");
    return this.session(query.direction, id, null, null);
  }
  private session(
    kind: string,
    value: string,
    year_from: number | null,
    year_to: number | null,
  ): RawItemSession {
    let cursor: string | null = null;
    let items: readonly unknown[] = [];
    let index = 0;
    let exhausted = false;
    return {
      pull_raw_item: async () => {
        if (index < items.length) {
          const raw_item = items[index++]!;
          return {
            raw_item,
            buffered_next: index < items.length,
            source_exhausted_after: exhausted && index === items.length,
          };
        }
        if (exhausted) return null;
        const url = new URL(this.base_url);
        url.pathname = `${url.pathname.replace(/\/$/u, "")}/${encodeURIComponent(kind)}`;
        url.searchParams.set("q", value);
        if (year_from !== null)
          url.searchParams.set("year_from", String(year_from));
        if (year_to !== null) url.searchParams.set("year_to", String(year_to));
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        const response = page(
          await this.transport.request(url.toString(), {
            headers: this.headers,
          }),
        );
        items = response.items;
        index = 0;
        cursor = response.next;
        exhausted = response.exhausted;
        if (!items.length && exhausted) return null;
        if (!items.length)
          throw new Error("metadata pagination made no progress");
        const raw_item = items[index++]!;
        return {
          raw_item,
          buffered_next: index < items.length,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: (raw_item) => {
        const observation = this.decoder(raw_item, this.provider_name);
        const neutral: NeutralMetadataItem = {
          observations: observation ? [observation] : [],
          relations: [],
          ...(observation ? {} : { empty_reason: "record-unusable" }),
        };
        return neutral;
      },
    };
  }
}
