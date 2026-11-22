import type { DatabaseSync } from "node:sqlite";
import { deviceKind, type DeviceConnection } from "@sciretriever/contracts";

export type DeviceStorageCommand =
  | {
      kind: "create";
      connection: DeviceConnection;
      code_sha256: string;
      expires_at: string;
    }
  | {
      kind: "exchange";
      code_sha256: string;
      token_sha256: string;
      peer_sha256: string;
      now: string;
    }
  | { kind: "authenticate"; token_sha256: string; now: string }
  | { kind: "list"; after: string | null }
  | { kind: "check"; connection_id: string }
  | { kind: "rename"; connection_id: string; name: string }
  | { kind: "revoke"; connection_id: string; now: string };
type Row = Record<string, import("node:sqlite").SQLOutputValue>;
function safe(row: Row): DeviceConnection {
  return {
    connection_id: String(row.connection_id),
    name: String(row.name),
    purposes: JSON.parse(String(row.purposes_json)),
    kind: deviceKind(row.kind),
    created_at: String(row.created_at),
    paired_at: row.paired_at === null ? null : String(row.paired_at),
    last_used_at: row.last_used_at === null ? null : String(row.last_used_at),
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
  };
}
/** Only derived authentication material crosses the storage boundary. */
export function runDeviceStorage(db: DatabaseSync, r: DeviceStorageCommand) {
  if (r.kind === "authenticate") {
    const d = db
      .prepare(
        "SELECT connection_id,name,purposes_json,token_sha256,created_at,paired_at,last_used_at,revoked_at,kind FROM device_connections WHERE token_sha256=?",
      )
      .get(r.token_sha256);
    if (!d) return { code: "device-token-invalid" };
    if (d.revoked_at !== null) return { code: "device-revoked" };
    if (
      d.last_used_at !== null &&
      Date.parse(r.now) - Date.parse(String(d.last_used_at)) < 300_000
    )
      return { connection: safe(d) };
    // Recheck inside the write transaction when the coalesced timestamp is due.
  }
  if (r.kind === "check") {
    const d = db
      .prepare(
        "SELECT connection_id,name,purposes_json,token_sha256,created_at,paired_at,last_used_at,revoked_at,kind FROM device_connections WHERE connection_id=?",
      )
      .get(r.connection_id);
    if (!d || d.paired_at === null || d.token_sha256 === null)
      return { code: "device-token-invalid" };
    return d.revoked_at !== null
      ? { code: "device-revoked" }
      : { connection: safe(d) };
  }
  if (r.kind === "list") {
    const rows = db
      .prepare(
        "SELECT connection_id,name,purposes_json,token_sha256,created_at,paired_at,last_used_at,revoked_at,kind FROM device_connections WHERE connection_id>? ORDER BY connection_id LIMIT 201",
      )
      .all(r.after ?? "");
    return {
      items: rows.slice(0, 200).map(safe),
      next_cursor: rows.length > 200 ? String(rows[199]!.connection_id) : null,
    };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    let result: unknown;
    if (r.kind === "create") {
      const d = r.connection;
      db.prepare(
        "INSERT INTO device_connections(connection_id,name,purposes_json,kind,token_sha256,created_at,paired_at,last_used_at,revoked_at) VALUES(?,?,?,?,NULL,?,NULL,NULL,NULL)",
      ).run(
        d.connection_id,
        d.name,
        JSON.stringify(d.purposes),
        d.kind,
        d.created_at,
      );
      db.prepare(
        "INSERT INTO device_pairings(code_sha256,connection_id,expires_at,used_at) VALUES(?,?,?,NULL)",
      ).run(r.code_sha256, d.connection_id, r.expires_at);
      result = { connection: d };
    } else if (r.kind === "exchange") {
      const now = Date.parse(r.now),
        windowMs = 60_000;
      db.prepare(
        "DELETE FROM device_exchange_limits WHERE window_start<=?",
      ).run(now - windowMs);
      const bucket = db
        .prepare("SELECT attempts FROM device_exchange_limits WHERE bucket=?")
        .get(r.peer_sha256);
      if (Number(bucket?.attempts ?? 0) >= 30)
        result = { code: "device-exchange-rate-limited" };
      else {
        if (
          !bucket &&
          Number(
            db.prepare("SELECT count(*) n FROM device_exchange_limits").get()!
              .n,
          ) >= 256
        )
          db.exec(
            "DELETE FROM device_exchange_limits WHERE bucket=(SELECT bucket FROM device_exchange_limits ORDER BY window_start,bucket LIMIT 1)",
          );
        db.prepare(
          "INSERT INTO device_exchange_limits(bucket,window_start,attempts) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1",
        ).run(r.peer_sha256, now);
        const p = db
          .prepare(
            "SELECT code_sha256,connection_id,expires_at,used_at FROM device_pairings WHERE code_sha256=?",
          )
          .get(r.code_sha256);
        if (!p) result = { code: "device-pairing-invalid" };
        else if (p.used_at !== null) result = { code: "device-pairing-used" };
        else if (String(p.expires_at) <= r.now)
          result = { code: "device-pairing-expired" };
        else {
          const d = db
            .prepare(
              "SELECT connection_id,name,purposes_json,token_sha256,created_at,paired_at,last_used_at,revoked_at,kind FROM device_connections WHERE connection_id=?",
            )
            .get(p.connection_id!);
          if (!d || d.revoked_at !== null) result = { code: "device-revoked" };
          else {
            db.prepare(
              "UPDATE device_pairings SET used_at=? WHERE code_sha256=?",
            ).run(r.now, r.code_sha256);
            db.prepare(
              "UPDATE device_connections SET token_sha256=?,paired_at=? WHERE connection_id=?",
            ).run(r.token_sha256, r.now, p.connection_id!);
            result = { connection: safe({ ...d, paired_at: r.now }) };
          }
        }
      }
    } else if (r.kind === "authenticate") {
      const d = db
        .prepare(
          "SELECT connection_id,name,purposes_json,token_sha256,created_at,paired_at,last_used_at,revoked_at,kind FROM device_connections WHERE token_sha256=?",
        )
        .get(r.token_sha256);
      if (!d) result = { code: "device-token-invalid" };
      else if (d.revoked_at !== null) result = { code: "device-revoked" };
      else if (
        d.last_used_at === null ||
        Date.parse(r.now) - Date.parse(String(d.last_used_at)) >= 300_000
      ) {
        db.prepare(
          "UPDATE device_connections SET last_used_at=? WHERE connection_id=?",
        ).run(r.now, d.connection_id!);
        result = { connection: safe({ ...d, last_used_at: r.now }) };
      } else result = { connection: safe(d) };
    } else {
      const d = db
        .prepare(
          "SELECT connection_id,name,purposes_json,token_sha256,created_at,paired_at,last_used_at,revoked_at,kind FROM device_connections WHERE connection_id=?",
        )
        .get(r.connection_id);
      if (!d) result = { code: "device-connection-missing" };
      else if (r.kind === "rename") {
        db.prepare(
          "UPDATE device_connections SET name=? WHERE connection_id=?",
        ).run(r.name, r.connection_id);
        result = { connection: safe({ ...d, name: r.name }) };
      } else {
        const revoked = d.revoked_at ?? r.now;
        db.prepare(
          "UPDATE device_connections SET revoked_at=? WHERE connection_id=?",
        ).run(revoked, r.connection_id);
        result = { connection: safe({ ...d, revoked_at: revoked }) };
      }
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
