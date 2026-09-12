import {
  canonicalJsonBytes,
  sha256,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type { MetadataTransport } from "./providers.js";
import type {
  MetadataLookupPort,
  RawItemSession,
  TopicSearchPort,
  TopicSearchQuery,
} from "./ports.js";
import { parseCrossrefRecord } from "./crossref-fixture.js";

interface CrossrefPage {
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface CrossrefAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly mailto?: string | null;
  readonly pageSize?: number;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}

function requireObject(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}

function readPage(value: unknown, lookup: boolean): CrossrefPage {
  const root = requireObject(value, "Crossref response is invalid");
  if (root.status !== "ok") throw new Error("Crossref response failed");
  const message = requireObject(root.message, "Crossref message is invalid");
  if (lookup) {
    if (root["message-type"] !== "work")
      throw new Error("Crossref lookup response is invalid");
    return { items: [message], nextCursor: null };
  }
  if (root["message-type"] !== "work-list")
    throw new Error("Crossref search response is invalid");
  if (!Array.isArray(message.items))
    throw new Error("Crossref items are invalid");
  const cursor = message["next-cursor"];
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string")
    throw new Error("Crossref cursor is invalid");
  return {
    items: message.items,
    nextCursor: cursor === null || cursor === undefined ? null : cursor,
  };
}

function normalizeDoi(value: string): string {
  const doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "");
  if (!doi || /[\p{Cc}\p{Cf}]/u.test(doi))
    throw new TypeError("Crossref DOI is invalid");
  return doi;
}

function pageSize(value: number | undefined): number {
  const size = value ?? 100;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000)
    throw new TypeError("Crossref page size is invalid");
  return size;
}

/**
 * Concrete Crossref REST adapter. Vendor JSON is parsed here and never leaves
 * the Metadata port as a provider-specific value.
 */
export class CrossrefRestAdapter
  implements TopicSearchPort, MetadataLookupPort
{
  readonly provider_name = "crossref" as const;
  private readonly origin: URL;
  private readonly size: number;
  private readonly mailto: string | null;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;

  constructor(private readonly options: CrossrefAdapterOptions) {
    this.origin = new URL(options.origin ?? "https://api.crossref.org");
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("Crossref origin must be an HTTPS origin");
    this.size = pageSize(options.pageSize);
    this.mailto = options.mailto?.trim() || null;
    if (
      this.mailto !== null &&
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(this.mailto)
    )
      throw new TypeError("Crossref mailto is invalid");
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  open_topic_search(query: TopicSearchQuery): RawItemSession {
    const parameters = {
      query: query.query,
      year_from: query.year_from,
      year_to: query.year_to,
    };
    const parametersHash = sha256(canonicalJsonBytes(parameters));
    let cursor: string | null = "*";
    let items: readonly unknown[] = [];
    let index = 0;
    let exhausted = false;
    let fetched = false;
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
        const url = this.url("/works");
        url.searchParams.set("query.bibliographic", query.query);
        url.searchParams.set("rows", String(this.size));
        url.searchParams.set("cursor", cursor!);
        const filter = this.yearFilter(query);
        if (filter !== null) url.searchParams.set("filter", filter);
        this.addMailto(url);
        const page = readPage(
          await this.options.transport.request(url.toString()),
          false,
        );
        if (!page.items.length) {
          exhausted = true;
          return null;
        }
        if (fetched && page.nextCursor === cursor)
          throw new Error("Crossref pagination made no progress");
        fetched = true;
        items = page.items;
        index = 0;
        cursor = page.nextCursor;
        exhausted = cursor === null;
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) => {
        const [observation_id, provenance_id, observed_at, parameters_sha256] =
          await Promise.all([
            this.observationId(),
            this.provenanceId(),
            Promise.resolve(this.clock()),
            parametersHash,
          ]);
        return {
          observations: [
            await parseCrossrefRecord(raw_item, {
              observation_id,
              provenance_id,
              observed_at,
              parameters_sha256,
            }),
          ],
          relations: [],
        };
      },
    };
  }

  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const candidate =
      key.record_id ??
      key.identifiers.find((item) => item.namespace === "doi")?.value;
    if (!candidate) throw new TypeError("Crossref lookup requires a DOI");
    const doi = normalizeDoi(candidate);
    let delivered = false;
    return {
      pull_raw_item: async () => {
        if (delivered) return null;
        const url = this.url(`/works/${encodeURIComponent(doi)}`);
        this.addMailto(url);
        const page = readPage(
          await this.options.transport.request(url.toString()),
          true,
        );
        delivered = true;
        return {
          raw_item: page.items[0]!,
          source_exhausted_after: true,
        };
      },
      convert_raw_item: async (raw_item) => ({
        observations: [
          await parseCrossrefRecord(raw_item, {
            observation_id: await this.observationId(),
            provenance_id: await this.provenanceId(),
            observed_at: this.clock(),
            parameters_sha256: await sha256(
              canonicalJsonBytes({ lookup: doi }),
            ),
          }),
        ],
        relations: [],
      }),
    };
  }

  private url(path: string): URL {
    return new URL(`${this.origin.toString().replace(/\/$/u, "")}${path}`);
  }

  private addMailto(url: URL): void {
    if (this.mailto !== null) url.searchParams.set("mailto", this.mailto);
  }

  private yearFilter(query: TopicSearchQuery): string | null {
    if (query.year_from === null && query.year_to === null) return null;
    const from = query.year_from ?? query.year_to!;
    const to = query.year_to ?? query.year_from!;
    return `from-pub-date:${from}-01-01,until-pub-date:${to}-12-31`;
  }
}
