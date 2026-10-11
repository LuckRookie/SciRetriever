import { parseProviderObservation } from "../shared/metadata-values.js";
import {
  canonicalJsonBytes,
  sha256,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type {
  MetadataLookupPort,
  ProviderRelationObservation,
  RawItemSession,
  ReferenceQueryContext,
  ReferenceQueryPort,
  TopicSearchPort,
  TopicSearchQuery,
} from "../../metadata/ports.js";
import type { MetadataTransport } from "../shared/metadata-transport.js";
import {
  JsonMetadataAdapter,
  type MetadataRecordDecoder,
} from "../shared/metadata-transport.js";
import { services } from "./definition.js";
export interface DataCiteAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function publicUrl(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ![...url.searchParams.keys()].some((key) =>
        /(?:token|key|secret|sig|auth|password|cookie)/iu.test(key),
      )
    )
      return url.toString();
  } catch {
    /* malformed provider links are ignored */
  }
  return null;
}
function doi(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "") ?? null;
}
function keysOverlap(
  left: ProviderLiteratureKey,
  right: ProviderLiteratureKey,
): boolean {
  if (left.record_id && right.record_id && left.record_id === right.record_id)
    return true;
  return left.identifiers.some((identifier) =>
    right.identifiers.some(
      (candidate) =>
        candidate.namespace === identifier.namespace &&
        candidate.value.toLowerCase() === identifier.value.toLowerCase(),
    ),
  );
}
type DataCiteReferenceTask = {
  readonly key: ProviderLiteratureKey;
  readonly value: string;
};
type DataCiteReferenceEnvelope = {
  readonly record: unknown;
  readonly task: DataCiteReferenceTask;
};
function page(
  value: unknown,
  lookup: boolean,
): {
  readonly items: readonly unknown[];
  readonly next: string | null;
} {
  const root = object(value, "DataCite response is invalid");
  const data = root.data;
  if (lookup)
    return {
      items: data === null ? [] : [object(data, "DataCite data is invalid")],
      next: null,
    };
  if (!Array.isArray(data)) throw new Error("DataCite data is invalid");
  const links =
    root.links === undefined || root.links === null
      ? {}
      : object(root.links, "DataCite links are invalid");
  const next = publicUrl(links.next);
  if (links.next !== undefined && links.next !== null && next === null)
    throw new Error("DataCite next link is invalid");
  return {
    items: data,
    next,
  };
}
function pageSize(value: number | undefined): number {
  // A page of 100 full JSON:API records can exceed the request time limit even
  // for a small raw scan. Keep default pages bounded without changing scan limits.
  const size = value ?? 25;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000)
    throw new TypeError("DataCite page size is invalid");
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
  const attributes = object(
    record.attributes,
    "DataCite attributes are invalid",
  );
  const identifier = doi(attributes.doi) ?? doi(record.id);
  if (!sourceRecordId || !identifier)
    throw new Error("DataCite record identity is missing");
  const titles = array(attributes.titles)
    .flatMap((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? [stringValue((item as Record<string, unknown>).title)]
        : [],
    )
    .filter((item): item is string => item !== null);
  const creators = array(attributes.creators).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const creator = item as Record<string, unknown>;
    const display =
      stringValue(creator.name) ??
      [stringValue(creator.givenName), stringValue(creator.familyName)]
        .filter(Boolean)
        .join(" ");
    if (!display) return [];
    return [
      {
        kind:
          creator.nameType === "Organizational"
            ? ("organization" as const)
            : ("person" as const),
        display_name: display,
        given_name: stringValue(creator.givenName),
        family_name: stringValue(creator.familyName),
        orcid:
          array(creator.nameIdentifiers)
            .flatMap((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value))
                return [];
              const item = value as Record<string, unknown>;
              return item.nameIdentifierScheme === "ORCID"
                ? [stringValue(item.nameIdentifier)]
                : [];
            })
            .find((value) => value !== null) ?? null,
        affiliations: [],
      },
    ];
  });
  const containerValue = attributes.container ?? attributes.containerInfo;
  const container =
    containerValue &&
    typeof containerValue === "object" &&
    !Array.isArray(containerValue)
      ? (containerValue as Record<string, unknown>)
      : {};
  const descriptions = array(attributes.descriptions).flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : [],
  );
  const abstract = descriptions.find(
    (item) => item.descriptionType === "Abstract",
  );
  const subjects = array(attributes.subjects)
    .flatMap((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? [stringValue((item as Record<string, unknown>).subject)]
        : [],
    )
    .filter((item): item is string => item !== null);

  const assetUrl = publicUrl(attributes.url);
  return parseProviderObservation({
    observation_id: options.observationId,
    provenance: {
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "datacite",
      source_record_id: sourceRecordId,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: options.parametersSha256,
    },
    metadata: {
      title: titles[0] ?? null,
      authors: creators,
      // Metadata text is a single-line neutral value; retain all words while
      // normalizing the paragraph whitespace permitted by DataCite descriptions.
      abstract: abstract
        ? (stringValue(abstract.description)?.replace(/\s+/gu, " ") ?? null)
        : null,
      publication_date: stringValue(attributes.created),
      publication_year: attributes.publicationYear,
      document_type: stringValue(
        attributes.types &&
          typeof attributes.types === "object" &&
          !Array.isArray(attributes.types)
          ? (attributes.types as Record<string, unknown>).resourceTypeGeneral
          : null,
      ),
      language: stringValue(attributes.language),
      venue: stringValue(container.title),
      publisher: stringValue(attributes.publisher),
      volume: stringValue(container.volume),
      issue: stringValue(container.issue),
      pages:
        [stringValue(container.firstPage), stringValue(container.lastPage)]
          .filter(Boolean)
          .join("-") || null,
      identifiers: [{ namespace: "doi", value: identifier }],
      keywords: subjects,
    },
    version_role: "published",
    version_links: [],
    declared_keywords: subjects,
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: assetUrl
      ? [
          {
            url: assetUrl,
            kind: "landing-page",
            media_type: null,
            asset_role: null,
            version_role: "published",
            access_status: "unknown",
            license: null,
          },
        ]
      : [],
  });
}

