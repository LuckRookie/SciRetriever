import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  canonicalJsonBytes,
  parseLiterature,
  parseMetadataObservation,
  sha256,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { id, lit, proposal, setup } from "./content-fixture.js";

const metadata = (
  title: string,
  identifiers: readonly { namespace: string; value: string }[] = [],
  overrides: Partial<LiteratureMetadata> = {},
): LiteratureMetadata => ({
  title,
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
  document_type: "article",
  language: "en",
  venue: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  identifiers,
  keywords: [],
  ...overrides,
});

function observation(
  n: number,
  options: {
    kind?: "metadata-provider" | "user";
    provider?: string;
    record?: string | null;
    title?: string;
    identifiers?: readonly { namespace: string; value: string }[];
    role?: "published" | "accepted-manuscript" | "preprint" | "other";
    links?: readonly {
      record_id: string | null;
      identifiers: readonly { namespace: string; value: string }[];
    }[];
    metadata?: LiteratureMetadata;
  } = {},
) {
  const kind = options.kind ?? "metadata-provider";
  return parseMetadataObservation({
    observation_id: id(1_000 + n),
    provenance: {
      provenance_id: id(2_000 + n),
      source_kind: kind,
      source_name:
        options.provider ?? (kind === "user" ? "bibliographic-import" : "p"),
      source_record_id:
        options.record === undefined
          ? kind === "user"
            ? null
            : `record-${n}`
          : options.record,
      observed_at: `2026-09-11T00:${String(n).padStart(2, "0")}:00Z`,
      input_sha256: kind === "user" ? null : String(n).padStart(64, "0"),
      parameters_sha256: null,
    },
    metadata:
      options.metadata ??
      metadata(options.title ?? `Title ${n}`, options.identifiers ?? []),
    version_role: options.role ?? "published",
    version_links: options.links ?? [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}

async function emptyApplication() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-identity-complete-"));
  const app = await createApplication(home);
  return {
    home,
    app,
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

it("uses strict fallback identity and semantically deduplicates user imports", async () => {
  const env = await emptyApplication();
  try {
    const first = observation(1, {
      kind: "user",
      metadata: metadata("  Unicode   Identity  "),
    });
    const created = await env.app.identity.observe(first);
    expect(created).toMatchObject({ disposition: "accepted", created: true });
    if (created.disposition !== "accepted")
      throw new Error("unexpected result");
    const replay = parseMetadataObservation({
      ...first,
      observation_id: id(1_099),
      provenance: {
        ...first.provenance,
        provenance_id: id(2_099),
        observed_at: "2026-09-11T02:00:00Z",
      },
    });
    await expect(env.app.identity.observe(replay)).resolves.toEqual({
      disposition: "accepted",
      literature_id: created.literature_id,
      meta_literature_id: created.meta_literature_id,
      outcome: "matched",
      created: false,
    });
    expect(await env.app.observations.get(replay.observation_id)).toBeNull();
    const provider = observation(2, {
      title: "unicode identity",
      metadata: metadata("unicode identity"),
    });
    await expect(env.app.identity.observe(provider)).resolves.toEqual({
      disposition: "accepted",
      literature_id: created.literature_id,
      meta_literature_id: created.meta_literature_id,
      outcome: "matched",
      created: false,
    });
  } finally {
    await env.close();
  }
});

it("keeps provider record ownership scoped by provider", async () => {
  const env = await emptyApplication();
  try {
    const first = observation(10, {
      provider: "alpha",
      record: "shared",
      identifiers: [{ namespace: "doi", value: "10.1000/provider-owner" }],
    });
    const created = await env.app.identity.observe(first);
    if (created.disposition !== "accepted")
      throw new Error("unexpected result");
    const snapshot = observation(11, {
      provider: "alpha",
      record: "shared",
      metadata: metadata("Sparse provider snapshot", [], {
        authors: [],
        publication_year: null,
        document_type: null,
      }),
    });
    await expect(env.app.identity.observe(snapshot)).resolves.toEqual({
      disposition: "accepted",
      literature_id: created.literature_id,
      meta_literature_id: created.meta_literature_id,
      outcome: "matched",
      created: false,
    });
    const otherProvider = observation(12, {
      provider: "beta",
      record: "shared",
      metadata: metadata("Independent provider snapshot", [], {
        authors: [],
        publication_year: null,
        document_type: null,
      }),
    });
    const independent = await env.app.identity.observe(otherProvider);
    expect(independent).toMatchObject({
      disposition: "accepted",
      created: true,
    });
    if (independent.disposition !== "accepted")
      throw new Error("unexpected result");
    expect(independent.literature_id).not.toBe(created.literature_id);
  } finally {
    await env.close();
  }
});

it("fails closed on stable identity ambiguity without retaining a partial observation", async () => {
  const env = await emptyApplication();
  try {
    const doi = { namespace: "doi", value: "10.1000/ambiguous" };
    for (const n of [20, 21])
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(3_000 + n),
          meta_literature_id: id(4_000 + n),
          metadata: metadata(`Ambiguous ${n}`, [doi]),
        }),
      );
    const incoming = observation(22, { identifiers: [doi] });
    await expect(env.app.identity.observe(incoming)).resolves.toEqual({
      disposition: "rejected",
      reason: "stable-identifier-ambiguity",
    });
    expect(await env.app.observations.get(incoming.observation_id)).toBeNull();
  } finally {
    await env.close();
  }
});

it("atomically merges two existing MetaLiteratures through one explicit provider link", async () => {
  const env = await emptyApplication();
  try {
    const a = observation(30, {
      record: "a",
      role: "preprint",
      identifiers: [{ namespace: "doi", value: "10.1000/version-a" }],
    });
    const b = observation(31, {
      record: "b",
      role: "published",
      identifiers: [{ namespace: "doi", value: "10.1000/version-b" }],
    });
    const acceptedA = await env.app.identity.observe(a);
    const acceptedB = await env.app.identity.observe(b);
    if (
      acceptedA.disposition !== "accepted" ||
      acceptedB.disposition !== "accepted"
    )
      throw new Error("unexpected result");
    const oldMeta = (await env.app.database.getLiterature(
      acceptedA.literature_id,
    ))!.meta_literature_id;
    const targetMeta = (await env.app.database.getLiterature(
      acceptedB.literature_id,
    ))!.meta_literature_id;
    const linking = observation(32, {
      record: "a-next",
      role: "preprint",
      identifiers: [{ namespace: "doi", value: "10.1000/version-a" }],
      links: [
        {
          record_id: "b",
          identifiers: [{ namespace: "doi", value: "10.1000/version-b" }],
        },
      ],
    });
    await expect(env.app.identity.observe(linking)).resolves.toEqual({
      disposition: "accepted",
      literature_id: acceptedA.literature_id,
      meta_literature_id: targetMeta,
      outcome: "matched",
      created: false,
    });
    expect(
      (await env.app.database.getLiterature(acceptedA.literature_id))!
        .meta_literature_id,
    ).toBe(targetMeta);
    const detail = await env.app.library.detail(acceptedB.literature_id);
    expect(detail.meta_literature.representative_literature_id).toBe(
      acceptedB.literature_id,
    );
    expect(
      detail.other_versions.map((item) => item.literature.literature_id),
    ).toEqual([acceptedA.literature_id]);
    const raw = new DatabaseSync(join(env.home, "catalog.sqlite"));
    try {
      expect(
        raw
          .prepare("SELECT 1 FROM meta_literatures WHERE meta_literature_id=?")
          .get(oldMeta),
      ).toBeUndefined();
    } finally {
      raw.close();
    }
  } finally {
    await env.close();
  }
});

it("rolls back the observation and projection when the identity CAS is stale", async () => {
  const env = await emptyApplication();
  try {
    await env.app.database.putLiterature(FIXTURE_LITERATURE);
    const incoming = observation(40, {
      identifiers: [
        { namespace: "doi", value: "10.5555/sciretriever.fixture" },
      ],
    });
    const before = await env.app.database.getLiterature(
      FIXTURE_LITERATURE.literature_id,
    );
    const changed = parseLiterature({
      ...before!,
      metadata: { ...before!.metadata, title: "Must roll back" },
    });
    const metadataSha256 = await sha256(canonicalJsonBytes(changed.metadata));
    await expect(
      env.app.database.publishIdentityObservation({
        literatures: [
          {
            literature: changed,
            metadata_revision: 2,
            metadata_sha256: metadataSha256,
            fallback_identity_sha256: null,
          },
        ],
        meta_literatures: [],
        observation: {
          literature_id: changed.literature_id,
          observation: incoming,
          user_semantic_sha256: null,
        },
        expected_literatures: [
          {
            literature_id: changed.literature_id,
            meta_literature_id: changed.meta_literature_id,
            metadata_revision: 2,
            metadata_sha256: metadataSha256,
          },
        ],
        expected_meta_literatures: [],
        retired_meta_literature_ids: [],
        clear_automatic_pdf_exhaustion_for: [],
      }),
    ).rejects.toThrow();
    expect(await env.app.database.getLiterature(changed.literature_id)).toEqual(
      before,
    );
    expect(await env.app.observations.get(incoming.observation_id)).toBeNull();
  } finally {
    await env.close();
  }
});

it("retains a new observation but preserves current metadata once content is ready", async () => {
  const env = await setup();
  try {
    const initial = await env.app.library.detail(lit);
    const content = await proposal(initial);
    await env.app.literatureContent.accept(content.value, content.bytes);
    const before = await env.app.library.detail(lit);
    const incoming = observation(50, {
      title: "Provider replacement",
      identifiers: [
        { namespace: "doi", value: "10.5555/sciretriever.fixture" },
      ],
    });
    await expect(env.app.identity.observe(incoming)).resolves.toEqual({
      disposition: "accepted",
      literature_id: lit,
      meta_literature_id: FIXTURE_LITERATURE.meta_literature_id,
      outcome: "enriched",
      created: false,
    });
    const after = await env.app.library.detail(lit);
    expect(after.literature.metadata).toEqual(before.literature.metadata);
    expect(after.metadata_revision).toBe(before.metadata_revision);
    expect(
      (await env.app.observations.get(incoming.observation_id))!.literature_id,
    ).toBe(lit);
  } finally {
    await env.close();
  }
});
