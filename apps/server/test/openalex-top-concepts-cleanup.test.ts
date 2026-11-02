import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  canonicalJsonBytes,
  sha256,
  parseMetadataObservation,
  type MetadataObservation,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { cleanupOpenAlexTopConcepts } from "../src/storage/sqlite/openalex-top-concepts-cleanup.js";

function observation(
  record: string,
  terms: string[],
  source = "openalex",
  kind: "metadata-provider" | "user" = "metadata-provider",
): MetadataObservation {
  return parseMetadataObservation({
    observation_id: randomUUID(),
    source_type: null,
    source_type_mapping_version: null,
    provenance: {
      provenance_id: randomUUID(),
      source_kind: kind,
      source_name: source,
      source_record_id: kind === "user" ? null : record,
      observed_at: "2026-11-02T00:00:00Z",
      input_sha256: kind === "user" ? null : "1".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      ...EMPTY_METADATA,
      title: record,
      identifiers: [{ namespace: "doi", value: `10.1000/${record}` }],
      keywords: ["Author phrase"],
      subject_terms: terms,
    },
    version_role: "published",
    version_links: [],
    declared_keywords: ["Author phrase"],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-openalex-cleanup-"));
  const app = await createApplication(home, {
    browserHost: () => null,
    metadata: {},
    indexRefreshIntervalMs: null,
  });
  const observe = async (o: MetadataObservation) => {
    const accepted = await app.identity.observe(o);
    if (accepted.disposition !== "accepted")
      throw new Error("synthetic observation was rejected");
    return accepted.literature_id;
  };
  return {
    home,
    app,
    observe,
    path: join(home, "catalog.sqlite"),
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
const metadataRows = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT literature_id,metadata_revision,metadata_sha256 FROM literature_metadata ORDER BY literature_id",
    )
    .all();
const subjectRows = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT * FROM metadata_observation_subject_terms ORDER BY observation_id,ordinal",
    )
    .all();

it("removes all 19 top classes only from OpenAlex provider observations, repacks ordinals and projects only their literatures idempotently", async () => {
  const e = await fixture();
  try {
    const top = [
      "Art",
      "BIOLOGY",
      "Business",
      "Chemistry",
      "Computer science",
      "Economics",
      "Engineering",
      "Environmental science",
      "Geography",
      "Geology",
      "History",
      "Materials science",
      "Mathematics",
      "Medicine",
      "Philosophy",
      "Physics",
      "Political science",
      "Psychology",
      "Sociology",
    ];
    const mixed = observation("mixed", [
      ...top.slice(0, 3),
      "Quantum optics",
      ...top.slice(3),
      "Art history studies",
    ]);
    const only = observation("only", ["Physics"]);
    const data = observation(
      "datacite",
      ["Chemistry", "Molecular science"],
      "datacite",
    );
    const cross = observation("crossref", ["Biology"], "crossref");
    const granular = observation("granular", ["Spectroscopy"]);
    const user = observation(
      "user",
      ["Physics"],
      "bibliographic-import",
      "user",
    );
    const mixedId = await e.observe(mixed),
      onlyId = await e.observe(only),
      dataId = await e.observe(data);
    for (const o of [cross, granular, user]) await e.observe(o);
    const orphan = observation("orphan", ["Medicine"]);
    await e.app.database.putObservation(orphan);
    await e.app.close();
    const beforeDb = new DatabaseSync(e.path, { readOnly: true });
    const before = metadataRows(beforeDb);
    const originals = subjectRows(beforeDb).filter(
      (r) =>
        ![
          mixed.observation_id,
          only.observation_id,
          orphan.observation_id,
        ].includes(String(r.observation_id)),
    );
    const provenances = beforeDb
      .prepare("SELECT * FROM provenances ORDER BY provenance_id")
      .all();
    const schema = beforeDb.prepare("SELECT * FROM schema_identity").all();
    beforeDb.close();
    const result = await cleanupOpenAlexTopConcepts(e.path);
    expect(result).toMatchObject({
      schema_version: 15,
      deleted_observation_rows: 21,
      affected_observations: 3,
      reprojected_literatures: 2,
      affected_without_subject_terms: 1,
      total_without_subject_terms: 2,
      foreign_key_violations: 0,
      integrity_check: ["ok"],
      library_fts_integrity: "ok",
    });
    const db = new DatabaseSync(e.path, { readOnly: true });
    expect(
      db
        .prepare(
          "SELECT ordinal,term FROM metadata_observation_subject_terms WHERE observation_id=? ORDER BY ordinal",
        )
        .all(mixed.observation_id),
    ).toEqual([
      { ordinal: 0, term: "Quantum optics" },
      { ordinal: 1, term: "Art history studies" },
    ]);
    expect(
      subjectRows(db).filter(
        (r) =>
          ![
            mixed.observation_id,
            only.observation_id,
            orphan.observation_id,
          ].includes(String(r.observation_id)),
      ),
    ).toEqual(originals);
    expect(
      db.prepare("SELECT * FROM provenances ORDER BY provenance_id").all(),
    ).toEqual(provenances);
    expect(db.prepare("SELECT * FROM schema_identity").all()).toEqual(schema);
    expect(
      db
        .prepare(
          "SELECT literature_id FROM literature_search_fts WHERE literature_search_fts MATCH 'Chemistry'",
        )
        .all(),
    ).toEqual([{ literature_id: dataId }]);
    const firstRows = metadataRows(db);
    for (const old of before) {
      const next = firstRows.find(
        (r) => r.literature_id === old.literature_id,
      )!;
      if ([mixedId, onlyId].includes(String(old.literature_id))) {
        expect(next.metadata_revision).toBe(Number(old.metadata_revision) + 1);
        expect(next.metadata_sha256).not.toBe(old.metadata_sha256);
      } else expect(next).toEqual(old);
    }
    db.close();
    const reader = await createQueryApplication(e.home);
    try {
      const detail = await reader.query!.detail(mixedId);
      expect(detail.literature.metadata).toMatchObject({
        title: "mixed",
        keywords: ["Author phrase"],
        subject_terms: ["Quantum optics", "Art history studies"],
      });
      expect(detail.metadata_sha256).toBe(
        await sha256(canonicalJsonBytes(detail.literature.metadata)),
      );
      expect(
        (await reader.query!.detail(dataId)).literature.metadata.subject_terms,
      ).toContain("Chemistry");
      expect(
        (await reader.query!.detail(onlyId)).literature.metadata.subject_terms,
      ).toEqual([]);
    } finally {
      await reader.close();
    }
    const second = await cleanupOpenAlexTopConcepts(e.path);
    expect(second).toMatchObject({
      deleted_observation_rows: 0,
      affected_observations: 0,
      reprojected_literatures: 0,
      affected_without_subject_terms: 0,
      total_without_subject_terms: 2,
    });
    expect(second.before).toEqual(second.after);
    expect(second.source_revision_before).toBe(result.source_revision_after);
    expect(second.source_revision_after).toBe(result.source_revision_after);
    const check = new DatabaseSync(e.path, { readOnly: true });
    expect(metadataRows(check)).toEqual(firstRows);
    check.close();
  } finally {
    await e.close();
  }
});

it("rolls the observation deletion back when reprojection rejects inconsistent identity evidence", async () => {
  const e = await fixture();
  try {
    const o = observation("rollback", ["Chemistry", "Catalysis"]);
    const id = await e.observe(o);
    const conflicting = observation("conflicting", ["Physics"], "datacite");
    await e.app.database.putObservation(conflicting);
    await e.app.close();
    const db = new DatabaseSync(e.path);
    db.prepare("INSERT INTO literature_metadata_observations VALUES(?,?)").run(
      id,
      conflicting.observation_id,
    );
    const before = subjectRows(db),
      metadata = metadataRows(db),
      fts = db
        .prepare("SELECT rowid,* FROM literature_search_fts ORDER BY rowid")
        .all();
    db.close();
    await expect(cleanupOpenAlexTopConcepts(e.path)).rejects.toThrow(
      "stable-identifier-conflict",
    );
    const check = new DatabaseSync(e.path, { readOnly: true });
    expect(subjectRows(check)).toEqual(before);
    expect(metadataRows(check)).toEqual(metadata);
    expect(
      check
        .prepare("SELECT rowid,* FROM literature_search_fts ORDER BY rowid")
        .all(),
    ).toEqual(fts);
    check.close();
  } finally {
    await e.close();
  }
});

it.each(["queued", "tampered"])(
  "refuses %s catalogs without deleting observations",
  async (kind) => {
    const e = await fixture();
    try {
      await e.observe(observation("refused", ["Chemistry"]));
      await e.app.close();
      const db = new DatabaseSync(e.path);
      if (kind === "queued")
        db.exec(
          "INSERT INTO execution_jobs VALUES('queued-job','selector','{}','p','queued','key','2026-11-02T00:00:00Z',NULL)",
        );
      else db.exec("CREATE TABLE unexpected(value TEXT)");
      const before = subjectRows(db);
      db.close();
      await expect(cleanupOpenAlexTopConcepts(e.path)).rejects.toMatchObject({
        code: "openalex-top-concepts-cleanup-refused",
      });
      const check = new DatabaseSync(e.path, { readOnly: true });
      expect(subjectRows(check)).toEqual(before);
      check.close();
    } finally {
      await e.close();
    }
  },
);
