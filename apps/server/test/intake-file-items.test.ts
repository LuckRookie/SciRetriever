import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  SCHEMA_MANIFEST_V16,
  LIBRARY_STATE_INPUT_TABLES_V16,
} from "../src/storage/sqlite/schema.js";

it("finds all file-item, recognition and needs-metadata storage in the frozen schema 16", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of SCHEMA_MANIFEST_V16) db.exec(sql);
    const columns = (table: string) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name);
    for (const [table, required] of Object.entries({
      intake_batches: [
        "state",
        "result",
        "confirmation",
        "confirmed_at",
        "initiated_by",
      ],
      import_sessions: ["batch_id", "active", "phase", "storage_failures"],
      import_parts: ["batch_id"],
      import_staged_keys: ["batch_id"],
      import_record_results: ["batch_id", "item_id", "disposition"],
      intake_open_batches: ["opener", "day", "batch_id"],
      intake_page_requests: [
        "connection_id",
        "request_id",
        "request_sha256",
        "item_id",
        "batch_id",
      ],
      intake_batch_objects: ["object_kind", "object_id", "batch_id"],
      intake_withdrawals: [
        "batch_id",
        "prior_state",
        "withdrawn_at",
        "withdrawn_by",
        "restored_at",
        "report_json",
        "restoration_json",
      ],
      intake_withdrawn_objects: [
        "object_kind",
        "object_id",
        "batch_id",
        "withdrawn_at",
      ],
    }))
      expect(columns(table), table).toEqual(expect.arrayContaining(required));
    expect(columns("intake_batches")).not.toContain("status");
    expect(columns("import_sessions")).not.toContain("state");
    for (const table of [
      "import_sessions",
      "import_parts",
      "import_staged_keys",
      "import_record_results",
      "import_files",
    ])
      expect(columns(table)).not.toContain("session_id");
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('capture_daily_batches','capture_items')",
        )
        .all(),
    ).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('import_sessions_active_library','device_exchange_limits_window')",
        )
        .all(),
    ).toHaveLength(2);
    expect(columns("intake_items")).toEqual(
      expect.arrayContaining([
        "item_id",
        "batch_id",
        "origin",
        "sequence",
        "record_index",
        "external_id",
        "title",
        "file_name",
        "candidate_transfer_id",
        "recognition_json",
        "possible_duplicates_json",
        "unpaired",
        "needs_decision",
        "decision_json",
        "decided_by",
        "decided_at",
        "disposition",
        "literature_id",
        "retain_until",
        "created_at",
      ]),
    );
    expect(columns("literature_needs_metadata")).toEqual([
      "literature_id",
      "set_at",
      "batch_id",
    ]);
    expect(columns("import_files")).toEqual(
      expect.arrayContaining(["item_id", "source_url"]),
    );
    expect(columns("external_object_mappings")).toContain("state");
    expect(db.prepare("PRAGMA foreign_key_list(intake_items)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "execution_candidates",
          from: "candidate_transfer_id",
          to: "transfer_id",
          on_delete: "RESTRICT",
        }),
        expect.objectContaining({
          table: "intake_batches",
          from: "batch_id",
          on_delete: "CASCADE",
        }),
        expect.objectContaining({
          table: "literatures",
          from: "literature_id",
          on_delete: "SET NULL",
        }),
      ]),
    );
    expect(
      db.prepare("PRAGMA foreign_key_list(literature_needs_metadata)").all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "literatures",
          from: "literature_id",
          on_delete: "CASCADE",
        }),
        expect.objectContaining({
          table: "intake_batches",
          from: "batch_id",
          on_delete: "SET NULL",
        }),
      ]),
    );
    for (const table of [
      "intake_items",
      "literature_needs_metadata",
      "intake_batch_objects",
      "intake_withdrawals",
      "intake_withdrawn_objects",
    ])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('intake_items_batch','intake_items_retention')",
        )
        .all(),
    ).toHaveLength(2);
    expect(LIBRARY_STATE_INPUT_TABLES_V16).not.toContain("intake_items");
    expect(LIBRARY_STATE_INPUT_TABLES_V16).not.toContain(
      "literature_needs_metadata",
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
