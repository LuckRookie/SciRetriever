import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  parseLiteratureId,
  parseLiterature,
  parseMetadataObservation,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import {
  findPossibleDuplicates,
  PossibleDuplicateService,
  type PossibleDuplicatePaper,
} from "../src/literature/possible-duplicates.js";
import {
  SCHEMA_FINGERPRINT_V16,
  SCHEMA_MANIFEST_V16,
} from "../src/storage/sqlite/schema.js";
import { createApplication } from "../src/bootstrap/application.js";

const id = (n: number) =>
  parseLiteratureId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const author = (name = "Jane Doe", family: string | null = "Doe") => ({
  kind: "person" as const,
  display_name: name,
  given_name: null,
  family_name: family,
  orcid: null,
  affiliations: [],
});
const metadata = (
  change: Partial<LiteratureMetadata> = {},
): LiteratureMetadata => ({
  ...EMPTY_METADATA,
  title: "Solid electrolytes and their molecular structure",
  authors: [author()],
  publication_year: 2020,
  ...change,
});
const paper = (
  n = 1,
  change: Partial<LiteratureMetadata> = {},
): PossibleDuplicatePaper => ({
  literature_id: id(n),
  title: metadata(change).title,
  authors: metadata(change).authors,
  publication_year: metadata(change).publication_year,
  publication_form: metadata(change).publication_form,
});
const observation = (m: LiteratureMetadata) =>
  parseMetadataObservation({
    observation_id: randomUUID(),
    metadata: m,
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "user",
      source_name: "bibliographic-import",
      source_record_id: null,
      observed_at: "2026-11-16T00:00:00Z",
      input_sha256: null,
      parameters_sha256: null,
    },
    source_type: null,
    source_type_mapping_version: null,
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });

it("finds the possible-duplicate decisions, audit and retention fields in frozen schema 16", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of SCHEMA_MANIFEST_V16) db.exec(sql);
    expect(SCHEMA_FINGERPRINT_V16).toBe(
      "8545637a22c2341066427f71195eec5465e4c906f3dabd2c2cbad2a4c512f0f8",
    );
    expect(
      db
        .prepare("PRAGMA table_info(intake_items)")
        .all()
        .map((row) => row.name),
    ).toEqual(
      expect.arrayContaining([
        "item_id",
        "batch_id",
        "sequence",
        "record_index",
        "recognition_json",
        "possible_duplicates_json",
        "needs_decision",
        "decision_json",
        "decided_by",
        "decided_at",
        "disposition",
        "literature_id",
        "retain_until",
      ]),
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('intake_items_batch','intake_items_retention')",
        )
        .all(),
    ).toHaveLength(2);
    expect(db.prepare("PRAGMA foreign_key_list(intake_items)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "intake_batches",
          from: "batch_id",
          on_delete: "CASCADE",
        }),
        expect.objectContaining({
          table: "literatures",
          from: "literature_id",
          on_delete: "SET NULL",
        }),
        expect.objectContaining({
          table: "execution_candidates",
          from: "candidate_transfer_id",
          on_delete: "RESTRICT",
        }),
      ]),
    );
    for (const table of ["intake_items", "import_record_results"])
      expect(
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table)!.sql,
      ).toContain("'pending-decision'");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

it("normalizes title case, punctuation and author name ordering, and accepts a one-year difference", () => {
  const matches = findPossibleDuplicates(
    metadata({ authors: [author("Doe, Jane", null)] }),
    [
      paper(2, {
        title: "ＳＯＬＩＤ electrolytes, and their molecular structure!",
        authors: [author("Jane Doe", null)],
        publication_year: 2021,
      }),
    ],
  );
  expect(matches).toMatchObject([{ literature_id: id(2), similarity: 1 }]);
  expect(
    findPossibleDuplicates(metadata({ publication_year: null, authors: [] }), [
      paper(),
    ]),
  ).toHaveLength(1);
});

it("keeps different Introduction papers separate and excludes identified inputs and strict fallback matches", () => {
  expect(
    findPossibleDuplicates(
      metadata({
        title: "Introduction",
        authors: [author("A Alpha", "Alpha")],
        publication_year: 2001,
      }),
      [
        paper(2, {
          title: "Introduction",
          authors: [author("B Beta", "Beta")],
          publication_year: 2019,
        }),
      ],
    ),
  ).toEqual([]);
  expect(
    findPossibleDuplicates(
      metadata({
        identifiers: [{ namespace: "doi", value: "10.5555/identified" }],
      }),
      [paper()],
    ),
  ).toEqual([]);
  const strict = metadata({ publication_form: "journal-article" });
  expect(findPossibleDuplicates(strict, [paper(1, strict)])).toEqual([]);
  expect(
    findPossibleDuplicates(metadata(), [paper(1, { publication_year: 2022 })]),
  ).toEqual([]);
});

it("returns at most three candidates ordered by similarity and then literature ID", () => {
  const matches = findPossibleDuplicates(metadata(), [
    paper(4),
    paper(2),
    paper(3),
    paper(1),
  ]);
  expect(matches.map((p) => p.literature_id)).toEqual([id(1), id(2), id(3)]);
});

