import {
  mapSourceType,
  SOURCE_TYPE_MAPPING_VERSION,
} from "../../literature/metadata-types.js";
import {
  ContractValidationError,
  parseAffiliation,
  parseAssetHint,
  parseAuthor,
  parseMetadataObservation,
  type MetadataObservation,
} from "@sciretriever/contracts";
import { createLogger, type Logger } from "../../logging/index.js";

const logger = createLogger("provider-metadata");
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Complete decimal integers only; never interpret a prefix such as "2024 draft". */
export function metadataInteger(value: unknown): number | null {
  const number =
    typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number(value.trim())
      : value;
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 0
    ? number
    : null;
}

/** Preserve positional precision; a missing month can never turn a day into a month. */
export function metadataDateParts(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const [year, month, day] = value;
  if (
    typeof year !== "number" ||
    !Number.isInteger(year) ||
    year < 1 ||
    year > 9999
  )
    return null;
  let date = String(year).padStart(4, "0");
  if (
    typeof month !== "number" ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  )
    return date;
  date += `-${String(month).padStart(2, "0")}`;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]!;
  if (
    typeof day !== "number" ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > days
  )
    return date;
  return `${date}-${String(day).padStart(2, "0")}`;
}

export function metadataDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const match =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(raw) ??
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
      raw,
    );
  return match
    ? metadataDateParts(
        match
          .slice(1)
          .map((part) => (part === undefined ? undefined : Number(part))),
      )
    : null;
}

/** Field loss is an ephemeral diagnostic, never a second catalog fact or raw payload. */
class OptionalFields {
  readonly discarded = new Set<string>();
  drop(path: string): null {
    this.discarded.add(path);
    return null;
  }
  text(value: unknown, path: string): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return this.drop(path);
    const normalized = value.replace(/\s+/gu, " ").trim().normalize("NFC");
    if (!normalized) return null;
    return /[\p{Cc}\uD800-\uDFFF]/u.test(normalized)
      ? this.drop(path)
      : normalized;
  }
  integer(value: unknown, path: string, year = false): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = metadataInteger(value);
    return number !== null && (!year || (number >= 1 && number <= 9999))
      ? number
      : this.drop(path);
  }
  date(value: unknown, path: string): string | null {
    if (value === null || value === undefined || value === "") return null;
    const date = metadataDate(value);
    if (typeof value !== "string" || date !== value.trim().split("T", 1)[0])
      this.drop(path);
    return date;
  }
  list(value: unknown, path: string): readonly unknown[] {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    this.drop(path);
    return [];
  }
  strings(value: unknown, path: string): readonly string[] {
    return this.list(value, path).flatMap((item, index) => {
      const text = this.text(item, `${path}[${index}]`);
      return text === null ? [] : [text];
    });
  }
  checked<T>(path: string, parse: () => T): T | null {
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof ContractValidationError)) throw error;
      return this.drop(path);
    }
  }
  author(value: unknown, path: string) {
    const raw = object(value);
    const display = this.text(raw?.display_name, `${path}.display_name`);
    if (!raw || !display) return this.drop(path);
    const affiliations = this.list(
      raw.affiliations,
      `${path}.affiliations`,
    ).flatMap((value, index) => {
      const a = object(value),
        p = `${path}.affiliations[${index}]`;
      const name = this.text(a?.name, `${p}.name`);
      if (!name) {
        this.drop(p);
        return [];
      }
      const ror = this.text(a?.ror, `${p}.ror`);
      const item = this.checked(p, () => parseAffiliation({ name, ror }));
      return [item ?? parseAffiliation({ name, ror: null })];
    });
    const author = {
      kind: raw.kind,
      display_name: display,
      given_name: this.text(raw.given_name, `${path}.given_name`),
      family_name: this.text(raw.family_name, `${path}.family_name`),
      orcid: null,
      affiliations,
    };
    const base = this.checked(path, () => parseAuthor(author));
    if (!base) return null;
    const orcid =
      this.text(raw.orcid, `${path}.orcid`)?.replace(
        /^https?:\/\/orcid\.org\//iu,
        "",
      ) ?? null;
    return (
      this.checked(`${path}.orcid`, () => parseAuthor({ ...base, orcid })) ??
      base
    );
  }
}

/** Vendor mappings stay explicit. Only the declared optional neutral fields degrade here. */
export function parseProviderObservation(
  input: {
    readonly metadata: Record<string, unknown>;
    readonly provenance: unknown;
    readonly [key: string]: unknown;
  },
  diagnostics: Logger = logger,
): MetadataObservation {
  const fields = new OptionalFields();
  const metadata = { ...input.metadata };
  for (const name of [
    "title",
    "abstract",
    "language",
    "venue",
    "publisher",
    "volume",
    "issue",
    "pages",
  ])
    metadata[name] = fields.text(metadata[name], `metadata.${name}`);
  metadata.publication_date = fields.date(
    metadata.publication_date,
    "metadata.publication_date",
  );
  metadata.publication_year = fields.integer(
    metadata.publication_year,
    "metadata.publication_year",
    true,
  );
  metadata.authors = fields
    .list(metadata.authors, "metadata.authors")
    .flatMap((value, i) => {
      const author = fields.author(value, `metadata.authors[${i}]`);
      return author ? [author] : [];
    });
  metadata.keywords = fields.strings(metadata.keywords, "metadata.keywords");
  const asset_hints = fields
    .list(input.asset_hints, "asset_hints")
    .flatMap((value, i) => {
      const raw = object(value);
      const path = `asset_hints[${i}]`;
      if (!raw) {
        fields.drop(path);
        return [];
      }
      const hint = { ...raw };
      for (const name of ["media_type", "access_status", "license"])
        hint[name] = fields.text(hint[name], `${path}.${name}`);
      const parsed = fields.checked(path, () => parseAssetHint(hint));
      return parsed ? [parsed] : [];
    });
  const source_type = fields.text(input.source_type, "source_type");
  const mapping = mapSourceType(
    String(object(input.provenance)?.source_name ?? ""),
    source_type,
  );
  metadata.publication_form = mapping.publication_form;
  metadata.article_kind = mapping.article_kind_hint;
  const result = parseMetadataObservation({
    ...input,
    source_type,
    source_type_mapping_version: SOURCE_TYPE_MAPPING_VERSION,
    version_role: mapping.version_role_hint ?? input.version_role,
    metadata,
    asset_hints,
    declared_keywords: fields.strings(
      input.declared_keywords,
      "declared_keywords",
    ),
    reference_texts: fields.strings(input.reference_texts, "reference_texts"),
    reference_count: fields.integer(input.reference_count, "reference_count"),
    cited_by_count: fields.integer(input.cited_by_count, "cited_by_count"),
  });
  if (fields.discarded.size)
    diagnostics.warn("Discarded unsupported optional metadata fields", {
      provider: result.provenance.source_name,
      code: "metadata-optional-field-discarded",
      operation: [...fields.discarded].join(","),
    });
  return result;
}
