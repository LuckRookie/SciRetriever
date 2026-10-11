import {
  parseProviderObservation,
  metadataDate,
} from "../shared/metadata-values.js";
import {
  canonicalJsonBytes,
  sha256,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type {
  MetadataLookupPort,
  RawItemSession,
  TopicSearchPort,
  TopicSearchQuery,
} from "../../metadata/ports.js";
import type { MetadataTransport } from "../shared/metadata-transport.js";
import {
  JsonMetadataAdapter,
  type MetadataRecordDecoder,
} from "../shared/metadata-transport.js";
import { services } from "./definition.js";
export interface ArxivAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly pageSize?: number;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const xml = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array)
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  throw new Error("arXiv response is invalid");
};
const unescape = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
function tag(body: string, name: string): string | null {
  const match = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,
    "iu",
  ).exec(body);
  return match ? unescape(match[1]!) : null;
}
function attr(body: string, name: string): string | null {
  const match = new RegExp(
    `<link[^>]+${name}=["']([^"']+)["'][^>]*>`,
    "iu",
  ).exec(body);
  return match ? unescape(match[1]!) : null;
}
function pdfLink(body: string): string | null {
  const match =
    /<link[^>]+title=["']pdf["'][^>]+href=["']([^"']+)["'][^>]*>/iu.exec(body);
  return match ? unescape(match[1]!) : attr(body, "href");
}
function entries(value: unknown): readonly Record<string, unknown>[] {
  const source = xml(value);
  if (
    !/^\s*(?:<\?xml\s[^?]*\?>\s*)?<feed(?:\s[^>]*?)?(?:\s*\/>|>[\s\S]*<\/feed>)\s*$/u.test(
      source,
    ) ||
    /<!DOCTYPE|<!ENTITY/iu.test(source)
  )
    throw new Error("arXiv Atom envelope is invalid");
  const result: Record<string, unknown>[] = [];
  for (const match of source.matchAll(
    /<entry(?:\s[^>]*?)?(?:\s*\/>|>([\s\S]*?)<\/entry>)/gu,
  )) {
    const body = match[1] ?? "";
    const id = tag(body, "id");
    const authors = [...body.matchAll(/<author>([\s\S]*?)<\/author>/giu)]
      .map((item) => tag(item[1]!, "name"))
      .filter((item): item is string => item !== null);
    result.push({
      id,
      title: tag(body, "title"),
      summary: tag(body, "summary"),
      published: tag(body, "published"),
      authors,
      doi: tag(body, "arxiv:doi"),
      journal: tag(body, "arxiv:journal_ref"),
      pdf: pdfLink(body),
    });
  }
  if ([...source.matchAll(/<entry(?=\s|\/?>)/gu)].length !== result.length)
    throw new Error("arXiv Atom entries are incomplete");
  return result;
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
  const idValue = text(record.id);
  const sourceRecordId =
    idValue?.match(/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?$/iu)?.[1] ?? null;
  if (!sourceRecordId) throw new Error("arXiv record identity is missing");
  const doiValue = text(record.doi)?.toLowerCase() ?? null;
  const identifiers = [
    { namespace: "arxiv", value: sourceRecordId },
    ...(doiValue ? [{ namespace: "doi", value: doiValue }] : []),
  ];
  const published = text(record.published);

  const pdf = text(record.pdf);
  const title = text(record.title);
  const authors = (Array.isArray(record.authors) ? record.authors : []).flatMap(
    (item) => {
      const value = text(item);
      return value
        ? [
            {
              kind: "person" as const,
              display_name: value,
              given_name: null,
              family_name: value.split(/\s+/u).at(-1) ?? value,
              orcid: null,
              affiliations: [],
            },
          ]
        : [];
    },
  );
  return parseProviderObservation({
    observation_id: options.observationId,
    provenance: {
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "arxiv",
      source_record_id: sourceRecordId,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: options.parametersSha256,
    },
    metadata: {
      title,
      authors,
      abstract: text(record.summary),
      publication_date: published,
      publication_year: metadataDate(published)?.slice(0, 4) ?? null,
      document_type: "preprint",
      language: null,
      venue: text(record.journal),
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      identifiers,
      keywords: [],
    },
    version_role: "preprint",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: pdf
      ? [
          {
            url: pdf,
            kind: "direct-file",
            media_type: "application/pdf",
            asset_role: "primary-pdf",
            version_role: "preprint",
            access_status: "open",
            license: null,
          },
        ]
      : [],
  });
}
function size(value: number | undefined): number {
  const result = value ?? 50;
  if (!Number.isSafeInteger(result) || result < 1 || result > 200)
    throw new TypeError("arXiv page size is invalid");
  return result;
}

export class ArxivRestAdapter implements TopicSearchPort, MetadataLookupPort {
  readonly provider_name = "arxiv" as const;
  private readonly origin: URL;
  private readonly pageSize: number;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: ArxivAdapterOptions) {
    this.origin = new URL(options.origin ?? services["arxiv-query"].endpoint);
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("arXiv origin must be HTTPS");
    this.pageSize = size(options.pageSize);
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_topic_search(query: TopicSearchQuery): RawItemSession {
    // An unscoped whitespace term is OR'd by arXiv. Explicitly scope every
    // term and join them with AND; retain phrases the caller explicitly quoted.
    const terms = query.query.match(/"[^"]+"|\S+/gu) ?? [];
    return this.session(
      terms.map((term) => `all:${term}`).join(" AND "),
      false,
    );
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const value =
      key.record_id ??
      key.identifiers.find((item) => item.namespace === "arxiv")?.value;
    if (!value) throw new TypeError("arXiv lookup key is empty");
    return this.session(value, true);
  }
  private session(value: string, lookup: boolean): RawItemSession {
    let start = 0;
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
        const url = new URL(this.origin);
        url.searchParams.set("max_results", String(this.pageSize));
        if (lookup) url.searchParams.set("id_list", value);
        else {
          url.searchParams.set("search_query", value);
          url.searchParams.set("start", String(start));
        }
        const pageItems = entries(
          await this.options.transport.request(url.toString()),
        );
        if (!pageItems.length) {
          exhausted = true;
          return null;
        }
        if (fetched && start === 0 && lookup)
          throw new Error("arXiv lookup repeated");
        fetched = true;
        items = pageItems;
        index = 0;
        start += pageItems.length;
        exhausted = lookup || pageItems.length < this.pageSize;
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

export class ArxivAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("arxiv", t, b, d);
  }
}
