const {
  beginCatalogWrite,
  commitCatalogWrite,
}: typeof import("./catalog-write.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./catalog-write.ts"
      : "./catalog-write.js",
    import.meta.url,
  ).href
);
import {
  ContractTextValidation,
  globalLibraryCountScope,
  LIBRARY_SORT_SCOPE_LIMIT,
} from "@sciretriever/contracts";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type {
  IdleWalCheckpointResult,
  SqliteCommand,
  WalCheckpointFrames,
} from "./worker.js";
import type { RetrievalStorageEngine } from "./retrieval-engine.js";
/** Dynamic values are confined to SQLite rows and JSON columns at this adapter boundary. */
type Dynamic = ReturnType<typeof JSON.parse>;
interface WorkerRuntimeData {
  readonly path: string;
  readonly read_only: boolean;
  readonly immutable_read_only: boolean;
  readonly long_read_lane: boolean;
  readonly task_detail_cache_directory: string | null;
  readonly max_tags: number;
  readonly archive_profile: "pipeline" | "vlm-engine";
  readonly schema_version: number;
  readonly schema_manifest: readonly string[];
  readonly schema_fingerprint: string;
  readonly execution_schema: readonly string[];
  readonly execution_schema_version: number;
  readonly execution_schema_fingerprint: string;
  readonly execution_runtime_schema: readonly string[];
  readonly execution_runtime_schema_version: number;
  readonly execution_runtime_schema_fingerprint: string;
}
interface WorkerMessage {
  readonly id: number;
  readonly command: SqliteCommand;
  readonly cancellation?: SharedArrayBuffer;
}
const data = workerData as WorkerRuntimeData;
const libraryStateModule: typeof import("./library-state.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./library-state.ts"
      : "./library-state.js",
    import.meta.url,
  ).href
);
let libraryState: import("./library-state.js").StoredLibraryState;
const draftFactsModule = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./draft-facts.ts" : "./draft-facts.js",
    import.meta.url,
  ).href
);
let cancellation: Int32Array | undefined;
function queryCheckpoint() {
  if (cancellation && Atomics.load(cancellation, 0))
    throw new Error("library-query-cancelled");
}

const layoutModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./catalog-layout.ts"
      : "./catalog-layout.js",
    import.meta.url,
  ).href
);
const deviceModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./device-connection-engine.ts"
      : "./device-connection-engine.js",
    import.meta.url,
  ).href
);
const withdrawalModule: typeof import("./intake-withdrawal-engine.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-withdrawal-engine.ts"
        : "./intake-withdrawal-engine.js",
      import.meta.url,
    ).href
  );
const visibilityModule: typeof import("./intake-visibility.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-visibility.ts"
      : "./intake-visibility.js",
    import.meta.url,
  ).href
);
const intakeObjectsModule: typeof import("./intake-objects.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-objects.ts"
      : "./intake-objects.js",
    import.meta.url,
  ).href
);
const importModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./import-engine.ts"
      : "./import-engine.js",
    import.meta.url,
  ).href
);
const captureModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./capture-engine.ts"
      : "./capture-engine.js",
    import.meta.url,
  ).href
);
const bibliographyModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./literature-bibliographies.ts"
      : "./literature-bibliographies.js",
    import.meta.url,
  ).href
);
const folderModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./folder-engine.ts"
      : "./folder-engine.js",
    import.meta.url,
  ).href
);
const libraryTrashModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./library-trash-engine.ts"
      : "./library-trash-engine.js",
    import.meta.url,
  ).href
);
const filterModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./filter-engine.ts"
      : "./filter-engine.js",
    import.meta.url,
  ).href
);
const marksModule = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./marks-engine.ts" : "./marks-engine.js",
    import.meta.url,
  ).href
);
const snapshotModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./snapshot-engine.ts"
      : "./snapshot-engine.js",
    import.meta.url,
  ).href
);
const archiveModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./archive-engine.ts"
      : "./archive-engine.js",
    import.meta.url,
  ).href
);
const tagModule = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./tag-engine.ts" : "./tag-engine.js",
    import.meta.url,
  ).href
);
const archiveReferenceModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./archive-reference-engine.ts"
      : "./archive-reference-engine.js",
    import.meta.url,
  ).href
);
const metadataFieldsModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./metadata-field-storage.ts"
      : "./metadata-field-storage.js",
    import.meta.url,
  ).href
);
const annotationModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./structure-annotation-engine.ts"
      : "./structure-annotation-engine.js",
    import.meta.url,
  ).href
);
const reviewModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./review-engine.ts"
      : "./review-engine.js",
    import.meta.url,
  ).href
);
const {
  TaskDetailCache,
  replayTaskDetail,
  taskDetailCatalogIdentity,
}: typeof import("./task-detail-engine.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./task-detail-engine.ts"
      : "./task-detail-engine.js",
    import.meta.url,
  ).href
);
const taskDetails = new TaskDetailCache(
  data.task_detail_cache_directory
    ? { directory: data.task_detail_cache_directory, catalog: data.path }
    : undefined,
);
const proofreadModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./proofread-engine.ts"
      : "./proofread-engine.js",
    import.meta.url,
  ).href
);
const rawParseModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./raw-parsing-engine.ts"
      : "./raw-parsing-engine.js",
    import.meta.url,
  ).href
);
const draftTextModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./draft-text-engine.ts"
      : "./draft-text-engine.js",
    import.meta.url,
  ).href
);
const documentDefaultsModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./document-defaults.ts"
      : "./document-defaults.js",
    import.meta.url,
  ).href
);
const processorModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./processor-engine.ts"
      : "./processor-engine.js",
    import.meta.url,
  ).href
);
const libraryPageModule = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./library-page.ts" : "./library-page.js",
    import.meta.url,
  ).href
);
const libraryRankings = new libraryPageModule.LibraryRelevanceCache();
const pagingSuffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const { libraryPagingReady }: typeof import("./library-paging-state.js") =
  await import(
    new URL("./library-paging-state" + pagingSuffix, import.meta.url).href
  );
const {
  invalidTopicCause,
  invalidCitationCause,
  invalidDiscoveryResult,
}: typeof import("./library-paging-schema.js") = await import(
  new URL("./library-paging-schema" + pagingSuffix, import.meta.url).href
);
const intakeModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-engine.ts"
      : "./intake-engine.js",
    import.meta.url,
  ).href
);
const queryTextModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../literature/unicode-casefold.ts"
      : "../../literature/unicode-casefold.js",
    import.meta.url,
  ).href
);
const port = parentPort;
if (!port) throw new Error("sqlite worker parent port is unavailable");
const SCHEMA_MANIFEST = data.schema_manifest;
const SCHEMA_VERSION = data.schema_version;
const SCHEMA_FINGERPRINT = data.schema_fingerprint;
const EXECUTION_SCHEMA_VERSION = data.execution_schema_version;
const EXECUTION_SCHEMA_FINGERPRINT = data.execution_schema_fingerprint;
const EXECUTION_RUNTIME_SCHEMA_VERSION = data.execution_runtime_schema_version;
const EXECUTION_RUNTIME_SCHEMA_FINGERPRINT =
  data.execution_runtime_schema_fingerprint;
const retrievalModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./retrieval-engine.ts"
      : "./retrieval-engine.js",
    import.meta.url,
  ).href
);
const extractionModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./extraction-engine.ts"
      : "./extraction-engine.js",
    import.meta.url,
  ).href
);
const {
  readCatalogIdentity,
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
const literatureSearchRows = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./literature-search-rows.ts"
      : "./literature-search-rows.js",
    import.meta.url,
  ).href
);
const {
  catalogCorruption,
  sqliteStorageFull,
  throwCatalogCorruption,
  DocumentCommitError,
  isDocumentCommitFailureCode,
} = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./errors.ts" : "./errors.js",
    import.meta.url,
  ).href
);
let retrievalEngine: RetrievalStorageEngine | undefined;
function getRetrievalEngine(): RetrievalStorageEngine {
  return (retrievalEngine ??= new retrievalModule.RetrievalStorageEngine(
    data.path,
    data.read_only,
    layoutModule.CURRENT_CATALOG_CONFIG,
  ));
}
let db: Dynamic;
const metadataStatements = new Map<string, StatementSync>();
const METADATA_STATEMENT_LIMIT = 256;
let metadataWrite:
  | {
      readonly prepare: (sql: string) => Dynamic;
      readonly nextSequence: Map<string, number>;
      readonly textValidation: ContractTextValidation;
      readonly textNormalization: InstanceType<
        typeof queryTextModule.MetadataTextNormalization
      >;
      citationRun?: { readonly id: string; finished: boolean };
    }
  | undefined;
let observedDataVersion: number | null = null;
let openedCatalogIdentity: string | null = null;
const CATALOG_BUSY_TIMEOUT_SQL = "PRAGMA busy_timeout=5000";
function catalogIdentity(): string {
  if (data.path === ":memory:") return "memory";
  const stat = statSync(data.path);
  return `${stat.dev}:${stat.ino}`;
}
function taskCatalogIdentity(inode: string): string {
  return taskDetailCatalogIdentity(
    db,
    inode,
    EXECUTION_SCHEMA_VERSION,
    EXECUTION_RUNTIME_SCHEMA_VERSION,
  );
}
let queryPreflight: {
  readonly status: "ready" | "not-initialized" | "unavailable";
  readonly schema: Dynamic | null;
} | null = null;
const EXHAUSTION_COMMAND_KEYS = "kind,literatureId";
const EXHAUSTION_LITERATURE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(): never {
  throw new Error("sqlite worker operation failed");
}
let verifiedDocumentSchema: string | null = null;
function documentSchemaProof(version: number): string {
  return JSON.stringify([
    version,
    db.prepare("PRAGMA schema_version").get().schema_version,
    catalogIdentity(),
  ]);
}
function validDocumentSchema(version: number): boolean {
  const identity = documentSchemaProof(version);
  if (verifiedDocumentSchema === identity) return true;
  verifiedDocumentSchema = null;
  try {
    if (
      version !== SCHEMA_VERSION ||
      !readCatalogIdentity(
        db,
        layoutModule.CURRENT_CATALOG_CONFIG,
        data.read_only,
      )
    )
      return false;
    verifiedDocumentSchema = identity;
    return true;
  } catch (error) {
    throwCatalogCorruption(error);
    if (
      error instanceof CatalogLayoutError &&
      error.reason === "catalog-addition-required"
    )
      throw error;
    return false;
  }
}
function initialize(): Dynamic {
  try {
    return initializeConnection();
  } catch (error) {
    try {
      db?.close();
    } finally {
      db = undefined;
      queryPreflight = null;
    }
    throw error;
  }
}
function initializeConnection(): Dynamic {
  // Reconnecting after another connection's commit keeps the proof; the
  // identity below still changes on DDL or a different catalog file.
  metadataStatements.clear();
  const location = data.immutable_read_only
    ? pathToFileURL(data.path)
    : data.path;
  if (location instanceof URL) location.searchParams.set("immutable", "1");
  db = data.read_only
    ? new DatabaseSync(location, { readOnly: true })
    : new DatabaseSync(data.path);
  openedCatalogIdentity = catalogIdentity();
  db.function("sr_normalize", { deterministic: true }, (value: Dynamic) =>
    value === null ? null : queryTextModule.normalizeQueryText(value),
  );
  db.function("sr_query_continue", () => {
    queryCheckpoint();
    return 1;
  });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(CATALOG_BUSY_TIMEOUT_SQL);
  libraryState = new libraryStateModule.StoredLibraryState(
    db,
    data,
    queryCheckpoint,
  );
  if (data.read_only) {
    db.exec("PRAGMA query_only = ON");
    queryPreflight = inspectQueryCatalog();
    observedDataVersion = Number(
      db.prepare("PRAGMA data_version").get().data_version,
    );
    return;
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
  db.exec("PRAGMA synchronous = FULL");
  const existingTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_identity'",
    )
    .get();
  const existing = existingTable
    ? db
        .prepare(
          "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
        )
        .get()
    : undefined;
  if (!existing) {
    layoutModule.initializeCurrentCatalog(db);
  } else if (
    existing.product !== "sciretriever" ||
    !(
      existing.schema_version === SCHEMA_VERSION &&
      existing.schema_fingerprint === SCHEMA_FINGERPRINT
    )
  )
    fail();
  if (existing?.schema_version === SCHEMA_VERSION) {
    if (verifiedDocumentSchema === documentSchemaProof(existing.schema_version))
      checkCatalogIdentityRows(db, layoutModule.CURRENT_CATALOG_CONFIG);
    else if (!validDocumentSchema(existing.schema_version)) fail();
  }
  libraryState.registerWrites();
  observedDataVersion = Number(
    db.prepare("PRAGMA data_version").get().data_version,
  );
}
function inspectQueryCatalog(): {
  readonly status: "ready" | "not-initialized" | "unavailable";
  readonly schema: Dynamic | null;
} {
  try {
    const proof = documentSchemaProof(SCHEMA_VERSION);
    const identity =
      verifiedDocumentSchema === proof
        ? checkCatalogIdentityRows(db, layoutModule.CURRENT_CATALOG_CONFIG)
        : readCatalogIdentity(db, layoutModule.CURRENT_CATALOG_CONFIG, true);
    if (!identity) return { status: "not-initialized", schema: null };
    verifiedDocumentSchema = proof;
    return { status: "ready", schema: identity };
  } catch (error) {
    verifiedDocumentSchema = null;
    throwCatalogCorruption(error);
    if (
      error instanceof CatalogLayoutError &&
      error.reason === "catalog-addition-required"
    )
      throw error;
    return { status: "unavailable", schema: null };
  }
}
function putLiterature(
  l: Dynamic,
  metadataSha256: Dynamic,
  fallbackIdentitySha256: Dynamic,
): Dynamic {
  try {
    beginCatalogWrite(db);
    db.prepare(
      "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?) ON CONFLICT(meta_literature_id) DO NOTHING",
    ).run(l.meta_literature_id, l.literature_id);
    db.prepare(
      "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?) ON CONFLICT(literature_id) DO UPDATE SET meta_literature_id=excluded.meta_literature_id,version_role=excluded.version_role",
    ).run(l.literature_id, l.meta_literature_id, l.version_role);
    writeMetadata(l.literature_id, l.metadata, metadataSha256);
    replaceFallbackIndex(l.literature_id, fallbackIdentitySha256);
    commitCatalogWrite(db);
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure when rollback also fails.
    }
    throw e;
  }
  return true;
}
function replaceFallbackIndex(literatureId: Dynamic, digest: Dynamic): Dynamic {
  db.prepare(
    "DELETE FROM literature_fallback_identity_indexes WHERE literature_id=?",
  ).run(literatureId);
  if (digest !== null)
    db.prepare(
      "INSERT INTO literature_fallback_identity_indexes(literature_id,fallback_identity_sha256) VALUES(?,?)",
    ).run(literatureId, digest);
}
function writeMetadata(
  literatureId: Dynamic,
  m: Dynamic,
  metadataSha256: Dynamic,
): Dynamic {
  const current = db
    .prepare(
      "SELECT metadata_revision FROM literature_metadata WHERE literature_id=?",
    )
    .get(literatureId);
  writeMetadataAtRevision(
    literatureId,
    m,
    current ? current.metadata_revision + 1 : 1,
    metadataSha256,
  );
}
function writeMetadataAtRevision(
  literatureId: Dynamic,
  m: Dynamic,
  revision: Dynamic,
  metadataSha256: Dynamic,
): Dynamic {
  db.prepare(
    "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id) DO UPDATE SET metadata_revision=excluded.metadata_revision,metadata_sha256=excluded.metadata_sha256,title=excluded.title,abstract=excluded.abstract,publication_date=excluded.publication_date,publication_year=excluded.publication_year,publication_form=excluded.publication_form,article_kind=excluded.article_kind,language=excluded.language,venue=excluded.venue,publisher=excluded.publisher,volume=excluded.volume,issue=excluded.issue,pages=excluded.pages",
  ).run(
    literatureId,
    revision,
    metadataSha256,
    m.title,
    m.abstract,
    m.publication_date,
    m.publication_year,
    m.publication_form,
    m.article_kind,
    m.language,
    m.venue,
    m.publisher,
    m.volume,
    m.issue,
    m.pages,
  );
  db.prepare(
    "DELETE FROM literature_metadata_authors WHERE literature_id=?",
  ).run(literatureId);
  db.prepare(
    "DELETE FROM literature_metadata_identifiers WHERE literature_id=?",
  ).run(literatureId);
  db.prepare(
    "DELETE FROM literature_metadata_keywords WHERE literature_id=?",
  ).run(literatureId);
  const author = db.prepare(
    "INSERT INTO literature_metadata_authors(literature_id,ordinal,kind,display_name,given_name,family_name,orcid) VALUES(?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < m.authors.length; i++) {
    const a = m.authors[i];
    author.run(
      literatureId,
      i,
      a.kind,
      a.display_name,
      a.given_name,
      a.family_name,
      a.orcid,
    );
    for (let j = 0; j < a.affiliations.length; j++) {
      const f = a.affiliations[j];
      db.prepare(
        "INSERT INTO literature_metadata_author_affiliations(literature_id,author_ordinal,affiliation_ordinal,name,ror) VALUES(?,?,?,?,?)",
      ).run(literatureId, i, j, f.name, f.ror);
    }
  }
  const identifier = db.prepare(
    "INSERT INTO literature_metadata_identifiers(literature_id,ordinal,namespace,value) VALUES(?,?,?,?)",
  );
  for (let i = 0; i < m.identifiers.length; i++) {
    const x = m.identifiers[i];
    identifier.run(literatureId, i, x.namespace, x.value);
  }
  db.prepare(
    "DELETE FROM literature_metadata_subject_terms WHERE literature_id=?",
  ).run(literatureId);
  const subject = db.prepare(
    "INSERT INTO literature_metadata_subject_terms(literature_id,ordinal,term,normalized_term) VALUES(?,?,?,?)",
  );
  for (const [i, term] of (m.subject_terms ?? []).entries())
    subject.run(
      literatureId,
      i,
      term,
      queryTextModule.normalizeQueryText(term),
    );
  const keyword = db.prepare(
    "INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) VALUES(?,?,?)",
  );
  for (let i = 0; i < m.keywords.length; i++)
    keyword.run(literatureId, i, m.keywords[i]);
  indexMetadata(literatureId, m);
}
function indexMetadata(literatureId: Dynamic, m: Dynamic): Dynamic {
  // Deleted papers keep their search rows; reads exclude them.
  if (visibilityModule.intakeWithdrawnLiterature(db, literatureId)) return;
  const rowIds = literatureSearchRows.literatureSearchRowIds(db, literatureId);
  const first = rowIds[0];
  const contentBody =
    first === undefined
      ? ""
      : db
          .prepare(
            "SELECT content_body FROM literature_search_fts WHERE rowid=?",
          )
          .get(first)?.content_body || "";
  literatureSearchRows.deleteLiteratureSearchRows(db, rowIds);
  const index = (value: string): string =>
    queryTextModule.ftsIndexText(value || "");
  db.prepare(literatureSearchRows.INSERT_LITERATURE_SEARCH_ROW).run(
    literatureId,
    index(m.title),
    index(m.abstract),
    index(
      m.authors
        .flatMap((a: Dynamic) => [
          a.display_name,
          a.given_name,
          a.family_name,
          a.orcid,
        ])
        .filter(Boolean)
        .join(" "),
    ),
    index(
      m.authors
        .flatMap((a: Dynamic) =>
          a.affiliations.flatMap((f: Dynamic) => [f.name, f.ror]),
        )
        .filter(Boolean)
        .join(" "),
    ),
    index(
      m.identifiers.flatMap((x: Dynamic) => [x.namespace, x.value]).join(" "),
    ),
    index([...m.keywords, ...(m.subject_terms ?? [])].join(" ")),
    index(m.venue),
    index(m.publisher),
    index(m.volume),
    index(m.issue),
    index(m.pages),
    contentBody,
  );
}
function getLiterature(id: Dynamic, includeWithdrawn = false): Dynamic {
  if (!includeWithdrawn && visibilityModule.literatureWithdrawn(db, id))
    return null;
  const l = db
    .prepare(
      "SELECT literature_id,meta_literature_id,version_role FROM literatures WHERE literature_id=?",
    )
    .get(id);
  if (!l) return null;
  const m = db
    .prepare(
      "SELECT title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages FROM literature_metadata WHERE literature_id=?",
    )
    .get(id);
  if (!m) fail();
  const authors = db
    .prepare(
      "SELECT ordinal,kind,display_name,given_name,family_name,orcid FROM literature_metadata_authors WHERE literature_id=? ORDER BY ordinal",
    )
    .all(id)
    .map(({ ordinal, ...a }: Dynamic) => ({
      ...a,
      affiliations: db
        .prepare(
          "SELECT name,ror FROM literature_metadata_author_affiliations WHERE literature_id=? AND author_ordinal=? ORDER BY affiliation_ordinal",
        )
        .all(id, ordinal),
    }));
  const identifiers = db
    .prepare(
      "SELECT namespace,value FROM literature_metadata_identifiers WHERE literature_id=? ORDER BY ordinal",
    )
    .all(id);
  const keywords = db
    .prepare(
      "SELECT keyword FROM literature_metadata_keywords WHERE literature_id=? ORDER BY ordinal",
    )
    .all(id)
    .map((x: Dynamic) => x.keyword);
  const status = libraryState.get(id)?.status;
  if (!status) fail();
  return {
    literature_id: l.literature_id,
    meta_literature_id: l.meta_literature_id,
    version_role: l.version_role,
    status,
    metadata: {
      ...m,
      authors,
      identifiers,
      keywords,
      subject_terms: db
        .prepare(
          "SELECT term FROM literature_metadata_subject_terms WHERE literature_id=? ORDER BY ordinal",
        )
        .all(id)
        .map((r: Dynamic) => r.term),
    },
  };
}
function getLiteratures(ids: Dynamic): Dynamic {
  if (!Array.isArray(ids) || ids.length > 10000) return fail();
  if (ids.length === 0) return [];
  const json = JSON.stringify(ids);
  const roots = db
    .prepare(
      `SELECT l.literature_id,l.meta_literature_id,l.version_role,m.title,m.abstract,m.publication_date,m.publication_year,m.publication_form,m.article_kind,m.language,m.venue,m.publisher,m.volume,m.issue,m.pages FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE ${visibilityModule.visibleLiteratureSql("l.literature_id")} AND l.literature_id IN (SELECT value FROM json_each(?)) ORDER BY l.literature_id`,
    )
    .all(json);
  const authors = db
    .prepare(
      "SELECT a.literature_id,a.ordinal,a.kind,a.display_name,a.given_name,a.family_name,a.orcid FROM literature_metadata_authors a WHERE a.literature_id IN (SELECT value FROM json_each(?)) ORDER BY a.literature_id,a.ordinal",
    )
    .all(json);
  const affiliations = db
    .prepare(
      "SELECT a.literature_id,a.author_ordinal,a.affiliation_ordinal,a.name,a.ror FROM literature_metadata_author_affiliations a WHERE a.literature_id IN (SELECT value FROM json_each(?)) ORDER BY a.literature_id,a.author_ordinal,a.affiliation_ordinal",
    )
    .all(json);
  const identifiers = db
    .prepare(
      "SELECT i.literature_id,i.ordinal,i.namespace,i.value FROM literature_metadata_identifiers i WHERE i.literature_id IN (SELECT value FROM json_each(?)) ORDER BY i.literature_id,i.ordinal",
    )
    .all(json);
  const keywords = db
    .prepare(
      "SELECT k.literature_id,k.ordinal,k.keyword FROM literature_metadata_keywords k WHERE k.literature_id IN (SELECT value FROM json_each(?)) ORDER BY k.literature_id,k.ordinal",
    )
    .all(json);
  const authorMap = new Map<Dynamic, Dynamic>();
  for (const author of authors) {
    const values = authorMap.get(author.literature_id) ?? [];
    values.push({ ...author, affiliations: [] });
    authorMap.set(author.literature_id, values);
  }
  for (const affiliation of affiliations) {
    const author = authorMap
      .get(affiliation.literature_id)
      ?.find((value: Dynamic) => value.ordinal === affiliation.author_ordinal);
    if (!author) fail();
    author.affiliations.push({ name: affiliation.name, ror: affiliation.ror });
  }
  const grouped = (
    rows: Dynamic,
    key: string,
    project: (row: Dynamic) => Dynamic,
  ) => {
    const values = new Map<Dynamic, Dynamic>();
    for (const row of rows) {
      const items = values.get(row.literature_id) ?? [];
      items.push(project(row));
      values.set(row.literature_id, items);
    }
    void key;
    return values;
  };
  const identifierMap = grouped(identifiers, "ordinal", (row: Dynamic) => ({
    namespace: row.namespace,
    value: row.value,
  }));
  const subjectMap = new Map<string, string[]>();
  for (const r of db
    .prepare(
      "SELECT literature_id,term FROM literature_metadata_subject_terms WHERE literature_id IN (SELECT value FROM json_each(?)) ORDER BY literature_id,ordinal",
    )
    .all(json)) {
    const id = String(r.literature_id);
    if (!subjectMap.has(id)) subjectMap.set(id, []);
    subjectMap.get(id)!.push(String(r.term));
  }
  const keywordMap = grouped(
    keywords,
    "ordinal",
    (row: Dynamic) => row.keyword,
  );
  return roots.map((row: Dynamic) => {
    const { literature_id, meta_literature_id, version_role, ...metadata } =
      row;
    const nestedAuthors = (authorMap.get(literature_id) ?? []).map(
      (author: Dynamic) => ({
        kind: author.kind,
        display_name: author.display_name,
        given_name: author.given_name,
        family_name: author.family_name,
        orcid: author.orcid,
        affiliations: author.affiliations,
      }),
    );
    const state = libraryState.get(literature_id);
    if (!state) fail();
    return {
      literature_id,
      meta_literature_id,
      version_role,
      status: state.status,
      metadata: {
        ...metadata,
        authors: nestedAuthors,
        identifiers: identifierMap.get(literature_id) ?? [],
        keywords: keywordMap.get(literature_id) ?? [],
        subject_terms: subjectMap.get(literature_id) ?? [],
      },
      __state: state,
    };
  });
}
function getLiteratureIds(id: string, includeWithdrawn = false): Dynamic {
  if (!includeWithdrawn && visibilityModule.literatureWithdrawn(db, id))
    return null;
  const row = db
    .prepare(
      "SELECT l.literature_id,l.meta_literature_id,m.literature_id AS has_metadata FROM literatures l LEFT JOIN literature_metadata m USING(literature_id) WHERE l.literature_id=?",
    )
    .get(id);
  if (!row) return null;
  if (!row.has_metadata) fail();
  return {
    literature_id: row.literature_id,
    meta_literature_id: row.meta_literature_id,
  };
}
function findLiteratureByIdentifiers(
  identifiers: Dynamic,
  idsOnly: boolean,
): Dynamic {
  if (!Array.isArray(identifiers) || identifiers.length > 128) fail();
  const ids = new Set<Dynamic>();
  const query = db.prepare(
    "SELECT literature_id FROM literature_metadata_identifiers WHERE namespace=? AND value=? ORDER BY literature_id",
  );
  for (const identifier of identifiers) {
    if (
      !identifier ||
      typeof identifier.namespace !== "string" ||
      typeof identifier.value !== "string"
    )
      fail();
    for (const row of query.all(identifier.namespace, identifier.value))
      ids.add(row.literature_id);
  }
  return [...ids]
    .sort()
    .map((id) =>
      idsOnly ? getLiteratureIds(id, true) : getLiterature(id, true),
    );
}
function libraryTagBadges(ids: readonly string[]): Map<string, Dynamic[]> {
  const result = new Map<string, Dynamic[]>();
  for (const row of db
    .prepare(
      // Origin and evidence count come from the same page's assignment rows
      // (primary-key lookups), never from per-literature history reads.
      `SELECT i.literature_id,i.rank,i.locked,t.tag_id,t.row_json,
        json_extract(j.value,'$.origin') AS origin,
        (SELECT coalesce(sum(json_array_length(e.value,'$.segment_ids')),0) FROM json_each(j.value,'$.evidence') e) AS evidence_count
      FROM literature_tag_items i JOIN tags t ON t.tag_id=i.tag_id
      LEFT JOIN literature_tag_assignments a ON a.literature_id=i.literature_id
      LEFT JOIN json_each(a.row_json,'$.items') j ON json_extract(j.value,'$.tag_id')=i.tag_id
      WHERE i.literature_id IN (SELECT value FROM json_each(?)) ORDER BY i.literature_id,i.rank`,
    )
    .all(JSON.stringify(ids))) {
    const t = JSON.parse(String(row.row_json)),
      items = result.get(String(row.literature_id)) ?? [];
    items.push({
      tag_id: row.tag_id,
      name: t.name_zh || t.name_en,
      rank: row.rank,
      ...(row.origin === null
        ? {}
        : {
            origin: row.origin,
            locked: Number(row.locked) === 1,
            evidence_count: Number(row.evidence_count),
          }),
    });
    result.set(String(row.literature_id), items);
  }
  return result;
}
function primaryDocumentTexts(ids: readonly string[]): Map<string, Dynamic> {
  return draftFactsModule.primaryDefaultTexts(
    draftFactsModule.readDefaultTextFacts(db, ids),
  );
}
function searchItem(
  id: Dynamic,
  literature: Dynamic = undefined,
  levels?: ReadonlyMap<string, Dynamic>,
): Dynamic {
  queryCheckpoint();
  literature = literature ?? getLiterature(id);
  const metadata = db
    .prepare(
      "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
    )
    .get(id);
  const state = libraryState.get(id);
  if (!state) fail();
  const defaultTexts = levels ?? primaryDocumentTexts([String(id)]);
  const exhausted = !!db
    .prepare(
      "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
    )
    .get(id);
  return {
    literature,
    ...metadata,
    tags: libraryTagBadges([id]).get(id) ?? [],
    intake_at: libraryPageModule.intakeAt(db, id),
    ...folderModule.libraryMembership(db, id),
    text_level: defaultTexts.get(String(id))?.text_level ?? null,
    draft_facts: defaultTexts.get(String(id))?.draft_facts ?? null,
    collected: libraryState.collected(id),
    long_document: archiveModule.archiveLongDocuments(db, [id]).get(id) ?? null,
    missing_step: state.missing_step,
    needs_manual_pdf: state.status === "UNREVIEWED" && exhausted,
    needs_metadata: !!db
      .prepare("SELECT 1 FROM literature_needs_metadata WHERE literature_id=?")
      .get(id),
  };
}
// The durable exhaustion fact is exactly one LiteratureId: a candidate, route, failure reason, provider, configuration hash or attempt count can never be persisted beside it. Only a business owner that observed every current automatic acquisition route end normally may set it; the API itself never decides that.
function exhaustionLiteratureId(command: Dynamic): Dynamic {
  if (
    !command ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    Object.keys(command).sort().join() !== EXHAUSTION_COMMAND_KEYS
  )
    fail();
  const id = command.literatureId;
  if (typeof id !== "string" || !EXHAUSTION_LITERATURE_RE.test(id)) fail();
  if (!db.prepare("SELECT 1 FROM literatures WHERE literature_id=?").get(id))
    fail();
  return id;
}
function setAutomaticPdfExhaustion(command: Dynamic): Dynamic {
  return transaction(() => {
    const id = exhaustionLiteratureId(command);
    db.prepare(
      "INSERT INTO automatic_pdf_acquisition_exhaustions(literature_id) VALUES(?) ON CONFLICT(literature_id) DO NOTHING",
    ).run(id);
    if (
      !db
        .prepare(
          "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
        )
        .get(id)
    )
      fail();
    return true;
  });
}
function clearAutomaticPdfExhaustion(command: Dynamic): Dynamic {
  return transaction(() => {
    const id = exhaustionLiteratureId(command);
    db.prepare(
      "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
    ).run(id);
    return !db
      .prepare(
        "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
      )
      .get(id);
  });
}
function readAutomaticPdfExhaustion(command: Dynamic): Dynamic {
  return readTransaction(() => {
    const id = exhaustionLiteratureId(command);
    return !!db
      .prepare(
        "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
      )
      .get(id);
  });
}
function validateProjectedDiscovery(id: string) {
  if (
    db
      .prepare(
        "SELECT 1 FROM library_discovery_invalid WHERE discovery_run_id=? LIMIT 1",
      )
      .get(id)
  )
    fail();
}
function validateDiscoveryCauses(ids: Dynamic): Dynamic {
  if (!ids.length) return;
  const indexed = libraryPagingReady(db);
  for (const id of new Set<Dynamic>(ids)) {
    if (indexed) {
      validateProjectedDiscovery(id);
      continue;
    }
    const kind =
      db
        .prepare("SELECT kind FROM discovery_runs WHERE discovery_run_id=?")
        .get(id)?.kind ?? null;
    if (
      db
        .prepare(
          `
      SELECT 1 FROM topic_discovery_causes c
      WHERE c.discovery_run_id=? AND ${invalidTopicCause("c", "?")} LIMIT 1`,
        )
        .get(id, kind)
    )
      fail();
    if (
      db
        .prepare(
          `
      SELECT 1 FROM citation_discovery_causes c
      WHERE c.discovery_run_id=? AND ${invalidCitationCause("c", "?")} LIMIT 1`,
        )
        .get(id, kind)
    )
      fail();
    if (
      db
        .prepare(
          `
      SELECT 1 FROM discovery_results r WHERE r.discovery_run_id=? AND
      ${invalidDiscoveryResult("r", "?")} LIMIT 1`,
        )
        .get(id, kind)
    )
      fail();
  }
}