it("uses only identity preview and a read-only snapshot, excluding withdrawn literature", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-possible-duplicates-"),
  );
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  try {
    for (const n of [1, 2])
      await app.database.putLiterature(
        parseLiterature({
          literature_id: id(n),
          meta_literature_id: id(n + 100),
          version_role: "other",
          status: "UNREVIEWED",
          metadata: metadata({
            title: `Solid electrolytes and their molecular structures`,
            publication_form: "journal-article",
            publication_year: n === 1 ? 2020 : 2021,
          }),
        }),
      );
    const batch = await app.importSessions.create(
      { format: "records", source: null, scope: "Synthetic" },
      { kind: "local", origin: "cli" },
    );
    const db = new DatabaseSync(join(home, "catalog.sqlite"));
    try {
      db.prepare(
        "INSERT INTO intake_withdrawn_objects VALUES('literature',?,?,?)",
      ).run(id(2), batch.batch_id, "2026-11-16T00:00:00Z");
    } finally {
      db.close();
    }
    const preview = vi.spyOn(app.identity, "preview");
    const publish = vi.spyOn(app.identity, "observe");
    const read = vi.fn(() =>
      app.importSessions.fileItems.read<PossibleDuplicatePaper[]>({
        kind: "duplicate-candidates",
      }),
    );
    const service = new PossibleDuplicateService(read, app.identity);
    const snapshot = () => {
      const db = new DatabaseSync(join(home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        return [
          "literatures",
          "metadata_observations",
          "literature_metadata",
          "library_state_revision",
        ].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      } finally {
        db.close();
      }
    };
    const before = snapshot();
    expect(
      (await service.find(observation(metadata()), false)).map(
        (p) => p.literature_id,
      ),
    ).toEqual([id(1)]);
    expect(preview).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(await service.find(observation(metadata()), true)).toEqual([]);
    expect(
      await service.find(
        observation(
          metadata({
            identifiers: [{ namespace: "doi", value: "10.5555/known" }],
          }),
        ),
        false,
      ),
    ).toEqual([]);
    expect(preview).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(
      await service.find(
        observation(
          metadata({
            title: "Solid electrolytes and their molecular structures",
            publication_form: "journal-article",
          }),
        ),
        false,
      ),
    ).toEqual([]);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(await preview.mock.results.at(-1)!.value).toMatchObject({
      disposition: "matched",
      literature_id: id(1),
    });
    expect(read).toHaveBeenCalledOnce();
    expect(snapshot()).toEqual(before);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("reports false positives and false negatives against a labelled synthetic catalog without tuning the specified rules", async () => {
  const samples: {
    expected: boolean;
    incoming: LiteratureMetadata;
    existing: PossibleDuplicatePaper;
  }[] = [];
  for (let n = 0; n < 20; n++) {
    const title = `Synthetic molecular transport study number ${n}`;
    const duplicateAuthor = author(
      `Jane DuplicateFamily${n}`,
      `DuplicateFamily${n}`,
    );
    samples.push({
      expected: true,
      incoming: metadata({ title: title + "s", authors: [duplicateAuthor] }),
      existing: paper(n + 1, {
        title,
        authors: [duplicateAuthor],
        publication_year: n % 2 ? 2019 : 2021,
      }),
    });
    samples.push({
      expected: false,
      incoming: metadata({
        title,
        authors: [author(`Jane NegativeFamily${n}`, `NegativeFamily${n}`)],
      }),
      existing: paper(n + 101, {
        title,
        authors: [author(`Jane OtherFamily${n}`, `OtherFamily${n}`)],
      }),
    });
  }
  samples.push({
    expected: false,
    incoming: metadata({
      title: "Introduction",
      publication_form: "journal-article",
      authors: [author("Jane Doe")],
    }),
    existing: paper(300, {
      title: "Introduction",
      publication_form: "book-or-chapter",
      authors: [author("John Doe")],
    }),
  });
  samples.push({
    expected: true,
    incoming: metadata({ authors: [author("Jane Chang", "Chang")] }),
    existing: paper(301, { authors: [author("Jane Zhang", "Zhang")] }),
  });
  const home = await mkdtemp(join(tmpdir(), "sciretriever-duplicate-corpus-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  try {
    for (const sample of samples) {
      const { literature_id, ...fields } = sample.existing;
      await app.database.putLiterature(
        parseLiterature({
          literature_id,
          meta_literature_id: randomUUID(),
          version_role: "other",
          status: "UNREVIEWED",
          metadata: { ...EMPTY_METADATA, ...fields },
        }),
      );
    }
    const service = new PossibleDuplicateService(
      () =>
        app.importSessions.fileItems.read<PossibleDuplicatePaper[]>({
          kind: "duplicate-candidates",
        }),
      app.identity,
    );
    const started = performance.now();
    const counts = { tp: 0, tn: 0, fp: 0, fn: 0 };
    for (const sample of samples) {
      const found =
        (await service.find(observation(sample.incoming), false)).length > 0;
      counts[sample.expected ? (found ? "tp" : "fn") : found ? "fp" : "tn"]++;
    }
    expect(counts).toEqual({ tp: 20, tn: 20, fp: 1, fn: 1 });
    console.log(
      "possible-duplicate-corpus",
      JSON.stringify({
        catalog_literatures: samples.length,
        samples: samples.length,
        ...counts,
        elapsed_ms: performance.now() - started,
      }),
    );
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
