import { describe, expect, it } from "vitest";
import {
  parseLiterature,
  parseMetadataObservation,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import {
  acceptMetadataObservation,
  projectMetadata,
  sameProviderObservation,
  sameUserObservation,
  userObservationSemanticSha256,
} from "../src/literature/metadata-rules.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const author = (name: string, orcid: string | null = null) => ({
  kind: "person" as const,
  display_name: name,
  given_name: null,
  family_name: null,
  orcid,
  affiliations: [],
});
const metadata = (
  overrides: Partial<LiteratureMetadata> = {},
): LiteratureMetadata => ({
  title: null,
  authors: [],
  abstract: null,
  publication_date: null,
  publication_year: null,
  publication_form: null,
  article_kind: null,
  language: null,
  venue: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  identifiers: [],
  keywords: [],
  subject_terms: [],
  ...overrides,
});
const observation = (
  n: number,
  sourceKind: "user" | "metadata-provider",
  value: LiteratureMetadata,
  sourceName = sourceKind === "user" ? "bibliographic-import" : "provider",
) =>
  parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: id(100 + n),
    provenance: {
      provenance_id: id(200 + n),
      source_kind: sourceKind,
      source_name: sourceName,
      source_record_id: sourceKind === "user" ? null : `record-${n}`,
      observed_at: "2026-09-11T00:00:00Z",
      input_sha256: sourceKind === "user" ? null : String(n).padStart(64, "0"),
      parameters_sha256: null,
    },
    metadata: value,
    version_role: sourceKind === "user" ? null : "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });

describe("Literature metadata rules", () => {
  it("projects user values first and supplements aligned authors", () => {
    const provider = observation(
      1,
      "metadata-provider",
      metadata({
        title: "Provider title",
        abstract: "Provider abstract",
        authors: [
          {
            ...author("Ada Lovelace", "0000-0000-0000-0001"),
            given_name: "Ada",
            affiliations: [{ name: "Analytical Engine", ror: null }],
          },
        ],
        identifiers: [{ namespace: "doi", value: "10.1000/work" }],
        keywords: ["provider-keyword"],
        subject_terms: [],
      }),
    );
    const user = observation(
      2,
      "user",
      metadata({
        title: "User title",
        authors: [author("ADA  LOVELACE", "0000-0000-0000-0001")],
        keywords: ["user-keyword"],
        subject_terms: [],
      }),
    );
    const result = projectMetadata([provider, user]);
    expect(result).toMatchObject({
      outcome: "projected",
      metadata_revision: 1,
      metadata: {
        title: "User title",
        abstract: "Provider abstract",
        keywords: ["user-keyword"],
        subject_terms: [],
      },
    });
    expect(result.metadata?.authors[0]).toMatchObject({
      display_name: "ADA  LOVELACE",
      given_name: "Ada",
      affiliations: [{ name: "Analytical Engine", ror: null }],
    });
  });

  it("honors provider precedence and rejects stable identifier conflicts", () => {
    const low = observation(
      1,
      "metadata-provider",
      metadata({
        title: "Low",
        identifiers: [{ namespace: "doi", value: "10.1000/one" }],
      }),
      "low",
    );
    const high = observation(
      2,
      "metadata-provider",
      metadata({ title: "High" }),
      "high",
    );
    expect(
      projectMetadata([low, high], { provider_precedence: ["high"] }).metadata
        ?.title,
    ).toBe("High");
    const conflict = observation(
      3,
      "metadata-provider",
      metadata({ identifiers: [{ namespace: "doi", value: "10.1000/two" }] }),
    );
    expect(projectMetadata([low, conflict])).toMatchObject({
      outcome: "rejected",
      reason: "stable-identifier-conflict",
    });
  });

  it("preserves content-ready metadata while retaining a compatible new source", () => {
    const current = metadata({
      title: "Analyzed title",
      identifiers: [{ namespace: "doi", value: "10.1000/work" }],
    });
    const source = observation(
      1,
      "metadata-provider",
      metadata({
        title: "Provider title",
        identifiers: [{ namespace: "doi", value: "10.1000/work" }],
      }),
    );
    expect(
      projectMetadata([source], {
        current_metadata: current,
        metadata_revision: 5,
        content_ready: true,
      }),
    ).toMatchObject({
      outcome: "preserved",
      metadata: current,
      metadata_revision: 5,
      changed: false,
    });
  });

  it("deduplicates user semantics but keeps distinct provider observations", async () => {
    const user = observation(1, "user", metadata({ title: "Imported title" }));
    const userReplay = parseMetadataObservation({
      ...user,
      observation_id: id(999),
      provenance: {
        ...user.provenance,
        provenance_id: id(998),
        observed_at: "2026-09-11T01:00:00Z",
      },
    });
    expect(sameUserObservation(user, userReplay)).toBe(true);
    expect(sameProviderObservation(user, userReplay)).toBe(false);
    await expect(userObservationSemanticSha256(user)).resolves.toBe(
      await userObservationSemanticSha256(userReplay),
    );
    expect(
      acceptMetadataObservation(userReplay, {
        existing_observations: [user],
      }),
    ).toMatchObject({
      outcome: "matched",
      deduplicated: true,
      reason: "duplicate-observation",
    });

    const provider = observation(
      2,
      "metadata-provider",
      metadata({ title: "Provider title" }),
    );
    const second = parseMetadataObservation({
      ...provider,
      observation_id: id(997),
      provenance: { ...provider.provenance, provenance_id: id(996) },
    });
    expect(sameProviderObservation(provider, second)).toBe(true);
    expect(
      acceptMetadataObservation(second, {
        existing_observations: [provider],
      }).deduplicated,
    ).toBe(false);
  });

  it("returns the matched Literature and rejects a missing title-or-DOI", () => {
    const existing = parseLiterature({
      literature_id: id(1),
      meta_literature_id: id(2),
      version_role: "published",
      status: "UNREVIEWED",
      metadata: metadata({
        title: "Existing",
        identifiers: [{ namespace: "doi", value: "10.1000/work" }],
      }),
    });
    const incoming = observation(
      1,
      "metadata-provider",
      metadata({
        title: "Incoming",
        identifiers: [{ namespace: "doi", value: "10.1000/work" }],
      }),
    );
    expect(
      acceptMetadataObservation(incoming, {
        existing_literature: [existing],
      }),
    ).toMatchObject({
      outcome: "matched",
      literature: existing,
    });
    expect(
      acceptMetadataObservation(
        observation(2, "metadata-provider", metadata()),
      ),
    ).toMatchObject({
      outcome: "rejected",
      reason: "missing-title-or-doi",
    });
  });
});

