import {
  parseProviderObservation,
  metadataDate,
} from "../shared/metadata-values.js";
import {
  canonicalJsonBytes,
  parseIdentifier,
  parseProvenance,
  sha256,
  type Identifier,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type {
  MetadataLookupPort,
  NeutralMetadataItem,
  ProviderRelationObservation,
  RawItemSession,
  ReferenceQueryContext,
  ReferenceQueryPort,
} from "../../metadata/ports.js";
import type { MetadataTransport } from "../shared/metadata-transport.js";
import {
  JsonMetadataAdapter,
  type MetadataRecordDecoder,
} from "../shared/metadata-transport.js";
import { services } from "./definition.js";
export interface OpenCitationsAdapterOptions {
  readonly transport: MetadataTransport;
  readonly origin?: string;
  readonly observationId?: () => string | Promise<string>;
  readonly provenanceId?: () => string | Promise<string>;
  readonly clock?: () => string;
}
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const INDEX_NAMES = new Set(["coci", "poci", "croci", "doci"]);
const PID_NAMES = new Set(["doi", "pmid", "isbn", "openalex", "omid"]);
function pids(value: unknown): readonly Identifier[] {
  const raw = text(value);
  if (!raw) return [];
  // Retain the single DOI shape accepted by older adapter callers/fixtures.
  if (/^(?:10\.\d{4,9}\/|https?:\/\/(?:dx\.)?doi\.org\/)/iu.test(raw))
    return [parseIdentifier({ namespace: "doi", value: raw })];
  const result: Identifier[] = [];
  for (const group of raw.split(/\s*;\s*(?=\[)/u)) {
    const prefixed = /^\[([^\]]+)\]\s*=>\s*(.+)$/u.exec(group);
    if (group.startsWith("[") && (!prefixed || !INDEX_NAMES.has(prefixed[1]!)))
      throw new Error("OpenCitations index prefix is invalid");
    for (const token of (prefixed?.[2] ?? group).split(/\s+/u)) {
      const match = /^([a-z]+):(.+)$/iu.exec(token);
      if (!match || !PID_NAMES.has(match[1]!.toLowerCase()))
        throw new Error("OpenCitations identifier namespace is invalid");
      const identifier = parseIdentifier({
        namespace: match[1],
        value: match[2],
      });
      if (
        !result.some(
          (item) =>
            item.namespace === identifier.namespace &&
            item.value === identifier.value,
        )
      )
        result.push(identifier);
    }
  }
  return result;
}
function recordId(identifiers: readonly Identifier[]): string | null {
  const identity =
    identifiers.find((item) => item.namespace === "doi") ??
    identifiers.find((item) => item.namespace === "pmid") ??
    identifiers.find((item) => item.namespace === "omid") ??
    identifiers[0];
  return identity
    ? identity.namespace === "doi"
      ? identity.value
      : `${identity.namespace}:${identity.value}`
    : null;
}
function requestId(key: ProviderLiteratureKey): string {
  const identifier = [...pids(key.record_id), ...key.identifiers].find((item) =>
    ["doi", "pmid", "omid"].includes(item.namespace),
  );
  if (!identifier) throw new TypeError("OpenCitations lookup key is empty");
  const normalized = parseIdentifier(identifier);
  return `${normalized.namespace}:${normalized.value}`;
}
function nameValue(value: unknown): string | null {
  return text(text(value)?.replace(/\s*\[[^\]]*\]\s*$/u, ""));
}
function authors(value: unknown) {
  return (text(value) ?? "").split(/\s*;\s*/u).flatMap((item) => {
    const name = nameValue(item);
    const identifiers = /\[([^\]]*)\]\s*$/u.exec(item)?.[1];
    const orcid = /(?:^|\s)orcid:([^\s]+)/u.exec(identifiers ?? "")?.[1];
    const comma = name?.indexOf(",") ?? -1;
    return name
      ? [
          {
            kind: "person" as const,
            display_name: name,
            given_name: comma < 0 ? null : text(name.slice(comma + 1)),
            family_name:
              comma < 0
                ? (name.split(/\s+/u).at(-1) ?? name)
                : text(name.slice(0, comma)),
            orcid: orcid ?? null,
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
  // ISBN-only entities are not article relation endpoints for this adapter.
  const identifiers = pids(value).filter((item) => item.namespace !== "isbn");
  return {
    record_id: recordId(identifiers),
    identifiers,
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
  const identifiers = pids(record.doi ?? record.id);
  const sourceRecordId = recordId(identifiers);
  if (!sourceRecordId)
    throw new Error("OpenCitations metadata identity is missing");

  return parseProviderObservation({
    observation_id: options.observationId,
    provenance: {
      provenance_id: options.provenanceId,
      source_kind: "metadata-provider",
      source_name: "opencitations",
      source_record_id: sourceRecordId,
      observed_at: options.observedAt,
      input_sha256: options.inputSha256,
      parameters_sha256: null,
    },
    source_type: text(record.type),
    metadata: {
      title: text(record.title),
      authors: authors(record.author),
      abstract: null,
      publication_date: text(record.pub_date),
      publication_year: metadataDate(record.pub_date)?.slice(0, 4) ?? null,
      language: null,
      venue: nameValue(record.venue),
      publisher: nameValue(record.publisher),
      volume: text(record.volume),
      issue: text(record.issue),
      pages: text(record.page),
      identifiers,
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
    this.origin = new URL(options.origin ?? services["opencitations"].endpoint);
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
    return this.session("meta", requestId(key));
  }
  open_reference_query(query: ReferenceQueryContext): RawItemSession {
    if (query.direction === "cited-by")
      throw new Error("OpenCitations cited-by capability is unavailable");
    const key = query.keys[0];
    if (!key) throw new TypeError("OpenCitations reference key is empty");
    return this.session("index", requestId(key));
  }
  private session(kind: "meta" | "index", value: string): RawItemSession {
    let items: readonly unknown[] | null = null;
    let index = 0;
    return {
      pull_raw_item: async () => {
        if (items === null) {
          const url = new URL(
            `${this.origin.toString().replace(/\/$/u, "")}/${kind === "meta" ? "meta/v1/metadata" : "index/v2/references"}/${encodeURIComponent(value)}`,
          );
          const response = await this.options.transport.request(url.toString());
          if (!Array.isArray(response))
            throw new Error("OpenCitations response is invalid");
          items = response;
        }
        if (index >= items.length) return null;
        return {
          raw_item: items[index++]!,
          source_exhausted_after: index === items.length,
        };
      },
      convert_raw_item: async (raw_item): Promise<NeutralMetadataItem> => {
        if (
          !raw_item ||
          typeof raw_item !== "object" ||
          Array.isArray(raw_item)
        )
          throw new Error("OpenCitations record is invalid");
        const record = raw_item as Record<string, unknown>;
        const inputSha256 = await sha256(canonicalJsonBytes(raw_item));
        if (kind === "meta")
          return {
            observations: [
              observation(record, {
                observationId: await this.observationId(),
                provenanceId: await this.provenanceId(),
                observedAt: this.clock(),
                inputSha256,
              }),
            ],
            relations: [],
          };
        const relations = [
          relation(record, {
            observationId: await this.observationId(),
            provenanceId: await this.provenanceId(),
            observedAt: this.clock(),
            inputSha256,
          }),
        ];
        return { observations: [], relations };
      },
    };
  }
}

export class OpenCitationsAdapter extends JsonMetadataAdapter {
  constructor(t: MetadataTransport, b: string, d?: MetadataRecordDecoder) {
    super("opencitations", t, b, d);
  }
}
