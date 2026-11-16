import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import {
  sha256,
  parseIntakeWithdrawalReport,
  parseLiterature,
  parseMetadataObservation,
  parseReference,
  type ImportRecord,
} from "@sciretriever/contracts";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startIntake, finishIntake } from "../src/literature/intake.js";
import { runFolderStorage } from "../src/storage/sqlite/folder-engine.js";
import { runIntakeWithdrawal } from "../src/storage/sqlite/intake-withdrawal-engine.js";
import { IntakeWithdrawalService } from "../src/literature/intake-withdrawal.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";
import {
  catalogRows,
  withdrawalFixture,
  withdrawalRecord as record,
} from "./intake-withdrawal-fixture.js";

it.each(["finished", "cancelled"] as const)(
  "withdraws and restores a %s batch without deleting facts or immutable shared files",
  async (prior) => {
    const f = await withdrawalFixture();
    try {
      const source = await f.batch([record("clean"), record("keep")]);
      const [clean, keep] = source.report.items.map((i) => i.literature_id!);
      const root = await f.folder("Imported", source.id),
        child = await f.folder("Child", source.id, root);
      await f.add(child, clean!, source.id);
      const bytes = workbenchPdf(),
        digest = await sha256(bytes);
      await f.app.maintenance!.ingestPdf({ literature_id: clean!, bytes });
      await f.app.maintenance!.ingestPdf({ literature_id: keep!, bytes });
      const mark = await f.app.marks.manageForIntake(
        {
          operation: "create",
          request: {
            literature_id: clean,
            kind: "highlight",
            color: "yellow",
            quote: "Synthetic",
            pdf: { sha256: digest, page: 1, rects: [[10, 10, 30, 4]] },
          },
        },
        source.id,
      );
      await f.app.folders.opened({ literature_id: keep });
      if (prior === "cancelled")
        await f.transaction(() => {
          f.db
            .prepare(
              "UPDATE intake_batches SET state='cancelled',result=NULL WHERE batch_id=?",
            )
            .run(source.id);
        });
      const service = new IntakeWithdrawalService(f.app.database),
        before = catalogRows(f.db);
      const preview = await service.preview(source.id);
      expect(catalogRows(f.db)).toEqual(before);
      expect(preview).toEqual({
        remove: {
          literatures: 1,
          file_relations: 1,
          folders: 2,
          folder_members: 1,
          marks: 1,
        },
        keep: { literatures: 1, by_reason: { opened: 1 } },
        kept_items: [
          {
            literature_id: keep,
            title: "Withdrawal keep",
            reasons: ["opened"],
          },
        ],
        registered: true,
      });
      const revision = Number(
        f.rows("SELECT revision FROM retrieval_source_revision")[0]!.revision,
      );
      const report = await service.withdraw(source.id);
      expect(report).toEqual({ ...preview, at: expect.any(String), by: "web" });
      expect(parseIntakeWithdrawalReport(report)).toEqual(report);
      expect(
        Number(
          f.rows("SELECT revision FROM retrieval_source_revision")[0]!.revision,
        ),
      ).toBe(revision + 1);
      expect(await f.app.database.getLiterature(clean!)).toBeNull();
      expect(await f.app.database.currentFacts(clean!)).not.toBeNull();
      expect(
        (
          await f.app.database.findLiteratureByIdentifiers(
            record("clean").metadata.identifiers,
          )
        )[0]!.literature_id,
      ).toBe(clean);
      expect(await f.app.database.assetByHash(digest)).not.toBeNull();
      expect(
        (await f.app.library.search({ query: {} })).items.map(
          (i) => i.literature.literature_id,
        ),
      ).toEqual([keep]);
      await expect(f.app.library.detail(clean)).rejects.toMatchObject({
        code: "literature-not-found",
      });
      expect(
        await f.app.folders.query({ operation: "list", request: {} }),
      ).toEqual({ items: [] });
      await expect(
        f.app.marks.query({
          operation: "list",
          request: { literature_id: clean },
        }),
      ).rejects.toMatchObject({ code: "literature-not-found" });
      const asset = (await f.app.database.assetByHash(digest))!;
      expect(await f.app.files.read(asset.path, asset.size_bytes)).toEqual(
        bytes,
      );
      expect(f.rows("SELECT * FROM assets")).toHaveLength(1);
      expect(f.rows("SELECT * FROM literature_assets")).toHaveLength(2);
      const restored = await service.restore(source.id);
      expect(restored).toMatchObject({
        restore: preview.remove,
        keep: preview.keep,
        registered: true,
      });
      expect((await f.app.importSessions.status(source.id)).state).toBe(prior);
      expect(await f.app.database.getLiterature(clean!)).not.toBeNull();
      expect(
        await f.app.marks.query({
          operation: "list",
          request: { literature_id: clean },
        }),
      ).toMatchObject({ items: [{ mark_id: mark.mark_id }] });
      expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("registers imported folders, members and PDF relations in their owner transactions and rolls back a failed registration", async () => {
  const f = await withdrawalFixture();
  try {
    const b = await f.create();
    const input: ImportRecord = {
      ...record("registration"),
      groups: ["group"],
      files: [
        {
          external_id: "pdf",
          file_name: "paper.pdf",
          media_type: "application/pdf",
          preferred: true,
          size_bytes: null,
          sha256: null,
        },
      ],
    };
    await f.app.importSessions.putData(b.batch_id, 0, {
      records: [input],
      groups: [
        {
          external_id: "group",
          name: "Import group",
          parent_external_id: null,
        },
      ],
    });
    await f.app.importSessions.confirm(b.batch_id);
    const file = (await f.app.importSessions.missingFiles(b.batch_id, null, 10))
      .items[0]!;
    async function* chunks() {
      yield workbenchPdf();
    }
    await f.app.importSessions.upload(b.batch_id, file.file_id, chunks());
    await f.app.importSessions.finish(b.batch_id);
    for (const [kind, sql] of [
      ["folder", "SELECT folder_id AS id FROM folders"],
      [
        "folder-member",
        "SELECT json_array(folder_id,literature_id) AS id FROM folder_members",
      ],
      [
        "literature-asset",
        "SELECT literature_asset_id AS id FROM literature_assets",
      ],
    ]) {
      const ids = f
        .rows(sql!)
        .map((row) => row.id)
        .sort();
      expect(ids.length).toBeGreaterThan(0);
      expect(
        f
          .rows(
            "SELECT object_id AS id FROM intake_batch_objects WHERE object_kind=? AND batch_id=?",
            kind!,
            b.batch_id,
          )
          .map((row) => row.id)
          .sort(),
      ).toEqual(ids);
    }
    await expect(
      f.app.folders.manage(
        { operation: "create", request: { name: "Rollback registration" } },
        undefined,
        randomUUID(),
      ),
    ).rejects.toThrow();
    expect(
      f.rows("SELECT 1 FROM folders WHERE name='Rollback registration'"),
    ).toEqual([]);
    const markId = randomUUID();
    await expect(
      f.app.marks.manageForIntake(
        {
          operation: "create",
          request: {
            mark_id: markId,
            literature_id: file.literature_id,
            kind: "highlight",
            color: "yellow",
            quote: "Registration must roll back",
            pdf: {
              sha256: await sha256(workbenchPdf()),
              page: 1,
              rects: [[10, 10, 30, 4]],
            },
          },
        },
        randomUUID(),
      ),
    ).rejects.toThrow();
    expect(
      f.rows("SELECT * FROM reading_marks WHERE mark_id=?", markId),
    ).toEqual([]);
    expect(
      f.rows(
        "SELECT * FROM intake_batch_objects WHERE object_kind='mark' AND object_id=?",
        markId,
      ),
    ).toEqual([]);
    expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
});

it("retains renamed and moved imported folders, including their ancestors, without leaving a visible child under a hidden parent", async () => {
  const f = await withdrawalFixture();
  try {
    const b = await f.batch([record("folder-history")]),
      id = b.report.items[0]!.literature_id!;
    const root = await f.folder("Imported root", b.id),
      renamed = await f.folder("Original child", b.id, root),
      safe = await f.folder("Safe child", b.id, root),
      moved = await f.folder("Moved child", b.id, root),
      outside = await f.folder("User parent");
    for (const folder of [renamed, safe, moved]) await f.add(folder, id, b.id);
    for (const command of [
      {
        operation: "rename",
        request: { folder_id: renamed, name: "User renamed" },
      },
      {
        operation: "move",
        request: { folder_id: moved, parent_id: outside, position: 0 },
      },
    ])
      await f.app.database.folders({
        ...command,
        actor: "local:web",
        now: new Date(Date.now() + 1000).toISOString(),
      });
    const svc = new IntakeWithdrawalService(f.app.database),
      preview = await svc.preview(b.id);
    expect(preview.remove).toEqual({
      literatures: 1,
      file_relations: 0,
      folders: 1,
      folder_members: 3,
      marks: 0,
    });
    await svc.withdraw(b.id);
    expect(
      (await f.app.folders.query({ operation: "list", request: {} })) as {
        items: unknown[];
      },
    ).toMatchObject({
      items: expect.arrayContaining([
        {
          folder_id: root,
          name: "Imported root",
          parent_id: null,
          position: expect.any(Number),
          created_at: expect.any(String),
          updated_at: expect.any(String),
          own_count: 0,
          total_count: 0,
        },
      ]),
    });
    expect(
      f
        .rows(
          "SELECT object_id FROM intake_withdrawn_objects WHERE object_kind='folder'",
        )
        .map((row) => row.object_id),
    ).toEqual([safe]);
    expect(await svc.restore(b.id)).toMatchObject({ restore: preview.remove });
    expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps all eight reasons, including multiple reasons, and re-evaluates after preview", async () => {
  const f = await withdrawalFixture();
  try {
    const old = await f.batch([record("existing"), record("version")]);
    const keys = [
      "clean",
      "later",
      "folder",
      "annotated",
      "opened",
      "processed",
      "edited",
      "merged",
      "existing",
    ];
    const b = await f.batch(keys.map((k) => record(k)));
    const ids = new Map(
      b.report.items.map((row) => [row.external_id, row.literature_id!]),
    );
    const id = (key: string) => ids.get(key)!;
    const owned = await f.folder("Owned", b.id);
    await f.add(owned, id("clean"), b.id);
    const folder = await f.folder("User folder");
    await f.add(folder, id("folder"));
    const bytes = workbenchPdf();
    for (const key of ["annotated", "processed"])
      await f.app.maintenance!.ingestPdf({ literature_id: id(key), bytes });
    await f.app.marks.manage({
      operation: "create",
      request: {
        literature_id: id("annotated"),
        kind: "highlight",
        color: "yellow",
        quote: "User note",
        pdf: { sha256: await sha256(bytes), page: 1, rects: [[10, 10, 30, 4]] },
      },
    });
    await f.app.folders.opened({ literature_id: id("opened") });
    const edited = await f.app.metadataFields.read(id("edited"));
    await f.app.metadataFields.edit({
      literature_id: id("edited"),
      expected_revision: edited.metadata_revision,
      set: [{ field: "title", value: "Edited title" }],
      unlock: [],
    });
    await f.app.folders.opened({ literature_id: id("edited") });
    await f.batch([record("later")]);
    const merging = (await f.app.database.getLiterature(id("merged")))!;
    await f.app.database.putLiterature(
      parseLiterature({ ...merging, version_role: "preprint" }),
    );
    await f.app.identity.observe(
      parseMetadataObservation({
        observation_id: randomUUID(),
        source_type: null,
        source_type_mapping_version: null,
        provenance: {
          provenance_id: randomUUID(),
          source_kind: "metadata-provider",
          source_name: "synthetic-withdrawal",
          source_record_id: "link",
          observed_at: new Date().toISOString(),
          input_sha256: "a".repeat(64),
          parameters_sha256: null,
        },
        metadata: record("merged").metadata,
        version_role: "preprint",
        version_links: [
          {
            record_id: null,
            identifiers: record("version").metadata.identifiers,
          },
        ],
        asset_hints: [],
        declared_keywords: [],
        reference_texts: [],
        reference_count: null,
        cited_by_count: null,
      }),
    );
    const asset = (await f.app.database.currentFacts(id("processed")))!
      .primary_asset!;
    await f.transaction(() => {
      f.db
        .prepare(
          "INSERT INTO archive_runs(literature_id,asset_id,mode,run_id,job_id,state,started_at,finished_at) VALUES(?,?,'full',?,NULL,'finished',?,?)",
        )
        .run(
          id("processed"),
          asset.asset_id,
          randomUUID(),
          new Date().toISOString(),
          new Date().toISOString(),
        );
    });
    const svc = new IntakeWithdrawalService(f.app.database),
      before = catalogRows(f.db),
      preview = await svc.preview(b.id);
    expect(catalogRows(f.db)).toEqual(before);
    expect(preview.keep, JSON.stringify(preview.kept_items)).toEqual({
      literatures: 8,
      by_reason: {
        "pre-existing": 1,
        "hit-by-later-batch": 1,
        "folder-changed": 1,
        annotated: 1,
        opened: 2,
        processed: 1,
        "metadata-edited": 1,
        "identity-merged": 1,
      },
    });
    expect(preview.kept_items.map((i) => i.literature_id)).toEqual(
      [...preview.kept_items.map((i) => i.literature_id)].sort(),
    );
    expect(
      preview.kept_items.find((i) => i.literature_id === id("edited"))!.reasons,
    ).toEqual(["metadata-edited", "opened"]);
    expect(preview.remove.literatures).toBe(1);
    await f.app.folders.opened({ literature_id: id("clean") });
    expect(await svc.withdraw(b.id)).toMatchObject({
      remove: { literatures: 0 },
      keep: { literatures: 9 },
    });
    expect((await f.app.library.search({ query: {} })).total_count).toBe(10);
    expect(old.report.batch.state).toBe("finished");
  } finally {
    await f.close();
  }
});

it("rejects nonterminal and busy batches and bounds kept_items to the first 200 IDs", async () => {
  const f = await withdrawalFixture();
  try {
    const svc = new IntakeWithdrawalService(f.app.database),
      open = await f.create();
    await expect(svc.preview(open.batch_id)).rejects.toMatchObject({
      code: "intake-batch-state",
    });
    const b = await f.batch([record("busy")]),
      id = b.report.items[0]!.literature_id!;
    // A real persisted queued job names its target before the runner starts.
    const { ExecutionRepository, normalizeExecutionPolicy } = await import(
      "../src/storage/execution/repository.js"
    );
    const repo = new ExecutionRepository(f.app.database);
    const jobId = `job-${randomUUID()}`;
    const job = await repo.createJob({
      job_id: jobId,
      target_kind: "literature",
      selector: { literature_ids: [id] },
      policy_version: randomUUID(),
      idempotency_key: randomUUID(),
      policy: normalizeExecutionPolicy({}),
      targets: [
        {
          target_id: randomUUID(),
          job_id: jobId,
          ordinal: 0,
          literature_id: id,
          version_role: "published",
          stage: "acquisition",
          disposition: "pending",
          next_eligible_at: null,
        },
      ],
    });
    for (const state of ["queued", "running"] as const) {
      await repo.updateJob(job.job_id, state);
      const before = catalogRows(f.db);
      await expect(svc.preview(b.id)).rejects.toMatchObject({
        code: "intake-batch-busy",
      });
      await expect(svc.withdraw(b.id)).rejects.toMatchObject({
        code: "intake-batch-busy",
      });
      expect(catalogRows(f.db)).toEqual(before);
    }
    await repo.controlJob(job.job_id, "cancelled");
    expect((await svc.preview(b.id)).remove.literatures).toBe(1);
    await svc.withdraw(b.id);
    expect(
      await f.app.database.review("task-run", { job_id: job.job_id }),
    ).toMatchObject({ items: [], total_count: 0, next_offset: null });
    expect(await repo.listTargets(job.job_id, 100, true)).toEqual([]);
    expect(await repo.listTargets(job.job_id, 100)).toHaveLength(1);
    const many = await f.batch(
      Array.from({ length: 205 }, (_, n) => record(`bounded-${n}`)),
    );
    const all = f
      .rows(
        "SELECT literature_id FROM intake_batch_members WHERE batch_id=? ORDER BY literature_id",
        many.id,
      )
      .map((row) => String(row.literature_id));
    expect(all).toHaveLength(205);
    await f.transaction(() => {
      for (const id of all)
        f.db
          .prepare("INSERT INTO reading_history VALUES(?,?,1)")
          .run(id, new Date().toISOString());
    });
    const p = await svc.preview(many.id);
    expect(p.keep.literatures).toBe(205);
    expect(p.kept_items).toHaveLength(200);
    expect(p.kept_items.map((i) => i.literature_id)).toEqual(all.slice(0, 200));
  } finally {
    await f.close();
  }
});

it("rolls back withdrawal and restoration failures without partial markers or source revision", async () => {
  const f = await withdrawalFixture();
  try {
    const b = await f.batch([record("atomic-a"), record("atomic-b")]),
      svc = new IntakeWithdrawalService(f.app.database);
    await f.transaction(() => {
      f.db.exec(
        "CREATE TRIGGER synthetic_withdrawal_failure BEFORE UPDATE OF state ON intake_batches WHEN NEW.state='withdrawn' BEGIN SELECT RAISE(ABORT,'injected withdrawal failure'); END",
      );
    });
    const before = catalogRows(f.db);
    await expect(svc.withdraw(b.id)).rejects.toThrow();
    expect(catalogRows(f.db)).toEqual(before);
    await f.transaction(() => {
      f.db.exec("DROP TRIGGER synthetic_withdrawal_failure");
    });
    await svc.withdraw(b.id);
    await f.transaction(() => {
      f.db.exec(
        "CREATE TRIGGER synthetic_restore_failure BEFORE UPDATE OF state ON intake_batches WHEN OLD.state='withdrawn' BEGIN SELECT RAISE(ABORT,'injected restoration failure'); END",
      );
    });
    const withdrawn = catalogRows(f.db);
    await expect(svc.restore(b.id)).rejects.toThrow();
    expect(catalogRows(f.db)).toEqual(withdrawn);
    await f.transaction(() => {
      f.db.exec("DROP TRIGGER synthetic_restore_failure");
    });
    await svc.restore(b.id);
    expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rolls back a process killed after its first marker, and can retry the same batch", async () => {
  const f = await withdrawalFixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const b = await f.batch([record("crash-a"), record("crash-b")]),
      before = catalogRows(f.db);
    const code = `import {DatabaseSync} from 'node:sqlite';import {writeSync} from 'node:fs';const {runIntakeWithdrawal}=await import(process.argv[2]);const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA foreign_keys=ON');const prepare=db.prepare.bind(db);db.prepare=(sql)=>{const s=prepare(sql);if(sql.startsWith('INSERT INTO intake_withdrawn_objects')){const run=s.run.bind(s);s.run=(...args)=>{const r=run(...args);writeSync(1,'CHECKPOINT\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return r;};}return s;};runIntakeWithdrawal(db,{operation:'withdraw',batch_id:process.argv[3],at:new Date().toISOString()});`;
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        code,
        join(f.home, "catalog.sqlite"),
        new URL(
          "../src/storage/sqlite/intake-withdrawal-engine.ts",
          import.meta.url,
        ).href,
        b.id,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("withdrawal child did not reach checkpoint")),
        20_000,
      );
      child!.stdout!.on("data", (chunk) => {
        if (String(chunk).includes("CHECKPOINT")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("withdrawal child exited before checkpoint"));
      });
    });
    expect(f.rows("SELECT * FROM intake_withdrawn_objects")).toEqual([]);
    child.kill("SIGKILL");
    await exited;
    child = undefined;
    expect(catalogRows(f.db)).toEqual(before);
    expect(
      await new IntakeWithdrawalService(f.app.database).withdraw(b.id),
    ).toMatchObject({ remove: { literatures: 2 } });
    expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    child?.kill("SIGKILL");
    await f.close();
  }
});

it("excludes withdrawal from counts, facets, paginated tasks, stale retrieval generations and read-only query applications", async () => {
  const f = await withdrawalFixture();
  let reader: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    const b = await f.batch([record("unique-hidden"), record("visible")]),
      [hidden, visible] = b.report.items.map((i) => i.literature_id!);
    await f.app.folders.opened({ literature_id: visible });
    await f.app.maintenance!.rebuildIndex();
    reader = await createQueryApplication(f.home);
    const request = {
      query: "Withdrawal",
      scope: { kind: "library" },
      kinds: ["metadata"],
      versions: { kind: "default" },
      budget: { max_items: 10, max_bytes: 65536, token_limit: null },
      continuation: null,
    };
    expect((await reader.context!.search(request)).items).toHaveLength(2);
    await new IntakeWithdrawalService(f.app.database).withdraw(b.id);
    expect((await reader.context!.search(request)).items).toHaveLength(1);
    expect((await reader.query!.counts({})).total).toBe(1);
    expect((await reader.query!.facets({ query: {}, limit: 10 })).total).toBe(
      1,
    );
    expect(
      (await reader.query!.search({ query: { text: "unique-hidden" } }))
        .total_count,
    ).toBe(0);
    expect(
      (
        await f.app.library.pdfSelection({
          kind: "query",
          query: {},
          sort: "intake-desc",
          limit: null,
        })
      ).items.map((i) => i.literature_id),
    ).toEqual([visible]);
    await expect(
      f.app.library.pdfSelection({
        kind: "literatures",
        literature_ids: [hidden],
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.app.library.parseSelection({
          kind: "query",
          query: {},
          sort: "intake-desc",
          limit: null,
        })
      ).counts.matched,
    ).toBe(1);
    await expect(
      f.app.library.bibliographies([hidden!, visible!]),
    ).rejects.toMatchObject({ code: "literature-not-found" });
    expect(await f.app.library.bibliographies([visible!])).toHaveLength(1);
    await f.app.maintenance!.refreshIndex!();
    expect((await reader.context!.search(request)).items).toHaveLength(1);
  } finally {
    await reader?.close();
    await f.close();
  }
});

it.each(["import-first", "user-first"])(
  "conservatively retains the legacy fork (%s), but withdraws an untouched legacy member",
  async (order) => {
    const f = await withdrawalFixture();
    try {
      const b = await f.batch([
        record("legacy-folder"),
        record("legacy-clean"),
        record("legacy-note"),
      ]);
      const [folderLit, clean, note] = b.report.items.map(
        (i) => i.literature_id!,
      );
      const folder = await f.folder("Same persisted legacy folder");
      // The same bottom state results from either creator order; old data has no owner.
      const commands =
        order === "import-first" ? ["import", "user"] : ["user", "import"];
      for (const actor of commands)
        await f.app.database.folders({
          operation: "add",
          request: { folder_id: folder, literature_ids: [folderLit] },
          actor,
          now: "2026-11-16T00:00:00Z",
        });
      const bytes = workbenchPdf();
      await f.app.maintenance!.ingestPdf({ literature_id: note!, bytes });
      await f.app.marks.manage({
        operation: "create",
        request: {
          literature_id: note,
          kind: "highlight",
          color: "yellow",
          quote: "User or legacy imported note",
          pdf: {
            sha256: await sha256(bytes),
            page: 1,
            rects: [[10, 10, 30, 4]],
          },
        },
      });
      expect(
        f.rows("SELECT * FROM intake_batch_objects WHERE batch_id=?", b.id),
      ).toEqual([]);
      const svc = new IntakeWithdrawalService(f.app.database),
        before = catalogRows(f.db);
      const preview = await svc.preview(b.id);
      expect(preview).toMatchObject({
        registered: false,
        remove: {
          literatures: 1,
          file_relations: 0,
          folders: 0,
          folder_members: 0,
          marks: 0,
        },
        keep: {
          literatures: 2,
          by_reason: { "folder-changed": 1, annotated: 1 },
        },
      });
      expect(catalogRows(f.db)).toEqual(before);
      expect((await svc.withdraw(b.id)).registered).toBe(false);
      expect(await f.app.database.getLiterature(clean!)).toBeNull();
      expect(await f.app.database.getLiterature(folderLit!)).not.toBeNull();
      expect(
        await f.app.folders.query({ operation: "list", request: {} }),
      ).toMatchObject({ items: [{ folder_id: folder }] });
    } finally {
      await f.close();
    }
  },
);

it("forks one legacy baseline into both creator orders and retains both as folder-changed", async () => {
  const f = await withdrawalFixture();
  try {
    const b = await f.batch([record("same-legacy-baseline")]);
    const id = b.report.items[0]!.literature_id!,
      folder = await f.folder("Same legacy group");
    const snapshots: ReturnType<typeof catalogRows>[] = [],
      actualCreators: string[] = [];
    for (const [n, order] of [
      ["import", "user"],
      ["user", "import"],
    ].entries()) {
      const path = join(f.home, `legacy-fork-${n}.sqlite`);
      await backup(f.db, path);
      const fork = new DatabaseSync(path);
      try {
        fork.exec("PRAGMA foreign_keys=ON");
        for (const origin of order) {
          const result = runFolderStorage(fork, {
            operation: "add",
            request: { folder_id: folder, literature_ids: [id] },
            actor: "local:web",
            now: "2026-11-17T00:00:00Z",
          }) as { changed: number };
          if (result.changed) actualCreators.push(origin);
        }
        const before = catalogRows(fork);
        expect(
          runIntakeWithdrawal(fork, {
            operation: "preview",
            batch_id: b.id,
            at: "2026-11-17T01:00:00Z",
          }),
        ).toMatchObject({
          registered: false,
          remove: { literatures: 0 },
          keep: { by_reason: { "folder-changed": 1 } },
        });
        expect(catalogRows(fork)).toEqual(before);
        const result = runIntakeWithdrawal(fork, {
          operation: "withdraw",
          batch_id: b.id,
          at: "2026-11-17T01:00:00Z",
        });
        expect(result).toMatchObject({
          registered: false,
          remove: { literatures: 0 },
          keep: { by_reason: { "folder-changed": 1 } },
        });
        expect(
          fork.prepare("SELECT * FROM intake_withdrawn_objects").all(),
        ).toEqual([]);
        expect(fork.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        snapshots.push(catalogRows(fork));
      } finally {
        fork.close();
      }
    }
    expect(actualCreators).toEqual(["import", "user"]);
    expect(snapshots[0]).toEqual(snapshots[1]);
  } finally {
    await f.close();
  }
});

it("re-entry restores the original identity, ownership and source without changing the original report", async () => {
  const f = await withdrawalFixture();
  try {
    const b = await f.batch([record("reenter"), record("remainder", false)]);
    const [id, remainder] = b.report.items.map((i) => i.literature_id!);
    const folder = await f.folder("Restore ancestors", b.id);
    await f.add(folder, id!, b.id);
    await f.add(folder, remainder!, b.id);
    const bytes = workbenchPdf();
    await f.app.maintenance!.ingestPdf({ literature_id: id!, bytes });
    const mark = await f.app.marks.manageForIntake(
      {
        operation: "create",
        request: {
          literature_id: id,
          kind: "highlight",
          color: "blue",
          quote: "Restored imported mark",
          pdf: {
            sha256: await sha256(bytes),
            page: 1,
            rects: [[10, 10, 30, 4]],
          },
        },
      },
      b.id,
    );
    const service = new IntakeWithdrawalService(f.app.database);
    await service.withdraw(b.id);
    const report = String(
      f.rows(
        "SELECT report_json FROM intake_withdrawals WHERE batch_id=?",
        b.id,
      )[0]!.report_json,
    );
    const observations = f.rows("SELECT * FROM metadata_observations").length;
    const next = await f.batch([record("reenter")], b.library);
    expect(next.report.items[0]).toMatchObject({
      literature_id: id,
      disposition: "restored",
    });
    expect(next.report.summary.records.restored).toBe(1);
    expect(
      await f.app.marks.query({
        operation: "list",
        request: { literature_id: id },
      }),
    ).toMatchObject({ items: [{ mark_id: mark.mark_id }] });
    expect((await f.app.library.detail(id)).primary_pdf).not.toBeNull();
    expect(f.rows("SELECT * FROM metadata_observations")).toHaveLength(
      observations,
    );
    expect(f.rows("SELECT * FROM literatures")).toHaveLength(2);
    expect(
      f.rows(
        "SELECT report_json FROM intake_withdrawals WHERE batch_id=?",
        b.id,
      )[0]!.report_json,
    ).toBe(report);
    expect((await f.app.importSessions.status(b.id)).state).toBe("withdrawn");
    expect(await f.app.database.getLiterature(remainder!)).toBeNull();
    const result = await service.restore(b.id);
    expect(result).toMatchObject({
      restore: {
        literatures: 1,
        file_relations: 0,
        folders: 0,
        folder_members: 1,
        marks: 0,
      },
    });
    expect(
      (await f.app.library.search({ query: { text: "Withdrawal" } }))
        .total_count,
    ).toBe(2);
  } finally {
    await f.close();
  }
});

it("excludes both reference endpoints and discovery causes, and chooses a visible MetaLiterature representative without changing identity", async () => {
  const f = await withdrawalFixture();
  try {
    const old = await f.batch([record("preprint")]),
      oldId = old.report.items[0]!.literature_id!;
    const existing = (await f.app.database.getLiterature(oldId))!;
    await f.app.database.putLiterature(
      parseLiterature({ ...existing, version_role: "preprint" }),
    );
    const batch = await startIntake(
      f.app.database,
      "citation",
      "Synthetic version",
      {},
      "web",
    );
    const observation = parseMetadataObservation({
      observation_id: randomUUID(),
      source_type: null,
      source_type_mapping_version: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "metadata-provider",
        source_name: "synthetic-version",
        source_record_id: "published",
        observed_at: new Date().toISOString(),
        input_sha256: "f".repeat(64),
        parameters_sha256: null,
      },
      metadata: record("published").metadata,
      version_role: "published",
      version_links: [
        {
          record_id: null,
          identifiers: record("preprint").metadata.identifiers,
        },
      ],
      asset_hints: [],
      declared_keywords: [],
      reference_texts: ["Synthetic preprint reference"],
      reference_count: null,
      cited_by_count: null,
    });
    const decision = await f.app.identity.observe(observation, {
      intake_batch_id: batch,
    });
    if (decision.disposition !== "accepted")
      throw new Error("Synthetic version refused");
    const id = decision.literature_id;
    await finishIntake(f.app.database, batch, "completed");
    expect(
      (await f.app.library.detail(oldId)).meta_literature
        .representative_literature_id,
    ).toBe(id);
    expect(
      (await new IntakeWithdrawalService(f.app.database).preview(old.id)).keep
        .by_reason["identity-merged"],
    ).toBe(1);
    const reference = parseReference({
      reference_id: randomUUID(),
      source_literature_id: id,
      target_literature_id: oldId,
    });
    await f.app.references.publish(reference);
    await f.app.references.supportWithMetadataReferenceText(
      reference.reference_id,
      observation.observation_id,
      0,
    );
    const discovery = randomUUID();
    await f.app.database.putDiscovery({
      run: {
        discovery_run_id: discovery,
        kind: "citation",
        status: "COMPLETED",
        started_at: new Date().toISOString(),
        seed_literature_ids: [oldId],
        direction: "references",
        max_depth: 1,
        result_limit: 10,
      },
      providers: [],
      source_results: [],
      results: [{ meta_literature_id: decision.meta_literature_id }],
      topic_causes: [],
      citation_causes: [
        {
          meta_literature_id: decision.meta_literature_id,
          source_literature_id: id,
          target_literature_id: oldId,
          actual_literature_id: id,
          depth: 1,
        },
      ],
    });
    expect(
      (
        await f.app.library.references({
          literature_id: oldId,
          direction: "cited-by",
        })
      ).total_count,
    ).toBe(1);
    await new IntakeWithdrawalService(f.app.database).withdraw(batch);
    const detail = await f.app.library.detail(oldId);
    expect(detail.meta_literature.representative_literature_id).toBe(oldId);
    expect(detail.other_versions).toEqual([]);
    expect(detail.cited_by_count).toBe(0);
    expect(
      f.rows(
        "SELECT representative_literature_id FROM meta_literatures WHERE meta_literature_id=?",
        decision.meta_literature_id,
      )[0]!.representative_literature_id,
    ).toBe(id);
    expect(await f.app.references.snapshot()).toEqual([]);
    expect(
      (
        await f.app.library.references({
          literature_id: oldId,
          direction: "cited-by",
        })
      ).total_count,
    ).toBe(0);
    await expect(
      f.app.library.referenceDetail(reference.reference_id),
    ).rejects.toMatchObject({ code: "literature-not-found" });
    expect(
      (await f.app.database.getDiscovery(discovery))!.citation_causes,
    ).toEqual([]);
    expect(
      (
        await f.app.library.search({
          query: { discovery_run_ids: [discovery] },
        })
      ).total_count,
    ).toBe(0);
    const match = await f.app.database.findLiteratureByIdentifiers(
      observation.metadata.identifiers,
    );
    expect(match[0]!.literature_id).toBe(id);
    await new IntakeWithdrawalService(f.app.database).restore(batch);
    expect((await f.app.library.detail(oldId)).cited_by_count).toBe(1);
  } finally {
    await f.close();
  }
});

it("restores a strict fallback match, records changed observations and does not duplicate its UUID", async () => {
  const f = await withdrawalFixture();
  try {
    const input = {
        ...record("strict-reentry", false),
        metadata: {
          ...record("strict-reentry", false).metadata,
          authors: [
            {
              kind: "person" as const,
              display_name: "Strict Author",
              given_name: "Strict",
              family_name: "Author",
              orcid: null,
              affiliations: [],
            },
          ],
        },
      },
      b = await f.batch([input]),
      id = b.report.items[0]!.literature_id!;
    const svc = new IntakeWithdrawalService(f.app.database);
    await svc.withdraw(b.id);
    const initial = f.rows(
      "SELECT count(*) AS n FROM metadata_observations",
    )[0]!.n;
    const next = await f.create();
    await f.app.importSessions.putData(next.batch_id, 0, {
      records: [
        {
          ...input,
          metadata: { ...input.metadata, abstract: "Changed source content" },
        },
      ],
    });
    expect(
      (await f.app.importSessions.preview(next.batch_id)).summary.records
        .restored,
    ).toBe(1);
    await f.app.importSessions.confirm(next.batch_id);
    const result = await f.app.importSessions.report(next.batch_id);
    expect(result.items[0]).toMatchObject({
      disposition: "restored",
      literature_id: id,
    });
    expect(
      f.rows("SELECT count(*) AS n FROM metadata_observations")[0]!.n,
    ).toBe(Number(initial) + 1);
    expect(f.rows("SELECT * FROM literatures")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("restores an identifier match from a different source library even when its strict fallback fields differ", async () => {
  const f = await withdrawalFixture();
  try {
    const input = record("identifier-reentry"),
      b = await f.batch([input]),
      id = b.report.items[0]!.literature_id!;
    const original = f
      .rows(
        "SELECT observation_id FROM literature_metadata_observations WHERE literature_id=?",
        id,
      )
      .map((row) => row.observation_id);
    await new IntakeWithdrawalService(f.app.database).withdraw(b.id);
    const next = await f.batch([
      {
        ...input,
        external_id: "different-source-key",
        metadata: {
          ...input.metadata,
          title: "Different incoming title",
          authors: [],
          publication_year: null,
        },
      },
    ]);
    expect(next.report.items[0]).toMatchObject({
      literature_id: id,
      disposition: "restored",
    });
    expect(f.rows("SELECT * FROM literatures")).toHaveLength(1);
    expect(
      f
        .rows(
          "SELECT observation_id FROM literature_metadata_observations WHERE literature_id=?",
          id,
        )
        .map((row) => row.observation_id),
    ).toEqual(expect.arrayContaining(original));
  } finally {
    await f.close();
  }
});
