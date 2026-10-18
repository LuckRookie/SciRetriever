import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

export interface RetrievalSchemaConfig {
  readonly schema_version?: 4 | 5 | 6 | 7 | 8 | 9 | 10;
  readonly schema_fingerprint: string;
  readonly schema_manifest: readonly string[];
  readonly execution_schema_version: number;
  readonly execution_schema_fingerprint: string;
  readonly execution_runtime_schema_version: number;
  readonly execution_runtime_schema_fingerprint: string;
}
export interface RetrievalCatalogInspection {
  readonly schema_version: 4 | 5 | 6 | 7 | 8 | 9 | 10;
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
function knowledgeHashes(db: DatabaseSync, generationId: string) {
  const content = createHash("sha256").update(
    `knowledge-content-v1:${generationId}\n`,
  );
  for (const row of db
    .prepare(
      "SELECT e.entry_id,e.artifact_id,e.content_sha256,e.manifest_sha256,e.scope_kind,e.scope_key,e.purpose,e.question_sha256,e.statement_id,e.statement_ordinal,e.statement_sha256,e.source_literature_ids_json,e.scope_complete,e.is_default,f.title,f.body FROM knowledge_retrieval_entries e JOIN knowledge_retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=? ORDER BY e.entry_id",
    )
    .iterate(generationId))
    content.update(`${JSON.stringify(Object.values(row))}\n`);
  const posting = createHash("sha256").update(
    `knowledge-posting-v1:${generationId}\n`,
  );
  for (const row of db
    .prepare(
      "SELECT v.term,v.doc,v.col,v.offset FROM knowledge_retrieval_fts_vocab v JOIN knowledge_retrieval_entries e ON e.entry_id=v.doc WHERE e.generation_id=? ORDER BY v.term,v.doc,v.col,v.offset",
    )
    .iterate(generationId))
    posting.update(`${JSON.stringify(Object.values(row))}\n`);
  return {
    content_sha256: content.digest("hex"),
    posting_sha256: posting.digest("hex"),
  };
}
export function inspectKnowledgeProjectionDdl(
  db: DatabaseSync,
  config: RetrievalSchemaConfig,
): void {
  if (
    !([8, 9, 10] as readonly (number | undefined)[]).includes(
      config.schema_version,
    )
  )
    fail();
  for (const sql of config.schema_manifest) {
    const name =
      /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER) (knowledge_retrieval_[a-z_][a-z0-9_]*)/.exec(
        sql,
      )?.[1];
    if (!name) continue;
    const actual = db
      .prepare("SELECT sql FROM sqlite_master WHERE name=?")
      .get(name) as { sql?: unknown } | undefined;
    if (actual?.sql !== sql) fail();
  }
}
export function inspectV4(
  db: DatabaseSync,
  config: RetrievalSchemaConfig,
  checkpoint?: () => void,
  sourceOnly = false,
): RetrievalCatalogInspection & { readonly schema_version: 4 } {
  const result = inspectCatalogWithRetrieval(
    db,
    config,
    checkpoint,
    sourceOnly,
  );
  if (result.schema_version !== 4) fail();
  return result as RetrievalCatalogInspection & { readonly schema_version: 4 };
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
    const result = inspectV4Snapshot(db, config, checkpoint, sourceOnly);
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
function inspectV4Snapshot(
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
    identity.schema_version !== (config.schema_version ?? 4) ||
    identity.schema_fingerprint !== config.schema_fingerprint
  )
    fail();
  const names = new Set<string>();
  for (const sql of config.schema_manifest) {
    const name =
      /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER) ([a-z_][a-z0-9_]*)/.exec(
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
        ([8, 9, 10] as readonly (number | undefined)[]).includes(
          config.schema_version,
        ) &&
        (name.startsWith("knowledge_retrieval_") ||
          [
            "processor_record_projection",
            "processor_projection_state",
            "processor_result_fts",
            "processor_collection_fts",
          ].includes(name))
      )
    )
      fail();
  }
  for (const table of ["literature_search_fts", "retrieval_fts"])
    for (const suffix of ["data", "idx", "content", "docsize", "config"])
      names.add(`${table}_${suffix}`);
  if (
    ([8, 9, 10] as readonly (number | undefined)[]).includes(
      config.schema_version,
    )
  )
    for (const suffix of ["data", "idx", "content", "docsize", "config"])
      names.add(`knowledge_retrieval_fts_${suffix}`);
  if (config.schema_version === 10)
    for (const prefix of ["processor_result_fts", "processor_collection_fts"])
      for (const suffix of ["data", "idx", "content", "docsize", "config"])
        names.add(`${prefix}_${suffix}`);
  const actual = db
    .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  if (actual.some((row) => !names.has(row.name))) fail();
  if (
    sourceOnly ||
    ([8, 9, 10] as readonly (number | undefined)[]).includes(
      config.schema_version,
    )
  ) {
    // The global integrity pragma invokes FTS5's integrity hook. Repair must
    // still be able to read sound source facts when only that index is damaged.
    for (const sql of config.schema_manifest) {
      const table = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/.exec(
        sql,
      )?.[1];
      if (
        !table ||
        (sourceOnly && table.startsWith("retrieval_")) ||
        table.startsWith("knowledge_retrieval_") ||
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
      schema_version: config.schema_version ?? 4,
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
    schema_version: config.schema_version ?? 4,
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
export interface KnowledgeRetrievalEntry {
  readonly artifact_id: string;
  readonly content_sha256: string;
  readonly manifest_sha256: string;
  readonly scope_kind: "literature" | "manifest";
  readonly scope_key: string;
  readonly purpose: "overview" | "detailed" | "question" | "synthesis";
  readonly question_sha256: string;
  readonly statement_id: string;
  readonly statement_ordinal: number;
  readonly statement_sha256: string;
  readonly source_literature_ids: readonly string[];
  readonly scope_complete: 0 | 1;
  readonly is_default: 0 | 1;
  readonly title: string;
  readonly body: string;
}
const KNOWLEDGE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const KNOWLEDGE_HASH = /^[0-9a-f]{64}$/;
const KNOWLEDGE_STATEMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
function validateKnowledgeEntries(
  entries: readonly KnowledgeRetrievalEntry[],
): void {
  let bytes = 0;
  const seen = new Set<string>();
  const ordinals = new Set<string>();
  const keys = [
    "artifact_id",
    "content_sha256",
    "manifest_sha256",
    "scope_kind",
    "scope_key",
    "purpose",
    "question_sha256",
    "statement_id",
    "statement_ordinal",
    "statement_sha256",
    "source_literature_ids",
    "scope_complete",
    "is_default",
    "title",
    "body",
  ];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join("\0") !== [...keys].sort().join("\0")
    )
      throw new RetrievalStorageError("index-corrupt");
    const sources = entry.source_literature_ids;
    if (
      !KNOWLEDGE_ID.test(entry.artifact_id) ||
      !KNOWLEDGE_HASH.test(entry.content_sha256) ||
      !KNOWLEDGE_HASH.test(entry.manifest_sha256) ||
      !["literature", "manifest"].includes(entry.scope_kind) ||
      !(entry.scope_kind === "literature" ? KNOWLEDGE_ID : KNOWLEDGE_HASH).test(
        entry.scope_key,
      ) ||
      !["overview", "detailed", "question", "synthesis"].includes(
        entry.purpose,
      ) ||
      (entry.purpose === "synthesis") !== (entry.scope_kind === "manifest") ||
      !KNOWLEDGE_HASH.test(entry.question_sha256) ||
      !KNOWLEDGE_STATEMENT_ID.test(entry.statement_id) ||
      !Number.isSafeInteger(entry.statement_ordinal) ||
      entry.statement_ordinal < 0 ||
      entry.statement_ordinal >= 64 ||
      !KNOWLEDGE_HASH.test(entry.statement_sha256) ||
      !Array.isArray(sources) ||
      sources.length < 1 ||
      sources.length > 1024 ||
      sources.some(
        (source, index) =>
          !KNOWLEDGE_ID.test(source) ||
          (index > 0 && sources[index - 1]! >= source),
      ) ||
      (entry.scope_kind === "literature" &&
        (sources.length !== 1 || sources[0] !== entry.scope_key)) ||
      (entry.scope_complete !== 0 && entry.scope_complete !== 1) ||
      (entry.is_default !== 0 && entry.is_default !== 1) ||
      (entry.scope_kind === "manifest" && entry.is_default !== 0) ||
      typeof entry.title !== "string" ||
      typeof entry.body !== "string" ||
      !entry.title ||
      !entry.body
    )
      throw new RetrievalStorageError("index-corrupt");
    const key = `${entry.artifact_id}\0${entry.statement_id}`;
    const ordinal = `${entry.artifact_id}\0${entry.statement_ordinal}`;
    if (seen.has(key) || ordinals.has(ordinal))
      throw new RetrievalStorageError("index-corrupt");
    seen.add(key);
    ordinals.add(ordinal);
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (
      bytes > 1024 * 1024 ||
      Buffer.byteLength(entry.title) > 8192 ||
      Buffer.byteLength(entry.body) > 65536
    )
      throw new RetrievalStorageError("index-corrupt");
  }
}
export interface KnowledgeRetrievalHit
  extends Omit<KnowledgeRetrievalEntry, "title" | "body"> {
  readonly entry_id: number;
  readonly score: number;
}
export type KnowledgeRetrievalGeneration = RetrievalGeneration;
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
  private knowledgeRepairGeneration: string | null = null;
  private knowledgeInspectionCache: {
    dataVersion: number;
    active: KnowledgeRetrievalGeneration | null;
  } | null = null;
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
    if (
      ([8, 9, 10] as readonly (number | undefined)[]).includes(
        this.config.schema_version,
      ) &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='knowledge_retrieval_fts'",
        )
        .get()
    )
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.knowledge_retrieval_fts_vocab USING fts5vocab(main,knowledge_retrieval_fts,instance)",
      );
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
        this.knowledgeInspectionCache = null;
      }
      return;
    }
    if (current !== this.observedDataVersion) {
      this.db.close();
      this.db = this.connect();
      this.observedDataVersion = this.dataVersion();
      this.validatedDataVersion = null;
      this.knowledgeInspectionCache = null;
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
        `SELECT v.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,NULL AS authors,NULL AS keywords,m.venue,m.publisher,m.publication_year,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.role='primary-pdf') AS primary_asset_id,v.document_version_id,v.representation_sha256,v.source_asset_id,v.source_sha256 AS source_asset_sha256,CASE WHEN d.document_version_id=v.document_version_id AND v.source_asset_id=(SELECT asset_id FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.role='primary-pdf') THEN 1 ELSE 0 END AS is_default FROM document_versions v JOIN literatures l ON l.literature_id=v.literature_id JOIN literature_metadata m ON m.literature_id=v.literature_id LEFT JOIN document_defaults d ON d.document_id=v.document_id WHERE (? IS NULL OR v.document_version_id>?) ORDER BY v.document_version_id LIMIT ?`,
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        "CREATE TEMP TABLE IF NOT EXISTS retrieval_repair_text(entry_id INTEGER PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL)",
      );
      this.db.exec("DELETE FROM temp.retrieval_repair_text");
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
      this.repairGeneration = repairing ? id : null;
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  insertEntries(
    generationId: string,
    entries: readonly RetrievalEntry[],
    sourceCount: number,
  ): void {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        "INSERT INTO retrieval_entries(generation_id,kind,literature_id,meta_literature_id,metadata_revision,metadata_sha256,document_version_id,representation_sha256,source_asset_id,source_asset_sha256,unit_start_utf8,unit_end_utf8,unit_sha256,section_id,unit_ordinal,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      const fts = this.db.prepare(
        "INSERT INTO retrieval_fts(rowid,title,body) VALUES(?,?,?)",
      );
      const repairText = this.db.prepare(
        "INSERT INTO temp.retrieval_repair_text(entry_id,title,body) VALUES(?,?,?)",
      );
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
        if (this.repairGeneration === generationId)
          repairText.run(result.lastInsertRowid, e.title, e.body);
        else fts.run(result.lastInsertRowid, e.title, e.body);
      }
      this.db
        .prepare(
          "UPDATE retrieval_generations SET entry_count=entry_count+?,fts_count=fts_count+?,source_count=source_count+? WHERE generation_id=? AND status='building'",
        )
        .run(entries.length, entries.length, sourceCount, generationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  publish(generationId: string, sourceRevision: number): RetrievalGeneration {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
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
      const repairing = this.repairGeneration === generationId;
      const ftsCount = Number(
        (
          this.db
            .prepare(
              repairing
                ? "SELECT count(*) AS n FROM temp.retrieval_repair_text t JOIN retrieval_entries e ON e.entry_id=t.entry_id WHERE e.generation_id=?"
                : "SELECT count(*) AS n FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=?",
            )
            .get(generationId) as { n: number }
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
        this.db.exec(
          "INSERT INTO retrieval_fts(rowid,title,body) SELECT entry_id,title,body FROM temp.retrieval_repair_text ORDER BY entry_id",
        );
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
        this.db.exec("DELETE FROM temp.retrieval_repair_text");
      }
      this.db.exec("COMMIT");
      if (repairing) this.repairGeneration = null;
      return {
        generation_id: row.generation_id,
        source_revision: row.source_revision,
        entry_count: row.entry_count,
        source_count: row.source_count,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  private requireKnowledge(): void {
    if (
      !([8, 9, 10] as readonly (number | undefined)[]).includes(
        this.config.schema_version,
      )
    )
      throw new RetrievalStorageError("index-unavailable");
  }
  knowledgeRevision(): number {
    this.requireKnowledge();
    this.refreshReader(true);
    return this.readKnowledgeRevision();
  }
  private readKnowledgeRevision(): number {
    const row = this.db
      .prepare(
        "SELECT revision FROM knowledge_retrieval_source_revision WHERE singleton=1",
      )
      .get() as { revision?: unknown } | undefined;
    if (!row || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0)
      throw new RetrievalStorageError("index-corrupt");
    return Number(row.revision);
  }
  knowledgeSourcePage(
    after: string | null,
    limit: number,
  ): readonly {
    artifact_id: string;
    content_sha256: string;
    manifest_sha256: string;
    scope_kind: "literature" | "manifest";
    scope_key: string;
    purpose: KnowledgeRetrievalEntry["purpose"];
    question_sha256: string;
    default_artifact_id: string | null;
  }[] {
    this.requireKnowledge();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw new RetrievalStorageError("index-corrupt");
    this.refreshReader(true);
    return this.db
      .prepare(
        "SELECT k.artifact_id,k.content_sha256,k.manifest_sha256,k.scope_kind,k.scope_key,k.purpose,k.question_sha256,d.artifact_id AS default_artifact_id FROM knowledge_artifacts k LEFT JOIN knowledge_defaults d ON d.artifact_id=k.artifact_id WHERE (? IS NULL OR k.artifact_id>?) ORDER BY k.artifact_id LIMIT ?",
      )
      .all(after, after, limit) as unknown as ReturnType<
      RetrievalStorageEngine["knowledgeSourcePage"]
    >;
  }
  private inspectKnowledge(sourceOnly = false): {
    revision: number;
    active: KnowledgeRetrievalGeneration | null;
  } {
    this.requireKnowledge();
    this.db.exec("BEGIN");
    try {
      inspectCatalogWithRetrieval(this.db, this.config, undefined, true);
      inspectKnowledgeProjectionDdl(this.db, this.config);
      const revision = this.readKnowledgeRevision();
      if (sourceOnly) {
        this.db.exec("COMMIT");
        return { revision, active: null };
      }
      const generations = this.db
        .prepare(
          "SELECT generation_id,status,entry_count,source_count,content_sha256,posting_sha256 FROM knowledge_retrieval_generations",
        )
        .all() as {
        generation_id: string;
        status: string;
        entry_count: number;
        source_count: number;
        content_sha256: string | null;
        posting_sha256: string | null;
      }[];
      for (const generation of generations) {
        const entries = Number(
          (
            this.db
              .prepare(
                "SELECT count(*) AS n FROM knowledge_retrieval_entries WHERE generation_id=?",
              )
              .get(generation.generation_id) as { n: number }
          ).n,
        );
        if (entries !== generation.entry_count) throw new Error();
        if (generation.status === "ready") {
          const fts = Number(
            (
              this.db
                .prepare(
                  "SELECT count(*) AS n FROM knowledge_retrieval_entries e JOIN knowledge_retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=?",
                )
                .get(generation.generation_id) as { n: number }
            ).n,
          );
          if (fts !== entries) throw new Error();
          const hashes = knowledgeHashes(this.db, generation.generation_id);
          if (
            hashes.content_sha256 !== generation.content_sha256 ||
            hashes.posting_sha256 !== generation.posting_sha256
          )
            throw new Error();
        } else if (
          generation.status !== "building" ||
          generation.content_sha256 !== null ||
          generation.posting_sha256 !== null
        )
          throw new Error();
      }
      if (
        this.db
          .prepare(
            "SELECT f.rowid FROM knowledge_retrieval_fts f LEFT JOIN knowledge_retrieval_entries e ON e.entry_id=f.rowid WHERE e.entry_id IS NULL LIMIT 1",
          )
          .get()
      )
        throw new Error();
      const pointer = this.db
        .prepare(
          "SELECT generation_id FROM knowledge_retrieval_active WHERE singleton=1",
        )
        .get() as { generation_id?: unknown } | undefined;
      const active = pointer?.generation_id;
      if (
        active !== undefined &&
        (typeof active !== "string" ||
          !generations.some(
            (g) => g.generation_id === active && g.status === "ready",
          ))
      )
        throw new Error();
      const activeRow =
        typeof active === "string"
          ? (this.db
              .prepare(
                "SELECT generation_id,source_revision,entry_count,source_count FROM knowledge_retrieval_generations WHERE generation_id=?",
              )
              .get(active) as KnowledgeRetrievalGeneration | undefined)
          : null;
      if (active !== undefined && !activeRow) throw new Error();
      this.db.exec("COMMIT");
      return { revision, active: activeRow ?? null };
    } catch {
      this.db.exec("ROLLBACK");
      throw new RetrievalStorageError("index-corrupt");
    }
  }
  knowledgeBegin(revision: number): string {
    this.requireKnowledge();
    this.refreshReader(true);
    const id = randomUUID();
    let repairing = false;
    try {
      this.inspectKnowledge();
    } catch {
      this.inspectKnowledge(true);
      repairing = true;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.readKnowledgeRevision() !== revision)
        throw new RetrievalStorageError("index-stale");
      this.db.exec(
        "CREATE TEMP TABLE IF NOT EXISTS knowledge_retrieval_repair_text(entry_id INTEGER PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL)",
      );
      this.db.exec("DELETE FROM temp.knowledge_retrieval_repair_text");
      if (!repairing) {
        this.db.exec(
          "DELETE FROM knowledge_retrieval_fts WHERE rowid IN (SELECT e.entry_id FROM knowledge_retrieval_entries e JOIN knowledge_retrieval_generations g ON g.generation_id=e.generation_id WHERE g.status='building')",
        );
        this.db.exec(
          "DELETE FROM knowledge_retrieval_generations WHERE status='building'",
        );
      }
      this.db
        .prepare(
          "INSERT INTO knowledge_retrieval_generations(generation_id,index_schema_version,source_revision,status,entry_count,source_count,created_at) VALUES(?,1,?,'building',0,0,?)",
        )
        .run(id, revision, new Date().toISOString());
      this.db.exec("COMMIT");
      this.knowledgeInspectionCache = null;
      this.knowledgeRepairGeneration = repairing ? id : null;
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  knowledgeInsert(
    id: string,
    entries: readonly KnowledgeRetrievalEntry[],
    sourceCount: number,
  ): void {
    this.requireKnowledge();
    this.refreshReader(true);
    if (
      !Array.isArray(entries) ||
      entries.length > 128 ||
      !Number.isSafeInteger(sourceCount) ||
      sourceCount < 0 ||
      sourceCount > 1
    )
      throw new RetrievalStorageError("index-corrupt");
    validateKnowledgeEntries(entries);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        "INSERT INTO knowledge_retrieval_entries(generation_id,artifact_id,content_sha256,manifest_sha256,scope_kind,scope_key,purpose,question_sha256,statement_id,statement_ordinal,statement_sha256,source_literature_ids_json,scope_complete,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      const fts = this.db.prepare(
        "INSERT INTO knowledge_retrieval_fts(rowid,title,body) VALUES(?,?,?)",
      );
      const repair = this.db.prepare(
        "INSERT INTO temp.knowledge_retrieval_repair_text(entry_id,title,body) VALUES(?,?,?)",
      );
      for (const entry of entries) {
        if (
          this.db
            .prepare(
              "SELECT 1 FROM knowledge_retrieval_entries WHERE generation_id=? AND artifact_id=? AND (statement_id=? OR statement_ordinal=?)",
            )
            .get(
              id,
              entry.artifact_id,
              entry.statement_id,
              entry.statement_ordinal,
            )
        )
          throw new RetrievalStorageError("index-corrupt");
        const result = insert.run(
          id,
          entry.artifact_id,
          entry.content_sha256,
          entry.manifest_sha256,
          entry.scope_kind,
          entry.scope_key,
          entry.purpose,
          entry.question_sha256,
          entry.statement_id,
          entry.statement_ordinal,
          entry.statement_sha256,
          JSON.stringify(entry.source_literature_ids),
          entry.scope_complete,
          entry.is_default,
        );
        if (this.knowledgeRepairGeneration === id)
          repair.run(result.lastInsertRowid, entry.title, entry.body);
        else fts.run(result.lastInsertRowid, entry.title, entry.body);
      }
      const updated = this.db
        .prepare(
          "UPDATE knowledge_retrieval_generations SET entry_count=entry_count+?,source_count=source_count+? WHERE generation_id=? AND status='building'",
        )
        .run(entries.length, sourceCount, id);
      if (updated.changes !== 1)
        throw new RetrievalStorageError("index-corrupt");
      this.db.exec("COMMIT");
      this.knowledgeInspectionCache = null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  knowledgePublish(id: string, revision: number): KnowledgeRetrievalGeneration {
    this.requireKnowledge();
    this.refreshReader(true);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.readKnowledgeRevision() !== revision)
        throw new RetrievalStorageError("index-stale");
      const row = this.db
        .prepare(
          "SELECT generation_id,source_revision,entry_count,source_count FROM knowledge_retrieval_generations WHERE generation_id=? AND status='building'",
        )
        .get(id) as KnowledgeRetrievalGeneration | undefined;
      if (!row || row.source_revision !== revision)
        throw new RetrievalStorageError("index-corrupt");
      const count = Number(
        (
          this.db
            .prepare(
              "SELECT count(*) AS n FROM knowledge_retrieval_entries WHERE generation_id=?",
            )
            .get(id) as { n: number }
        ).n,
      );
      const repairing = this.knowledgeRepairGeneration === id;
      const indexed = Number(
        (
          this.db
            .prepare(
              repairing
                ? "SELECT count(*) AS n FROM temp.knowledge_retrieval_repair_text t JOIN knowledge_retrieval_entries e ON e.entry_id=t.entry_id WHERE e.generation_id=?"
                : "SELECT count(*) AS n FROM knowledge_retrieval_entries e JOIN knowledge_retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=?",
            )
            .get(id) as { n: number }
        ).n,
      );
      if (count !== row.entry_count || indexed !== count)
        throw new RetrievalStorageError("index-corrupt");
      if (repairing) {
        this.db.exec("DROP TABLE knowledge_retrieval_fts");
        this.db.exec(
          "CREATE VIRTUAL TABLE knowledge_retrieval_fts USING fts5(title,body,tokenize='unicode61')",
        );
        this.db.exec(
          "INSERT INTO knowledge_retrieval_fts(rowid,title,body) SELECT entry_id,title,body FROM temp.knowledge_retrieval_repair_text ORDER BY entry_id",
        );
      }
      this.db
        .prepare(
          "INSERT INTO knowledge_retrieval_fts(knowledge_retrieval_fts) VALUES('integrity-check')",
        )
        .run();
      const hashes = knowledgeHashes(this.db, id);
      this.db
        .prepare(
          "UPDATE knowledge_retrieval_generations SET status='ready',content_sha256=?,posting_sha256=? WHERE generation_id=?",
        )
        .run(hashes.content_sha256, hashes.posting_sha256, id);
      this.db
        .prepare(
          "INSERT INTO knowledge_retrieval_active(singleton,generation_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id",
        )
        .run(id);
      if (repairing)
        this.db
          .prepare(
            "DELETE FROM knowledge_retrieval_generations WHERE generation_id<>?",
          )
          .run(id);
      this.db.exec("COMMIT");
      this.knowledgeInspectionCache = null;
      this.knowledgeRepairGeneration = null;
      return row;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  knowledgeActive(): KnowledgeRetrievalGeneration | null {
    this.requireKnowledge();
    this.refreshReader(true);
    const version = this.dataVersion();
    if (this.knowledgeInspectionCache?.dataVersion === version)
      return this.knowledgeInspectionCache.active;
    const active = this.inspectKnowledge().active;
    this.knowledgeInspectionCache = { dataVersion: version, active };
    return active;
  }
  knowledgeCoverage(
    generationId: string,
    scope: readonly string[],
    artifactIds: readonly string[] | null,
    purposes: readonly string[],
    questionSha: string | null,
    selection: "all" | "defaults" | "explicit",
  ): {
    any: boolean;
    missing_literature_ids: readonly string[];
    missing_artifact_ids: readonly string[];
  } {
    this.requireKnowledge();
    this.refreshReader(true);
    const where =
      "e.generation_id=? AND e.purpose IN (SELECT value FROM json_each(?)) AND (? IS NULL OR e.question_sha256=?) AND (?='all' OR (?='defaults' AND e.is_default=1) OR (?='explicit' AND e.artifact_id IN (SELECT value FROM json_each(?)))) AND (?=0 OR e.artifact_id IN (SELECT value FROM json_each(?))) AND (?=0 OR (e.scope_complete=1 AND NOT EXISTS(SELECT 1 FROM json_each(e.source_literature_ids_json) s WHERE s.value NOT IN (SELECT value FROM json_each(?)))))";
    const bound = [
      generationId,
      JSON.stringify(purposes),
      questionSha,
      questionSha,
      selection,
      selection,
      selection,
      JSON.stringify(artifactIds ?? []),
      artifactIds?.length ?? 0,
      JSON.stringify(artifactIds ?? []),
      scope.length,
      JSON.stringify(scope),
    ];
    const exists = (extra: string, value?: string) =>
      !!this.db
        .prepare(
          `SELECT 1 FROM knowledge_retrieval_entries e WHERE ${where}${extra} LIMIT 1`,
        )
        .get(...bound, ...(value === undefined ? [] : [value]));
    const any = exists("");
    const missing_literature_ids = scope.length
      ? scope.filter(
          (id) =>
            !exists(
              " AND EXISTS(SELECT 1 FROM json_each(e.source_literature_ids_json) s WHERE s.value=?)",
              id,
            ),
        )
      : [];
    const missing_artifact_ids = artifactIds?.length
      ? artifactIds.filter((id) => !exists(" AND e.artifact_id=?", id))
      : [];
    return { any, missing_literature_ids, missing_artifact_ids };
  }
  knowledgeSearch(
    ftsQuery: string,
    terms: readonly string[],
    generationId: string,
    scope: readonly string[],
    artifactIds: readonly string[] | null,
    purposes: readonly string[],
    questionSha: string | null,
    selection: "all" | "defaults" | "explicit",
    limit: number,
  ): { hits: readonly KnowledgeRetrievalHit[]; candidateLimit: boolean } {
    this.requireKnowledge();
    this.refreshReader(true);
    const rows = this.db
      .prepare(
        "SELECT e.entry_id,e.artifact_id,e.content_sha256,e.manifest_sha256,e.scope_kind,e.scope_key,e.purpose,e.question_sha256,e.statement_id,e.statement_ordinal,e.statement_sha256,e.source_literature_ids_json,e.scope_complete,e.is_default,f.title,f.body FROM knowledge_retrieval_fts f JOIN knowledge_retrieval_entries e ON e.entry_id=f.rowid WHERE knowledge_retrieval_fts MATCH ? AND e.generation_id=? AND e.purpose IN (SELECT value FROM json_each(?)) AND (? IS NULL OR e.question_sha256=?) AND (?='all' OR (?='defaults' AND e.is_default=1) OR (?='explicit' AND e.artifact_id IN (SELECT value FROM json_each(?)))) AND (?=0 OR e.artifact_id IN (SELECT value FROM json_each(?))) AND (?=0 OR (e.scope_complete=1 AND NOT EXISTS(SELECT 1 FROM json_each(e.source_literature_ids_json) s WHERE s.value NOT IN (SELECT value FROM json_each(?))))) ORDER BY e.entry_id LIMIT 4098",
      )
      .all(
        ftsQuery,
        generationId,
        JSON.stringify(purposes),
        questionSha,
        questionSha,
        selection,
        selection,
        selection,
        JSON.stringify(artifactIds ?? []),
        artifactIds?.length ?? 0,
        JSON.stringify(artifactIds ?? []),
        scope.length,
        JSON.stringify(scope),
      ) as unknown as (Omit<
      KnowledgeRetrievalHit,
      "score" | "source_literature_ids"
    > & { title: string; body: string; source_literature_ids_json: string })[];
    const hits = rows
      .slice(0, 4097)
      .map((row) => {
        const { title, body, source_literature_ids_json, ...rest } = row;
        return {
          ...rest,
          source_literature_ids: JSON.parse(
            source_literature_ids_json,
          ) as string[],
          score: scoreText(title, body, terms),
        } as KnowledgeRetrievalHit;
      })
      .sort(
        (a, b) =>
          a.score - b.score ||
          compareText(a.artifact_id, b.artifact_id) ||
          a.statement_ordinal - b.statement_ordinal,
      );
    return { hits: hits.slice(0, limit), candidateLimit: rows.length > 4097 };
  }
}
