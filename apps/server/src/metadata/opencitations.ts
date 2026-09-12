import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseProvenance,
  parseMetadataObservation,
  sha256,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import type { MetadataTransport } from "./providers.js";
import type {
  MetadataLookupPort,
  NeutralMetadataItem,
  ProviderRelationObservation,
  RawItemSession,
  ReferenceQueryContext,
  ReferenceQueryPort,
} from "./ports.js";

export interface OpenCitationsAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const array = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];
const doiValue = (value: unknown): string | null =>
  text(value)
    ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .toLowerCase() ?? null;
function authors(value: unknown) {
  return (text(value) ?? "").split(/\s*;\s*/u).flatMap((item) => {
    const name = text(item);
    return name
      ? [
          {
            kind: "person" as const,
            display_name: name,
            given_name: null,
            family_name: name.split(/\s+/u).at(-1) ?? name,
            orcid: null,
            affiliations: [],
          },
        ]
      : [];
  });
}
function endpoint(value: unknown): {
  readonly record_id: string | null;
  readonly identifiers: readonly {
    readonly namespace: string;
    readonly value: string;
  }[];
} {
  const doi = doiValue(value);
  return {
    record_id: doi,
    identifiers: doi ? [{ namespace: "doi", value: doi }] : [],
  };
}
function relation(
  record: Record<string, unknown>,
  options: {
    readonly observationId: string;
    readonly provenanceId: string;
    readonly observedAt: string;
    readonly inputSha256: string;
  },
): ProviderRelationObservation {
  const citing = endpoint(record.citing);
  const cited = endpoint(record.cited);
  const sourceRecordId = text(record.oci);
  if (
    !citing.identifiers.length ||
    !cited.identifiers.length ||
    !sourceRecordId
  )
    throw new Error("OpenCitations relation identity is missing");
  return {
    observation_id: options.observationId,
    provenance: parseProvenance({
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "opencitations",
      source_record_id: sourceRecordId,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: null,
    }),
    citing,
    cited,
  };
}
function observation(
  record: Record<string, unknown>,
  options: {
    readonly observationId: string;
    readonly provenanceId: string;
    readonly observedAt: string;
    readonly inputSha256: string;
  },
): MetadataObservation {
  const doi = doiValue(record.doi ?? record.id);
  if (!doi) throw new Error("OpenCitations metadata identity is missing");
  const yearValue = Number.parseInt(
    text(record.pub_date)?.slice(0, 4) ?? "",
    10,
  );
  return parseMetadataObservation({
    observation_id: options.observationId,
    provenance: {
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "opencitations",
      source_record_id: doi,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: null,
    },
    metadata: {
      title: text(record.title),
      authors: authors(record.author),
      abstract: null,
      publication_date: text(record.pub_date),
      publication_year:
        Number.isSafeInteger(yearValue) && yearValue > 0 ? yearValue : null,
      document_type: text(record.type),
      language: null,
      venue: text(record.venue),
      publisher: null,
      volume: text(record.volume),
      issue: text(record.issue),
      pages: text(record.page),
      identifiers: [{ namespace: "doi", value: doi }],
      keywords: [],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}

export class OpenCitationsRestAdapter
  implements MetadataLookupPort, ReferenceQueryPort
{
  readonly provider_name = "opencitations" as const;
  private readonly origin: URL;
  private readonly observationId: () => string | Promise<string>;
  private readonly provenanceId: () => string | Promise<string>;
  private readonly clock: () => string;
  constructor(private readonly options: OpenCitationsAdapterOptions) {
    this.origin = new URL(options.origin ?? "https://api.opencitations.net");
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("OpenCitations origin must be HTTPS");
    this.observationId = options.observationId ?? randomUUID;
    this.provenanceId = options.provenanceId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }
  open_lookup(key: ProviderLiteratureKey): RawItemSession {
    const value =
      key.record_id ??
      key.identifiers.find((item) => item.namespace === "doi")?.value;
    if (!value) throw new TypeError("OpenCitations lookup key is empty");
    return this.session("meta", doiValue(value) ?? value);
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (query.direction === "cited-by")
      throw new Error("OpenCitations cited-by capability is unavailable");
    const value =
      query.keys[0]?.record_id ??
      query.keys[0]?.identifiers.find((item) => item.namespace === "doi")
        ?.value;
    if (!value) throw new TypeError("OpenCitations reference key is empty");
    return this.session("index", doiValue(value) ?? value);
  }
  private session(kind: "meta" | "index", value: string): RawItemSession {
    let delivered = false;
    return {
      pull_raw_item: async () => {
        if (delivered) return null;
        delivered = true;
        const url = new URL(
          `${this.origin.toString().replace(/\/$/u, "")}/${kind === "meta" ? "meta/v1" : "index/v2"}/${encodeURIComponent(value)}`,
        );
        const response = await this.options.transport.request(url.toString());
        const records = array(response);
        if (!records.length) return null;
        return { raw_item: records, source_exhausted_after: true };
      },
      convert_raw_item: async (raw_item): Promise<NeutralMetadataItem> => {
        const records = array(raw_item);
        const inputSha256 = await sha256(canonicalJsonBytes(raw_item));
        if (kind === "meta")
          return {
            observations: [
              observation(records[0]!, {
                observationId: await this.observationId(),
                provenanceId: await this.provenanceId(),
                observedAt: this.clock(),
                inputSha256,
              }),
            ],
            relations: [],
          };
        const relations = await Promise.all(
          records.map(async (record) =>
            relation(record, {
              observationId: await this.observationId(),
              provenanceId: await this.provenanceId(),
              observedAt: this.clock(),
              inputSha256,
            }),
          ),
        );
        return { observations: [], relations };
      },
    };
  }
}
