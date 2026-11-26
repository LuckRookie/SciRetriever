import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { readCatalogLayout } from "../src/storage/sqlite/catalog-identity.js";
import { catalogConfigFor } from "../src/storage/sqlite/catalog-layout.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  ARCHIVE_ISSUES_ADDITION,
  DOCUMENT_LAYERS_ADDITION,
  DOCUMENT_TRANSLATIONS_ADDITION,
  LIBRARY_SCALE_ADDITION,
  LIBRARY_TRASH_ADDITION,
} from "../src/storage/sqlite/schema.js";
import { archiveFixture } from "./archive-fixture.js";
import { withoutDocumentLayers } from "./document-layers-fixture.js";

it("upgrades an archived catalog without the layers table by the plain document-layers addition", async () => {
  const e = await archiveFixture({ offline: true });
  try {
    await e.submit("before-layers-addition");
    const path = join(e.home, "catalog.sqlite");
    await e.app.close();
    const db = new DatabaseSync(path);
    let objects: unknown[];
    try {
      withoutDocumentLayers(db);
      // The older layout is exact for the release before this addition.
      expect(
        readCatalogLayout(
          db,
          catalogConfigFor([
            LIBRARY_SCALE_ADDITION,
            ARCHIVE_ISSUES_ADDITION,
            LIBRARY_TRASH_ADDITION,
            DOCUMENT_TRANSLATIONS_ADDITION,
          ]),
        )?.extra_objects,
      ).toEqual([]);
      objects = db
        .prepare(
          "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
        )
        .all();
    } finally {
      db.close();
    }
    // Start-up refuses as for every addition, naming it.
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
      reason: "catalog-addition-required",
      addition: DOCUMENT_LAYERS_ADDITION.name,
    });
    await expect(e.openAnother()).rejects.toMatchObject({
      code: "catalog-addition-required",
      addition: DOCUMENT_LAYERS_ADDITION.name,
    });
    const applied = await runCli(
      [
        "storage",
        "schema-apply",
        "--catalog",
        path,
        "--addition",
        DOCUMENT_LAYERS_ADDITION.name,
      ],
      { home: e.home, stdout: () => {}, stderr: () => {} },
    );
    expect(applied).toMatchObject({
      code: 0,
      value: {
        name: DOCUMENT_LAYERS_ADDITION.name,
        ddl_fingerprint: DOCUMENT_LAYERS_ADDITION.ddl_fingerprint,
      },
    });
    // A plain addition: the table and its two indexes, nothing rebuilt, no trigger.
    expect(DOCUMENT_LAYERS_ADDITION.rebuilds).toEqual([]);
    const check = new DatabaseSync(path);
    try {
      const after = check
        .prepare(
          "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
        )
        .all() as { type: string; name: string }[];
      expect(
        after
          .filter(
            (o) =>
              !objects.some((b) => JSON.stringify(b) === JSON.stringify(o)),
          )
          .map((o) => `${o.type}:${o.name}`),
      ).toEqual([
        "index:document_layers_latest",
        "index:document_layers_version",
        "table:document_layers",
      ]);
      expect(after).toHaveLength(objects.length + 3);
    } finally {
      check.close();
    }
    await expect(inspectCatalogSchema(path)).resolves.toMatchObject({
      status: "ready",
    });
    // Applying it twice is refused.
    expect(
      (
        await runCli(
          [
            "storage",
            "schema-apply",
            "--catalog",
            path,
            "--addition",
            DOCUMENT_LAYERS_ADDITION.name,
          ],
          { home: e.home, stdout: () => {}, stderr: () => {} },
        )
      ).code,
    ).not.toBe(0);
    await e.reopen();
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    // The step runs again and registers its result (the short fixture is not applicable).
    await e.submit("after-layers-addition", undefined, "layers");
    expect(
      (await e.app.archive.status(e.id)).parts[0]!.steps.find(
        (s) => s.step === "layers",
      ),
    ).toMatchObject({
      status: "done",
      output: expect.objectContaining({
        layers: expect.objectContaining({ reason: "too-short" }),
      }),
    });
  } finally {
    await e.close();
  }
}, 0);
