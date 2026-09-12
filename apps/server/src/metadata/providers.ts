import {
  parseMetadataObservation,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import type {
  MetadataLookupPort,
  NeutralMetadataItem,
  RawItemSession,
  ReferenceQueryContext,
  ReferenceQueryPort,
  TopicSearchPort,
  TopicSearchQuery,
} from "./ports.js";
import type { AgentTransport } from "../agents/protocol.js";

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
      const response = await transport({
        endpoint: url,
        headers,
        body: new Uint8Array(),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error("metadata HTTP request failed");
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(response.body),
        ) as unknown;
      } catch {
        throw new Error("metadata JSON response is invalid");
      }
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

export class WebOfScienceAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("web-of-science", t, b, d);
  }
}
export class CrossrefAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("crossref", t, b, d);
  }
}
export class SemanticScholarAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("semantic-scholar", t, b, d);
  }
}
export class ArxivAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("arxiv", t, b, d);
  }
}
export class OpenAlexAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("openalex", t, b, d);
  }
}
export class EuropePmcAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("europe-pmc", t, b, d);
  }
}
export class ElsevierAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("elsevier", t, b, d);
  }
}
export class SpringerAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("springer", t, b, d);
  }
}
export class DataCiteAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("datacite", t, b, d);
  }
}
export class CoreAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("core", t, b, d);
  }
}
export class OpenCitationsAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("opencitations", t, b, d);
  }
}
