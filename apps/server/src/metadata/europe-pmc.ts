import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseMetadataObservation,
  sha256,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import type { MetadataTransport } from "./providers.js";
import type {
  MetadataLookupPort,
  ProviderRelationObservation,
  ReferenceQueryContext,
  ReferenceQueryPort,
  RawItemSession,
  TopicSearchPort,
  TopicSearchQuery,
} from "./ports.js";

export interface EuropePmcAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}
type RelationEnvelope = {
  readonly item: Record<string, unknown>;
  readonly task: {
    readonly key: ProviderLiteratureKey;
    readonly source: string;
    readonly id: string;
    readonly kind: "references" | "citations";
  };
};

function keysOverlap(
  left: ProviderLiteratureKey,
  right: ProviderLiteratureKey,
): boolean {
  if (
    left.record_id &&
    right.record_id &&
    left.record_id.toUpperCase() === right.record_id.toUpperCase()
  )
    return true;
  return left.identifiers.some((identifier) =>
    right.identifiers.some(
      (candidate) =>
        candidate.namespace === identifier.namespace &&
        candidate.value.toLowerCase() === identifier.value.toLowerCase(),
    ),
  );
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function publicUrl(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) =>
        /(?:token|key|secret|sig|auth|password|cookie)/iu.test(key),
      )
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
function list(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    );
  return value && typeof value === "object" && !Array.isArray(value)
    ? [value as Record<string, unknown>]
    : [];
}
function id(
  value: unknown,
  namespace: string,
): { readonly namespace: string; readonly value: string } | null {
  const normalized = stringValue(value);
  if (!normalized) return null;
  return {
    namespace,
    value:
      namespace === "doi"
        ? normalized.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
        : normalized,
  };
}
function relationKey(
  record: Record<string, unknown>,
): ProviderLiteratureKey | null {
  const source = stringValue(record.source);
  const recordId = stringValue(record.id);
  const identifiers = [
    id(record.pmid, "pmid"),
    id(record.pmcid, "pmcid"),
    id(record.doi, "doi"),
  ].filter(
    (item): item is { namespace: string; value: string } => item !== null,
  );
  if (source || recordId) {
    const normalizedSource = source?.toUpperCase();
    if (
      !normalizedSource ||
      !recordId ||
      !/^[A-Z][A-Z0-9_-]*$/u.test(normalizedSource)
    )
      throw new Error("Europe PMC relation record id is invalid");
    return {
      record_id: `${normalizedSource}:${recordId}`,
      identifiers,
    };
  }
  return identifiers.length ? { record_id: null, identifiers } : null;
}
function inlinePublicationYear(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 9999
  )
    return value;
  const normalized = stringValue(value);
  if (normalized && /^[0-9]{4}$/u.test(normalized)) {
    const year = Number(normalized);
    if (year >= 1 && year <= 9999) return year;
  }
  throw new Error("Europe PMC relation publication year is invalid");
}
function relationObservation(
  record: Record<string, unknown>,
  options: {
    readonly observationId: string;
    readonly provenance: MetadataObservation["provenance"];
    readonly identifiers: ProviderLiteratureKey["identifiers"];
    readonly referenceText?: string;
  },
): MetadataObservation {
  return parseMetadataObservation({
    observation_id: options.observationId,
    provenance: options.provenance,
    metadata: {
      title:
        options.referenceText === undefined ? stringValue(record.title) : null,
      authors: [],
      abstract: null,
      publication_date: null,
      publication_year:
        options.referenceText === undefined
          ? inlinePublicationYear(record.pubYear)
          : null,
      document_type: null,
      language: null,
      venue:
        options.referenceText === undefined
          ? stringValue(record.journalAbbreviation)
          : null,
      publisher: null,
      volume:
        options.referenceText === undefined ? stringValue(record.volume) : null,
      issue:
        options.referenceText === undefined ? stringValue(record.issue) : null,
      pages:
        options.referenceText === undefined
          ? stringValue(record.pageInfo)
          : null,
      identifiers: options.identifiers,
      keywords: [],
    },
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts:
      options.referenceText === undefined ? [] : [options.referenceText],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
function parsePage(value: unknown): {
  readonly items: readonly Record<string, unknown>[];
  readonly next: string | null;
} {
  const root = object(value, "Europe PMC response is invalid");
  const resultList = object(
    root.resultList,
    "Europe PMC result list is invalid",
  );
  const result = list(resultList.result);
  const next = root.nextCursorMark;
  if (next !== undefined && next !== null && typeof next !== "string")
    throw new Error("Europe PMC cursor is invalid");
  return {
    items: result,
    next: next === null || next === undefined ? null : next,
  };
}
function parseRelationPage(
  root: Record<string, unknown>,
  kind: "references" | "citations",
  expectedOffset: number,
  maximumItems: number,
): {
  readonly items: readonly Record<string, unknown>[];
  readonly total: number;
} {
  if (!Number.isSafeInteger(root.hitCount) || (root.hitCount as number) < 0)
    throw new Error("Europe PMC relation hit count is invalid");
  const container = object(
    root[kind === "references" ? "referenceList" : "citationList"],
    "Europe PMC relation list is invalid",
  );
  const value = container[kind === "references" ? "reference" : "citation"];
  if (!Array.isArray(value))
    throw new Error("Europe PMC relation items are invalid");
  if (
    value.length > maximumItems ||
    value.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  )
    throw new Error("Europe PMC relation page is invalid");
  const request = object(
    root.request,
    "Europe PMC relation request is invalid",
  );
  if (
    request.offSet !== null &&
    request.offSet !== undefined &&
    (!Number.isSafeInteger(request.offSet) || request.offSet !== expectedOffset)
  )
    throw new Error("Europe PMC relation offset changed");
  return {
    items: value as readonly Record<string, unknown>[],
    total: root.hitCount as number,
  };
}
function normalizePageSize(value: number | undefined): number {
  const size = value ?? 100;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000)
    throw new TypeError("Europe PMC page size is invalid");
  return size;
}

function observationFromRecord(
  record: Record<string, unknown>,
  options: {
    readonly observationId: string;
    readonly provenanceId: string;
    readonly observedAt: string;
    readonly inputSha256: string;
    readonly parametersSha256: string;
  },
): MetadataObservation {
  const sourceRecordId = stringValue(record.id);
  if (!sourceRecordId) throw new Error("Europe PMC record has no id");
  const identifiers = [
    id(record.doi, "doi"),
    id(record.pmid, "pmid"),
    id(record.pmcid, "pmcid"),
  ].filter(
    (item): item is { namespace: string; value: string } => item !== null,
  );
  if (!identifiers.length)
    identifiers.push({ namespace: "europe-pmc", value: sourceRecordId });
  const authorList =
    record.authorList &&
    typeof record.authorList === "object" &&
    !Array.isArray(record.authorList)
      ? (record.authorList as Record<string, unknown>)
      : {};
  const authors = list(authorList.author).flatMap((item) => {
    const display =
      stringValue(item.fullName) ??
      [stringValue(item.firstName), stringValue(item.lastName)]
        .filter(Boolean)
        .join(" ");
    return display
      ? [
          {
            kind: "person" as const,
            display_name: display,
            given_name: stringValue(item.firstName),
            family_name: stringValue(item.lastName),
            orcid:
              stringValue(item.orcid)?.replace(
                /^https?:\/\/orcid\.org\//iu,
                "",
              ) ?? null,
            affiliations: [],
          },
        ]
      : [];
  });
  const fullTextList =
    record.fullTextUrlList &&
    typeof record.fullTextUrlList === "object" &&
    !Array.isArray(record.fullTextUrlList)
      ? (record.fullTextUrlList as Record<string, unknown>)
      : {};
  const hints = list(fullTextList.fullTextUrl).flatMap((item) => {
    const url = publicUrl(item.documentStyle === "pdf" ? item.url : null);
    return url
      ? [
          {
            url,
            kind: "direct-file" as const,
            media_type: "application/pdf",
            asset_role: "primary-pdf" as const,
            version_role: "published" as const,
            access_status: "open",
            license: null,
          },
        ]
      : [];
  });
  const yearValue = Number.parseInt(stringValue(record.pubYear) ?? "", 10);
  const keywordList =
    record.keywordList &&
    typeof record.keywordList === "object" &&
    !Array.isArray(record.keywordList)
      ? (record.keywordList as Record<string, unknown>)
      : {};
  const keywords = (
    Array.isArray(keywordList.keyword)
      ? keywordList.keyword
      : typeof keywordList.keyword === "string"
        ? [keywordList.keyword]
        : []
  ).flatMap((item) => {
    const value = stringValue(
      typeof item === "string" ? item : (item as Record<string, unknown>).value,
    );
    return value ? [value] : [];
  });
  return parseMetadataObservation({
    observation_id: options.observationId,
    provenance: {
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "europe-pmc",
      source_record_id: sourceRecordId,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: options.parametersSha256,
    },
    metadata: {
      title: stringValue(record.title),
      authors,
      abstract: stringValue(record.abstractText),
      publication_date: stringValue(record.firstPublicationDate),
      publication_year:
        Number.isSafeInteger(yearValue) && yearValue > 0 ? yearValue : null,
      document_type: stringValue(record.pubType),
      language: stringValue(record.language),
      venue: stringValue(record.journalTitle),
      publisher: null,
      volume: stringValue(record.journalVolume),
      issue: stringValue(record.issue),
      pages: stringValue(record.pageInfo),
      identifiers,
      keywords,
    },
    version_role: "published",
    version_links: [],
    declared_keywords: keywords,
    reference_texts: [],
    reference_count: null,
    cited_by_count:
      typeof record.citedByCount === "number" &&
      Number.isSafeInteger(record.citedByCount)
        ? record.citedByCount
        : null,
    asset_hints: hints,
  });
}

export class EuropePmcRestAdapter
  implements TopicSearchPort, MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name = "europe-pmc" as const;
  private readonly origin: URL;
  private readonly size: number;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: EuropePmcAdapterOptions) {
    this.origin = new URL(
      options.origin ?? "https://www.ebi.ac.uk/europepmc/webservices/rest",
    );
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("Europe PMC origin must be HTTPS");
    this.size = normalizePageSize(options.pageSize);
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session(query.query, {
      year_from: query.year_from,
      year_to: query.year_to,
    });
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const value =
      key.record_id ??
      key.identifiers.find((item) =>
        ["pmid", "pmcid", "doi"].includes(item.namespace),
      )?.value;
    if (!value) throw new TypeError("Europe PMC lookup key is empty");
    return this.session(`EXT_ID:${value}`, {});
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (!query.keys.length)
      throw new TypeError("Europe PMC reference key is empty");
    const tasks = query.keys.flatMap((key) => {
      const value =
        key.record_id ??
        key.identifiers.find((item) =>
          ["pmid", "pmcid"].includes(item.namespace),
        )?.value;
      if (!value) return [];
      const [source, id] = value.includes(":")
        ? value.split(":", 2)
        : ["MED", value];
      const kinds: readonly ("references" | "citations")[] =
        query.direction === "references"
          ? ["references"]
          : query.direction === "cited-by"
            ? ["citations"]
            : ["references", "citations"];
      const current = {
        record_id: `${source!.toUpperCase()}:${id!}`,
        identifiers: key.identifiers,
      };
      return kinds.map((kind) => ({
        key: current,
        source: source!.toUpperCase(),
        id: id!,
        kind,
      }));
    });
    if (tasks.length === 0)
      throw new TypeError("Europe PMC reference query requires PMID or PMCID");
    let taskIndex = 0;
    let offset = 0;
    let items: readonly RelationEnvelope[] = [];
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
            `${this.origin.toString().replace(/\/$/u, "")}/${encodeURIComponent(task.source)}/${encodeURIComponent(task.id)}/${task.kind}`,
          );
          url.searchParams.set("format", "json");
          url.searchParams.set("pageSize", String(this.size));
          url.searchParams.set(
            "page",
            String(Math.floor(offset / this.size) + 1),
          );
          const root = object(
            await this.options.transport.request(url.toString()),
            "Europe PMC reference response is invalid",
          );
          const page = parseRelationPage(root, task.kind, offset, this.size);
          const values = page.items;
          if (!values.length) {
            if (offset < page.total)
              throw new Error(
                "Europe PMC empty relation page did not reach the total",
              );
            taskIndex += 1;
            offset = 0;
            continue;
          }
          items = values.map((item) => ({ item, task }));
          index = 0;
          const consumed = offset + values.length;
          if (consumed >= page.total) {
            taskIndex += 1;
            offset = 0;
            exhausted = taskIndex >= tasks.length;
          } else offset += this.size;
          return {
            raw_item: items[index++]!,
            source_exhausted_after: exhausted && index === items.length,
          };
        }
        return null;
      },
      convert_raw_item: async (raw_item) => {
        if (
          !raw_item ||
          typeof raw_item !== "object" ||
          Array.isArray(raw_item)
        )
          throw new Error("Europe PMC relation item is invalid");
        const envelope = raw_item as RelationEnvelope;
        const task = envelope.task;
        const item = object(
          envelope.item,
          "Europe PMC relation item is invalid",
        );
        const anchor = task.key;
        const observedAt = this.clock();
        const inputSha256 = (await sha256(
          canonicalJsonBytes(raw_item),
        )) as MetadataObservation["provenance"]["input_sha256"];
        const currentProvenance = {
          provenance_id:
            (await this.provenanceId()) as MetadataObservation["provenance"]["provenance_id"],
          source_kind: "metadata-provider" as const,
          source_name: "europe-pmc",
          source_record_id: anchor.record_id,
          observed_at: observedAt,
          input_sha256: inputSha256,
          parameters_sha256: null,
        };
        const observations: MetadataObservation[] = [];
        const rawText =
          task.kind === "references"
            ? stringValue(item.unstructuredInformation)
            : null;
        if (rawText)
          observations.push(
            relationObservation(item, {
              observationId: await this.observationId(),
              provenance: currentProvenance,
              identifiers: anchor.identifiers,
              referenceText: rawText,
            }),
          );

        const target = relationKey(item);
        if (!target) return { observations, relations: [] };
        const relatedProvenance = target.record_id
          ? {
              ...currentProvenance,
              provenance_id:
                (await this.provenanceId()) as MetadataObservation["provenance"]["provenance_id"],
              source_record_id: target.record_id,
            }
          : currentProvenance;
        observations.push(
          relationObservation(item, {
            observationId: await this.observationId(),
            provenance: relatedProvenance,
            identifiers: target.identifiers,
          }),
        );
        const outgoing = task.kind === "references";
        const relation: ProviderRelationObservation = {
          observation_id: await this.observationId(),
          provenance: currentProvenance,
          citing: outgoing ? anchor : target,
          cited: outgoing ? target : anchor,
        };
        return {
          observations,
          relations: keysOverlap(relation.citing, relation.cited)
            ? []
            : [relation],
        };
      },
    };
  }
  private session(
    query: string,
    extra: Readonly<Record<string, number | null>>,
  ): RawItemSession {
    let cursor: string | null = "*";
    let items: readonly Record<string, unknown>[] = [];
    let index = 0;
    let exhausted = false;
    let fetched = false;
    const parametersHash = sha256(canonicalJsonBytes({ query, ...extra }));
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
        const url = new URL(
          `${this.origin.toString().replace(/\/$/u, "")}/search`,
        );
        url.searchParams.set("query", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("pageSize", String(this.size));
        if (cursor !== null) url.searchParams.set("cursorMark", cursor);
        for (const [key, value] of Object.entries(extra))
          if (value !== null) url.searchParams.set(key, String(value));
        const page = parsePage(
          await this.options.transport.request(url.toString()),
        );
        if (!page.items.length) {
          exhausted = true;
          return null;
        }
        if (fetched && page.next === cursor)
          throw new Error("Europe PMC pagination made no progress");
        fetched = true;
        items = page.items;
        index = 0;
        cursor = page.next;
        exhausted = cursor === null;
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) => ({
        observations: [
          observationFromRecord(raw_item as Record<string, unknown>, {
            observationId: await this.observationId(),
            provenanceId: await this.provenanceId(),
            observedAt: this.clock(),
            inputSha256: await sha256(canonicalJsonBytes(raw_item)),
            parametersSha256: await parametersHash,
          }),
        ],
        relations: [],
      }),
    };
  }
}
