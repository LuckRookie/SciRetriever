import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import {
  parseFolderNode,
  parseLiterature,
  parseMetadataObservation,
  parseProvenance,
  parseReference,
  sha256,
  type IntakeReport,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { withActivity } from "../src/logging/activity.js";
import { createTaskOperations } from "../src/entry/task-operations.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { rawParserFixture } from "./raw-parser-fixture.js";

// Schema-capability drill only. These SQL projections and manual transactions
// intentionally do not claim that production withdrawal routes/read filters exist.
type Kind =
  | "literature"
  | "literature-asset"
  | "folder"
  | "folder-member"
  | "mark";
const memberId = (folder: string, literature: string) =>
  JSON.stringify([folder, literature]);
const absent = (kind: Kind, key: string) =>
  `NOT EXISTS(SELECT 1 FROM intake_withdrawn_objects w WHERE w.object_kind='${kind}' AND w.object_id=${key})`;
const visible = `WITH visible AS (SELECT l.* FROM literatures l WHERE ${absent("literature", "l.literature_id")})`;

function record(key: string, identified = true) {
  return {
    external_id: key,
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `WithdrawalDrill ${key}`,
      authors: [
        {
          kind: "person",
          display_name: "Drill Author",
          given_name: "Drill",
          family_name: "Author",
          orcid: null,
          affiliations: [],
        },
      ],
      identifiers: identified
        ? [{ namespace: "doi", value: `10.5555/withdrawal-drill-${key}` }]
        : [],
    },
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-withdrawal-drill-"));
  let now = Date.now() - 3_600_000;
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [] },
    importSessions: { maintain: false, now: () => now },
    parsing: {
      rawParser: rawParserFixture({
        async parse(request) {
          const bytes = Buffer.from("# WithdrawalDrill\n\nOffline parser.\n");
          return {
            source_asset_id: request.source_asset_id,
            source_sha256: request.source_sha256,
            page_count: 1,
            markdown: {
              bytes,
              artifact: {
                sha256: await sha256(bytes),
                byte_size: bytes.length,
                media_type: "text/markdown",
              },
            },
            resources: [],
            provenance: {
              parser_version: "withdrawal-drill",
              mode: null,
              model_identity: null,
              provenance: parseProvenance({
                provenance_id: randomUUID(),
                source_kind: "parser",
                source_name: "withdrawal-drill",
                source_record_id: null,
                observed_at: new Date(now).toISOString(),
                input_sha256: request.source_sha256,
                parameters_sha256: "1".repeat(64),
              }),
            },
          };
        },
      }),
    },
  });
  const db = new DatabaseSync(join(home, "catalog.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const rows = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).all(...args);
  const ids = (sql: string, ...args: SQLInputValue[]) =>
    rows(sql, ...args)
      .map((r) => String(r.id))
      .sort();
  const transaction = (work: () => void) =>
    app.writes.run(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        work();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  const batch = async (records: unknown[], library = randomUUID()) => {
    now += 1000;
    const b = await app.importSessions.create(
      {
        format: "records",
        source: {
          system: "synthetic",
          library_id: library,
          identity: "global",
          name: "WithdrawalDrill",
        },
        scope: "Withdrawal and restoration drill",
      },
      { kind: "local", origin: "cli" },
    );
    await app.importSessions.putData(b.batch_id, 0, { records });
    await app.importSessions.confirm(b.batch_id);
    const report = await app.importSessions.report(b.batch_id);
    expect(report.batch.state).toBe("finished");
    expect(report.items.every((i) => i.literature_id !== null)).toBe(true);
    return { id: b.batch_id, report, library };
  };
  // This historical schema drill constructs its own synthetic ownership. The
  // supplement used to create PDF bytes now registers its real batch too; assign
  // that freshly created relation to this drill's synthetic import explicitly.
  // The production transaction/ownership path is tested in intake-withdrawal.
  const own = (batch: string, kind: Exclude<Kind, "literature">, id: string) =>
    transaction(() => {
      db.prepare(
        "INSERT INTO intake_batch_objects VALUES(?,?,?) ON CONFLICT(object_kind,object_id) DO UPDATE SET batch_id=excluded.batch_id",
      ).run(kind, id, batch);
      expect(
        db
          .prepare(
            "SELECT batch_id FROM intake_batch_objects WHERE object_kind=? AND object_id=?",
          )
          .get(kind, id)?.batch_id,
      ).toBe(batch);
    });
  return {
    app,
    db,
    rows,
    ids,
    batch,
    own,
    transaction,
    at: () => new Date(++now).toISOString(),
    settleClock: () => {
      now = Date.now() + 2000;
    },
    async close() {
      db.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

type Drill = Awaited<ReturnType<typeof fixture>>;
function reasons(f: Drill, batch: string) {
  const sql = `
    WITH members AS (
      SELECT m.*,l.meta_literature_id FROM intake_batch_members m
      JOIN literatures l USING(literature_id) WHERE m.batch_id=?
    ), owner AS (SELECT * FROM intake_batch_objects WHERE batch_id=?)
    SELECT literature_id,'pre-existing' AS reason FROM members WHERE disposition<>'created'
    UNION SELECT m.literature_id,'hit-by-later-batch' FROM members m
      JOIN intake_batch_members next USING(literature_id)
      JOIN intake_batches b ON b.batch_id=next.batch_id
      WHERE b.created_at>(SELECT created_at FROM intake_batches WHERE batch_id=?)
    UNION SELECT m.literature_id,'folder-changed' FROM members m JOIN folder_members fm USING(literature_id)
      WHERE NOT EXISTS(SELECT 1 FROM owner o WHERE o.object_kind='folder-member' AND o.object_id=json_array(fm.folder_id,fm.literature_id))
    UNION SELECT m.literature_id,'annotated' FROM members m JOIN reading_marks r USING(literature_id)
      WHERE NOT EXISTS(SELECT 1 FROM owner o WHERE o.object_kind='mark' AND o.object_id=r.mark_id)
    UNION SELECT m.literature_id,'opened' FROM members m JOIN reading_history h USING(literature_id)
    UNION SELECT m.literature_id,'processed' FROM members m WHERE
      EXISTS(SELECT 1 FROM literature_assets a JOIN raw_parses p ON p.source_asset_id=a.asset_id WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM archive_runs a WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM archive_steps a WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM literature_assets a JOIN proofread_versions p ON p.part_asset_id=a.asset_id WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM literature_tag_assignments a WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM processor_result_literatures p WHERE p.literature_id=m.literature_id)
    UNION SELECT m.literature_id,'metadata-edited' FROM members m JOIN literature_metadata_field_states s USING(literature_id)
      WHERE s.locked=1 OR (s.source='manual' AND json_extract(s.evidence_json,'$.provenance.source_name')='manual-metadata')
    UNION SELECT m.literature_id,'identity-merged' FROM members m WHERE
      EXISTS(SELECT 1 FROM import_record_results r WHERE r.batch_id=? AND r.literature_id=m.literature_id AND r.meta_literature_id<>m.meta_literature_id)
      OR EXISTS(SELECT 1 FROM intake_items i WHERE json_extract(i.decision_json,'$.kind')='merge'
        AND json_extract(i.decision_json,'$.literature_id')=m.literature_id
        AND i.decided_at>(SELECT finished_at FROM intake_batches WHERE batch_id=?))
    ORDER BY literature_id,reason`;
  const found = new Map<string, string[]>();
  for (const row of f.rows(sql, batch, batch, batch, batch, batch)) {
    const id = String(row.literature_id);
    found.set(id, [...(found.get(id) ?? []), String(row.reason)]);
  }
  return found;
}

function removedObjects(f: Drill, batch: string) {
  const kept = reasons(f, batch);
  const removed = f
    .ids(
      "SELECT literature_id AS id FROM intake_batch_members WHERE batch_id=? AND disposition='created'",
      batch,
    )
    .filter((id) => !kept.has(id));
  const doomed = new Set(removed);
  const objects: { kind: Kind; id: string }[] = removed.map((id) => ({
    kind: "literature",
    id,
  }));
  for (const o of f.rows(
    "SELECT * FROM intake_batch_objects WHERE batch_id=? ORDER BY object_kind,object_id",
    batch,
  )) {
    const kind = String(o.object_kind) as Exclude<Kind, "literature">,
      id = String(o.object_id);
    const target =
      kind === "literature-asset"
        ? f.db
            .prepare(
              "SELECT literature_id FROM literature_assets WHERE literature_asset_id=?",
            )
            .get(id)?.literature_id
        : kind === "mark"
          ? f.db
              .prepare(
                "SELECT literature_id FROM reading_marks WHERE mark_id=?",
              )
              .get(id)?.literature_id
          : kind === "folder-member"
            ? (JSON.parse(id) as [string, string])[1]
            : null;
    if (target && doomed.has(String(target))) objects.push({ kind, id });
  }
  // Check descendants too: a visible child must not become an orphan in the tree.
  for (const o of f.rows(
    "SELECT object_id FROM intake_batch_objects WHERE batch_id=? AND object_kind='folder'",
    batch,
  )) {
    const id = String(o.object_id);
    const folders = f.rows(
      `WITH RECURSIVE sub AS (SELECT * FROM folders WHERE folder_id=? UNION ALL SELECT x.* FROM folders x JOIN sub ON x.parent_id=sub.folder_id) SELECT * FROM sub`,
      id,
    );
    if (
      folders.every(
        (x) =>
          x.created_at === x.updated_at &&
          f.rows(
            "SELECT 1 FROM intake_batch_objects WHERE batch_id=? AND object_kind='folder' AND object_id=?",
            batch,
            String(x.folder_id),
          ).length === 1 &&
          f
            .ids(
              "SELECT literature_id AS id FROM folder_members WHERE folder_id=?",
              String(x.folder_id),
            )
            .every((lit) => doomed.has(lit)),
      )
    )
      objects.push({ kind: "folder", id });
  }
  return { kept, removed, objects };
}

function objectRows(f: Drill) {
  // All facts that must survive withdrawal, including observation children and files.
  const tables = f
    .rows("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => String(r.name))
    .filter((name) =>
      /^(?:literatures$|meta_literatures$|literature_metadata(?:_|$)|metadata_observation|user_observation|provenances$|assets$|artifact_objects$|literature_assets$|literature_references$|literature_intake$|provider_relation_|discovery_|topic_discovery_|citation_discovery_|literature_fallback|external_object_mappings$|folders$|folder_members$|reading_marks$|reading_history$|raw_parse|proofread_|document_|archive_|literature_tag|processor_result|execution_jobs$|execution_targets$|intake_batch_objects$)/u.test(
        name,
      ),
    );
  return Object.fromEntries(
    tables.map((name) => [
      name,
      f
        .rows(`SELECT * FROM "${name}"`)
        .map((r) => JSON.stringify(r))
        .sort(),
    ]),
  );
}

function objectCounts(objects: readonly { kind: Kind }[]) {
  const count = (kind: Kind) => objects.filter((o) => o.kind === kind).length;
  return {
    literatures: count("literature"),
    file_relations: count("literature-asset"),
    folders: count("folder"),
    folder_members: count("folder-member"),
    marks: count("mark"),
  };
}

function projections(f: ScopedDrill) {
  return {
    library: f.ids(`${visible} SELECT literature_id AS id FROM visible`),
    counts: Number(
      f.rows(
        `${visible} SELECT count(DISTINCT meta_literature_id) AS n FROM visible`,
      )[0]!.n,
    ),
    terms: f.rows(
      `${visible} SELECT m.title,count(*) AS n FROM visible v JOIN literature_metadata m USING(literature_id) GROUP BY m.title ORDER BY m.title`,
    ),
    fts: f.ids(
      `${visible} SELECT literature_search_fts.literature_id AS id FROM literature_search_fts JOIN visible v ON v.literature_id=literature_search_fts.literature_id WHERE literature_search_fts MATCH 'WithdrawalDrill'`,
    ),
    context: f.ids(
      `${visible} SELECT DISTINCT e.literature_id AS id FROM retrieval_entries e JOIN retrieval_active_generation a USING(generation_id) JOIN retrieval_fts ft ON ft.rowid=e.entry_id JOIN visible v ON v.literature_id=e.literature_id WHERE retrieval_fts MATCH 'WithdrawalDrill'`,
    ),
    references: f.ids(
      `${visible} SELECT r.reference_id AS id FROM literature_references r JOIN visible source ON source.literature_id=r.source_literature_id JOIN visible target ON target.literature_id=r.target_literature_id`,
    ),
    tasks: f.ids(
      `${visible} SELECT m.literature_id AS id FROM intake_batch_members m JOIN visible v USING(literature_id) WHERE m.batch_id=?`,
      f.batchId,
    ),
    discovery: f.ids(
      `${visible} SELECT c.actual_literature_id AS id FROM topic_discovery_causes c JOIN visible v ON v.literature_id=c.actual_literature_id`,
    ),
    storedTargets: f.ids(
      `${visible} SELECT DISTINCT t.literature_id AS id FROM execution_targets t JOIN visible v USING(literature_id)`,
    ),
    folders: f.ids(
      `SELECT folder_id AS id FROM folders f WHERE ${absent("folder", "f.folder_id")}`,
    ),
    members: f.ids(
      `${visible} SELECT json_array(m.folder_id,m.literature_id) AS id FROM folder_members m JOIN visible v USING(literature_id) WHERE ${absent("folder", "m.folder_id")} AND ${absent("folder-member", "json_array(m.folder_id,m.literature_id)")}`,
    ),
    marks: f.ids(
      `${visible} SELECT r.mark_id AS id FROM reading_marks r JOIN visible v USING(literature_id) WHERE r.deleted_at IS NULL AND ${absent("mark", "r.mark_id")}`,
    ),
    representatives: f.ids(
      `${visible} SELECT v.literature_id AS id FROM visible v WHERE v.literature_id=(SELECT x.literature_id FROM visible x WHERE x.meta_literature_id=v.meta_literature_id ORDER BY CASE x.version_role WHEN 'published' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE 3 END,x.literature_id LIMIT 1)`,
    ),
  };
}

// Read projections get their scope explicitly; no new application service is added.
type ScopedDrill = Drill & { batchId: string };

it.each(["finished", "cancelled"] as const)(
  "drills %s batch withdrawal, identity-preserving re-entry and exact restoration on the current catalog",
  async (priorState) =>
    withActivity({ actor: "web:withdrawal-drill" }, async () => {
      const base = await fixture();
      const f: ScopedDrill = Object.assign(base, { batchId: "" });
      try {
        const layout = f.rows(
          "SELECT type,name,sql FROM sqlite_master ORDER BY type,name",
        );
        const prior = await f.batch([
          record("old-a"),
          record("old-b"),
          record("old-version"),
        ]);
        const clean = [
          record("clean-pdf"),
          record("clean-fallback", false),
          record("clean-plain"),
        ];
        const touched = [
          "later",
          "folder",
          "annotated",
          "opened",
          "processed",
          "edited",
          "merged",
        ].map((key) => record(key));
        const input = [...clean, ...touched, record("old-a"), record("old-b")];
        const main = await f.batch(input);
        f.batchId = main.id;
        const byKey = new Map(
          main.report.items.map((r) => [r.external_id, r.literature_id!]),
        );
        const id = (key: string) => byKey.get(key)!;
        const preexisting = prior.report.items.map((r) => r.literature_id!);
        const expectedClean = clean.map((r) => id(r.external_id)).sort();
        expect(
          main.report.items.filter((r) => r.disposition === "created"),
        ).toHaveLength(10);
        expect(
          main.report.items.filter((r) =>
            ["matched", "enriched"].includes(r.disposition),
          ),
        ).toHaveLength(2);
        const folder = async (name: string, parent: string | null = null) => {
          const result = parseFolderNode(
            await f.app.folders.manage({
              operation: "create",
              request: { name, parent_id: parent },
            }),
          );
          await f.own(main.id, "folder", result.folder_id);
          return result.folder_id;
        };
        const add = async (folder: string, lit: string, owned = true) => {
          await f.app.folders.manage({
            operation: "add",
            request: { folder_id: folder, literature_ids: [lit] },
          });
          if (owned)
            await f.own(main.id, "folder-member", memberId(folder, lit));
        };
        const root = await folder("Imported source"),
          child = await folder("Clean group", root),
          mixed = await folder("Mixed group");
        for (const lit of expectedClean) await add(child, lit);
        for (const r of input)
          if (!expectedClean.includes(id(r.external_id)))
            await add(mixed, id(r.external_id));
        await add(mixed, id("clean-pdf"));
        const renamed = await folder("Original name"),
          moved = await folder("Will move");
        await add(renamed, id("clean-plain"));
        await add(moved, id("clean-plain"));
        // Existing storage entry supports an explicit clock, making edit timestamps deterministic.
        for (const [, operation, request] of [
          [renamed, "rename", { folder_id: renamed, name: "User renamed" }],
          [moved, "move", { folder_id: moved, parent_id: mixed, position: 0 }],
        ] as const)
          await f.app.database.folders({
            operation,
            request,
            actor: "web:withdrawal-drill",
            now: new Date(Date.now() + 1000).toISOString(),
          });
        const pdf = workbenchPdf(),
          digest = await sha256(pdf);
        for (const key of [
          "clean-pdf",
          ...touched.map((r) => r.external_id),
          "old-a",
        ]) {
          const bytes =
            key === "processed" ? Buffer.concat([pdf, Buffer.from(" ")]) : pdf;
          await f.app.maintenance!.ingestPdf({ literature_id: id(key), bytes });
          const asset = f.rows(
            "SELECT literature_asset_id AS id FROM literature_assets WHERE literature_id=?",
            id(key),
          )[0]!;
          await f.own(main.id, "literature-asset", String(asset.id));
          const mark = await f.app.marks.manage({
            operation: "create",
            request: {
              literature_id: id(key),
              kind: "highlight",
              color: "yellow",
              quote: "Synthetic imported quote",
              pdf: {
                sha256: await sha256(bytes),
                page: 1,
                rects: [[10, 10, 30, 4]],
              },
            },
          });
          await f.own(main.id, "mark", mark.mark_id);
        }
        const outside = parseFolderNode(
          await f.app.folders.manage({
            operation: "create",
            request: { name: "User folder" },
          }),
        );
        await add(outside.folder_id, id("folder"), false);
        await f.app.marks.manage({
          operation: "create",
          request: {
            literature_id: id("annotated"),
            kind: "highlight",
            color: "blue",
            quote: "Later user quote",
            pdf: { sha256: digest, page: 1, rects: [[10, 20, 30, 4]] },
          },
        });
        await f.app.folders.opened({ literature_id: id("opened") });
        const processed = (await f.app.database.currentFacts(id("processed")))!
          .primary_asset!;
        await f.app.documentProcessing.parseDocuments({
          literature_id: id("processed"),
          asset_id: processed.asset_id,
          asset_sha256: processed.sha256,
          profiles: ["pipeline"],
          force: false,
        });
        const editing = await f.app.metadataFields.read(id("edited"));
        await f.app.metadataFields.edit({
          literature_id: id("edited"),
          expected_revision: editing.metadata_revision,
          set: [{ field: "title", value: "WithdrawalDrill user title" }],
          unlock: [],
        });
        await f.app.folders.opened({ literature_id: id("edited") });
        await f.batch([record("later")]);
        const oldVersion = preexisting[2]!;
        const merging = (await f.app.database.getLiterature(id("merged")))!;
        await f.app.database.putLiterature(
          parseLiterature({ ...merging, version_role: "preprint" }),
        );
        const linked = await f.app.identity.observe(
          parseMetadataObservation({
            observation_id: randomUUID(),
            source_type: null,
            source_type_mapping_version: null,
            provenance: {
              provenance_id: randomUUID(),
              source_kind: "metadata-provider",
              source_name: "withdrawal-drill",
              source_record_id: "merge-link",
              observed_at: f.at(),
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: record("merged").metadata,
            version_role: "preprint",
            version_links: [
              {
                record_id: null,
                identifiers: record("old-version").metadata.identifiers,
              },
            ],
            asset_hints: [],
            declared_keywords: [],
            reference_texts: [],
            reference_count: null,
            cited_by_count: null,
          }),
        );
        expect(linked).toMatchObject({
          disposition: "accepted",
          literature_id: id("merged"),
        });
        expect(
          (await f.app.database.getLiterature(id("merged")))!
            .meta_literature_id,
        ).toBe(
          (await f.app.database.getLiterature(oldVersion))!.meta_literature_id,
        );
        // Also show that the future merge decision uses the existing JSON columns.
        await f.transaction(() => {
          f.db
            .prepare(
              "UPDATE intake_items SET decision_json=?,decided_at=?,decided_by='web' WHERE batch_id=? AND external_id='old-b'",
            )
            .run(
              JSON.stringify({ kind: "merge", literature_id: id("merged") }),
              f.at(),
              main.id,
            );
          if (priorState === "cancelled")
            f.db
              .prepare(
                "UPDATE intake_batches SET state='cancelled',result=NULL WHERE batch_id=?",
              )
              .run(main.id);
        });
        const expectedReasons = new Map<string, string[]>([
          [id("old-a"), ["pre-existing"]],
          [id("old-b"), ["pre-existing"]],
          ...touched.map(
            (r) =>
              [
                id(r.external_id),
                [
                  {
                    later: "hit-by-later-batch",
                    folder: "folder-changed",
                    annotated: "annotated",
                    opened: "opened",
                    processed: "processed",
                    edited: "metadata-edited",
                    merged: "identity-merged",
                  }[r.external_id]!,
                ],
              ] as [string, string[]],
          ),
        ]);
        expectedReasons.set(id("edited"), ["metadata-edited", "opened"]);
        // Imported fields share the manual source class; provenance distinguishes
        // them from a later human edit. Locks remain independently protective.
        expect(reasons(f, main.id)).toEqual(expectedReasons);
        const plan = removedObjects(f, main.id);
        expect(plan.removed).toEqual(expectedClean);
        expect(
          plan.objects
            .filter((o) => o.kind === "folder")
            .map((o) => o.id)
            .sort(),
        ).toEqual([root, child].sort());
        expect(
          plan.objects.filter((o) => o.kind === "literature-asset"),
        ).toHaveLength(1);
        expect(plan.objects.filter((o) => o.kind === "mark")).toHaveLength(1);
        expect(
          plan.objects.filter((o) => o.kind === "folder-member"),
        ).toHaveLength(6);
        // Three references exercise both endpoints independently.
        for (const [source, target] of [
          [id("clean-pdf"), id("old-a")],
          [id("old-a"), id("clean-pdf")],
          [id("old-a"), id("old-b")],
        ])
          await f.app.database.putReference(
            parseReference({
              reference_id: randomUUID(),
              source_literature_id: source!,
              target_literature_id: target!,
            }),
          );
        await f.transaction(() => {
          const run = randomUUID();
          f.db
            .prepare(
              "INSERT INTO discovery_runs VALUES(?,'topic','COMPLETED',?)",
            )
            .run(run, f.at());
          f.db
            .prepare(
              "INSERT INTO topic_discovery_inputs VALUES(?,'topic','WithdrawalDrill',NULL,NULL)",
            )
            .run(run);
          for (const literature of [id("clean-pdf"), id("old-a")]) {
            const meta = f.rows(
              "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
              literature,
            )[0]!.meta_literature_id!;
            const observation = f.rows(
              "SELECT observation_id FROM literature_metadata_observations WHERE literature_id=? ORDER BY observation_id LIMIT 1",
              literature,
            )[0]!.observation_id!;
            f.db
              .prepare("INSERT INTO discovery_results VALUES(?,?)")
              .run(run, meta);
            f.db
              .prepare("INSERT INTO topic_discovery_causes VALUES(?,?,?,?)")
              .run(run, meta, observation, literature);
          }
        });
        const tasks = createTaskOperations(f.app)!;
        const queued = await tasks.create({
          kind: "acquire-pdf",
          idempotency_key: `withdrawal-drill-${priorState}`,
          selector: {
            kind: "literatures",
            literature_ids: [...byKey.values()],
          },
        });
        const busy = () =>
          Number(
            f.rows(
              "SELECT count(*) AS n FROM execution_targets t JOIN execution_jobs j USING(job_id) JOIN intake_batch_members m USING(literature_id) WHERE m.batch_id=? AND j.status IN ('queued','running')",
              main.id,
            )[0]!.n,
          );
        expect(busy()).toBe(12);
        await tasks.control(queued.job_id, "cancel");
        expect(busy()).toBe(0);
        await f.app.maintenance!.rebuildIndex();
        const before = objectRows(f),
          beforeProjection = projections(f);
        const artifacts = f.rows(
          "SELECT relative_path,byte_size FROM artifact_objects ORDER BY relative_path",
        );
        const bytesBefore = await Promise.all(
          artifacts.map((a) =>
            f.app.files.read(String(a.relative_path), Number(a.byte_size)),
          ),
        );
        const searchRows = () =>
          f.rows("SELECT rowid,* FROM literature_search_fts ORDER BY rowid");
        const fts = searchRows();
        const retrievalWatermark = () => {
          const { revision, position } = f.rows(
            "SELECT revision,COALESCE((SELECT max(position) FROM retrieval_changes),0) AS position FROM retrieval_source_revision WHERE singleton=1",
          )[0]!;
          return { revision: Number(revision), position: Number(position) };
        };
        const expectRetrievalChanges = (
          before: ReturnType<typeof retrievalWatermark>,
          literatures: readonly string[],
        ) => {
          // The watermark signals staleness; the journal names the affected papers.
          expect(retrievalWatermark().revision).toBeGreaterThan(
            before.revision,
          );
          expect(
            f.ids(
              "SELECT DISTINCT literature_id AS id FROM retrieval_changes WHERE position>?",
              before.position,
            ),
          ).toEqual([...literatures].sort());
        };
        const beforeWithdrawal = retrievalWatermark();
        f.settleClock();
        const report = {
          remove: {
            literatures: plan.removed.length,
            file_relations: plan.objects.filter(
              (o) => o.kind === "literature-asset",
            ).length,
            folders: plan.objects.filter((o) => o.kind === "folder").length,
            folder_members: plan.objects.filter(
              (o) => o.kind === "folder-member",
            ).length,
            marks: plan.objects.filter((o) => o.kind === "mark").length,
          },
          keep: {
            literatures: plan.kept.size,
            by_reason: [...plan.kept.values()]
              .flat()
              .reduce<
                Record<string, number>
              >((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}),
          },
          kept_items: [...plan.kept]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([literature_id, reasons]) => ({
              literature_id,
              title: String(
                f.rows(
                  "SELECT title FROM literature_metadata WHERE literature_id=?",
                  literature_id,
                )[0]!.title,
              ),
              reasons,
            })),
          at: f.at(),
          by: "web",
        };
        const withdraw = (inject = false) =>
          f.transaction(() => {
            for (const object of plan.objects)
              f.db
                .prepare("INSERT INTO intake_withdrawn_objects VALUES(?,?,?,?)")
                .run(object.kind, object.id, main.id, report.at);
            f.db
              .prepare(
                "INSERT INTO intake_withdrawals VALUES(?,?,?,?,NULL,?,NULL)",
              )
              .run(
                main.id,
                priorState,
                report.at,
                "web",
                JSON.stringify(report),
              );
            f.db
              .prepare(
                "DELETE FROM literature_search_fts WHERE literature_id IN (SELECT object_id FROM intake_withdrawn_objects WHERE object_kind='literature')",
              )
              .run();
            f.db
              .prepare(
                "UPDATE intake_batches SET state='withdrawn' WHERE batch_id=?",
              )
              .run(main.id);
            if (inject) throw new Error("Synthetic withdrawal interruption");
          });
        await expect(withdraw(true)).rejects.toThrow(
          "Synthetic withdrawal interruption",
        );
        expect(f.rows("SELECT * FROM intake_withdrawn_objects")).toEqual([]);
        expect(f.rows("SELECT * FROM intake_withdrawals")).toEqual([]);
        expect(projections(f)).toEqual(beforeProjection);
        expect(objectRows(f)).toEqual(before);
        expect(retrievalWatermark()).toEqual(beforeWithdrawal);
        await withdraw();
        expectRetrievalChanges(beforeWithdrawal, expectedClean);
        expect(objectRows(f)).toEqual(before);
        expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
        const after = projections(f),
          survivors = beforeProjection.library.filter(
            (lit) => !expectedClean.includes(lit),
          );
        expect(after.library).toEqual(survivors);
        expect(after.counts).toBe(beforeProjection.counts - 3);
        expect(after.fts).toEqual(survivors);
        expect(after.context).toEqual(survivors);
        expect(after.tasks).toEqual(
          beforeProjection.tasks.filter((lit) => !expectedClean.includes(lit)),
        );
        expect(after.storedTargets).toEqual(after.tasks);
        expect(after.references).toHaveLength(1);
        expect(after.discovery).toEqual([id("old-a")]);
        expect(after.folders).toEqual(
          beforeProjection.folders.filter((x) => ![root, child].includes(x)),
        );
        expect(after.members).toEqual(
          beforeProjection.members.filter(
            (x) => !expectedClean.includes((JSON.parse(x) as string[])[1]!),
          ),
        );
        expect(after.marks).toHaveLength(beforeProjection.marks.length - 1);
        expect(after.representatives).toEqual(
          beforeProjection.representatives.filter(
            (x) => !expectedClean.includes(x),
          ),
        );
        expect(after.terms).toHaveLength(beforeProjection.terms.length - 3);
        // These temporary masks isolate representative projection capability:
        // the real merged papers are correctly kept by the withdrawal plan.
        const beforeRepresentativeMasks = retrievalWatermark();
        await f.transaction(() => {
          const meta = f.rows(
            "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
            id("merged"),
          )[0]!.meta_literature_id!;
          const rep = String(
            f.rows(
              "SELECT representative_literature_id FROM meta_literatures WHERE meta_literature_id=?",
              meta,
            )[0]!.representative_literature_id,
          );
          const sibling = rep === oldVersion ? id("merged") : oldVersion;
          f.db
            .prepare(
              "INSERT INTO intake_withdrawn_objects VALUES('literature',?,?,?)",
            )
            .run(rep, main.id, f.at());
          expect(projections(f).representatives).toContain(sibling);
          expect(projections(f).representatives).not.toContain(rep);
          f.db
            .prepare(
              "INSERT INTO intake_withdrawn_objects VALUES('literature',?,?,?)",
            )
            .run(sibling, main.id, f.at());
          expect(projections(f).representatives).not.toContain(sibling);
          f.db
            .prepare(
              "DELETE FROM intake_withdrawn_objects WHERE object_kind='literature' AND object_id IN (?,?)",
            )
            .run(rep, sibling);
        });
        expectRetrievalChanges(beforeRepresentativeMasks, [
          oldVersion,
          id("merged"),
        ]);
        // Identity, observation replay, hash and external-object matching NEVER join the mask.
        for (const key of ["clean-pdf", "clean-fallback"]) {
          const original = main.report.items.find(
            (r) => r.external_id === key,
          )!;
          const preview = await f.app.identity.preview(
            parseMetadataObservation({
              observation_id: randomUUID(),
              source_type: null,
              source_type_mapping_version: null,
              provenance: {
                provenance_id: randomUUID(),
                source_kind: "user",
                source_name: "bibliographic-import",
                source_record_id: null,
                observed_at: f.at(),
                input_sha256: null,
                parameters_sha256: null,
              },
              metadata: record(key, key !== "clean-fallback").metadata,
              version_role: null,
              version_links: [],
              asset_hints: [],
              declared_keywords: [],
              reference_texts: [],
              reference_count: null,
              cited_by_count: null,
            }),
          );
          // The implemented re-entry contract now names a masked identity
          // "restored" in preview; it still matches the exact original UUID.
          expect(preview).toMatchObject({
            disposition: "restored",
            literature_id: original.literature_id,
          });
        }
        const asset = (await f.app.database.assetByHash(digest))!;
        expect(
          f.rows("SELECT * FROM assets WHERE sha256=?", digest),
        ).toHaveLength(1);
        expect(
          f.rows(
            "SELECT * FROM literature_assets WHERE asset_id=? AND literature_id=?",
            asset.asset_id,
            id("clean-pdf"),
          ),
        ).toHaveLength(1);
        expect(
          f.rows(
            "SELECT * FROM external_object_mappings WHERE object_kind='record' AND internal_id=?",
            id("clean-pdf"),
          ),
        ).toHaveLength(1);
        const savedReport = String(
          f.rows(
            "SELECT report_json FROM intake_withdrawals WHERE batch_id=?",
            main.id,
          )[0]!.report_json,
        );
        const beforeReentry = retrievalWatermark();
        const reentry = await f.batch([record("clean-pdf")], main.library);
        expectRetrievalChanges(beforeReentry, [id("clean-pdf")]);
        expect(reentry.report.items[0]!.literature_id).toBe(id("clean-pdf"));
        const restoreIds = (lit: string) => {
          const relationIds = f.ids(
            "SELECT literature_asset_id AS id FROM literature_assets WHERE literature_id=?",
            lit,
          );
          const markIds = f.ids(
            "SELECT mark_id AS id FROM reading_marks WHERE literature_id=?",
            lit,
          );
          const memberships = f.rows(
            "SELECT folder_id FROM folder_members WHERE literature_id=?",
            lit,
          );
          const folders = new Set(memberships.map((m) => String(m.folder_id)));
          for (const group of [...folders])
            for (const row of f.rows(
              "WITH RECURSIVE parents AS (SELECT * FROM folders WHERE folder_id=? UNION ALL SELECT f.* FROM folders f JOIN parents p ON p.parent_id=f.folder_id) SELECT folder_id FROM parents",
              group,
            ))
              folders.add(String(row.folder_id));
          return plan.objects.filter((o) =>
            o.kind === "literature"
              ? o.id === lit
              : o.kind === "literature-asset"
                ? relationIds.includes(o.id)
                : o.kind === "mark"
                  ? markIds.includes(o.id)
                  : o.kind === "folder-member"
                    ? (JSON.parse(o.id) as string[])[1] === lit
                    : folders.has(o.id),
          );
        };
        // Re-entry now restores these masks and advances source revision in
        // its real member transaction. Assert that work instead of replaying
        // the drill's former manual restoration (which would count it twice).
        for (const o of restoreIds(id("clean-pdf")))
          expect(
            f.rows(
              "SELECT 1 FROM intake_withdrawn_objects WHERE object_kind=? AND object_id=? AND batch_id=?",
              o.kind,
              o.id,
              main.id,
            ),
          ).toEqual([]);
        const restoredReport: IntakeReport = await f.app.importSessions.report(
          reentry.id,
        );
        expect(restoredReport.summary.records.restored).toBe(1);
        expect(reasons(f, reentry.id).get(id("clean-pdf"))).toContain(
          "pre-existing",
        );
        expect(
          f.rows(
            "SELECT state FROM intake_batches WHERE batch_id=?",
            main.id,
          )[0]!.state,
        ).toBe("withdrawn");
        expect(
          String(
            f.rows(
              "SELECT report_json FROM intake_withdrawals WHERE batch_id=?",
              main.id,
            )[0]!.report_json,
          ),
        ).toBe(savedReport);
        expect(projections(f).library).toContain(id("clean-pdf"));
        expect(projections(f).library).not.toContain(id("clean-fallback"));
        expect(objectRows(f)).toEqual(before);
        expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
        const beforeRestore = retrievalWatermark();
        await f.transaction(() => {
          const remaining = f.rows(
            "SELECT * FROM intake_withdrawn_objects WHERE batch_id=?",
            main.id,
          );
          expect(
            remaining.filter((r) => r.object_kind === "literature"),
          ).toHaveLength(2);
          f.db
            .prepare("DELETE FROM intake_withdrawn_objects WHERE batch_id=?")
            .run(main.id);
          f.db
            .prepare(
              "UPDATE intake_batches SET state=(SELECT prior_state FROM intake_withdrawals WHERE batch_id=?) WHERE batch_id=?",
            )
            .run(main.id, main.id);
          f.db
            .prepare(
              "UPDATE intake_withdrawals SET restored_at=?,restoration_json=? WHERE batch_id=?",
            )
            .run(
              f.at(),
              JSON.stringify({
                restore: objectCounts(
                  remaining.map((r) => ({
                    kind: String(r.object_kind) as Kind,
                  })),
                ),
                keep: report.keep,
                kept_items: report.kept_items,
                at: f.at(),
                by: "web",
              }),
              main.id,
            );
          // Real re-entry already rebuilds its metadata FTS row, potentially at
          // a new rowid. Remove both that logical owner and the saved rowid
          // before restoring the drill's exact baseline (including rowids).
          for (const row of fts) {
            f.db
              .prepare(
                "DELETE FROM literature_search_fts WHERE literature_id=? OR rowid=?",
              )
              .run(row.literature_id!, row.rowid!);
            const columns = Object.keys(row);
            f.db
              .prepare(
                `INSERT INTO literature_search_fts(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
              )
              .run(...columns.map((c) => row[c]!));
          }
        });
        expectRetrievalChanges(
          beforeRestore,
          expectedClean.filter((lit) => lit !== id("clean-pdf")),
        );
        expect(projections(f)).toEqual(beforeProjection);
        expect(objectRows(f)).toEqual(before);
        expect(searchRows()).toEqual(fts);
        expect(f.rows("SELECT * FROM intake_withdrawn_objects")).toEqual([]);
        expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
        expect(
          f.rows("SELECT type,name,sql FROM sqlite_master ORDER BY type,name"),
        ).toEqual(layout);
        expect(
          f.rows(
            "SELECT state,result FROM intake_batches WHERE batch_id=?",
            main.id,
          )[0],
        ).toMatchObject({
          state: priorState,
          result: priorState === "finished" ? "completed" : null,
        });
        for (const [index, a] of artifacts.entries())
          expect(
            await f.app.files.read(
              String(a.relative_path),
              Number(a.byte_size),
            ),
          ).toEqual(bytesBefore[index]);
        console.log(
          "withdrawal-drill",
          JSON.stringify({
            prior_state: priorState,
            removed: plan.objects.reduce<Record<string, number>>(
              (counts, o) => ({
                ...counts,
                [o.kind]: (counts[o.kind] ?? 0) + 1,
              }),
              {},
            ),
            kept: plan.kept.size,
            reason_categories: new Set([...plan.kept.values()].flat()).size,
            physical_literatures: beforeProjection.library.length,
            foreign_key_violations: 0,
          }),
        );
      } finally {
        await f.close();
      }
    }),
  60_000,
);
