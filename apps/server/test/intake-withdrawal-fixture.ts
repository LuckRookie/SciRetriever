import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect } from "vitest";
import { parseFolderNode, type ImportRecord } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

export function withdrawalRecord(key: string, identified = true): ImportRecord {
  return {
    external_id: key,
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `Withdrawal ${key}`,
      identifiers: identified
        ? [{ namespace: "doi", value: `10.5555/withdrawal-${key}` }]
        : [],
    },
    source_type: null,
    groups: [],
    user_tags: [],
    files: [],
    annotations: [],
  };
}

export async function withdrawalFixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-withdrawal-"));
  let now = Date.now() - 3_600_000;
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [] },
    importSessions: { maintain: false, now: () => now },
  });
  const db = new DatabaseSync(join(home, "catalog.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const rows = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).all(...args);
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
  const create = async (library: string = randomUUID()) => {
    now += 1000;
    return app.importSessions.create(
      {
        format: "records",
        source: {
          system: "synthetic",
          library_id: library,
          identity: "global",
          name: "Withdrawal source",
        },
        scope: "offline withdrawal test",
      },
      { kind: "local", origin: "web" },
    );
  };
  const batch = async (records: ImportRecord[], library?: string) => {
    const b = await create(library);
    await app.importSessions.putData(b.batch_id, 0, { records });
    await app.importSessions.confirm(b.batch_id);
    const report = await app.importSessions.report(b.batch_id);
    expect(report.batch.state).toBe("finished");
    return { id: b.batch_id, report, library: b.source!.library_id };
  };
  const folder = async (
    name: string,
    batchId?: string,
    parent: string | null = null,
  ) =>
    parseFolderNode(
      await app.folders.manage(
        { operation: "create", request: { name, parent_id: parent } },
        undefined,
        batchId,
      ),
    ).folder_id;
  const add = (folderId: string, literatureId: string, batchId?: string) =>
    app.folders.manage(
      {
        operation: "add",
        request: { folder_id: folderId, literature_ids: [literatureId] },
      },
      undefined,
      batchId,
    );
  return {
    home,
    app,
    db,
    rows,
    transaction,
    create,
    batch,
    folder,
    add,
    async close() {
      db.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Logical rows, including FTS, so a preview/rollback cannot hide a write. */
export function catalogRows(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => {
        const name = String(row.name);
        return [
          name,
          db
            .prepare(`SELECT * FROM "${name}"`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort(),
        ];
      }),
  );
}
