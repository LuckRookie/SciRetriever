import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  parseTag,
  tagAssignmentHash,
  type TagListItem,
} from "@sciretriever/contracts";
import { SCHEMA_MANIFEST } from "../src/storage/sqlite/schema.js";
import { runTagStorage } from "../src/storage/sqlite/tag-engine.js";
import type { TagPage } from "../src/tags/service.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("counts direct papers including zero uses across pages, without per-tag queries", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA_MANIFEST.join(";"));
    for (let n = 1; n <= 5; n++) {
      const tag = parseTag({
        tag_id: id(n),
        name_en: `Topic ${n}`,
        name_zh: "",
        aliases: [],
        definition: { includes: `Topic ${n}`, excludes: "" },
        parent_id: n === 3 ? id(1) : null,
        category: n === 3 ? "Child" : "General",
        kind: "topic",
        status: n === 5 ? "merged" : "active",
        merged_into: n === 5 ? id(1) : null,
        locked: false,
        created_vocab_version: n,
        backfilled_vocab_version: null,
        examples: [],
      });
      db.prepare("INSERT INTO tags VALUES(?,?,?,?,0,?,NULL,?)").run(
        tag.tag_id,
        tag.parent_id,
        tag.status,
        tag.merged_into,
        n,
        JSON.stringify(tag),
      );
      if (tag.status === "active") {
        db.prepare("INSERT INTO tag_search VALUES(?,?,?)").run(
          tag.tag_id,
          tag.name_en,
          tag.definition.includes,
        );
        db.prepare("INSERT INTO tag_aliases VALUES(?,?)").run(
          tag.name_en.toLowerCase(),
          tag.tag_id,
        );
      }
    }
    db.exec("BEGIN");
    for (const [index, numbers] of [[1, 3], [3, 4], [4]].entries()) {
      const literature = id(100 + index),
        meta = id(200 + index);
      db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(
        meta,
        literature,
      );
      db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(
        literature,
        meta,
      );
      const items = numbers.map((n, rank) => ({
        tag_id: id(n),
        rank: rank + 1,
        reason: "Synthetic",
        evidence: [{ document_version_id: id(999), segment_ids: ["p0"] }],
        origin: "manual" as const,
        locked: false,
      }));
      const assignment = {
        literature_id: literature,
        items,
        revision: 1,
        vocab_version: 5,
        model: null,
        assignment_sha256: await tagAssignmentHash({
          literature_id: literature,
          items,
        }),
      };
      db.prepare(
        "INSERT INTO literature_tag_assignments VALUES(?,1,5,?,?)",
      ).run(
        literature,
        assignment.assignment_sha256,
        JSON.stringify(assignment),
      );
      for (const item of items)
        db.prepare("INSERT INTO literature_tag_items VALUES(?,?,?,0)").run(
          literature,
          item.tag_id,
          item.rank,
        );
    }
    db.exec("COMMIT");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const prepare = vi.spyOn(db, "prepare");
    const list = (request: object) =>
      runTagStorage(db, "list", request) as TagPage;
    const first = list({ limit: 2 });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(
      prepare.mock.calls.filter(([sql]) =>
        sql.includes("literature_tag_items"),
      ),
    ).toHaveLength(1);
    prepare.mockRestore();
    expect(first).toMatchObject({
      total: 4,
      next_offset: 2,
      items: [
        { tag_id: id(4), uses: 2 },
        { tag_id: id(3), uses: 2 },
      ],
    });
    const second = list({ limit: 2, offset: first.next_offset });
    expect(second).toMatchObject({
      total: 4,
      next_offset: null,
      items: [
        { tag_id: id(2), uses: 0 },
        { tag_id: id(1), uses: 1 },
      ],
    });
    expect(list({ limit: 2, offset: 4 })).toEqual({
      items: [],
      total: 4,
      next_offset: null,
    });
    for (const item of [...first.items, ...second.items]) {
      expect(runTagStorage(db, "get", { tag_id: item.tag_id })).toMatchObject({
        uses: item.uses,
      });
    }
    expect(list({ parent_id: id(1) }).items).toMatchObject([
      { tag_id: id(3), uses: 2 },
    ]);
    expect(list({ category: "Child" }).items).toMatchObject([
      { tag_id: id(3), uses: 2 },
    ]);
    expect(
      list({ query: "Topic 3" }).items.find((t) => t.tag_id === id(3))?.uses,
    ).toBe(2);
    expect(list({ query: "missing" })).toEqual({
      items: [],
      total: 0,
      next_offset: null,
    });
    expect(list({ query: "!!!" })).toEqual({
      items: [],
      total: 0,
      next_offset: null,
    });
    expect(list({ status: "merged" }).items).toMatchObject([
      { tag_id: id(5), uses: 0 },
    ]);
    db.prepare(
      "DELETE FROM literature_tag_items WHERE literature_id=? AND tag_id=?",
    ).run(id(102), id(4));
    expect(
      list({}).items.find((t: TagListItem) => t.tag_id === id(4))?.uses,
    ).toBe(1);
  } finally {
    db.close();
  }
});
