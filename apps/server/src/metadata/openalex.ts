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

export interface OpenAlexAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}
const object = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const list = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];
const safeUrl = (value: unknown): string | null => {
  const candidate = text(value);
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
};
function page(
  value: unknown,
  lookup: boolean,
): {
  readonly items: readonly Record<string, unknown>[];
  readonly next: string | null;
} {
  const root = object(value, "OpenAlex response is invalid");
  if (lookup) return { items: root.id ? [root] : [], next: null };
  if (!Array.isArray(root.results))
    throw new Error("OpenAlex results are invalid");
  const meta = object(root.meta, "OpenAlex page metadata is invalid");
  if (
    meta.next_cursor !== null &&
    meta.next_cursor !== undefined &&
    text(meta.next_cursor) === null
  )
    throw new Error("OpenAlex next cursor is invalid");
  const nextCursor = text(meta.next_cursor);
  const next = nextCursor ? `cursor:${nextCursor}` : null;
  if (
    root.results.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  )
    throw new Error("OpenAlex result item is invalid");
  return {
    items: root.results as readonly Record<string, unknown>[],
    next,
  };
}
function observation(
  record: Record<string, unknown>,
  options: {
    readonly observationId: string;
    readonly provenanceId: string;
    readonly observedAt: string;
    readonly inputSha256: string;
    readonly parametersSha256: string;
  },
): MetadataObservation {
  const sourceRecordId = text(record.id);
  if (!sourceRecordId) throw new Error("OpenAlex record has no id");
  const doi =
    text(record.doi)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "") ?? null;
  const primary =
    record.primary_location &&
    typeof record.primary_location === "object" &&
    !Array.isArray(record.primary_location)
      ? (record.primary_location as Record<string, unknown>)
      : {};
  const source =
    primary.source &&
    typeof primary.source === "object" &&
    !Array.isArray(primary.source)
      ? (primary.source as Record<string, unknown>)
      : {};
  const biblio =
    record.biblio &&
    typeof record.biblio === "object" &&
    !Array.isArray(record.biblio)
      ? (record.biblio as Record<string, unknown>)
      : {};
  const authors = list(record.authorships).flatMap((item) => {
    const person =
      item.author &&
      typeof item.author === "object" &&
      !Array.isArray(item.author)
        ? (item.author as Record<string, unknown>)
        : {};
    const display = text(person.display_name);
    return display
      ? [
          {
            kind: "person" as const,
            display_name: display,
            given_name: null,
            family_name: display.split(/\s+/u).at(-1) ?? display,
            orcid:
              text(person.orcid)?.replace(/^https?:\/\/orcid\.org\//iu, "") ??
              null,
            affiliations: [],
          },
        ]
      : [];
  });
  const keywords = list(record.concepts).flatMap((item) => {
    const value = text(item.display_name);
    return value ? [value] : [];
  });
  const oa =
    record.open_access &&
    typeof record.open_access === "object" &&
    !Array.isArray(record.open_access)
      ? (record.open_access as Record<string, unknown>)
      : {};
  const bestLocation =
    record.best_oa_location &&
    typeof record.best_oa_location === "object" &&
    !Array.isArray(record.best_oa_location)
      ? (record.best_oa_location as Record<string, unknown>)
      : {};
  const location = bestLocation.pdf_url ?? oa.oa_url;
  const pdf = safeUrl(location);
  const yearValue =
    typeof record.publication_year === "number"
      ? record.publication_year
      : Number.parseInt(text(record.publication_year) ?? "", 10);
  return parseMetadataObservation({
    observation_id: options.observationId,
    provenance: {
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "openalex",
      source_record_id: sourceRecordId,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: options.parametersSha256,
    },
    metadata: {
      title: text(record.title),
      authors,
      abstract: null,
      publication_date: text(record.publication_date),
      publication_year:
        Number.isSafeInteger(yearValue) && yearValue > 0 ? yearValue : null,
      document_type: text(record.type),
      language: text(record.language),
      venue: text(source.display_name),
      publisher: null,
      volume: text(biblio.volume),
      issue: text(biblio.issue),
      pages:
        [text(biblio.first_page), text(biblio.last_page)]
          .filter(Boolean)
          .join("-") || null,
      identifiers: doi
        ? [{ namespace: "doi", value: doi }]
        : [{ namespace: "openalex", value: sourceRecordId }],
      keywords,
    },
    version_role: "published",
    version_links: [],
    declared_keywords: keywords,
    reference_texts: [],
    reference_count: Array.isArray(record.referenced_works)
      ? record.referenced_works.length
      : null,
    cited_by_count:
      typeof record.cited_by_count === "number" &&
      Number.isSafeInteger(record.cited_by_count)
        ? record.cited_by_count
        : null,
    asset_hints: pdf
      ? [
          {
            url: pdf,
            kind: "direct-file",
            media_type: "application/pdf",
            asset_role: "primary-pdf",
            version_role: "published",
            access_status: "open",
            license: null,
          },
        ]
      : [],
  });
}
function size(value: number | undefined): number {
  const result = value ?? 100;
  if (!Number.isSafeInteger(result) || result < 1 || result > 200)
    throw new TypeError("OpenAlex page size is invalid");
  return result;
}

