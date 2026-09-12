import { randomUUID } from "node:crypto";
import type { ProviderLiteratureKey } from "@sciretriever/contracts";
import type {
  MetadataLookupPort,
  RawItemSession,
  ReferenceQueryContext,
  ReferenceQueryPort,
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

export interface WebOfScienceAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly apiKey?: string;
  readonly database?: string;
  readonly edition?: string;
  /** Starter v2 and Expanded Full Record are separate product contracts. */
  readonly product?: "starter" | "expanded";
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}

function starterPage(value: unknown): {
  items: readonly Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
} {
  const root = object(value, "Web of Science Starter response is invalid");
  const metadata = object(
    root.metadata,
    "Web of Science Starter metadata is invalid",
  );
  const total = Number(metadata.total);
  const page = Number(metadata.page);
  const limit = Number(metadata.limit);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    throw new Error("Web of Science Starter page is invalid");
  return { items: records(root.hits), total, page, limit };
}
function expandedItems(value: unknown): readonly Record<string, unknown>[] {
  const root = object(value, "Web of Science Expanded response is invalid");
  const data = object(root.Data, "Web of Science Expanded data is invalid");
  const recordsRoot = object(
    object(data.Records, "Web of Science Expanded records are invalid").records,
    "Web of Science Expanded record body is invalid",
  );
  return records(recordsRoot.REC);
}

function expandedPage(value: unknown): {
  items: readonly Record<string, unknown>[];
  total: number;
} {
  const root = object(value, "Web of Science Expanded response is invalid");
  const result = object(
    root.QueryResult,
    "Web of Science Expanded query result is invalid",
  );
  const total = Number(result.RecordsFound);
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error("Web of Science Expanded total is invalid");
  return { items: expandedItems(root), total };
}

function expandedReferencePage(value: unknown): {
  items: readonly Record<string, unknown>[];
  total: number;
} {
  const root = object(
    value,
    "Web of Science Expanded reference response is invalid",
  );
  const result = object(
    root.QueryResult,
    "Web of Science Expanded query result is invalid",
  );
  const total = Number(result.RecordsFound);
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error("Web of Science Expanded reference total is invalid");
  return { items: records(root.Data), total };
}

function expandedKey(record: Record<string, unknown>): {
  readonly record_id: string;
  readonly identifiers: readonly { namespace: string; value: string }[];
} {
  const uid = text(record.UID);
  if (!uid)
    throw new Error("Web of Science Expanded record identity is missing");
  return { record_id: uid, identifiers: expandedIdentifiers(record) };
}

function expandedAuthors(
  summary: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const names =
    summary.names &&
    typeof summary.names === "object" &&
    !Array.isArray(summary.names)
      ? (summary.names as Record<string, unknown>)
      : {};
  return records(names.name)
    .filter((item) => text(item.role)?.toLowerCase() === "author")
    .sort(
      (a, b) => Number(a.seq_no ?? 1_000_000) - Number(b.seq_no ?? 1_000_000),
    )
    .map((item) => ({
      displayName: item.display_name ?? item.full_name,
      given: item.first_name,
      family: item.last_name,
      orcid: item.orcid_id,
    }));
}

function expandedAbstract(full: Record<string, unknown>): string | null {
  const abstracts =
    full.abstracts &&
    typeof full.abstracts === "object" &&
    !Array.isArray(full.abstracts)
      ? (full.abstracts as Record<string, unknown>)
      : {};
  const paragraphs: string[] = [];
  for (const item of records(abstracts.abstract)) {
    const body =
      item.abstract_text &&
      typeof item.abstract_text === "object" &&
      !Array.isArray(item.abstract_text)
        ? (item.abstract_text as Record<string, unknown>)
        : {};
    if (Array.isArray(body.p)) {
      for (const paragraph of body.p) {
        const value =
          text(paragraph) ??
          (paragraph &&
          typeof paragraph === "object" &&
          !Array.isArray(paragraph)
            ? text((paragraph as Record<string, unknown>).content)
            : null);
        if (value) paragraphs.push(value);
      }
    }
  }
  return paragraphs.length ? paragraphs.join(" ") : null;
}

