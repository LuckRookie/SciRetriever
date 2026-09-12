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
  object,
  observation,
  origin,
  pageSize,
  records,
  requestWithHeaders,
  safeUrl,
  text,
} from "./rest-common.js";

export interface ElsevierAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly apiKey?: string;
  readonly institutionToken?: string;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}

function nested(value: unknown): Record<string, unknown> {
  const root = object(value, "Elsevier response is invalid");
  return object(
    root["search-results"] ?? root["abstracts-retrieval-response"] ?? root,
    "Elsevier response body is invalid",
  );
}
function entries(
  root: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const values = root.entry ?? root.coredata;
  return values && !Array.isArray(values) && typeof values === "object"
    ? [values as Record<string, unknown>]
    : records(values);
}
function identifierList(
  record: Record<string, unknown>,
): readonly { namespace: string; value: string }[] {
  const result: { namespace: string; value: string }[] = [];
  const add = (namespace: string, value: unknown) => {
    const normalized = namespace === "doi" ? doi(value) : text(value);
    if (
      normalized &&
      !result.some(
        (item) => item.namespace === namespace && item.value === normalized,
      )
    )
      result.push({ namespace, value: normalized });
  };
  add("doi", record["prism:doi"]);
  add("pmid", record["pubmed-id"]);
  add("pii", record.pii);
  const identifier = text(record["dc:identifier"]);
  if (identifier?.startsWith("SCOPUS_ID:"))
    add("scopus", identifier.slice("SCOPUS_ID:".length));
  return result;
}
function authorValues(record: Record<string, unknown>): readonly unknown[] {
  const authors =
    record.author ??
    (record.authors && typeof record.authors === "object"
      ? (record.authors as Record<string, unknown>).author
      : null);
  return records(authors);
}

export class ElsevierRestAdapter
  implements TopicSearchPort, MetadataLookupPort
{
  readonly provider_name = "elsevier" as const;
  private readonly base: URL;
  private readonly size: number;
  private readonly requestHeaders: Readonly<Record<string, string>>;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: ElsevierAdapterOptions) {
    this.base = origin(options.origin, "https://api.elsevier.com", "Elsevier");
    this.size = pageSize(options.pageSize, 25, 200, "Elsevier");
    if (
      options.apiKey !== undefined &&
      (!options.apiKey.trim() || /[\p{Cc}\p{Cf}]/u.test(options.apiKey))
    )
      throw new TypeError("Elsevier API key is invalid");
    if (
      options.institutionToken !== undefined &&
      (!options.institutionToken.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(options.institutionToken))
    )
      throw new TypeError("Elsevier institution token is invalid");
    this.requestHeaders = {
      ...(options.apiKey ? { "x-els-apikey": options.apiKey } : {}),
      ...(options.institutionToken
        ? { "x-els-insttoken": options.institutionToken }
        : {}),
    };
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.searchSession(query.query, query);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const record = key.record_id;
    const identifier = key.identifiers.find((item) =>
      ["doi", "pmid"].includes(item.namespace),
    );
    if (!record && !identifier)
      throw new TypeError("Elsevier lookup key is empty");
    return this.lookupSession(
      record ?? `${identifier!.namespace}:${identifier!.value}`,
      key,
    );
  }
  private searchSession(
    query: string,
    topic: TopicSearchQuery,
  ): RawItemSession {
    let cursor = "*";
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
        const url = new URL("/content/search/scopus", this.base);
        const clauses = [
          `TITLE-ABS-KEY("${query.replace(/([\\"])/gu, "\\$1")}")`,
        ];
        if (topic.year_from !== null)
          clauses.push(`PUBYEAR AFT ${topic.year_from - 1}`);
        if (topic.year_to !== null)
          clauses.push(`PUBYEAR BEF ${topic.year_to + 1}`);
        url.searchParams.set("query", clauses.join(" AND "));
        url.searchParams.set("cursor", cursor);
        url.searchParams.set("count", String(this.size));
        url.searchParams.set("view", "COMPLETE");
        const root = nested(
          await requestWithHeaders(
            this.options.transport,
            url.toString(),
            this.requestHeaders,
          ),
        );
        const pageItems = entries(root);
        const cursorValue =
          root.cursor &&
          typeof root.cursor === "object" &&
          !Array.isArray(root.cursor)
            ? text((root.cursor as Record<string, unknown>)["@next"])
            : null;
        if (fetched && cursorValue === cursor)
          throw new Error("Elsevier pagination made no progress");
        fetched = true;
        items = pageItems;
        index = 0;
        exhausted = !cursorValue || !pageItems.length;
        cursor = cursorValue ?? cursor;
        if (!items.length) return null;
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) =>
        this.convert(raw_item as Record<string, unknown>, null, query),
    };
  }
  private lookupSession(
    locator: string,
    expected: ProviderLiteratureKey,
  ): RawItemSession {
    let delivered = false;
    return {
      pull_raw_item: async () => {
        if (delivered) return null;
        delivered = true;
        const [kind, value] = locator.includes(":")
          ? locator.split(":", 2)
          : ["eid", locator];
        const path =
          kind === "doi"
            ? "doi"
            : kind === "pmid"
              ? "pubmed_id"
              : kind === "scopus"
                ? "eid"
                : "eid";
        const url = new URL(
          `/content/abstract/${path}/${encodeURIComponent(value!)}`,
          this.base,
        );
        const root = nested(
          await requestWithHeaders(
            this.options.transport,
            url.toString(),
            this.requestHeaders,
          ),
        );
        const item = entries(root)[0];
        if (!item) return null;
        return { raw_item: item, source_exhausted_after: true };
      },
      convert_raw_item: async (raw_item) =>
        this.convert(raw_item as Record<string, unknown>, expected, null),
    };
  }
  private async convert(
    record: Record<string, unknown>,
    expected: ProviderLiteratureKey | null,
    query: string | null,
  ) {
    const core =
      record.coredata &&
      typeof record.coredata === "object" &&
      !Array.isArray(record.coredata)
        ? (record.coredata as Record<string, unknown>)
        : record;
    const source =
      text(core.eid) ??
      text(core["dc:identifier"])?.replace(/^SCOPUS_ID:/iu, "") ??
      null;
    if (!source) throw new Error("Elsevier record identity is missing");
    const ids = identifierList(core);
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
      throw new Error("Elsevier lookup identity mismatch");
    const links = records(core.link).flatMap((item) => {
      const url = safeUrl(item["@href"]);
      return url
        ? [
            {
              url,
              kind: "landing-page" as const,
              media_type: null,
              asset_role: null,
              version_role: "published" as const,
            },
          ]
        : [];
    });
    return {
      observations: [
        await observation("elsevier", {
          sourceRecordId: source,
          identifiers: ids,
          title: core["dc:title"],
          abstract: core["dc:description"],
          authors: authorValues(record),
          publicationDate: core["prism:coverDate"],
          publicationYear: text(core["prism:coverDate"])?.slice(0, 4),
          documentType: core.subtypeDescription,
          venue: core["prism:publicationName"],
          volume: core["prism:volume"],
          issue: core["prism:issueIdentifier"],
          pages: core["prism:pageRange"],
          citedByCount: core["citedby-count"],
          assetHints: links,
          raw: record,
          observationId: await this.observationId(),
          provenanceId: await this.provenanceId(),
          observedAt: this.clock(),
          parameters: query ? { query } : { lookup: source },
        }),
      ],
      relations: [],
    };
  }
}
