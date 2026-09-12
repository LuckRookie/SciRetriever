import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadataObservation } from "@sciretriever/contracts";
import { setup, id, lit } from "./content-fixture.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { createApplication } from "../src/bootstrap/application.js";

function observation(
  n: number,
  input: {
    doi?: string;
    version_role?: "published" | "preprint" | "accepted-manuscript";
    links?: readonly {
      record_id: string | null;
      identifiers: readonly { namespace: string; value: string }[];
    }[];
  } = {},
) {
  return parseMetadataObservation({
    observation_id: id(700 + n),
    provenance: {
      provenance_id: id(800 + n),
      source_kind: "metadata-provider",
      source_name: "fixture-provider",
      source_record_id: `record-${n}`,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: String(n).padStart(64, "0"),
      parameters_sha256: null,
    },
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `Observed title ${n}`,
      identifiers: input.doi ? [{ namespace: "doi", value: input.doi }] : [],
    },
    version_role: input.version_role ?? "published",
    version_links: input.links ?? [],
    asset_hints: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: 0,
    cited_by_count: 0,
  });
}

it("creates, enriches and groups provider observations with explicit version links", async () => {
  const env = await setup();
  try {
    const merged = observation(1, {
      doi: "10.5555/sciretriever.fixture",
    });
    await expect(env.app.identity.observe(merged)).resolves.toEqual({
      disposition: "accepted",
      literature_id: lit,
      meta_literature_id: FIXTURE_LITERATURE.meta_literature_id,
      outcome: "enriched",
      created: false,
    });
    await expect(env.app.identity.observe(merged)).resolves.toEqual({
      disposition: "accepted",
      literature_id: lit,
      meta_literature_id: FIXTURE_LITERATURE.meta_literature_id,
      outcome: "matched",
      created: false,
    });
    expect((await env.app.database.getLiterature(lit))!.metadata.title).toBe(
      "Observed title 1",
    );

    const roleClaim = observation(2, {
      doi: "10.5555/sciretriever.fixture",
      version_role: "preprint",
    });
    await expect(env.app.identity.observe(roleClaim)).resolves.toEqual({
      disposition: "accepted",
      literature_id: lit,
      meta_literature_id: FIXTURE_LITERATURE.meta_literature_id,
      outcome: "matched",
      created: false,
    });
    expect(
      (await env.app.observations.get(roleClaim.observation_id))!.literature_id,
    ).toBe(lit);
    expect((await env.app.database.getLiterature(lit))!.version_role).toBe(
      "published",
    );

    const version = observation(3, {
      doi: "10.5555/sciretriever.preprint",
      version_role: "preprint",
      links: [
        {
          record_id: "record-1",
          identifiers: [
            { namespace: "doi", value: "10.5555/sciretriever.fixture" },
          ],
        },
      ],
    });
    const created = await env.app.identity.observe(version);
    expect(created).toMatchObject({ disposition: "accepted", created: true });
    if (created.disposition !== "accepted")
      throw new Error("unexpected decision");
    const newLiterature = await env.app.database.getLiterature(
      created.literature_id,
    );
    expect(newLiterature?.meta_literature_id).toBe(
      FIXTURE_LITERATURE.meta_literature_id,
    );
    expect(newLiterature?.version_role).toBe("preprint");

    const fallback = observation(4);
    const fallbackCreated = await env.app.identity.observe(fallback);
    expect(fallbackCreated).toMatchObject({
      disposition: "accepted",
      created: true,
    });
    expect(
      await env.app.observations.get(fallback.observation_id),
    ).not.toBeNull();
  } finally {
    await env.close();
  }
});

it("uses the identifier index beyond ten thousand Literatures", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-identity-capacity-"));
  const first = await createApplication(home);
  await first.close();
  const raw = new DatabaseSync(join(home, "catalog.sqlite"));
  const targetIndex = 10_004;
  try {
    raw.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const meta = raw.prepare(
      "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?)",
    );
    const literature = raw.prepare(
      "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?)",
    );
    const metadata = raw.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages) VALUES(?,1,?,?,NULL,NULL,2026,'article','en',NULL,NULL,NULL,NULL,NULL)",
    );
    const identifier = raw.prepare(
      "INSERT INTO literature_metadata_identifiers(literature_id,ordinal,namespace,value) VALUES(?,0,'doi',?)",
    );
    for (let n = 0; n <= targetIndex; n++) {
      const suffix = String(n).padStart(12, "0");
      const literatureId = `30000000-0000-0000-0000-${suffix}`;
      const metaId = `40000000-0000-0000-0000-${suffix}`;
      meta.run(metaId, literatureId);
      literature.run(literatureId, metaId, "published");
      metadata.run(literatureId, "0".repeat(64), `Capacity fixture ${n}`);
      identifier.run(literatureId, `10.7777/capacity.${n}`);
    }
    raw.exec("COMMIT");
  } catch (error) {
    raw.exec("ROLLBACK");
    throw error;
  } finally {
    raw.close();
  }

  const app = await createApplication(home);
  try {
    await expect(
      app.identity.observe(
        observation(90, { doi: `10.7777/capacity.${targetIndex}` }),
      ),
    ).resolves.toEqual({
      disposition: "accepted",
      literature_id: `30000000-0000-0000-0000-${String(targetIndex).padStart(12, "0")}`,
      meta_literature_id: `40000000-0000-0000-0000-${String(targetIndex).padStart(12, "0")}`,
      outcome: "enriched",
      created: false,
    });
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