export class DataCiteRestAdapter
  implements TopicSearchPort, MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name = "datacite" as const;
  private readonly origin: URL;
  private readonly size: number;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: DataCiteAdapterOptions) {
    this.origin = new URL(options.origin ?? services["datacite-rest"].endpoint);
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("DataCite origin must be HTTPS");
    this.size = pageSize(options.pageSize);
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session(false, query.query, query);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const value =
      key.record_id ??
      key.identifiers.find((item) => item.namespace === "doi")?.value;
    if (!value) throw new TypeError("DataCite lookup key is empty");
    return this.session(true, doi(value) ?? value, null);
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (!query.keys.length)
      throw new TypeError("DataCite reference key is empty");
    const tasks = query.keys.map((key) => {
      const raw =
        key.identifiers.find((item) => item.namespace === "doi")?.value ??
        key.record_id;
      const value = doi(raw);
      if (!value)
        throw new TypeError("DataCite reference query requires a DOI");
      return { key, value };
    });
    return this.session(true, tasks[0]!.value, null, query, tasks);
  }
  private session(
    lookup: boolean,
    value: string,
    query: TopicSearchQuery | null,
    referenceQuery: ReferenceQueryContext | null = null,
    referenceTasks: readonly DataCiteReferenceTask[] = [],
  ): RawItemSession {
    let next: string | null = null;
    let items: readonly unknown[] = [];
    let index = 0;
    let exhausted = false;
    let fetched = false;
    let taskIndex = 0;
    const parametersHash = sha256(
      canonicalJsonBytes({ lookup, value, query, referenceQuery }),
    );
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
        const referenceTask = referenceQuery
          ? referenceTasks[taskIndex]
          : undefined;
        if (referenceQuery && !referenceTask) {
          exhausted = true;
          return null;
        }
        const requestValue = referenceTask?.value ?? value;
        const url =
          next && !referenceQuery
            ? new URL(next)
            : new URL(
                `${this.origin.toString().replace(/\/$/u, "")}${lookup ? `/dois/${encodeURIComponent(requestValue)}` : "/dois"}`,
              );
        if (!lookup) {
          url.searchParams.set("query", value);
          url.searchParams.set("page[size]", String(this.size));
        }
        const result = page(
          await this.options.transport.request(url.toString()),
          lookup,
        );
        if (!result.items.length) {
          if (result.next !== null)
            throw new Error("DataCite empty page has a next link");
          exhausted = true;
          return null;
        }
        if (!referenceQuery && fetched && next === result.next)
          throw new Error("DataCite pagination made no progress");
        fetched = true;
        items = referenceTask
          ? result.items.map(
              (record) =>
                ({
                  record,
                  task: referenceTask,
                }) satisfies DataCiteReferenceEnvelope,
            )
          : result.items;
        index = 0;
        if (referenceTask) {
          taskIndex += 1;
          next = null;
          exhausted = taskIndex >= referenceTasks.length;
        } else {
          next = result.next;
          exhausted = next === null;
        }
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) => {
        const envelope = referenceQuery
          ? (raw_item as DataCiteReferenceEnvelope)
          : null;
        const record = envelope
          ? object(envelope.record, "DataCite reference record is invalid")
          : object(raw_item, "DataCite record is invalid");
        const metadata = await observationFromRecord(record, {
          observationId: await this.observationId(),
          provenanceId: await this.provenanceId(),
          observedAt: this.clock(),
          inputSha256: await sha256(canonicalJsonBytes(record)),
          parametersSha256: await parametersHash,
        });
        if (!referenceQuery) return { observations: [metadata], relations: [] };
        const attributes = object(
          record.attributes,
          "DataCite attributes are invalid",
        );
        const related = array(attributes.relatedIdentifiers);
        const currentDoi = doi(attributes.doi) ?? doi(record.id);
        if (!currentDoi)
          throw new Error("DataCite reference record identity is missing");
        const anchor = {
          record_id: stringValue(record.id),
          identifiers: [{ namespace: "doi", value: currentDoi }],
        };
        const relations: ProviderRelationObservation[] = [];
        for (const item of related) {
          if (!item || typeof item !== "object" || Array.isArray(item))
            continue;
          const relation = item as Record<string, unknown>;
          if (
            stringValue(relation.relatedIdentifierType)?.toLowerCase() !== "doi"
          )
            continue;
          const targetValue = doi(relation.relatedIdentifier);
          if (!targetValue) continue;
          const kind = stringValue(relation.relationType)?.toLowerCase() ?? "";
          const target = {
            record_id: targetValue,
            identifiers: [{ namespace: "doi", value: targetValue }],
          };
          const outgoing = kind === "cites" || kind === "references";
          const incoming = kind === "iscitedby" || kind === "isreferencedby";
          if (!outgoing && !incoming) continue;
          const citing = outgoing ? anchor : target;
          const cited = outgoing ? target : anchor;
          if (
            (referenceQuery.direction === "references" && !outgoing) ||
            (referenceQuery.direction === "cited-by" && outgoing)
          )
            continue;
          if (keysOverlap(citing, cited)) continue;
          relations.push({
            observation_id: randomUUID(),
            provenance: metadata.provenance,
            citing,
            cited,
          });
        }
        return { observations: [metadata], relations };
      },
    };
  }
}

export class DataCiteAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("datacite", t, b, d);
  }
}
