import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type * as Schema from "./schema.js";
const { SCHEMA_VERSION }: typeof Schema = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./schema.ts" : "./schema.js",
    import.meta.url,
  ).href
);

export interface RetrievalSchemaConfig {
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly schema_fingerprint: string;
  readonly schema_manifest: readonly string[];
  readonly execution_schema_version: number;
  readonly execution_schema_fingerprint: string;
  readonly execution_runtime_schema_version: number;
  readonly execution_runtime_schema_fingerprint: string;
}
export interface RetrievalCatalogInspection {
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly schema_fingerprint: string;
  readonly integrity: "ok";
  readonly foreign_keys: "ok";
  readonly source_revision: number;
  readonly active_generation: string | null;
}
function fail(): never {
  throw new RetrievalStorageError("index-corrupt");
}
export function prepareRetrievalVocab(db: DatabaseSync): void {
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.retrieval_fts_vocab USING fts5vocab(main,retrieval_fts,instance)",
  );
}
export function retrievalHashes(
  db: DatabaseSync,
  generationId: string,
): { content_sha256: string; posting_sha256: string } {
  const content = createHash("sha256").update(
    `retrieval-content-v1:${generationId}\n`,
  );
  const rows = db.prepare(
    "SELECT e.entry_id,e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=? ORDER BY e.entry_id",
  );
  for (const row of rows.iterate(generationId))
    content.update(`${JSON.stringify(Object.values(row))}\n`);
  const posting = createHash("sha256").update(
    `retrieval-posting-v1:${generationId}\n`,
  );
  const instances = db.prepare(
    "SELECT v.term,v.doc,v.col,v.offset FROM retrieval_fts_vocab v JOIN retrieval_entries e ON e.entry_id=v.doc WHERE e.generation_id=? ORDER BY v.term,v.doc,v.col,v.offset",
  );
  for (const row of instances.iterate(generationId))
    posting.update(`${JSON.stringify(Object.values(row))}\n`);
  return {
    content_sha256: content.digest("hex"),
    posting_sha256: posting.digest("hex"),
  };
}
export function inspectCatalogWithRetrieval(
  db: DatabaseSync,
  config: RetrievalSchemaConfig,
  checkpoint?: () => void,
  sourceOnly = false,
): RetrievalCatalogInspection {
  // A SAVEPOINT also works inside an outer writer transaction. SQLite fixes the
  // read snapshot at the first statement and keeps it through the final pointer.
  db.exec("SAVEPOINT sciretriever_retrieval_inspect");
  try {
    const result = inspectCatalogSnapshot(db, config, checkpoint, sourceOnly);
    db.exec("RELEASE sciretriever_retrieval_inspect");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK TO sciretriever_retrieval_inspect");
      db.exec("RELEASE sciretriever_retrieval_inspect");
    } catch {
      // Keep the inspection failure as the diagnostic when SQLite is damaged.
    }
    throw error;
  }
}
function inspectCatalogSnapshot(
  db: DatabaseSync,
  config: RetrievalSchemaConfig,
  checkpoint?: () => void,
  sourceOnly = false,
): RetrievalCatalogInspection {
  const identity = db
    .prepare(
      "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get() as
    | {
        product?: unknown;
        schema_version?: unknown;
        schema_fingerprint?: unknown;
      }
    | undefined;
  if (
    identity?.product !== "sciretriever" ||
    identity.schema_version !== config.schema_version ||
    identity.schema_fingerprint !== config.schema_fingerprint
  )
    fail();
  const names = new Set<string>();
  for (const sql of config.schema_manifest) {
    const name =
      /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER|VIEW) ([a-z_][a-z0-9_]*)/.exec(
        sql,
      )?.[1];
    if (!name) fail();
    names.add(name);
    const actual = db
      .prepare("SELECT sql FROM sqlite_master WHERE name=?")
      .get(name) as { sql?: unknown } | undefined;
    if (
      actual?.sql !== sql &&
      !(
        config.schema_version === SCHEMA_VERSION &&
        [
          "processor_record_projection",
          "processor_projection_state",
          "processor_result_fts",
          "processor_collection_fts",
        ].includes(name)
      )
    )
      fail();
  }
  for (const table of ["literature_search_fts", "retrieval_fts", "tag_search"])
    for (const suffix of ["data", "idx", "content", "docsize", "config"])
      names.add(`${table}_${suffix}`);
  if (config.schema_version === SCHEMA_VERSION)
    for (const prefix of ["processor_result_fts", "processor_collection_fts"])
      for (const suffix of ["data", "idx", "content", "docsize", "config"])
        names.add(`${prefix}_${suffix}`);
  const actual = db
    .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  if (actual.some((row) => !names.has(row.name))) fail();
  if (sourceOnly || config.schema_version === SCHEMA_VERSION) {
    // The global integrity pragma invokes FTS5's integrity hook. Repair must
    // still be able to read sound source facts when only that index is damaged.
    for (const sql of config.schema_manifest) {
      const table = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/.exec(
        sql,
      )?.[1];
      if (
        !table ||
        (sourceOnly && table.startsWith("retrieval_")) ||
        [
          "processor_record_projection",
          "processor_projection_state",
          "processor_result_fts",
          "processor_collection_fts",
        ].includes(table)
      )
        continue;
      if (
        (
          db.prepare(`PRAGMA integrity_check(${table})`).get() as
            | { integrity_check?: unknown }
            | undefined
        )?.integrity_check !== "ok"
      )
        fail();
      if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) fail();
    }
  } else {
    if (
      (
        db.prepare("PRAGMA integrity_check").get() as
          | { integrity_check?: unknown }
          | undefined
      )?.integrity_check !== "ok"
    )
      fail();
    if (db.prepare("PRAGMA foreign_key_check").all().length) fail();
  }
  const execution = db
    .prepare(
      "SELECT version,fingerprint FROM execution_schema_identity WHERE singleton=1",
    )
    .get() as { version?: unknown; fingerprint?: unknown } | undefined;
  const runtime = db
    .prepare(
      "SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1",
    )
    .get() as { version?: unknown; fingerprint?: unknown } | undefined;
  if (
    execution?.version !== config.execution_schema_version ||
    execution.fingerprint !== config.execution_schema_fingerprint ||
    runtime?.version !== config.execution_runtime_schema_version ||
    runtime.fingerprint !== config.execution_runtime_schema_fingerprint
  )
    fail();
  const source = db
    .prepare("SELECT revision FROM retrieval_source_revision WHERE singleton=1")
    .get() as { revision?: unknown } | undefined;
  if (
    !source ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 0
  )
    fail();
  if (sourceOnly)
    return {
      schema_version: config.schema_version,
      schema_fingerprint: config.schema_fingerprint,
      integrity: "ok",
      foreign_keys: "ok",
      source_revision: source.revision as number,
      active_generation: null,
    };
  const counts = db
    .prepare(
      "SELECT g.generation_id,g.status,g.entry_count,g.fts_count,g.content_sha256,g.posting_sha256,(SELECT count(*) FROM retrieval_entries e WHERE e.generation_id=g.generation_id) AS actual_entries,(SELECT count(*) FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=g.generation_id) AS actual_fts FROM retrieval_generations g",
    )
    .all() as {
    generation_id: string;
    status: string;
    entry_count: number;
    fts_count: number;
    content_sha256: string | null;
    posting_sha256: string | null;
    actual_entries: number;
    actual_fts: number;
  }[];
  if (
    counts.some(
      (row) =>
        row.entry_count !== row.actual_entries ||
        row.fts_count !== row.actual_fts ||
        row.entry_count !== row.fts_count,
    )
  )
    fail();
  for (const row of counts) {
    if (row.status === "ready") {
      const hashes = retrievalHashes(db, row.generation_id);
      if (
        row.content_sha256 !== hashes.content_sha256 ||
        row.posting_sha256 !== hashes.posting_sha256
      )
        fail();
    } else if (
      row.status !== "building" ||
      row.content_sha256 !== null ||
      row.posting_sha256 !== null
    )
      fail();
  }
  const orphanFts = db
    .prepare(
      "SELECT f.rowid FROM retrieval_fts f LEFT JOIN retrieval_entries e ON e.entry_id=f.rowid WHERE e.entry_id IS NULL LIMIT 1",
    )
    .get();
  if (orphanFts) fail();
  checkpoint?.();
  const active = db
    .prepare(
      "SELECT generation_id FROM retrieval_active_generation WHERE singleton=1",
    )
    .get() as { generation_id?: unknown } | undefined;
  if (
    active &&
    (typeof active.generation_id !== "string" ||
      !counts.some(
        (row) =>
          row.generation_id === active.generation_id && row.status === "ready",
      ))
  )
    fail();
  return {
    schema_version: config.schema_version,
    schema_fingerprint: config.schema_fingerprint,
    integrity: "ok",
    foreign_keys: "ok",
    source_revision: source.revision as number,
    active_generation:
      typeof active?.generation_id === "string" ? active.generation_id : null,
  };
}
export const RETRIEVAL_SCORE_RULE = "weighted-term-frequency-v1" as const;
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function scoreText(
  title: string,
  body: string,
  terms: readonly string[],
): number {
  const titleTokens = title.split(" ");
  const bodyTokens = body.split(" ");
  let matched = 0;
  for (const term of terms) {
    matched += 4 * titleTokens.filter((token) => token === term).length;
    matched += bodyTokens.filter((token) => token === term).length;
  }
  return -matched;
}

