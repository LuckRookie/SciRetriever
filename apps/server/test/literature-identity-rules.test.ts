import { describe, expect, it } from "vitest";
import {
  parseLiterature,
  parseMetadataObservation,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
  normalizeIdentityText,
  providerKeyMatchesSeed,
  resolveLiteratureIdentity,
  resolveMetaLiterature,
  stableIdentifierIndex,
} from "../src/literature/identity-rules.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const metadata = (
  overrides: Partial<LiteratureMetadata> = {},
): LiteratureMetadata => ({
  title: "École  Study",
  authors: [
    {
      kind: "person",
      display_name: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      orcid: null,
      affiliations: [],
    },
  ],
  abstract: null,
  publication_date: null,
  publication_year: 2026,
  document_type: "journal-article",
  language: null,
  venue: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  identifiers: [],
  keywords: [],
  ...overrides,
});
const literature = (n: number, value: LiteratureMetadata, meta = id(100 + n)) =>
  parseLiterature({
    literature_id: id(n),
    meta_literature_id: meta,
    version_role: "published",
    status: "UNREVIEWED",
    metadata: value,
  });
const observation = (
  n: number,
  value: LiteratureMetadata,
  options: {
    source?: string;
    record?: string;
    links?: readonly {
      record_id: string | null;
      identifiers: readonly { namespace: string; value: string }[];
    }[];
  } = {},
) =>
  parseMetadataObservation({
    observation_id: id(200 + n),
    provenance: {
      provenance_id: id(300 + n),
      source_kind: "metadata-provider",
      source_name: options.source ?? "openalex",
      source_record_id: options.record ?? `W${n}`,
      observed_at: "2026-09-11T00:00:00Z",
      input_sha256: String(n).padStart(64, "0"),
      parameters_sha256: null,
    },
    metadata: value,
    version_role: "published",
    version_links: options.links ?? [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });

describe("Literature identity rules", () => {
  it("uses Python-compatible Unicode folding and stable fallback hashes", async () => {
    expect(normalizeIdentityText("  École\u2003  STUDY  ")).toBe("école study");
    expect(normalizeIdentityText("Straße")).toBe("strasse");
    const key = fallbackIdentityKey(metadata());
    expect(key).toEqual([
      "école study",
      ["ada lovelace"],
      2026,
      "journal-article",
    ]);
    await expect(fallbackIdentitySha256(key!)).resolves.toMatch(
      /^[0-9a-f]{64}$/u,
    );
    await expect(fallbackIdentitySha256(key!)).resolves.toBe(
      await fallbackIdentitySha256(fallbackIdentityKey(metadata())!),
    );
  });

  it("matches stable identities conservatively and falls back only without stable IDs", () => {
    const first = literature(
      1,
      metadata({ identifiers: [{ namespace: "doi", value: "10.1000/one" }] }),
    );
    expect(stableIdentifierIndex(first.metadata)).toEqual([
      ["doi", "10.1000/one"],
    ]);
    expect(
      resolveLiteratureIdentity(
        metadata({ identifiers: [{ namespace: "doi", value: "10.1000/one" }] }),
        [first],
      ),
    ).toMatchObject({ decision: "matched", literature: first });
    expect(
      resolveLiteratureIdentity(
        metadata({
          identifiers: [
            { namespace: "doi", value: "10.1000/one" },
            { namespace: "doi", value: "10.1000/two" },
          ],
        }),
        [first],
      ),
    ).toMatchObject({
      decision: "identity-conflict",
      reason: "incoming-stable-identifier-conflict",
    });
    expect(
      resolveLiteratureIdentity(metadata(), [literature(2, metadata())]),
    ).toMatchObject({
      decision: "matched",
      reason: "fallback",
    });
    expect(
      resolveLiteratureIdentity(
        metadata({ identifiers: [{ namespace: "openalex", value: "W1" }] }),
        [first],
      ),
    ).toMatchObject({ decision: "created", reason: "no-fallback-match" });
  });

  it("requires every provider record and stable identifier claim to match the seed closure", () => {
    const record = observation(
      1,
      metadata({ identifiers: [{ namespace: "pmid", value: "1" }] }),
      { source: "crossref", record: "provider-record" },
    );
    const doi = observation(
      2,
      metadata({ identifiers: [{ namespace: "doi", value: "10.1000/seed" }] }),
      { source: "other" },
    );
    expect(
      providerKeyMatchesSeed(
        "crossref",
        {
          record_id: "provider-record",
          identifiers: [{ namespace: "doi", value: "10.1000/seed" }],
        },
        [record, doi],
      ),
    ).toBe(true);
    expect(
      providerKeyMatchesSeed(
        "semantic-scholar",
        { record_id: "provider-record", identifiers: [] },
        [record],
      ),
    ).toBe(false);
  });

  it("links versions only through one provider-scoped explicit target", () => {
    const current = literature(1, metadata(), id(101));
    const target = literature(2, metadata(), id(102));
    const source = observation(1, metadata(), {
      source: "openalex",
      record: "CURRENT",
      links: [{ record_id: "TARGET", identifiers: [] }],
    });
    const targetObservation = observation(2, metadata(), {
      source: "openalex",
      record: "TARGET",
    });
    expect(
      resolveMetaLiterature(current, source, [
        { literature: target, observations: [targetObservation] },
      ]),
    ).toEqual({
      decision: "linked",
      meta_literature_id: current.meta_literature_id,
      linked_literature_ids: [current.literature_id, target.literature_id],
    });
    expect(
      resolveMetaLiterature(current, source, [
        { literature: target, observations: [targetObservation] },
        {
          literature: literature(3, metadata()),
          observations: [
            observation(3, metadata(), {
              source: "openalex",
              record: "TARGET",
            }),
          ],
        },
      ]),
    ).toMatchObject({ decision: "identity-conflict" });
  });
});
