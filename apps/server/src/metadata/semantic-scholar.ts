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

export interface SemanticScholarAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly apiKey?: string | null;
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
function pageItems(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error("Semantic Scholar page data is invalid");
  if (
    value.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  )
    throw new Error("Semantic Scholar page item is invalid");
  return value as readonly Record<string, unknown>[];
}
function nonnegativeInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(message);
  return value as number;
}
function nextOffset(value: unknown, current: number): number | null {
  if (value === null || value === undefined) return null;
  const next = nonnegativeInteger(
    value,
    "Semantic Scholar next offset is invalid",
  );
  if (next <= current)
    throw new Error("Semantic Scholar pagination made no progress");
  return next;
}
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
function size(value: number | undefined): number {
  const result = value ?? 100;
  if (!Number.isSafeInteger(result) || result < 1 || result > 100)
    throw new TypeError("Semantic Scholar page size is invalid");
  return result;
}
function paperKey(record: Record<string, unknown>): ProviderLiteratureKey {
  const recordId = text(record.paperId);
  if (!recordId) throw new Error("Semantic Scholar paper id is missing");
  const external =
    record.externalIds &&
    typeof record.externalIds === "object" &&
    !Array.isArray(record.externalIds)
      ? (record.externalIds as Record<string, unknown>)
      : {};
  const identifiers = (
    [
      ["doi", external.DOI],
      ["arxiv", external.ArXiv],
      ["pmid", external.PubMed],
      ["pmcid", external.PubMedCentral],
    ] as const
  ).flatMap(([namespace, value]) => {
    const normalized = text(value);
    return normalized
      ? [
          {
            namespace,
            value: namespace === "doi" ? normalized.toLowerCase() : normalized,
          },
        ]
      : [];
  });
  return { record_id: recordId, identifiers };
}
function lookupId(key: ProviderLiteratureKey): string {
  if (key.record_id) return key.record_id;
  const prefixes: Readonly<Record<string, string>> = {
    doi: "DOI",
    arxiv: "ARXIV",
    pmid: "PMID",
    pmcid: "PMCID",
  };
  for (const namespace of ["doi", "arxiv", "pmid", "pmcid"] as const) {
    const identifier = key.identifiers.find(
      (item) => item.namespace === namespace,
    );
    if (identifier) return `${prefixes[namespace]}:${identifier.value}`;
  }
  throw new TypeError("Semantic Scholar lookup key is unsupported");
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
type ReferenceEnvelope = {
  readonly edge: Record<string, unknown>;
  readonly task: {
    readonly anchor: ProviderLiteratureKey;
    readonly id: string;
    readonly kind: "references" | "cited-by";
  };
};
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
  const sourceRecordId = text(record.paperId);
  if (!sourceRecordId)
    throw new Error("Semantic Scholar record has no paper ID");
  const external =
    record.externalIds &&
    typeof record.externalIds === "object" &&
    !Array.isArray(record.externalIds)
      ? (record.externalIds as Record<string, unknown>)
      : {};
  const identifiers: { namespace: string; value: string }[] = (
    [
      ["doi", external.DOI],
      ["arxiv", external.ArXiv],
      ["pmid", external.PubMed],
      ["pmcid", external.PubMedCentral],
    ] as const
  ).flatMap(([namespace, value]) => {
    const normalized = text(value);
    return normalized
      ? [
          {
            namespace,
            value: namespace === "doi" ? normalized.toLowerCase() : normalized,
          },
        ]
      : [];
  });
  if (!identifiers.length)
    identifiers.push({ namespace: "semantic-scholar", value: sourceRecordId });
  const authors = list(record.authors).flatMap((item) => {
    const display = text(item.name);
    return display
      ? [
          {
            kind: "person" as const,
            display_name: display,
            given_name: null,
            family_name: display.split(/\s+/u).at(-1) ?? display,
            orcid: null,
            affiliations: [],
          },
        ]
      : [];
  });
  const openPdf =
    record.openAccessPdf &&
    typeof record.openAccessPdf === "object" &&
    !Array.isArray(record.openAccessPdf)
      ? (record.openAccessPdf as Record<string, unknown>).url
      : null;
  const pdf = safeUrl(openPdf);
  const yearValue =
    typeof record.year === "number"
      ? record.year
      : Number.parseInt(text(record.year) ?? "", 10);
  return parseMetadataObservation({
    observation_id: options.observationId,
    provenance: {
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "semantic-scholar",
      source_record_id: sourceRecordId,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: options.parametersSha256,
    },
    metadata: {
      title: text(record.title),
      authors,
      abstract: text(record.abstract),
      publication_date: text(record.publicationDate),
      publication_year:
        Number.isSafeInteger(yearValue) && yearValue > 0 ? yearValue : null,
      document_type: null,
      language: null,
      venue: text(record.venue),
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      identifiers,
      keywords: [],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count:
      typeof record.citationCount === "number" &&
      Number.isSafeInteger(record.citationCount)
        ? record.citationCount
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

export class SemanticScholarRestAdapter
  implements TopicSearchPort, MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name = "semantic-scholar" as const;
  private readonly origin: URL;
  private readonly pageSize: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: SemanticScholarAdapterOptions) {
    this.origin = new URL(
      options.origin ?? "https://api.semanticscholar.org/graph/v1",
    );
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("Semantic Scholar origin must be HTTPS");
    this.pageSize = size(options.pageSize);
    if (
      options.apiKey !== undefined &&
      options.apiKey !== null &&
      (!options.apiKey.trim() || /[\p{Cc}\p{Cf}]/u.test(options.apiKey))
    )
      throw new TypeError("Semantic Scholar API key is invalid");
    this.headers = options.apiKey ? { "x-api-key": options.apiKey } : {};
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    return this.session(false, query.query);
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    return this.session(true, lookupId(key));
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (!query.keys.length)
      throw new TypeError("Semantic Scholar reference key is empty");
    const kinds: readonly ("references" | "cited-by")[] =
      query.direction === "references"
        ? ["references"]
        : query.direction === "cited-by"
          ? ["cited-by"]
          : ["references", "cited-by"];
    const tasks = query.keys.flatMap((anchor) => {
      const id = lookupId(anchor);
      return kinds.map((kind) => ({ anchor, id, kind }));
    });
    let taskIndex = 0;
    let offset = 0;
    let items: readonly ReferenceEnvelope[] = [];
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
            `${this.origin.toString().replace(/\/$/u, "")}/paper/${encodeURIComponent(task.id!)}/${task.kind === "references" ? "references" : "citations"}`,
          );
          url.searchParams.set(
            "fields",
            "citedPaper.paperId,citedPaper.title,citedPaper.abstract,citedPaper.year,citedPaper.publicationDate,citedPaper.authors,citedPaper.externalIds,citedPaper.venue,citedPaper.citationCount,citedPaper.openAccessPdf,citingPaper.paperId,citingPaper.title,citingPaper.abstract,citingPaper.year,citingPaper.publicationDate,citingPaper.authors,citingPaper.externalIds,citingPaper.venue,citingPaper.citationCount,citingPaper.openAccessPdf",
          );
          url.searchParams.set("limit", String(this.pageSize));
          url.searchParams.set("offset", String(offset));
          const root = object(
            await this.options.transport.request(url.toString(), {
              headers: this.headers,
            }),
            "Semantic Scholar reference response is invalid",
          );
          const returnedOffset = nonnegativeInteger(
            root.offset,
            "Semantic Scholar reference offset is invalid",
          );
          if (returnedOffset !== offset)
            throw new Error("Semantic Scholar reference offset changed");
          const values = pageItems(root.data);
          if (values.length > this.pageSize)
            throw new Error("Semantic Scholar reference page is too large");
          const next = nextOffset(root.next, offset);
          if (!values.length) {
            if (next !== null)
              throw new Error(
                "Semantic Scholar empty reference page has a next offset",
              );
            taskIndex += 1;
            offset = 0;
            continue;
          }
          items = values.map((edge) => ({
            edge,
            task: { ...task, id: task.id! },
          }));
          index = 0;
          if (next === null) {
            taskIndex += 1;
            offset = 0;
            exhausted = taskIndex >= tasks.length;
          } else offset = next;
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
          throw new Error("Semantic Scholar reference item is invalid");
        const envelope = raw_item as ReferenceEnvelope;
        const task = envelope.task;
        const edge = object(
          envelope.edge,
          "Semantic Scholar reference item is invalid",
        );
        const relatedField =
          task.kind === "references" ? "citedPaper" : "citingPaper";
        const related = object(
          edge[relatedField],
          "Semantic Scholar related paper is invalid",
        );
        const relatedKey = paperKey(related);
        const relation: ProviderRelationObservation = {
          observation_id: randomUUID(),
          provenance: {
            provenance_id:
              (await this.provenanceId()) as MetadataObservation["provenance"]["provenance_id"],
            source_kind: "metadata-provider",
            source_name: "semantic-scholar",
            source_record_id: relatedKey.record_id,
            observed_at: this.clock(),
            input_sha256: (await sha256(
              canonicalJsonBytes(raw_item),
            )) as MetadataObservation["provenance"]["input_sha256"],
            parameters_sha256: null,
          },
          citing: task.kind === "references" ? task.anchor : relatedKey,
          cited: task.kind === "references" ? relatedKey : task.anchor,
        };
        const observations =
          Object.keys(related).length > 1
            ? [
                await observation(related, {
                  observationId: await this.observationId(),
                  provenanceId: relation.provenance.provenance_id,
                  observedAt: relation.provenance.observed_at,
                  inputSha256: relation.provenance.input_sha256!,
                  parametersSha256: await sha256(
                    canonicalJsonBytes({ kind: task.kind, id: task.id }),
                  ),
                }),
              ]
            : [];
        return {
          observations,
          relations: keysOverlap(relation.citing, relation.cited)
            ? []
            : [relation],
        };
      },
    };
  }
  private session(lookup: boolean, value: string): RawItemSession {
    let offset = 0;
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
        const url = new URL(
          `${this.origin.toString().replace(/\/$/u, "")}${lookup ? `/paper/${encodeURIComponent(value)}` : "/paper/search"}`,
        );
        url.searchParams.set(
          "fields",
          "paperId,title,abstract,year,publicationDate,authors,externalIds,venue,citationCount,openAccessPdf",
        );
        if (!lookup) {
          url.searchParams.set("query", value);
          url.searchParams.set("limit", String(this.pageSize));
          url.searchParams.set("offset", String(offset));
        }
        const root = object(
          await this.options.transport.request(url.toString(), {
            headers: this.headers,
          }),
          "Semantic Scholar response is invalid",
        );
        const records = lookup
          ? root.paperId
            ? [root]
            : []
          : pageItems(root.data);
        if (!lookup) {
          const returnedOffset = nonnegativeInteger(
            root.offset,
            "Semantic Scholar offset is invalid",
          );
          if (returnedOffset !== offset)
            throw new Error("Semantic Scholar response offset changed");
          nonnegativeInteger(root.total, "Semantic Scholar total is invalid");
          if (records.length > this.pageSize)
            throw new Error("Semantic Scholar page is too large");
        }
        if (!records.length) {
          if (!lookup && nextOffset(root.next, offset) !== null)
            throw new Error("Semantic Scholar empty page has a next offset");
          exhausted = true;
          return null;
        }
        const following = lookup ? null : nextOffset(root.next, offset);
        if (fetched && following === offset)
          throw new Error("Semantic Scholar pagination made no progress");
        fetched = true;
        items = records;
        index = 0;
        offset = following ?? offset + records.length;
        exhausted = lookup || following === null;
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
