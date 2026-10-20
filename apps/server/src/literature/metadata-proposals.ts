import {
  ARTICLE_KINDS,
  PUBLICATION_FORMS,
  METADATA_FIELDS,
  EMPTY_METADATA,
  parseMetadataField,
  parseLiteratureMetadata,
  parseMetadataFieldCandidate,
  type MetadataFieldCandidate,
  type MetadataField,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
export interface MetadataFragment {
  readonly fragment_id: string;
  readonly page: number;
  readonly role: string;
  readonly text: string;
}
const closed = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const nullable = (type: string) => ({ anyOf: [{ type }, { type: "null" }] });
const affiliation = closed({
  name: { type: "string" },
  ror: nullable("string"),
});
const author = closed({
  kind: { type: "string", enum: ["person", "organization", "unknown"] },
  display_name: { type: "string" },
  given_name: nullable("string"),
  family_name: nullable("string"),
  orcid: nullable("string"),
  affiliations: { type: "array", items: affiliation },
});
const valueSchema = (field: MetadataField): unknown =>
  field === "authors"
    ? { type: "array", items: author }
    : field === "identifiers"
      ? {
          type: "array",
          items: closed({
            namespace: { type: "string", enum: ["doi"] },
            value: { type: "string" },
          }),
        }
      : field === "keywords"
        ? { type: "array", items: { type: "string" } }
        : field === "publication_year"
          ? { anyOf: [{ type: "integer" }, { type: "null" }] }
          : field === "publication_form"
            ? {
                anyOf: [
                  { type: "string", enum: [...PUBLICATION_FORMS] },
                  { type: "null" },
                ],
              }
            : field === "article_kind"
              ? {
                  anyOf: [
                    { type: "string", enum: [...ARTICLE_KINDS] },
                    { type: "null" },
                  ],
                }
              : nullable("string");
export const METADATA_PROPOSAL_SCHEMA = closed({
  proposals: {
    type: "array",
    items: {
      anyOf: METADATA_FIELDS.map((field) =>
        closed({
          field: { type: "string", enum: [field] },
          value: valueSchema(field),
          fragment_ids: { type: "array", items: { type: "string" } },
        }),
      ),
    },
  },
});
function citedDois(text: string): ReadonlySet<string> {
  const tokens = text.toLowerCase().match(/10\.\d{4,9}\/[^\s<>"'`]+/gu) ?? [];
  return new Set(
    tokens.map((token) => {
      let value = token.replace(/[.,;:]+$/u, "");
      for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
        ["{", "}"],
      ] as const) {
        while (
          value.endsWith(close) &&
          value.split(close).length > value.split(open).length
        )
          value = value.slice(0, -1);
      }
      return value;
    }),
  );
}
/** Model data never supplies provenance. Evidence is bound to the fixed input owned by Document. */
export function validateMetadataProposals(
  value: unknown,
  document: string,
  fragments: readonly MetadataFragment[],
): {
  readonly candidates: readonly MetadataFieldCandidate[];
  readonly discarded: readonly { field: MetadataField; reason: string }[];
} {
  const fail = (): never => {
    throw new Error("metadata-proposal-invalid");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).join() !== "proposals" ||
    !Array.isArray(r.proposals) ||
    r.proposals.length > METADATA_FIELDS.length
  )
    return fail();
  const seen = new Set<MetadataField>(),
    known = new Map(fragments.map((f) => [f.fragment_id, f]));
  if (known.size !== fragments.length) fail();
  const candidates: MetadataFieldCandidate[] = [],
    discarded: { field: MetadataField; reason: string }[] = [];
  for (const item of r.proposals) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail();
    const p = item as Record<string, unknown>,
      keys = Object.keys(p).sort();
    if (keys.join() !== "field,fragment_ids,value") fail();
    const field = parseMetadataField(p.field);
    if (seen.has(field)) fail();
    seen.add(field);
    if (
      !Array.isArray(p.fragment_ids) ||
      !p.fragment_ids.length ||
      p.fragment_ids.length > 64 ||
      p.fragment_ids.some((id) => typeof id !== "string" || !known.has(id)) ||
      new Set(p.fragment_ids).size !== p.fragment_ids.length
    ) {
      discarded.push({ field, reason: "metadata-evidence-invalid" });
      continue;
    }
    let metadata: LiteratureMetadata;
    try {
      metadata = parseLiteratureMetadata({
        ...EMPTY_METADATA,
        [field]: p.value,
      });
    } catch (error) {
      if (field !== "identifiers") throw error;
      discarded.push({ field, reason: "metadata-doi-invalid" });
      continue;
    }
    if (field === "identifiers") {
      const text = p.fragment_ids
        .map((id) => known.get(String(id))!.text)
        .join("\n")
        .toLowerCase();
      const values = metadata.identifiers;
      if (
        values.some(
          (id) =>
            id.namespace !== "doi" ||
            !/^10\.\d{4,9}\/\S+$/u.test(id.value) ||
            !citedDois(text).has(id.value.toLowerCase()),
        )
      ) {
        discarded.push({ field, reason: "metadata-doi-not-in-evidence" });
        continue;
      }
    }
    candidates.push(
      parseMetadataFieldCandidate({
        field,
        value: metadata[field],
        evidence: {
          source: "proofread",
          document_version_id: document,
          fragment_ids: p.fragment_ids,
        },
      }),
    );
  }
  return { candidates, discarded };
}