function librarySnapshot(
  ftsQuery: Dynamic,
  discoveryRunIds: Dynamic,
  includeOtherVersions: Dynamic,
  literatureIds: Dynamic = [],
  metaLiteratureIds: Dynamic = [],
  tags: Dynamic = undefined,
  scope: Dynamic = undefined,
): Dynamic {
  return readTransaction(() => {
    if (
      !Array.isArray(literatureIds) ||
      !Array.isArray(metaLiteratureIds) ||
      literatureIds.length > 10000 ||
      metaLiteratureIds.length > 10000 ||
      (literatureIds.length && metaLiteratureIds.length)
    )
      fail();
    validateDiscoveryCauses(discoveryRunIds);
    let scopeMatches: Set<string> | null = null;
    if (scope) {
      scopeMatches = new Set(
        libraryPageModule
          .libraryPageIds(db, {
            query: scope,
            ftsQuery,
            sort: scope.recently_opened ? "opened-desc" : "intake-desc",
            limit: Number.MAX_SAFE_INTEGER,
            after: null,
            fullRelevance: true,
          })
          .rows.map((r: Dynamic) => String(r.literature_id)),
      );
    }
    // Select IDs before materializing domain rows: an unrelated row must not be
    // parsed just because it shares the catalog or an FTS term with this scope.
    const conditions: string[] = [
      visibilityModule.visibleLiteratureSql("literature_id"),
    ];
    const parameters: string[] = [];
    if (scopeMatches) {
      conditions.push("literature_id IN (SELECT value FROM json_each(?))");
      parameters.push(JSON.stringify([...scopeMatches]));
    }
    if (ftsQuery !== null) {
      conditions.push("literature_search_fts MATCH ?");
      parameters.push(ftsQuery);
    }
    if (literatureIds.length) {
      conditions.push("literature_id IN (SELECT value FROM json_each(?))");
      parameters.push(JSON.stringify(literatureIds));
    }
    if (metaLiteratureIds.length) {
      conditions.push(
        "literature_id IN (SELECT literature_id FROM literatures WHERE meta_literature_id IN (SELECT value FROM json_each(?)))",
      );
      parameters.push(JSON.stringify(metaLiteratureIds));
    }
    if (discoveryRunIds.length) {
      conditions.push(
        `literature_id IN (SELECT actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id IN (SELECT value FROM json_each(?)) UNION SELECT actual_literature_id FROM citation_discovery_causes WHERE ${visibilityModule.visibleCitationSql()} AND discovery_run_id IN (SELECT value FROM json_each(?)))`,
      );
      const json = JSON.stringify(discoveryRunIds);
      parameters.push(json, json);
    }
    if (tags?.ids?.length) {
      const ids = tagModule.resolveLibraryTagIds(db, tags.ids);
      conditions.push(
        `literature_id IN (SELECT literature_id FROM literature_tag_items WHERE tag_id IN (SELECT value FROM json_each(?)) ${tags.mode === "primary" ? "AND rank=1" : ""})`,
      );
      parameters.push(JSON.stringify(ids));
    }
    const selection =
      ftsQuery === null
        ? "SELECT literature_id,NULL AS relevance FROM literatures"
        : "SELECT literature_id,bm25(literature_search_fts) AS relevance FROM literature_search_fts";
    let rows = db
      .prepare(
        `${selection}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY literature_id`,
      )
      .all(...parameters);
    if (
      new Set<Dynamic>(rows.map((row: Dynamic) => row.literature_id)).size !==
      rows.length
    )
      fail();
    const tagMatches = tags?.ids?.length
      ? new Set(rows.map((r: Dynamic) => r.literature_id))
      : null;
    if (
      includeOtherVersions &&
      (ftsQuery !== null ||
        discoveryRunIds.length ||
        literatureIds.length ||
        tags?.ids?.length ||
        scopeMatches)
    ) {
      const relevance = new Map<Dynamic, Dynamic>(
        rows.map((row: Dynamic) => [row.literature_id, row.relevance]),
      );
      rows = db
        .prepare(
          `SELECT literature_id FROM literatures WHERE ${visibilityModule.visibleLiteratureSql("literature_id")} AND meta_literature_id IN (SELECT meta_literature_id FROM literatures WHERE literature_id IN (SELECT value FROM json_each(?))) ORDER BY literature_id`,
        )
        .all(JSON.stringify(rows.map((row: Dynamic) => row.literature_id)))
        .map((row: Dynamic) => ({
          literature_id: row.literature_id,
          relevance: relevance.get(row.literature_id) ?? null,
        }));
    }
    const textLevels = primaryDocumentTexts(
      rows.map((row: Dynamic) => String(row.literature_id)),
    );
    let result;
    if (literatureIds.length || metaLiteratureIds.length) {
      const ids = rows.map((row: Dynamic) => row.literature_id);
      const json = JSON.stringify(ids);
      const literatureById = new Map<Dynamic, Dynamic>(
        getLiteratures(ids).map((item: Dynamic) => [item.literature_id, item]),
      );
      const metadataById = new Map<Dynamic, Dynamic>(
        db
          .prepare(
            "SELECT literature_id,metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id IN (SELECT value FROM json_each(?))",
          )
          .all(json)
          .map((item: Dynamic) => [item.literature_id, item]),
      );
      const exhausted = new Set<Dynamic>(
        db
          .prepare(
            "SELECT literature_id FROM automatic_pdf_acquisition_exhaustions WHERE literature_id IN (SELECT value FROM json_each(?))",
          )
          .all(json)
          .map((item: Dynamic) => item.literature_id),
      );
      const discovery = new Map<Dynamic, Dynamic>();
      for (const item of db
        .prepare(
          `SELECT actual_literature_id,discovery_run_id FROM topic_discovery_causes WHERE actual_literature_id IN (SELECT value FROM json_each(?)) UNION SELECT actual_literature_id,discovery_run_id FROM citation_discovery_causes WHERE ${visibilityModule.visibleCitationSql()} AND actual_literature_id IN (SELECT value FROM json_each(?)) ORDER BY actual_literature_id,discovery_run_id`,
        )
        .all(json, json)) {
        const values = discovery.get(item.actual_literature_id) ?? [];
        values.push(item.discovery_run_id);
        discovery.set(item.actual_literature_id, values);
      }
      const tagBadges = libraryTagBadges(
        rows.map((row: Dynamic) => String(row.literature_id)),
      );
      const longDocuments = archiveModule.archiveLongDocuments(
        db,
        rows.map((row: Dynamic) => String(row.literature_id)),
      );
      result = rows.map((row: Dynamic) => {
        const loaded = literatureById.get(row.literature_id);
        const metadata = metadataById.get(row.literature_id);
        if (!loaded || !metadata) fail();
        const { __state, ...literature } = loaded;
        const hasExhaustion = exhausted.has(row.literature_id);
        return {
          item: {
            literature,
            metadata_revision: metadata.metadata_revision,
            metadata_sha256: metadata.metadata_sha256,
            tags: tagBadges.get(String(row.literature_id)) ?? [],
            intake_at: libraryPageModule.intakeAt(db, row.literature_id),
            ...folderModule.libraryMembership(db, row.literature_id),
            collected: libraryState.collected(row.literature_id),
            long_document: longDocuments.get(String(row.literature_id)) ?? null,
            text_level:
              textLevels.get(String(row.literature_id))?.text_level ?? null,
            draft_facts:
              textLevels.get(String(row.literature_id))?.draft_facts ?? null,
            missing_step: __state.missing_step,
            needs_manual_pdf: __state.status === "UNREVIEWED" && hasExhaustion,
            needs_metadata: !!db
              .prepare(
                "SELECT 1 FROM literature_needs_metadata WHERE literature_id=?",
              )
              .get(row.literature_id),
          },
          relevance: row.relevance,
          has_pdf_exhaustion: hasExhaustion,
          discovery_run_ids: discovery.get(row.literature_id) ?? [],
        };
      });
    } else
      result = rows.map((row: Dynamic) => ({
        item: searchItem(row.literature_id, undefined, textLevels),
        relevance: row.relevance,
        has_pdf_exhaustion: !!db
          .prepare(
            "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
          )
          .get(row.literature_id),
        discovery_run_ids: db
          .prepare(
            `SELECT discovery_run_id FROM topic_discovery_causes WHERE actual_literature_id=? UNION SELECT discovery_run_id FROM citation_discovery_causes WHERE ${visibilityModule.visibleCitationSql()} AND actual_literature_id=?`,
          )
          .all(row.literature_id, row.literature_id)
          .map((x: Dynamic) => x.discovery_run_id),
      }));
    if (scopeMatches)
      result = result.map((r: Dynamic) => ({
        ...r,
        scope_match: scopeMatches.has(r.item.literature.literature_id),
      }));
    return tagMatches
      ? result.map((r: Dynamic) => ({
          ...r,
          tag_match: tagMatches.has(r.item.literature.literature_id),
        }))
      : result;
  });
}
function libraryExactCount(
  command: Extract<SqliteCommand, { kind: "library_exact_count" }>,
) {
  return readTransaction(() => {
    // A real catalog read pins the WAL snapshot before reporting its time.
    const snapshot_at = String(
      db
        .prepare(
          "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at FROM schema_identity WHERE singleton=1",
        )
        .get().at,
    );
    const at = Date.parse(snapshot_at);
    const { request, ftsQuery } = command;
    const { kind, query } = request;
    if (kind === "facets")
      return {
        kind,
        snapshot_at,
        facets: libraryPageModule.libraryFacets(
          db,
          query,
          ftsQuery,
          request.limit,
          true,
          at,
        ),
      };
    validateDiscoveryCauses(query.discovery_run_ids);
    if (kind === "counts")
      return {
        kind,
        snapshot_at,
        counts: libraryPageModule.libraryCounts(db, query, ftsQuery, true, at),
      };
    return {
      kind,
      snapshot_at,
      total_count: libraryPageModule.librarySearchTotal(
        db,
        query,
        ftsQuery,
        true,
        undefined,
        at,
      ).total_count,
    };
  });
}
function librarySearchPage(
  request: import("../../literature/query.js").LibraryPageQuery,
  defer: boolean,
): Dynamic {
  return readTransaction(() => {
    const pagingReady = libraryPagingReady(db);
    if (defer) {
      const plan = libraryState.readPlan();
      if (
        (!plan.indexed &&
          (request.query.statuses.length ||
            request.query.missing_steps.length ||
            request.query.needs_manual_pdf === true)) ||
        (!plan.collectionReady &&
          (request.query.collection_scope === "collected" ||
            request.query.collection_scope === "candidates")) ||
        (!pagingReady &&
          (request.sort === "collected-desc" ||
            request.query.folder ||
            request.query.intake_batch_ids.length ||
            request.query.discovery_run_ids.length)) ||
        (!request.after?.total &&
          globalLibraryCountScope(request.query) &&
          !libraryState.countsReady(plan))
      )
        return { defer: true };
    }
    validateDiscoveryCauses(request.query.discovery_run_ids);
    const page = libraryPageModule.libraryPageIds(db, request, libraryRankings);
    const textLevels = primaryDocumentTexts(
      page.rows.map((row: Dynamic) => String(row.literature_id)),
    );
    const { rows: pageRows, ...summary } = page;
    const rows = pageRows.map((row: Dynamic) => ({
      item: {
        ...searchItem(row.literature_id, undefined, textLevels),
        ...(request.sort === "collected-desc"
          ? {
              collected_at: libraryPageModule.collectedAt(
                db,
                row.literature_id,
                pagingReady,
              ),
            }
          : {}),
      },
      relevance: row.relevance,
      ...(row.workset_at === undefined ? {} : { workset_at: row.workset_at }),
      has_pdf_exhaustion: !!db
        .prepare(
          "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
        )
        .get(row.literature_id),
      discovery_run_ids: db
        .prepare(
          `SELECT discovery_run_id FROM topic_discovery_causes WHERE actual_literature_id=? UNION SELECT discovery_run_id FROM citation_discovery_causes WHERE ${visibilityModule.visibleCitationSql()} AND actual_literature_id=?`,
        )
        .all(row.literature_id, row.literature_id)
        .map((r: Dynamic) => r.discovery_run_id),
    }));
    if (!request.fullRelevance) {
      const uncollected = rows
        .slice(0, request.limit)
        .filter((row: Dynamic) => row.item.collected === false);
      const origins = libraryPageModule.libraryDiscoveryOrigins(
        db,
        uncollected.map((row: Dynamic) =>
          String(row.item.literature.literature_id),
        ),
      );
      for (const { item } of uncollected)
        item.discovery_origin =
          origins.get(item.literature.literature_id) ?? null;
    }
    return { ...summary, rows };
  });
}
function collectLibrarySelection(
  request: import("../../literature/query.js").LibraryCollectRequest,
): import("@sciretriever/contracts").CollectLiteraturesResult | null {
  queryCheckpoint();
  const { selector } = request;
  if (selector.kind === "query")
    validateDiscoveryCauses(selector.query.discovery_run_ids);
  const targets = libraryPageModule.libraryCollectionTargets(db, request);
  const count = db
    .prepare(
      `SELECT count(*) AS total,count(DISTINCT literature_id) AS unique_count FROM (${targets.sql})`,
    )
    .get(...targets.parameters)!;
  if (count.total !== count.unique_count)
    throw new Error("duplicate library search rows");
  queryCheckpoint();
  const target_count = Number(count.total);
  if (
    selector.kind === "literatures" &&
    target_count !== selector.literature_ids.length
  )
    return null;
  const newly_collected = target_count
    ? libraryStateModule.recordCollectedLiteratures(db, targets)
    : 0;
  queryCheckpoint();
  return { target_count, newly_collected };
}
function uncollectLibrarySelection(
  request: import("../../literature/query.js").LibraryCollectRequest,
):
  | import("@sciretriever/contracts").UncollectLiteraturesResult
  | null
  | "collection-pending" {
  queryCheckpoint();
  const { selector } = request;
  if (selector.kind === "query")
    validateDiscoveryCauses(selector.query.discovery_run_ids);
  if (!libraryState.readPlan().collectionReady) return "collection-pending";
  const targets = libraryPageModule.libraryCollectionTargets(db, request);
  const count = db
    .prepare(
      `SELECT count(*) AS total,count(DISTINCT literature_id) AS unique_count FROM (${targets.sql})`,
    )
    .get(...targets.parameters)!;
  if (count.total !== count.unique_count)
    throw new Error("duplicate library search rows");
  queryCheckpoint();
  const target_count = Number(count.total);
  if (
    selector.kind === "literatures" &&
    target_count !== selector.literature_ids.length
  )
    return null;
  const removal = target_count
    ? libraryStateModule.removeCollectedLiteratures(db, targets)
    : { removed: 0, folder_members_removed: 0 };
  queryCheckpoint();
  return { target_count, ...removal };
}
function listLiterature(afterId: Dynamic, limit: Dynamic): Dynamic {
  const rows = db
    .prepare(
      `SELECT literature_id FROM literatures WHERE ${visibilityModule.visibleLiteratureSql("literature_id")} AND (? IS NULL OR literature_id>?) ORDER BY literature_id LIMIT ?`,
    )
    .all(afterId, afterId, limit + 1);
  const items = rows
    .slice(0, limit)
    .map((row: Dynamic) => getLiterature(row.literature_id));
  return {
    items,
    next_cursor: rows.length > limit ? rows[limit - 1].literature_id : null,
  };
}
function currentFacts(id: Dynamic): Dynamic {
  db.exec("BEGIN");
  try {
    const literature = getLiterature(id, true);
    if (!literature) {
      db.exec("COMMIT");
      return null;
    }
    const snapshot = db
      .prepare(
        "SELECT metadata_revision AS revision,metadata_sha256 AS sha256 FROM literature_metadata WHERE literature_id=?",
      )
      .get(id);
    const asset =
      db
        .prepare(
          "SELECT a.asset_id,a.sha256,a.size_bytes,a.media_type,a.relative_path AS path FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'",
        )
        .get(id) || null;
    db.exec("COMMIT");
    return { literature, metadata_snapshot: snapshot, primary_asset: asset };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function assetByHash(hash: Dynamic): Dynamic {
  return (
    db
      .prepare(
        "SELECT asset_id,sha256,size_bytes,media_type,relative_path AS path FROM assets WHERE sha256=? ORDER BY asset_id LIMIT 1",
      )
      .get(hash) || null
  );
}
function putObservation(o: Dynamic): Dynamic {
  return transaction(() => storeObservation(o));
}
function storeObservation(o: Dynamic, literatureId = o.literature_id): Dynamic {
  const old = getObservation(o.observation_id);
  if (old) {
    const normalized = (value: Dynamic) => {
      const body = { ...value };
      delete body.literature_id;
      return {
        ...body,
        metadata: {
          ...body.metadata,
          authors: body.metadata.authors.map((author: Dynamic) => {
            const result = { ...author };
            delete result.ordinal;
            return result;
          }),
        },
        version_links: body.version_links || [],
        asset_hints: body.asset_hints || [],
      };
    };
    const stable = (value: Dynamic): Dynamic =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, stable(v)]),
            )
          : value;
    if (
      JSON.stringify(stable(normalized(old))) !==
        JSON.stringify(stable(normalized(o))) ||
      (old.literature_id !== undefined &&
        literatureId !== undefined &&
        old.literature_id !== literatureId)
    )
      fail();
    if (literatureId !== undefined)
      db.prepare(
        "INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      ).run(literatureId, o.observation_id);
    return true;
  }
  const p = o.provenance;
  insertExact("provenances", p, "provenance_id");
  db.prepare(
    "INSERT INTO metadata_observations(observation_id,source_type,source_type_mapping_version,provenance_id,version_role,reference_count,cited_by_count,title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_id) DO NOTHING",
  ).run(
    o.observation_id,
    o.source_type,
    o.source_type_mapping_version,
    p.provenance_id,
    o.version_role,
    o.reference_count,
    o.cited_by_count,
    o.metadata.title,
    o.metadata.abstract,
    o.metadata.publication_date,
    o.metadata.publication_year,
    o.metadata.publication_form,
    o.metadata.article_kind,
    o.metadata.language,
    o.metadata.venue,
    o.metadata.publisher,
    o.metadata.volume,
    o.metadata.issue,
    o.metadata.pages,
  );
  const author = db.prepare(
    "INSERT INTO metadata_observation_authors(observation_id,ordinal,kind,display_name,given_name,family_name,orcid) VALUES(?,?,?,?,?,?,?) ON CONFLICT(observation_id,ordinal) DO NOTHING",
  );
  for (let i = 0; i < o.metadata.authors.length; i++) {
    const a = o.metadata.authors[i];
    author.run(
      o.observation_id,
      i,
      a.kind,
      a.display_name,
      a.given_name,
      a.family_name,
      a.orcid,
    );
    for (let j = 0; j < a.affiliations.length; j++) {
      const f = a.affiliations[j];
      db.prepare(
        "INSERT INTO metadata_observation_author_affiliations(observation_id,author_ordinal,affiliation_ordinal,name,ror) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      ).run(o.observation_id, i, j, f.name, f.ror);
    }
  }
  const identifier = db.prepare(
    "INSERT INTO metadata_observation_identifiers(observation_id,ordinal,namespace,value) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
  );
  for (let i = 0; i < o.metadata.identifiers.length; i++) {
    const x = o.metadata.identifiers[i];
    identifier.run(o.observation_id, i, x.namespace, x.value);
  }
  const keyword = db.prepare(
    "INSERT INTO metadata_observation_keywords(observation_id,ordinal,keyword) VALUES(?,?,?) ON CONFLICT DO NOTHING",
  );
  for (let i = 0; i < o.metadata.keywords.length; i++)
    keyword.run(o.observation_id, i, o.metadata.keywords[i]);
  const subject = db.prepare(
    "INSERT INTO metadata_observation_subject_terms(observation_id,ordinal,term) VALUES(?,?,?) ON CONFLICT DO NOTHING",
  );
  for (const [i, term] of o.metadata.subject_terms.entries())
    subject.run(o.observation_id, i, term);
  const declared = db.prepare(
    "INSERT INTO metadata_observation_declared_keywords(observation_id,ordinal,keyword) VALUES(?,?,?) ON CONFLICT DO NOTHING",
  );
  for (let i = 0; i < o.declared_keywords.length; i++)
    declared.run(o.observation_id, i, o.declared_keywords[i]);
  const reference = db.prepare(
    "INSERT INTO metadata_observation_reference_texts(observation_id,reference_index,reference_text) VALUES(?,?,?) ON CONFLICT DO NOTHING",
  );
  for (let i = 0; i < o.reference_texts.length; i++)
    reference.run(o.observation_id, i, o.reference_texts[i]);
  for (let i = 0; i < (o.asset_hints || []).length; i++) {
    const h = o.asset_hints[i];
    db.prepare(
      "INSERT INTO metadata_observation_asset_hints(observation_id,hint_ordinal,url,kind,media_type,asset_role,version_role,access_status,license) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    ).run(
      o.observation_id,
      i,
      h.url,
      h.kind,
      h.media_type,
      h.asset_role,
      h.version_role,
      h.access_status,
      h.license,
    );
  }
  for (let i = 0; i < (o.version_links || []).length; i++) {
    const link = o.version_links[i];
    db.prepare(
      "INSERT INTO metadata_observation_version_links(observation_id,link_ordinal,record_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
    ).run(o.observation_id, i, link.record_id);
    for (let j = 0; j < link.identifiers.length; j++) {
      const x = link.identifiers[j];
      db.prepare(
        "INSERT INTO metadata_observation_version_link_identifiers(observation_id,link_ordinal,ordinal,namespace,value) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      ).run(o.observation_id, i, j, x.namespace, x.value);
    }
  }
  if (literatureId !== undefined)
    db.prepare(
      "INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING",
    ).run(literatureId, o.observation_id);
  return true;
}
function getObservation(id: Dynamic): Dynamic {
  const row = db
    .prepare(
      "SELECT observation_id,source_type,source_type_mapping_version,provenance_id,version_role,reference_count,cited_by_count,title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages FROM metadata_observations WHERE observation_id=?",
    )
    .get(id);
  if (!row) return null;
  const p = db
    .prepare(
      "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=(SELECT provenance_id FROM metadata_observations WHERE observation_id=?)",
    )
    .get(id);
  const authors = db
    .prepare(
      "SELECT ordinal,kind,display_name,given_name,family_name,orcid FROM metadata_observation_authors WHERE observation_id=? ORDER BY ordinal",
    )
    .all(id)
    .map(({ ordinal, ...a }: Dynamic) => ({
      ...a,
      affiliations: db
        .prepare(
          "SELECT name,ror FROM metadata_observation_author_affiliations WHERE observation_id=? AND author_ordinal=? ORDER BY affiliation_ordinal",
        )
        .all(id, ordinal),
    }));
  const identifiers = db
    .prepare(
      "SELECT namespace,value FROM metadata_observation_identifiers WHERE observation_id=? ORDER BY ordinal",
    )
    .all(id);
  const keywords = db
    .prepare(
      "SELECT keyword FROM metadata_observation_keywords WHERE observation_id=? ORDER BY ordinal",
    )
    .all(id)
    .map((x: Dynamic) => x.keyword);
  const declared_keywords = db
    .prepare(
      "SELECT keyword FROM metadata_observation_declared_keywords WHERE observation_id=? ORDER BY ordinal",
    )
    .all(id)
    .map((x: Dynamic) => x.keyword);
  const reference_texts = db
    .prepare(
      "SELECT reference_text FROM metadata_observation_reference_texts WHERE observation_id=? ORDER BY reference_index",
    )
    .all(id)
    .map((x: Dynamic) => x.reference_text);
  const owner = db
    .prepare(
      "SELECT literature_id FROM literature_metadata_observations WHERE observation_id=?",
    )
    .get(id);
  const asset_hints = db
    .prepare(
      "SELECT url,kind,media_type,asset_role,version_role,access_status,license FROM metadata_observation_asset_hints WHERE observation_id=? ORDER BY hint_ordinal",
    )
    .all(id);
  const version_links = db
    .prepare(
      "SELECT link_ordinal,record_id FROM metadata_observation_version_links WHERE observation_id=? ORDER BY link_ordinal",
    )
    .all(id)
    .map((link: Dynamic) => ({
      record_id: link.record_id,
      identifiers: db
        .prepare(
          "SELECT namespace,value FROM metadata_observation_version_link_identifiers WHERE observation_id=? AND link_ordinal=? ORDER BY ordinal",
        )
        .all(id, link.link_ordinal),
    }));
  return {
    observation_id: row.observation_id,
    source_type: row.source_type,
    source_type_mapping_version: row.source_type_mapping_version,
    provenance: p,
    literature_id: owner?.literature_id,
    version_role: row.version_role,
    reference_count: row.reference_count,
    cited_by_count: row.cited_by_count,
    metadata: {
      title: row.title,
      abstract: row.abstract,
      publication_date: row.publication_date,
      publication_year: row.publication_year,
      publication_form: row.publication_form,
      article_kind: row.article_kind,
      language: row.language,
      venue: row.venue,
      publisher: row.publisher,
      volume: row.volume,
      issue: row.issue,
      pages: row.pages,
      authors,
      identifiers,
      keywords,
      subject_terms: db
        .prepare(
          "SELECT term FROM metadata_observation_subject_terms WHERE observation_id=? ORDER BY ordinal",
        )
        .all(id)
        .map((r: Dynamic) => r.term),
    },
    declared_keywords,
    reference_texts,
    asset_hints,
    version_links,
  };
}
function identityRead(r: Dynamic): Dynamic {
  return readTransaction(() => {
    if (
      !r ||
      typeof r.observation_id !== "string" ||
      !Array.isArray(r.stable_identifier_keys) ||
      r.stable_identifier_keys.length > 128 ||
      !Array.isArray(r.version_link_keys) ||
      r.version_link_keys.length > 128
    )
      fail();
    const seeds = new Set<Dynamic>();
    if (r.target_literature_id !== undefined) {
      if (
        typeof r.target_literature_id !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
          r.target_literature_id,
        )
      )
        fail();
      if (
        db
          .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
          .get(r.target_literature_id)
      )
        seeds.add(r.target_literature_id);
    }
    const addOwners = (ids: Dynamic) => {
      for (const observationId of ids) {
        const owner = db
          .prepare(
            "SELECT literature_id FROM literature_metadata_observations WHERE observation_id=?",
          )
          .all(observationId);
        const exists = db
          .prepare("SELECT 1 FROM metadata_observations WHERE observation_id=?")
          .get(observationId);
        if (owner.length > 1 || (exists && owner.length !== 1)) fail();
        if (owner.length === 1) seeds.add(owner[0].literature_id);
      }
    };
    addOwners([r.observation_id]);
    if (r.provider_record_key !== null) {
      const k = r.provider_record_key;
      if (
        !k ||
        typeof k.source_name !== "string" ||
        typeof k.source_record_id !== "string"
      )
        fail();
      addOwners(
        db
          .prepare(
            "SELECT o.observation_id FROM metadata_observations o JOIN provenances p ON p.provenance_id=o.provenance_id WHERE p.source_kind='metadata-provider' AND p.source_name=? AND p.source_record_id=? ORDER BY o.observation_id",
          )
          .all(k.source_name, k.source_record_id)
          .map((x: Dynamic) => x.observation_id),
      );
    }
    for (const key of r.stable_identifier_keys) {
      if (
        !Array.isArray(key) ||
        key.length !== 2 ||
        typeof key[0] !== "string" ||
        typeof key[1] !== "string"
      )
        fail();
      for (const row of db
        .prepare(
          "SELECT literature_id FROM literature_metadata_identifiers WHERE namespace=? AND value=? ORDER BY literature_id",
        )
        .all(key[0], key[1]))
        seeds.add(row.literature_id);
    }
    if (r.fallback_identity_sha256 !== null) {
      if (typeof r.fallback_identity_sha256 !== "string") fail();
      for (const row of db
        .prepare(
          "SELECT literature_id FROM literature_fallback_identity_indexes WHERE fallback_identity_sha256=? ORDER BY literature_id",
        )
        .all(r.fallback_identity_sha256))
        seeds.add(row.literature_id);
    }
    if (r.user_observation_semantic_sha256 !== null) {
      if (typeof r.user_observation_semantic_sha256 !== "string") fail();
      addOwners(
        db
          .prepare(
            "SELECT observation_id FROM user_observation_semantic_indexes WHERE semantic_sha256=? ORDER BY observation_id",
          )
          .all(r.user_observation_semantic_sha256)
          .map((x: Dynamic) => x.observation_id),
      );
    }
    for (const key of r.version_link_keys) {
      if (
        !key ||
        typeof key.source_name !== "string" ||
        (key.record_id !== null && typeof key.record_id !== "string") ||
        !Array.isArray(key.stable_identifier_keys) ||
        key.stable_identifier_keys.length > 128
      )
        fail();
      let candidates = null;
      if (key.record_id !== null)
        candidates = new Set<Dynamic>(
          db
            .prepare(
              "SELECT o.observation_id FROM metadata_observations o JOIN provenances p ON p.provenance_id=o.provenance_id WHERE p.source_kind='metadata-provider' AND p.source_name=? AND p.source_record_id=? ORDER BY o.observation_id",
            )
            .all(key.source_name, key.record_id)
            .map((x: Dynamic) => x.observation_id),
        );
      for (const stable of key.stable_identifier_keys) {
        if (
          !Array.isArray(stable) ||
          stable.length !== 2 ||
          typeof stable[0] !== "string" ||
          typeof stable[1] !== "string"
        )
          fail();
        const matches = new Set<Dynamic>(
          db
            .prepare(
              "SELECT observation_id FROM metadata_observation_identifiers WHERE namespace=? AND value=? ORDER BY observation_id",
            )
            .all(stable[0], stable[1])
            .map((x: Dynamic) => x.observation_id),
        );
        candidates =
          candidates === null
            ? matches
            : new Set<Dynamic>(
                [...candidates].filter((id: Dynamic) => matches.has(id)),
              );
      }
      addOwners(candidates === null ? [] : [...candidates]);
    }
    if (!seeds.size)
      return {
        literatures: [],
        meta_literatures: [],
        observations: [],
        facts: [],
      };
    const metaIds = new Set<Dynamic>();
    for (const id of [...seeds].sort()) {
      const row = db
        .prepare(
          "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
        )
        .get(id);
      if (!row) fail();
      metaIds.add(row.meta_literature_id);
    }
    const memberIds = [];
    for (const metaId of [...metaIds].sort())
      for (const row of db
        .prepare(
          "SELECT literature_id FROM literatures WHERE meta_literature_id=? ORDER BY literature_id",
        )
        .all(metaId))
        memberIds.push(row.literature_id);
    const literatures = memberIds.map((id) => getLiterature(id, true));
    if (literatures.some((x: Dynamic) => !x)) fail();
    const meta_literatures = [...metaIds]
      .sort()
      .map((metaId: Dynamic) =>
        db
          .prepare(
            "SELECT meta_literature_id,representative_literature_id FROM meta_literatures WHERE meta_literature_id=?",
          )
          .get(metaId),
      );
    if (meta_literatures.some((x: Dynamic) => !x)) fail();
    const observations = [];
    for (const literatureId of memberIds)
      for (const row of db
        .prepare(
          "SELECT observation_id FROM literature_metadata_observations WHERE literature_id=? ORDER BY observation_id",
        )
        .all(literatureId)) {
        const stored = getObservation(row.observation_id);
        if (!stored) fail();
        const { literature_id, ...observation } = stored;
        if (literature_id !== literatureId) fail();
        observations.push({ literature_id: literatureId, observation });
      }
    const facts = literatures.map((literature: Dynamic) => {
      const metadata = db
        .prepare(
          "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
        )
        .get(literature.literature_id);
      if (!metadata) fail();
      return {
        literature,
        metadata_revision: metadata.metadata_revision,
        metadata_sha256: metadata.metadata_sha256,
        content_ready: literature.status === "READY",
        withdrawn: visibilityModule.literatureWithdrawn(
          db,
          literature.literature_id,
        ),
        field_states: metadataFieldsModule.readMetadataFields(
          db,
          literature.literature_id,
        ),
      };
    });
    return { literatures, meta_literatures, observations, facts };
  });
}
function checkIdentityToken(token: Dynamic): Dynamic {
  const row = db
    .prepare(
      "SELECT l.meta_literature_id,m.metadata_revision,m.metadata_sha256 FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE l.literature_id=?",
    )
    .get(token.literature_id);
  if (
    !row ||
    row.meta_literature_id !== token.meta_literature_id ||
    row.metadata_revision !== token.metadata_revision ||
    row.metadata_sha256 !== token.metadata_sha256
  )
    fail();
}
function checkMetaIdentityToken(token: Dynamic): Dynamic {
  const row = db
    .prepare(
      "SELECT representative_literature_id FROM meta_literatures WHERE meta_literature_id=?",
    )
    .get(token.meta_literature_id);
  const members = db
    .prepare(
      "SELECT literature_id FROM literatures WHERE meta_literature_id=? ORDER BY literature_id",
    )
    .all(token.meta_literature_id)
    .map((x: Dynamic) => x.literature_id);
  if (
    !row ||
    row.representative_literature_id !== token.representative_literature_id ||
    JSON.stringify(members) !== JSON.stringify(token.member_literature_ids)
  )
    fail();
}
function normalizeDiscoveryMemberships(
  literatureIds: Dynamic,
  retiredMetaIds: Dynamic,
): Dynamic {
  const moved = new Set<Dynamic>();
  for (const literatureId of literatureIds) {
    const current = db
      .prepare(
        "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
      )
      .get(literatureId);
    if (!current) fail();
    for (const row of db
      .prepare(
        "SELECT discovery_run_id,meta_literature_id,metadata_observation_id,actual_literature_id FROM topic_discovery_causes WHERE actual_literature_id=?",
      )
      .all(literatureId)) {
      if (row.meta_literature_id === current.meta_literature_id) continue;
      db.prepare(
        "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      ).run(row.discovery_run_id, current.meta_literature_id);
      db.prepare(
        "UPDATE topic_discovery_causes SET meta_literature_id=? WHERE discovery_run_id=? AND meta_literature_id=? AND metadata_observation_id=? AND actual_literature_id=?",
      ).run(
        current.meta_literature_id,
        row.discovery_run_id,
        row.meta_literature_id,
        row.metadata_observation_id,
        row.actual_literature_id,
      );
      moved.add(row.discovery_run_id + "\u0000" + row.meta_literature_id);
    }
    for (const row of db
      .prepare(
        "SELECT discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth FROM citation_discovery_causes WHERE actual_literature_id=?",
      )
      .all(literatureId)) {
      if (row.meta_literature_id === current.meta_literature_id) continue;
      db.prepare(
        "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      ).run(row.discovery_run_id, current.meta_literature_id);
      db.prepare(
        "UPDATE citation_discovery_causes SET meta_literature_id=? WHERE discovery_run_id=? AND meta_literature_id=? AND source_literature_id=? AND target_literature_id=? AND actual_literature_id=? AND depth=?",
      ).run(
        current.meta_literature_id,
        row.discovery_run_id,
        row.meta_literature_id,
        row.source_literature_id,
        row.target_literature_id,
        row.actual_literature_id,
        row.depth,
      );
      moved.add(row.discovery_run_id + "\u0000" + row.meta_literature_id);
    }
  }
  for (const value of [...moved].sort()) {
    const [runId, oldMetaId] = value.split("\u0000");
    const remains = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM topic_discovery_causes WHERE discovery_run_id=? AND meta_literature_id=?) OR EXISTS(SELECT 1 FROM citation_discovery_causes WHERE discovery_run_id=? AND meta_literature_id=?) AS present",
      )
      .get(runId, oldMetaId, runId, oldMetaId);
    if (!remains.present)
      db.prepare(
        "DELETE FROM discovery_results WHERE discovery_run_id=? AND meta_literature_id=?",
      ).run(runId, oldMetaId);
  }
  for (const metaId of retiredMetaIds)
    if (
      db
        .prepare("SELECT 1 FROM discovery_results WHERE meta_literature_id=?")
        .get(metaId)
    )
      fail();
}
function publishIdentityObservation(p: Dynamic): Dynamic {
  return transaction(() => {
    if (
      !p ||
      !Array.isArray(p.literatures) ||
      !Array.isArray(p.meta_literatures) ||
      !Array.isArray(p.expected_literatures) ||
      !Array.isArray(p.expected_meta_literatures) ||
      !Array.isArray(p.retired_meta_literature_ids) ||
      !Array.isArray(p.clear_automatic_pdf_exhaustion_for)
    )
      fail();
    if (p.document_condition) {
      const c = p.document_condition;
      if (
        !db
          .prepare(
            "SELECT 1 FROM document_versions d JOIN document_defaults f ON f.document_version_id=d.document_version_id JOIN structure_annotation_current a ON a.document_version_id=d.document_version_id JOIN literature_assets l ON l.literature_id=d.literature_id AND l.asset_id=d.source_asset_id AND l.role='primary-pdf' WHERE d.literature_id=? AND d.document_version_id=? AND d.schema_version=2 AND f.revision=? AND a.annotation_id=?",
          )
          .get(
            c.literature_id,
            c.document_version_id,
            c.default_revision,
            c.annotation_id,
          )
      )
        fail();
    }
    const expectedLiteratures = new Map<Dynamic, Dynamic>();
    for (const token of p.expected_literatures) {
      if (expectedLiteratures.has(token.literature_id)) fail();
      checkIdentityToken(token);
      expectedLiteratures.set(token.literature_id, token);
    }
    const expectedMetas = new Map<Dynamic, Dynamic>();
    for (const token of p.expected_meta_literatures) {
      if (expectedMetas.has(token.meta_literature_id)) fail();
      checkMetaIdentityToken(token);
      expectedMetas.set(token.meta_literature_id, token);
    }
    const metas = new Set<Dynamic>();
    for (const meta of p.meta_literatures) {
      if (metas.has(meta.meta_literature_id)) fail();
      metas.add(meta.meta_literature_id);
      const existing = db
        .prepare(
          "SELECT representative_literature_id FROM meta_literatures WHERE meta_literature_id=?",
        )
        .get(meta.meta_literature_id);
      if (existing && !expectedMetas.has(meta.meta_literature_id)) fail();
      if (existing)
        db.prepare(
          "UPDATE meta_literatures SET representative_literature_id=? WHERE meta_literature_id=?",
        ).run(meta.representative_literature_id, meta.meta_literature_id);
      else
        db.prepare(
          "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?)",
        ).run(meta.meta_literature_id, meta.representative_literature_id);
    }
    const changedIds = new Set<Dynamic>();
    for (const item of p.literatures) {
      const l = item.literature;
      if (changedIds.has(l.literature_id)) fail();
      changedIds.add(l.literature_id);
      const existing = db
        .prepare(
          "SELECT meta_literature_id,version_role FROM literatures WHERE literature_id=?",
        )
        .get(l.literature_id);
      if (existing && !expectedLiteratures.has(l.literature_id)) fail();
      if (!existing && expectedLiteratures.has(l.literature_id)) fail();
      if (existing)
        db.prepare(
          "UPDATE literatures SET meta_literature_id=?,version_role=? WHERE literature_id=?",
        ).run(l.meta_literature_id, l.version_role, l.literature_id);
      else
        db.prepare(
          "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?)",
        ).run(l.literature_id, l.meta_literature_id, l.version_role);
      writeMetadataAtRevision(
        l.literature_id,
        l.metadata,
        item.metadata_revision,
        item.metadata_sha256,
      );
      replaceFallbackIndex(l.literature_id, item.fallback_identity_sha256);
    }
    normalizeDiscoveryMemberships(
      [...changedIds],
      p.retired_meta_literature_ids,
    );
    if (p.observation !== null) {
      const link = p.observation;
      if (
        !db
          .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
          .get(link.literature_id)
      )
        fail();
      storeObservation(link.observation, link.literature_id);
      if (link.user_semantic_sha256 !== null) {
        const existing = db
          .prepare(
            "SELECT semantic_sha256 FROM user_observation_semantic_indexes WHERE observation_id=?",
          )
          .get(link.observation.observation_id);
        if (existing && existing.semantic_sha256 !== link.user_semantic_sha256)
          fail();
        if (!existing)
          db.prepare(
            "INSERT INTO user_observation_semantic_indexes(observation_id,semantic_sha256) VALUES(?,?)",
          ).run(link.observation.observation_id, link.user_semantic_sha256);
      }
    }
    for (const item of p.literatures)
      metadataFieldsModule.writeMetadataFields(
        db,
        item.literature.literature_id,
        item.metadata_revision,
        item.literature.metadata,
        item.field_states,
      );
    for (const meta of p.meta_literatures)
      if (
        !db
          .prepare(
            "SELECT 1 FROM literatures WHERE literature_id=? AND meta_literature_id=?",
          )
          .get(meta.representative_literature_id, meta.meta_literature_id)
      )
        fail();
    for (const metaId of p.retired_meta_literature_ids) {
      if (
        !expectedMetas.has(metaId) ||
        db
          .prepare("SELECT 1 FROM literatures WHERE meta_literature_id=?")
          .get(metaId)
      )
        fail();
      db.prepare("DELETE FROM meta_literatures WHERE meta_literature_id=?").run(
        metaId,
      );
    }
    for (const literatureId of p.clear_automatic_pdf_exhaustion_for) {
      if (
        !db
          .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
          .get(literatureId)
      )
        fail();
      db.prepare(
        "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
      ).run(literatureId);
    }
    if (p.intake_member) intakeModule.recordIntakeMember(db, p.intake_member);
    if (p.observation) {
      const observation = p.observation.observation;
      const manualTitle =
        observation.provenance.source_name === "manual-metadata" &&
        p.literatures.some((item: Dynamic) =>
          item.field_states.some(
            (state: Dynamic) =>
              state.field === "title" &&
              state.evidence.observation_id === observation.observation_id &&
              state.locked,
          ),
        );
      if (
        manualTitle ||
        (observation.metadata.identifiers.length &&
          (p.intake_member ||
            observation.provenance.source_name === "post-parse-recognition" ||
            observation.provenance.source_name === "file-recognition"))
      )
        db.prepare(
          "DELETE FROM literature_needs_metadata WHERE literature_id=?",
        ).run(p.observation.literature_id);
    }
    return true;
  });
}
function acceptObservation(c: Dynamic): Dynamic {
  try {
    beginCatalogWrite(db);
    const current = db
      .prepare(
        "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
      )
      .get(c.literatureId);
    if (
      !current ||
      current.metadata_revision !== c.expectedMetadataRevision ||
      current.metadata_sha256 !== c.expectedMetadataSha256
    )
      fail();
    const observation = db
      .prepare(
        "SELECT title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages FROM metadata_observations WHERE observation_id=?",
      )
      .get(c.observationId);
    if (!observation) fail();
    db.prepare(
      "UPDATE literature_metadata SET metadata_revision=metadata_revision+1,metadata_sha256=?,title=?,abstract=?,publication_date=?,publication_year=?,publication_form=?,article_kind=?,language=?,venue=?,publisher=?,volume=?,issue=?,pages=? WHERE literature_id=?",
    ).run(
      c.nextMetadataSha256,
      observation.title,
      observation.abstract,
      observation.publication_date,
      observation.publication_year,
      observation.publication_form,
      observation.article_kind,
      observation.language,
      observation.venue,
      observation.publisher,
      observation.volume,
      observation.issue,
      observation.pages,
      c.literatureId,
    );
    db.prepare(
      "DELETE FROM literature_metadata_authors WHERE literature_id=?",
    ).run(c.literatureId);
    db.prepare(
      "DELETE FROM literature_metadata_identifiers WHERE literature_id=?",
    ).run(c.literatureId);
    db.prepare(
      "DELETE FROM literature_metadata_keywords WHERE literature_id=?",
    ).run(c.literatureId);
    db.prepare(
      "INSERT INTO literature_metadata_authors(literature_id,ordinal,kind,display_name,given_name,family_name,orcid) SELECT ?,ordinal,kind,display_name,given_name,family_name,orcid FROM metadata_observation_authors WHERE observation_id=?",
    ).run(c.literatureId, c.observationId);
    db.prepare(
      "INSERT INTO literature_metadata_author_affiliations(literature_id,author_ordinal,affiliation_ordinal,name,ror) SELECT ?,author_ordinal,affiliation_ordinal,name,ror FROM metadata_observation_author_affiliations WHERE observation_id=?",
    ).run(c.literatureId, c.observationId);
    db.prepare(
      "INSERT INTO literature_metadata_identifiers(literature_id,ordinal,namespace,value) SELECT ?,ordinal,namespace,value FROM metadata_observation_identifiers WHERE observation_id=?",
    ).run(c.literatureId, c.observationId);
    db.prepare(
      "INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) SELECT ?,ordinal,keyword FROM metadata_observation_keywords WHERE observation_id=?",
    ).run(c.literatureId, c.observationId);
    db.prepare(
      "INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?)",
    ).run(c.literatureId, c.observationId);
    db.prepare(
      "DELETE FROM literature_metadata_subject_terms WHERE literature_id=?",
    ).run(c.literatureId);
    for (const r of db
      .prepare(
        "SELECT ordinal,term FROM metadata_observation_subject_terms WHERE observation_id=? AND ordinal<8 ORDER BY ordinal",
      )
      .all(c.observationId))
      db.prepare(
        "INSERT INTO literature_metadata_subject_terms(literature_id,ordinal,term,normalized_term) VALUES(?,?,?,?)",
      ).run(
        c.literatureId,
        r.ordinal,
        r.term,
        queryTextModule.normalizeQueryText(r.term),
      );
    indexMetadata(c.literatureId, getLiterature(c.literatureId, true).metadata);
    // Accepting a new MetadataObservation invalidates the automatic acquisition exhaustion fact.
    db.prepare(
      "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
    ).run(c.literatureId);
    commitCatalogWrite(db);
    return true;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure when rollback also fails.
    }
    throw e;
  }
}
function insertExact(table: Dynamic, values: Dynamic, key: Dynamic): Dynamic {
  const columns = Object.keys(values);
  db.prepare(
    "INSERT INTO " +
      table +
      "(" +
      columns.join(",") +
      ") VALUES(" +
      columns.map(() => "?").join(",") +
      ") ON CONFLICT(" +
      key +
      ") DO NOTHING",
  ).run(...Object.values(values));
  const row = db
    .prepare(
      "SELECT " + columns.join(",") + " FROM " + table + " WHERE " + key + "=?",
    )
    .get(values[key]);
  if (!row || columns.some((column: Dynamic) => row[column] !== values[column]))
    fail();
}
function writeLiteratureAsset(p: Dynamic): Dynamic {
  const existed = db
    .prepare("SELECT 1 FROM literature_assets WHERE literature_asset_id=?")
    .get(p.literature_asset_id);
  insertExact("provenances", p.provenance, "provenance_id");
  const a = p.asset;
  const registered = db
    .prepare(
      "SELECT sha256,byte_size,media_type FROM artifact_objects WHERE relative_path=?",
    )
    .get(a.path);
  if (registered) {
    if (
      registered.sha256 !== a.sha256 ||
      registered.byte_size !== a.size_bytes ||
      registered.media_type !== a.media_type
    )
      fail();
  } else
    insertExact(
      "artifact_objects",
      {
        artifact_id: a.asset_id,
        sha256: a.sha256,
        byte_size: a.size_bytes,
        media_type: a.media_type,
        relative_path: a.path,
      },
      "artifact_id",
    );
  insertExact(
    "assets",
    {
      asset_id: a.asset_id,
      sha256: a.sha256,
      size_bytes: a.size_bytes,
      media_type: a.media_type,
      relative_path: a.path,
    },
    "asset_id",
  );
  insertExact(
    "literature_assets",
    {
      literature_asset_id: p.literature_asset_id,
      literature_id: p.literature_id,
      asset_id: a.asset_id,
      role: p.role,
      provenance_id: p.provenance.provenance_id,
      source_url: p.source_url,
    },
    "literature_asset_id",
  );
  if (!existed)
    intakeObjectsModule.recordIntakeObject(
      db,
      p.intake_batch_id,
      "literature-asset",
      p.literature_asset_id,
    );
}
function transaction(operation: Dynamic): Dynamic {
  if (metadataWrite) return operation();
  beginCatalogWrite(db);
  try {
    const value = operation();
    commitCatalogWrite(db);
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function refreshLibraryState(
  budget: Extract<SqliteCommand, { kind: "library_state_refresh" }>["budget"],
) {
  if (!budget) return transaction(() => libraryState.refreshBatch());
  const retry = { rebuilt: 0, repaired: 0, more: true };
  const shouldYield = () => performance.now() >= budget.deadline;
  // A writer outside the admission protocol may own SQLite's lock.
  db.exec("PRAGMA busy_timeout=0");
  try {
    return transaction(() => libraryState.refreshBatch(shouldYield));
  } catch (error) {
    if (
      error instanceof Error &&
      "errcode" in error &&
      typeof error.errcode === "number" &&
      (error.errcode & 0xff) === 5 // SQLITE_BUSY
    )
      return retry;
    throw error;
  } finally {
    db.exec(CATALOG_BUSY_TIMEOUT_SQL);
  }
}
function readTransaction(operation: Dynamic): Dynamic {
  if (metadataWrite) return operation();
  db.exec("BEGIN");
  try {
    queryCheckpoint();
    const value = operation();
    queryCheckpoint();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function requireCount(result: Dynamic, count: Dynamic): Dynamic {
  if (result.changes !== count) fail();
}
function putLiteratureAsset(p: Dynamic): Dynamic {
  return transaction(() => {
    writeLiteratureAsset(p);
    return true;
  });
}
function requireExecution(): Dynamic {
  const row = db
    .prepare(
      "SELECT version,fingerprint FROM execution_schema_identity WHERE singleton=1",
    )
    .get();
  if (
    !row ||
    row.version !== EXECUTION_SCHEMA_VERSION ||
    row.fingerprint !== EXECUTION_SCHEMA_FINGERPRINT
  )
    fail();
}
const executionTables = new Set(
  SCHEMA_MANIFEST.flatMap((sql) => {
    const name = /^CREATE TABLE (execution_[a-z0-9_]+)\(/u.exec(sql)?.[1];
    return name ? [name] : [];
  }),
);
function runtimeTables(connection: DatabaseSync = db): string[] {
  return connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => executionTables.has(name));
}
function requireRuntime(): Dynamic {
  const row = db
    .prepare(
      "SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1",
    )
    .get();
  if (
    !row ||
    row.version !== EXECUTION_RUNTIME_SCHEMA_VERSION ||
    row.fingerprint !== EXECUTION_RUNTIME_SCHEMA_FINGERPRINT
  )
    fail();
}
function runtimeInspect(): Dynamic {
  const catalog = db
    .prepare(
      "SELECT schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get();
  if (!catalog) fail();
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='execution_runtime_schema_identity'",
    )
    .get();
  const identity = row
    ? db
        .prepare(
          "SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1",
        )
        .get()
    : null;
  const names = runtimeTables();
  const counts: Record<string, number> = {};
  for (const name of names) {
    if (name === "execution_runtime_schema_identity") continue;
    counts[name] = Number(
      db.prepare("SELECT count(*) AS count FROM " + name).get().count,
    );
  }
  return {
    catalog_version: catalog.schema_version,
    catalog_fingerprint: catalog.schema_fingerprint,
    version: identity?.version ?? null,
    fingerprint: identity?.fingerprint ?? null,
    migrated:
      catalog.schema_version === SCHEMA_VERSION &&
      catalog.schema_fingerprint === SCHEMA_FINGERPRINT &&
      !!identity &&
      identity.version === EXECUTION_RUNTIME_SCHEMA_VERSION &&
      identity.fingerprint === EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
    tables: names,
    counts,
  };
}
function backupExecution(path: Dynamic): Dynamic {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path === workerData.path
  )
    fail();
  if (existsSync(path)) fail();
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (!integrity || integrity.integrity_check !== "ok") fail();
  db.prepare("VACUUM INTO ?").run(path);
  return { path, integrity: "ok" };
}
function restoreCheck(path: Dynamic): Dynamic {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path === workerData.path
  )
    fail();
  if (!existsSync(path)) fail();
  const candidate = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = candidate.prepare("PRAGMA integrity_check").get();
    if (!integrity || integrity.integrity_check !== "ok") fail();
    const schema = candidate
      .prepare(
        "SELECT schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
      )
      .get();
    if (
      !schema ||
      !(
        schema.schema_version === SCHEMA_VERSION &&
        schema.schema_fingerprint === SCHEMA_FINGERPRINT
      )
    )
      fail();
    const runtime = candidate
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='execution_runtime_schema_identity'",
      )
      .get();
    const identity = runtime
      ? candidate
          .prepare(
            "SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1",
          )
          .get()
      : null;
    if (!readCatalogIdentity(candidate, layoutModule.CURRENT_CATALOG_CONFIG))
      fail();
    const names = runtimeTables(candidate);
    const counts: Record<string, number> = {};
    for (const name of names) {
      if (name === "execution_runtime_schema_identity") continue;
      const count = candidate
        .prepare("SELECT count(*) AS count FROM " + name)
        .get();
      if (!count) fail();
      counts[name] = Number(count.count);
    }
    return {
      path,
      integrity: "ok",
      schema_version: schema.schema_version,
      schema_fingerprint: schema.schema_fingerprint,
      runtime: {
        catalog_version: schema.schema_version,
        catalog_fingerprint: schema.schema_fingerprint,
        version: identity?.version ?? null,
        fingerprint: identity?.fingerprint ?? null,
        migrated:
          schema.schema_version === SCHEMA_VERSION &&
          schema.schema_fingerprint === SCHEMA_FINGERPRINT &&
          !!identity &&
          identity.version === EXECUTION_RUNTIME_SCHEMA_VERSION &&
          identity.fingerprint === EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
        tables: names,
        counts,
      },
    };
  } finally {
    candidate.close();
  }
}
function createExecutionJob(
  job: Dynamic,
  policySha256: Dynamic,
  policyJson: Dynamic,
  targets: Dynamic = [],
  origin: Dynamic = null,
): Dynamic {
  requireRuntime();
  if (typeof policySha256 !== "string" || !/^[0-9a-f]{64}$/.test(policySha256))
    fail();
  return transaction(() => {
    const policy = JSON.stringify(policyJson);
    db.prepare(
      "INSERT INTO execution_policy_snapshots(policy_version,policy_sha256,policy_json,frozen_at) VALUES(?,?,?,?) ON CONFLICT(policy_version) DO NOTHING",
    ).run(job.policy_version, policySha256, policy, job.created_at);
    const existingPolicy = db
      .prepare(
        "SELECT policy_sha256,policy_json FROM execution_policy_snapshots WHERE policy_version=?",
      )
      .get(job.policy_version);
    if (
      !existingPolicy ||
      existingPolicy.policy_sha256 !== policySha256 ||
      existingPolicy.policy_json !== policy
    )
      fail();
    const selector = JSON.stringify(job.selector);
    db.prepare(
      "INSERT INTO execution_jobs(job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING",
    ).run(
      job.job_id,
      job.target_kind,
      selector,
      job.policy_version,
      job.status,
      job.idempotency_key,
      job.created_at,
      job.finished_at,
    );
    const row = db
      .prepare(
        "SELECT job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at,finished_at FROM execution_jobs WHERE idempotency_key=?",
      )
      .get(job.idempotency_key);
    if (
      !row ||
      row.target_kind !== job.target_kind ||
      row.selector_json !== selector ||
      row.policy_version !== job.policy_version
    )
      fail();
    db.prepare(
      "INSERT INTO execution_budgets(job_id,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at) VALUES(?,?,?,?,0,0,0,?) ON CONFLICT(job_id) DO NOTHING",
    ).run(
      row.job_id,
      policyJson.max_attempts,
      policyJson.max_network_bytes,
      policyJson.max_model_calls,
      job.created_at,
    );
    const budget = db
      .prepare(
        "SELECT max_attempts,max_network_bytes,max_model_calls FROM execution_budgets WHERE job_id=?",
      )
      .get(row.job_id);
    if (
      !budget ||
      budget.max_attempts !== policyJson.max_attempts ||
      budget.max_network_bytes !== policyJson.max_network_bytes ||
      budget.max_model_calls !== policyJson.max_model_calls
    )
      fail();
    for (const target of targets) {
      if (
        target.literature_id &&
        visibilityModule.literatureWithdrawn(db, target.literature_id)
      )
        fail();
      if (!target || target.job_id !== row.job_id) fail();
      db.prepare(
        "INSERT INTO execution_targets(target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(target_id) DO NOTHING",
      ).run(
        target.target_id,
        target.job_id,
        target.ordinal,
        target.literature_id,
        target.version_role,
        target.stage,
        target.disposition,
        target.next_eligible_at,
      );
      const persisted = db
        .prepare(
          "SELECT job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at FROM execution_targets WHERE target_id=?",
        )
        .get(target.target_id);
      if (
        !persisted ||
        persisted.job_id !== row.job_id ||
        persisted.ordinal !== target.ordinal ||
        persisted.literature_id !== target.literature_id ||
        persisted.version_role !== target.version_role ||
        persisted.stage !== target.stage ||
        persisted.disposition !== target.disposition ||
        persisted.next_eligible_at !== target.next_eligible_at
      )
        fail();
    }
    if (origin)
      reviewModule.runReviewStorage(db, "job-origin-put", {
        job_id: row.job_id,
        actor: origin.actor,
        operation: origin.operation,
        created_at: job.created_at,
      });
    return {
      job_id: row.job_id,
      target_kind: row.target_kind,
      selector: JSON.parse(row.selector_json),
      policy_version: row.policy_version,
      status: row.status,
      idempotency_key: row.idempotency_key,
      created_at: row.created_at,
      finished_at: row.finished_at,
    };
  });
}
function getExecutionJob(jobId: Dynamic): Dynamic {
  requireRuntime();
  const row = db
    .prepare(
      "SELECT job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at,finished_at FROM execution_jobs WHERE job_id=?",
    )
    .get(jobId);
  if (!row) return null;
  return {
    job_id: row.job_id,
    target_kind: row.target_kind,
    selector: JSON.parse(row.selector_json),
    policy_version: row.policy_version,
    status: row.status,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}
function listExecutionJobs(
  limit: Dynamic,
  order: Dynamic,
  before: Dynamic,
  statuses: Dynamic,
): Dynamic {
  requireRuntime();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail();
  if (order !== "oldest" && order !== "newest" && order !== "finished") fail();
  if (
    before !== null &&
    (order === "oldest" ||
      !before ||
      typeof before.timestamp !== "string" ||
      !before.timestamp ||
      before.timestamp.length > 64 ||
      typeof before.job_id !== "string" ||
      !before.job_id ||
      before.job_id.length > 256)
  )
    fail();
  if (
    !Array.isArray(statuses) ||
    statuses.length > 7 ||
    statuses.some(
      (status: Dynamic) =>
        ![
          "queued",
          "running",
          "paused",
          "interrupted",
          "completed",
          "cancelled",
          "failed",
        ].includes(status),
    )
  )
    fail();
  const timeColumn =
    order === "finished" ? "COALESCE(finished_at,created_at)" : "created_at";
  const filters: string[] = [];
  const args: Dynamic[] = [];
  if (before !== null) {
    filters.push(`(${timeColumn} < ? OR (${timeColumn} = ? AND job_id < ?))`);
    args.push(before.timestamp, before.timestamp, before.job_id);
  }
  if (statuses.length) {
    filters.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  const sort =
    order === "oldest" ? "created_at,job_id" : `${timeColumn} DESC,job_id DESC`;
  // Aggregate only this page's unique target rows through the existing job_id
  // index. Keep wide job/selector rows out of GROUP BY and attempts out entirely.
  const rows = db
    .prepare(
      `WITH selected_jobs AS MATERIALIZED (
        SELECT job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at,finished_at FROM execution_jobs${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY ${sort} LIMIT ?
      ), progress AS (
        SELECT job_id, count(*) AS total,
          count(CASE WHEN disposition IN ('completed','failed','skipped') THEN 1 END) AS done
        FROM execution_targets
        WHERE job_id IN (SELECT job_id FROM selected_jobs) AND (literature_id IS NULL OR ${visibilityModule.visibleLiteratureSql("literature_id")})
        GROUP BY job_id
      ), requested_starts AS (
        SELECT job_id, 1 AS requested
        FROM execution_events
        WHERE job_id IN (SELECT job_id FROM selected_jobs) AND kind='task-start-requested'
        GROUP BY job_id
      )
      SELECT job.*, COALESCE(progress.total,0) AS progress_total,
        COALESCE(progress.done,0) AS progress_done,
        COALESCE(requested_starts.requested,0) AS start_requested
      FROM selected_jobs job
      LEFT JOIN progress ON progress.job_id=job.job_id
      LEFT JOIN requested_starts ON requested_starts.job_id=job.job_id
      ORDER BY ${sort.replaceAll("job_id", "job.job_id")}`,
    )
    .all(...args, limit);
  return rows.map((row: Dynamic) => ({
    job_id: row.job_id,
    target_kind: row.target_kind,
    selector: JSON.parse(row.selector_json),
    policy_version: row.policy_version,
    status: row.status,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    finished_at: row.finished_at,
    progress: { total: row.progress_total, done: row.progress_done },
    start_requested: Boolean(row.start_requested),
  }));
}
function requestExecutionStart(
  jobId: Dynamic,
  eventId: Dynamic,
  actor: Dynamic,
  now: Dynamic,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const job = getExecutionJob(jobId);
    if (job && ["queued", "running"].includes(job.status))
      insertExecutionEvent({
        event_id: eventId,
        job_id: jobId,
        sequence: -1,
        kind: "task-start-requested",
        payload: { actor },
        created_at: now,
      });
    return job;
  });
}
function listRequestedExecutionJobs(): Dynamic {
  requireRuntime();
  return db
    .prepare(
      `SELECT job.job_id FROM execution_jobs job
       JOIN execution_events event ON event.job_id=job.job_id AND event.kind='task-start-requested'
       WHERE job.status='queued' AND NOT EXISTS (
         SELECT 1 FROM execution_targets target
         JOIN execution_attempts attempt ON attempt.target_id=target.target_id
         WHERE target.job_id=job.job_id
       )
       GROUP BY job.job_id ORDER BY MIN(event.rowid)`,
    )
    .all()
    .map((row: Dynamic) => row.job_id);
}
function getExecutionPolicy(jobId: Dynamic): Dynamic {
  requireRuntime();
  const row = db
    .prepare(
      "SELECT p.policy_json FROM execution_jobs j JOIN execution_policy_snapshots p ON p.policy_version=j.policy_version WHERE j.job_id=?",
    )
    .get(jobId);
  return row ? JSON.parse(row.policy_json) : null;
}
function executionBudget(row: Dynamic): Dynamic {
  return row
    ? {
        job_id: row.job_id,
        max_attempts: row.max_attempts,
        max_network_bytes: row.max_network_bytes,
        max_model_calls: row.max_model_calls,
        attempts: row.used_attempts,
        network_bytes: row.used_network_bytes,
        model_calls: row.used_model_calls,
        updated_at: row.updated_at,
      }
    : null;
}
function getExecutionBudget(jobId: Dynamic): Dynamic {
  requireRuntime();
  return executionBudget(
    db
      .prepare(
        "SELECT job_id,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at FROM execution_budgets WHERE job_id=?",
      )
      .get(jobId),
  );
}
function consumeExecutionBudget(
  jobId: Dynamic,
  usage: Dynamic,
  now: Dynamic,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const current = db
      .prepare(
        "SELECT job_id,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at FROM execution_budgets WHERE job_id=?",
      )
      .get(jobId);
    if (!current) fail();
    const nextAttempts = current.used_attempts + usage.attempts,
      nextBytes = current.used_network_bytes + usage.network_bytes,
      nextModels = current.used_model_calls + usage.model_calls;
    const accepted =
      nextAttempts <= current.max_attempts &&
      nextBytes <= current.max_network_bytes &&
      nextModels <= current.max_model_calls;
    if (accepted)
      db.prepare(
        "UPDATE execution_budgets SET used_attempts=?,used_network_bytes=?,used_model_calls=?,updated_at=? WHERE job_id=?",
      ).run(nextAttempts, nextBytes, nextModels, now, jobId);
    return { accepted, budget: getExecutionBudget(jobId) };
  });
}
function listExecutionTargets(
  jobId: Dynamic,
  limit: Dynamic,
  visibleOnly = false,
): Dynamic {
  requireRuntime();
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > Number.MAX_SAFE_INTEGER
  )
    fail();
  return db
    .prepare(
      `SELECT target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at FROM execution_targets WHERE job_id=? ${visibleOnly ? "AND (literature_id IS NULL OR " + visibilityModule.visibleLiteratureSql("literature_id") + ")" : ""} ORDER BY ordinal,target_id LIMIT ?`,
    )
    .all(jobId, limit)
    .map((row: Dynamic) => ({
      target_id: row.target_id,
      job_id: row.job_id,
      ordinal: row.ordinal,
      literature_id: row.literature_id,
      version_role: row.version_role,
      stage: row.stage,
      disposition: row.disposition,
      next_eligible_at: row.next_eligible_at,
    }));
}
function listExecutionAttempts(targetId: Dynamic, limit: Dynamic): Dynamic {
  requireRuntime();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail();
  return db
    .prepare(
      "SELECT attempt_id,target_id,stage,status,started_at,finished_at,failure_code,failure_reason,failure_action,failure_retryable,usage_json FROM execution_attempts WHERE target_id=? ORDER BY started_at,attempt_id LIMIT ?",
    )
    .all(targetId, limit)
    .map((row: Dynamic) => ({
      attempt_id: row.attempt_id,
      target_id: row.target_id,
      stage: row.stage,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      failure:
        row.failure_code === null
          ? null
          : {
              code: row.failure_code,
              reason: row.failure_reason,
              action: row.failure_action,
              retryable: Boolean(row.failure_retryable),
            },
      usage: row.usage_json === null ? null : JSON.parse(row.usage_json),
    }));
}
const citationCheckpointsSql =
  "SELECT sequence,payload_json FROM execution_events INDEXED BY task_event_target WHERE job_id=? AND kind='citation-write-checkpoint' AND json_extract(payload_json,'$.target_id')=?";

