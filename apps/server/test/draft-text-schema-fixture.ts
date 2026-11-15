import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { processorFixture } from "./processor-fixture.js";
import { offlineTableCounts } from "../src/storage/sqlite/archive-schema-migration.js";
import { imageBytes } from "./archive-text-fixture.js";
import { sha256 } from "@sciretriever/contracts";

function syntheticLongPdf() {
  const content = "BT /F1 14 Tf 40 740 Td (A synthetic finding.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: 51 }, (_, i) => `${i + 5} 0 R`).join(" ")}] /Count 51 >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: 51 },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(bytes));
    bytes += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(bytes);
  bytes += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(bytes);
}

/** A real offline application supplies facts; only the test projects them onto frozen v16. */
export async function draftMigrationFixture(manifest: readonly string[]) {
  const env = await processorFixture({
    offline: true,
    pageCount: 51,
    sourcePdf: syntheticLongPdf(),
    pageText: (page, text) => `${text}\n\nSynthetic page ${page}.`,
  });
  try {
    env.setResources([
      {
        reference: "images/migration.png",
        content: {
          bytes: imageBytes,
          artifact: {
            sha256: await sha256(imageBytes),
            byte_size: imageBytes.length,
            media_type: "image/png",
          },
        },
      },
    ]);
    env.setText(
      "A synthetic finding.\n\n![Synthetic diagram](images/migration.png)",
    );
    const published = await env.build(env.parseRequest);
    const document = published.document;
    const described = await env.app.documentRead.describe({
      document_version_id: document.document_version_id,
    });
    const state = await env.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "draft-migration-result",
      name: "Synthetic migration result",
      processor: { id: "summary", version: "2" },
      spec: {},
      inputs: [
        { kind: "literature", literature_id: env.parseRequest.literature_id },
      ],
    });
    if (state.failures.length)
      throw new Error("Synthetic migration result did not publish");
    await env.app.marks.manage({
      operation: "create",
      request: {
        literature_id: env.parseRequest.literature_id,
        kind: "region",
        color: "purple",
        note: "Synthetic migration note #fixture",
        pdf: {
          sha256: env.asset.sha256,
          page: 1,
          rects: [[40, 40, 100, 20]],
        },
      },
    });
    await env.app.maintenance!.refreshIndex!();
    await env.app.close();

    const source = join(env.home, "catalog.sqlite");
    const path = join(env.home, "frozen-v16.sqlite");
    const db = new DatabaseSync(path);
    try {
      db.prepare("ATTACH DATABASE ? AS fixture_source").run(source);
      db.exec("PRAGMA foreign_keys=OFF;BEGIN");
      // Do not replay fact invalidation while constructing the historic input.
      for (const sql of manifest)
        if (!sql.startsWith("CREATE TRIGGER ")) db.exec(sql);
      const names = manifest.flatMap((sql) => {
        const match = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/u.exec(
          sql,
        );
        return match ? [match[1]!] : [];
      });
      for (const name of names) {
        if (name === "schema_identity") {
          db.prepare(
            "INSERT INTO schema_identity SELECT singleton,product,16,?,created_at FROM fixture_source.schema_identity",
          ).run(
            createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
          );
          continue;
        }
        const columns = db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((row) => String(row.name));
        if (columns.some((column) => !/^[a-z_][a-z0-9_]*$/u.test(column)))
          throw new Error("Invalid synthetic schema column");
        const rowid = manifest.some((sql) =>
          sql.startsWith(`CREATE VIRTUAL TABLE ${name} `),
        )
          ? "rowid,"
          : "";
        const list = rowid + columns.join(",");
        db.exec(
          `INSERT INTO ${name}(${list}) SELECT ${list} FROM fixture_source.${name}`,
        );
      }
      for (const sql of manifest)
        if (sql.startsWith("CREATE TRIGGER ")) db.exec(sql);
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Synthetic schema-16 fixture violates foreign keys");
      db.exec("COMMIT;DETACH DATABASE fixture_source;PRAGMA foreign_keys=ON");
      return {
        env,
        path,
        document,
        longDocument: described.long_document,
        counts: offlineTableCounts(db),
        close: () => env.close(),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    await env.close();
    throw error;
  }
}
