const { visibleLiteratureSql }: typeof import("./intake-visibility.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-visibility.ts"
        : "./intake-visibility.js",
      import.meta.url,
    ).href
  );
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type * as Schema from "./schema.js";
const { SCHEMA_VERSION }: typeof Schema = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./schema.ts" : "./schema.js",
    import.meta.url,
  ).href
);
const { CatalogCorruptionError, catalogCorruption } = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./errors.ts" : "./errors.js",
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
  readonly hashes: "verified" | "not-current";
}
/** Invalidated full-verification certificate; never interpreted as a real hash. */
export const RETRIEVAL_UNVERIFIED = "0".repeat(64);
export const RETRIEVAL_CORRUPT = "f".repeat(64);
/** Fixed schema work only. No source, entry, FTS or integrity scan. */
export function inspectRetrievalIdentity(
  db: DatabaseSync,
  config: RetrievalSchemaConfig,
): void {
  const row = db
    .prepare(
      "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get();
  if (
    row?.product !== "sciretriever" ||
    row.schema_version !== config.schema_version ||
    row.schema_fingerprint !== config.schema_fingerprint
  )
    fail();
  for (const sql of config.schema_manifest) {
    const name =
      /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER|VIEW) (retrieval_[a-z_]+)/u.exec(
        sql,
      )?.[1];
    if (
      name &&
      db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)
        ?.sql !== sql
    )
      fail();
  }
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
  onHashes?: (
    generation: string,
    hashes: ReturnType<typeof retrievalHashes>,
  ) => void,
): RetrievalCatalogInspection {
  // A SAVEPOINT also works inside an outer writer transaction. SQLite fixes the
  // read snapshot at the first statement and keeps it through the final pointer.
  db.exec("SAVEPOINT sciretriever_retrieval_inspect");
  try {
    const result = inspectCatalogSnapshot(
      db,
      config,
      checkpoint,
      sourceOnly,
      onHashes,
    );
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
  onHashes?: (
    generation: string,
    hashes: ReturnType<typeof retrievalHashes>,
  ) => void,
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
      hashes: "not-current",
    };
  // Retired and unpublished generations cannot be queried and may be partly
  // reclaimed. SQLite/FK/FTS physical checks above still cover the full file;
  // logical projection counts and certificates apply to the active state.
  const counts = db
    .prepare(
      "SELECT g.generation_id,g.status,g.entry_count,g.fts_count,g.content_sha256,g.posting_sha256,(SELECT count(*) FROM retrieval_entries e WHERE e.generation_id=g.generation_id) AS actual_entries,(SELECT count(*) FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=g.generation_id) AS actual_fts FROM retrieval_generations g WHERE g.generation_id=(SELECT generation_id FROM retrieval_active_generation WHERE singleton=1)",
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
      onHashes?.(row.generation_id, hashes);
      if (
        row.posting_sha256 === RETRIEVAL_CORRUPT ||
        (row.content_sha256 !== RETRIEVAL_UNVERIFIED &&
          (row.content_sha256 !== hashes.content_sha256 ||
            row.posting_sha256 !== hashes.posting_sha256))
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
    hashes: counts.some(
      (r) => r.status === "ready" && r.content_sha256 === RETRIEVAL_UNVERIFIED,
    )
      ? "not-current"
      : "verified",
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
export interface RetrievalIndexState {
  readonly generation: RetrievalGeneration | null;
  readonly source_revision: number;
  readonly state_token: string | null;
}
type SourceStamp = readonly [
  string,
  string,
  number,
  string,
  "metadata" | "document",
  string | null,
  string | null,
  string | null,
  string | null,
  number,
];
export interface RetrievalChangeScan {
  readonly revision: number;
  readonly generation: RetrievalGeneration | null;
  readonly literature_ids: readonly string[];
}
function stamps(rows: readonly SourceStamp[]) {
  return JSON.stringify(rows);
}
export class RetrievalStorageError extends Error {
  readonly code:
    | "index-unavailable"
    | "index-corrupt"
    | "index-stale"
    | "index-limit";
  constructor(
    code: "index-unavailable" | "index-corrupt" | "index-stale" | "index-limit",
  ) {
    super(code);
    this.code = code;
  }
}

/** SQLite projection adapter. It never treats indexed text as source content. */
export class RetrievalStorageEngine {
  private db: DatabaseSync;
  private observedDataVersion: number;
  private repairGeneration: string | null = null;
  private repairText: DatabaseSync | null = null;
  private verification: {
    token: string;
    generation: string;
    revision: number;
    dataVersion: number;
    hashes: ReturnType<typeof retrievalHashes>;
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
        inspectRetrievalIdentity(this.db, this.config);
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
  private refreshReader(): void {
    // A SAVEPOINT/transaction already pins its SQLite snapshot. Reopening here
    // would discard both the snapshot and the caller's transaction boundary.
    if (this.db.isTransaction) return;
    const current = this.dataVersion();
    if (!this.readOnly) {
      if (current !== this.observedDataVersion) {
        this.verification = null;
        this.db.close();
        this.db = this.connect();
        inspectRetrievalIdentity(this.db, this.config);
        this.observedDataVersion = this.dataVersion();
      }
      return;
    }
    if (current !== this.observedDataVersion) {
      this.verification = null;
      this.db.close();
      this.db = this.connect();
      this.observedDataVersion = this.dataVersion();
    }
    inspectRetrievalIdentity(this.db, this.config);
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
        `SELECT l.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,m.venue,m.publisher,m.publication_year,(SELECT group_concat(display_name,' ') FROM literature_metadata_authors a WHERE a.literature_id=l.literature_id) AS authors,(SELECT group_concat(keyword,' ') FROM literature_metadata_keywords k WHERE k.literature_id=l.literature_id) AS keywords,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf') AS primary_asset_id FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE ${visibleLiteratureSql("l.literature_id")} AND (? IS NULL OR l.literature_id>?) ORDER BY l.literature_id LIMIT ?`,
      )
      .all(after, after, limit) as unknown as RetrievalSource[];
  }
  sourceCount(): number {
    this.refreshReader();
    return Number(
      this.db
        .prepare(
          `SELECT (SELECT count(*) FROM literatures l JOIN literature_metadata USING(literature_id) WHERE ${visibleLiteratureSql("l.literature_id")})+(SELECT count(*) FROM document_versions v JOIN literatures USING(literature_id) JOIN literature_metadata USING(literature_id) WHERE ${visibleLiteratureSql("v.literature_id")}) AS n`,
        )
        .get()!.n,
    );
  }
  /** Only indexed scalar fingerprints: no artifact, body or FTS access. */
  private sourceStamps(literature?: string): SourceStamp[] {
    return this.db
      .prepare(
        `
      SELECT l.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,'metadata' AS kind,NULL AS document_version_id,NULL AS representation_sha256,NULL AS source_asset_id,NULL AS source_asset_sha256,1 AS is_default
      FROM literatures l JOIN literature_metadata m USING(literature_id) WHERE ${visibleLiteratureSql("l.literature_id")} ${literature === undefined ? "" : "AND l.literature_id=?"}
      UNION ALL
      SELECT v.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,'document',v.document_version_id,v.representation_sha256,v.source_asset_id,v.source_sha256,CASE WHEN d.document_version_id=v.document_version_id AND EXISTS(SELECT 1 FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.asset_id=v.source_asset_id AND p.role IN ('primary-pdf','supplementary-pdf')) THEN 1 ELSE 0 END
      FROM document_versions v JOIN literatures l USING(literature_id) JOIN literature_metadata m USING(literature_id) LEFT JOIN document_defaults d ON d.document_id=v.document_id WHERE ${visibleLiteratureSql("v.literature_id")} ${literature === undefined ? "" : "AND v.literature_id=?"}
      ORDER BY literature_id,kind,document_version_id
    `,
      )
      .all(...(literature === undefined ? [] : [literature, literature]))
      .map((row) => Object.values(row) as unknown as SourceStamp);
  }
  private indexedStamps(
    generation: string,
    literature?: string,
  ): SourceStamp[] {
    return this.db
      .prepare(
        `SELECT DISTINCT literature_id,meta_literature_id,metadata_revision,metadata_sha256,kind,document_version_id,representation_sha256,source_asset_id,source_asset_sha256,is_default FROM retrieval_entries WHERE generation_id=? ${literature === undefined ? "" : "AND kind IN ('metadata','document') AND literature_id=?"} ORDER BY literature_id,kind,document_version_id`,
      )
      .all(generation, ...(literature === undefined ? [] : [literature]))
      .map((row) => Object.values(row) as unknown as SourceStamp);
  }
  scanChanges(): RetrievalChangeScan {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_change_scan");
    try {
      const generation = this.active(),
        revision = this.revision();
      const group = (rows: readonly SourceStamp[]) => {
        const result = new Map<string, SourceStamp[]>();
        for (const row of rows) {
          const items = result.get(row[0]) ?? [];
          items.push(row);
          result.set(row[0], items);
        }
        return result;
      };
      const current = group(this.sourceStamps()),
        indexed = group(
          generation ? this.indexedStamps(generation.generation_id) : [],
        );
      const ids = [...new Set([...current.keys(), ...indexed.keys()])].sort();
      return {
        generation,
        revision,
        literature_ids: ids.filter(
          (id) =>
            stamps(current.get(id) ?? []) !== stamps(indexed.get(id) ?? []),
        ),
      };
    } finally {
      this.db.exec("RELEASE retrieval_change_scan");
    }
  }
  literatureSources(literature: string) {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_literature_sources");
    try {
      const metadata = this.metadataSource(literature);
      const documents = this.documentPage(null, 100_001, literature);
      return {
        fingerprint: stamps(this.sourceStamps(literature)),
        metadata,
        documents,
      };
    } finally {
      this.db.exec("RELEASE retrieval_literature_sources");
    }
  }
  /** A ready empty projection lets the first refresh use the same incremental path. */
  ensureActive(): RetrievalGeneration {
    this.refreshReader();
    const current = this.active();
    if (current) return current;
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO retrieval_generations(generation_id,index_schema_version,unit_rule,source_revision,status,entry_count,fts_count,source_count,content_sha256,posting_sha256,created_at) VALUES(?,1,'markdown-context-v1',0,'ready',0,0,0,?,?,?)",
        )
        .run(
          id,
          RETRIEVAL_UNVERIFIED,
          RETRIEVAL_UNVERIFIED,
          new Date().toISOString(),
        );
      this.db
        .prepare("INSERT INTO retrieval_active_generation VALUES(1,?)")
        .run(id);
      this.db.exec("COMMIT");
      return this.active()!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  beginLiteratureUpdate(): string {
    this.refreshReader();
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO retrieval_generations(generation_id,index_schema_version,unit_rule,source_revision,status,entry_count,fts_count,source_count,created_at) VALUES(?,1,'markdown-context-v1',?,'building',0,0,0,?)",
      )
      .run(id, this.revision(), new Date().toISOString());
    return id;
  }
  /** Caller owns the generation lock; all non-active stages are abandoned here. */
  pruneGenerationBatch(target: string | null = null): {
    entries_deleted: number;
    generations_deleted: number;
    done: boolean;
  } {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active =
        this.db
          .prepare(
            "SELECT generation_id FROM retrieval_active_generation WHERE singleton=1",
          )
          .get()?.generation_id ?? null;
      if (target !== null && target === active)
        throw new RetrievalStorageError("index-stale");
      const candidate = this.db
        .prepare(
          "SELECT generation_id FROM retrieval_generations WHERE generation_id IS NOT ? AND (? IS NULL OR generation_id=?) LIMIT 1",
        )
        .get(active, target, target);
      if (!candidate) {
        this.db.exec("COMMIT");
        return { entries_deleted: 0, generations_deleted: 0, done: true };
      }
      const id = String(candidate.generation_id);
      const selected = this.db
        .prepare(
          "SELECT e.entry_id,e.kind,e.literature_id,e.document_version_id,COALESCE(length(CAST(f.title AS BLOB))+length(CAST(f.body AS BLOB)),0) AS bytes FROM retrieval_entries e LEFT JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=? LIMIT 128",
        )
        .all(id);
      const rows: typeof selected = [];
      let bytes = 0;
      for (const row of selected) {
        const size = Number(row.bytes);
        if (rows.length && bytes + size > 1024 * 1024) break;
        rows.push(row);
        bytes += size;
      }
      const ids = JSON.stringify(rows.map((r) => r.entry_id));
      this.db
        .prepare(
          "DELETE FROM retrieval_fts WHERE rowid IN (SELECT value FROM json_each(?))",
        )
        .run(ids);
      const removed = Number(
        this.db
          .prepare(
            "DELETE FROM retrieval_entries WHERE generation_id=? AND entry_id IN (SELECT value FROM json_each(?))",
          )
          .run(id, ids).changes,
      );
      const sources = new Map(
        rows.map((r) => [
          JSON.stringify([r.kind, r.literature_id, r.document_version_id]),
          r,
        ]),
      );
      let removedSources = 0;
      const remains = this.db.prepare(
        "SELECT 1 FROM retrieval_entries WHERE generation_id=? AND kind=? AND literature_id=? AND document_version_id IS ? LIMIT 1",
      );
      for (const row of sources.values())
        if (
          !remains.get(
            id,
            row.kind!,
            row.literature_id!,
            row.document_version_id!,
          )
        )
          removedSources++;
      this.db
        .prepare(
          "UPDATE retrieval_generations SET entry_count=max(0,entry_count-?),fts_count=max(0,fts_count-?),source_count=max(0,source_count-?),content_sha256=CASE WHEN status='ready' THEN ? ELSE NULL END,posting_sha256=CASE WHEN status='ready' THEN ? ELSE NULL END WHERE generation_id=?",
        )
        .run(
          removed,
          removed,
          removedSources,
          RETRIEVAL_UNVERIFIED,
          RETRIEVAL_UNVERIFIED,
          id,
        );
      let removedGeneration = 0;
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM retrieval_entries WHERE generation_id=? LIMIT 1",
          )
          .get(id)
      )
        removedGeneration = Number(
          this.db
            .prepare("DELETE FROM retrieval_generations WHERE generation_id=?")
            .run(id).changes,
        );
      const pending = this.db
        .prepare(
          "SELECT 1 FROM retrieval_generations WHERE generation_id IS NOT ? AND (? IS NULL OR generation_id=?) LIMIT 1",
        )
        .get(active, target, target);
      this.db.exec("COMMIT");
      return {
        entries_deleted: removed,
        generations_deleted: removedGeneration,
        done: !pending,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  commitLiteratureUpdate(
    active: string,
    staged: string,
    literature: string,
    fingerprint: string,
  ): boolean {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.active()?.generation_id !== active)
        throw new RetrievalStorageError("index-stale");
      if (stamps(this.sourceStamps(literature)) !== fingerprint) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const oldSources = this.indexedStamps(active, literature).length;
      const newSources = this.indexedStamps(staged, literature).length;
      const activeHeader = this.active()!;
      const oldCount = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM retrieval_entries WHERE generation_id=? AND kind IN ('metadata','document') AND literature_id=?",
          )
          .get(active, literature)!.n,
      );
      const stage = this.db
        .prepare(
          "SELECT entry_count,fts_count,source_count FROM retrieval_generations WHERE generation_id=? AND status='building'",
        )
        .get(staged);
      if (!stage || stage.entry_count !== stage.fts_count) fail();
      if (
        activeHeader.entry_count + Number(stage.entry_count) - oldCount >
          2_000_000 ||
        activeHeader.source_count + newSources - oldSources > 100_000
      )
        throw new RetrievalStorageError("index-limit");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM retrieval_entries WHERE generation_id=? AND literature_id<>? LIMIT 1",
          )
          .get(staged, literature)
      )
        fail();
      this.db
        .prepare(
          "DELETE FROM retrieval_fts WHERE rowid IN (SELECT entry_id FROM retrieval_entries WHERE generation_id=? AND kind IN ('metadata','document') AND literature_id=?)",
        )
        .run(active, literature);
      this.db
        .prepare(
          "DELETE FROM retrieval_entries WHERE generation_id=? AND kind IN ('metadata','document') AND literature_id=?",
        )
        .run(active, literature);
      this.db
        .prepare(
          "UPDATE retrieval_entries SET generation_id=? WHERE generation_id=?",
        )
        .run(active, staged);
      this.db
        .prepare(
          "UPDATE retrieval_generations SET entry_count=entry_count+?,fts_count=fts_count+?,source_count=source_count+?,content_sha256=?,posting_sha256=? WHERE generation_id=? AND status='ready'",
        )
        .run(
          Number(stage.entry_count) - oldCount,
          Number(stage.fts_count) - oldCount,
          newSources - oldSources,
          RETRIEVAL_UNVERIFIED,
          // While the content certificate is invalid, this opaque marker
          // changes atomically with every accepted paper, including equal-size edits.
          createHash("sha256")
            .update(`retrieval-mutation-v1:${staged}`)
            .digest("hex"),
          active,
        );
      this.db
        .prepare("DELETE FROM retrieval_generations WHERE generation_id=?")
        .run(staged);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finishIncremental(generation: string, revision: number): RetrievalGeneration {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.active();
      if (
        !active ||
        active.generation_id !== generation ||
        !Number.isSafeInteger(revision) ||
        revision < active.source_revision ||
        revision > this.revision()
      )
        throw new RetrievalStorageError("index-stale");
      // Only the completed scan is covered. Publications after its snapshot
      // may still need indexing in the next round.
      this.db
        .prepare(
          "UPDATE retrieval_generations SET source_revision=? WHERE generation_id=?",
        )
        .run(revision, generation);
      this.db.exec("COMMIT");
      return { ...active, source_revision: revision };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  verificationEntries(generation: string, id: string): RetrievalEntry[] {
    this.refreshReader();
    return this.db
      .prepare(
        "SELECT e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body FROM retrieval_entries e LEFT JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=? AND e.kind IN ('metadata','document') AND e.literature_id=? ORDER BY e.kind,e.document_version_id,e.unit_ordinal,e.entry_id",
      )
      .all(generation, id) as unknown as RetrievalEntry[];
  }
  /** Explicit catalog maintenance, including an empty/unbuilt retrieval projection. */
  verifyCatalog(): RetrievalCatalogInspection {
    this.refreshReader();
    try {
      return inspectCatalogWithRetrieval(this.db, this.config);
    } catch (error) {
      const corruption = catalogCorruption(error);
      if (corruption) throw corruption;
      if (
        error instanceof RetrievalStorageError &&
        error.code === "index-corrupt"
      )
        throw new CatalogCorruptionError(null, { cause: error });
      throw error;
    }
  }
  /** Explicit maintenance only: this is intentionally not called by active/search. */
  verify(): { inspection: RetrievalCatalogInspection; proof: string } {
    this.refreshReader();
    this.verification = null;
    this.db
      .prepare(
        "INSERT INTO retrieval_fts(retrieval_fts) VALUES('integrity-check')",
      )
      .run();
    const observed = this.dataVersion(),
      hashes = new Map<string, ReturnType<typeof retrievalHashes>>();
    const inspection = inspectCatalogWithRetrieval(
      this.db,
      this.config,
      undefined,
      false,
      (id, value) => hashes.set(id, value),
    );
    const generation = inspection.active_generation,
      value = generation ? hashes.get(generation) : null;
    if (!generation || !value)
      throw new RetrievalStorageError("index-unavailable");
    if (this.dataVersion() !== observed)
      throw new RetrievalStorageError("index-stale");
    const token = randomUUID();
    this.verification = {
      token,
      generation,
      revision: inspection.source_revision,
      dataVersion: observed,
      hashes: value,
    };
    return { inspection, proof: token };
  }
  recordVerification(
    generation: string,
    revision: number,
    token: string,
  ): RetrievalGeneration {
    this.refreshReader();
    const proof = this.verification;
    this.verification = null;
    if (
      !proof ||
      proof.token !== token ||
      proof.generation !== generation ||
      proof.revision !== revision
    )
      throw new RetrievalStorageError("index-stale");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.dataVersion() !== proof.dataVersion ||
        this.revision() !== revision ||
        this.active()?.generation_id !== generation
      )
        throw new RetrievalStorageError("index-stale");
      this.db
        .prepare(
          "UPDATE retrieval_generations SET content_sha256=?,posting_sha256=? WHERE generation_id=?",
        )
        .run(
          proof.hashes.content_sha256,
          proof.hashes.posting_sha256,
          generation,
        );
      this.db.exec("COMMIT");
      return this.active()!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  markCorrupt(generation: string, revision: number): void {
    this.refreshReader();
    const result = this.db
      .prepare(
        "UPDATE retrieval_generations SET posting_sha256=? WHERE generation_id=? AND generation_id=(SELECT generation_id FROM retrieval_active_generation WHERE singleton=1) AND (SELECT revision FROM retrieval_source_revision WHERE singleton=1)=?",
      )
      .run(RETRIEVAL_CORRUPT, generation, revision);
    if (result.changes !== 1) throw new RetrievalStorageError("index-stale");
  }
  documentPage(
    after: string | null,
    limit: number,
    literature?: string,
  ): readonly RetrievalSource[] {
    return this.db
      .prepare(
        `SELECT v.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,NULL AS authors,NULL AS keywords,m.venue,m.publisher,m.publication_year,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.role='primary-pdf') AS primary_asset_id,v.document_version_id,v.representation_sha256,v.source_asset_id,v.source_sha256 AS source_asset_sha256,CASE WHEN d.document_version_id=v.document_version_id AND EXISTS(SELECT 1 FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.asset_id=v.source_asset_id AND p.role IN ('primary-pdf','supplementary-pdf')) THEN 1 ELSE 0 END AS is_default FROM document_versions v JOIN literatures l ON l.literature_id=v.literature_id JOIN literature_metadata m ON m.literature_id=v.literature_id LEFT JOIN document_defaults d ON d.document_id=v.document_id WHERE ${visibleLiteratureSql("v.literature_id")} AND (? IS NULL OR v.document_version_id>?) ${literature === undefined ? "" : "AND v.literature_id=?"} ORDER BY v.document_version_id LIMIT ?`,
      )
      .all(
        after,
        after,
        ...(literature === undefined ? [] : [literature]),
        limit,
      ) as unknown as RetrievalSource[];
  }
  beginGeneration(sourceRevision: number): string {
    this.refreshReader();
    this.validate(true);
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
      // Abandoned staging is retired in bounded batches after successful
      // publication. Do not cascade-delete an entire failed generation here.
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
      if (repairing) inspectCatalogWithRetrieval(this.db, this.config);
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
        "SELECT g.generation_id,g.source_revision,g.entry_count,g.fts_count,g.source_count,g.status,g.posting_sha256 FROM retrieval_active_generation a JOIN retrieval_generations g ON g.generation_id=a.generation_id WHERE a.singleton=1",
      )
      .get() as
      | (RetrievalGeneration & {
          fts_count: number;
          status: string;
          posting_sha256: string;
        })
      | undefined;
    if (pointer && !row) throw new RetrievalStorageError("index-corrupt");
    if (!row) return null;
    if (
      row.status !== "ready" ||
      row.entry_count !== row.fts_count ||
      row.posting_sha256 === RETRIEVAL_CORRUPT
    )
      throw new RetrievalStorageError("index-corrupt");
    return {
      generation_id: row.generation_id,
      source_revision: row.source_revision,
      entry_count: row.entry_count,
      source_count: row.source_count,
    };
  }
  /** Fixed-size snapshot; never scans entries, FTS or source fingerprints. */
  state(): RetrievalIndexState {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_state");
    try {
      const generation = this.active(),
        source_revision = this.revision();
      const certificate = generation
        ? this.db
            .prepare(
              "SELECT content_sha256,posting_sha256 FROM retrieval_generations WHERE generation_id=?",
            )
            .get(generation.generation_id)
        : null;
      const state_token = generation
        ? createHash("sha256")
            .update(JSON.stringify([generation, certificate]))
            .digest("hex")
        : null;
      this.db.exec("RELEASE retrieval_state");
      return { generation, source_revision, state_token };
    } catch (error) {
      this.db.exec("ROLLBACK TO retrieval_state; RELEASE retrieval_state");
      throw error;
    }
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
    this.db.exec("SAVEPOINT retrieval_search");
    try {
      if (this.active()?.generation_id !== generationId)
        throw new RetrievalStorageError("index-stale");
      const scopeJson = JSON.stringify(scope);
      const kindsJson = JSON.stringify(kinds);
      const versionsJson = JSON.stringify(explicitVersions ?? []);
      const rows = this.db
        .prepare(
          `SELECT e.entry_id,e.generation_id,e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,retrieval_fts.title,retrieval_fts.body,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=e.literature_id AND p.role='primary-pdf') AS primary_asset_id FROM retrieval_fts JOIN retrieval_entries e ON e.entry_id=retrieval_fts.rowid WHERE retrieval_fts MATCH ? AND ${visibleLiteratureSql("e.literature_id")} AND e.generation_id=? AND e.kind IN (SELECT value FROM json_each(?)) AND (json_array_length(?)=0 OR e.literature_id IN (SELECT value FROM json_each(?))) AND (e.kind='metadata' OR (?=0 AND e.is_default=1) OR (?=1 AND e.document_version_id IN (SELECT value FROM json_each(?)))) ORDER BY e.entry_id LIMIT 4098`,
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
          compareText(
            a.document_version_id ?? "",
            b.document_version_id ?? "",
          ) ||
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
      const result = {
        hits: ordered.filter(follows).slice(0, limit),
        candidateLimit: rows.length > 4097,
      };
      this.db.exec("RELEASE retrieval_search");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK TO retrieval_search; RELEASE retrieval_search");
      } catch {
        /* Preserve the original read failure. */
      }
      throw error;
    }
  }
  metadataSource(literatureId: string): RetrievalSource | null {
    const row = this.db
      .prepare(
        `SELECT l.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,m.venue,m.publisher,m.publication_year,(SELECT group_concat(display_name,' ') FROM literature_metadata_authors a WHERE a.literature_id=l.literature_id) AS authors,(SELECT group_concat(keyword,' ') FROM literature_metadata_keywords k WHERE k.literature_id=l.literature_id) AS keywords,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf') AS primary_asset_id FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE ${visibleLiteratureSql("l.literature_id")} AND l.literature_id=?`,
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
          `SELECT literature_id FROM literatures WHERE ${visibleLiteratureSql("literature_id")} AND literature_id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(scope)) as { literature_id: string }[];
      if (found.length !== scope.length)
        throw new RetrievalStorageError("index-stale");
    }
    if (explicit) {
      const matched = this.db
        .prepare(
          `SELECT count(*) AS n FROM json_each(?) j JOIN document_versions v ON v.document_version_id=json_extract(j.value,'$.document_version_id') AND v.literature_id=json_extract(j.value,'$.literature_id') AND v.representation_sha256=json_extract(j.value,'$.representation_sha256') WHERE ${visibleLiteratureSql("v.literature_id")}`,
        )
        .get(JSON.stringify(explicit)) as { n: number };
      if (matched.n !== explicit.length)
        throw new RetrievalStorageError("index-stale");
      return [];
    }
    if (!includeGaps) return [];
    if (!scope.length) {
      const missing = !!this.db
        .prepare(
          `SELECT 1 FROM literatures l WHERE ${visibleLiteratureSql("l.literature_id")} AND NOT EXISTS(SELECT 1 FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf') LIMIT 1`,
        )
        .get();
      const unrepresented = !!this.db
        .prepare(
          `SELECT 1 FROM literature_assets p WHERE ${visibleLiteratureSql("p.literature_id")} AND p.role='primary-pdf' AND NOT EXISTS(SELECT 1 FROM document_versions v JOIN document_defaults d ON d.document_version_id=v.document_version_id WHERE v.literature_id=p.literature_id AND v.source_asset_id=p.asset_id) LIMIT 1`,
        )
        .get();
      return [
        ...(missing
          ? [{ code: "material-missing" as const, literature_id: null }]
          : []),
        ...(unrepresented
          ? [{ code: "representation-missing" as const, literature_id: null }]
          : []),
      ];
    }
    const rows = this.db
      .prepare(
        `SELECT l.literature_id,(SELECT p.asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf') AS asset_id,EXISTS(SELECT 1 FROM document_defaults d JOIN document_versions v ON v.document_version_id=d.document_version_id WHERE v.literature_id=l.literature_id AND v.source_asset_id=(SELECT p.asset_id FROM literature_assets p WHERE p.literature_id=l.literature_id AND p.role='primary-pdf')) AS ready FROM literatures l WHERE ${visibleLiteratureSql("l.literature_id")} AND (json_array_length(?)=0 OR l.literature_id IN (SELECT value FROM json_each(?)))`,
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
        `SELECT 1 FROM document_defaults d JOIN document_versions v ON v.document_version_id=d.document_version_id WHERE ${visibleLiteratureSql("v.literature_id")} AND v.literature_id=? AND v.source_asset_id=?`,
      )
      .get(literatureId, assetId);
  }
}
