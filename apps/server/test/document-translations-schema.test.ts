import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { readCatalogLayout } from "../src/storage/sqlite/catalog-identity.js";
import { catalogConfigFor } from "../src/storage/sqlite/catalog-layout.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  ARCHIVE_ISSUES_ADDITION,
  DOCUMENT_TRANSLATIONS_ADDITION,
  LIBRARY_SCALE_ADDITION,
  LIBRARY_TRASH_ADDITION,
} from "../src/storage/sqlite/schema.js";
import { archiveFixture } from "./archive-fixture.js";
import { withoutDocumentTranslations } from "./document-translations-fixture.js";

it("upgrades an archived catalog to the document-translations addition with every step row kept", async () => {
  const e = await archiveFixture({ offline: true });
  try {
    await e.submit("before-translation-addition");
    const path = join(e.home, "catalog.sqlite");
    await e.app.close();
    const db = new DatabaseSync(path);
    let rows: unknown[];
    try {
      withoutDocumentTranslations(db);
      // A historical step name keeps being read after the rebuild.
      db.exec(
        "INSERT INTO archive_steps SELECT literature_id,asset_id,'document',status,input_sha256,'{\"schema_version\":1}',reason,elapsed_ms,calls,input_tokens,output_tokens,updated_at FROM archive_steps WHERE step='render'",
      );
      expect(() =>
        db
          .prepare(
            "INSERT INTO archive_steps SELECT literature_id,asset_id,'translate',status,input_sha256,output_json,reason,elapsed_ms,calls,input_tokens,output_tokens,updated_at FROM archive_steps WHERE step='render'",
          )
          .run(),
      ).toThrow(/CHECK/u);
      // The older layout is exact for the release before this addition.
      expect(
        readCatalogLayout(
          db,
          catalogConfigFor([
            LIBRARY_SCALE_ADDITION,
            ARCHIVE_ISSUES_ADDITION,
            LIBRARY_TRASH_ADDITION,
          ]),
        )?.extra_objects,
      ).toEqual([]);
      rows = db.prepare("SELECT * FROM archive_steps ORDER BY step").all();
    } finally {
      db.close();
    }
    // Start-up refuses as for every addition, naming it.
    const required = {
      reason: "catalog-addition-required",
      addition: DOCUMENT_TRANSLATIONS_ADDITION.name,
    };
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject(required);
    await expect(e.openAnother()).rejects.toMatchObject({
      code: "catalog-addition-required",
      addition: DOCUMENT_TRANSLATIONS_ADDITION.name,
    });
    const applied = await runCli(
      [
        "storage",
        "schema-apply",
        "--catalog",
        path,
        "--addition",
        DOCUMENT_TRANSLATIONS_ADDITION.name,
      ],
      { home: e.home, stdout: () => {}, stderr: () => {} },
    );
    expect(applied).toMatchObject({
      code: 0,
      value: {
        name: DOCUMENT_TRANSLATIONS_ADDITION.name,
        ddl_fingerprint: DOCUMENT_TRANSLATIONS_ADDITION.ddl_fingerprint,
      },
    });
    await expect(inspectCatalogSchema(path)).resolves.toMatchObject({
      status: "ready",
    });
    const check = new DatabaseSync(path);
    try {
      expect(
        check.prepare("SELECT * FROM archive_steps ORDER BY step").all(),
      ).toEqual(rows);
      // Indexes and state triggers on the table were recreated unchanged.
      expect(
        check
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE tbl_name='archive_steps' AND type='trigger'",
          )
          .get(),
      ).toEqual({ n: 3 });
    } finally {
      check.close();
    }
    // Applying it twice is refused and changes nothing.
    const again = await runCli(
      [
        "storage",
        "schema-apply",
        "--catalog",
        path,
        "--addition",
        DOCUMENT_TRANSLATIONS_ADDITION.name,
      ],
      { home: e.home, stdout: () => {}, stderr: () => {} },
    );
    expect(again.code).not.toBe(0);
    await e.reopen();
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    expect(state.parts[0]!.legacy_steps!.map((s) => s.step)).toContain(
      "document",
    );
    // The new step is accepted again. Its units come back from the
    // translation cache, so archiving again asks no model at all.
    const calls = e.modelCalls;
    await e.submit("after-translation-addition");
    expect(e.modelCalls).toBe(calls);
    expect(
      (await e.app.archive.status(e.id)).parts[0]!.steps.find(
        (s) => s.step === "translate",
      ),
    ).toMatchObject({ status: "done" });
  } finally {
    await e.close();
  }
}, 0);
