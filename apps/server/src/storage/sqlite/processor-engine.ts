import { PROCESSOR_METHOD_REVISION } from "@sciretriever/contracts";
import type * as Freshness from "./processor-freshness.js";
const { bindProcessorFreshness, readProcessorFreshness }: typeof Freshness =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./processor-freshness.ts"
        : "./processor-freshness.js",
      import.meta.url,
    ).href
  );
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ProcessorInput } from "@sciretriever/contracts";

type Row = Record<string, unknown>;
export class ProcessorStorageFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super("processor storage operation refused");
    this.code = code;
  }
}
function fail(code: string): never {
  throw new ProcessorStorageFailure(code);
}
function one(
  db: DatabaseSync,
  sql: string,
  ...args: SQLInputValue[]
): Row | null {
  return (db.prepare(sql).get(...args) as Row | undefined) ?? null;
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
export interface ProcessorPublication {
  readonly usage?: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
  } | null;
  readonly outcomes?: import("@sciretriever/contracts").ProcessorOutcomeCounts;
  readonly reads: import("@sciretriever/contracts").ProcessorReads;
  readonly uses_description: boolean;
  readonly result_id: string;
  readonly comparison_sha256: string;
  readonly processor_id: string;
  readonly processor_version: string;
  readonly complete: boolean;
  readonly producer: string;
  readonly reference: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly media_type: string;
  readonly created_at: string;
  readonly inputs: readonly ProcessorInput[];
}
export interface ProcessorProjection {
  readonly result_id: string;
  readonly content_sha256: string;
  readonly records: readonly {
    readonly record_id: string;
    readonly payload: object;
  }[];
  readonly text: string;
}
export interface ProcessorCollectionPublication {
  readonly collection_id: string;
  readonly run_id: string;
  readonly name: string;
  readonly processor_id: string;
  readonly spec_json: string;
  readonly reference: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly media_type: string;
  readonly created_at: string;
  readonly members: readonly {
    readonly target_id: string;
    readonly result: {
      readonly result_id: string;
      readonly content_sha256: string;
    } | null;
    readonly gap: string | null;
  }[];
}
function artifact(
  db: DatabaseSync,
  p: Pick<
    ProcessorPublication,
    "reference" | "sha256" | "byte_size" | "media_type" | "created_at"
  >,
): void {
  const old = one(
    db,
    "SELECT sha256,byte_size,media_type FROM artifact_objects WHERE relative_path=?",
    p.reference,
  );
  if (old) {
    if (
      old.sha256 !== p.sha256 ||
      old.byte_size !== p.byte_size ||
      old.media_type !== p.media_type
    )
      fail("processor-artifact-conflict");
    return;
  }
  db.prepare(
    "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
  ).run(randomUUID(), p.sha256, p.byte_size, p.media_type, p.reference);
}
function publish(db: DatabaseSync, p: ProcessorPublication): Row {
  return tx(db, () => {
    const existing = one(
      db,
      "SELECT * FROM processor_results WHERE result_id=?",
      p.result_id,
    );
    if (existing) {
      if (existing.content_sha256 !== p.sha256)
        fail("processor-publication-conflict");
      return existing;
    }
    if (p.complete && p.producer === "internal") {
      const previous = one(
        db,
        "SELECT * FROM processor_results WHERE comparison_sha256=? AND complete=1 AND producer='internal'",
        p.comparison_sha256,
      );
      if (previous) return previous;
    }
    artifact(db, p);
    db.prepare(
      "INSERT INTO processor_results(result_id,comparison_sha256,processor_id,processor_version,complete,producer,content_reference,content_sha256,content_size,content_media_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      p.result_id,
      p.comparison_sha256,
      p.processor_id,
      p.processor_version,
      Number(p.complete),
      p.producer,
      p.reference,
      p.sha256,
      p.byte_size,
      p.media_type,
      p.created_at,
    );
    if (p.outcomes)
      db.prepare("INSERT INTO processor_result_summaries VALUES(?,?,?,?)").run(
        p.result_id,
        p.usage ? JSON.stringify(p.usage) : null,
        JSON.stringify(p.outcomes),
        PROCESSOR_METHOD_REVISION,
      );
    for (const input of p.inputs) {
      if (input.kind === "snapshot")
        db.prepare(
          "INSERT OR IGNORE INTO processor_result_literatures SELECT ?,literature_id FROM snapshot_members WHERE snapshot_id=?",
        ).run(p.result_id, input.snapshot_id);
      else
        db.prepare(
          "INSERT OR IGNORE INTO processor_result_literatures VALUES(?,?)",
        ).run(p.result_id, input.literature_id);
      if (input.kind === "archive-document") {
        for (const part of input.parts)
          if (part.available) {
            const d = one(
              db,
              "SELECT d.* FROM document_versions d JOIN structure_annotations a ON a.document_version_id=d.document_version_id WHERE d.document_version_id=? AND d.literature_id=? AND d.source_asset_id=? AND d.source_sha256=? AND d.schema_version=2 AND a.annotation_id=?",
              part.document_version_id!,
              input.literature_id,
              part.asset_id,
              part.asset_sha256,
              part.structure_annotation_id!,
            );
            if (!d) fail("processor-input-changed");
            db.prepare(
              "INSERT OR IGNORE INTO processor_result_documents VALUES(?,?,?,?,?,?)",
            ).run(
              p.result_id,
              input.literature_id,
              part.asset_id,
              part.asset_sha256,
              part.document_version_id!,
              String(d.representation_sha256),
            );
          }
      } else if (input.kind === "snapshot") {
        const snapshot = one(
          db,
          "SELECT content_sha256 FROM snapshots WHERE snapshot_id=?",
          input.snapshot_id,
        );
        if (snapshot?.content_sha256 !== input.content_sha256)
          fail("processor-input-changed");
        for (const source of input.mapped_results)
          db.prepare(
            "INSERT OR IGNORE INTO processor_result_inputs(result_id,source_result_id,source_sha256) VALUES(?,?,?)",
          ).run(p.result_id, source.result_id, source.content_sha256);
      } else if (input.kind === "external") {
        const d = input.document,
          m = input.material;
        if (d) {
          const found = one(
            db,
            "SELECT 1 FROM document_versions WHERE document_version_id=? AND literature_id=? AND source_asset_id=? AND representation_sha256=?",
            d.document_version_id,
            input.literature_id,
            d.source_material_ref.asset_id,
            d.representation_sha256,
          );
          if (!found) fail("processor-input-changed");
          db.prepare(
            "INSERT OR IGNORE INTO processor_result_documents VALUES(?,?,?,?,?,?)",
          ).run(
            p.result_id,
            input.literature_id,
            d.source_material_ref.asset_id,
            d.source_material_ref.asset_sha256,
            d.document_version_id,
            d.representation_sha256,
          );
        } else if (m)
          db.prepare(
            "INSERT OR IGNORE INTO processor_result_materials VALUES(?,?,?,?)",
          ).run(p.result_id, input.literature_id, m.asset_id, m.asset_sha256);
      }
    }
    bindProcessorFreshness(
      db,
      p.result_id,
      p.inputs,
      p.reads,
      p.uses_description,
    );
    return one(
      db,
      "SELECT * FROM processor_results WHERE result_id=?",
      p.result_id,
    )!;
  });
}
function project(db: DatabaseSync, p: ProcessorProjection) {
  return tx(db, () => {
    const row = one(
      db,
      "SELECT content_sha256 FROM processor_results WHERE result_id=?",
      p.result_id,
    );
    if (!row || row.content_sha256 !== p.content_sha256)
      fail("processor-input-changed");
    db.prepare("DELETE FROM processor_record_projection WHERE result_id=?").run(
      p.result_id,
    );
    db.prepare("DELETE FROM processor_result_fts WHERE result_id=?").run(
      p.result_id,
    );
    for (const [ordinal, r] of p.records.entries()) {
      const payload = JSON.stringify(r.payload);
      db.prepare(
        "INSERT INTO processor_record_projection(result_id,record_id,ordinal,payload_json) VALUES(?,?,?,?)",
      ).run(p.result_id, r.record_id, ordinal, payload);
      db.prepare(
        "INSERT INTO processor_result_fts(result_id,record_id,body) VALUES(?,?,?)",
      ).run(p.result_id, r.record_id, payload);
    }
    db.prepare(
      "INSERT INTO processor_result_fts(result_id,record_id,body) VALUES(?,'',?)",
    ).run(p.result_id, p.text);
    db.prepare(
      "INSERT INTO processor_projection_state(result_id,content_sha256,record_count) VALUES(?,?,?) ON CONFLICT(result_id) DO UPDATE SET content_sha256=excluded.content_sha256,record_count=excluded.record_count",
    ).run(p.result_id, p.content_sha256, p.records.length);
    return true;
  });
}
export interface ProcessorRecordQuery {
  readonly result_ids: readonly string[];
  readonly filters: readonly {
    readonly path: string;
    readonly operator: "eq" | "ne" | "gt" | "ge" | "lt" | "le";
    readonly value: string | number | boolean | null;
  }[];
  readonly sort: {
    readonly path: string;
    readonly direction: "asc" | "desc";
  } | null;
  readonly limit: number;
  readonly offset: number;
}
function queryRecords(db: DatabaseSync, q: ProcessorRecordQuery) {
  const operators = {
    eq: "IS",
    ne: "IS NOT",
    gt: ">",
    ge: ">=",
    lt: "<",
    le: "<=",
  };
  const where = ["r.result_id IN (SELECT value FROM json_each(?))"];
  const params: SQLInputValue[] = [JSON.stringify(q.result_ids)];
  for (const filter of q.filters) {
    if (!Object.hasOwn(operators, filter.operator))
      fail("processor-query-invalid");
    where.push(
      `json_extract(r.payload_json,?) ${operators[filter.operator]} ?`,
    );
    params.push(
      filter.path,
      typeof filter.value === "boolean" ? Number(filter.value) : filter.value,
    );
  }
  let sort = "r.result_id,r.ordinal";
  if (q.sort) {
    if (!["asc", "desc"].includes(q.sort.direction))
      fail("processor-query-invalid");
    sort = `json_extract(r.payload_json,?) ${q.sort.direction},${sort}`;
    params.push(q.sort.path);
  }
  params.push(q.limit, q.offset);
  return db
    .prepare(
      `SELECT r.result_id,r.record_id,r.payload_json FROM processor_record_projection r WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    )
    .all(...params);
}
export type ProcessorStorageAction =
  | "freshness"
  | "repair-projections"
  | "collection-project"
  | "index-status"
  | "collection-members"
  | "get"
  | "comparison"
  | "list"
  | "publish"
  | "project"
  | "projection"
  | "query"
  | "context-search"
  | "search"
  | "collection-put"
  | "collection-get"
  | "collections"
  | "collection-search"
  | "pins";
export function runProcessorStorage(
  db: DatabaseSync,
  action: ProcessorStorageAction,
  args: unknown,
  schema: readonly string[],
): unknown {
  if (
    ![11].includes(
      Number(
        one(db, "SELECT schema_version FROM schema_identity WHERE singleton=1")
          ?.schema_version,
      ),
    )
  )
    fail("catalog-v10-required");
  switch (action) {
    case "freshness":
      return readProcessorFreshness(db, String(args));
    case "repair-projections":
      return tx(db, () => {
        for (const ddl of schema) {
          const name = /CREATE (?:VIRTUAL )?TABLE ([a-z_]+)/u.exec(ddl)?.[1];
          if (
            name &&
            [
              "processor_record_projection",
              "processor_projection_state",
              "processor_result_fts",
              "processor_collection_fts",
            ].includes(name) &&
            !one(db, "SELECT 1 FROM sqlite_master WHERE name=?", name)
          )
            db.exec(ddl);
        }
        return true;
      });
    case "collection-members":
      return db
        .prepare(
          "SELECT target_id,result_id,content_sha256,gap FROM processor_collection_members WHERE collection_id=? ORDER BY target_id",
        )
        .all(String(args));
    case "index-status":
      return one(
        db,
        "SELECT (SELECT count(*) FROM processor_results r LEFT JOIN processor_projection_state s ON s.result_id=r.result_id WHERE s.result_id IS NULL OR s.content_sha256<>r.content_sha256 OR s.record_count<>(SELECT count(*) FROM processor_record_projection p WHERE p.result_id=r.result_id) OR s.record_count+1<>(SELECT count(*) FROM processor_result_fts f WHERE f.result_id=r.result_id)) AS stale, (SELECT count(*) FROM processor_collections c WHERE 1<>(SELECT count(*) FROM processor_collection_fts f WHERE f.collection_id=c.collection_id)) AS collections",
      );
    case "collection-project":
      return tx(db, () => {
        const p = args as { collection_id: string; text: string };
        db.prepare(
          "DELETE FROM processor_collection_fts WHERE collection_id=?",
        ).run(p.collection_id);
        db.prepare(
          "INSERT INTO processor_collection_fts(collection_id,body) VALUES(?,?)",
        ).run(p.collection_id, p.text);
        return true;
      });

    case "get":
      return one(
        db,
        "SELECT * FROM processor_results WHERE result_id=?",
        String(args),
      );
    case "comparison":
      return one(
        db,
        "SELECT * FROM processor_results WHERE comparison_sha256=? AND complete=1 AND producer='internal'",
        String(args),
      );
    case "publish":
      return publish(db, args as ProcessorPublication);
    case "project":
      return project(db, args as ProcessorProjection);
    case "projection":
      return one(
        db,
        "SELECT s.*, (SELECT count(*) FROM processor_record_projection r WHERE r.result_id=s.result_id) AS actual_count, (SELECT count(*) FROM processor_result_fts f WHERE f.result_id=s.result_id) AS fts_count FROM processor_projection_state s WHERE s.result_id=?",
        String(args),
      );
    case "query":
      return queryRecords(db, args as ProcessorRecordQuery);
    case "pins":
      return {
        materials: db
          .prepare(
            "SELECT * FROM processor_result_materials WHERE result_id=? ORDER BY asset_id",
          )
          .all(String(args)),
        documents: db
          .prepare(
            "SELECT * FROM processor_result_documents WHERE result_id=? ORDER BY document_version_id",
          )
          .all(String(args)),
        results: db
          .prepare(
            "SELECT * FROM processor_result_inputs WHERE result_id=? ORDER BY source_result_id",
          )
          .all(String(args)),
      };
    case "list": {
      const q = args as {
        after: string;
        limit: number;
        literature_id?: string | null;
        stale?: boolean | null;
      };
      if (q.literature_id)
        return db
          .prepare(
            `
        WITH related(result_id) AS (
          SELECT result_id FROM processor_result_literatures WHERE literature_id=?
        )
        SELECT p.*,f.state AS freshness FROM processor_results p JOIN related r ON r.result_id=p.result_id JOIN processor_result_currentness f ON f.result_id=p.result_id
        WHERE p.result_id>? AND (? IS NULL OR f.state=?) ORDER BY p.result_id LIMIT ?
      `,
          )
          .all(
            q.literature_id,
            q.after,
            q.stale === null || q.stale === undefined
              ? null
              : q.stale
                ? "stale"
                : "current",
            q.stale ? "stale" : "current",
            q.limit,
          );
      return db
        .prepare(
          "SELECT p.*,f.state AS freshness FROM processor_results p JOIN processor_result_currentness f ON f.result_id=p.result_id WHERE p.result_id>? AND (? IS NULL OR f.state=?) ORDER BY p.result_id LIMIT ?",
        )
        .all(
          q.after,
          q.stale === null || q.stale === undefined
            ? null
            : q.stale
              ? "stale"
              : "current",
          q.stale ? "stale" : "current",
          q.limit,
        );
    }
    case "context-search": {
      const q = args as {
        query: string;
        scope: readonly string[];
        watermark: number | null;
        after: { result_id: string; record_id: string } | null;
      };
      const watermark =
        q.watermark ??
        Number(
          one(db, "SELECT coalesce(max(rowid),0) AS n FROM processor_results")
            ?.n ?? 0,
        );
      const rows = db
        .prepare(
          "SELECT f.result_id,f.record_id FROM processor_result_fts f JOIN processor_results r ON r.result_id=f.result_id WHERE processor_result_fts MATCH ? AND r.rowid<=? AND (f.record_id<>'' OR NOT EXISTS(SELECT 1 FROM processor_record_projection p WHERE p.result_id=f.result_id)) AND (?='[]' OR EXISTS(SELECT 1 FROM processor_result_literatures l WHERE l.result_id=f.result_id AND l.literature_id IN (SELECT value FROM json_each(?)))) AND (f.result_id>? OR (f.result_id=? AND f.record_id>?)) ORDER BY f.result_id,f.record_id LIMIT 1",
        )
        .all(
          q.query,
          watermark,
          JSON.stringify(q.scope),
          JSON.stringify(q.scope),
          q.after?.result_id ?? "",
          q.after?.result_id ?? "",
          q.after?.record_id ?? "",
        );
      return { watermark, row: rows[0] ?? null };
    }
    case "search": {
      const q = args as { query: string; limit: number; offset: number };
      return db
        .prepare(
          "SELECT result_id,record_id,body FROM processor_result_fts WHERE processor_result_fts MATCH ? ORDER BY rank,result_id,record_id LIMIT ? OFFSET ?",
        )
        .all(q.query, q.limit, q.offset);
    }
    case "collection-put": {
      const p = args as ProcessorCollectionPublication;
      return tx(db, () => {
        const old = one(
          db,
          "SELECT * FROM processor_collections WHERE collection_id=?",
          p.collection_id,
        );
        if (old) {
          if (old.content_sha256 !== p.sha256)
            fail("processor-publication-conflict");
          return p.collection_id;
        }
        artifact(db, p);
        db.prepare(
          "INSERT INTO processor_collections(collection_id,run_id,name,processor_id,spec_json,content_reference,content_sha256,content_size,content_media_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          p.collection_id,
          p.run_id,
          p.name,
          p.processor_id,
          p.spec_json,
          p.reference,
          p.sha256,
          p.byte_size,
          p.media_type,
          p.created_at,
        );
        for (const m of p.members)
          db.prepare(
            "INSERT INTO processor_collection_members(collection_id,target_id,result_id,content_sha256,gap) VALUES(?,?,?,?,?)",
          ).run(
            p.collection_id,
            m.target_id,
            m.result?.result_id ?? null,
            m.result?.content_sha256 ?? null,
            m.gap,
          );
        return p.collection_id;
      });
    }
    case "collection-get":
      return one(
        db,
        "SELECT * FROM processor_collections WHERE collection_id=?",
        String(args),
      );
    case "collections": {
      const q = args as {
        run_id: string | null;
        limit: number;
        offset: number;
      };
      return db
        .prepare(
          "SELECT collection_id,run_id,name,processor_id,created_at FROM processor_collections WHERE (? IS NULL OR run_id=?) ORDER BY created_at,collection_id LIMIT ? OFFSET ?",
        )
        .all(q.run_id, q.run_id, q.limit, q.offset);
    }
    case "collection-search": {
      const q = args as { query: string; limit: number; offset: number };
      return db
        .prepare(
          "SELECT c.collection_id,c.run_id,c.name,c.processor_id FROM processor_collection_fts f JOIN processor_collections c ON c.collection_id=f.collection_id WHERE processor_collection_fts MATCH ? ORDER BY rank,c.collection_id LIMIT ? OFFSET ?",
        )
        .all(q.query, q.limit, q.offset);
    }
  }
}
