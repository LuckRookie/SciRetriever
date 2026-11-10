import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
type Item = {
  input_id: string;
  literature_id: string;
  material: null | {
    asset_id: string;
    asset_sha256: string;
    byte_size: number;
    media_type: string;
  };
  document: null | {
    document_version_id: string;
    representation_sha256: string;
  };
};
type Operation = Row & { manifest_json: string; spec_json: string };

export class ExtractionStorageFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super("extraction storage operation refused");
    this.code = code;
  }
}
function fail(code: string): never {
  throw new ExtractionStorageFailure(code);
}
function one(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number)[]
): Row | null {
  return (db.prepare(sql).get(...args) as Row | undefined) ?? null;
}
function count(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number)[]
): number {
  return Number(one(db, sql, ...args)?.n ?? 0);
}
function tx<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function readTx<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function now(): string {
  return new Date().toISOString();
}
function plus(nowValue: string, days: number): string {
  return new Date(Date.parse(nowValue) + days * 86_400_000).toISOString();
}
function v5(db: DatabaseSync): void {
  if (
    ![16].includes(
      Number(
        one(db, "SELECT schema_version FROM schema_identity WHERE singleton=1")
          ?.schema_version,
      ),
    )
  )
    fail("catalog-v5-required");
}
function operation(db: DatabaseSync, id: string): Operation | null {
  const row = one(
    db,
    "SELECT o.*,s.spec_json FROM extraction_operations o JOIN extraction_specs s ON s.caller_id=o.caller_id AND s.spec_id=o.spec_id AND s.spec_version=o.spec_version AND s.spec_sha256=o.spec_sha256 WHERE o.operation_id=?",
    id,
  );
  return row as Operation | null;
}
function receipt(db: DatabaseSync, row: Row): Row {
  const receiptId = String(row.receipt_id);
  const materials = db
    .prepare(
      "SELECT input_id,literature_id,asset_id,asset_sha256 FROM extraction_receipt_materials WHERE receipt_id=? ORDER BY input_id",
    )
    .all(receiptId);
  const documents = db
    .prepare(
      "SELECT input_id,document_version_id,representation_sha256 FROM extraction_receipt_documents WHERE receipt_id=? ORDER BY input_id",
    )
    .all(receiptId);
  return {
    ...row,
    checks: JSON.parse(String(row.checks_json)),
    protected_materials: materials,
    protected_documents: documents,
  };
}
function validReceipt(
  db: DatabaseSync,
  row: Row | null,
  time: string,
): Row | null {
  return row && String(row.receipt_expires_at) > time ? receipt(db, row) : null;
}
function receiptByKey(
  db: DatabaseSync,
  operationId: string,
  key: string,
  time: string,
): Row | null {
  return validReceipt(
    db,
    one(
      db,
      "SELECT * FROM extraction_receipts WHERE operation_id=? AND submission_key=?",
      operationId,
      key,
    ),
    time,
  );
}
function checkInputs(db: DatabaseSync, items: readonly Item[]): void {
  for (const item of items) {
    if (item.material === null) {
      if (
        !one(
          db,
          "SELECT 1 FROM literatures WHERE literature_id=?",
          item.literature_id,
        )
      )
        fail("input-stale");
      if (
        count(
          db,
          "SELECT count(*) AS n FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role IN ('primary-pdf','supplementary-pdf') AND a.media_type='application/pdf'",
          item.literature_id,
        )
      )
        fail("input-stale");
      continue;
    }
    const material = item.material;
    const asset = one(
      db,
      "SELECT a.sha256,a.size_bytes,a.media_type FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.asset_id=? AND l.role IN ('primary-pdf','supplementary-pdf')",
      item.literature_id,
      material.asset_id,
    );
    if (
      !asset ||
      asset.sha256 !== material.asset_sha256 ||
      asset.size_bytes !== material.byte_size ||
      asset.media_type !== material.media_type
    )
      fail("input-stale");
    if (item.document !== null) {
      const document = one(
        db,
        "SELECT literature_id,source_asset_id,source_sha256,representation_sha256 FROM document_versions WHERE document_version_id=?",
        item.document.document_version_id,
      );
      if (
        !document ||
        document.literature_id !== item.literature_id ||
        document.source_asset_id !== material.asset_id ||
        document.source_sha256 !== material.asset_sha256 ||
        document.representation_sha256 !== item.document.representation_sha256
      )
        fail("input-stale");
    }
  }
}
type Create = {
  caller_id: string;
  spec_id: string;
  spec_version: string;
  spec_sha256: string;
  spec_json: string;
  manifest_sha256: string;
  manifest_json: string;
};
type Submit = {
  operation_id: string;
  submission_key: string;
  batch_id: string;
  submission_sha256: string;
  checks_json: string;
};

