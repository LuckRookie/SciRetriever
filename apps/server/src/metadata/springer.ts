import { randomUUID } from "node:crypto";
import type { ProviderLiteratureKey } from "@sciretriever/contracts";
import type {
  MetadataLookupPort,
  RawItemSession,
  TopicSearchPort,
  TopicSearchQuery,
} from "./ports.js";
import type { MetadataTransport } from "./providers.js";
import {
  doi,
  headers,
  object,
  observation,
  origin,
  pageSize,
  records,
  requestWithHeaders,
  safeUrl,
  text,
} from "./rest-common.js";

export interface SpringerAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly apiKey?: string;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}

function page(value: unknown): {
  items: readonly Record<string, unknown>[];
  total: number;
  start: number;
  length: number;
} {
  const root = object(value, "Springer response is invalid");
  const meta = records(root.result)[0] ?? {};
  const total = Number(text(meta.total) ?? 0);
  const start = Number(text(meta.start) ?? 1);
  const length = Number(text(meta.pageLength) ?? records(root.records).length);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(start) ||
    start < 1 ||
    !Number.isSafeInteger(length) ||
    length < 1
  )
    throw new Error("Springer response page is invalid");
  return { items: records(root.records), total, start, length };
}
function recordIdentifiers(
  record: Record<string, unknown>,
): readonly { namespace: string; value: string }[] {
  const value = doi(record.doi ?? record.identifier);
  return value ? [{ namespace: "doi", value }] : [];
}

export class SpringerRestAdapter
  implements TopicSearchPort, MetadataLookupPort
{
  readonly provider_name = "springer" as const;
  private readonly base: URL;
  private readonly size: number;
  private readonly requestHeaders: Readonly<Record<string, string>>;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: SpringerAdapterOptions) {
    this.base = origin(
      options.origin,
      "https://api.springernature.com/meta/v2/json",
      "Springer",
    );
    this.size = pageSize(options.pageSize, 25, 100, "Springer");
    this.requestHeaders = headers(options.apiKey);
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session(`keyword:${query.query}`, null);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const value = key.identifiers.find(
      (item) => item.namespace === "doi",
    )?.value;
    if (!value) throw new TypeError("Springer lookup requires DOI");
    return this.session(`doi:${value}`, key);
  }
  private session(
    query: string,
    expected: ProviderLiteratureKey | null,
  ): RawItemSession {
    let start = 1;
    let items: readonly Record<string, unknown>[] = [];
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
        const url = new URL(this.base);
        url.searchParams.set("q", query);
        url.searchParams.set("s", String(start));
        url.searchParams.set("p", String(expected ? 1 : this.size));
        const result = page(
          await requestWithHeaders(
            this.options.transport,
            url.toString(),
            this.requestHeaders,
          ),
        );
        if (fetched && result.start !== start)
          throw new Error("Springer pagination made no progress");
        fetched = true;
        items = result.items;
        index = 0;
        start = result.start + result.items.length;
        exhausted =
          expected !== null ||
          result.items.length === 0 ||
          start > result.total;
        if (!items.length) return null;
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) => {
        const record = object(raw_item, "Springer record is invalid");
        const ids = recordIdentifiers(record);
        const source =
          ids[0]?.value ??
          text(record.identifier)?.replace(/^doi:/iu, "") ??
          null;
        if (!source) throw new Error("Springer record identity is missing");
        if (
          expected &&
          expected.identifiers.length &&
          !ids.some((item) =>
            expected.identifiers.some(
              (candidate) =>
                candidate.namespace === item.namespace &&
                candidate.value === item.value,
            ),
          )
        )
          throw new Error("Springer lookup identity mismatch");
        const urls = records(record.url);
        const hints = urls.flatMap((item) => {
          const url = safeUrl(item.value);
          if (!url) return [];
          const format = text(item.format)?.toLowerCase();
          return [
            {
              url,
              kind:
                format === "pdf"
                  ? ("direct-file" as const)
                  : ("landing-page" as const),
              media_type: format === "pdf" ? "application/pdf" : null,
              asset_role: format === "pdf" ? ("primary-pdf" as const) : null,
              version_role: "published" as const,
            },
          ];
        });
        return {
          observations: [
            await observation("springer", {
              sourceRecordId: source,
              identifiers: ids,
              title: record.title,
              abstract: record.abstract,
              authors: record.creators,
              publicationDate: record.publicationDate,
              publicationYear: record.year,
              documentType: record.contentType,
              language: record.language,
              venue: record.publicationName,
              publisher: record.publisher,
              keywords: record.subjects,
              assetHints: hints,
              raw: record,
              observationId: await this.observationId(),
              provenanceId: await this.provenanceId(),
              observedAt: this.clock(),
              parameters: { query },
            }),
          ],
          relations: [],
        };
      },
    };
  }
}
