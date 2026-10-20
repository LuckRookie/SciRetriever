import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RawParse, ArtifactRef } from "@sciretriever/contracts";

export type RawParseStorageAction =
  | "attempt"
  | "get"
  | "current"
  | "resources"
  | "publish"
  | "failure"
  | "pin"
  | "unpin"
  | "retire";
export interface RawParsePublication {
  readonly result: RawParse;
  readonly manifest: ArtifactRef & { readonly reference: string };
  readonly resources: readonly (ArtifactRef & {
    readonly reference: string;
    readonly artifact_reference: string;
    readonly kind: "blocks" | "markdown" | "private-content-list" | "image";
  })[];
}
function fail(code: string): never {
  throw Object.assign(new Error("raw parsing storage refused"), { code });
}
function one(db: DatabaseSync, sql: string, ...args: SQLInputValue[]) {
  return db.prepare(sql).get(...args) ?? null;
}
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
function register(db: DatabaseSync, reference: string, a: ArtifactRef) {
  const prior = one(
    db,
    "SELECT * FROM artifact_objects WHERE relative_path=? OR sha256=?",
    reference,
    a.sha256,
  );
  if (prior) {
    if (
      prior.relative_path !== reference ||
      prior.sha256 !== a.sha256 ||
      prior.byte_size !== a.byte_size ||
      prior.media_type !== a.media_type
    )
      fail("raw-parse-artifact-conflict");
  } else
    db.prepare(
      "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
    ).run(randomUUID(), a.sha256, a.byte_size, a.media_type, reference);
}
export function runRawParseStorage(
  db: DatabaseSync,
  action: RawParseStorageAction,
  args: unknown,
): unknown {
  if (
    ![11].includes(
      Number(
        one(db, "SELECT schema_version FROM schema_identity WHERE singleton=1")
          ?.schema_version,
      ),
    )
  )
    fail("catalog-v11-required");
  if (action === "get")
    return one(
      db,
      "SELECT * FROM raw_parses WHERE raw_parse_id=?",
      String(args),
    );
  if (action === "resources")
    return db
      .prepare(
        "SELECT * FROM raw_parse_resources WHERE raw_parse_id=? ORDER BY kind,reference",
      )
      .all(String(args));
  if (action === "current")
    return db
      .prepare(
        "SELECT c.*,p.manifest_reference,p.manifest_sha256,p.manifest_size,p.manifest_media_type,p.result_sha256,p.parameters_sha256 FROM raw_parse_current c LEFT JOIN raw_parses p ON p.raw_parse_id=c.raw_parse_id WHERE c.source_asset_id=? ORDER BY c.profile",
      )
      .all(String(args));
  return transaction(db, () => {
    if (action === "attempt") {
      const r = args as import("../../parsing/raw-service.js").RawParseAttempt;
      db.prepare(
        "INSERT INTO raw_parse_attempts(asset_id,profile,status,page_count,elapsed_ms,raw_parse_id,failure_code,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        r.asset_id,
        r.profile,
        r.status,
        r.page_count,
        r.elapsed_ms,
        r.raw_parse_id,
        r.failure_code,
        new Date().toISOString(),
      );
      return null;
    }
    if (action === "publish") {
      const p = args as RawParsePublication;
      const r = p.result;
      if (
        !one(
          db,
          "SELECT 1 FROM assets WHERE asset_id=? AND sha256=?",
          r.source_asset_id,
          r.source_sha256,
        )
      )
        fail("raw-parse-source-stale");
      const prior = one(
        db,
        "SELECT * FROM raw_parses WHERE raw_parse_id=?",
        r.raw_parse_id,
      );
      if (
        prior &&
        (prior.result_sha256 !== r.result_sha256 ||
          prior.manifest_sha256 !== p.manifest.sha256)
      )
        fail("raw-parse-conflict");
      if (!prior) {
        register(db, p.manifest.reference, p.manifest);
        for (const a of p.resources) register(db, a.artifact_reference, a);
        db.prepare(
          "INSERT INTO raw_parses(raw_parse_id,source_asset_id,source_sha256,profile,parameters_sha256,result_sha256,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          r.raw_parse_id,
          r.source_asset_id,
          r.source_sha256,
          r.profile,
          r.parameters_sha256,
          r.result_sha256,
          p.manifest.reference,
          p.manifest.sha256,
          p.manifest.byte_size,
          p.manifest.media_type,
          new Date().toISOString(),
        );
        for (const a of p.resources)
          db.prepare(
            "INSERT INTO raw_parse_resources(raw_parse_id,kind,reference,artifact_reference,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?,?)",
          ).run(
            r.raw_parse_id,
            a.kind,
            a.reference,
            a.artifact_reference,
            a.sha256,
            a.byte_size,
            a.media_type,
          );
      }
      db.prepare(
        "INSERT INTO raw_parse_current(source_asset_id,source_sha256,profile,raw_parse_id,last_parameters_sha256) VALUES(?,?,?,?,?) ON CONFLICT(source_asset_id,profile) DO UPDATE SET raw_parse_id=excluded.raw_parse_id,last_failure_code=NULL,last_parameters_sha256=excluded.last_parameters_sha256",
      ).run(
        r.source_asset_id,
        r.source_sha256,
        r.profile,
        r.raw_parse_id,
        r.parameters_sha256,
      );
      return { published: !prior };
    }
    if (action === "failure") {
      const p = args as {
        source_asset_id: string;
        source_sha256: string;
        profile: string;
        code: string;
        parameters_sha256: string;
      };
      if (
        !/^[a-z][a-z0-9-]{1,95}$/u.test(p.code) ||
        !/^[a-f0-9]{64}$/u.test(p.parameters_sha256)
      )
        fail("raw-parse-invalid-failure");
      db.prepare(
        "INSERT INTO raw_parse_current(source_asset_id,source_sha256,profile,last_failure_code,last_parameters_sha256) VALUES(?,?,?,?,?) ON CONFLICT(source_asset_id,profile) DO UPDATE SET last_failure_code=excluded.last_failure_code,last_parameters_sha256=excluded.last_parameters_sha256",
      ).run(
        p.source_asset_id,
        p.source_sha256,
        p.profile,
        p.code,
        p.parameters_sha256,
      );
      return true;
    }
    if (action === "pin" || action === "unpin") {
      const p = args as { raw_parse_id: string; proofread_id: string };
      if (action === "pin")
        db.prepare(
          "INSERT INTO raw_parse_pins(raw_parse_id,proofread_id) VALUES(?,?) ON CONFLICT DO NOTHING",
        ).run(p.raw_parse_id, p.proofread_id);
      else
        db.prepare(
          "DELETE FROM raw_parse_pins WHERE raw_parse_id=? AND proofread_id=?",
        ).run(p.raw_parse_id, p.proofread_id);
      return true;
    }
    if (action === "retire") {
      const id = String(args);
      if (
        one(db, "SELECT 1 FROM raw_parse_pins WHERE raw_parse_id=?", id) ||
        one(db, "SELECT 1 FROM raw_parse_current WHERE raw_parse_id=?", id)
      )
        fail("raw-parse-in-use");
      db.prepare("DELETE FROM raw_parse_resources WHERE raw_parse_id=?").run(
        id,
      );
      return db.prepare("DELETE FROM raw_parses WHERE raw_parse_id=?").run(id)
        .changes;
    }
    return fail("raw-parse-invalid-operation");
  });
}
