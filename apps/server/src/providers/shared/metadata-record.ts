import { parseProviderObservation } from "./metadata-values.js";
import {
  canonicalJsonBytes,
  sha256,
  type MetadataObservation,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type { MetadataTransport } from "./metadata-transport.js";
export const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const object = (
  value: unknown,
  message: string,
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
};

export const records = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];

/** Protocol lists are required and every raw item must reach record-level conversion. */
export function rawItems(value: unknown): readonly unknown[] {
  if (!Array.isArray(value))
    throw new Error("metadata response items are invalid");
  return value;
}

export const doi = (value: unknown): string | null =>
  text(value)
    ?.replace(/^\s*(?:doi:\s*)?https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .replace(/^\s*doi:\s*/iu, "")
    .toLowerCase() ?? null;

export const safeUrl = (value: unknown): string | null => {
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

export const authors = (value: unknown): readonly Record<string, unknown>[] => {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s*;\s*/u)
      : [];
  return values.flatMap((item) => {
    if (typeof item === "string") {
      const display = text(item);
      return display ? [{ display }] : [];
    }
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const display =
      text(record.displayName) ??
      text(record.name) ??
      text(record.creator) ??
      ([text(record.given), text(record.family)].filter(Boolean).join(" ") ||
        null);
    return display
      ? [
          {
            display,
            given: text(record.given),
            family: text(record.family),
            orcid: text(record.orcid),
          },
        ]
      : [];
  });
};

export async function observation(
  provider: string,
  record: {
    readonly sourceRecordId: string;
    readonly identifiers: readonly { namespace: string; value: string }[];
    readonly title?: unknown;
    readonly abstract?: unknown;
    readonly authors?: unknown;
    readonly publicationDate?: unknown;
    readonly publicationYear?: unknown;
    readonly documentType?: unknown;
    readonly language?: unknown;
    readonly venue?: unknown;
    readonly publisher?: unknown;
    readonly volume?: unknown;
    readonly issue?: unknown;
    readonly pages?: unknown;
    readonly keywords?: unknown;
    readonly subjectTerms?: unknown;
    readonly citedByCount?: unknown;
    readonly referenceCount?: unknown;
    readonly assetHints?: readonly {
      readonly url: string;
      readonly kind: "direct-file" | "landing-page";
      readonly media_type?: string | null;
      readonly asset_role?:
        | "primary-pdf"
        | "supplementary-pdf"
        | "xml"
        | "html"
        | "supplementary"
        | null;
      readonly version_role?:
        | "published"
        | "accepted-manuscript"
        | "preprint"
        | "other"
        | null;
    }[];
    readonly raw: unknown;
    readonly observationId?: string;
    readonly provenanceId?: string;
    readonly observedAt?: string;
    readonly parameters?: unknown;
  },
): Promise<MetadataObservation> {
  const normalizedAuthors = authors(record.authors).map((author) => ({
    kind: "person" as const,
    display_name: author.display as string,
    given_name: (author.given as string | null | undefined) ?? null,
    family_name:
      (author.family as string | null | undefined) ??
      (author.display as string).split(/\s+/u).at(-1) ??
      null,
    orcid: (author.orcid as string | null | undefined) ?? null,
    affiliations: [],
  }));
  return parseProviderObservation({
    observation_id: record.observationId ?? randomUUID(),
    provenance: {
      provenance_id: record.provenanceId ?? randomUUID(),
      source_kind: "metadata-provider",
      source_name: provider,
      source_record_id: record.sourceRecordId,
      observed_at: record.observedAt ?? new Date().toISOString(),
      input_sha256: await sha256(canonicalJsonBytes(record.raw)),
      parameters_sha256:
        record.parameters === undefined
          ? null
          : await sha256(canonicalJsonBytes(record.parameters)),
    },
    source_type: text(record.documentType),
    metadata: {
      title: text(record.title),
      authors: normalizedAuthors,
      abstract: text(record.abstract),
      publication_date: text(record.publicationDate),
      publication_year: record.publicationYear,
      language: text(record.language),
      venue: text(record.venue),
      publisher: text(record.publisher),
      volume: text(record.volume),
      issue: text(record.issue),
      pages: text(record.pages),
      identifiers: record.identifiers,
      subject_terms: Array.isArray(record.subjectTerms)
        ? record.subjectTerms
            .flatMap((item) => {
              const value = text(item);
              return value ? [value] : [];
            })
            .slice(0, 8)
        : [],
      keywords: Array.isArray(record.keywords)
        ? record.keywords.flatMap((item) => {
            const value = text(item);
            return value ? [value] : [];
          })
        : [],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: Array.isArray(record.keywords)
      ? record.keywords.flatMap((item) => {
          const value = text(item);
          return value ? [value] : [];
        })
      : [],
    reference_texts: [],
    reference_count: record.referenceCount,
    cited_by_count: record.citedByCount,
    asset_hints: (record.assetHints ?? []).map((hint) => ({
      url: hint.url,
      kind: hint.kind,
      media_type: hint.media_type ?? null,
      asset_role: hint.asset_role ?? null,
      version_role: hint.version_role ?? "published",
      access_status: hint.kind === "direct-file" ? "open" : "unknown",
      license: null,
    })),
  });
}

export function origin(
  value: string | undefined,
  fallback: string,
  label: string,
): URL {
  const url = new URL(value ?? fallback);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError(`${label} origin must be HTTPS`);
  return url;
}

export function pageSize(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const size = value ?? fallback;
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum)
    throw new TypeError(`${label} page size is invalid`);
  return size;
}

export function headers(
  apiKey: string | undefined,
  name = "x-api-key",
): Readonly<Record<string, string>> {
  if (
    apiKey !== undefined &&
    (!apiKey.trim() || /[\p{Cc}\p{Cf}]/u.test(apiKey))
  )
    throw new TypeError("provider API key is invalid");
  return apiKey ? { [name]: apiKey } : {};
}

export function requestWithHeaders(
  transport: MetadataTransport,
  url: string,
  requestHeaders: Readonly<Record<string, string>>,
) {
  return transport.request(url, { headers: requestHeaders });
}
