import { randomUUID } from "node:crypto";
import {
  parseProvenance,
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

export interface CoreAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly apiKey?: string;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}

function identifier(
  value: unknown,
): { namespace: string; value: string } | null {
  const item =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const namespace = text(item.type)?.toLowerCase();
  const raw = text(item.identifier);
  if (
    !namespace ||
    !raw ||
    !["doi", "arxiv", "pmid", "pmcid"].includes(namespace)
  )
    return null;
  return {
    namespace,
    value: namespace === "doi" ? doi(raw)! : raw.replace(/^arxiv:/iu, ""),
  };
}
function identifiers(
  record: Record<string, unknown>,
): readonly { namespace: string; value: string }[] {
  const result: { namespace: string; value: string }[] = [];
  const append = (namespace: string, value: unknown) => {
    const raw = text(value);
    if (!raw) return;
    const normalized =
      namespace === "doi" ? doi(raw) : raw.replace(/^arxiv:/iu, "");
    if (
      normalized &&
      !result.some(
        (item) => item.namespace === namespace && item.value === normalized,
      )
    )
      result.push({ namespace, value: normalized });
  };
  append("doi", record.doi);
  append("arxiv", record.arxivId);
  append("pmid", record.pubmedId);
  for (const item of records(record.identifiers)) {
    const parsed = identifier(item);
    if (
      parsed &&
      !result.some(
        (value) =>
          value.namespace === parsed.namespace && value.value === parsed.value,
      )
    )
      result.push(parsed);
  }
  return result;
}
function sourceRecordId(
  record: Record<string, unknown>,
  entity: "work" | "output" = "work",
): string {
  const raw = record.id;
  if (
    !(typeof raw === "number" || typeof raw === "string") ||
    !String(raw).trim()
  )
    throw new Error("CORE record identity is missing");
  return `${entity}:${String(raw).trim()}`;
}
function page(value: unknown): {
  items: readonly Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
} {
  const root = object(value, "CORE response is invalid");
  const total = Number(root.totalHits);
  const offset = Number(root.offset);
  const limit = Number(root.limit);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    throw new Error("CORE response page is invalid");
  return { items: records(root.results), total, offset, limit };
}

export class CoreRestAdapter
  implements TopicSearchPort, MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name = "core" as const;
  private readonly base: URL;
  private readonly size: number;
  private readonly requestHeaders: Readonly<Record<string, string>>;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: CoreAdapterOptions) {
    this.base = origin(options.origin, "https://api.core.ac.uk", "CORE");
    this.size = pageSize(options.pageSize, 100, 100, "CORE");
    this.requestHeaders = options.apiKey
      ? { authorization: `Bearer ${options.apiKey}` }
      : {};
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session("search", query.query, null);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const record = key.record_id;
    if (record) {
      const [prefix, value] = record.includes(":")
        ? record.split(":", 2)
        : ["work", record];
      if ((prefix !== "work" && prefix !== "output") || !value)
        throw new TypeError("CORE lookup key is invalid");
      return this.session("lookup", `${prefix}:${value}`, key);
    }
    const value = key.identifiers.find(
      (item) => item.namespace === "doi",
    )?.value;
    if (!value) throw new TypeError("CORE lookup key is empty");
    return this.session("search", `doi:"${value}"`, key);
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (query.direction !== "references")
      throw new Error("CORE cited-by capability is unavailable");
    const key = query.keys[0];
    if (!key) throw new TypeError("CORE reference key is empty");
    return this.open_lookup(key);
  }
  private session(
    kind: "search" | "lookup",
    value: string,
    expected: ProviderLiteratureKey | null,
  ): RawItemSession {
    let offset = 0;
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
        url.pathname = `${url.pathname.replace(/\/$/u, "")}${kind === "lookup" ? `/v3/${value.startsWith("output:") ? "outputs" : "works"}/${encodeURIComponent(value.split(":")[1]!)}` : "/v3/search/works"}`;
        if (kind === "search") {
          url.searchParams.set("q", value);
          url.searchParams.set("offset", String(offset));
          url.searchParams.set("limit", String(this.size));
        }
        const result = await requestWithHeaders(
          this.options.transport,
          url.toString(),
          this.requestHeaders,
        );
        const pageResult =
          kind === "lookup"
            ? {
                items: records([
                  object(result, "CORE lookup response is invalid"),
                ]),
                total: 1,
                offset: 0,
                limit: 1,
              }
            : page(result);
        if (fetched && kind === "search" && pageResult.offset !== offset)
          throw new Error("CORE pagination made no progress");
        fetched = true;
        items = pageResult.items;
        index = 0;
        offset = pageResult.offset + pageResult.items.length;
        exhausted =
          kind === "lookup" ||
          offset >= pageResult.total ||
          pageResult.items.length < this.size;
        if (!items.length) {
          exhausted = true;
          return null;
        }
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) =>
        this.convert(raw_item as Record<string, unknown>, expected),
    };
  }
  private async convert(
    record: Record<string, unknown>,
    expected: ProviderLiteratureKey | null,
  ): Promise<NeutralMetadataItem> {
    const entity = expected?.record_id?.startsWith("output:")
      ? "output"
      : "work";
    const source = sourceRecordId(record, entity);
    const ids = identifiers(record);
    if (
      expected &&
      expected.record_id &&
      expected.record_id !== source &&
      !ids.some((item) =>
        expected.identifiers.some(
          (candidate) =>
            candidate.namespace === item.namespace &&
            candidate.value === item.value,
        ),
      )
    )
      throw new Error("CORE lookup identity mismatch");
    const current = { record_id: source, identifiers: ids };
    const base = await observation("core", {
      sourceRecordId: source,
      identifiers: ids,
      title: record.title,
      abstract: record.abstract,
      authors: record.authors,
      publicationDate: record.publishedDate,
      publicationYear: record.yearPublished,
      documentType: record.documentType,
      language: record.language,
      venue: records(record.journals)
        .map((item) => item.title)
        .find((item) => text(item)),
      publisher: record.publisher,
      assetHints: [
        record.downloadUrl,
        ...(Array.isArray(record.sourceFulltextUrls)
          ? record.sourceFulltextUrls
          : []),
      ].flatMap((value) => {
        const url = safeUrl(value);
        return url
          ? [
              {
                url,
                kind: "direct-file" as const,
                media_type: "application/pdf",
                asset_role: "primary-pdf" as const,
                version_role: "published" as const,
              },
            ]
          : [];
      }),
      raw: record,
      observationId: await this.observationId(),
      provenanceId: await this.provenanceId(),
      observedAt: this.clock(),
    });
    const provenance = parseProvenance(base.provenance);
    const relations = records(record.references).flatMap((item) => {
      const targetIds = identifiers(item);
      const refId = text(item.id);
      if (!targetIds.length && !refId) return [];
      const cited = {
        record_id: refId ? `work:${refId}` : null,
        identifiers: targetIds,
      };
      if (cited.record_id === current.record_id) return [];
      return [
        { observation_id: randomUUID(), provenance, citing: current, cited },
      ];
    });
    return { observations: [base], relations };
  }
}
