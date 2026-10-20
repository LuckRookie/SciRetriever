import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { SqliteCommand } from "./worker.js";
import type { RetrievalStorageEngine } from "./retrieval-engine.js";
/** Dynamic values are confined to SQLite rows and JSON columns at this adapter boundary. */
type Dynamic = ReturnType<typeof JSON.parse>;
interface WorkerRuntimeData {
  readonly path: string;
  readonly read_only: boolean;
  readonly max_tags: number;
  readonly archive_profile: "pipeline" | "vlm-engine";
  readonly case_fold: Readonly<Record<string, string>>;
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
}
const data = workerData as WorkerRuntimeData;
const layoutModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./catalog-layout.ts"
      : "./catalog-layout.js",
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
const stateModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../literature/state.ts"
      : "../../literature/state.js",
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
const CASE_FOLD = data.case_fold;
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
let retrievalEngine: RetrievalStorageEngine | undefined;
function getRetrievalEngine(): RetrievalStorageEngine {
  return (retrievalEngine ??= new retrievalModule.RetrievalStorageEngine(
    data.path,
    data.read_only,
    {
      schema_version: SCHEMA_VERSION,
      schema_fingerprint: SCHEMA_FINGERPRINT,
      schema_manifest: SCHEMA_MANIFEST,
      execution_schema_version: EXECUTION_SCHEMA_VERSION,
      execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
      execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
      execution_runtime_schema_fingerprint:
        EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
    },
  ));
}
function caseFold(value: string): string {
  return Array.from(
    value,
    (character) => CASE_FOLD[character] ?? character,
  ).join("");
}
function ftsIndexText(value: string): string {
  return (
    caseFold(value.normalize("NFC")).match(
      /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu,
    ) ?? []
  )
    .filter((term) => !["and", "near", "not", "or"].includes(term))
    .join(" ");
}
let db: Dynamic;
let observedDataVersion: number | null = null;
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
function validDocumentSchema(version: number): boolean {
  // Reuse a full health check only while this connection's database state is
  // unchanged. External commits, local writes (including rolled-back writes),
  // DDL and reopening the connection all invalidate this proof.
  const identity = JSON.stringify([
    version,
    db.prepare("PRAGMA data_version").get().data_version,
    db.prepare("PRAGMA schema_version").get().schema_version,
    db.prepare("SELECT total_changes() AS changes").get().changes,
  ]);
  if (verifiedDocumentSchema === identity) return true;
  verifiedDocumentSchema = null;
  const valid = inspectDocumentSchema(version);
  if (valid) verifiedDocumentSchema = identity;
  return valid;
}
function inspectDocumentSchema(version: number): boolean {
  try {
    const names = new Set<string>();
    const manifest = version === SCHEMA_VERSION ? SCHEMA_MANIFEST : null;
    if (!manifest) return false;
    for (const sql of manifest) {
      const name =
        /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER|VIEW) ([a-z_][a-z0-9_]*)/.exec(
          sql,
        )?.[1];
      if (!name) return false;
      names.add(name);
      // These exact known objects belong to the derived Context projection.
      // Its own inspector checks their DDL; source readers need only their
      // names whitelisted so a missing/damaged projection index cannot hide
      // otherwise valid Literature and Document facts.
      if (
        [
          "processor_record_projection",
          "processor_projection_state",
          "processor_result_fts",
          "processor_collection_fts",
        ].includes(name)
      )
        continue;
      if (
        data.read_only &&
        version === SCHEMA_VERSION &&
        (name.startsWith("retrieval_") ||
          [
            "processor_record_projection",
            "processor_projection_state",
            "processor_result_fts",
            "processor_collection_fts",
          ].includes(name))
      )
        continue;
      if (
        db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)
          ?.sql !== sql
      )
        return false;
    }
    for (const suffix of ["data", "idx", "content", "docsize", "config"])
      names.add(`literature_search_fts_${suffix}`);
    for (const suffix of ["data", "idx", "content", "docsize", "config"])
      names.add(`tag_search_${suffix}`);
    if (version === SCHEMA_VERSION)
      for (const suffix of ["data", "idx", "content", "docsize", "config"])
        names.add(`retrieval_fts_${suffix}`);
    if (version === SCHEMA_VERSION)
      for (const prefix of ["processor_result_fts", "processor_collection_fts"])
        for (const suffix of ["data", "idx", "content", "docsize", "config"])
          names.add(`${prefix}_${suffix}`);
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all()
        .some((row: Dynamic) => !names.has(row.name))
    )
      return false;
    if (version === SCHEMA_VERSION) {
      // Retrieval is a rebuildable projection. Its damaged FTS postings must
      // not block Library and Document source reads needed to repair it.
      for (const sql of manifest) {
        const table = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/.exec(
          sql,
        )?.[1];
        if (
          !table ||
          table.startsWith("retrieval_") ||
          [
            "processor_record_projection",
            "processor_projection_state",
            "processor_result_fts",
            "processor_collection_fts",
          ].includes(table)
        )
          continue;
        if (
          db.prepare(`PRAGMA integrity_check(${table})`).get()
            ?.integrity_check !== "ok"
        )
          return false;
        if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length)
          return false;
      }
    } else {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        return false;
      if (db.prepare("PRAGMA foreign_key_check").all().length !== 0)
        return false;
    }
    const execution = db
      .prepare(
        "SELECT version,fingerprint FROM execution_schema_identity WHERE singleton=1",
      )
      .get();
    const runtime = db
      .prepare(
        "SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1",
      )
      .get();
    return (
      execution?.version === EXECUTION_SCHEMA_VERSION &&
      execution?.fingerprint === EXECUTION_SCHEMA_FINGERPRINT &&
      runtime?.version === EXECUTION_RUNTIME_SCHEMA_VERSION &&
      runtime?.fingerprint === EXECUTION_RUNTIME_SCHEMA_FINGERPRINT
    );
  } catch {
    return false;
  }
}
function initialize(): Dynamic {
  verifiedDocumentSchema = null;
  db = data.read_only
    ? new DatabaseSync(data.path, { readOnly: true })
    : new DatabaseSync(data.path);
  db.function("sr_normalize", { deterministic: true }, (value: Dynamic) =>
    value === null ? null : queryTextModule.normalizeQueryText(value),
  );
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (data.read_only) {
    db.exec("PRAGMA query_only = ON");
    queryPreflight = inspectQueryCatalog();
    observedDataVersion = Number(
      db.prepare("PRAGMA data_version").get().data_version,
    );
    return;
  }
  db.exec("PRAGMA journal_mode = WAL");
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
  if (
    existing?.schema_version === SCHEMA_VERSION &&
    !validDocumentSchema(existing.schema_version)
  )
    fail();
  observedDataVersion = Number(
    db.prepare("PRAGMA data_version").get().data_version,
  );
}
function inspectQueryCatalog(): {
  readonly status: "ready" | "not-initialized" | "unavailable";
  readonly schema: Dynamic | null;
} {
  try {
    const identityTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_identity'",
      )
      .get();
    if (!identityTable) {
      const userTables = Number(
        db
          .prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get().count,
      );
      return {
        status: userTables === 0 ? "not-initialized" : "unavailable",
        schema: null,
      };
    }
    const identity = db
      .prepare(
        "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
      )
      .get();
    if (
      !identity ||
      identity.product !== "sciretriever" ||
      !(
        identity.schema_version === SCHEMA_VERSION &&
        identity.schema_fingerprint === SCHEMA_FINGERPRINT
      )
    )
      return { status: "unavailable", schema: null };
    if (
      identity.schema_version === SCHEMA_VERSION &&
      !validDocumentSchema(identity.schema_version)
    )
      return { status: "unavailable", schema: null };
    return { status: "ready", schema: identity };
  } catch {
    return { status: "unavailable", schema: null };
  }
}
function putLiterature(
  l: Dynamic,
  metadataSha256: Dynamic,
  fallbackIdentitySha256: Dynamic,
): Dynamic {
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?) ON CONFLICT(meta_literature_id) DO NOTHING",
    ).run(l.meta_literature_id, l.literature_id);
    db.prepare(
      "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?) ON CONFLICT(literature_id) DO UPDATE SET meta_literature_id=excluded.meta_literature_id,version_role=excluded.version_role",
    ).run(l.literature_id, l.meta_literature_id, l.version_role);
    writeMetadata(l.literature_id, l.metadata, metadataSha256);
    replaceFallbackIndex(l.literature_id, fallbackIdentitySha256);
    db.exec("COMMIT");
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
  const keyword = db.prepare(
    "INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) VALUES(?,?,?)",
  );
  for (let i = 0; i < m.keywords.length; i++)
    keyword.run(literatureId, i, m.keywords[i]);
  indexMetadata(literatureId, m);
}
function indexMetadata(literatureId: Dynamic, m: Dynamic): Dynamic {
  const contentBody =
    db
      .prepare(
        "SELECT content_body FROM literature_search_fts WHERE literature_id=?",
      )
      .get(literatureId)?.content_body || "";
  db.prepare("DELETE FROM literature_search_fts WHERE literature_id=?").run(
    literatureId,
  );
  const index = (value: string): string => ftsIndexText(value || "");
  db.prepare(
    "INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
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
    index(m.keywords.join(" ")),
    index(m.venue),
    index(m.publisher),
    index(m.volume),
    index(m.issue),
    index(m.pages),
    contentBody,
  );
}
function getLiterature(id: Dynamic): Dynamic {
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
  const status = stateEvidence(id).status;
  return {
    literature_id: l.literature_id,
    meta_literature_id: l.meta_literature_id,
    version_role: l.version_role,
    status,
    metadata: { ...m, authors, identifiers, keywords },
  };
}
function getLiteratures(ids: Dynamic): Dynamic {
  if (!Array.isArray(ids) || ids.length > 10000) return fail();
  if (ids.length === 0) return [];
  const json = JSON.stringify(ids);
  const roots = db
    .prepare(
      "SELECT l.literature_id,l.meta_literature_id,l.version_role,m.title,m.abstract,m.publication_date,m.publication_year,m.publication_form,m.article_kind,m.language,m.venue,m.publisher,m.volume,m.issue,m.pages FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE l.literature_id IN (SELECT value FROM json_each(?)) ORDER BY l.literature_id",
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
    const state = stateEvidence(literature_id);
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
      },
      __state: state,
    };
  });
}
function findLiteratureByIdentifiers(identifiers: Dynamic): Dynamic {
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
  return [...ids].sort().map(getLiterature);
}
function stateEvidence(id: string): Dynamic {
  return archiveModule.archiveState(
    db,
    id,
    data.max_tags,
    data.archive_profile,
  );
}
function libraryTagBadges(ids: readonly string[]): Map<string, Dynamic[]> {
  const result = new Map<string, Dynamic[]>();
  for (const row of db
    .prepare(
      "SELECT i.literature_id,i.rank,t.tag_id,t.row_json FROM literature_tag_items i JOIN tags t ON t.tag_id=i.tag_id WHERE i.literature_id IN (SELECT value FROM json_each(?)) ORDER BY i.literature_id,i.rank",
    )
    .all(JSON.stringify(ids))) {
    const t = JSON.parse(String(row.row_json)),
      items = result.get(String(row.literature_id)) ?? [];
    items.push({
      tag_id: row.tag_id,
      name: t.name_zh || t.name_en,
      rank: row.rank,
    });
    result.set(String(row.literature_id), items);
  }
  return result;
}
function searchItem(id: Dynamic, literature: Dynamic = undefined): Dynamic {
  literature = literature ?? getLiterature(id);
  const metadata = db
    .prepare(
      "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
    )
    .get(id);
  const state = stateEvidence(id);
  const exhausted = !!db
    .prepare(
      "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
    )
    .get(id);
  return {
    literature,
    ...metadata,
    tags: libraryTagBadges([id]).get(id) ?? [],
    missing_step: state.missing_step,
    needs_manual_pdf: state.status === "UNREVIEWED" && exhausted,
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
function validateDiscoveryCauses(ids: Dynamic): Dynamic {
  for (const id of new Set<Dynamic>(ids)) {
    const run = db
      .prepare("SELECT kind FROM discovery_runs WHERE discovery_run_id=?")
      .get(id);
    const results = db
      .prepare(
        "SELECT meta_literature_id FROM discovery_results WHERE discovery_run_id=?",
      )
      .all(id);
    const resultIds = new Set<Dynamic>(
      results.map((row: Dynamic) => row.meta_literature_id),
    );
    const counts = new Map<Dynamic, Dynamic>();
    for (const c of db
      .prepare("SELECT * FROM topic_discovery_causes WHERE discovery_run_id=?")
      .all(id)) {
      if (
        run?.kind !== "topic" ||
        !resultIds.has(c.meta_literature_id) ||
        !db
          .prepare(
            "SELECT 1 FROM literature_metadata_observations owner JOIN literatures actual ON actual.literature_id=owner.literature_id WHERE owner.observation_id=? AND actual.literature_id=? AND actual.meta_literature_id=?",
          )
          .get(
            c.metadata_observation_id,
            c.actual_literature_id,
            c.meta_literature_id,
          )
      )
        fail();
      counts.set(
        c.meta_literature_id,
        (counts.get(c.meta_literature_id) || 0) + 1,
      );
    }
    for (const c of db
      .prepare(
        "SELECT * FROM citation_discovery_causes WHERE discovery_run_id=?",
      )
      .all(id)) {
      if (
        run?.kind !== "citation" ||
        !resultIds.has(c.meta_literature_id) ||
        ![c.source_literature_id, c.target_literature_id].includes(
          c.actual_literature_id,
        ) ||
        !db
          .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
          .get(c.source_literature_id) ||
        !db
          .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
          .get(c.target_literature_id) ||
        !db
          .prepare(
            "SELECT 1 FROM literatures WHERE literature_id=? AND meta_literature_id=?",
          )
          .get(c.actual_literature_id, c.meta_literature_id)
      )
        fail();
      counts.set(
        c.meta_literature_id,
        (counts.get(c.meta_literature_id) || 0) + 1,
      );
    }
    for (const result of results)
      if (
        !["topic", "citation"].includes(run?.kind) ||
        !counts.get(result.meta_literature_id)
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
): Dynamic {
  db.exec("BEGIN");
  try {
    if (
      !Array.isArray(literatureIds) ||
      !Array.isArray(metaLiteratureIds) ||
      literatureIds.length > 10000 ||
      metaLiteratureIds.length > 10000 ||
      (literatureIds.length && metaLiteratureIds.length)
    )
      fail();
    validateDiscoveryCauses(discoveryRunIds);
    // Select IDs before materializing domain rows: an unrelated row must not be
    // parsed just because it shares the catalog or an FTS term with this scope.
    const conditions: string[] = [];
    const parameters: string[] = [];
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
        "literature_id IN (SELECT actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id IN (SELECT value FROM json_each(?)) UNION SELECT actual_literature_id FROM citation_discovery_causes WHERE discovery_run_id IN (SELECT value FROM json_each(?)))",
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
        tags?.ids?.length)
    ) {
      const relevance = new Map<Dynamic, Dynamic>(
        rows.map((row: Dynamic) => [row.literature_id, row.relevance]),
      );
      rows = db
        .prepare(
          "SELECT literature_id FROM literatures WHERE meta_literature_id IN (SELECT meta_literature_id FROM literatures WHERE literature_id IN (SELECT value FROM json_each(?))) ORDER BY literature_id",
        )
        .all(JSON.stringify(rows.map((row: Dynamic) => row.literature_id)))
        .map((row: Dynamic) => ({
          literature_id: row.literature_id,
          relevance: relevance.get(row.literature_id) ?? null,
        }));
    }
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
          "SELECT actual_literature_id,discovery_run_id FROM topic_discovery_causes WHERE actual_literature_id IN (SELECT value FROM json_each(?)) UNION SELECT actual_literature_id,discovery_run_id FROM citation_discovery_causes WHERE actual_literature_id IN (SELECT value FROM json_each(?)) ORDER BY actual_literature_id,discovery_run_id",
        )
        .all(json, json)) {
        const values = discovery.get(item.actual_literature_id) ?? [];
        values.push(item.discovery_run_id);
        discovery.set(item.actual_literature_id, values);
      }
      const tagBadges = libraryTagBadges(
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
            missing_step: __state.missing_step,
            needs_manual_pdf: __state.status === "UNREVIEWED" && hasExhaustion,
          },
          relevance: row.relevance,
          has_pdf_exhaustion: hasExhaustion,
          discovery_run_ids: discovery.get(row.literature_id) ?? [],
        };
      });
    } else
      result = rows.map((row: Dynamic) => ({
        item: searchItem(row.literature_id),
        relevance: row.relevance,
        has_pdf_exhaustion: !!db
          .prepare(
            "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
          )
          .get(row.literature_id),
        discovery_run_ids: db
          .prepare(
            "SELECT discovery_run_id FROM topic_discovery_causes WHERE actual_literature_id=? UNION SELECT discovery_run_id FROM citation_discovery_causes WHERE actual_literature_id=?",
          )
          .all(row.literature_id, row.literature_id)
          .map((x: Dynamic) => x.discovery_run_id),
      }));
    db.exec("COMMIT");
    return tagMatches
      ? result.map((r: Dynamic) => ({
          ...r,
          tag_match: tagMatches.has(r.item.literature.literature_id),
        }))
      : result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function librarySearchPage(request: Dynamic): Dynamic {
  return readTransaction(() => {
    validateDiscoveryCauses(request.query.discovery_run_ids);
    const q = request.query;
    if (
      q.statuses.length ||
      q.missing_steps.length ||
      q.needs_manual_pdf === true
    ) {
      const states = new Map(
        [...archiveModule.archiveStates(db)].map(([id, facts]: Dynamic) => [
          id,
          stateModule.deriveCurrentState(
            facts,
            data.max_tags,
            data.archive_profile,
          ),
        ]),
      );
      db.function(
        "sr_status",
        { deterministic: true },
        (id: Dynamic) => states.get(id)?.status ?? null,
      );
      db.function(
        "sr_missing",
        { deterministic: true },
        (id: Dynamic) => states.get(id)?.missing_step ?? null,
      );
    }
    const page = libraryPageModule.libraryPageIds(db, request);
    return {
      total_count: page.total_count,
      ...(page.tag_backfill_pending === undefined
        ? {}
        : { tag_backfill_pending: page.tag_backfill_pending }),
      rows: page.rows.map((row: Dynamic) => ({
        item: searchItem(row.literature_id),
        relevance: row.relevance,
        has_pdf_exhaustion: !!db
          .prepare(
            "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
          )
          .get(row.literature_id),
        discovery_run_ids: db
          .prepare(
            "SELECT discovery_run_id FROM topic_discovery_causes WHERE actual_literature_id=? UNION SELECT discovery_run_id FROM citation_discovery_causes WHERE actual_literature_id=?",
          )
          .all(row.literature_id, row.literature_id)
          .map((r: Dynamic) => r.discovery_run_id),
      })),
    };
  });
}
function listLiterature(afterId: Dynamic, limit: Dynamic): Dynamic {
  const rows = db
    .prepare(
      "SELECT literature_id FROM literatures WHERE (? IS NULL OR literature_id>?) ORDER BY literature_id LIMIT ?",
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
    const literature = getLiterature(id);
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
function storeObservation(o: Dynamic): Dynamic {
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
        o.literature_id !== undefined &&
        old.literature_id !== o.literature_id)
    )
      fail();
    if (o.literature_id !== undefined)
      db.prepare(
        "INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      ).run(o.literature_id, o.observation_id);
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
  if (o.literature_id !== undefined)
    db.prepare(
      "INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING",
    ).run(o.literature_id, o.observation_id);
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
    const literatures = memberIds.map(getLiterature);
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
        content_ready:
          stateEvidence(literature.literature_id).status === "READY",
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
      storeObservation({
        ...link.observation,
        literature_id: link.literature_id,
      });
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
    return true;
  });
}
function acceptObservation(c: Dynamic): Dynamic {
  try {
    db.exec("BEGIN IMMEDIATE");
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
    indexMetadata(c.literatureId, getLiterature(c.literatureId).metadata);
    // Accepting a new MetadataObservation invalidates the automatic acquisition exhaustion fact.
    db.prepare(
      "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
    ).run(c.literatureId);
    db.exec("COMMIT");
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
    .prepare("SELECT * FROM " + table + " WHERE " + key + "=?")
    .get(values[key]);
  if (!row || columns.some((column: Dynamic) => row[column] !== values[column]))
    fail();
}
function writeLiteratureAsset(p: Dynamic): Dynamic {
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
}
function transaction(operation: Dynamic): Dynamic {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function readTransaction(operation: Dynamic): Dynamic {
  db.exec("BEGIN");
  try {
    const value = operation();
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
function runtimeTables(): Dynamic {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name",
    )
    .all()
    .map((row: Dynamic) => row.name);
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
    const names = candidate
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name",
      )
      .all()
      .map((row: Dynamic) => row.name);
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
      .prepare("SELECT * FROM execution_jobs WHERE idempotency_key=?")
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
    .prepare("SELECT * FROM execution_jobs WHERE job_id=?")
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
  const rows = db
    .prepare(
      `SELECT * FROM execution_jobs${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY ${order === "oldest" ? "created_at,job_id" : `${timeColumn} DESC,job_id DESC`} LIMIT ?`,
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
  }));
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
    db.prepare("SELECT * FROM execution_budgets WHERE job_id=?").get(jobId),
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
      .prepare("SELECT * FROM execution_budgets WHERE job_id=?")
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
function listExecutionTargets(jobId: Dynamic, limit: Dynamic): Dynamic {
  requireRuntime();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail();
  return db
    .prepare(
      "SELECT * FROM execution_targets WHERE job_id=? ORDER BY ordinal,target_id LIMIT ?",
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
      "SELECT * FROM execution_attempts WHERE target_id=? ORDER BY started_at,attempt_id LIMIT ?",
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
        "SELECT attempt_id,target_id FROM execution_attempts WHERE status='running'",
      )
      .all();
    for (const attempt of running) {
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
    db.prepare(
      "UPDATE execution_jobs SET status=?,finished_at=? WHERE job_id=? AND ((?='paused' AND status IN ('queued','running')) OR (?='cancelled' AND status IN ('queued','running','paused')))",
    ).run(status, finishedAt, jobId, status, status);
    const job = getExecutionJob(jobId);
    if (!job) fail();
    return job;
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
      .prepare("SELECT * FROM execution_targets WHERE target_id=?")
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
    .prepare("SELECT * FROM execution_targets WHERE target_id=?")
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
        "SELECT target.* FROM execution_targets target JOIN execution_jobs job ON job.job_id=target.job_id WHERE target.job_id=? AND job.status IN ('queued','running') AND target.stage='queued' AND (target.next_eligible_at IS NULL OR target.next_eligible_at<=?) AND (? IS NULL OR target.target_id=?) ORDER BY target.ordinal,target.target_id LIMIT 1",
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
      .prepare("SELECT * FROM execution_attempts WHERE attempt_id=?")
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
      .prepare("SELECT * FROM execution_attempts WHERE attempt_id=?")
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
    const expected = last.sequence === null ? 0 : Number(last.sequence) + 1;
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
    return { ...event, sequence };
  });
}
function listExecutionEvents(
  jobId: Dynamic,
  after: Dynamic,
  limit: Dynamic,
  order: Dynamic,
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
  if (order !== "oldest" && order !== "newest") fail();
  return db
    .prepare(
      order === "newest"
        ? "SELECT * FROM execution_events WHERE job_id=? AND sequence>? ORDER BY sequence DESC LIMIT ?"
        : "SELECT * FROM execution_events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?",
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
          "SELECT * FROM execution_interventions WHERE intervention_id=?",
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
      "SELECT * FROM execution_interventions WHERE job_id=? ORDER BY created_at,intervention_id LIMIT ?",
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
          "SELECT * FROM execution_interventions WHERE intervention_id=?",
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
    .prepare("SELECT * FROM document_versions WHERE document_version_id=?")
    .get(versionId);
  if (!v) return null;
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
    proofread_id: v.proofread_id,
    proofread_content_sha256: v.proofread_content_sha256,
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
      fail();
    if (v.schema_version !== 2) fail();
    {
      const proofread = db
        .prepare(
          "SELECT p.* FROM proofread_versions p JOIN proofread_current c ON c.proofread_id=p.proofread_id WHERE p.proofread_id=? AND p.part_asset_id=? AND p.part_sha256=? AND p.content_sha256=? AND p.status='complete'",
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
      if (!proofread || !binding) fail();
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
      if (manualRevision !== p.expected_manual_revision || stale) fail();
      const markdown = db
        .prepare(
          "SELECT * FROM proofread_resources WHERE proofread_id=? AND kind='markdown'",
        )
        .get(v.proofread_id);
      if (
        markdown?.sha256 !== v.markdown.sha256 ||
        markdown?.artifact_reference !== p.markdown_artifact_path
      )
        fail();
      const images = db
        .prepare(
          "SELECT * FROM proofread_resources WHERE proofread_id=? AND kind='image'",
        )
        .all(v.proofread_id);
      if (
        images.length !== v.resources.length ||
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
        fail();
    }
    const exactArtifact = (path: Dynamic, a: Dynamic): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?",
          )
          .get(path, a.sha256, a.byte_size, a.media_type)
      )
        fail();
    };
    exactArtifact(p.source_artifact_path, v.source_material_ref.artifact);
    exactArtifact(p.markdown_artifact_path, v.markdown);
    if (Object.keys(p.resource_artifact_paths).length !== v.resources.length)
      fail();
    for (const r of v.resources)
      exactArtifact(p.resource_artifact_paths[r.reference], r.artifact);
    const previousStructure = db
      .prepare("SELECT * FROM artifact_objects WHERE sha256=?")
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
      fail();
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
      if (current) {
        db.prepare(
          "UPDATE document_defaults SET document_version_id=?,revision=revision+1 WHERE document_id=? AND revision=?",
        ).run(v.document_version_id, v.document_id, current.revision);
        revision = current.revision + 1;
      } else {
        db.prepare(
          "INSERT INTO document_defaults(document_id,document_version_id,revision) VALUES(?,?,1)",
        ).run(v.document_id, v.document_version_id);
        revision = 1;
      }
      updated = true;
    }
    return {
      published: !existing,
      default_updated: updated,
      default_revision: revision,
    };
  });
}
function putProviderRelation(o: Dynamic): Dynamic {
  try {
    db.exec("BEGIN IMMEDIATE");
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
    db.exec("COMMIT");
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
  try {
    db.exec("BEGIN IMMEDIATE");
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
    db.exec("COMMIT");
    return reference ? edge : true;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure when rollback also fails.
    }
    throw e;
  }
}
function putMetadataReferenceSupport(
  referenceId: Dynamic,
  observationId: Dynamic,
  index: Dynamic,
): Dynamic {
  try {
    db.exec("BEGIN IMMEDIATE");
    const valid = db
      .prepare(
        "SELECT 1 FROM literature_references r JOIN literature_metadata_observations owner ON owner.literature_id=r.source_literature_id JOIN metadata_observation_reference_texts text ON text.observation_id=owner.observation_id AND text.reference_index=? WHERE r.reference_id=? AND owner.observation_id=?",
      )
      .get(index, referenceId, observationId);
    if (!valid) fail();
    db.prepare(
      "INSERT INTO metadata_reference_text_supports(reference_id,metadata_observation_id,reference_index) VALUES(?,?,?) ON CONFLICT DO NOTHING",
    ).run(referenceId, observationId, index);
    db.exec("COMMIT");
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
        "SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE EXISTS(SELECT 1 FROM provider_relation_reference_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM metadata_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM archive_reference_text_supports s JOIN document_defaults f ON f.document_version_id=s.document_version_id JOIN structure_annotation_current c ON c.document_version_id=s.document_version_id AND c.annotation_id=s.annotation_id JOIN document_versions d ON d.document_version_id=s.document_version_id JOIN literature_assets l ON l.literature_id=d.literature_id AND l.asset_id=d.source_asset_id AND l.role='primary-pdf' WHERE s.reference_id=literature_references.reference_id) ORDER BY source_literature_id,target_literature_id,reference_id",
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
      "SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE " +
        where,
    )
    .all(selection.reference_id ?? selection.literature_id);
  const result = [];
  for (const reference of rows) {
    const source = searchItem(reference.source_literature_id),
      target = searchItem(reference.target_literature_id);
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
    const meta_literature = db
      .prepare(
        "SELECT meta_literature_id,representative_literature_id FROM meta_literatures WHERE meta_literature_id=?",
      )
      .get(literature.meta_literature_id);
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
    const assets = db
      .prepare(
        "SELECT literature_asset_id,literature_id,asset_id,role,provenance_id,source_url FROM literature_assets WHERE literature_id=? ORDER BY role,literature_asset_id",
      )
      .all(id)
      .map(({ provenance_id, ...relation }: Dynamic) => ({
        asset: getAsset(relation.asset_id),
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
      }));
    const primary = assets.filter(
      (a: Dynamic) => a.literature_asset.role === "primary-pdf",
    );
    if (primary.length > 1) fail();
    const primary_pdf = primary[0] || null;
    const other_versions = db
      .prepare(
        "SELECT literature_id FROM literatures WHERE meta_literature_id=? AND literature_id<>? ORDER BY CASE version_role WHEN 'published' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE 3 END,literature_id",
      )
      .all(literature.meta_literature_id, id)
      .map((row: Dynamic) => searchItem(row.literature_id));
    const detail = {
      ...searchItem(id),
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
  db.exec("BEGIN IMMEDIATE");
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
    db.exec("COMMIT");
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
            "SELECT literature_id FROM citation_discovery_seeds WHERE discovery_run_id=? ORDER BY seed_ordinal",
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
      "SELECT meta_literature_id FROM discovery_results WHERE discovery_run_id=? ORDER BY meta_literature_id",
    )
    .all(id);
  const topic_causes = db
    .prepare(
      "SELECT meta_literature_id,metadata_observation_id,actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id=? ORDER BY meta_literature_id,metadata_observation_id",
    )
    .all(id);
  const citation_causes = db
    .prepare(
      "SELECT meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth FROM citation_discovery_causes WHERE discovery_run_id=? ORDER BY depth,source_literature_id,target_literature_id",
    )
    .all(id);
  return {
    run: {
      ...run,
      ...input,
      ...(run.kind === "citation" ? { seed_literature_ids: seeds } : {}),
    },
    providers,
    source_results,
    results,
    topic_causes,
    citation_causes,
  };
}
function putDiscovery(p: Dynamic): Dynamic {
  return transaction(() => {
    if (
      !p ||
      !p.run ||
      !Array.isArray(p.providers) ||
      !Array.isArray(p.source_results) ||
      !Array.isArray(p.results) ||
      !Array.isArray(p.topic_causes) ||
      !Array.isArray(p.citation_causes)
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
    if (
      !saved ||
      saved.kind !== r.kind ||
      saved.status !== r.status ||
      saved.started_at !== r.started_at
    )
      fail();
    if (r.kind === "topic") {
      db.prepare(
        "INSERT INTO topic_discovery_inputs(discovery_run_id,kind,query,year_from,year_to) VALUES(?,'topic',?,?,?) ON CONFLICT(discovery_run_id) DO NOTHING",
      ).run(
        r.discovery_run_id,
        r.query,
        r.year_from ?? null,
        r.year_to ?? null,
      );
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
        "INSERT INTO discovery_run_providers(discovery_run_id,provider_ordinal,provider_name,scan_limit) VALUES(?,?,?,?) ON CONFLICT(discovery_run_id,provider_ordinal) DO NOTHING",
      ).run(r.discovery_run_id, i, x.provider_name, x.scan_limit);
    }
    for (const x of p.source_results) {
      const f = x.failure;
      db.prepare(
        "INSERT INTO discovery_source_results(discovery_run_id,provider_name,outcome,failure_code,failure_reason,failure_action,failure_retryable) VALUES(?,?,?,?,?,?,?) ON CONFLICT(discovery_run_id,provider_name) DO NOTHING",
      ).run(
        r.discovery_run_id,
        x.provider_name,
        x.outcome,
        f?.code ?? null,
        f?.reason ?? null,
        f?.action ?? null,
        f?.retryable === undefined ? null : Number(f.retryable),
      );
    }
    for (const x of p.results)
      db.prepare(
        "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?) ON CONFLICT(discovery_run_id,meta_literature_id) DO NOTHING",
      ).run(r.discovery_run_id, x.meta_literature_id);
    for (const x of p.topic_causes)
      db.prepare(
        "INSERT INTO topic_discovery_causes(discovery_run_id,meta_literature_id,metadata_observation_id,actual_literature_id) VALUES(?,?,?,?) ON CONFLICT(discovery_run_id,meta_literature_id,metadata_observation_id) DO NOTHING",
      ).run(
        r.discovery_run_id,
        x.meta_literature_id,
        x.metadata_observation_id,
        x.actual_literature_id,
      );
    for (const x of p.citation_causes)
      db.prepare(
        "INSERT INTO citation_discovery_causes(discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth) VALUES(?,?,?,?,?,?) ON CONFLICT(discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,depth) DO NOTHING",
      ).run(
        r.discovery_run_id,
        x.meta_literature_id,
        x.source_literature_id,
        x.target_literature_id,
        x.actual_literature_id,
        x.depth,
      );
    validateDiscoveryCauses([r.discovery_run_id]);
    return getDiscovery(r.discovery_run_id);
  });
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
port.on("message", (message: WorkerMessage) => {
  try {
    if (message.command.kind === "close") {
      retrievalEngine?.close();
      db?.close();
      port.postMessage({ id: message.id, ok: true, value: true });
      return;
    }
    if (message.command.kind === "retrieval") {
      let value;
      try {
        if (!db) initialize();
        const engine = getRetrievalEngine();
        const { operation, args } = message.command;
        if (
          data.read_only &&
          ["beginGeneration", "insertEntries", "publish"].includes(operation)
        )
          fail();
        const allowed = [
          "revision",
          "metadataPage",
          "documentPage",
          "beginGeneration",
          "insertEntries",
          "publish",
          "active",
          "search",
          "documentCoverage",
          "metadataSource",
          "hasDefault",
        ];
        if (!allowed.includes(operation) || !Array.isArray(args)) fail();
        value = {
          ok: true,
          value: Reflect.apply(engine[operation], engine, args),
        };
      } catch (error) {
        value = {
          ok: false,
          code:
            error && typeof error === "object" && "code" in error
              ? error.code
              : "index-corrupt",
        };
      }
      port.postMessage({ id: message.id, ok: true, value });
      return;
    }
    if (!db) initialize();
    else {
      // FTS5 may retain an obsolete index view on a long-lived SQLite
      // connection after another connection commits. Refresh only between
      // commands; initialize repeats the original read-only/schema gate.
      const current = Number(
        db.prepare("PRAGMA data_version").get().data_version,
      );
      if (current !== observedDataVersion) {
        db.close();
        db = undefined;
        queryPreflight = null;
        initialize();
      }
    }
    if (
      data.read_only &&
      message.command.kind !== "query_preflight" &&
      queryPreflight?.status !== "ready"
    )
      fail();
    let value;
    switch (message.command.kind) {
      case "snapshot":
        try {
          value = {
            ok: true,
            value: snapshotModule.runSnapshotStorage(
              db,
              message.command.action,
              message.command.args,
              data.max_tags,
              data.archive_profile,
            ),
          };
        } catch (error) {
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
              data.max_tags,
              data.archive_profile,
            ),
          };
        } catch (error) {
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
        value = readTransaction(() => ({
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
        }));
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
        );
        break;
      case "execution_get_job":
        value = getExecutionJob(message.command.jobId);
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
        );
        break;
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
      case "library_search_page":
        value = librarySearchPage(message.command.request);
        break;
      case "library_snapshot":
        value = librarySnapshot(
          message.command.ftsQuery,
          message.command.discoveryRunIds,
          message.command.includeOtherVersions,
          message.command.literatureIds,
          message.command.metaLiteratureIds,
          message.command.tags,
        );
        break;
      case "candidate_cleanup_snapshot":
        value = transaction(candidateCleanupSnapshot);
        break;
      case "artifact_reclamation_snapshot":
        value = artifactReclamationSnapshot(message.command.reference);
        break;
      case "literature_detail_snapshot":
        value = literatureDetailSnapshot(message.command.literatureId);
        break;
      case "locate_artifact":
        value = locateArtifact(message.command.value);
        break;
      case "reference_query_snapshot":
        value = referenceQuerySnapshot(message.command.selection);
        break;
      case "put_discovery":
        value = putDiscovery(message.command.publication);
        break;
      case "get_discovery":
        value = getDiscovery(message.command.discoveryRunId);
        break;
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
      case "find_literature_by_identifiers":
        value = findLiteratureByIdentifiers(message.command.identifiers);
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
      case "publish_identity_observation":
        value = publishIdentityObservation(message.command.publication);
        break;
      case "accept_observation":
        value = acceptObservation(message.command);
        break;
      case "snapshot_counts":
        value = counts();
        break;
      default:
        fail();
    }
    port.postMessage({ id: message.id, ok: true, value });
  } catch {
    port.postMessage({ id: message.id, ok: false, value: null });
  }
});
