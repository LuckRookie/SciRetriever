import {
  parseProviderObservation,
  metadataDateParts,
} from "../shared/metadata-values.js";
import {
  canonicalJsonBytes,
  sha256,
  type MetadataObservation,
} from "@sciretriever/contracts";
/** Convert one already-decoded Crossref work into the neutral observation contract. */
export async function parseCrossrefRecord(
  value: unknown,
  options: {
    readonly observation_id: string;
    readonly provenance_id: string;
    readonly observed_at: string;
    readonly parameters_sha256?: string | null;
  },
): Promise<MetadataObservation> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Crossref record");
  const record = value as Record<string, unknown>;
  const displayText = (value: unknown): string | null =>
    typeof value === "string"
      ? value.replace(/\s+/gu, " ").trim() || null
      : null;
  const text = (key: string): string | null => {
    return displayText(record[key]);
  };
  const first = (key: string): unknown =>
    Array.isArray(record[key]) ? record[key][0] : null;
  const stripMarkup = (input: string): string =>
    input
      .replace(/<[^>]*>/gu, " ")
      .replace(
        /&(?:amp|lt|gt|quot|apos);/gu,
        (entity) =>
          ({
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": '"',
            "&apos;": "'",
          })[entity] ?? entity,
      )
      .replace(/\s+/gu, " ")
      .trim();
  const doi =
    typeof record.DOI === "string"
      ? record.DOI.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
      : null;
  if (!doi) throw new Error("Crossref record has no DOI");
  const authors = (Array.isArray(record.author) ? record.author : []).flatMap(
    (item): readonly unknown[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const author = item as Record<string, unknown>;
      const given = displayText(author.given);
      const family = displayText(author.family);
      const name = displayText(author.name);
      const display = name ?? [given, family].filter(Boolean).join(" ");
      if (!display) return [];
      const affiliations = (
        Array.isArray(author.affiliation) ? author.affiliation : []
      ).flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const affiliation = displayText(
          (entry as Record<string, unknown>).name,
        );
        return affiliation ? [{ name: affiliation, ror: null }] : [];
      });
      const orcidValue = typeof author.ORCID === "string" ? author.ORCID : null;
      return [
        {
          kind: name && !given && !family ? "organization" : "person",
          display_name: display,
          given_name: given,
          family_name: family,
          orcid:
            orcidValue
              ?.replace(/^https?:\/\/orcid\.org\//iu, "")
              .toUpperCase() ?? null,
          affiliations,
        },
      ];
    },
  );
  const publicationDate =
    ["published-print", "published-online", "published", "issued"]
      .map((key) => {
        const value = record[key];
        if (!value || typeof value !== "object" || Array.isArray(value))
          return null;
        const parts = (value as Record<string, unknown>)["date-parts"];
        return Array.isArray(parts) ? metadataDateParts(parts[0]) : null;
      })
      .find((value) => value !== null) ?? null;
  const links = (Array.isArray(record.link) ? record.link : []).flatMap(
    (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const link = item as Record<string, unknown>;
      if (typeof link.URL !== "string") return [];
      let url: URL;
      try {
        url = new URL(link.URL);
      } catch {
        return [];
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        [...url.searchParams.keys()].some((key) =>
          /token|signature|key|password|credential|cookie/iu.test(key),
        )
      )
        return [];
      const contentType =
        typeof link["content-type"] === "string"
          ? link["content-type"].toLowerCase()
          : null;
      const contentVersion =
        typeof link["content-version"] === "string"
          ? link["content-version"].toLowerCase()
          : null;
      return [
        {
          url: url.toString(),
          kind: "direct-file",
          media_type: contentType,
          asset_role:
            contentType === "application/pdf"
              ? "primary-pdf"
              : contentType === "text/html"
                ? "html"
                : null,
          version_role:
            contentVersion === "vor"
              ? "published"
              : contentVersion === "am"
                ? "accepted-manuscript"
                : null,
          access_status: "unknown",
          license: null,
        },
      ];
    },
  );
  const references = (
    Array.isArray(record.reference) ? record.reference : []
  ).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const reference = item as Record<string, unknown>;
    const raw = displayText(reference.unstructured);
    const target =
      typeof reference.DOI === "string" ? reference.DOI.trim() : null;
    const value = raw || target;
    return value ? [value] : [];
  });
  const input_sha256 = await sha256(canonicalJsonBytes(record));
  return parseProviderObservation({
    observation_id: options.observation_id,
    provenance: {
      provenance_id: options.provenance_id,
      source_kind: "metadata-provider",
      source_name: "crossref",
      source_record_id: doi,
      observed_at: options.observed_at,
      input_sha256,
      parameters_sha256: options.parameters_sha256 ?? null,
    },
    metadata: {
      title: displayText(first("title")),
      authors,
      abstract:
        typeof record.abstract === "string"
          ? stripMarkup(record.abstract) || null
          : null,
      publication_date: publicationDate,
      publication_year: publicationDate?.slice(0, 4) ?? null,
      document_type: text("type"),
      language: text("language"),
      venue: displayText(first("container-title")),
      publisher: text("publisher"),
      volume: text("volume"),
      issue: text("issue"),
      pages: text("page"),
      identifiers: [{ namespace: "doi", value: doi }],
      keywords: [],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: references,
    reference_count: record["reference-count"],
    cited_by_count: record["is-referenced-by-count"],
    asset_hints: links,
  });
}
