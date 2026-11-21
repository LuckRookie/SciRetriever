import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { IntakeWithdrawalService } from "../src/literature/intake-withdrawal.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { withdrawalFixture } from "./intake-withdrawal-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const paper = (literatureId: string, title: string) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: literatureId,
    meta_literature_id: literatureId,
    metadata: { ...FIXTURE_LITERATURE.metadata, title, identifiers: [] },
  });
const legacyInsert =
  "INSERT INTO literature_search_fts(literature_id,title,content_body) VALUES(?,?,?)";

it("replaces the FTS row on metadata rewrite and removes and restores it on withdrawal", async () => {
  const f = await withdrawalFixture();
  try {
    const imported = await f.app.importSessions.importBibliography(
      Buffer.from(
        "@article{a,title={Originaltitle},doi={10.5555/fts-rewrite-a}}",
      ),
      "bibtex",
      "rewrite.bib",
      "web",
    );
    const literatureId = imported.items[0]!.literature_id!,
      batchId = imported.intake_batch_id!,
      searchRows = () =>
        f.rows(
          "SELECT rowid FROM literature_search_fts WHERE literature_id=?",
          literatureId,
        ),
      matching = (query: string) =>
        f.rows(
          "SELECT literature_id FROM literature_search_fts WHERE literature_search_fts MATCH ?",
          query,
        );
    expect(searchRows()).toHaveLength(1);
    expect(matching("originaltitle")).toEqual([
      { literature_id: literatureId },
    ]);
    const current = (await f.app.database.getLiterature(literatureId))!;
    await f.app.database.putLiterature(
      parseLiterature({
        ...current,
        metadata: { ...current.metadata, title: "Rewrittentitle" },
      }),
    );
    expect(searchRows()).toHaveLength(1);
    expect(matching("originaltitle")).toEqual([]);
    expect(matching("rewrittentitle")).toEqual([
      { literature_id: literatureId },
    ]);
    const service = new IntakeWithdrawalService(f.app.database);
    expect(await service.withdraw(batchId)).toMatchObject({
      remove: { literatures: 1 },
    });
    expect(searchRows()).toEqual([]);
    expect(matching("rewrittentitle")).toEqual([]);
    await service.restore(batchId);
    expect(searchRows()).toHaveLength(1);
    expect(matching("rewrittentitle")).toEqual([
      { literature_id: literatureId },
    ]);
    expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rewrites legacy DELETE/INSERT rows after rowid reuse and preserves the first old body", async () => {
  const f = await withdrawalFixture();
  const legacy = new DatabaseSync(join(f.home, "catalog.sqlite"), {
    enableForeignKeyConstraints: false,
  });
  try {
    for (const n of [1, 2, 3])
      await f.app.database.putLiterature(paper(id(n), "Initial"));
    legacy.exec("BEGIN IMMEDIATE");
    const remove = legacy.prepare(
      "DELETE FROM literature_search_fts WHERE literature_id=?",
    );
    const insert = legacy.prepare(legacyInsert);
    remove.run(id(2));
    remove.run(id(3));
    insert.run(id(4), "Newlegacyrow", "fourthbody");
    insert.run(id(2), "Existinglegacyrow", "secondbody");
    // Legacy data can contain duplicates. Rewriting removes every old row.
    insert.run(id(2), "Duplicatelegacyrow", "duplicatebody");
    legacy.exec("COMMIT");
    expect(
      f.rows(
        "SELECT rowid,literature_id FROM literature_search_fts ORDER BY rowid",
      ),
    ).toEqual([
      { rowid: 1, literature_id: id(1) },
      { rowid: 2, literature_id: id(4) },
      { rowid: 3, literature_id: id(2) },
      { rowid: 4, literature_id: id(2) },
    ]);
    for (const n of [2, 4, 5])
      await f.app.database.putLiterature(paper(id(n), "Newwriter"));
    expect(
      f.rows(
        "SELECT literature_id,title,content_body FROM literature_search_fts ORDER BY literature_id",
      ),
    ).toEqual([
      { literature_id: id(1), title: "initial", content_body: "" },
      { literature_id: id(2), title: "newwriter", content_body: "secondbody" },
      { literature_id: id(4), title: "newwriter", content_body: "fourthbody" },
      { literature_id: id(5), title: "newwriter", content_body: "" },
    ]);
  } finally {
    legacy.close();
    await f.close();
  }
});