export interface RetrievalSource {
  readonly literature_id: string;
  readonly meta_literature_id: string;
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly title: string | null;
  readonly abstract: string | null;
  readonly authors: string | null;
  readonly keywords: string | null;
  readonly venue: string | null;
  readonly publisher: string | null;
  readonly publication_year: number | null;
  readonly primary_asset_id: string | null;
  readonly document_version_id?: string;
  readonly representation_sha256?: string;
  readonly source_asset_id?: string;
  readonly source_asset_sha256?: string;
  readonly is_default?: number;
}
export interface RetrievalEntry {
  readonly kind: "metadata" | "document";
  readonly literature_id: string;
  readonly meta_literature_id: string;
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly document_version_id: string | null;
  readonly representation_sha256: string | null;
  readonly source_asset_id: string | null;
  readonly source_asset_sha256: string | null;
  readonly unit_start_utf8: number | null;
  readonly unit_end_utf8: number | null;
  readonly unit_sha256: string | null;
  readonly section_id: string | null;
  readonly unit_ordinal: number;
  readonly is_default: number;
  readonly title: string;
  readonly body: string;
}
export interface RetrievalHit extends Omit<RetrievalEntry, "title" | "body"> {
  readonly entry_id: number;
  readonly score: number;
  readonly primary_asset_id: string | null;
}
export interface RetrievalGeneration {
  readonly generation_id: string;
  readonly source_revision: number;
  readonly entry_count: number;
  readonly source_count: number;
}
export class RetrievalStorageError extends Error {
  readonly code: "index-unavailable" | "index-corrupt" | "index-stale";
  constructor(code: "index-unavailable" | "index-corrupt" | "index-stale") {
    super(code);
    this.code = code;
  }
}