function recoverExecution(bootId: Dynamic, now: Dynamic): Dynamic {
  requireRuntime();
  if (
    typeof bootId !== "string" ||
    !bootId.trim() ||
    typeof now !== "string" ||
    !now.trim()
  )
    fail();
  return transaction(() => {
    const running = db
      .prepare(
        `SELECT a.attempt_id,a.target_id,t.job_id
         FROM execution_attempts a JOIN execution_targets t USING(target_id)
         WHERE a.status='running'`,
      )
      .all();
    const latestCitation = db.prepare(
      citationCheckpointsSql + " ORDER BY sequence DESC LIMIT 1",
    );
    const stopRun = db.prepare(
      `UPDATE discovery_runs SET status='INTERRUPTED'
       WHERE discovery_run_id=? AND kind='citation' AND status='RUNNING'
       AND EXISTS(SELECT 1 FROM intake_batches b WHERE b.batch_id=?
          AND b.discovery_run_id=discovery_runs.discovery_run_id
          AND b.kind='citation' AND b.state='running')`,
    );
    const stopBatch = db.prepare(
      `UPDATE intake_batches SET state='finished',result='interrupted',
          finished_at=?,owner_pid=NULL
       WHERE batch_id=? AND discovery_run_id=? AND kind='citation' AND state='running'`,
    );
    for (const attempt of running) {
      // The runtime lease excludes a live runner. Match the batch to this
      // attempt's durable checkpoint rather than a potentially recycled PID.
      const tail = latestCitation.get(attempt.job_id, attempt.target_id);
      if (typeof tail?.payload_json === "string") {
        const { run_id, batch_id } = JSON.parse(tail.payload_json);
        if (
          typeof run_id === "string" &&
          typeof batch_id === "string" &&
          stopRun.run(run_id, batch_id).changes === 1
        )
          stopBatch.run(now, batch_id, run_id);
      }
      db.prepare(
        "UPDATE execution_attempts SET status='unknown',finished_at=?,failure_code='execution-outcome-unknown',failure_reason='The process stopped before the attempt outcome was durable.',failure_action='Reconcile current facts and retry only when safe.',failure_retryable=1 WHERE attempt_id=? AND status='running'",
      ).run(now, attempt.attempt_id);
      db.prepare(
        "UPDATE execution_targets SET stage='interrupted',disposition='interrupted',next_eligible_at=? WHERE target_id=? AND stage NOT IN ('completed','skipped','failed')",
      ).run(now, attempt.target_id);
    }
    const jobs = db
      .prepare("SELECT job_id FROM execution_jobs WHERE status='running'")
      .all();
    for (const job of jobs)
      db.prepare(
        "UPDATE execution_jobs SET status='interrupted',finished_at=? WHERE job_id=? AND status='running'",
      ).run(now, job.job_id);
    const releasedLeases = db
      .prepare(
        "UPDATE execution_leases SET released_at=? WHERE released_at IS NULL",
      )
      .run(now).changes;
    const expiredInterventions = db
      .prepare(
        "UPDATE execution_interventions SET status='expired',resolved_at=?,resolution_json=? WHERE status='open' AND expires_at<=?",
      )
      .run(now, JSON.stringify({ kind: "timeout" }), now).changes;
    return {
      boot_id: bootId,
      recovered_attempts: running.length,
      recovered_targets: running.length,
      recovered_jobs: jobs.length,
      released_leases: releasedLeases,
      expired_interventions: expiredInterventions,
    };
  });
}
function updateExecutionJob(
  jobId: Dynamic,
  status: Dynamic,
  finishedAt: Dynamic,
  onlyIfActive: Dynamic = false,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const result = db
      .prepare(
        "UPDATE execution_jobs SET status=?,finished_at=? WHERE job_id=? AND (?=0 OR status IN ('queued','running'))",
      )
      .run(status, finishedAt, jobId, onlyIfActive ? 1 : 0);
    if (result.changes !== 1 && !onlyIfActive) fail();
    const job = getExecutionJob(jobId);
    if (!job) fail();
    return job;
  });
}
function controlExecutionJob(
  jobId: Dynamic,
  status: Dynamic,
  finishedAt: Dynamic,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    if (status !== "paused" && status !== "cancelled") fail();
    const result = db
      .prepare(
        "UPDATE execution_jobs SET status=?,finished_at=? WHERE job_id=? AND ((?='paused' AND status IN ('queued','running')) OR (?='cancelled' AND status IN ('queued','running','paused','interrupted')))",
      )
      .run(status, finishedAt, jobId, status, status);
    const job = getExecutionJob(jobId);
    if (!job) fail();
    return { job, changed: result.changes === 1 };
  });
}
function putExecutionTarget(target: Dynamic): Dynamic {
  requireRuntime();
  return transaction(() => {
    if (
      !db
        .prepare("SELECT 1 FROM execution_jobs WHERE job_id=?")
        .get(target.job_id)
    )
      fail();
    db.prepare(
      "INSERT INTO execution_targets(target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(target_id) DO NOTHING",
    ).run(
      target.target_id,
      target.job_id,
      target.ordinal,
      target.literature_id,
      target.version_role,
      target.stage,
      target.disposition,
      target.next_eligible_at,
    );
    const row = db
      .prepare(
        "SELECT target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at FROM execution_targets WHERE target_id=?",
      )
      .get(target.target_id);
    if (!row || row.job_id !== target.job_id || row.ordinal !== target.ordinal)
      fail();
    return {
      target_id: row.target_id,
      job_id: row.job_id,
      ordinal: row.ordinal,
      literature_id: row.literature_id,
      version_role: row.version_role,
      stage: row.stage,
      disposition: row.disposition,
      next_eligible_at: row.next_eligible_at,
    };
  });
}
function getExecutionTarget(targetId: Dynamic): Dynamic {
  requireRuntime();
  const row = db
    .prepare(
      "SELECT target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at FROM execution_targets WHERE target_id=?",
    )
    .get(targetId);
  if (!row) return null;
  return {
    target_id: row.target_id,
    job_id: row.job_id,
    ordinal: row.ordinal,
    literature_id: row.literature_id,
    version_role: row.version_role,
    stage: row.stage,
    disposition: row.disposition,
    next_eligible_at: row.next_eligible_at,
  };
}
function claimExecutionTarget(
  jobId: Dynamic,
  now: Dynamic,
  targetId: Dynamic = null,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const row = db
      .prepare(
        "SELECT target.target_id,target.job_id,target.ordinal,target.literature_id,target.version_role,target.stage,target.disposition,target.next_eligible_at FROM execution_targets target JOIN execution_jobs job ON job.job_id=target.job_id WHERE target.job_id=? AND job.status IN ('queued','running') AND target.stage='queued' AND (target.next_eligible_at IS NULL OR target.next_eligible_at<=?) AND (? IS NULL OR target.target_id=?) ORDER BY target.ordinal,target.target_id LIMIT 1",
      )
      .get(jobId, now, targetId, targetId);
    if (!row) return null;
    db.prepare(
      "UPDATE execution_jobs SET status='running' WHERE job_id=? AND status='queued'",
    ).run(jobId);
    db.prepare(
      "UPDATE execution_targets SET stage='acquisition',disposition='pending' WHERE target_id=?",
    ).run(row.target_id);
    return getExecutionTarget(row.target_id);
  });
}
function updateExecutionTarget(
  targetId: Dynamic,
  stage: Dynamic,
  disposition: Dynamic,
  nextEligibleAt: Dynamic,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const result = db
      .prepare(
        "UPDATE execution_targets SET stage=?,disposition=?,next_eligible_at=? WHERE target_id=?",
      )
      .run(stage, disposition, nextEligibleAt, targetId);
    if (result.changes !== 1) fail();
    return getExecutionTarget(targetId);
  });
}
function startExecutionAttempt(attempt: Dynamic): Dynamic {
  requireRuntime();
  return transaction(() => {
    if (
      !db
        .prepare("SELECT 1 FROM execution_targets WHERE target_id=?")
        .get(attempt.target_id)
    )
      fail();
    db.prepare(
      "INSERT INTO execution_attempts(attempt_id,target_id,stage,status,started_at,finished_at,failure_code,failure_reason,failure_action,failure_retryable,usage_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING",
    ).run(
      attempt.attempt_id,
      attempt.target_id,
      attempt.stage,
      attempt.status,
      attempt.started_at,
      attempt.finished_at,
      attempt.failure?.code ?? null,
      attempt.failure?.reason ?? null,
      attempt.failure?.action ?? null,
      attempt.failure === null ? null : Number(attempt.failure.retryable),
      attempt.usage === null ? null : JSON.stringify(attempt.usage),
    );
    const row = db
      .prepare(
        "SELECT attempt_id,target_id,stage,status,started_at,finished_at,failure_code,failure_reason,failure_action,failure_retryable,usage_json FROM execution_attempts WHERE attempt_id=?",
      )
      .get(attempt.attempt_id);
    if (!row) fail();
    return {
      attempt_id: row.attempt_id,
      target_id: row.target_id,
      stage: row.stage,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      failure:
        row.failure_code === null
          ? null
          : {
              code: row.failure_code,
              reason: row.failure_reason,
              action: row.failure_action,
              retryable: Boolean(row.failure_retryable),
            },
      usage: row.usage_json === null ? null : JSON.parse(row.usage_json),
    };
  });
}
function finishExecutionAttempt(
  attemptId: Dynamic,
  status: Dynamic,
  finishedAt: Dynamic,
  failure: Dynamic,
  usage: Dynamic,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const result = db
      .prepare(
        "UPDATE execution_attempts SET status=?,finished_at=?,failure_code=?,failure_reason=?,failure_action=?,failure_retryable=?,usage_json=? WHERE attempt_id=?",
      )
      .run(
        status,
        finishedAt,
        failure?.code ?? null,
        failure?.reason ?? null,
        failure?.action ?? null,
        failure === null ? null : Number(failure.retryable),
        usage === null ? null : JSON.stringify(usage),
        attemptId,
      );
    if (result.changes !== 1) fail();
    const row = db
      .prepare(
        "SELECT attempt_id,target_id,stage,status,started_at,finished_at,failure_code,failure_reason,failure_action,failure_retryable,usage_json FROM execution_attempts WHERE attempt_id=?",
      )
      .get(attemptId);
    return {
      attempt_id: row.attempt_id,
      target_id: row.target_id,
      stage: row.stage,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      failure:
        row.failure_code === null
          ? null
          : {
              code: row.failure_code,
              reason: row.failure_reason,
              action: row.failure_action,
              retryable: Boolean(row.failure_retryable),
            },
      usage: row.usage_json === null ? null : JSON.parse(row.usage_json),
    };
  });
}
function appendExecutionEvent(event: Dynamic): Dynamic {
  requireRuntime();
  return transaction(() => {
    const sequence = insertExecutionEvent(event);
    return { ...event, sequence };
  });
}
function insertExecutionEvent(event: Dynamic): number {
  let expected = metadataWrite?.nextSequence.get(event.job_id);
  if (expected === undefined) {
    if (
      !db
        .prepare("SELECT 1 FROM execution_jobs WHERE job_id=?")
        .get(event.job_id)
    )
      fail();
    const last = db
      .prepare(
        "SELECT max(sequence) AS sequence FROM execution_events WHERE job_id=?",
      )
      .get(event.job_id);
    expected = last.sequence === null ? 0 : Number(last.sequence) + 1;
  }
  const sequence = event.sequence === -1 ? expected : event.sequence;
  if (sequence !== expected) fail();
  db.prepare(
    "INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    event.event_id,
    event.job_id,
    sequence,
    event.kind,
    JSON.stringify(event.payload),
    event.created_at,
  );
  metadataWrite?.nextSequence.set(event.job_id, expected + 1);
  return sequence;
}
function listExecutionEvents(
  jobId: Dynamic,
  after: Dynamic,
  limit: Dynamic,
  order: Dynamic,
  acquisitionOnly: Dynamic = false,
): Dynamic {
  requireRuntime();
  if (
    !Number.isSafeInteger(after) ||
    after < -1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    fail();
  if (
    (order !== "oldest" && order !== "newest") ||
    typeof acquisitionOnly !== "boolean"
  )
    fail();
  const filter = acquisitionOnly
    ? " AND kind='acquisition-attempt'"
    : " AND kind<>'citation-write-checkpoint'";
  return db
    .prepare(
      order === "newest"
        ? `SELECT event_id,job_id,sequence,kind,payload_json,created_at FROM execution_events WHERE job_id=? AND sequence>?${filter} ORDER BY sequence DESC LIMIT ?`
        : `SELECT event_id,job_id,sequence,kind,payload_json,created_at FROM execution_events WHERE job_id=? AND sequence>?${filter} ORDER BY sequence LIMIT ?`,
    )
    .all(jobId, after, limit)
    .map((row: Dynamic) => ({
      event_id: row.event_id,
      job_id: row.job_id,
      sequence: row.sequence,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      created_at: row.created_at,
    }));
}
function executionIntervention(row: Dynamic): Dynamic {
  return {
    intervention_id: row.intervention_id,
    job_id: row.job_id,
    target_id: row.target_id,
    mode: row.mode,
    status: row.status,
    failure: JSON.parse(row.failure_json),
    created_at: row.created_at,
    expires_at: row.expires_at,
    resolved_at: row.resolved_at,
    resolution:
      row.resolution_json === null ? null : JSON.parse(row.resolution_json),
  };
}
function putExecutionIntervention(
  value: Dynamic,
  onlyIfActive: Dynamic = false,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const job = db
      .prepare("SELECT status FROM execution_jobs WHERE job_id=?")
      .get(value.job_id);
    if (!job) fail();
    if (onlyIfActive && !["queued", "running"].includes(job.status))
      return null;
    if (
      value.target_id !== null &&
      !db
        .prepare(
          "SELECT 1 FROM execution_targets WHERE target_id=? AND job_id=?",
        )
        .get(value.target_id, value.job_id)
    )
      fail();
    const failure = JSON.stringify(value.failure),
      resolution =
        value.resolution === null ? null : JSON.stringify(value.resolution);
    db.prepare(
      "INSERT INTO execution_interventions(intervention_id,job_id,target_id,mode,status,failure_json,created_at,expires_at,resolved_at,resolution_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      value.intervention_id,
      value.job_id,
      value.target_id,
      value.mode,
      value.status,
      failure,
      value.created_at,
      value.expires_at,
      value.resolved_at,
      resolution,
    );
    if (value.mode === "pause" && value.status === "open")
      db.prepare(
        "UPDATE execution_jobs SET status='paused' WHERE job_id=? AND status IN ('queued','running')",
      ).run(value.job_id);
    return executionIntervention(
      db
        .prepare(
          "SELECT intervention_id,job_id,target_id,mode,status,failure_json,created_at,expires_at,resolved_at,resolution_json FROM execution_interventions WHERE intervention_id=?",
        )
        .get(value.intervention_id),
    );
  });
}
function listExecutionInterventions(jobId: Dynamic, limit: Dynamic): Dynamic {
  requireRuntime();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail();
  return db
    .prepare(
      "SELECT intervention_id,job_id,target_id,mode,status,failure_json,created_at,expires_at,resolved_at,resolution_json FROM execution_interventions WHERE job_id=? ORDER BY created_at,intervention_id LIMIT ?",
    )
    .all(jobId, limit)
    .map(executionIntervention);
}
function resolveExecutionIntervention(
  interventionId: Dynamic,
  status: Dynamic,
  resolvedAt: Dynamic,
  resolution: Dynamic,
): Dynamic {
  requireRuntime();
  return transaction(() => {
    const encoded = JSON.stringify(resolution);
    const result = db
      .prepare(
        "UPDATE execution_interventions SET status=?,resolved_at=?,resolution_json=? WHERE intervention_id=? AND status='open'",
      )
      .run(status, resolvedAt, encoded, interventionId);
    if (result.changes !== 1) fail();
    return executionIntervention(
      db
        .prepare(
          "SELECT intervention_id,job_id,target_id,mode,status,failure_json,created_at,expires_at,resolved_at,resolution_json FROM execution_interventions WHERE intervention_id=?",
        )
        .get(interventionId),
    );
  });
}
function acquireExecutionLease(lease: Dynamic): Dynamic {
  requireRuntime();
  return transaction(() => {
    if (
      db
        .prepare(
          "SELECT 1 FROM execution_leases WHERE job_id=? AND released_at IS NULL",
        )
        .get(lease.job_id)
    )
      fail();
    db.prepare(
      "INSERT INTO execution_leases(lease_id,job_id,workspace_id,boot_id,control_epoch,acquired_at,released_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      lease.lease_id,
      lease.job_id,
      lease.workspace_id,
      lease.boot_id,
      lease.control_epoch,
      lease.acquired_at,
      lease.released_at,
    );
    return lease;
  });
}
function releaseExecutionLease(leaseId: Dynamic, releasedAt: Dynamic): Dynamic {
  requireRuntime();
  return transaction(() => {
    const result = db
      .prepare(
        "UPDATE execution_leases SET released_at=? WHERE lease_id=? AND released_at IS NULL",
      )
      .run(releasedAt, leaseId);
    if (result.changes !== 1) fail();
    return true;
  });
}
function putCandidate(candidate: Dynamic): Dynamic {
  requireExecution();
  insertExact(
    "execution_candidates",
    {
      transfer_id: candidate.transfer_id,
      record_json: JSON.stringify(candidate),
    },
    "transfer_id",
  );
  return true;
}
function retireCandidate(candidate: Dynamic): Dynamic {
  requireExecution();
  return transaction(() => {
    const current = getCandidate(candidate.transfer_id);
    if (!current || JSON.stringify(current) !== JSON.stringify(candidate))
      return null;
    if (
      db
        .prepare("SELECT 1 FROM execution_receipts WHERE transfer_id=? LIMIT 1")
        .get(candidate.transfer_id)
    )
      return null;
    requireCount(
      db
        .prepare("DELETE FROM execution_candidates WHERE transfer_id=?")
        .run(candidate.transfer_id),
      1,
    );
    return current;
  });
}
function getCandidate(transferId: Dynamic): Dynamic {
  requireExecution();
  const row = db
    .prepare("SELECT record_json FROM execution_candidates WHERE transfer_id=?")
    .get(transferId);
  return row ? JSON.parse(row.record_json) : null;
}
function getReceiptIntent(receiptId: Dynamic): Dynamic {
  requireExecution();
  const row = db
    .prepare("SELECT intent_json FROM execution_receipts WHERE receipt_id=?")
    .get(receiptId);
  return row ? JSON.parse(row.intent_json) : null;
}
function getReceiptResult(receiptId: Dynamic): Dynamic {
  requireExecution();
  const row = db
    .prepare("SELECT result_json FROM execution_receipts WHERE receipt_id=?")
    .get(receiptId);
  return row?.result_json ? JSON.parse(row.result_json) : null;
}
function listCandidates(articleId: Dynamic): Dynamic {
  requireExecution();
  return db
    .prepare(
      "SELECT record_json FROM execution_candidates WHERE json_extract(record_json,'$.capture.article_id')=? ORDER BY transfer_id LIMIT 100",
    )
    .all(articleId)
    .map((row: Dynamic) => JSON.parse(row.record_json));
}
function requireMetadataSnapshot(intent: Dynamic): Dynamic {
  const row = db
    .prepare(
      "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
    )
    .get(intent.literature_id);
  if (
    !row ||
    row.metadata_revision !== intent.metadata_snapshot.revision ||
    row.metadata_sha256 !== intent.metadata_snapshot.sha256
  )
    fail();
}
function prepareReceipt(intent: Dynamic): Dynamic {
  requireExecution();
  return transaction(() => {
    const candidate = getCandidate(intent.candidate.transfer_id);
    if (
      !candidate ||
      JSON.stringify(candidate) !== JSON.stringify(intent.candidate)
    )
      fail();
    if (
      !db
        .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
        .get(intent.literature_id)
    )
      fail();
    const record = JSON.stringify(intent);
    db.prepare(
      "INSERT INTO execution_receipts(receipt_id,transfer_id,intent_json) VALUES(?,?,?) ON CONFLICT(receipt_id) DO NOTHING",
    ).run(intent.receipt_id, intent.candidate.transfer_id, record);
    const row = db
      .prepare(
        "SELECT intent_json,result_json FROM execution_receipts WHERE receipt_id=?",
      )
      .get(intent.receipt_id);
    if (row.intent_json !== record) fail();
    if (!row.result_json) requireMetadataSnapshot(intent);
    return row.result_json ? JSON.parse(row.result_json) : null;
  });
}
function commitReceipt(intent: Dynamic, created: Dynamic): Dynamic {
  requireExecution();
  return transaction(() => {
    const row = db
      .prepare(
        "SELECT intent_json,result_json FROM execution_receipts WHERE receipt_id=?",
      )
      .get(intent.receipt_id);
    if (!row || row.intent_json !== JSON.stringify(intent)) fail();
    if (row.result_json) return JSON.parse(row.result_json);
    requireMetadataSnapshot(intent);
    const c = intent.candidate;
    const existing = db
      .prepare(
        "SELECT a.asset_id,a.sha256,a.size_bytes,a.relative_path FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'",
      )
      .get(intent.literature_id);
    if (existing) {
      if (
        existing.asset_id !== intent.asset_id ||
        existing.sha256 !== c.sha256 ||
        existing.size_bytes !== c.size_bytes ||
        existing.relative_path !== intent.target
      )
        fail();
      insertExact("provenances", intent.provenance, "provenance_id");
    } else
      writeLiteratureAsset({
        ...(intent.intake_batch_id
          ? { intake_batch_id: intent.intake_batch_id }
          : {}),
        literature_asset_id: intent.literature_asset_id,
        literature_id: intent.literature_id,
        asset: {
          asset_id: intent.asset_id,
          sha256: c.sha256,
          size_bytes: c.size_bytes,
          media_type: "application/pdf",
          path: intent.target,
        },
        role: "primary-pdf",
        provenance: intent.provenance,
        source_url: intent.source_url,
      });
    db.prepare(
      "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
    ).run(intent.literature_id);
    const result = {
      receipt_id: intent.receipt_id,
      literature_id: intent.literature_id,
      asset_id: intent.asset_id,
      sha256: c.sha256,
      reference: intent.target,
      created,
    };
    db.prepare(
      "UPDATE execution_receipts SET result_json=? WHERE receipt_id=?",
    ).run(JSON.stringify(result), intent.receipt_id);
    return result;
  });
}
function pendingReceipts(): Dynamic {
  requireExecution();
  return db
    .prepare(
      "SELECT intent_json FROM execution_receipts WHERE result_json IS NULL ORDER BY receipt_id",
    )
    .all()
    .map((row: Dynamic) => JSON.parse(row.intent_json));
}
function requireDocumentV3(): void {
  const row = db
    .prepare(
      "SELECT schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get();
  if (
    !(
      row?.schema_version === SCHEMA_VERSION &&
      row.schema_fingerprint === SCHEMA_FINGERPRINT
    ) ||
    !validDocumentSchema(row.schema_version)
  )
    fail();
}
function articleIdentityCurrent(
  literatureId: Dynamic,
  assetId: Dynamic,
): Dynamic {
  if (
    ![SCHEMA_VERSION].includes(
      Number(
        db
          .prepare(
            "SELECT schema_version FROM schema_identity WHERE singleton=1",
          )
          .get()?.schema_version,
      ),
    )
  )
    return null;
  const row = db
    .prepare(
      "SELECT i.assessment_json FROM article_identity_assessments i JOIN literature_metadata m ON m.literature_id=i.literature_id AND m.metadata_revision=i.metadata_revision AND m.metadata_sha256=i.metadata_sha256 JOIN literature_assets a ON a.literature_id=i.literature_id AND a.asset_id=i.asset_id JOIN document_versions d ON d.document_version_id=i.document_version_id JOIN document_defaults current ON current.document_version_id=d.document_version_id AND d.source_sha256=i.asset_sha256 WHERE i.literature_id=? AND i.asset_id=? ORDER BY i.created_at DESC,i.assessment_id DESC LIMIT 1",
    )
    .get(literatureId, assetId);
  return row ? JSON.parse(row.assessment_json) : null;
}
function articleIdentityGet(id: Dynamic): Dynamic {
  if (
    ![SCHEMA_VERSION].includes(
      Number(
        db
          .prepare(
            "SELECT schema_version FROM schema_identity WHERE singleton=1",
          )
          .get()?.schema_version,
      ),
    )
  )
    return null;
  const row = db
    .prepare(
      "SELECT assessment_json FROM article_identity_assessments WHERE assessment_id=?",
    )
    .get(id);
  return row ? JSON.parse(row.assessment_json) : null;
}
function articleIdentityPut(a: Dynamic): Dynamic {
  if (
    ![SCHEMA_VERSION].includes(
      Number(
        db
          .prepare(
            "SELECT schema_version FROM schema_identity WHERE singleton=1",
          )
          .get()?.schema_version,
      ),
    )
  )
    fail();
  return transaction(() => {
    const existing = articleIdentityGet(a.assessment_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(a)) fail();
      return false;
    }
    const input = db
      .prepare(
        "SELECT 1 FROM document_versions d JOIN literature_metadata m ON m.literature_id=d.literature_id JOIN literature_assets l ON l.literature_id=d.literature_id AND l.asset_id=d.source_asset_id WHERE d.document_version_id=? AND d.representation_sha256=? AND d.literature_id=? AND d.source_asset_id=? AND d.source_sha256=? AND m.metadata_revision=? AND m.metadata_sha256=?",
      )
      .get(
        a.document_version_id,
        a.representation_sha256,
        a.literature_id,
        a.asset_id,
        a.asset_sha256,
        a.metadata_revision,
        a.metadata_sha256,
      );
    if (!input) fail();
    db.prepare(
      "INSERT INTO article_identity_assessments(assessment_id,literature_id,asset_id,asset_sha256,document_version_id,representation_sha256,metadata_revision,metadata_sha256,status,assessment_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      a.assessment_id,
      a.literature_id,
      a.asset_id,
      a.asset_sha256,
      a.document_version_id,
      a.representation_sha256,
      a.metadata_revision,
      a.metadata_sha256,
      a.status,
      JSON.stringify(a),
      a.provenance.observed_at,
    );
    return true;
  });
}
function documentMaterial(literatureId: Dynamic, assetId: Dynamic): Dynamic {
  return readTransaction(() => {
    if (visibilityModule.literatureWithdrawn(db, literatureId)) return null;
    const source = db
      .prepare(
        "SELECT a.sha256,a.size_bytes,a.media_type,a.relative_path FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.asset_id=? AND l.role IN ('primary-pdf','supplementary-pdf')",
      )
      .get(literatureId, assetId);
    if (!source || source.media_type !== "application/pdf") return null;
    const object = db
      .prepare(
        "SELECT 1 FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?",
      )
      .get(
        source.relative_path,
        source.sha256,
        source.size_bytes,
        source.media_type,
      );
    if (!object) fail();
    return {
      material: {
        literature_id: literatureId,
        asset_id: assetId,
        asset_sha256: source.sha256,
        media_type: source.media_type,
        byte_size: source.size_bytes,
        artifact: {
          sha256: source.sha256,
          byte_size: source.size_bytes,
          media_type: source.media_type,
        },
      },
      path: source.relative_path,
    };
  });
}
function documentVersion(versionId: Dynamic): Dynamic {
  requireDocumentV3();
  const v = db
    .prepare(
      "SELECT document_version_id,document_id,schema_version,literature_id,source_asset_id,source_sha256,source_byte_size,source_media_type,source_artifact_path,builder_version,locator_scheme,representation_sha256,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,structure_artifact_path,structure_sha256,structure_byte_size,structure_media_type,proofread_id,proofread_content_sha256,created_at,raw_parse_id,raw_parse_result_sha256,page_layer_sha256,draft_method_sha256,draft_content_artifact_path,draft_content_sha256,draft_content_byte_size,draft_content_media_type FROM document_versions WHERE document_version_id=?",
    )
    .get(versionId);
  if (!v || visibilityModule.literatureWithdrawn(db, v.literature_id))
    return null;
  const resources = db
    .prepare(
      "SELECT resource_id,reference,relation,artifact_sha256,artifact_byte_size,artifact_media_type FROM document_version_resources WHERE document_version_id=? ORDER BY ordinal",
    )
    .all(versionId)
    .map((r: Dynamic) => ({
      resource_id: r.resource_id,
      reference: r.reference,
      relation: r.relation,
      artifact: {
        sha256: r.artifact_sha256,
        byte_size: r.artifact_byte_size,
        media_type: r.artifact_media_type,
      },
    }));
  const version = {
    schema_version: v.schema_version,
    document_id: v.document_id,
    document_version_id: v.document_version_id,
    representation_sha256: v.representation_sha256,
    ...(v.schema_version === 3
      ? {
          text_level: "draft",
          raw_parse_id: v.raw_parse_id,
          raw_parse_result_sha256: v.raw_parse_result_sha256,
          page_layer_sha256: v.page_layer_sha256,
          draft_method_sha256: v.draft_method_sha256,
          draft_content: {
            sha256: v.draft_content_sha256,
            byte_size: v.draft_content_byte_size,
            media_type: v.draft_content_media_type,
          },
        }
      : {
          proofread_id: v.proofread_id,
          proofread_content_sha256: v.proofread_content_sha256,
        }),
    builder_version: v.builder_version,
    locator_scheme: v.locator_scheme,
    source_material_ref: {
      literature_id: v.literature_id,
      asset_id: v.source_asset_id,
      asset_sha256: v.source_sha256,
      media_type: v.source_media_type,
      byte_size: v.source_byte_size,
      artifact: {
        sha256: v.source_sha256,
        byte_size: v.source_byte_size,
        media_type: v.source_media_type,
      },
    },
    markdown: {
      sha256: v.markdown_sha256,
      byte_size: v.markdown_byte_size,
      media_type: v.markdown_media_type,
    },
    structure: {
      sha256: v.structure_sha256,
      byte_size: v.structure_byte_size,
      media_type: v.structure_media_type,
    },
    resources,
  };
  const paths = db
    .prepare(
      "SELECT reference,artifact_path FROM document_version_resources WHERE document_version_id=?",
    )
    .all(versionId);
  const current = db
    .prepare(
      "SELECT document_version_id,revision FROM document_defaults WHERE document_id=?",
    )
    .get(v.document_id);
  return {
    version,
    is_default: current?.document_version_id === versionId,
    default_revision: current?.revision ?? null,
    source_artifact_path: v.source_artifact_path,
    markdown_artifact_path: v.markdown_artifact_path,
    structure_artifact_path: v.structure_artifact_path,
    ...(v.schema_version === 3
      ? { draft_content_artifact_path: v.draft_content_artifact_path }
      : {}),
    resource_artifact_paths: Object.fromEntries(
      paths.map((r: Dynamic) => [r.reference, r.artifact_path]),
    ),
  };
}
function documentDefault(
  literatureId: Dynamic,
  assetId: Dynamic,
  assetSha256: Dynamic,
): Dynamic {
  requireDocumentV3();
  if (visibilityModule.literatureWithdrawn(db, literatureId)) return null;
  return (
    db
      .prepare(
        "SELECT d.document_version_id,d.revision FROM document_defaults d JOIN document_versions v ON v.document_version_id=d.document_version_id WHERE v.literature_id=? AND v.source_asset_id=? AND v.source_sha256=?",
      )
      .get(literatureId, assetId, assetSha256) ?? null
  );
}
function commitDocumentVersion(p: Dynamic): Dynamic {
  requireDocumentV3();
  return transaction(() => {
    const v = p.version;
    const source = db
      .prepare(
        "SELECT sha256,size_bytes,media_type,relative_path FROM assets WHERE asset_id=?",
      )
      .get(v.source_material_ref.asset_id);
    if (
      !source ||
      source.sha256 !== v.source_material_ref.asset_sha256 ||
      source.size_bytes !== v.source_material_ref.byte_size ||
      source.media_type !== v.source_material_ref.media_type ||
      source.relative_path !== p.source_artifact_path
    )
      throw new DocumentCommitError("document-source-stale");
    if (v.schema_version !== 2)
      throw new DocumentCommitError("document-version-invalid");
    {
      const proofread = db
        .prepare(
          "SELECT p.proofread_id,p.part_asset_id,p.part_sha256,p.content_sha256,p.status,p.manifest_reference,p.manifest_sha256,p.manifest_size,p.manifest_media_type,p.created_at FROM proofread_versions p JOIN proofread_current c ON c.proofread_id=p.proofread_id WHERE p.proofread_id=? AND p.part_asset_id=? AND p.part_sha256=? AND p.content_sha256=? AND p.status='complete'",
        )
        .get(
          v.proofread_id,
          v.source_material_ref.asset_id,
          source.sha256,
          v.proofread_content_sha256,
        );
      const binding = db
        .prepare(
          "SELECT 1 FROM literature_assets WHERE literature_id=? AND asset_id=? AND role IN ('primary-pdf','supplementary-pdf')",
        )
        .get(
          v.source_material_ref.literature_id,
          v.source_material_ref.asset_id,
        );
      if (!proofread || !binding)
        throw new DocumentCommitError("document-proofread-stale");
      const manualRevision =
        db
          .prepare(
            "SELECT revision FROM proofread_manual_state WHERE part_asset_id=?",
          )
          .get(v.source_material_ref.asset_id)?.revision ?? 0;
      const stale = db
        .prepare(
          "SELECT 1 FROM raw_parse_pins pin JOIN raw_parses p ON p.raw_parse_id=pin.raw_parse_id LEFT JOIN raw_parse_current c ON c.source_asset_id=p.source_asset_id AND c.profile=p.profile WHERE pin.proofread_id=? AND (c.raw_parse_id IS NULL OR c.raw_parse_id!=p.raw_parse_id) LIMIT 1",
        )
        .get(v.proofread_id);
      if (manualRevision !== p.expected_manual_revision)
        throw new DocumentCommitError("document-manual-stale");
      if (stale) throw new DocumentCommitError("document-raw-stale");
      const markdown = db
        .prepare(
          "SELECT proofread_id,kind,reference,artifact_reference,sha256,byte_size,media_type FROM proofread_resources WHERE proofread_id=? AND kind='markdown' AND sha256=? AND artifact_reference=? LIMIT 1",
        )
        .get(v.proofread_id, v.markdown.sha256, p.markdown_artifact_path);
      if (
        markdown?.sha256 !== v.markdown.sha256 ||
        markdown?.artifact_reference !== p.markdown_artifact_path
      )
        throw new DocumentCommitError("document-markdown-unregistered");
      const images = db
        .prepare(
          "SELECT proofread_id,kind,reference,artifact_reference,sha256,byte_size,media_type FROM proofread_resources WHERE proofread_id=? AND kind='image'",
        )
        .all(v.proofread_id);
      if (
        // v4 intentionally leaves equation screenshots in the immutable
        // proofread source while publishing only its rendered resource closure.
        (v.builder_version !== "source-order-leaves-v4" &&
          images.length !== v.resources.length) ||
        v.resources.some(
          (r: Dynamic) =>
            !images.some(
              (i: Dynamic) =>
                i.reference === r.reference &&
                i.sha256 === r.artifact.sha256 &&
                i.artifact_reference === p.resource_artifact_paths[r.reference],
            ),
        )
      )
        throw new DocumentCommitError("document-resources-mismatch");
    }
    const exactArtifact = (path: Dynamic, a: Dynamic): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?",
          )
          .get(path, a.sha256, a.byte_size, a.media_type)
      )
        throw new DocumentCommitError("document-artifact-unregistered");
    };
    exactArtifact(p.source_artifact_path, v.source_material_ref.artifact);
    exactArtifact(p.markdown_artifact_path, v.markdown);
    if (Object.keys(p.resource_artifact_paths).length !== v.resources.length)
      throw new DocumentCommitError("document-resources-mismatch");
    for (const r of v.resources)
      exactArtifact(p.resource_artifact_paths[r.reference], r.artifact);
    const previousStructure = db
      .prepare(
        "SELECT artifact_id,sha256,byte_size,media_type,relative_path FROM artifact_objects WHERE sha256=?",
      )
      .get(v.structure.sha256);
    if (previousStructure)
      exactArtifact(p.structure_artifact_path, v.structure);
    else
      db.prepare(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
      ).run(
        v.document_version_id,
        v.structure.sha256,
        v.structure.byte_size,
        v.structure.media_type,
        p.structure_artifact_path,
      );
    const existing = documentVersion(v.document_version_id);
    const stable = (value: Dynamic): Dynamic =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, stable(value[key])]),
            )
          : value;
    if (
      existing &&
      (JSON.stringify(
        stable({
          ...existing.version,
          proofread_id: v.proofread_id,
        }),
      ) !== JSON.stringify(stable(v)) ||
        existing.source_artifact_path !== p.source_artifact_path ||
        existing.markdown_artifact_path !== p.markdown_artifact_path ||
        existing.structure_artifact_path !== p.structure_artifact_path ||
        JSON.stringify(stable(existing.resource_artifact_paths)) !==
          JSON.stringify(stable(p.resource_artifact_paths)))
    )
      throw new DocumentCommitError("document-version-conflict");
    if (!existing) {
      db.prepare(
        `INSERT INTO document_versions(document_version_id,document_id,schema_version,literature_id,source_asset_id,source_sha256,source_byte_size,source_media_type,source_artifact_path,builder_version,locator_scheme,representation_sha256,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,structure_artifact_path,structure_sha256,structure_byte_size,structure_media_type,created_at,proofread_id,proofread_content_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        v.document_version_id,
        v.document_id,
        v.schema_version,
        v.source_material_ref.literature_id,
        v.source_material_ref.asset_id,
        v.source_material_ref.asset_sha256,
        v.source_material_ref.byte_size,
        v.source_material_ref.media_type,
        p.source_artifact_path,
        v.builder_version,
        v.locator_scheme,
        v.representation_sha256,
        p.markdown_artifact_path,
        v.markdown.sha256,
        v.markdown.byte_size,
        v.markdown.media_type,
        p.structure_artifact_path,
        v.structure.sha256,
        v.structure.byte_size,
        v.structure.media_type,
        new Date().toISOString(),
        v.proofread_id ?? null,
        v.proofread_content_sha256 ?? null,
      );
      for (let ordinal = 0; ordinal < v.resources.length; ordinal++) {
        const r = v.resources[ordinal];
        db.prepare(
          "INSERT INTO document_version_resources(document_version_id,ordinal,resource_id,reference,relation,artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          v.document_version_id,
          ordinal,
          r.resource_id,
          r.reference,
          r.relation,
          p.resource_artifact_paths[r.reference],
          r.artifact.sha256,
          r.artifact.byte_size,
          r.artifact.media_type,
        );
      }
    }
    const current = db
      .prepare(
        "SELECT document_version_id,revision FROM document_defaults WHERE document_id=?",
      )
      .get(v.document_id);
    let updated = false;
    let revision = current?.revision ?? null;
    if (current?.document_version_id === v.document_version_id) updated = true;
    else if ((current?.revision ?? null) === p.expected_default_revision) {
      updated = true;
    }
    if (updated) {
      const selected = documentDefaultsModule.recomputeDocumentDefault(db, {
        literature_id: v.source_material_ref.literature_id,
        asset_id: v.source_material_ref.asset_id,
        asset_sha256: v.source_material_ref.asset_sha256,
        expected_default_revision: current?.revision ?? null,
        preferred_proofread_version_id: v.document_version_id,
      });
      updated = selected.document_version_id === v.document_version_id;
      revision = selected.default_revision;
    }
    return {
      published: !existing,
      default_updated: updated,
      default_revision: revision,
    };
  });
}
function putProviderRelation(o: Dynamic): Dynamic {
  return transaction(() => {
    const p = o.provenance;
    db.prepare(
      "INSERT INTO provenances(provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provenance_id) DO NOTHING",
    ).run(
      p.provenance_id,
      p.source_kind,
      p.source_name,
      p.source_record_id,
      p.observed_at,
      p.input_sha256,
      p.parameters_sha256,
    );
    db.prepare(
      "INSERT INTO provider_relation_observations(observation_id,provenance_id) VALUES(?,?) ON CONFLICT(observation_id) DO NOTHING",
    ).run(o.observation_id, p.provenance_id);
    for (const [kind, endpoint] of [
      ["citing", o.citing],
      ["cited", o.cited],
    ]) {
      db.prepare(
        "INSERT INTO provider_relation_endpoints(observation_id,endpoint_kind,record_id) VALUES(?,?,?) ON CONFLICT(observation_id,endpoint_kind) DO NOTHING",
      ).run(o.observation_id, kind, endpoint.record_id);
      const insert = db.prepare(
        "INSERT INTO provider_relation_endpoint_identifiers(observation_id,endpoint_kind,ordinal,namespace,value) VALUES(?,?,?,?,?) ON CONFLICT(observation_id,endpoint_kind,namespace,value) DO NOTHING",
      );
      for (let i = 0; i < endpoint.identifiers.length; i++) {
        const identifier = endpoint.identifiers[i];
        insert.run(
          o.observation_id,
          kind,
          i,
          identifier.namespace,
          identifier.value,
        );
      }
    }
    return true;
  });
}
function getProviderRelation(id: Dynamic): Dynamic {
  const row = db
    .prepare(
      "SELECT observation_id,provenance_id FROM provider_relation_observations WHERE observation_id=?",
    )
    .get(id);
  if (!row) return null;
  const p = db
    .prepare(
      "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
    )
    .get(row.provenance_id);
  const endpoint = (kind: Dynamic) => {
    const value = db
      .prepare(
        "SELECT record_id FROM provider_relation_endpoints WHERE observation_id=? AND endpoint_kind=?",
      )
      .get(id, kind);
    if (!value) fail();
    return {
      record_id: value.record_id,
      identifiers: db
        .prepare(
          "SELECT namespace,value FROM provider_relation_endpoint_identifiers WHERE observation_id=? AND endpoint_kind=? ORDER BY ordinal",
        )
        .all(id, kind),
    };
  };
  return {
    observation_id: row.observation_id,
    source_type: row.source_type,
    source_type_mapping_version: row.source_type_mapping_version,
    provenance: p,
    citing: endpoint("citing"),
    cited: endpoint("cited"),
  };
}
function putProviderReferenceSupport(
  referenceId: Dynamic,
  observationId: Dynamic,
  reference?: Dynamic,
): Dynamic {
  return transaction(() => {
    if (reference) {
      const existing = db
        .prepare(
          "SELECT reference_id FROM literature_references WHERE source_literature_id=? AND target_literature_id=?",
        )
        .get(reference.source_literature_id, reference.target_literature_id);
      if (existing) referenceId = existing.reference_id;
      else putReference(reference);
    }
    const edge = db
      .prepare(
        "SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE reference_id=?",
      )
      .get(referenceId);
    const observation = getProviderRelation(observationId);
    if (!edge || !observation) fail();
    if (
      reference &&
      (edge.source_literature_id !== reference.source_literature_id ||
        edge.target_literature_id !== reference.target_literature_id)
    )
      fail();
    const matches = (id: Dynamic, endpoint: Dynamic) =>
      endpoint.identifiers.some((identifier: Dynamic) =>
        db
          .prepare(
            "SELECT 1 FROM literature_metadata_identifiers WHERE literature_id=? AND namespace=? AND value=?",
          )
          .get(id, identifier.namespace, identifier.value),
      ) ||
      (endpoint.record_id !== null &&
        db
          .prepare(
            "SELECT 1 FROM literature_metadata_observations owner JOIN metadata_observations observation ON observation.observation_id=owner.observation_id JOIN provenances p ON p.provenance_id=observation.provenance_id WHERE owner.literature_id=? AND p.source_name=? AND p.source_record_id=?",
          )
          .get(id, observation.provenance.source_name, endpoint.record_id));
    if (
      !matches(edge.source_literature_id, observation.citing) ||
      !matches(edge.target_literature_id, observation.cited)
    )
      fail();
    db.prepare(
      "INSERT INTO provider_relation_reference_supports(reference_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING",
    ).run(referenceId, observationId);
    return reference ? edge : true;
  });
}
function putMetadataReferenceSupport(
  referenceId: Dynamic,
  observationId: Dynamic,
  index: Dynamic,
): Dynamic {
  try {
    beginCatalogWrite(db);
    const valid = db
      .prepare(
        "SELECT 1 FROM literature_references r JOIN literature_metadata_observations owner ON owner.literature_id=r.source_literature_id JOIN metadata_observation_reference_texts text ON text.observation_id=owner.observation_id AND text.reference_index=? WHERE r.reference_id=? AND owner.observation_id=?",
      )
      .get(index, referenceId, observationId);
    if (!valid) fail();
    db.prepare(
      "INSERT INTO metadata_reference_text_supports(reference_id,metadata_observation_id,reference_index) VALUES(?,?,?) ON CONFLICT DO NOTHING",
    ).run(referenceId, observationId, index);
    commitCatalogWrite(db);
    return true;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure when rollback also fails.
    }
    throw e;
  }
}
function referenceSnapshot(): Dynamic {
  db.exec("BEGIN");
  try {
    const rows = db
      .prepare(
        `SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE ${visibilityModule.visibleLiteratureSql("source_literature_id")} AND ${visibilityModule.visibleLiteratureSql("target_literature_id")} AND (EXISTS(SELECT 1 FROM provider_relation_reference_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM metadata_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM archive_reference_text_supports s JOIN document_defaults f ON f.document_version_id=s.document_version_id JOIN structure_annotation_current c ON c.document_version_id=s.document_version_id AND c.annotation_id=s.annotation_id JOIN document_versions d ON d.document_version_id=s.document_version_id JOIN literature_assets l ON l.literature_id=d.literature_id AND l.asset_id=d.source_asset_id AND l.role='primary-pdf' WHERE s.reference_id=literature_references.reference_id)) ORDER BY source_literature_id,target_literature_id,reference_id`,
      )
      .all();
    const result = rows.map((row: Dynamic) => {
      const supports = [];
      for (const s of db
        .prepare(
          "SELECT observation_id FROM provider_relation_reference_supports WHERE reference_id=? ORDER BY observation_id",
        )
        .all(row.reference_id))
        supports.push({
          kind: "provider_relation",
          observation_id: s.observation_id,
        });
      for (const s of db
        .prepare(
          "SELECT metadata_observation_id,reference_index FROM metadata_reference_text_supports WHERE reference_id=? ORDER BY metadata_observation_id,reference_index",
        )
        .all(row.reference_id))
        supports.push({
          kind: "metadata_reference_text",
          metadata_observation_id: s.metadata_observation_id,
          reference_index: s.reference_index,
        });
      supports.push(
        ...archiveReferenceModule.archiveReferenceSupports(
          db,
          row.reference_id,
        ),
      );
      return {
        reference: {
          reference_id: row.reference_id,
          source_literature_id: row.source_literature_id,
          target_literature_id: row.target_literature_id,
        },
        supports,
      };
    });
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
function referenceQueryRows(selection: Dynamic): Dynamic {
  if ("literature_id" in selection && !getLiterature(selection.literature_id))
    return null;
  const where =
    "reference_id" in selection
      ? "reference_id=?"
      : selection.direction === "references"
        ? "source_literature_id=?"
        : "target_literature_id=?";
  const rows = db
    .prepare(
      `SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE ${visibilityModule.visibleLiteratureSql("source_literature_id")} AND ${visibilityModule.visibleLiteratureSql("target_literature_id")} AND ` +
        where,
    )
    .all(selection.reference_id ?? selection.literature_id);
  const defaultTexts = primaryDocumentTexts(
    rows.flatMap((row: Dynamic) => [
      String(row.source_literature_id),
      String(row.target_literature_id),
    ]),
  );
  const result = [];
  for (const reference of rows) {
    const source = searchItem(
        reference.source_literature_id,
        undefined,
        defaultTexts,
      ),
      target = searchItem(
        reference.target_literature_id,
        undefined,
        defaultTexts,
      );
    if (
      !source ||
      !target ||
      reference.source_literature_id === reference.target_literature_id
    )
      fail();
    const supports = [];
    for (const s of db
      .prepare(
        "SELECT observation_id FROM provider_relation_reference_supports WHERE reference_id=? ORDER BY observation_id",
      )
      .all(reference.reference_id)) {
      const o = getProviderRelation(s.observation_id);
      if (!o) fail();
      const matches = (id: Dynamic, endpoint: Dynamic) =>
        endpoint.identifiers.some((identifier: Dynamic) =>
          db
            .prepare(
              "SELECT 1 FROM literature_metadata_identifiers WHERE literature_id=? AND namespace=? AND value=?",
            )
            .get(id, identifier.namespace, identifier.value),
        ) ||
        (endpoint.record_id !== null &&
          db
            .prepare(
              "SELECT 1 FROM literature_metadata_observations owner JOIN metadata_observations observation ON observation.observation_id=owner.observation_id JOIN provenances p ON p.provenance_id=observation.provenance_id WHERE owner.literature_id=? AND p.source_name=? AND p.source_record_id=?",
            )
            .get(id, o.provenance.source_name, endpoint.record_id));
      if (
        !matches(reference.source_literature_id, o.citing) ||
        !matches(reference.target_literature_id, o.cited)
      )
        fail();
      supports.push({
        reference_id: reference.reference_id,
        source: { kind: "provider_relation", observation_id: s.observation_id },
      });
    }
    for (const s of db
      .prepare(
        "SELECT metadata_observation_id,reference_index FROM metadata_reference_text_supports WHERE reference_id=? ORDER BY metadata_observation_id,reference_index",
      )
      .all(reference.reference_id)) {
      if (
        !db
          .prepare(
            "SELECT 1 FROM literature_metadata_observations owner JOIN metadata_observation_reference_texts text ON text.observation_id=owner.observation_id WHERE owner.literature_id=? AND owner.observation_id=? AND text.reference_index=?",
          )
          .get(
            reference.source_literature_id,
            s.metadata_observation_id,
            s.reference_index,
          )
      )
        fail();
      supports.push({
        reference_id: reference.reference_id,
        source: { kind: "metadata_reference_text", ...s },
      });
    }
    for (const source of archiveReferenceModule.archiveReferenceSupports(
      db,
      reference.reference_id,
    ))
      supports.push({ reference_id: reference.reference_id, source });
    if (supports.length) result.push({ reference, source, target, supports });
  }
  return result;
}
function referenceQuerySnapshot(selection: Dynamic): Dynamic {
  db.exec("BEGIN");
  try {
    const result = referenceQueryRows(selection);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
/**
 * Rewrite the library search rows of a page of literatures with the current
 * FTS text rule (explicit maintenance after the rule changes; spec 9.7). One
 * short write transaction per page; withdrawn papers keep their rows.
 */
function reprojectLibrarySearch(after: string | null, limit: number) {
  beginCatalogWrite(db);
  try {
    const ids = db
      .prepare(
        "SELECT literature_id FROM literature_metadata WHERE (? IS NULL OR literature_id>?) ORDER BY literature_id LIMIT ?",
      )
      .all(after, after, limit)
      .map((row: Dynamic) => String(row.literature_id));
    for (const id of ids) indexMetadata(id, getLiterature(id, true).metadata);
    // The last page records that every row now follows the current rule.
    if (ids.length < limit)
      db.prepare(
        "UPDATE retrieval_change_state SET library_search_rule=? WHERE singleton=1",
      ).run(queryTextModule.FTS_TEXT_RULE);
    commitCatalogWrite(db);
    return {
      count: ids.length,
      next: ids.length === limit ? ids.at(-1)! : null,
    };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function literatureDetailSnapshot(
  id: Dynamic,
  nested: Dynamic = false,
): Dynamic {
  if (!nested) db.exec("BEGIN");
  try {
    const literature = getLiterature(id);
    if (!literature) {
      if (!nested) db.exec("COMMIT");
      return null;
    }
    const meta_literature = visibilityModule.visibleMetaLiterature(
      db,
      literature.meta_literature_id,
    );
    if (
      !meta_literature ||
      !db
        .prepare(
          "SELECT 1 FROM literatures WHERE literature_id=? AND meta_literature_id=?",
        )
        .get(
          meta_literature.representative_literature_id,
          meta_literature.meta_literature_id,
        )
    )
      fail();
    const metadata_observations = db
      .prepare(
        "SELECT observation_id FROM literature_metadata_observations WHERE literature_id=?",
      )
      .all(id)
      .map(({ observation_id }: Dynamic) => {
        const { literature_id, ...o } = getObservation(observation_id);
        if (literature_id !== id) fail();
        o.metadata.authors = o.metadata.authors.map((author: Dynamic) => {
          const result = { ...author };
          delete result.ordinal;
          return result;
        });
        o.asset_hints = db
          .prepare(
            "SELECT url,kind,media_type,asset_role,version_role,access_status,license FROM metadata_observation_asset_hints WHERE observation_id=? ORDER BY hint_ordinal",
          )
          .all(observation_id);
        o.version_links = db
          .prepare(
            "SELECT link_ordinal,record_id FROM metadata_observation_version_links WHERE observation_id=? ORDER BY link_ordinal",
          )
          .all(observation_id)
          .map((link: Dynamic) => ({
            record_id: link.record_id,
            identifiers: db
              .prepare(
                "SELECT namespace,value FROM metadata_observation_version_link_identifiers WHERE observation_id=? AND link_ordinal=? ORDER BY ordinal",
              )
              .all(observation_id, link.link_ordinal),
          }));
        return o;
      });
    const provenance = (id: Dynamic) =>
      db
        .prepare(
          "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
        )
        .get(id);
    const defaultRows = draftFactsModule.readDefaultTextFacts(db, [String(id)]),
      assetDefaults = new Map(
        defaultRows.map((row: Dynamic) => [row.asset_id, row.default_text]),
      ),
      primaryTexts = draftFactsModule.primaryDefaultTexts(defaultRows);
    const assets = db
      .prepare(
        `SELECT literature_asset_id,literature_id,asset_id,role,provenance_id,source_url FROM literature_assets WHERE literature_id=? AND ${visibilityModule.visibleObjectSql("literature-asset", "literature_asset_id")} ORDER BY role,literature_asset_id`,
      )
      .all(id)
      .map(({ provenance_id, ...relation }: Dynamic) => {
        const asset = getAsset(relation.asset_id);
        return {
          asset,
          ...(asset.media_type === "application/pdf"
            ? {
                default_text: assetDefaults.get(String(asset.asset_id)) ?? null,
              }
            : {}),
          literature_asset: {
            ...relation,
            provenance: provenance(provenance_id),
          },
          ...(() => {
            const assessment = articleIdentityCurrent(id, relation.asset_id);
            return assessment
              ? {
                  article_identity_assessment: assessment,
                  article_identity_status: assessment.status,
                }
              : {};
          })(),
        };
      });
    const primary = assets.filter(
      (a: Dynamic) => a.literature_asset.role === "primary-pdf",
    );
    if (primary.length > 1) fail();
    const primary_pdf = primary[0] || null;
    const versionRows = db
      .prepare(
        `SELECT literature_id FROM literatures WHERE ${visibilityModule.visibleLiteratureSql("literature_id")} AND meta_literature_id=? AND literature_id<>? ORDER BY CASE version_role WHEN 'published' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE 3 END,literature_id`,
      )
      .all(literature.meta_literature_id, id);
    const versionTexts = primaryDocumentTexts(
      versionRows.map((row: Dynamic) => String(row.literature_id)),
    );
    const other_versions = versionRows.map((row: Dynamic) =>
      searchItem(row.literature_id, undefined, versionTexts),
    );
    const detail = {
      ...searchItem(id, undefined, primaryTexts),
      intake_batches: intakeModule.intakeMemberships(db, id),
      meta_literature,
      metadata_observations,
      primary_pdf,
      additional_assets: assets.filter(
        (a: Dynamic) => a.literature_asset.role !== "primary-pdf",
      ),
      other_versions,
      reference_count: referenceQueryRows({
        literature_id: id,
        direction: "references",
      }).length,
      cited_by_count: referenceQueryRows({
        literature_id: id,
        direction: "cited-by",
      }).length,
    };
    if (!nested) db.exec("COMMIT");
    return { detail };
  } catch (error) {
    if (!nested) db.exec("ROLLBACK");
    throw error;
  }
}
function candidateCleanupSnapshot(): Dynamic {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('execution_schema_identity','execution_candidates','execution_receipts')",
    )
    .all();
  if (tables.length !== 0 && tables.length !== 3) fail();
  const execution = tables.length === 3;
  if (execution) requireExecution();
  const candidates = execution
    ? db
        .prepare(
          "SELECT transfer_id,record_json FROM execution_candidates ORDER BY transfer_id",
        )
        .all()
    : [];
  const receipts = execution
    ? db
        .prepare(
          "SELECT receipt_id,transfer_id,intent_json,result_json FROM execution_receipts ORDER BY receipt_id",
        )
        .all()
    : [];
  return { candidates, receipts };
}
function artifactReclamationSnapshot(reference: Dynamic): Dynamic {
  return transaction(() => {
    // Every accepted document/raw/knowledge artifact is registered and FK-pinned.
    const registered = !!db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM artifact_objects WHERE relative_path=?) OR EXISTS(SELECT 1 FROM assets WHERE relative_path=?) AS used",
      )
      .get(reference, reference).used;
    return { registered, ...candidateCleanupSnapshot() };
  });
}
function putAsset(a: Dynamic): Dynamic {
  beginCatalogWrite(db);
  try {
    db.prepare(
      "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?) ON CONFLICT(artifact_id) DO NOTHING",
    ).run(a.asset_id, a.sha256, a.size_bytes, a.media_type, a.path);
    db.prepare(
      "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) VALUES(?,?,?,?,?) ON CONFLICT(asset_id) DO NOTHING",
    ).run(a.asset_id, a.sha256, a.size_bytes, a.media_type, a.path);
    const stored = db
      .prepare(
        "SELECT sha256,size_bytes,media_type,relative_path FROM assets WHERE asset_id=?",
      )
      .get(a.asset_id);
    if (
      !stored ||
      stored.sha256 !== a.sha256 ||
      stored.size_bytes !== a.size_bytes ||
      stored.media_type !== a.media_type ||
      stored.relative_path !== a.path
    )
      fail();
    commitCatalogWrite(db);
    return true;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure when rollback also fails.
    }
    throw e;
  }
}
function putReference(r: Dynamic): Dynamic {
  if (r.source_literature_id === r.target_literature_id) fail();
  db.prepare(
    "INSERT INTO literature_references(reference_id,source_literature_id,target_literature_id) VALUES(?,?,?) ON CONFLICT(reference_id) DO NOTHING",
  ).run(r.reference_id, r.source_literature_id, r.target_literature_id);
  return true;
}
function getAsset(id: Dynamic): Dynamic {
  return (
    db
      .prepare(
        "SELECT asset_id,sha256,size_bytes,media_type,relative_path AS path FROM assets WHERE asset_id=?",
      )
      .get(id) || null
  );
}
function locateArtifact(value: Dynamic): Dynamic {
  if ("asset_id" in value) {
    const asset = getAsset(value.asset_id);
    if (
      !asset ||
      ["asset_id", "sha256", "size_bytes", "media_type", "path"].some(
        (key: Dynamic) => asset[key] !== value[key],
      )
    )
      return null;
  }
  const row = db
    .prepare(
      "SELECT relative_path AS reference,sha256,byte_size,media_type FROM artifact_objects WHERE sha256=? AND byte_size=? AND media_type=?",
    )
    .get(value.sha256, value.byte_size ?? value.size_bytes, value.media_type);
  if (!row || ("path" in value && row.reference !== value.path)) return null;
  return {
    reference: row.reference,
    artifact: {
      sha256: row.sha256,
      byte_size: row.byte_size,
      media_type: row.media_type,
    },
  };
}
function getDiscovery(id: Dynamic): Dynamic {
  const run = db
    .prepare(
      "SELECT discovery_run_id,kind,status,started_at FROM discovery_runs WHERE discovery_run_id=?",
    )
    .get(id);
  if (!run) return null;
  const input =
    run.kind === "topic"
      ? db
          .prepare(
            "SELECT query,year_from,year_to FROM topic_discovery_inputs WHERE discovery_run_id=?",
          )
          .get(id)
      : db
          .prepare(
            "SELECT direction,max_depth,result_limit FROM citation_discovery_inputs WHERE discovery_run_id=?",
          )
          .get(id);
  if (!input) fail();
  const seeds =
    run.kind === "citation"
      ? db
          .prepare(
            `SELECT literature_id FROM citation_discovery_seeds WHERE discovery_run_id=? AND ${visibilityModule.visibleLiteratureSql("literature_id")} ORDER BY seed_ordinal`,
          )
          .all(id)
          .map((x: Dynamic) => x.literature_id)
      : [];
  const providers = db
    .prepare(
      "SELECT provider_name,scan_limit FROM discovery_run_providers WHERE discovery_run_id=? ORDER BY provider_ordinal",
    )
    .all(id);
  const source_results = db
    .prepare(
      "SELECT provider_name,outcome,failure_code,failure_reason,failure_action,failure_retryable FROM discovery_source_results WHERE discovery_run_id=? ORDER BY provider_name",
    )
    .all(id)
    .map((x: Dynamic) => ({
      provider_name: x.provider_name,
      outcome: x.outcome,
      failure:
        x.failure_code === null
          ? null
          : {
              code: x.failure_code,
              reason: x.failure_reason,
              action: x.failure_action,
              retryable: !!x.failure_retryable,
            },
    }));
  const results = db
    .prepare(
      `SELECT meta_literature_id FROM discovery_results WHERE discovery_run_id=? AND EXISTS(SELECT 1 FROM literatures l WHERE l.meta_literature_id=discovery_results.meta_literature_id AND ${visibilityModule.visibleLiteratureSql("l.literature_id")}) ORDER BY meta_literature_id`,
    )
    .all(id);
  const topic_causes = db
    .prepare(
      `SELECT meta_literature_id,metadata_observation_id,actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id=? AND ${visibilityModule.visibleLiteratureSql("actual_literature_id")} ORDER BY meta_literature_id,metadata_observation_id`,
    )
    .all(id);
  const citation_causes = db
    .prepare(
      `SELECT meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth FROM citation_discovery_causes WHERE discovery_run_id=? AND ${visibilityModule.visibleLiteratureSql("source_literature_id")} AND ${visibilityModule.visibleLiteratureSql("target_literature_id")} ORDER BY depth,source_literature_id,target_literature_id`,
    )
    .all(id);
  const visibleResults = new Set(
    [...topic_causes, ...citation_causes].map(
      (cause: Dynamic) => cause.meta_literature_id,
    ),
  );
  return {
    run: {
      ...run,
      ...input,
      ...(run.kind === "citation" ? { seed_literature_ids: seeds } : {}),
    },
    providers,
    source_results,
    results: results.filter((result: Dynamic) =>
      visibleResults.has(result.meta_literature_id),
    ),
    topic_causes,
    citation_causes,
  };
}
function putDiscoveryHeader(p: Dynamic, resumeCitation: boolean): string {
  if (
    !p?.run ||
    !Array.isArray(p.providers) ||
    !Array.isArray(p.source_results)
  )
    fail();
  const r = p.run;
  db.prepare(
    "INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) VALUES(?,?,?,?) ON CONFLICT(discovery_run_id) DO NOTHING",
  ).run(r.discovery_run_id, r.kind, r.status, r.started_at);
  const saved = db
    .prepare(
      "SELECT kind,status,started_at FROM discovery_runs WHERE discovery_run_id=?",
    )
    .get(r.discovery_run_id);
  const resuming =
    resumeCitation &&
    r.kind === "citation" &&
    saved?.kind === "citation" &&
    saved.started_at === r.started_at &&
    saved.status === "INTERRUPTED";
  if (
    !saved ||
    saved.kind !== r.kind ||
    (saved.status !== r.status && !resuming) ||
    saved.started_at !== r.started_at
  )
    fail();
  if (resuming) {
    db.prepare(
      "UPDATE discovery_runs SET status=? WHERE discovery_run_id=?",
    ).run(r.status, r.discovery_run_id);
    db.prepare(
      "DELETE FROM discovery_source_results WHERE discovery_run_id=?",
    ).run(r.discovery_run_id);
  }
  if (r.kind === "topic") {
    db.prepare(
      "INSERT INTO topic_discovery_inputs(discovery_run_id,kind,query,year_from,year_to) VALUES(?,'topic',?,?,?) ON CONFLICT(discovery_run_id) DO NOTHING",
    ).run(r.discovery_run_id, r.query, r.year_from ?? null, r.year_to ?? null);
  } else if (r.kind === "citation") {
    db.prepare(
      "INSERT INTO citation_discovery_inputs(discovery_run_id,kind,direction,max_depth,result_limit) VALUES(?,'citation',?,?,?) ON CONFLICT(discovery_run_id) DO NOTHING",
    ).run(r.discovery_run_id, r.direction, r.max_depth, r.result_limit);
    for (let i = 0; i < (r.seed_literature_ids || []).length; i++)
      db.prepare(
        "INSERT INTO citation_discovery_seeds(discovery_run_id,seed_ordinal,literature_id) VALUES(?,?,?) ON CONFLICT(discovery_run_id,seed_ordinal) DO NOTHING",
      ).run(r.discovery_run_id, i, r.seed_literature_ids[i]);
  } else fail();
  for (let i = 0; i < p.providers.length; i++) {
    const x = p.providers[i];
    db.prepare(
      "INSERT INTO discovery_run_providers(discovery_run_id,provider_ordinal,provider_name,scan_limit,kind) VALUES(?,?,?,?,?) ON CONFLICT(discovery_run_id,provider_ordinal) DO NOTHING",
    ).run(r.discovery_run_id, i, x.provider_name, x.scan_limit, r.kind);
  }
  putDiscoverySourceResults(r.discovery_run_id, p.source_results);
  return r.discovery_run_id;
}
function putDiscoverySourceResults(id: string, sources: Dynamic) {
  for (const x of sources) {
    const f = x.failure;
    db.prepare(
      "INSERT INTO discovery_source_results(discovery_run_id,provider_name,outcome,failure_code,failure_reason,failure_action,failure_retryable) VALUES(?,?,?,?,?,?,?) ON CONFLICT(discovery_run_id,provider_name) DO NOTHING",
    ).run(
      id,
      x.provider_name,
      x.outcome,
      f?.code ?? null,
      f?.reason ?? null,
      f?.action ?? null,
      f?.retryable === undefined ? null : Number(f.retryable),
    );
  }
}
function insertDiscoveryResult(runId: string, metaId: string) {
  db.prepare(
    "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?) ON CONFLICT(discovery_run_id,meta_literature_id) DO NOTHING",
  ).run(runId, metaId);
}
function insertCitationCause(runId: string, cause: Dynamic) {
  db.prepare(
    "INSERT INTO citation_discovery_causes(discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth) VALUES(?,?,?,?,?,?) ON CONFLICT(discovery_run_id,source_literature_id,target_literature_id,depth) DO NOTHING",
  ).run(
    runId,
    cause.meta_literature_id,
    cause.source_literature_id,
    cause.target_literature_id,
    cause.actual_literature_id,
    cause.depth,
  );
}
function putDiscovery(p: Dynamic, resumeCitation = false): Dynamic {
  return transaction(() => {
    if (
      !p ||
      !Array.isArray(p.results) ||
      !Array.isArray(p.topic_causes) ||
      !Array.isArray(p.citation_causes)
    )
      fail();
    const id = putDiscoveryHeader(p, resumeCitation);
    for (const x of p.results) insertDiscoveryResult(id, x.meta_literature_id);
    for (const x of p.topic_causes)
      db.prepare(
        "INSERT INTO topic_discovery_causes(discovery_run_id,meta_literature_id,metadata_observation_id,actual_literature_id) VALUES(?,?,?,?) ON CONFLICT(discovery_run_id,meta_literature_id,metadata_observation_id) DO NOTHING",
      ).run(
        id,
        x.meta_literature_id,
        x.metadata_observation_id,
        x.actual_literature_id,
      );
    for (const x of p.citation_causes) insertCitationCause(id, x);
    validateDiscoveryCauses([id]);
    return getDiscovery(id);
  });
}
function putCitationPublication(
  part: Extract<SqliteCommand, { kind: "citation_publication" }>["part"],
) {
  if (!metadataWrite) fail();
  if (part.kind === "start") {
    const { run } = part.publication;
    if (
      metadataWrite.citationRun ||
      run.kind !== "citation" ||
      run.status !== "RUNNING"
    )
      fail();
    const existing = db
      .prepare("SELECT status FROM discovery_runs WHERE discovery_run_id=?")
      .get(run.discovery_run_id);
    if (existing && !part.resume) fail();
    const id = putDiscoveryHeader(
      { ...part.publication, source_results: [] },
      part.resume,
    );
    metadataWrite.citationRun = { id, finished: false };
    return existing?.status ?? null;
  }
  const id = part.runId;
  if (!metadataWrite.citationRun) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM discovery_runs WHERE discovery_run_id=? AND kind='citation' AND status='RUNNING'",
        )
        .get(id)
    )
      fail();
    metadataWrite.citationRun = { id, finished: false };
  }
  if (metadataWrite.citationRun.id !== id || metadataWrite.citationRun.finished)
    fail();
  if (part.kind === "append") {
    insertDiscoveryResult(id, part.cause.meta_literature_id);
    insertCitationCause(id, part.cause);
  } else {
    if (
      !Array.isArray(part.sources) ||
      !["COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"].includes(part.status)
    )
      fail();
    putDiscoverySourceResults(id, part.sources);
    db.prepare(
      "UPDATE discovery_runs SET status=? WHERE discovery_run_id=?",
    ).run(part.status, id);
    metadataWrite.citationRun.finished = true;
  }
  return true;
}

function counts(): Dynamic {
  const names = [
    "schema_identity",
    "artifact_objects",
    "provenances",
    "meta_literatures",
    "literatures",
    "literature_metadata",
    "literature_metadata_authors",
    "literature_metadata_author_affiliations",
    "literature_metadata_identifiers",
    "literature_metadata_keywords",
    "metadata_observations",
    "provider_relation_observations",
    "literature_references",
    "assets",
    "literature_assets",
    "discovery_runs",
  ];
  const result: Record<string, number> = {};
  for (const name of names)
    result[name] = Number(
      db.prepare("SELECT count(*) AS count FROM " + name).get().count,
    );
  return { tables: result };
}
function idleWalCheckpoint(): IdleWalCheckpointResult {
  if (data.read_only) fail();
  const wal = () => {
    const stat = statSync(data.path + "-wal", { throwIfNoEntry: false });
    return stat ? { size: stat.size, mtime_ms: stat.mtimeMs } : null;
  };
  const before = data.path === ":memory:" ? null : wal();
  const started_at_ms = Date.now();
  if (!before?.size || started_at_ms - before.mtime_ms < 15_000)
    return {
      started_at_ms,
      before,
      after: before,
      passive: null,
      truncate: null,
    };
  // PASSIVE can flush a backlog without waiting on foreign readers or writers.
  // Only truncate a fully checkpointed, idle WAL, with a zero busy timeout.
  const maintenance = new DatabaseSync(data.path);
  try {
    maintenance.exec("PRAGMA busy_timeout=0");
    const checkpoint = (mode: "PASSIVE" | "TRUNCATE"): WalCheckpointFrames => {
      const row = maintenance.prepare(`PRAGMA wal_checkpoint(${mode})`).get()!;
      return {
        busy: Number(row.busy),
        log: Number(row.log),
        checkpointed: Number(row.checkpointed),
      };
    };
    const passive = checkpoint("PASSIVE");
    const after = wal();
    if (
      passive.busy !== 0 ||
      passive.log !== passive.checkpointed ||
      after?.mtime_ms !== before.mtime_ms ||
      after.size !== before.size
    )
      return { started_at_ms, before, after, passive, truncate: null };
    const truncate = checkpoint("TRUNCATE");
    return { started_at_ms, before, after: wal(), passive, truncate };
  } finally {
    maintenance.close();
  }
}
port.on("message", (message: WorkerMessage) => {
  cancellation = message.cancellation
    ? new Int32Array(message.cancellation)
    : undefined;
  try {
    queryCheckpoint();
    if (message.command.kind === "close") {
      taskDetails.clear();
      retrievalEngine?.close();
      db?.close();
      port.postMessage({ id: message.id, ok: true, value: true });
      return;
    }
    if (message.command.kind === "idle_wal_checkpoint") {
      const value = idleWalCheckpoint();
      port.postMessage({ id: message.id, ok: true, value });
      return;
    }
    if (message.command.kind === "retrieval") {
      let value;
      try {
        const engine = getRetrievalEngine();
        const { operation, args } = message.command;
        if (
          data.read_only &&
          [
            "beginGeneration",
            "insertEntries",
            "publish",
            "ensureActive",
            "beginLiteratureUpdate",
            "pruneGenerationBatch",
            "commitLiteratureUpdate",
            "commitLiteratureBatch",
            "finishIncremental",
            "pruneChangeBatch",
            "recordVerification",
            "markCorrupt",
            "verify",
          ].includes(operation)
        )
          fail();
        const allowed = [
          "revision",
          "sourceCount",
          "metadataPage",
          "documentPage",
          "beginGeneration",
          "insertEntries",
          "publish",
          "active",
          "state",
          "ruleStatus",
          "search",
          "documentCoverage",
          "metadataSource",
          "hasDefault",
          "pruneGenerationBatch",
          "scanChanges",
          "changesSnapshot",
          "changePage",
          "pruneChangeBatch",
          "literatureSources",
          "ensureActive",
          "beginLiteratureUpdate",
          "commitLiteratureUpdate",
          "commitLiteratureBatch",
          "finishIncremental",
          "verificationEntries",
          "verify",
          "verifyCatalog",
          "recordVerification",
          "markCorrupt",
        ];
        if (!allowed.includes(operation) || !Array.isArray(args)) fail();
        // Translations are indexed in the caller's configured language only.
        engine.translationLanguage =
          typeof message.command.translation_language === "string"
            ? message.command.translation_language
            : null;
        value = {
          ok: true,
          value: Reflect.apply(engine[operation], engine, args),
        };
      } catch (error) {
        if (
          message.command.operation === "verifyCatalog" ||
          (error instanceof CatalogLayoutError &&
            error.reason === "catalog-addition-required")
        )
          throw error;
        value = {
          ok: false,
          code: sqliteStorageFull(error)
            ? "index-storage-full"
            : error && typeof error === "object" && "code" in error
              ? error.code
              : "index-corrupt",
        };
      }
      port.postMessage({ id: message.id, ok: true, value });
      return;
    }
    if (!db) initialize();
    else if (!db.isTransaction && !metadataWrite) {
      // FTS5 may retain an obsolete index view on a long-lived SQLite
      // connection after another connection commits. Refresh only between
      // transactions; a multi-command read snapshot must keep its connection.
      // initialize repeats the original read-only/schema gate.
      const current = Number(
        db.prepare("PRAGMA data_version").get().data_version,
      );
      const catalogChanged = openedCatalogIdentity !== catalogIdentity();
      if (current !== observedDataVersion || catalogChanged) {
        if (
          !catalogChanged &&
          !data.read_only &&
          message.command.kind === "library_state_refresh" &&
          verifiedDocumentSchema === documentSchemaProof(SCHEMA_VERSION)
        ) {
          // Projection backfill reads ordinary SQLite tables. Keep its hot
          // statements and pages between admitted batches, with the same
          // layout proof and identity-row checks as a fresh connection.
          // Leave observedDataVersion unchanged for later FTS commands.
          checkCatalogIdentityRows(db, layoutModule.CURRENT_CATALOG_CONFIG);
        } else {
          // A refresh of the same catalog keeps the task cache. Task reads
          // validate its event prefix against their new SQLite snapshot.
          if (catalogChanged) {
            taskDetails.clear();
            libraryRankings.clear();
          }
          db.close();
          db = undefined;
          queryPreflight = null;
          initialize();
        }
      }
    }
    if (
      data.read_only &&
      message.command.kind !== "query_preflight" &&
      queryPreflight?.status !== "ready"
    )
      fail();
    // Some SQLite errors roll back the whole transaction. Until the segment
    // owner has cleaned up, never run its remaining commands in autocommit.
    if (
      metadataWrite &&
      !db.isTransaction &&
      message.command.kind !== "metadata_write_rollback"
    )
      fail();
    let value;
    switch (message.command.kind) {
      case "metadata_write_begin": {
        if (data.read_only || metadataWrite || db.isTransaction) fail();
        beginCatalogWrite(db);
        const prepare: DatabaseSync["prepare"] = db.prepare;
        // Segments on this connection use the same statement settings. Keep
        // the cache bounded for SQL with variable numbers of parameters.
        db.prepare = (sql: string) => {
          let statement = metadataStatements.get(sql);
          if (!statement) {
            statement = prepare.call(db, sql);
            if (metadataStatements.size === METADATA_STATEMENT_LIMIT) {
              const oldest = metadataStatements.keys().next().value;
              if (oldest !== undefined) metadataStatements.delete(oldest);
            }
            metadataStatements.set(sql, statement);
          }
          return statement;
        };
        metadataWrite = {
          prepare,
          nextSequence: new Map(),
          textValidation: new ContractTextValidation(),
          textNormalization: new queryTextModule.MetadataTextNormalization(),
        };
        value = true;
        break;
      }
      case "metadata_write_commit":
      case "metadata_write_rollback": {
        if (!metadataWrite) fail();
        if (message.command.kind === "metadata_write_commit") {
          if (metadataWrite.citationRun)
            // Triggers record the rows changed by publication even during the
            // historical backfill. Do not scan the run in a write segment.
            validateProjectedDiscovery(metadataWrite.citationRun.id);
          if (message.command.events.length) requireRuntime();
          for (const event of message.command.events)
            insertExecutionEvent(event);
          commitCatalogWrite(db);
        } else if (db.isTransaction) db.exec("ROLLBACK");
        db.prepare = metadataWrite.prepare;
        metadataWrite = undefined;
        value = true;
        break;
      }
      case "citation_checkpoints": {
        requireRuntime();
        const { jobId, targetId, range } = message.command;
        const rows = range
          ? db
              .prepare(
                citationCheckpointsSql +
                  " AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 32",
              )
              .all(jobId, targetId, range.after, range.through)
          : db
              .prepare(
                citationCheckpointsSql + " ORDER BY sequence DESC LIMIT 1",
              )
              .all(jobId, targetId);
        value = rows.map((row: Dynamic) => ({
          sequence: row.sequence,
          payload: JSON.parse(row.payload_json),
        }));
        break;
      }
      case "citation_publication":
        value = putCitationPublication(message.command.part);
        break;
      case "capture_read":
      case "capture_write":
        try {
          const c = message.command;
          value = {
            ok: true,
            value:
              c.kind === "capture_read"
                ? readTransaction(() => captureModule.readCapture(db, c.action))
                : captureModule.writeCapture(db, c.action, intakeModule),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          const code =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code.startsWith("intake-")
              ? error.code
              : "intake-unavailable";
          value = { ok: false, code };
        }
        break;
      case "import_read":
      case "import_write":
        try {
          const command = message.command;
          value = {
            ok: true,
            value:
              command.kind === "import_read"
                ? readTransaction(() =>
                    importModule.readImportStorage(
                      db,
                      command.action,
                      data.archive_profile,
                    ),
                  )
                : importModule.writeImportStorage(
                    db,
                    command.action,
                    intakeModule.writeIntakeBatch,
                  ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          const code =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code.startsWith("intake-")
              ? error.code
              : "intake-unavailable";
          value = { ok: false, code };
        }
        break;
      case "device_connections":
        value = deviceModule.runDeviceStorage(db, message.command.command);
        break;
      case "intake_withdrawn":
        value = visibilityModule.literatureWithdrawn(
          db,
          message.command.literature_id,
        );
        break;
      case "intake_withdrawal_read":
      case "intake_withdrawal_write":
        try {
          value = {
            ok: true,
            value: withdrawalModule.runIntakeWithdrawal(
              db,
              message.command.command,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code.startsWith("intake-batch-")
          )
            value = { ok: false, code: error.code };
          else throw error;
        }
        break;
      case "folders":
        try {
          value = {
            ok: true,
            value: folderModule.runFolderStorage(db, message.command.value),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error && typeof error === "object" && "code" in error
                ? error.code
                : "folder-storage-failed",
          };
        }
        break;
      case "library_trash":
        try {
          value = {
            ok: true,
            value: libraryTrashModule.runLibraryTrashStorage(
              db,
              message.command.command,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "library-trash-busy"
          )
            value = { ok: false, code: error.code };
          else throw error;
        }
        break;
      case "filters":
        try {
          value = {
            ok: true,
            value: filterModule.runFilterStorage(db, message.command.value),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error && typeof error === "object" && "code" in error
                ? error.code
                : "filter-storage-failed",
          };
        }
        break;
      case "marks":
        try {
          value = {
            ok: true,
            value: marksModule.runMarkStorage(db, message.command.value),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error && typeof error === "object" && "code" in error
                ? error.code
                : "mark-storage-failed",
          };
        }
        break;
      case "snapshot":
        try {
          value = {
            ok: true,
            value: snapshotModule.runSnapshotStorage(
              db,
              message.command.action,
              message.command.args,
              libraryState.settings().max_tags,
              libraryState.settings().archive_profile,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error && typeof error === "object" && "code" in error
                ? error.code
                : "snapshot-storage-failed",
          };
        }
        break;
      case "archive":
        try {
          value = {
            ok: true,
            value: archiveModule.runArchiveStorage(
              db,
              message.command.action,
              message.command.args,
              libraryState.settings().max_tags,
              libraryState.settings().archive_profile,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error && typeof error === "object" && "code" in error
                ? error.code
                : "archive-storage-failed",
          };
        }
        break;
      case "tags":
        try {
          value = {
            ok: true,
            value: tagModule.runTagStorage(
              db,
              message.command.action,
              message.command.args,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          const known = error instanceof Error && error.name === "TagError";
          value = {
            ok: false,
            code: known && "code" in error ? error.code : "tag-storage-failed",
            details: known && "details" in error ? error.details : {},
          };
        }
        break;
      case "annotation":
        try {
          value = {
            ok: true,
            value: annotationModule.runAnnotationStorage(
              db,
              message.command.action,
              message.command.args,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "annotation-storage-failed",
          };
        }
        break;
      case "review": {
        const { action, args } = message.command;
        const review = () => reviewModule.runReviewStorage(db, action, args);
        try {
          value = {
            ok: true,
            // Completing an audited manual tag assignment can collect a version.
            value: action === "audit-finish" ? transaction(review) : review(),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = { ok: false, code: "review-storage-failed" };
        }
        break;
      }
      case "proofread":
        try {
          value = {
            ok: true,
            value: proofreadModule.runProofreadStorage(
              db,
              message.command.action,
              message.command.args,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "proofread-storage-failed",
          };
        }
        break;
      case "draft_text_read": {
        const request = message.command.request;
        value = readTransaction(() =>
          draftTextModule.runDraftTextRead(db, request),
        );
        break;
      }
      case "draft_text_write":
        try {
          value = {
            ok: true,
            value: draftTextModule.runDraftTextWrite(
              db,
              message.command.request,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "draft-text-storage-failed",
          };
        }
        break;
      case "raw_parse":
        try {
          value = {
            ok: true,
            value: rawParseModule.runRawParseStorage(
              db,
              message.command.action,
              message.command.args,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "raw-parse-storage-failed",
          };
        }
        break;
      case "processor":
        try {
          value = {
            ok: true,
            value: processorModule.runProcessorStorage(
              db,
              message.command.action,
              message.command.args,
              SCHEMA_MANIFEST,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "processor-storage-failed",
          };
        }
        break;
      case "extraction":
        try {
          value = {
            ok: true,
            value: extractionModule.runExtractionStorage(
              db,
              message.command.action,
              message.command.args,
            ),
          };
        } catch (error) {
          throwCatalogCorruption(error);
          value = {
            ok: false,
            code:
              error &&
              typeof error === "object" &&
              error.constructor?.name === "ExtractionStorageFailure" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "storage-failed",
          };
        }
        break;
      case "article_identity_get":
        value = articleIdentityGet(message.command.assessmentId);
        break;
      case "article_identity_current": {
        const { literatureId, assetId } = message.command;
        value = readTransaction(() =>
          articleIdentityCurrent(literatureId, assetId),
        );
        break;
      }
      case "article_identity_put":
        value = articleIdentityPut(message.command.assessment);
        break;
      case "document_parts": {
        requireDocumentV3();
        const { literatureId, offset, limit } = message.command;
        value = readTransaction(() =>
          visibilityModule.literatureWithdrawn(db, literatureId)
            ? { total: 0, items: [] }
            : {
                total: Number(
                  db
                    .prepare(
                      "SELECT count(*) AS n FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role IN ('primary-pdf','supplementary-pdf') AND a.media_type='application/pdf'",
                    )
                    .get(literatureId).n,
                ),
                items: db
                  .prepare(
                    "SELECT l.asset_id,a.sha256 AS asset_sha256,CASE l.role WHEN 'primary-pdf' THEN 'main' ELSE 'supplementary' END AS role FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role IN ('primary-pdf','supplementary-pdf') AND a.media_type='application/pdf' ORDER BY CASE l.role WHEN 'primary-pdf' THEN 0 ELSE 1 END,l.rowid LIMIT ? OFFSET ?",
                  )
                  .all(literatureId, limit, offset),
              },
        );
        break;
      }
      case "document_material":
        value = documentMaterial(
          message.command.literatureId,
          message.command.assetId,
        );
        break;
      case "document_version":
        {
          const versionId = message.command.versionId;
          value = readTransaction(() => documentVersion(versionId));
        }
        break;
      case "document_default":
        value = documentDefault(
          message.command.literatureId,
          message.command.assetId,
          message.command.assetSha256,
        );
        break;
      case "document_commit":
        value = commitDocumentVersion(message.command.publication);
        break;
      case "execution_runtime_inspect":
        value = runtimeInspect();
        break;
      case "execution_backup":
        value = backupExecution(message.command.path);
        break;
      case "execution_restore_check":
        value = restoreCheck(message.command.path);
        break;
      case "execution_create_job":
        value = createExecutionJob(
          message.command.job,
          message.command.policy_sha256,
          message.command.policy_json,
          message.command.targets ?? [],
          message.command.origin,
        );
        break;
      case "execution_get_job":
        value = getExecutionJob(message.command.jobId);
        break;
      case "execution_request_start":
        value = requestExecutionStart(
          message.command.jobId,
          message.command.eventId,
          message.command.actor,
          message.command.now,
        );
        break;
      case "execution_list_requested_jobs":
        value = listRequestedExecutionJobs();
        break;
      case "execution_list_jobs":
        value = listExecutionJobs(
          message.command.limit,
          message.command.order,
          message.command.before,
          message.command.statuses,
        );
        break;
      case "execution_list_targets":
        value = listExecutionTargets(
          message.command.jobId,
          message.command.limit,
          message.command.visibleOnly,
        );
        break;
      case "execution_list_attempts":
        value = listExecutionAttempts(
          message.command.targetId,
          message.command.limit,
        );
        break;
      case "execution_recover":
        value = recoverExecution(message.command.bootId, message.command.now);
        break;
      case "execution_get_policy":
        value = getExecutionPolicy(message.command.jobId);
        break;
      case "execution_get_budget":
        value = getExecutionBudget(message.command.jobId);
        break;
      case "execution_consume_budget":
        value = consumeExecutionBudget(
          message.command.jobId,
          message.command.usage,
          message.command.now,
        );
        break;
      case "execution_update_job":
        value = updateExecutionJob(
          message.command.jobId,
          message.command.status,
          message.command.finishedAt,
          message.command.onlyIfActive,
        );
        break;
      case "execution_control_job":
        value = controlExecutionJob(
          message.command.jobId,
          message.command.status,
          message.command.finishedAt,
        );
        break;
      case "execution_put_target":
        value = putExecutionTarget(message.command.target);
        break;
      case "execution_get_target":
        value = getExecutionTarget(message.command.targetId);
        break;
      case "execution_claim_target":
        value = claimExecutionTarget(
          message.command.jobId,
          message.command.now,
          message.command.targetId,
        );
        break;
      case "execution_update_target":
        value = updateExecutionTarget(
          message.command.targetId,
          message.command.stage,
          message.command.disposition,
          message.command.nextEligibleAt,
        );
        break;
      case "execution_start_attempt":
        value = startExecutionAttempt(message.command.attempt);
        break;
      case "execution_finish_attempt":
        value = finishExecutionAttempt(
          message.command.attemptId,
          message.command.status,
          message.command.finishedAt,
          message.command.failure,
          message.command.usage,
        );
        break;
      case "execution_append_event":
        value = appendExecutionEvent(message.command.event);
        break;
      case "execution_list_events":
        value = listExecutionEvents(
          message.command.jobId,
          message.command.after,
          message.command.limit,
          message.command.order,
          message.command.acquisitionOnly ?? false,
        );
        break;
      case "execution_task_detail_events": {
        const { jobId, through, withActivity, incrementalOnly } =
          message.command;
        const inode = openedCatalogIdentity;
        if (inode === null) fail();
        requireRuntime();
        const identity = () => taskCatalogIdentity(inode);
        const pinned = db.isTransaction;
        if (!pinned) taskDetails.restore(db, identity, jobId, through);
        const read = () =>
          taskDetails.read(
            db,
            identity(),
            jobId,
            through,
            withActivity,
            queryCheckpoint,
            incrementalOnly === true,
          );
        value = pinned ? read() : readTransaction(read);
        if (!pinned && value.status === "ok") taskDetails.checkpoint(jobId);
        break;
      }
      case "execution_task_detail_replay": {
        if (!data.read_only || !data.long_read_lane || db.isTransaction) fail();
        const inode = openedCatalogIdentity;
        requireRuntime();
        const { jobId, through, withActivity, scratchPath } = message.command;
        value = replayTaskDetail(
          db,
          () => {
            const current = catalogIdentity();
            if (current !== inode) fail();
            return taskCatalogIdentity(current);
          },
          jobId,
          through,
          withActivity,
          scratchPath,
          queryCheckpoint,
        );
        if (value.transfer) taskDetails.saveTransfer(value.transfer);
        break;
      }
      case "execution_task_detail_install": {
        const inode = openedCatalogIdentity;
        if (inode === null || data.long_read_lane) fail();
        const identity = taskCatalogIdentity(inode);
        value = taskDetails.install(db, identity, message.command.transfer);
        break;
      }
      case "execution_put_intervention":
        value = putExecutionIntervention(message.command.intervention);
        break;
      case "execution_put_intervention_if_active":
        value = putExecutionIntervention(message.command.intervention, true);
        break;
      case "execution_list_interventions":
        value = listExecutionInterventions(
          message.command.jobId,
          message.command.limit,
        );
        break;
      case "execution_resolve_intervention":
        value = resolveExecutionIntervention(
          message.command.interventionId,
          message.command.status,
          message.command.resolvedAt,
          message.command.resolution,
        );
        break;
      case "execution_acquire_lease":
        value = acquireExecutionLease(message.command.lease);
        break;
      case "execution_release_lease":
        value = releaseExecutionLease(
          message.command.leaseId,
          message.command.releasedAt,
        );
        break;
      case "put_candidate":
        value = putCandidate(message.command.candidate);
        break;
      case "retire_candidate":
        value = retireCandidate(message.command.candidate);
        break;
      case "get_candidate":
        value = getCandidate(message.command.transferId);
        break;
      case "prepare_receipt":
        value = prepareReceipt(message.command.intent);
        break;
      case "get_receipt_intent":
        value = getReceiptIntent(message.command.receiptId);
        break;
      case "get_receipt_result":
        value = getReceiptResult(message.command.receiptId);
        break;
      case "library_state_configure": {
        const settings = message.command.settings;
        value = transaction(() => libraryState.configure(settings));
        break;
      }
      case "library_state_pending":
        value = readTransaction(() => libraryState.maintenancePending());
        break;
      case "library_state_refresh":
        value = refreshLibraryState(message.command.budget);
        break;
      case "library_collect": {
        const command = message.command;
        if ("ids" in command)
          value = transaction(() => {
            libraryStateModule.recordCollectedLiteratures(db, command.ids);
          });
        else {
          cancellation = new Int32Array(command.cancellation);
          value = transaction(() => collectLibrarySelection(command.request));
          // A cancellation after the commit point must not report a rollback.
          cancellation = undefined;
        }
        break;
      }
      case "library_uncollect": {
        const command = message.command;
        cancellation = new Int32Array(command.cancellation);
        try {
          value = transaction(() => uncollectLibrarySelection(command.request));
        } finally {
          // A cancellation after the commit point must not report a rollback.
          cancellation = undefined;
        }
        break;
      }
      case "library_counts": {
        const command = message.command;
        value = readTransaction(() => {
          if (command.counterRead === "defer" && !libraryState.countsReady())
            return { defer: true };
          validateDiscoveryCauses(command.query.discovery_run_ids);
          return libraryPageModule.libraryCounts(
            db,
            command.query,
            command.ftsQuery,
            false,
            Date.now(),
            command.windowStart,
          );
        });
        break;
      }
      case "library_exact_count":
        value = libraryExactCount(message.command);
        break;
      case "intake_read":
      case "intake_summary_read": {
        const c = message.command;
        const read = () =>
          c.kind === "intake_summary_read"
            ? intakeModule.queryIntakeBatchSummaries(db, c.request)
            : intakeModule.queryIntakeBatches(
                db,
                c.value,
                data.archive_profile,
              );
        value = db.isTransaction ? read() : readTransaction(read);
        break;
      }
      case "intake_write": {
        const c = message.command;
        value = transaction(() => intakeModule.writeIntakeBatch(db, c.action));
        break;
      }
      case "library_facets": {
        const c = message.command;
        value = readTransaction(() => {
          return libraryPageModule.libraryFacets(
            db,
            c.request,
            c.ftsQuery,
            c.limit,
            false,
            Date.now(),
            c.windowStart,
          );
        });
        break;
      }
      case "acquire_pdf_selection": {
        const c = message.command;
        value = readTransaction(() => {
          return libraryPageModule.acquirePdfSelection(db, c.request);
        });
        break;
      }
      case "parse_document_selection": {
        const c = message.command;
        value = readTransaction(() => {
          return libraryPageModule.parseDocumentSelection(
            db,
            c.request,
            data.archive_profile,
          );
        });
        break;
      }
      case "library_search_page":
        value = librarySearchPage(
          message.command.request,
          message.command.stateRead === "defer",
        );
        break;
      case "library_snapshot":
        value = librarySnapshot(
          message.command.ftsQuery,
          message.command.discoveryRunIds,
          message.command.includeOtherVersions,
          message.command.literatureIds,
          message.command.metaLiteratureIds,
          message.command.tags,
          message.command.scope,
        );
        break;
      case "candidate_cleanup_snapshot":
        value = readTransaction(candidateCleanupSnapshot);
        break;
      case "artifact_reclamation_snapshot":
        value = artifactReclamationSnapshot(message.command.reference);
        break;
      case "literature_detail_snapshot":
        value = literatureDetailSnapshot(message.command.literatureId);
        break;
      case "library_search_reproject":
        value = reprojectLibrarySearch(
          message.command.after,
          message.command.limit,
        );
        break;
      case "locate_artifact":
        value = locateArtifact(message.command.value);
        break;
      case "reference_query_snapshot":
        value = referenceQuerySnapshot(message.command.selection);
        break;
      case "put_discovery":
        value = putDiscovery(
          message.command.publication,
          message.command.resumeCitation,
        );
        break;
      case "get_discovery": {
        const { discoveryRunId } = message.command;
        value = readTransaction(() => getDiscovery(discoveryRunId));
        break;
      }
      case "list_candidates":
        value = listCandidates(message.command.articleId);
        break;
      case "current_facts":
        value = currentFacts(message.command.literatureId);
        break;
      case "set_automatic_pdf_exhaustion":
        value = setAutomaticPdfExhaustion(message.command);
        break;
      case "clear_automatic_pdf_exhaustion":
        value = clearAutomaticPdfExhaustion(message.command);
        break;
      case "read_automatic_pdf_exhaustion":
        value = readAutomaticPdfExhaustion(message.command);
        break;
      case "asset_by_hash":
        value = assetByHash(message.command.sha256);
        break;
      case "commit_receipt":
        value = commitReceipt(message.command.intent, message.command.created);
        break;
      case "pending_receipts":
        value = pendingReceipts();
        break;
      case "get_literature_ids":
        value = getLiteratureIds(
          message.command.literatureId,
          message.command.includeHidden === true,
        );
        break;
      case "find_literature_by_identifiers":
        value = findLiteratureByIdentifiers(
          message.command.identifiers,
          message.command.idsOnly === true,
        );
        break;
      case "schema":
        value = db
          .prepare(
            "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
          )
          .get();
        break;
      case "query_preflight":
        value = queryPreflight;
        break;
      case "put_literature":
        value = putLiterature(
          message.command.literature,
          message.command.metadataSha256,
          message.command.fallbackIdentitySha256,
        );
        break;
      case "begin_read_snapshot":
        if (!data.read_only || db.isTransaction) fail();
        db.exec("BEGIN");
        db.prepare("SELECT singleton FROM schema_identity").get();
        value = true;
        break;
      case "literature_bibliographies":
        if (message.command.ids.length > 1000) fail();
        value = bibliographyModule.readLiteratureBibliographies(
          db,
          message.command.ids,
        );
        break;
      case "get_literature":
        value = getLiterature(message.command.literatureId);
        break;
      case "list_literature":
        value = listLiterature(
          message.command.afterLiteratureId,
          message.command.limit,
        );
        break;
      case "put_asset":
        value = putAsset(message.command.asset);
        break;
      case "get_asset":
        value = getAsset(message.command.assetId);
        break;
      case "put_literature_asset":
        value = putLiteratureAsset(message.command.publication);
        break;
      case "put_reference":
        value = putReference(message.command.reference);
        break;
      case "publish_provider_reference":
        value = putProviderReferenceSupport(
          message.command.reference.reference_id,
          message.command.observationId,
          message.command.reference,
        );
        break;
      case "put_provider_relation":
        value = putProviderRelation(message.command.observation);
        break;
      case "get_provider_relation":
        value = getProviderRelation(message.command.observationId);
        break;
      case "put_provider_reference_support":
        value = putProviderReferenceSupport(
          message.command.referenceId,
          message.command.observationId,
        );
        break;
      case "put_metadata_reference_support":
        value = putMetadataReferenceSupport(
          message.command.referenceId,
          message.command.observationId,
          message.command.referenceIndex,
        );
        break;
      case "reference_snapshot":
        value = referenceSnapshot();
        break;
      case "put_observation":
        value = putObservation(message.command.observation);
        break;
      case "get_observation":
        value = getObservation(message.command.observationId);
        break;
      case "archive_reference_publish":
        value = archiveReferenceModule.publishArchiveReferences(
          db,
          message.command.publication,
        );
        break;
      case "metadata_fields_read":
        value = readTransaction(() => {
          const id =
            message.command.kind === "metadata_fields_read"
              ? message.command.literatureId
              : fail();
          const literature = getLiterature(id);
          if (!literature) return null;
          const metadata = db
            .prepare(
              "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
            )
            .get(id);
          const observations = db
            .prepare(
              "SELECT observation_id FROM literature_metadata_observations WHERE literature_id=? ORDER BY observation_id",
            )
            .all(id)
            .map((row: Dynamic) => {
              const { literature_id, ...observation } = getObservation(
                row.observation_id,
              );
              if (literature_id !== id) fail();
              return observation;
            });
          return {
            literature,
            ...metadata,
            field_states: metadataFieldsModule.readMetadataFields(db, id),
            observations,
          };
        });
        break;
      case "identity_read":
        value = identityRead(message.command.request);
        break;
      case "publish_identity_observation": {
        const { publication } = message.command;
        const scope = metadataWrite;
        value = scope
          ? scope.textValidation.run(() =>
              scope.textNormalization.run(() =>
                publishIdentityObservation(publication),
              ),
            )
          : publishIdentityObservation(publication);
        break;
      }
      case "accept_observation":
        value = acceptObservation(message.command);
        break;
      case "snapshot_counts":
        value = counts();
        break;
      default:
        fail();
    }
    queryCheckpoint();
    port.postMessage({ id: message.id, ok: true, value });
  } catch (error) {
    const corruption = catalogCorruption(error);
    const publicationCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      isDocumentCommitFailureCode(error.code)
        ? error.code
        : "document-publication-failed";
    port.postMessage({
      id: message.id,
      ok: false,
      value: null,
      ...(corruption
        ? { code: corruption.code, sqlite_code: corruption.sqlite_code }
        : error instanceof CatalogLayoutError &&
            error.reason === "catalog-addition-required"
          ? { code: error.reason, addition: error.addition }
          : message.command.kind === "document_commit"
            ? { code: publicationCode }
            : message.command.kind === "library_search_page" &&
                error instanceof Error &&
                "code" in error &&
                error.code === LIBRARY_SORT_SCOPE_LIMIT
              ? { code: LIBRARY_SORT_SCOPE_LIMIT }
              : {}),
      cancelled: !!cancellation && Atomics.load(cancellation, 0) !== 0,
    });
  } finally {
    cancellation = undefined;
  }
});