function expandedIdentifiers(
  record: Record<string, unknown>,
): readonly { namespace: string; value: string }[] {
  const result: { namespace: string; value: string }[] = [];
  const append = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    const namespace = text(item.type)?.toLowerCase();
    const raw = text(item.value);
    if (!namespace || !raw || !["doi", "pmid"].includes(namespace)) return;
    const normalized = namespace === "doi" ? doi(raw) : raw;
    if (
      normalized &&
      !result.some(
        (id) => id.namespace === namespace && id.value === normalized,
      )
    )
      result.push({ namespace, value: normalized });
  };
  const staticData =
    record.static_data &&
    typeof record.static_data === "object" &&
    !Array.isArray(record.static_data)
      ? (record.static_data as Record<string, unknown>)
      : {};
  const item =
    staticData.item &&
    typeof staticData.item === "object" &&
    !Array.isArray(staticData.item)
      ? (staticData.item as Record<string, unknown>)
      : {};
  const itemIdentifiers =
    item.identifiers &&
    typeof item.identifiers === "object" &&
    !Array.isArray(item.identifiers)
      ? (item.identifiers as Record<string, unknown>)
      : {};
  for (const id of records(itemIdentifiers.identifier)) append(id);
  const dynamic =
    record.dynamic_data &&
    typeof record.dynamic_data === "object" &&
    !Array.isArray(record.dynamic_data)
      ? (record.dynamic_data as Record<string, unknown>)
      : {};
  const cluster =
    dynamic.cluster_related &&
    typeof dynamic.cluster_related === "object" &&
    !Array.isArray(dynamic.cluster_related)
      ? (dynamic.cluster_related as Record<string, unknown>)
      : {};
  const clusterIdentifiers =
    cluster.identifiers &&
    typeof cluster.identifiers === "object" &&
    !Array.isArray(cluster.identifiers)
      ? (cluster.identifiers as Record<string, unknown>)
      : {};
  for (const id of records(clusterIdentifiers.identifier)) append(id);
  return result;
}
function expandedReferenceTarget(record: Record<string, unknown>): {
  readonly record_id: string | null;
  readonly identifiers: readonly { namespace: string; value: string }[];
} | null {
  const uid = text(record.UID);
  const value = doi(record.doi);
  if (!uid && !value) return null;
  return {
    record_id: uid,
    identifiers: value ? [{ namespace: "doi", value }] : [],
  };
}
function expandedCitedByCount(
  record: Record<string, unknown>,
  database: string,
  edition: string | null,
): number | null {
  const dynamic =
    record.dynamic_data &&
    typeof record.dynamic_data === "object" &&
    !Array.isArray(record.dynamic_data)
      ? (record.dynamic_data as Record<string, unknown>)
      : {};
  const citation =
    dynamic.citation_related &&
    typeof dynamic.citation_related === "object" &&
    !Array.isArray(dynamic.citation_related)
      ? (dynamic.citation_related as Record<string, unknown>)
      : {};
  const list =
    citation.tc_list &&
    typeof citation.tc_list === "object" &&
    !Array.isArray(citation.tc_list)
      ? (citation.tc_list as Record<string, unknown>).silo_tc
      : [];
  const wanted = (edition ?? database).toLowerCase();
  const values = records(list)
    .filter((item) => text(item.coll_id)?.toLowerCase() === wanted)
    .map((item) => Number(item.local_count))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return values.length && values.every((value) => value === values[0])
    ? values[0]!
    : null;
}
function starterIdentifiers(
  record: Record<string, unknown>,
): readonly { namespace: string; value: string }[] {
  const values =
    record.identifiers &&
    typeof record.identifiers === "object" &&
    !Array.isArray(record.identifiers)
      ? (record.identifiers as Record<string, unknown>)
      : {};
  return [
    doi(values.doi) ? { namespace: "doi", value: doi(values.doi)! } : null,
    text(values.pmid) ? { namespace: "pmid", value: text(values.pmid)! } : null,
  ].filter(
    (item): item is { namespace: string; value: string } => item !== null,
  );
}
function expandedRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const uid = text(record.UID);
  const staticData = object(
    record.static_data,
    "Web of Science Expanded static data is invalid",
  );
  const summary = object(
    staticData.summary,
    "Web of Science Expanded summary is invalid",
  );
  const titles = records(
    object(summary.titles, "Web of Science Expanded titles are invalid").title,
  );
  const itemTitle = titles.find(
    (item) => text(item.type)?.toLowerCase() === "item",
  );
  const pub = object(
    summary.pub_info,
    "Web of Science Expanded publication info is invalid",
  );
  const full =
    staticData.fullrecord_metadata &&
    typeof staticData.fullrecord_metadata === "object" &&
    !Array.isArray(staticData.fullrecord_metadata)
      ? (staticData.fullrecord_metadata as Record<string, unknown>)
      : {};
  const dynamic =
    record.dynamic_data &&
    typeof record.dynamic_data === "object" &&
    !Array.isArray(record.dynamic_data)
      ? (record.dynamic_data as Record<string, unknown>)
      : {};
  const ids = expandedIdentifiers(record);
  const page =
    pub.page && typeof pub.page === "object" && !Array.isArray(pub.page)
      ? (text((pub.page as Record<string, unknown>).content) ??
        ([
          text((pub.page as Record<string, unknown>).page_begin),
          text((pub.page as Record<string, unknown>).page_end),
        ]
          .filter(Boolean)
          .join("-") ||
          null))
      : text(pub.page);
  const language = records(
    full.languages &&
      typeof full.languages === "object" &&
      !Array.isArray(full.languages)
      ? (full.languages as Record<string, unknown>).language
      : [],
  ).find((item) => text(item.type)?.toLowerCase() === "primary")?.content;
  const publisher =
    records(
      summary.publishers &&
        typeof summary.publishers === "object" &&
        !Array.isArray(summary.publishers)
        ? (summary.publishers as Record<string, unknown>).publisher
        : [],
    ).flatMap((item) => {
      const names =
        item.names &&
        typeof item.names === "object" &&
        !Array.isArray(item.names)
          ? (item.names as Record<string, unknown>)
          : {};
      return records(names.name)
        .map((name) => text(name.display_name))
        .filter((value): value is string => value !== null);
    })[0] ?? null;
  return {
    UID: uid,
    title: itemTitle?.content,
    identifiers: Object.fromEntries(
      ids.map((item) => [item.namespace, item.value]),
    ),
    source: {
      sourceTitle: titles.find(
        (item) => text(item.type)?.toLowerCase() === "source",
      )?.content,
      publishYear: pub.pubyear,
      volume: pub.vol,
      issue: pub.issue,
      page,
      pages: page,
      publicationDate: pub.sortdate ?? pub.coverdate ?? pub.early_access_date,
    },
    names: {
      authors: expandedAuthors(summary),
    },
    types: Array.isArray(
      (summary.doctypes as Record<string, unknown> | undefined)?.doctype,
    )
      ? (
          (summary.doctypes as Record<string, unknown>).doctype as unknown[]
        ).flatMap((item) => (text(item) ? [text(item)!] : []))
      : [],
    fullrecord_metadata: full,
    abstract: expandedAbstract(full),
    language,
    publisher,
    keywords: Array.isArray(
      (full.keywords as Record<string, unknown> | undefined)?.keyword,
    )
      ? (
          (full.keywords as Record<string, unknown>).keyword as unknown[]
        ).flatMap((item) => (text(item) ? [text(item)!] : []))
      : [],
    referenceCount:
      full.refs && typeof full.refs === "object" && !Array.isArray(full.refs)
        ? (full.refs as Record<string, unknown>).count
        : null,
    dynamic_data: dynamic,
  };
}