/** SQLite projection adapter. It never treats indexed text as source content. */
export class RetrievalStorageEngine {
  private db: DatabaseSync;
  private observedDataVersion: number;
  private validatedDataVersion: number | null = null;
  private repairGeneration: string | null = null;
  private repairText: DatabaseSync | null = null;
  readonly readOnly: boolean;
  private readonly config: RetrievalSchemaConfig;
  constructor(path: string, readOnly: boolean, config: RetrievalSchemaConfig) {
    this.path = path;
    this.readOnly = readOnly;
    this.config = config;
    this.db = this.connect();
    this.observedDataVersion = this.dataVersion();
    if (!readOnly) {
      try {
        this.validate(true);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }
  private readonly path: string;
  private connect(): DatabaseSync {
    const db = new DatabaseSync(this.path, { readOnly: this.readOnly });
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");
    prepareRetrievalVocab(db);
    if (this.readOnly) db.exec("PRAGMA query_only=ON");
    return db;
  }
  private dataVersion(): number {
    return Number(
      (this.db.prepare("PRAGMA data_version").get() as { data_version: number })
        .data_version,
    );
  }
  private refreshReader(skipMaterial = false): void {
    const current = this.dataVersion();
    if (!this.readOnly) {
      if (current !== this.observedDataVersion) {
        this.db.close();
        this.db = this.connect();
        this.validate(true);
        this.observedDataVersion = this.dataVersion();
      }
      return;
    }
    if (current !== this.observedDataVersion) {
      this.db.close();
      this.db = this.connect();
      this.observedDataVersion = this.dataVersion();
      this.validatedDataVersion = null;
    }
    if (skipMaterial || this.validatedDataVersion === this.observedDataVersion)
      return;
    this.validate(false);
    this.validatedDataVersion = this.observedDataVersion;
  }
  private validate(sourceOnly: boolean): void {
    try {
      inspectCatalogWithRetrieval(this.db, this.config, undefined, sourceOnly);
    } catch {
      throw new RetrievalStorageError("index-corrupt");
    }
  }
  close(): void {
    this.repairText?.close();
    this.repairText = null;
    this.db.close();
  }
  revision(): number {
    this.refreshReader();
    const row = this.db
      .prepare(
        "SELECT revision FROM retrieval_source_revision WHERE singleton=1",
      )
      .get() as { revision?: unknown } | undefined;
    if (!row || !Number.isSafeInteger(row.revision))
      throw new RetrievalStorageError("index-corrupt");
    return row.revision as number;
  }
  metadataPage(
    after: string | null,
    limit: number,
  ): readonly RetrievalSource[] {
    return this.db
      .prepare(
        `SELECT l.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,m.venue,m.publisher,m.publication_year,(SELECT group_concat(display_name,' ') FROM literature_metadata_authors a WHERE a.literature_id=l.literature_id) AS authors,(SELECT group_concat(keyword,' ') FROM literature_metadata_keywords k WHERE k.literature_id=l.literature_id) AS keywords,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf') AS primary_asset_id FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE (? IS NULL OR l.literature_id>?) ORDER BY l.literature_id LIMIT ?`,
      )
      .all(after, after, limit) as unknown as RetrievalSource[];
  }
  documentPage(
    after: string | null,
    limit: number,
  ): readonly RetrievalSource[] {
    return this.db
      .prepare(
        `SELECT v.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,NULL AS authors,NULL AS keywords,m.venue,m.publisher,m.publication_year,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.role='primary-pdf') AS primary_asset_id,v.document_version_id,v.representation_sha256,v.source_asset_id,v.source_sha256 AS source_asset_sha256,CASE WHEN d.document_version_id=v.document_version_id AND EXISTS(SELECT 1 FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.asset_id=v.source_asset_id AND p.role IN ('primary-pdf','supplementary-pdf')) THEN 1 ELSE 0 END AS is_default FROM document_versions v JOIN literatures l ON l.literature_id=v.literature_id JOIN literature_metadata m ON m.literature_id=v.literature_id LEFT JOIN document_defaults d ON d.document_id=v.document_id WHERE (? IS NULL OR v.document_version_id>?) ORDER BY v.document_version_id LIMIT ?`,
      )
      .all(after, after, limit) as unknown as RetrievalSource[];
  }
  beginGeneration(sourceRevision: number): string {
    this.refreshReader();
    const id = randomUUID();
    let repairing = false;
    try {
      inspectCatalogWithRetrieval(this.db, this.config);
    } catch {
      // The source schema passed validation. Only an explicit rebuild may
      // replace a damaged, derived retrieval projection.
      repairing = true;
    }
    // Anonymous temporary SQLite storage survives main-connection refreshes,
    // spills to disk, and disappears on close. It adds no catalog schema.
    const repairText = repairing ? new DatabaseSync("") : null;
    let transaction = false;
    try {
      if (repairText)
        repairText.exec(
          "PRAGMA temp_store=FILE; CREATE TEMP TABLE retrieval_repair_text(entry_id INTEGER PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL)",
        );
      this.db.exec("BEGIN IMMEDIATE");
      transaction = true;
      // Only interrupted staging is removed; ready generations remain readable.
      const stale = this.db
        .prepare(
          "SELECT generation_id FROM retrieval_generations WHERE status='building'",
        )
        .all() as { generation_id: string }[];
      for (const row of stale) {
        this.db
          .prepare(
            "DELETE FROM retrieval_fts WHERE rowid IN (SELECT entry_id FROM retrieval_entries WHERE generation_id=?)",
          )
          .run(row.generation_id);
        this.db
          .prepare("DELETE FROM retrieval_generations WHERE generation_id=?")
          .run(row.generation_id);
      }
      if (this.revision() !== sourceRevision)
        throw new RetrievalStorageError("index-stale");
      this.db
        .prepare(
          "INSERT INTO retrieval_generations(generation_id,index_schema_version,unit_rule,source_revision,status,entry_count,fts_count,source_count,created_at) VALUES(?,1,'markdown-context-v1',?,'building',0,0,0,?)",
        )
        .run(id, sourceRevision, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      if (transaction) this.db.exec("ROLLBACK");
      repairText?.close();
      throw error;
    }
    this.repairText?.close();
    this.repairText = repairText;
    this.repairGeneration = repairing ? id : null;
    return id;
  }
  insertEntries(
    generationId: string,
    entries: readonly RetrievalEntry[],
    sourceCount: number,
  ): void {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    const repair =
      this.repairGeneration === generationId ? this.repairText : null;
    const stagedIds: (number | bigint)[] = [];
    let repairTransaction = false;
    try {
      if (repair) {
        repair.exec("BEGIN");
        repairTransaction = true;
      }
      const insert = this.db.prepare(
        "INSERT INTO retrieval_entries(generation_id,kind,literature_id,meta_literature_id,metadata_revision,metadata_sha256,document_version_id,representation_sha256,source_asset_id,source_asset_sha256,unit_start_utf8,unit_end_utf8,unit_sha256,section_id,unit_ordinal,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      const fts = this.db.prepare(
        "INSERT INTO retrieval_fts(rowid,title,body) VALUES(?,?,?)",
      );
      const repairText = repair
        ? repair.prepare(
            "INSERT INTO temp.retrieval_repair_text(entry_id,title,body) VALUES(?,?,?)",
          )
        : null;
      for (const e of entries) {
        const result = insert.run(
          generationId,
          e.kind,
          e.literature_id,
          e.meta_literature_id,
          e.metadata_revision,
          e.metadata_sha256,
          e.document_version_id,
          e.representation_sha256,
          e.source_asset_id,
          e.source_asset_sha256,
          e.unit_start_utf8,
          e.unit_end_utf8,
          e.unit_sha256,
          e.section_id,
          e.unit_ordinal,
          e.is_default,
        );
        if (repairText) {
          repairText.run(result.lastInsertRowid, e.title, e.body);
          stagedIds.push(result.lastInsertRowid);
        } else fts.run(result.lastInsertRowid, e.title, e.body);
      }
      this.db
        .prepare(
          "UPDATE retrieval_generations SET entry_count=entry_count+?,fts_count=fts_count+?,source_count=source_count+? WHERE generation_id=? AND status='building'",
        )
        .run(entries.length, entries.length, sourceCount, generationId);
      if (repair) {
        repair.exec("COMMIT");
        repairTransaction = false;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (repairTransaction) repair!.exec("ROLLBACK");
      else if (repair) {
        // If the main commit failed after temporary staging committed, remove
        // only this batch. It must never be mistaken for published input.
        const remove = repair.prepare(
          "DELETE FROM temp.retrieval_repair_text WHERE entry_id=?",
        );
        for (const id of stagedIds) remove.run(id);
      }
      throw error;
    }
  }
  publish(generationId: string, sourceRevision: number): RetrievalGeneration {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    let published: RetrievalGeneration;
    const repairing = this.repairGeneration === generationId;
    try {
      if (this.revision() !== sourceRevision)
        throw new RetrievalStorageError("index-stale");
      const row = this.db
        .prepare(
          "SELECT generation_id,source_revision,entry_count,fts_count,source_count FROM retrieval_generations WHERE generation_id=? AND status='building'",
        )
        .get(generationId) as
        | (RetrievalGeneration & { fts_count: number })
        | undefined;
      if (!row || row.source_revision !== sourceRevision)
        throw new RetrievalStorageError("index-corrupt");
      const count = Number(
        (
          this.db
            .prepare(
              "SELECT count(*) AS n FROM retrieval_entries WHERE generation_id=?",
            )
            .get(generationId) as { n: number }
        ).n,
      );
      const ftsCount = Number(
        (
          (repairing ? this.repairText! : this.db)
            .prepare(
              repairing
                ? "SELECT count(*) AS n FROM temp.retrieval_repair_text"
                : "SELECT count(*) AS n FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=?",
            )
            .get(...(repairing ? [] : [generationId])) as { n: number }
        ).n,
      );
      if (
        count !== row.entry_count ||
        ftsCount !== row.fts_count ||
        ftsCount !== count
      )
        throw new RetrievalStorageError("index-corrupt");
      if (repairing) {
        // DDL and the active pointer switch share one rollback boundary. A
        // failed rebuild leaves the old (still corrupt) projection untouched.
        this.db.exec("DROP TABLE retrieval_fts");
        this.db.exec(
          "CREATE VIRTUAL TABLE retrieval_fts USING fts5(title,body,tokenize='unicode61')",
        );
        const insert = this.db.prepare(
          "INSERT INTO retrieval_fts(rowid,title,body) VALUES(?,?,?)",
        );
        const member = this.db.prepare(
          "SELECT 1 FROM retrieval_entries WHERE generation_id=? AND entry_id=?",
        );
        for (const row of this.repairText!.prepare(
          "SELECT entry_id,title,body FROM temp.retrieval_repair_text ORDER BY entry_id",
        ).iterate()) {
          if (!member.get(generationId, row.entry_id!)) fail();
          insert.run(row.entry_id!, row.title!, row.body!);
        }
      }
      this.db
        .prepare(
          "INSERT INTO retrieval_fts(retrieval_fts) VALUES('integrity-check')",
        )
        .run();
      const hashes = retrievalHashes(this.db, generationId);
      this.db
        .prepare(
          "UPDATE retrieval_generations SET status='ready',content_sha256=?,posting_sha256=? WHERE generation_id=?",
        )
        .run(hashes.content_sha256, hashes.posting_sha256, generationId);
      this.db
        .prepare(
          "INSERT INTO retrieval_active_generation(singleton,generation_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id",
        )
        .run(generationId);
      if (repairing) {
        this.db
          .prepare("DELETE FROM retrieval_generations WHERE generation_id<>?")
          .run(generationId);
        inspectCatalogWithRetrieval(this.db, this.config);
      }
      this.db.exec("COMMIT");
      published = {
        generation_id: row.generation_id,
        source_revision: row.source_revision,
        entry_count: row.entry_count,
        source_count: row.source_count,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (repairing) {
      this.repairText!.close();
      this.repairText = null;
      this.repairGeneration = null;
    }
    return published;
  }
  active(): RetrievalGeneration | null {
    this.refreshReader();
    const pointer = this.db
      .prepare(
        "SELECT generation_id FROM retrieval_active_generation WHERE singleton=1",
      )
      .get();
    const row = this.db
      .prepare(
        "SELECT g.generation_id,g.source_revision,g.entry_count,g.fts_count,g.source_count,g.status FROM retrieval_active_generation a JOIN retrieval_generations g ON g.generation_id=a.generation_id WHERE a.singleton=1",
      )
      .get() as
      | (RetrievalGeneration & { fts_count: number; status: string })
      | undefined;
    if (pointer && !row) throw new RetrievalStorageError("index-corrupt");
    if (!row) return null;
    if (row.status !== "ready" || row.entry_count !== row.fts_count)
      throw new RetrievalStorageError("index-corrupt");
    const count = Number(
      (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM retrieval_entries WHERE generation_id=?",
          )
          .get(row.generation_id) as { n: number }
      ).n,
    );
    const ftsCount = Number(
      (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=?",
          )
          .get(row.generation_id) as { n: number }
      ).n,
    );
    if (count !== row.entry_count || ftsCount !== count)
      throw new RetrievalStorageError("index-corrupt");
    return {
      generation_id: row.generation_id,
      source_revision: row.source_revision,
      entry_count: row.entry_count,
      source_count: row.source_count,
    };
  }
  reusableGeneration(): RetrievalGeneration | null {
    this.refreshReader();
    try {
      // Never turn corrupt indexed text into a new trusted generation.
      this.validate(false);
      return this.active();
    } catch (error) {
      if (error instanceof RetrievalStorageError) return null;
      throw error;
    }
  }
  reusePage(
    generation: string,
    kind: "metadata" | "document",
    source: RetrievalSource,
    after: number,
    limit: number,
  ): readonly (RetrievalEntry & { entry_id: number })[] {
    return this.db
      .prepare(
        `SELECT e.entry_id,e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body
       FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id
       WHERE e.generation_id=? AND e.kind=? AND e.literature_id=? AND e.meta_literature_id=? AND e.metadata_revision=? AND e.metadata_sha256=?
       AND e.document_version_id IS ? AND e.representation_sha256 IS ? AND e.source_asset_id IS ? AND e.source_asset_sha256 IS ? AND e.is_default=?
       AND e.entry_id>? ORDER BY e.entry_id LIMIT ?`,
      )
      .all(
        generation,
        kind,
        source.literature_id,
        source.meta_literature_id,
        source.metadata_revision,
        source.metadata_sha256,
        kind === "document" ? source.document_version_id! : null,
        kind === "document" ? source.representation_sha256! : null,
        kind === "document" ? source.source_asset_id! : null,
        kind === "document" ? source.source_asset_sha256! : null,
        kind === "document" ? source.is_default! : 1,
        after,
        limit,
      ) as unknown as (RetrievalEntry & { entry_id: number })[];
  }
  search(
    ftsQuery: string,
    terms: readonly string[],
    generationId: string,
    scope: readonly string[],
    kinds: readonly ("metadata" | "document")[],
    explicitVersions: readonly string[] | null,
    limit: number,
    after: {
      readonly score: number;
      readonly kind: string;
      readonly literature_id: string;
      readonly document_version_id: string;
      readonly unit_ordinal: number;
    } | null,
  ): {
    readonly hits: readonly RetrievalHit[];
    readonly candidateLimit: boolean;
  } {
    this.refreshReader();
    const scopeJson = JSON.stringify(scope);
    const kindsJson = JSON.stringify(kinds);
    const versionsJson = JSON.stringify(explicitVersions ?? []);
    const rows = this.db
      .prepare(
        `SELECT e.entry_id,e.generation_id,e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,retrieval_fts.title,retrieval_fts.body,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=e.literature_id AND p.role='primary-pdf') AS primary_asset_id FROM retrieval_fts JOIN retrieval_entries e ON e.entry_id=retrieval_fts.rowid WHERE retrieval_fts MATCH ? AND e.generation_id=? AND e.kind IN (SELECT value FROM json_each(?)) AND (json_array_length(?)=0 OR e.literature_id IN (SELECT value FROM json_each(?))) AND (e.kind='metadata' OR (?=0 AND e.is_default=1) OR (?=1 AND e.document_version_id IN (SELECT value FROM json_each(?)))) ORDER BY e.entry_id LIMIT 4098`,
      )
      .all(
        ftsQuery,
        generationId,
        kindsJson,
        scopeJson,
        scopeJson,
        explicitVersions === null ? 0 : 1,
        explicitVersions === null ? 0 : 1,
        versionsJson,
      ) as unknown as (Omit<RetrievalHit, "score"> & {
      title: string;
      body: string;
    })[];
    const groups = new Map<string, RetrievalHit>();
    for (const row of rows.slice(0, 4097)) {
      const { title, body, ...reference } = row;
      const hit: RetrievalHit = {
        ...reference,
        score: scoreText(title, body, terms),
      };
      const key = JSON.stringify([
        hit.kind,
        hit.literature_id,
        hit.document_version_id,
        hit.unit_ordinal,
      ]);
      const previous = groups.get(key);
      if (
        !previous ||
        hit.score < previous.score ||
        (hit.score === previous.score && hit.entry_id < previous.entry_id)
      )
        groups.set(key, hit);
    }
    const ordered = [...groups.values()].sort(
      (a, b) =>
        a.score - b.score ||
        compareText(a.kind, b.kind) ||
        compareText(a.literature_id, b.literature_id) ||
        compareText(a.document_version_id ?? "", b.document_version_id ?? "") ||
        a.unit_ordinal - b.unit_ordinal,
    );
    const position = (hit: RetrievalHit) =>
      [
        hit.score,
        hit.kind,
        hit.literature_id,
        hit.document_version_id ?? "",
        hit.unit_ordinal,
      ] as const;
    const follows = (hit: RetrievalHit) => {
      if (!after) return true;
      const value = position(hit);
      const previous = [
        after.score,
        after.kind,
        after.literature_id,
        after.document_version_id,
        after.unit_ordinal,
      ] as const;
      for (let index = 0; index < value.length; index++) {
        const left = value[index]!;
        const right = previous[index]!;
        const order =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : compareText(String(left), String(right));
        if (order !== 0) return order > 0;
      }
      return false;
    };
    return {
      hits: ordered.filter(follows).slice(0, limit),
      candidateLimit: rows.length > 4097,
    };
  }
  metadataSource(literatureId: string): RetrievalSource | null {
    const row = this.db
      .prepare(
        `SELECT l.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,m.venue,m.publisher,m.publication_year,(SELECT group_concat(display_name,' ') FROM literature_metadata_authors a WHERE a.literature_id=l.literature_id) AS authors,(SELECT group_concat(keyword,' ') FROM literature_metadata_keywords k WHERE k.literature_id=l.literature_id) AS keywords,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf') AS primary_asset_id FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE l.literature_id=?`,
      )
      .get(literatureId) as RetrievalSource | undefined;
    return row ?? null;
  }
  /** Bounded source coverage; library-wide omissions are reported without leaking IDs. */
  documentCoverage(
    scope: readonly string[],
    explicit:
      | readonly {
          literature_id: string;
          document_version_id: string;
          representation_sha256: string;
        }[]
      | null,
    includeGaps = true,
  ): readonly {
    code: "material-missing" | "representation-missing";
    literature_id: string | null;
  }[] {
    this.refreshReader();
    if (scope.length) {
      const found = this.db
        .prepare(
          "SELECT literature_id FROM literatures WHERE literature_id IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify(scope)) as { literature_id: string }[];
      if (found.length !== scope.length)
        throw new RetrievalStorageError("index-stale");
    }
    if (explicit) {
      const matched = this.db
        .prepare(
          "SELECT count(*) AS n FROM json_each(?) j JOIN document_versions v ON v.document_version_id=json_extract(j.value,'$.document_version_id') AND v.literature_id=json_extract(j.value,'$.literature_id') AND v.representation_sha256=json_extract(j.value,'$.representation_sha256')",
        )
        .get(JSON.stringify(explicit)) as { n: number };
      if (matched.n !== explicit.length)
        throw new RetrievalStorageError("index-stale");
      return [];
    }
    if (!includeGaps) return [];
    const rows = this.db
      .prepare(
        "SELECT l.literature_id,(SELECT p.asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf') AS asset_id,EXISTS(SELECT 1 FROM document_defaults d JOIN document_versions v ON v.document_version_id=d.document_version_id WHERE v.literature_id=l.literature_id AND v.source_asset_id=(SELECT p.asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf')) AS ready FROM literatures l WHERE (json_array_length(?)=0 OR l.literature_id IN (SELECT value FROM json_each(?)))",
      )
      .all(JSON.stringify(scope), JSON.stringify(scope)) as {
      literature_id: string;
      asset_id: string | null;
      ready: number;
    }[];
    const gaps: {
      code: "material-missing" | "representation-missing";
      literature_id: string;
    }[] = [];
    for (const row of rows) {
      if (!row.asset_id)
        gaps.push({
          code: "material-missing",
          literature_id: row.literature_id,
        });
      else if (!row.ready)
        gaps.push({
          code: "representation-missing",
          literature_id: row.literature_id,
        });
    }
    if (!gaps.length) return [];
    if (!scope.length || gaps.length > 30)
      return [...new Set(gaps.map((gap) => gap.code))].map((code) => ({
        code,
        literature_id: null,
      }));
    return gaps;
  }
  hasDefault(literatureId: string, assetId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM document_defaults d JOIN document_versions v ON v.document_version_id=d.document_version_id WHERE v.literature_id=? AND v.source_asset_id=?",
      )
      .get(literatureId, assetId);
  }
}