function workKey(record: Record<string, unknown>): {
  readonly record_id: string | null;
  readonly identifiers: readonly { namespace: string; value: string }[];
} {
  const recordId = text(record.id);
  const doi = text(record.doi)?.replace(
    /^https?:\/\/(?:dx\.)?doi\.org\//iu,
    "",
  );
  return {
    record_id: recordId,
    identifiers: doi ? [{ namespace: "doi", value: doi.toLowerCase() }] : [],
  };
}

function openAlexWorkId(key: {
  readonly record_id: string | null;
}): string | null {
  const value = key.record_id?.trim();
  if (!value) return null;
  const match = /(?:^|\/)((?:W|w)[A-Za-z0-9]+)$/u.exec(value);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function referenceKey(value: unknown): {
  readonly record_id: string | null;
  readonly identifiers: readonly { namespace: string; value: string }[];
} | null {
  const raw = text(value);
  if (!raw) return null;
  const id = raw.startsWith("http") ? raw : `https://openalex.org/${raw}`;
  if (!openAlexWorkId({ record_id: id })) return null;
  return { record_id: id, identifiers: [] };
}

function openAlexLookupId(key: ProviderLiteratureKey): string {
  if (key.record_id) {
    const workId = openAlexWorkId(key);
    if (workId) return workId;
    throw new TypeError("OpenAlex record id is invalid");
  }
  for (const namespace of ["doi", "pmid", "pmcid"] as const) {
    const identifier = key.identifiers.find(
      (item) => item.namespace === namespace,
    );
    if (identifier) return `${namespace}:${identifier.value}`;
  }
  throw new TypeError("OpenAlex lookup key is unsupported");
}

function keysOverlap(
  left: ProviderLiteratureKey,
  right: ProviderLiteratureKey,
): boolean {
  const leftWork = openAlexWorkId(left);
  const rightWork = openAlexWorkId(right);
  if (leftWork && rightWork && leftWork === rightWork) return true;
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

type ReferenceTask = {
  readonly kind: "references" | "cited-by";
  readonly anchor: {
    readonly record_id: string | null;
    readonly identifiers: readonly { namespace: string; value: string }[];
  };
  readonly request_id: string;
  readonly work_id: string | null;
};
type RawReference = {
  readonly record: Record<string, unknown>;
  readonly task: ReferenceTask;
};

export class OpenAlexRestAdapter
  implements TopicSearchPort, MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name = "openalex" as const;
  private readonly origin: URL;
  private readonly pageSize: number;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: OpenAlexAdapterOptions) {
    this.origin = new URL(options.origin ?? "https://api.openalex.org");
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("OpenAlex origin must be HTTPS");
    this.pageSize = size(options.pageSize);
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session(false, query.query);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    return this.session(true, openAlexLookupId(key));
  }

  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (!Array.isArray(query.keys) || query.keys.length === 0)
      throw new TypeError("OpenAlex reference key is empty");
    const kinds: readonly ("references" | "cited-by")[] =
      query.direction === "references"
        ? ["references"]
        : query.direction === "cited-by"
          ? ["cited-by"]
          : ["references", "cited-by"];
    const tasks: ReferenceTask[] = [];
    for (const key of query.keys) {
      const requestId = openAlexLookupId(key);
      const workId = openAlexWorkId(key);
      for (const kind of kinds) {
        if (kind === "cited-by" && !workId)
          throw new TypeError(
            "OpenAlex cited-by query requires an OpenAlex work id",
          );
        tasks.push({
          kind,
          anchor: key,
          request_id: requestId,
          work_id: workId,
        });
      }
    }
    let taskIndex = 0;
    let cursor: string | null = null;
    let items: readonly RawReference[] = [];
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
          if (task.kind === "references") {
            const url = new URL(
              `${this.origin.toString().replace(/\/$/u, "")}/works/${encodeURIComponent(task.request_id)}`,
            );
            url.searchParams.set(
              "select",
              "id,doi,title,publication_year,publication_date,type,language,primary_location,biblio,authorships,concepts,referenced_works,referenced_works_count,cited_by_count,best_oa_location",
            );
            const result = await this.options.transport.request(url.toString());
            const root = object(
              result,
              "OpenAlex reference response is invalid",
            );
            items = [{ record: root, task }];
            index = 0;
            taskIndex += 1;
            cursor = null;
            exhausted = taskIndex >= tasks.length;
            const raw_item = items[index++]!;
            return { raw_item, source_exhausted_after: exhausted };
          }
          const url = new URL(
            `${this.origin.toString().replace(/\/$/u, "")}/works`,
          );
          url.searchParams.set("filter", `cites:${task.work_id!}`);
          url.searchParams.set("per_page", String(this.pageSize));
          const requestedCursor = cursor ?? "*";
          url.searchParams.set("cursor", requestedCursor);
          url.searchParams.set(
            "select",
            "id,doi,title,publication_year,publication_date,type,language,primary_location,biblio,authorships,concepts,referenced_works,referenced_works_count,cited_by_count,best_oa_location",
          );
          const result = page(
            await this.options.transport.request(url.toString()),
            false,
          );
          if (result.items.length > this.pageSize)
            throw new Error("OpenAlex cited-by page is too large");
          const returnedCursor = result.next?.startsWith("cursor:")
            ? result.next.slice("cursor:".length)
            : null;
          if (returnedCursor === requestedCursor)
            throw new Error("OpenAlex cited-by pagination made no progress");
          if (!result.items.length) {
            if (returnedCursor)
              throw new Error("OpenAlex empty cited-by page has a cursor");
            taskIndex += 1;
            cursor = null;
            continue;
          }
          items = result.items.map((record) => ({ record, task }));
          index = 0;
          if (returnedCursor) {
            cursor = returnedCursor;
            exhausted = false;
          } else {
            cursor = null;
            taskIndex += 1;
            exhausted = taskIndex >= tasks.length;
          }
          const raw_item = items[index++]!;
          return {
            raw_item,
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
          throw new Error("OpenAlex reference record is invalid");
        const envelope = raw_item as RawReference;
        const record = object(
          envelope.record,
          "OpenAlex reference record is invalid",
        );
        const task = envelope.task;
        const metadata = await observation(record, {
          observationId: await this.observationId(),
          provenanceId: await this.provenanceId(),
          observedAt: this.clock(),
          inputSha256: await sha256(canonicalJsonBytes(record)),
          parametersSha256: await sha256(
            canonicalJsonBytes({ kind: task.kind, work_id: task.work_id }),
          ),
        });
        const current = workKey(record);
        const relationPairs: readonly [typeof current, typeof current][] =
          task.kind === "cited-by"
            ? [[current, task.anchor]]
            : Array.isArray(record.referenced_works)
              ? record.referenced_works
                  .map(referenceKey)
                  .filter(
                    (
                      item,
                    ): item is {
                      readonly record_id: string;
                      readonly identifiers: readonly {
                        namespace: string;
                        value: string;
                      }[];
                    } => item !== null,
                  )
                  .map((target) => [task.anchor, target] as const)
              : [];
        const relations: ProviderRelationObservation[] = relationPairs
          .filter(([citing, cited]) => !keysOverlap(citing, cited))
          .map(([citing, cited]) => ({
            observation_id: randomUUID(),
            provenance: metadata.provenance,
            citing,
            cited,
          }));
        return { observations: [metadata], relations };
      },
    };
  }
  private session(lookup: boolean, value: string): RawItemSession {
    let next: string | null = null;
    let items: readonly Record<string, unknown>[] = [];
    let index = 0;
    let exhausted = false;
    let fetched = false;
    const parametersHash = sha256(canonicalJsonBytes({ lookup, value }));
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
        const url = next?.startsWith("cursor:")
          ? new URL(`${this.origin.toString().replace(/\/$/u, "")}/works`)
          : next
            ? new URL(next)
            : new URL(
                `${this.origin.toString().replace(/\/$/u, "")}${lookup ? `/works/${encodeURIComponent(value)}` : "/works"}`,
              );
        if (!lookup) {
          url.searchParams.set("search", value);
          url.searchParams.set("per_page", String(this.pageSize));
          url.searchParams.set(
            "cursor",
            next?.startsWith("cursor:") ? next.slice("cursor:".length) : "*",
          );
        }
        const result = page(
          await this.options.transport.request(url.toString()),
          lookup,
        );
        if (!lookup && result.items.length > this.pageSize)
          throw new Error("OpenAlex page is too large");
        if (!result.items.length) {
          if (!lookup && result.next)
            throw new Error("OpenAlex empty page has a cursor");
          exhausted = true;
          return null;
        }
        if (fetched && next === result.next)
          throw new Error("OpenAlex pagination made no progress");
        fetched = true;
        items = result.items;
        index = 0;
        next = result.next;
        exhausted = next === null;
        const raw_item = items[index++]!;
        return {
          raw_item,
          source_exhausted_after: exhausted && index === items.length,
        };
      },
      convert_raw_item: async (raw_item) => ({
        observations: [
          observation(raw_item as Record<string, unknown>, {
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