it("selects declared provider author keywords below proofread/manual values and merges at most eight normalized subject terms", () => {
  const first = observation(
    31,
    "metadata-provider",
    metadata({
      title: "Scope",
      keywords: ["Provider keyword"],
      subject_terms: [
        "Physics",
        "PHYSICS",
        "Materials",
        ...Array.from({ length: 9 }, (_, i) => `Field ${i}`),
      ],
    }),
    "first",
  );
  const source = { ...first, declared_keywords: first.metadata.keywords };
  const other = {
    ...observation(
      32,
      "metadata-provider",
      metadata({ keywords: ["Other"], subject_terms: ["Biology"] }),
      "other",
    ),
    declared_keywords: ["Other"],
  };
  const projected = projectMetadata([other, source], {
    provider_precedence: ["first", "other"],
  });
  if (projected.outcome === "rejected") throw new Error(projected.reason);
  expect(projected.metadata.keywords).toEqual(["Provider keyword"]);
  expect(projected.metadata.subject_terms).toEqual([
    "Physics",
    "Materials",
    ...Array.from({ length: 6 }, (_, i) => `Field ${i}`),
  ]);
  const proofread = {
    field: "keywords" as const,
    value: ["From paper"],
    evidence: {
      source: "proofread" as const,
      document_version_id: id(900),
      fragment_ids: ["fragment"],
    },
    locked: false,
    conflict: false,
    conflicts: [],
  };
  const proof = projectMetadata([source], {
    current_metadata: metadata({ title: "Scope", keywords: ["From paper"] }),
    field_states: [proofread],
  });
  expect(proof.metadata?.keywords).toEqual(["From paper"]);
  const manual = observation(
    33,
    "user",
    metadata({ title: "Scope", keywords: ["Manual"] }),
  );
  expect(
    projectMetadata([source, manual], {
      current_metadata: metadata({ title: "Scope", keywords: ["From paper"] }),
      field_states: [proofread],
    }).metadata?.keywords,
  ).toEqual(["Manual"]);
  expect(
    projectMetadata([{ ...source, declared_keywords: [] }]).metadata?.keywords,
  ).toEqual([]);
});

it("projects historical author declarations even when observation.metadata.keywords was empty", () => {
  const declared = {
    ...observation(
      41,
      "metadata-provider",
      metadata({ title: "Declared" }),
      "europe-pmc",
    ),
    declared_keywords: ["Author supplied"],
  };
  expect(projectMetadata([declared]).metadata?.keywords).toEqual([
    "Author supplied",
  ]);
});

it("keeps the v14 semantic identity of imports that predate subject_terms", async () => {
  const legacy = observation(51, "user", metadata({ title: "Legacy import" }));
  expect(await userObservationSemanticSha256(legacy)).toBe(
    "58f0a0c6a01810d01536af5b8bcbca540827347c4c09642bf6590f25eee74ee0",
  );
});