export function runExtractionStorage(
  db: DatabaseSync,
  action:
    | "create"
    | "operation"
    | "receipt"
    | "receipt-key"
    | "submit"
    | "close"
    | "cancel"
    | "cleanup",
  args: unknown,
): unknown {
  v5(db);
  if (action === "operation") return operation(db, String(args));
  if (action === "receipt") {
    return readTx(db, () =>
      validReceipt(
        db,
        one(
          db,
          "SELECT * FROM extraction_receipts WHERE receipt_id=?",
          String(args),
        ),
        now(),
      ),
    );
  }
  if (action === "receipt-key") {
    const input = args as { operation_id: string; submission_key: string };
    return readTx(db, () =>
      receiptByKey(db, input.operation_id, input.submission_key, now()),
    );
  }
  if (action === "create")
    return tx(db, () => {
      const input = args as Create;
      const time = now();
      if (
        count(
          db,
          "SELECT count(*) AS n FROM extraction_operations o WHERE o.accept_until>? OR EXISTS(SELECT 1 FROM extraction_receipts r WHERE r.operation_id=o.operation_id AND r.receipt_expires_at>?)",
          time,
          time,
        ) >= 1000
      )
        fail("operation-capacity");
      const existing = one(
        db,
        "SELECT spec_sha256 FROM extraction_specs WHERE caller_id=? AND spec_id=? AND spec_version=?",
        input.caller_id,
        input.spec_id,
        input.spec_version,
      );
      if (existing && existing.spec_sha256 !== input.spec_sha256)
        fail("spec-conflict");
      const items = (JSON.parse(input.manifest_json) as { items: Item[] })
        .items;
      checkInputs(db, items);
      if (!existing)
        db.prepare(
          "INSERT INTO extraction_specs(caller_id,spec_id,spec_version,spec_sha256,spec_json) VALUES(?,?,?,?,?)",
        ).run(
          input.caller_id,
          input.spec_id,
          input.spec_version,
          input.spec_sha256,
          input.spec_json,
        );
      const id = randomUUID();
      const until = plus(time, 1);
      db.prepare(
        "INSERT INTO extraction_operations(operation_id,caller_id,spec_id,spec_version,spec_sha256,manifest_sha256,manifest_json,status,created_at,accept_until,closed_at) VALUES(?,?,?,?,?,?,?,'open',?,?,NULL)",
      ).run(
        id,
        input.caller_id,
        input.spec_id,
        input.spec_version,
        input.spec_sha256,
        input.manifest_sha256,
        input.manifest_json,
        time,
        until,
      );
      return operation(db, id);
    });
  if (action === "submit")
    return tx(db, () => {
      const input = args as Submit;
      const time = now();
      const historical = receiptByKey(
        db,
        input.operation_id,
        input.submission_key,
        time,
      );
      if (historical) {
        if (historical.submission_sha256 !== input.submission_sha256)
          fail("submission-conflict");
        return historical;
      }
      if (
        one(
          db,
          "SELECT 1 FROM extraction_receipts WHERE operation_id=? AND submission_key=?",
          input.operation_id,
          input.submission_key,
        )
      )
        fail("unknown-or-expired");
      const op = operation(db, input.operation_id);
      if (!op) fail("unknown-or-expired");
      if (
        one(
          db,
          "SELECT 1 FROM extraction_receipts WHERE operation_id=? AND batch_id=? AND receipt_expires_at>?",
          input.operation_id,
          input.batch_id,
          time,
        )
      )
        fail("batch-conflict");
      if (op.status !== "open") fail("operation-not-open");
      if (String(op.accept_until) <= time) fail("operation-expired");
      if (
        count(
          db,
          "SELECT count(*) AS n FROM extraction_receipts WHERE operation_id=?",
          input.operation_id,
        ) >= 64
      )
        fail("batch-capacity");
      if (
        count(
          db,
          "SELECT count(*) AS n FROM extraction_receipts WHERE receipt_expires_at>?",
          time,
        ) >= 10000
      )
        fail("receipt-capacity");
      const items = (JSON.parse(op.manifest_json) as { items: Item[] }).items;
      checkInputs(db, items);
      const receiptId = randomUUID();
      const expires = plus(time, 30);
      db.prepare(
        "INSERT INTO extraction_receipts(receipt_id,operation_id,submission_key,batch_id,submission_sha256,accepted_at,receipt_expires_at,protection_expires_at,checks_json) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        receiptId,
        input.operation_id,
        input.submission_key,
        input.batch_id,
        input.submission_sha256,
        time,
        expires,
        expires,
        input.checks_json,
      );
      for (const item of items) {
        if (!item.material) continue;
        db.prepare(
          "INSERT INTO extraction_receipt_materials(receipt_id,input_id,literature_id,asset_id,asset_sha256) VALUES(?,?,?,?,?)",
        ).run(
          receiptId,
          item.input_id,
          item.literature_id,
          item.material.asset_id,
          item.material.asset_sha256,
        );
        if (item.document)
          db.prepare(
            "INSERT INTO extraction_receipt_documents(receipt_id,input_id,document_version_id,representation_sha256) VALUES(?,?,?,?)",
          ).run(
            receiptId,
            item.input_id,
            item.document.document_version_id,
            item.document.representation_sha256,
          );
      }
      return receipt(
        db,
        one(
          db,
          "SELECT * FROM extraction_receipts WHERE receipt_id=?",
          receiptId,
        )!,
      );
    });
  if (action === "close" || action === "cancel")
    return tx(db, () => {
      const id = String(args);
      const op = operation(db, id);
      if (!op) fail("unknown-or-expired");
      if (
        op.status !== "open" &&
        op.status !== (action === "close" ? "closed" : "cancelled")
      )
        fail("operation-not-open");
      if (op.status === "open")
        db.prepare(
          "UPDATE extraction_operations SET status=?,closed_at=? WHERE operation_id=? AND status='open'",
        ).run(action === "close" ? "closed" : "cancelled", now(), id);
      return operation(db, id);
    });
  if (action === "cleanup")
    return tx(db, () => {
      const limit = args;
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 1000
      )
        fail("invalid-cleanup-limit");
      const time = now();
      const expired = db
        .prepare(
          "SELECT receipt_id FROM extraction_receipts WHERE receipt_expires_at<=? AND protection_expires_at<=? ORDER BY receipt_expires_at,receipt_id LIMIT ?",
        )
        .all(time, time, limit as number) as { receipt_id: string }[];
      for (const item of expired)
        db.prepare("DELETE FROM extraction_receipts WHERE receipt_id=?").run(
          item.receipt_id,
        );
      const remaining = (limit as number) - expired.length;
      const stale =
        remaining > 0
          ? (db
              .prepare(
                "SELECT operation_id FROM extraction_operations o WHERE accept_until<=? AND NOT EXISTS(SELECT 1 FROM extraction_receipts r WHERE r.operation_id=o.operation_id) ORDER BY accept_until,operation_id LIMIT ?",
              )
              .all(time, remaining) as { operation_id: string }[])
          : [];
      for (const item of stale)
        db.prepare(
          "DELETE FROM extraction_operations WHERE operation_id=?",
        ).run(item.operation_id);
      return {
        receipts_deleted: expired.length,
        operations_deleted: stale.length,
      };
    });
  return fail("invalid-action");
}
