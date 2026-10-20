import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { parseAsset, sha256 } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
export const lit = FIXTURE_LITERATURE.literature_id;
/** Orphan publication bytes exercise recovery without a retired business deletion policy. */
export async function reclamationFixture(registered = false) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-reclamation-"));
  await initializeCatalogSchema(join(home, "catalog.sqlite"));
  const app = await createApplication(home);
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    await app.maintenance!.ingestPdf({
      literature_id: lit,
      bytes: workbenchPdf(),
    });
    const bytes = Buffer.concat([
        workbenchPdf(),
        Buffer.from("\n% Unreferenced synthetic publication\n"),
      ]),
      hash = await sha256(bytes),
      reference = `originals/pdf/${hash}.pdf`;
    const stage = await app.files.stage();
    await stage.write(bytes);
    await app.files.publish(stage, reference);
    const primary = parseAsset({
        asset_id: randomUUID(),
        sha256: hash,
        size_bytes: bytes.length,
        media_type: "application/pdf",
        path: reference,
      }),
      artifacts = [
        {
          reference,
          artifact: {
            sha256: hash,
            byte_size: bytes.length,
            media_type: "application/pdf",
          },
        },
      ];
    if (registered) await app.database.putAsset(primary);
    return {
      home,
      app,
      primary,
      retired: artifacts,
      artifacts,
      before: await app.library.detail(lit),
      journal: join(app.files.root, ".reclamation"),
      async unregister() {
        await app.writes.run(async () => {
          const db = new DatabaseSync(join(home, "catalog.sqlite"));
          try {
            db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
            db.prepare("DELETE FROM assets WHERE asset_id=?").run(
              primary.asset_id,
            );
            db.prepare(
              "DELETE FROM artifact_objects WHERE relative_path=?",
            ).run(reference);
            db.exec("COMMIT");
          } finally {
            db.close();
          }
        });
      },
      async close() {
        await app.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
