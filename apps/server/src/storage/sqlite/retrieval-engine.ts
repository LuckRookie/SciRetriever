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
import { RELEVANCE_RESULT_LIMIT } from "@sciretriever/contracts";
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import type { CatalogAdditionRequirement } from "./catalog-ddl.js";
import type * as Schema from "./schema.js";
const { SCHEMA_VERSION }: typeof Schema = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./schema.ts" : "./schema.js",
    import.meta.url,
  ).href
);
const { CatalogCorruptionError, catalogCorruption, sqliteStorageFull } =
  await import(
    new URL(
      import.meta.url.endsWith(".ts") ? "./errors.ts" : "./errors.js",
      import.meta.url,
    ).href
  );
const {
  readCatalogLayout,
  checkCatalogIdentityRows,
  CatalogLayoutError,
}: typeof import("./catalog-identity.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./catalog-identity.ts"
      : "./catalog-identity.js",
    import.meta.url,
  ).href
);

export interface RetrievalSchemaConfig {
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly schema_fingerprint: string;
  readonly schema_manifest: readonly string[];
  readonly schema_additions?: readonly CatalogAdditionRequirement[];
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
  if (config.schema_additions) {
    try {
      if (!readCatalogLayout(db, config)) fail();
    } catch (error) {
      if (
        !(error instanceof CatalogLayoutError) ||
        error.reason === "catalog-addition-required"
      )
        throw error;
      fail();
    }
    return;
  }
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
    "SELECT e.entry_id,e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body,e.translation_language,e.translation_sha256 FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=? ORDER BY e.entry_id",
  );
  for (const row of rows.iterate(generationId)) {
    // A translation entry adds its two fields; other entries hash as before.
    const { translation_language, translation_sha256, ...rest } = row;
    content.update(
      `${JSON.stringify([
        ...Object.values(rest),
        ...(translation_sha256 === null || translation_sha256 === undefined
          ? []
          : [translation_language, translation_sha256]),
      ])}\n`,
    );
  }
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
  const layout = config.schema_additions
    ? readCatalogLayout(db, config)
    : undefined;
  if (layout === null) fail();
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
    if (layout) continue;
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
  if (!layout && actual.some((row) => !names.has(row.name))) fail();
  if (sourceOnly || config.schema_version === SCHEMA_VERSION) {
    // The global integrity pragma invokes FTS5's integrity hook. Repair must
    // still be able to read sound source facts when only that index is damaged.
    const tables = config.schema_manifest.map(
      (sql) => /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/.exec(sql)?.[1],
    );
    if (layout && !sourceOnly)
      tables.push(
        ...layout.extra_objects
          .filter((object) => object.type === "table")
          .map((object) => object.name),
      );
    // A table-specific check of the FTS virtual table invokes the FTS5 hook.
    // Check the shadow table as well to cover its ordinary SQLite index.
    if (names.has("literature_search_fts_content_owner"))
      tables.push("literature_search_fts_content");
    for (const table of tables) {
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
          db
            .prepare("SELECT integrity_check FROM pragma_integrity_check(?)")
            .get(table) as { integrity_check?: unknown } | undefined
        )?.integrity_check !== "ok"
      )
        fail();
      if (
        db
          .prepare("SELECT 1 FROM pragma_foreign_key_check(?) LIMIT 1")
          .get(table)
      )
        fail();
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
    if (db.prepare("PRAGMA foreign_key_check").get()) fail();
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
/** Text rule written on a generation; an older or missing one reads as stale. */
export const RETRIEVAL_TEXT_RULE = "cjk-char-v1" as const;
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
  /** A stored translation of the original unit at the same range (spec 9.7). */
  readonly translation_language?: string | null;
  readonly translation_sha256?: string | null;
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
  /**
   * The active generation was built with the current text rule and the
   * caller's translation language; false reads as stale until a rebuild.
   */
  readonly rule_current: boolean;
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
export interface RetrievalChangeSnapshot {
  readonly generation: RetrievalGeneration | null;
  readonly revision: number;
  readonly position: number;
  readonly tail: number;
  readonly pending: number;
}
export interface RetrievalChange {
  readonly position: number;
  readonly literature_id: string;
}
export interface RetrievalCheckpoint {
  readonly previous: number;
  readonly position: number;
  readonly revision: number | null;
}
export interface RetrievalLiteratureUpdate {
  readonly literature_id: string;
  readonly fingerprint: string;
  /** Null means the same fingerprint is already indexed. */
  readonly entries: readonly RetrievalEntry[] | null;
}
function stamps(rows: readonly SourceStamp[]) {
  return JSON.stringify(rows);
}
/** The SELECTs order each literature's rows together in both streams. */
function* groupStamps(rows: Iterable<SourceStamp>) {
  let group: SourceStamp[] = [];
  for (const row of rows) {
    if (group.length && group[0]![0] !== row[0]) {
      yield { id: group[0]![0], fingerprint: stamps(group) };
      group = [];
    }
    group.push(row);
  }
  if (group.length) yield { id: group[0]![0], fingerprint: stamps(group) };
}
export class RetrievalStorageError extends Error {
  readonly code:
    | "index-unavailable"
    | "index-corrupt"
    | "index-stale"
    | "index-reconcile-required";
  constructor(code: RetrievalStorageError["code"]) {
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
  /** Set for each worker command from the caller's configuration. */
  translationLanguage: string | null = null;
  private readonly config: RetrievalSchemaConfig;
  private layoutProof: string | undefined;
  private fileIdentity: string;
  constructor(path: string, readOnly: boolean, config: RetrievalSchemaConfig) {
    this.path = path;
    this.readOnly = readOnly;
    this.config = config;
    this.db = this.connect();
    this.fileIdentity = this.catalogFileIdentity();
    this.observedDataVersion = this.dataVersion();
    if (!readOnly) {
      try {
        this.checkLayout();
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }
  private readonly path: string;
  private catalogFileIdentity(): string {
    if (this.path === ":memory:") return "memory";
    const file = statSync(this.path);
    return `${file.dev}:${file.ino}`;
  }
  private checkLayout(reconnected = false) {
    const proof = `${this.fileIdentity}:${this.db.prepare("PRAGMA schema_version").get()!.schema_version}`;
    if (proof === this.layoutProof) {
      if (reconnected) {
        try {
          checkCatalogIdentityRows(this.db, this.config);
        } catch (error) {
          this.layoutProof = undefined;
          if (
            !(error instanceof CatalogLayoutError) ||
            error.reason === "catalog-addition-required"
          )
            throw error;
          fail();
        }
      }
      return;
    }
    inspectRetrievalIdentity(this.db, this.config);
    this.layoutProof = proof;
  }
  private connect(): DatabaseSync {
    const db = new DatabaseSync(this.path, { readOnly: this.readOnly });
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");
    // Fingerprint and posting order may require SQLite to sort the corpus.
    db.exec("PRAGMA temp_store=FILE");
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
    const file = this.catalogFileIdentity();
    const reconnected =
      current !== this.observedDataVersion || file !== this.fileIdentity;
    if (reconnected) {
      this.verification = null;
      this.db.close();
      this.db = this.connect();
      this.fileIdentity = file;
      this.observedDataVersion = this.dataVersion();
    }
    this.checkLayout(reconnected);
  }
  private validate(sourceOnly: boolean): void {
    try {
      inspectCatalogWithRetrieval(this.db, this.config, undefined, sourceOnly);
    } catch (error) {
      if (sqliteStorageFull(error)) throw error;
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
  private *sourceStamps(literature?: string): Generator<SourceStamp> {
    const rows = this.db
      .prepare(
        `
      SELECT l.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,'metadata' AS kind,NULL AS document_version_id,NULL AS representation_sha256,NULL AS source_asset_id,NULL AS source_asset_sha256,1 AS is_default
      FROM literatures l JOIN literature_metadata m USING(literature_id) WHERE ${visibleLiteratureSql("l.literature_id")} ${literature === undefined ? "" : "AND l.literature_id=?"}
      UNION ALL
      SELECT v.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,'document',v.document_version_id,v.representation_sha256,v.source_asset_id,v.source_sha256,CASE WHEN d.document_version_id=v.document_version_id AND EXISTS(SELECT 1 FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.asset_id=v.source_asset_id AND p.role IN ('primary-pdf','supplementary-pdf')) THEN 1 ELSE 0 END
      FROM document_versions v JOIN literatures l USING(literature_id) JOIN literature_metadata m USING(literature_id) LEFT JOIN document_defaults d ON d.document_id=v.document_id WHERE ${visibleLiteratureSql("v.literature_id")} ${literature === undefined ? "" : "AND v.literature_id=?"}
      UNION ALL
      SELECT v.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256,'translation',v.document_version_id,t.sha256,v.source_asset_id,v.source_sha256,1
      FROM document_translations t JOIN document_versions v ON v.document_version_id=t.document_version_id AND v.literature_id=t.literature_id AND v.source_asset_id=t.asset_id
      JOIN literatures l ON l.literature_id=v.literature_id JOIN literature_metadata m ON m.literature_id=v.literature_id
      JOIN document_defaults d ON d.document_id=v.document_id AND d.document_version_id=v.document_version_id
      JOIN structure_annotation_current c ON c.document_version_id=v.document_version_id AND c.annotation_id=t.annotation_id
      WHERE t.target_language=? AND t.translated_count>0 AND EXISTS(SELECT 1 FROM literature_assets p WHERE p.literature_id=v.literature_id AND p.asset_id=v.source_asset_id AND p.role='primary-pdf') AND ${visibleLiteratureSql("v.literature_id")} ${literature === undefined ? "" : "AND v.literature_id=?"}
      ORDER BY literature_id,kind,document_version_id
    `,
      )
      .iterate(
        ...(literature === undefined
          ? [this.translationLanguage]
          : [literature, literature, this.translationLanguage, literature]),
      );
    for (const row of rows) yield Object.values(row) as unknown as SourceStamp;
  }
  private *indexedStamps(
    generation: string,
    literature?: string,
  ): Generator<SourceStamp> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT literature_id,meta_literature_id,metadata_revision,metadata_sha256,CASE WHEN translation_sha256 IS NULL THEN kind ELSE 'translation' END AS stamp_kind,document_version_id,COALESCE(translation_sha256,representation_sha256) AS stamp_sha256,source_asset_id,source_asset_sha256,is_default FROM retrieval_entries WHERE generation_id=? ${literature === undefined ? "" : "AND kind IN ('metadata','document') AND literature_id=?"} ORDER BY literature_id,stamp_kind,document_version_id`,
      )
      .iterate(generation, ...(literature === undefined ? [] : [literature]));
    for (const row of rows) yield Object.values(row) as unknown as SourceStamp;
  }
  /** Sources are metadata and document versions; a translation is not one. */
  private indexedSources(generation: string, literature: string): number {
    let n = 0;
    for (const stamp of this.indexedStamps(generation, literature))
      if (stamp[4] !== ("translation" as string)) n++;
    return n;
  }
  private *changedLiteratures(generation: RetrievalGeneration | null) {
    const current = groupStamps(this.sourceStamps()),
      indexed = groupStamps(
        generation ? this.indexedStamps(generation.generation_id) : [],
      );
    try {
      let source = current.next(),
        projected = indexed.next();
      while (!source.done && !projected.done) {
        if (source.value.id === projected.value.id) {
          if (source.value.fingerprint !== projected.value.fingerprint)
            yield source.value.id;
          source = current.next();
          projected = indexed.next();
        } else if (
          Buffer.compare(
            Buffer.from(source.value.id),
            Buffer.from(projected.value.id),
          ) < 0
        ) {
          yield source.value.id;
          source = current.next();
        } else {
          yield projected.value.id;
          projected = indexed.next();
        }
      }
      for (; !source.done; source = current.next()) yield source.value.id;
      for (; !projected.done; projected = indexed.next())
        yield projected.value.id;
    } finally {
      current.return(undefined);
      indexed.return(undefined);
    }
  }
  /** Explicit verification only. Normal refresh takes a journal snapshot. */
  scanChanges(): RetrievalChangeScan {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_change_scan");
    try {
      const generation = this.active();
      return {
        generation,
        revision: this.revision(),
        literature_ids: [...this.changedLiteratures(generation)].sort(),
      };
    } finally {
      if (this.db.isTransaction) this.db.exec("RELEASE retrieval_change_scan");
    }
  }
  private changePosition(): number | null {
    const position = this.db
      .prepare(
        "SELECT processed_position FROM retrieval_change_state WHERE singleton=1",
      )
      .get()?.processed_position;
    if (position === null) return null;
    if (
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position < 0
    )
      fail();
    return position;
  }
  private changeTail(): number {
    const tail = this.db
      .prepare(
        "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='retrieval_changes'),0) AS tail",
      )
      .get()?.tail;
    if (typeof tail !== "number" || !Number.isSafeInteger(tail) || tail < 0)
      fail();
    return tail;
  }
  changesSnapshot(): RetrievalChangeSnapshot {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_changes_snapshot");
    try {
      const position = this.changePosition();
      if (position === null)
        throw new RetrievalStorageError("index-reconcile-required");
      const tail = this.changeTail();
      if (position > tail) fail();
      return {
        generation: this.active(),
        revision: this.revision(),
        position,
        tail,
        pending: Number(
          this.db
            .prepare(
              "SELECT count(DISTINCT literature_id) AS n FROM retrieval_changes WHERE position>? AND position<=?",
            )
            .get(position, tail)!.n,
        ),
      };
    } finally {
      this.db.exec("RELEASE retrieval_changes_snapshot");
    }
  }
  changePage(after: number, tail: number, limit: number): RetrievalChange[] {
    this.refreshReader();
    const rows = this.db
      .prepare(
        `WITH page AS MATERIALIZED (
         SELECT position,literature_id FROM retrieval_changes WHERE position>? AND position<=? ORDER BY position LIMIT ?
       )
       SELECT min(position) AS position,literature_id,(SELECT max(position) FROM page) AS tail
       FROM page GROUP BY literature_id ORDER BY position`,
      )
      .all(after, tail, limit) as unknown as (RetrievalChange & {
      tail: number;
    })[];
    // A batch may commit before the end of this page. Until then, only cover
    // the first position of its last paper, leaving all unprocessed IDs ahead.
    return rows.map(({ position, literature_id, tail }, index) => ({
      position: index === rows.length - 1 ? tail : position,
      literature_id,
    }));
  }
  /** Keep the source and active generation in one snapshot during migration. */
  *migrationDifferences(): Generator<string> {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_migration_scan");
    try {
      if (this.changePosition() !== null) return;
      yield* this.changedLiteratures(this.active());
    } finally {
      this.db.exec("RELEASE retrieval_migration_scan");
    }
  }
  recordMigrationChanges(ids: readonly string[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.changePosition() !== null)
        throw new RetrievalStorageError("index-stale");
      const record = this.db.prepare(
        "INSERT INTO retrieval_changes(literature_id) VALUES(?)",
      );
      for (const id of ids) record.run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  completeMigration(): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.changePosition() === null;
      if (pending) {
        this.db.exec(
          "UPDATE retrieval_change_state SET processed_position=0 WHERE singleton=1",
        );
        // Reconciliation can discover a stale projection at an equal legacy
        // revision. Make the backlog visible to the regular scalar monitor.
        if (this.changeTail() > 0)
          this.db.exec(
            "UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1",
          );
      }
      this.db.exec("COMMIT");
      return pending;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  literatureSources(literature: string, generation?: string) {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_literature_sources");
    try {
      const fingerprint = stamps([...this.sourceStamps(literature)]);
      if (
        generation !== undefined &&
        fingerprint === stamps([...this.indexedStamps(generation, literature)])
      )
        return { fingerprint, metadata: null, documents: [], indexed: true };
      const metadata = this.metadataSource(literature);
      // SQLite LIMIT -1 includes every version of this literature in the snapshot.
      const documents = this.documentPage(null, -1, literature);
      return {
        fingerprint,
        metadata,
        documents,
        indexed: false,
      };
    } finally {
      if (this.db.isTransaction)
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
          "INSERT INTO retrieval_generations(generation_id,index_schema_version,unit_rule,source_revision,status,entry_count,fts_count,source_count,content_sha256,posting_sha256,created_at,text_rule,translation_language) VALUES(?,1,'markdown-context-v1',0,'ready',0,0,0,?,?,?,?,?)",
        )
        .run(
          id,
          RETRIEVAL_UNVERIFIED,
          RETRIEVAL_UNVERIFIED,
          new Date().toISOString(),
          RETRIEVAL_TEXT_RULE,
          this.translationLanguage,
        );
      this.db
        .prepare(
          "INSERT INTO retrieval_active_generation(singleton,generation_id) VALUES(1,?)",
        )
        .run(id);
      this.db.exec("COMMIT");
      return this.active()!;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
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
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  commitLiteratureUpdate(
    active: string,
    staged: string,
    literature: string,
    fingerprint: string,
    checkpoint: RetrievalCheckpoint,
  ): boolean {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.active();
      if (generation?.generation_id !== active)
        throw new RetrievalStorageError("index-stale");
      if (stamps([...this.sourceStamps(literature)]) !== fingerprint) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const oldSources = this.indexedSources(active, literature);
      const newSources = this.indexedSources(staged, literature);
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
      this.advanceChanges(generation, checkpoint);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Small, verified metadata updates fit in a single short catalog write. */
  commitLiteratureBatch(
    generation: string,
    updates: readonly RetrievalLiteratureUpdate[],
    checkpoint: RetrievalCheckpoint,
  ): boolean {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.active();
      if (active?.generation_id !== generation)
        throw new RetrievalStorageError("index-stale");
      for (const update of updates) {
        if (
          stamps([...this.sourceStamps(update.literature_id)]) !==
          update.fingerprint
        ) {
          this.db.exec("ROLLBACK");
          return false;
        }
      }
      const dropFts = this.db.prepare(
        "DELETE FROM retrieval_fts WHERE rowid IN (SELECT entry_id FROM retrieval_entries WHERE generation_id=? AND kind IN ('metadata','document') AND literature_id=?)",
      );
      const drop = this.db.prepare(
        "DELETE FROM retrieval_entries WHERE generation_id=? AND kind IN ('metadata','document') AND literature_id=?",
      );
      const insert = this.entryWriter();
      let entryDelta = 0,
        sourceDelta = 0,
        changed = false;
      for (const { literature_id, entries } of updates) {
        if (entries === null) continue;
        if (
          entries.some(
            (entry) =>
              entry.kind !== "metadata" ||
              entry.literature_id !== literature_id,
          )
        )
          fail();
        changed = true;
        sourceDelta +=
          Number(entries.length > 0) -
          this.indexedSources(generation, literature_id);
        dropFts.run(generation, literature_id);
        entryDelta +=
          entries.length - Number(drop.run(generation, literature_id).changes);
        for (const entry of entries) insert(generation, entry);
      }
      if (changed)
        this.db
          .prepare(
            "UPDATE retrieval_generations SET entry_count=entry_count+?,fts_count=fts_count+?,source_count=source_count+?,content_sha256=?,posting_sha256=? WHERE generation_id=?",
          )
          .run(
            entryDelta,
            entryDelta,
            sourceDelta,
            RETRIEVAL_UNVERIFIED,
            createHash("sha256")
              .update(`retrieval-mutation-v1:${randomUUID()}`)
              .digest("hex"),
            generation,
          );
      this.advanceChanges(active, checkpoint);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private advanceChanges(
    active: RetrievalGeneration,
    checkpoint: RetrievalCheckpoint,
  ): RetrievalGeneration {
    const { previous, position, revision } = checkpoint;
    if (
      previous !== this.changePosition() ||
      !Number.isSafeInteger(position) ||
      position < previous ||
      position > this.changeTail()
    )
      throw new RetrievalStorageError("index-stale");
    this.db
      .prepare(
        "UPDATE retrieval_change_state SET processed_position=? WHERE singleton=1",
      )
      .run(position);
    if (revision === null) return active;
    if (
      !Number.isSafeInteger(revision) ||
      revision < active.source_revision ||
      revision > this.revision()
    )
      throw new RetrievalStorageError("index-stale");
    // Only the captured prefix is covered. Later commits remain in the journal.
    this.db
      .prepare(
        "UPDATE retrieval_generations SET source_revision=? WHERE generation_id=?",
      )
      .run(revision, active.generation_id);
    return { ...active, source_revision: revision };
  }
  finishIncremental(
    generation: string,
    checkpoint: RetrievalCheckpoint,
  ): RetrievalGeneration {
    this.refreshReader();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.active();
      if (active?.generation_id !== generation)
        throw new RetrievalStorageError("index-stale");
      const result = this.advanceChanges(active, checkpoint);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  pruneChangeBatch(): boolean {
    this.refreshReader();
    const limit = 2048;
    const position = this.changePosition();
    if (position === null) return true;
    return (
      Number(
        this.db
          .prepare(
            "DELETE FROM retrieval_changes WHERE position IN (SELECT position FROM retrieval_changes WHERE position<=? ORDER BY position LIMIT ?)",
          )
          .run(position, limit).changes,
      ) < limit
    );
  }
  verificationEntries(generation: string, id: string): RetrievalEntry[] {
    this.refreshReader();
    return this.db
      .prepare(
        "SELECT e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body,e.translation_language,e.translation_sha256 FROM retrieval_entries e LEFT JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=? AND e.kind IN ('metadata','document') AND e.literature_id=? ORDER BY e.kind,e.document_version_id,e.unit_ordinal,e.entry_id",
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
    } catch (error) {
      if (sqliteStorageFull(error)) throw error;
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
          "INSERT INTO retrieval_generations(generation_id,index_schema_version,unit_rule,source_revision,status,entry_count,fts_count,source_count,created_at,text_rule,translation_language) VALUES(?,1,'markdown-context-v1',?,'building',0,0,0,?,?,?)",
        )
        .run(
          id,
          sourceRevision,
          new Date().toISOString(),
          RETRIEVAL_TEXT_RULE,
          this.translationLanguage,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      if (transaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      repairText?.close();
      throw error;
    }
    this.repairText?.close();
    this.repairText = repairText;
    this.repairGeneration = repairing ? id : null;
    return id;
  }
  private entryWriter() {
    const insert = this.db.prepare(
      "INSERT INTO retrieval_entries(generation_id,kind,literature_id,meta_literature_id,metadata_revision,metadata_sha256,document_version_id,representation_sha256,source_asset_id,source_asset_sha256,unit_start_utf8,unit_end_utf8,unit_sha256,section_id,unit_ordinal,is_default,translation_language,translation_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const fts = this.db.prepare(
      "INSERT INTO retrieval_fts(rowid,title,body) VALUES(?,?,?)",
    );
    return (generationId: string, e: RetrievalEntry, target = fts) => {
      const { lastInsertRowid } = insert.run(
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
        e.translation_language ?? null,
        e.translation_sha256 ?? null,
      );
      target.run(lastInsertRowid, e.title, e.body);
      return lastInsertRowid;
    };
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
      const insert = this.entryWriter();
      const repairText = repair
        ? repair.prepare(
            "INSERT INTO temp.retrieval_repair_text(entry_id,title,body) VALUES(?,?,?)",
          )
        : null;
      for (const e of entries) {
        const id = insert(generationId, e, repairText ?? undefined);
        if (repairText) stagedIds.push(id);
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
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (repairTransaction) {
        if (repair!.isTransaction) repair!.exec("ROLLBACK");
      } else if (repair) {
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
      // The rebuild's unchanged-source CAS covers all changes in this snapshot,
      // including a migrated catalog whose journal was not yet reconciled.
      this.db
        .prepare(
          "UPDATE retrieval_change_state SET processed_position=? WHERE singleton=1",
        )
        .run(this.changeTail());
      if (repairing) inspectCatalogWithRetrieval(this.db, this.config);
      this.db.exec("COMMIT");
      published = {
        generation_id: row.generation_id,
        source_revision: row.source_revision,
        entry_count: row.entry_count,
        source_count: row.source_count,
      };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
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
      const rule = generation
        ? (this.db
            .prepare(
              "SELECT text_rule,translation_language FROM retrieval_generations WHERE generation_id=?",
            )
            .get(generation.generation_id) as
            | { text_rule: string | null; translation_language: string | null }
            | undefined)
        : undefined;
      const rule_current =
        !!rule &&
        rule.text_rule === RETRIEVAL_TEXT_RULE &&
        rule.translation_language === this.translationLanguage;
      return { generation, source_revision, state_token, rule_current };
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
    readonly relevanceLimited: boolean;
  } {
    this.refreshReader();
    this.db.exec("SAVEPOINT retrieval_search");
    try {
      if (this.active()?.generation_id !== generationId)
        throw new RetrievalStorageError("index-stale");
      const scopeJson = JSON.stringify(scope);
      const kindsJson = JSON.stringify(kinds);
      const versionsJson = JSON.stringify(explicitVersions ?? []);
      // entry_id is exactly FTS rowid. For library-wide searches, stream that
      // order from MATCH and stop at the existing candidate boundary.
      const join = scope.length === 0 ? "CROSS JOIN" : "JOIN";
      const rows = this.db
        .prepare(
          `SELECT e.entry_id,e.generation_id,e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,e.translation_language,e.translation_sha256,retrieval_fts.title,retrieval_fts.body,(SELECT asset_id FROM literature_assets p WHERE p.literature_id=e.literature_id AND p.role='primary-pdf') AS primary_asset_id FROM retrieval_fts ${join} retrieval_entries e ON e.entry_id=retrieval_fts.rowid WHERE retrieval_fts MATCH ? AND ${visibleLiteratureSql("e.literature_id")} AND e.generation_id=? AND e.kind IN (SELECT value FROM json_each(?)) AND (json_array_length(?)=0 OR e.literature_id IN (SELECT value FROM json_each(?))) AND (e.kind='metadata' OR (?=0 AND e.is_default=1) OR (?=1 AND e.document_version_id IN (SELECT value FROM json_each(?)))) ORDER BY retrieval_fts.rowid LIMIT 4098`,
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
        // The original and the translation of one unit are one hit, shown
        // as the original (spec 9.7), ranked by the better of the two.
        const translated = (h: RetrievalHit) => !!h.translation_sha256;
        if (previous && translated(previous) !== translated(hit)) {
          const original = translated(hit) ? previous : hit;
          groups.set(key, {
            ...original,
            score: Math.min(previous.score, hit.score),
          });
        } else if (
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
        hits: ordered
          .slice(0, RELEVANCE_RESULT_LIMIT)
          .filter(follows)
          .slice(0, limit),
        candidateLimit: rows.length > 4097,
        relevanceLimited: ordered.length > RELEVANCE_RESULT_LIMIT,
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