export class WebOfScienceRestAdapter
  implements TopicSearchPort, MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name = "web-of-science" as const;
  private readonly base: URL;
  private readonly size: number;
  private readonly requestHeaders: Readonly<Record<string, string>>;
  private readonly database: string;
  private readonly product: "starter" | "expanded";
  private readonly edition: string | null;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: WebOfScienceAdapterOptions) {
    this.product = options.product ?? "starter";
    this.base = origin(
      options.origin,
      this.product === "expanded"
        ? "https://wos-api.clarivate.com/api/wos"
        : "https://api.clarivate.com/apis/wos-starter/v2",
      "Web of Science",
    );
    this.size = pageSize(options.pageSize, 50, 50, "Web of Science");
    this.requestHeaders = headers(options.apiKey, "x-apikey");
    this.database = text(options.database) ?? "WOS";
    this.edition = text(options.edition);
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session("topic", query.query, null);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const uid = key.record_id?.startsWith("WOS:") ? key.record_id : null;
    const doiValue = key.identifiers.find(
      (item) => item.namespace === "doi",
    )?.value;
    const pmid = key.identifiers.find(
      (item) => item.namespace === "pmid",
    )?.value;
    if (!uid && !doiValue && !pmid)
      throw new TypeError("Web of Science lookup key is empty");
    return this.session(
      "lookup",
      uid ?? (doiValue ? `DO:${doiValue}` : `PMID:${pmid}`),
      key,
    );
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (this.product !== "expanded")
      throw new Error(
        "Web of Science Starter reference capability is unavailable",
      );
    if (!query.keys.length)
      throw new TypeError("Web of Science reference key is empty");
    const tasks = query.keys.flatMap((key) => {
      const uid = key.record_id?.startsWith("WOS:") ? key.record_id : null;
      if (!uid) return [];
      return query.direction === "references"
        ? [{ kind: "references" as const, uid, key }]
        : query.direction === "cited-by"
          ? [{ kind: "citing" as const, uid, key }]
          : [
              { kind: "references" as const, uid, key },
              { kind: "citing" as const, uid, key },
            ];
    });
    if (!tasks.length)
      throw new TypeError("Web of Science reference key requires WOS UID");
    let taskIndex = 0;
    let firstRecord = 1;
    let items: readonly Record<string, unknown>[] = [];
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
        while (taskIndex < tasks.length) {
          const task = tasks[taskIndex]!;
          const url = new URL(
            task.kind === "references" ? "/references" : "/citing",
            this.base,
          );
          url.searchParams.set("databaseId", this.database);
          url.searchParams.set("uniqueId", task.uid);
          url.searchParams.set("count", String(this.size));
          url.searchParams.set("firstRecord", String(firstRecord));
          if (task.kind === "citing") url.searchParams.set("optionView", "FR");
          const result = await requestWithHeaders(
            this.options.transport,
            url.toString(),
            this.requestHeaders,
          );
          const pageResult =
            task.kind === "references"
              ? expandedReferencePage(result)
              : expandedPage(result);
          if (!pageResult.items.length) {
            if (firstRecord <= pageResult.total)
              throw new Error(
                "Web of Science Expanded reference page is empty",
              );
            taskIndex += 1;
            firstRecord = 1;
            continue;
          }
          items = pageResult.items.map((item) => ({
            ...item,
            __wos_relation_kind: task.kind,
            __wos_anchor: task.key,
          }));
          index = 0;
          firstRecord += pageResult.items.length;
          exhausted = firstRecord > pageResult.total;
          if (exhausted) {
            taskIndex += 1;
            firstRecord = 1;
          }
          const raw_item = items[index++]!;
          return {
            raw_item,
            source_exhausted_after:
              exhausted && index === items.length && taskIndex >= tasks.length,
          };
        }
        return null;
      },
      convert_raw_item: async (
        raw_item,
      ): Promise<import("./ports.js").NeutralMetadataItem> => {
        const record = object(
          raw_item,
          "Web of Science Expanded reference record is invalid",
        );
        const relationKind = text(record.__wos_relation_kind);
        const anchor = record.__wos_anchor as ProviderLiteratureKey | undefined;
        delete record.__wos_relation_kind;
        delete record.__wos_anchor;
        if (!relationKind || !anchor || !anchor.record_id)
          throw new Error(
            "Web of Science Expanded reference context is invalid",
          );
        const target =
          relationKind === "references"
            ? expandedReferenceTarget(record)
            : expandedKey(record);
        if (
          !target ||
          (target.record_id === anchor.record_id &&
            target.identifiers.length === anchor.identifiers.length)
        )
          return { observations: [], relations: [] };
        const baseObservation = await observation("web-of-science", {
          sourceRecordId:
            target.record_id ?? target.identifiers[0]?.value ?? "relation",
          identifiers: target.identifiers,
          raw: record,
          observationId: await this.observationId(),
          provenanceId: await this.provenanceId(),
          observedAt: this.clock(),
          parameters: {
            product: this.product,
            database: this.database,
            relation: relationKind,
          },
        });
        return {
          observations: [],
          relations: [
            {
              observation_id: await this.observationId(),
              provenance: baseObservation.provenance,
              citing: relationKind === "references" ? anchor : target,
              cited: relationKind === "references" ? target : anchor,
            },
          ],
        };
      },
    };
  }
  private session(
    kind: "topic" | "lookup",
    value: string,
    expected: ProviderLiteratureKey | null,
  ): RawItemSession {
    let pageNumber = 1;
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
        const expanded = this.product === "expanded";
        const url = new URL(
          expanded
            ? kind === "lookup" && value.startsWith("WOS:")
              ? "/id"
              : "/"
            : kind === "lookup" && value.startsWith("WOS:")
              ? `/documents/${encodeURIComponent(value)}`
              : "/documents",
          this.base,
        );
        if (expanded) {
          url.searchParams.set("databaseId", this.database);
          url.searchParams.set("count", String(this.size));
          url.searchParams.set("firstRecord", String(pageNumber));
          url.searchParams.set("optionView", "FR");
          if (kind === "lookup" && value.startsWith("WOS:"))
            url.searchParams.set("uniqueId", value);
          else
            url.searchParams.set(
              "usrQuery",
              kind === "topic"
                ? `TS=("${value.replace(/[\\"]+/gu, "\\$&")}")`
                : `${value.split(":", 1)[0]}=("${value.slice(value.indexOf(":") + 1).replace(/[\\"]+/gu, "\\$&")}")`,
            );
        } else if (kind === "lookup" && !value.startsWith("WOS:")) {
          url.searchParams.set("q", value);
          url.searchParams.set("page", "1");
          url.searchParams.set("limit", "1");
        } else if (kind === "topic") {
          url.searchParams.set("q", value);
          url.searchParams.set("database", this.database);
          url.searchParams.set("page", String(pageNumber));
          url.searchParams.set("limit", String(this.size));
        }
        const result = await requestWithHeaders(
          this.options.transport,
          url.toString(),
          this.requestHeaders,
        );
        const pageResult = expanded
          ? (() => {
              const parsed = expandedPage(result);
              return {
                items: parsed.items.map((item) => ({
                  ...expandedRecord(item),
                  __raw: item,
                })),
                total: parsed.total,
                page: pageNumber,
                limit: this.size,
              };
            })()
          : starterPage(result);
        if (fetched && pageResult.page !== pageNumber)
          throw new Error("Web of Science pagination made no progress");
        fetched = true;
        items = pageResult.items;
        index = 0;
        pageNumber += 1;
        exhausted =
          kind === "lookup" ||
          pageResult.items.length === 0 ||
          pageResult.page * pageResult.limit >= pageResult.total;
        if (!items.length) return null;
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) => {
        const record = object(raw_item, "Web of Science record is invalid");
        const source = text(record.uid ?? record.UID);
        if (!source)
          throw new Error("Web of Science record identity is missing");
        const identifiers =
          this.product === "expanded"
            ? expandedIdentifiers(record)
            : starterIdentifiers(record);
        if (
          expected &&
          expected.identifiers.length &&
          !identifiers.some((item) =>
            expected.identifiers.some(
              (candidate) =>
                candidate.namespace === item.namespace &&
                candidate.value === item.value,
            ),
          )
        )
          throw new Error("Web of Science lookup identity mismatch");
        const sourceInfo =
          record.source &&
          typeof record.source === "object" &&
          !Array.isArray(record.source)
            ? (record.source as Record<string, unknown>)
            : {};
        const citation = records(record.citations).find(
          (item) => text(item.db)?.toLowerCase() === "wos",
        );
        const keywords =
          record.keywords &&
          typeof record.keywords === "object" &&
          !Array.isArray(record.keywords)
            ? (record.keywords as Record<string, unknown>).authorKeywords
            : [];
        const links =
          record.links &&
          typeof record.links === "object" &&
          !Array.isArray(record.links)
            ? [
                safeUrl((record.links as Record<string, unknown>).record),
              ].flatMap((url) =>
                url
                  ? [
                      {
                        url,
                        kind: "landing-page" as const,
                        media_type: null,
                        asset_role: null,
                        version_role: "published" as const,
                      },
                    ]
                  : [],
              )
            : [];
        return {
          observations: [
            await observation("web-of-science", {
              sourceRecordId: source,
              identifiers,
              title: record.title,
              abstract:
                this.product === "expanded" ? record.abstract : undefined,
              authors:
                record.names &&
                typeof record.names === "object" &&
                !Array.isArray(record.names)
                  ? (record.names as Record<string, unknown>).authors
                  : [],
              publicationDate:
                this.product === "expanded"
                  ? sourceInfo.publicationDate
                  : undefined,
              publicationYear: sourceInfo.publishYear,
              venue: sourceInfo.sourceTitle,
              volume: sourceInfo.volume,
              issue: sourceInfo.issue,
              pages:
                sourceInfo.pages &&
                typeof sourceInfo.pages === "object" &&
                !Array.isArray(sourceInfo.pages)
                  ? ((sourceInfo.pages as Record<string, unknown>).range ??
                    (sourceInfo.pages as Record<string, unknown>).content)
                  : (sourceInfo.pages ??
                    sourceInfo.page ??
                    sourceInfo.articleNumber),
              documentType:
                this.product === "expanded"
                  ? Array.isArray(record.types) &&
                    typeof record.types[0] === "string"
                    ? record.types[0]
                    : null
                  : text(records(record.types)[0]),
              language:
                this.product === "expanded" ? text(record.language) : undefined,
              publisher:
                this.product === "expanded"
                  ? text(record.publisher)
                  : undefined,
              keywords:
                this.product === "expanded" ? record.keywords : keywords,
              referenceCount:
                this.product === "expanded" ? record.referenceCount : undefined,
              citedByCount:
                this.product === "expanded"
                  ? expandedCitedByCount(record, this.database, this.edition)
                  : citation?.count,
              assetHints: links,
              raw:
                this.product === "expanded" && record.__raw !== undefined
                  ? record.__raw
                  : record,
              observationId: await this.observationId(),
              provenanceId: await this.provenanceId(),
              observedAt: this.clock(),
              parameters: {
                database: this.database,
                product: this.product,
                ...(this.edition ? { edition: this.edition } : {}),
              },
            }),
          ],
          relations: [],
        };
      },
    };
  }
}

export class WebOfScienceStarterRestAdapter extends WebOfScienceRestAdapter {
  constructor(options: WebOfScienceAdapterOptions) {
    super({ ...options, product: "starter" });
  }
}
export class WebOfScienceExpandedRestAdapter extends WebOfScienceRestAdapter {
  constructor(options: WebOfScienceAdapterOptions) {
    super({ ...options, product: "expanded" });
  }
}
