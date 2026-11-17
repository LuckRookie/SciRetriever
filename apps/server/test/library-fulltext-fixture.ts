import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseFolderNode,
  parseLiterature,
  parseAsset,
  sha256,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { startIntake, finishIntake } from "../src/literature/intake.js";
import { IntakeWithdrawalService } from "../src/literature/intake-withdrawal.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

export const fullTextId = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
export const FULL_TEXT_EXPECTED = {
  total: 10,
  recently_opened: 0,
  unavailable_pdf: 3,
  with_primary_pdf: 2,
  full_text: { total: 8, obtained: 2, missing: 6, exhausted: 2 },
  statuses: {
    UNREVIEWED: 8,
    ASSET_READY: 2,
    ARCHIVING: 0,
    ARCHIVE_FAILED: 0,
    READY: 0,
    EXCLUDED: 0,
  },
};

/** All tables, including FTS shadow rows, so read-only checks cannot hide a write. */
export function fullTextCatalogRows(home: string) {
  const db = new DatabaseSync(join(home, "catalog.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map(({ name }) => [
          String(name),
          db
            .prepare(`SELECT * FROM "${String(name)}"`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort(),
        ]),
    );
  } finally {
    db.close();
  }
}

/** Published facts only; all tools/providers are absent or synthetic. */
export async function libraryFullTextFixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-fulltext-status-"));
  let modelCalls = 0;
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
    agentTransportFactory: () => async () => {
      modelCalls++;
      throw new Error("Read must not call a model");
    },
  });
  let reader: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    const selected = [1, 3, 5, 7];
    const meta = (n: number) =>
      fullTextId(1000 + (n === 2 ? 1 : n === 4 ? 3 : n === 11 ? 10 : n));
    for (let n = 1; n <= 12; n++)
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: fullTextId(n),
          meta_literature_id: meta(n),
          version_role: [1, 3, 10].includes(n) ? "preprint" : "published",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `${selected.includes(n) ? "Scope" : "Other"} ${n}`,
            language: "en",
            identifiers: [{ namespace: "doi", value: `10.5555/fulltext.${n}` }],
          },
        }),
      );
    const pdf = workbenchPdf(),
      digest = await sha256(pdf),
      path = "objects/fulltext-fixture.pdf";
    const stage = await app.files.stage({ maxBytes: pdf.length });
    await stage.write(pdf);
    await app.files.publish(stage, path);
    const asset = parseAsset({
      asset_id: fullTextId(7000),
      sha256: digest,
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path,
    });
    for (const n of [2, 6, 9, 11, 12])
      await app.database.putLiteratureAsset({
        literature_asset_id: fullTextId(7100 + n),
        literature_id: fullTextId(n),
        asset,
        role: n === 12 ? "supplementary-pdf" : "primary-pdf",
        source_url: null,
        provenance: {
          provenance_id: fullTextId(7200 + n),
          source_kind: "user",
          source_name: "synthetic-fulltext",
          source_record_id: null,
          observed_at: "2026-11-17T00:00:00Z",
          input_sha256: digest,
          parameters_sha256: null,
        },
      });
    const root = parseFolderNode(
      await app.folders.manage({
        operation: "create",
        request: { name: "Full text scope" },
      }),
    ).folder_id;
    const child = parseFolderNode(
      await app.folders.manage({
        operation: "create",
        request: { name: "Selected", parent_id: root },
      }),
    ).folder_id;
    await app.folders.manage({
      operation: "add",
      request: { folder_id: child, literature_ids: selected.map(fullTextId) },
    });
    const batch = await startIntake(
      app.database,
      "topic",
      "Full text batch",
      {},
      "web",
    );
    for (const n of selected)
      await app.database.writeIntake({
        operation: "member",
        member: {
          batch_id: batch,
          literature_id: fullTextId(n),
          disposition: "matched",
        },
      });
    await finishIntake(app.database, batch, "completed");
    const discovery = fullTextId(8000);
    for (const n of selected)
      await app.observations.publish({
        observation_id: fullTextId(8100 + n),
        literature_id: fullTextId(n),
        source_type: null,
        source_type_mapping_version: null,
        provenance: {
          provenance_id: fullTextId(8200 + n),
          source_kind: "metadata-provider",
          source_name: "synthetic-fulltext",
          source_record_id: `scope-${n}`,
          observed_at: "2026-11-17T00:00:00Z",
          input_sha256: "a".repeat(64),
          parameters_sha256: null,
        },
        metadata: (await app.database.getLiterature(fullTextId(n)))!.metadata,
        version_role: n === 1 || n === 3 ? "preprint" : "published",
        reference_count: null,
        cited_by_count: null,
        declared_keywords: [],
        reference_texts: [],
      });
    await app.writes.run(async () => {
      const db = new DatabaseSync(join(home, "catalog.sqlite"));
      try {
        db.exec("PRAGMA foreign_keys=ON;BEGIN IMMEDIATE");
        db.prepare(
          "INSERT INTO discovery_runs VALUES(?,'topic','COMPLETED','2026-11-17T00:00:00Z')",
        ).run(discovery);
        db.prepare(
          "INSERT INTO topic_discovery_inputs VALUES(?,'topic','Scope',NULL,NULL)",
        ).run(discovery);
        for (const n of selected) {
          db.prepare("INSERT INTO discovery_results VALUES(?,?)").run(
            discovery,
            meta(n),
          );
          db.prepare("INSERT INTO topic_discovery_causes VALUES(?,?,?,?)").run(
            discovery,
            meta(n),
            fullTextId(8100 + n),
            fullTextId(n),
          );
        }
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    });
    for (const n of [3, 5, 10])
      await app.database.setAutomaticPdfExhaustion(fullTextId(n));
    const withdrawn = await startIntake(
      app.database,
      "topic",
      "Withdrawn full text",
      {},
      "web",
    );
    for (const n of [9, 11])
      await app.database.writeIntake({
        operation: "member",
        member: {
          batch_id: withdrawn,
          literature_id: fullTextId(n),
          disposition: "created",
        },
      });
    await finishIntake(app.database, withdrawn, "completed");
    await new IntakeWithdrawalService(app.database).withdraw(withdrawn);
    reader = await createQueryApplication(home);
    return {
      home,
      app,
      reader,
      root,
      child,
      batch,
      discovery,
      asset,
      get modelCalls() {
        return modelCalls;
      },
      async close() {
        await reader?.close();
        await app.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await reader?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
