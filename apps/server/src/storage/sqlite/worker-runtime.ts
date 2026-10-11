import { createHash, randomUUID } from "node:crypto";
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
  readonly case_fold: Readonly<Record<string, string>>;
  readonly schema_manifest: readonly string[];
  readonly schema_fingerprint: string;
  readonly schema_identity_v2: string;
  readonly schema_v2_version: number;
  readonly schema_v2_fingerprint: string;
  readonly schema_v3_version: number;
  readonly schema_v3_fingerprint: string;
  readonly schema_v3_manifest: readonly string[];
  readonly schema_v4_version: number;
  readonly schema_v4_fingerprint: string;
  readonly schema_v4_manifest: readonly string[];
  readonly schema_v5_version: number;
  readonly schema_v5_fingerprint: string;
  readonly schema_v5_manifest: readonly string[];
  readonly schema_v6_version: number;
  readonly schema_v6_fingerprint: string;
  readonly schema_v6_manifest: readonly string[];
  readonly schema_v7_version: number;
  readonly schema_v7_fingerprint: string;
  readonly schema_v7_manifest: readonly string[];
  readonly schema_v9_version: number;
  readonly schema_v9_fingerprint: string;
  readonly schema_v9_manifest: readonly string[];
  readonly schema_v8_version: number;
  readonly schema_v8_fingerprint: string;
  readonly schema_v8_manifest: readonly string[];
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
const port = parentPort;
if (!port) throw new Error("sqlite worker parent port is unavailable");
const CASE_FOLD = data.case_fold;
const SCHEMA_MANIFEST = data.schema_manifest;
const SCHEMA_FINGERPRINT = data.schema_fingerprint;
const SCHEMA_IDENTITY_V2 = data.schema_identity_v2;
const SCHEMA_V2_VERSION = data.schema_v2_version;
const SCHEMA_V2_FINGERPRINT = data.schema_v2_fingerprint;
const SCHEMA_V3_VERSION = data.schema_v3_version;
const SCHEMA_V3_FINGERPRINT = data.schema_v3_fingerprint;
const SCHEMA_V3_MANIFEST = data.schema_v3_manifest;
const SCHEMA_V4_VERSION = data.schema_v4_version;
const SCHEMA_V4_FINGERPRINT = data.schema_v4_fingerprint;
const SCHEMA_V4_MANIFEST = data.schema_v4_manifest;
const SCHEMA_V5_VERSION = data.schema_v5_version;
const SCHEMA_V5_FINGERPRINT = data.schema_v5_fingerprint;
const SCHEMA_V5_MANIFEST = data.schema_v5_manifest;
const SCHEMA_V6_VERSION = data.schema_v6_version;
const SCHEMA_V6_FINGERPRINT = data.schema_v6_fingerprint;
const SCHEMA_V6_MANIFEST = data.schema_v6_manifest;
const SCHEMA_V7_VERSION = data.schema_v7_version;
const SCHEMA_V7_FINGERPRINT = data.schema_v7_fingerprint;
const SCHEMA_V7_MANIFEST = data.schema_v7_manifest;
const SCHEMA_V9_VERSION = data.schema_v9_version;
const SCHEMA_V9_FINGERPRINT = data.schema_v9_fingerprint;
const SCHEMA_V9_MANIFEST = data.schema_v9_manifest;
const SCHEMA_V8_VERSION = data.schema_v8_version;
const SCHEMA_V8_FINGERPRINT = data.schema_v8_fingerprint;
const SCHEMA_V8_MANIFEST = data.schema_v8_manifest;
const EXECUTION_SCHEMA = data.execution_schema;
const EXECUTION_SCHEMA_VERSION = data.execution_schema_version;
const EXECUTION_SCHEMA_FINGERPRINT = data.execution_schema_fingerprint;
const EXECUTION_RUNTIME_SCHEMA = data.execution_runtime_schema;
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
const knowledgeModule = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./knowledge-engine.ts"
      : "./knowledge-engine.js",
    import.meta.url,
  ).href
);
let retrievalEngine: RetrievalStorageEngine | undefined;
function getRetrievalEngine(): RetrievalStorageEngine {
  const identity = db
    .prepare("SELECT schema_version FROM schema_identity WHERE singleton=1")
    .get();
  const v6 = identity?.schema_version === SCHEMA_V6_VERSION;
  const v7 = identity?.schema_version === SCHEMA_V7_VERSION;
  const v9 = identity?.schema_version === SCHEMA_V9_VERSION;
  const v8 = identity?.schema_version === SCHEMA_V8_VERSION;
  const v5 = identity?.schema_version === SCHEMA_V5_VERSION;
  return (retrievalEngine ??= new retrievalModule.RetrievalStorageEngine(
    data.path,
    data.read_only,
    {
      schema_version: v9 ? 9 : v8 ? 8 : v7 ? 7 : v6 ? 6 : v5 ? 5 : 4,
      schema_fingerprint: v9
        ? SCHEMA_V9_FINGERPRINT
        : v8
          ? SCHEMA_V8_FINGERPRINT
          : v7
            ? SCHEMA_V7_FINGERPRINT
            : v6
              ? SCHEMA_V6_FINGERPRINT
              : v5
                ? SCHEMA_V5_FINGERPRINT
                : SCHEMA_V4_FINGERPRINT,
      schema_manifest: v9
        ? SCHEMA_V9_MANIFEST
        : v8
          ? SCHEMA_V8_MANIFEST
          : v7
            ? SCHEMA_V7_MANIFEST
            : v6
              ? SCHEMA_V6_MANIFEST
              : v5
                ? SCHEMA_V5_MANIFEST
                : SCHEMA_V4_MANIFEST,
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

function deriveCurrentState(facts: Dynamic): {
  readonly status: "UNREVIEWED" | "ASSET_READY" | "CONTENT_READY";
  readonly missing_step:
    | "primary-pdf"
    | "parser-result"
    | "literature-content"
    | null;
} {
  const primary = facts.primary;
  if (!primary || primary.media_type !== "application/pdf")
    return { status: "UNREVIEWED", missing_step: "primary-pdf" };
  const content = facts.content;
  const ready =
    !!content &&
    content.metadata_revision === facts.metadata_revision &&
    content.metadata_sha256 === facts.metadata_sha256 &&
    content.primary_asset_id === primary.asset_id &&
    content.primary_asset_sha256 === primary.sha256 &&
    content.source_kind === "analysis" &&
    content.input_sha256 === content.expected_input_sha256;
  const parser = facts.parser;
  return {
    status: ready ? "CONTENT_READY" : "ASSET_READY",
    missing_step:
      !parser ||
      parser.source_asset_id !== primary.asset_id ||
      parser.source_sha256 !== primary.sha256
        ? "parser-result"
        : ready
          ? null
          : "literature-content",
  };
}

let db: Dynamic;
let observedDataVersion: number | null = null;
let queryPreflight: {
  readonly status: "ready" | "not-initialized" | "unavailable";
  readonly schema: Dynamic | null;
} | null = null;
const schema = SCHEMA_MANIFEST;
const EXHAUSTION_COMMAND_KEYS = "kind,literatureId";
const EXHAUSTION_LITERATURE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(): never {
  throw new Error("sqlite worker operation failed");
}
function validDocumentSchema(version: number): boolean {
  try {
    const names = new Set<string>();
    const manifest =
      version === SCHEMA_V9_VERSION
        ? SCHEMA_V9_MANIFEST
        : version === SCHEMA_V3_VERSION
          ? SCHEMA_V3_MANIFEST
          : version === SCHEMA_V4_VERSION
            ? SCHEMA_V4_MANIFEST
            : version === SCHEMA_V5_VERSION
              ? SCHEMA_V5_MANIFEST
              : version === SCHEMA_V6_VERSION
                ? SCHEMA_V6_MANIFEST
                : version === SCHEMA_V7_VERSION
                  ? SCHEMA_V7_MANIFEST
                  : version === SCHEMA_V8_VERSION
                    ? SCHEMA_V8_MANIFEST
                    : null;
    if (!manifest) return false;
    for (const sql of manifest) {
      const name =
        /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER) ([a-z_][a-z0-9_]*)/.exec(
          sql,
        )?.[1];
      if (!name) return false;
      names.add(name);
      // These exact known objects belong to the derived Context projection.
      // Its own inspector checks their DDL; source readers need only their
      // names whitelisted so a missing/damaged projection index cannot hide
      // otherwise valid Literature and Document facts.
      if (
        data.read_only &&
        (version === SCHEMA_V4_VERSION ||
          version === SCHEMA_V5_VERSION ||
          version === SCHEMA_V6_VERSION ||
          version === SCHEMA_V7_VERSION ||
          version === SCHEMA_V8_VERSION ||
          version === SCHEMA_V9_VERSION) &&
        (name.startsWith("retrieval_") ||
          name.startsWith("knowledge_retrieval_"))
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
    if (
      version === SCHEMA_V4_VERSION ||
      version === SCHEMA_V5_VERSION ||
      version === SCHEMA_V6_VERSION ||
      version === SCHEMA_V7_VERSION ||
      version === SCHEMA_V8_VERSION ||
      version === SCHEMA_V9_VERSION
    )
      for (const suffix of ["data", "idx", "content", "docsize", "config"])
        names.add(`retrieval_fts_${suffix}`);
    if (version === SCHEMA_V8_VERSION || version === SCHEMA_V9_VERSION)
      for (const suffix of ["data", "idx", "content", "docsize", "config"])
        names.add(`knowledge_retrieval_fts_${suffix}`);
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all()
        .some((row: Dynamic) => !names.has(row.name))
    )
      return false;
    if (
      version === SCHEMA_V4_VERSION ||
      version === SCHEMA_V5_VERSION ||
      version === SCHEMA_V6_VERSION ||
      version === SCHEMA_V7_VERSION ||
      version === SCHEMA_V8_VERSION ||
      version === SCHEMA_V9_VERSION
    ) {
      // Retrieval is a rebuildable projection. Its damaged FTS postings must
      // not block Library and Document source reads needed to repair it.
      for (const sql of manifest) {
        const table = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/.exec(
          sql,
        )?.[1];
        if (
          !table ||
          table.startsWith("retrieval_") ||
          table.startsWith("knowledge_retrieval_")
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
  db = data.read_only
    ? new DatabaseSync(data.path, { readOnly: true })
    : new DatabaseSync(data.path);
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
    for (const statement of schema) db.exec(statement);
    db.prepare(
      "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,?,?,?,?)",
    ).run("sciretriever", 1, SCHEMA_FINGERPRINT, new Date().toISOString());
  } else if (
    existing.product !== "sciretriever" ||
    !(
      (existing.schema_version === 1 &&
        existing.schema_fingerprint === SCHEMA_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V2_VERSION &&
        existing.schema_fingerprint === SCHEMA_V2_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V3_VERSION &&
        existing.schema_fingerprint === SCHEMA_V3_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V4_VERSION &&
        existing.schema_fingerprint === SCHEMA_V4_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V5_VERSION &&
        existing.schema_fingerprint === SCHEMA_V5_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V6_VERSION &&
        existing.schema_fingerprint === SCHEMA_V6_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V7_VERSION &&
        existing.schema_fingerprint === SCHEMA_V7_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V8_VERSION &&
        existing.schema_fingerprint === SCHEMA_V8_FINGERPRINT) ||
      (existing.schema_version === SCHEMA_V9_VERSION &&
        existing.schema_fingerprint === SCHEMA_V9_FINGERPRINT)
    )
  )
    fail();
  if (
    (existing?.schema_version === SCHEMA_V3_VERSION ||
      existing?.schema_version === SCHEMA_V4_VERSION ||
      existing?.schema_version === SCHEMA_V5_VERSION ||
      existing?.schema_version === SCHEMA_V6_VERSION ||
      existing?.schema_version === SCHEMA_V7_VERSION ||
      existing?.schema_version === SCHEMA_V8_VERSION ||
      existing?.schema_version === SCHEMA_V9_VERSION) &&
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
        (identity.schema_version === 1 &&
          identity.schema_fingerprint === SCHEMA_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V2_VERSION &&
          identity.schema_fingerprint === SCHEMA_V2_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V3_VERSION &&
          identity.schema_fingerprint === SCHEMA_V3_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V4_VERSION &&
          identity.schema_fingerprint === SCHEMA_V4_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V5_VERSION &&
          identity.schema_fingerprint === SCHEMA_V5_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V6_VERSION &&
          identity.schema_fingerprint === SCHEMA_V6_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V7_VERSION &&
          identity.schema_fingerprint === SCHEMA_V7_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V8_VERSION &&
          identity.schema_fingerprint === SCHEMA_V8_FINGERPRINT) ||
        (identity.schema_version === SCHEMA_V9_VERSION &&
          identity.schema_fingerprint === SCHEMA_V9_FINGERPRINT)
      )
    )
      return { status: "unavailable", schema: null };
    if (
      (identity.schema_version === SCHEMA_V3_VERSION ||
        identity.schema_version === SCHEMA_V4_VERSION ||
        identity.schema_version === SCHEMA_V5_VERSION ||
        identity.schema_version === SCHEMA_V6_VERSION ||
        identity.schema_version === SCHEMA_V7_VERSION ||
        identity.schema_version === SCHEMA_V8_VERSION ||
        identity.schema_version === SCHEMA_V9_VERSION) &&
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
    "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id) DO UPDATE SET metadata_revision=excluded.metadata_revision,metadata_sha256=excluded.metadata_sha256,title=excluded.title,abstract=excluded.abstract,publication_date=excluded.publication_date,publication_year=excluded.publication_year,document_type=excluded.document_type,language=excluded.language,venue=excluded.venue,publisher=excluded.publisher,volume=excluded.volume,issue=excluded.issue,pages=excluded.pages",
  ).run(
    literatureId,
    revision,
    metadataSha256,
    m.title,
    m.abstract,
    m.publication_date,
    m.publication_year,
    m.document_type,
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
      "SELECT title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages FROM literature_metadata WHERE literature_id=?",
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
      "SELECT l.literature_id,l.meta_literature_id,l.version_role,m.title,m.abstract,m.publication_date,m.publication_year,m.document_type,m.language,m.venue,m.publisher,m.volume,m.issue,m.pages FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE l.literature_id IN (SELECT value FROM json_each(?)) ORDER BY l.literature_id",
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
function stateEvidence(id: Dynamic): Dynamic {
  const metadata = db
    .prepare(
      "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
    )
    .get(id);
  if (!metadata) fail();
  const primary =
    db
      .prepare(
        "SELECT a.asset_id,a.sha256,a.media_type FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'",
      )
      .get(id) || null;
  const parser = primary
    ? db
        .prepare(
          "SELECT source_asset_id,source_sha256 FROM parser_results WHERE source_asset_id=?",
        )
        .get(primary.asset_id) || null
    : null;
  const content =
    db
      .prepare(
        "SELECT c.metadata_revision,c.metadata_sha256,c.primary_asset_id,c.primary_asset_sha256,c.parser_result_sha256,p.source_kind,p.input_sha256 FROM literature_contents c JOIN provenances p ON p.provenance_id=c.analysis_provenance_id WHERE c.literature_id=?",
      )
      .get(id) || null;
  if (content)
    content.expected_input_sha256 = createHash("sha256")
      .update(
        JSON.stringify({
          metadata_sha256: metadata.metadata_sha256,
          parser_result_sha256: content.parser_result_sha256,
          primary_pdf_sha256: primary?.sha256 || "",
          schema: "sciretriever-literature-content-input-v1",
        }),
      )
      .digest("hex");
  return deriveCurrentState({ ...metadata, primary, parser, content });
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
    if (
      includeOtherVersions &&
      (ftsQuery !== null || discoveryRunIds.length || literatureIds.length)
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
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
    "INSERT INTO metadata_observations(observation_id,provenance_id,version_role,reference_count,cited_by_count,title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_id) DO NOTHING",
  ).run(
    o.observation_id,
    p.provenance_id,
    o.version_role,
    o.reference_count,
    o.cited_by_count,
    o.metadata.title,
    o.metadata.abstract,
    o.metadata.publication_date,
    o.metadata.publication_year,
    o.metadata.document_type,
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
      "SELECT observation_id,provenance_id,version_role,reference_count,cited_by_count,title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages FROM metadata_observations WHERE observation_id=?",
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
      document_type: row.document_type,
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
          stateEvidence(literature.literature_id).status === "CONTENT_READY",
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
        "SELECT title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages FROM metadata_observations WHERE observation_id=?",
      )
      .get(c.observationId);
    if (!observation) fail();
    db.prepare(
      "UPDATE literature_metadata SET metadata_revision=metadata_revision+1,metadata_sha256=?,title=?,abstract=?,publication_date=?,publication_year=?,document_type=?,language=?,venue=?,publisher=?,volume=?,issue=?,pages=? WHERE literature_id=?",
    ).run(
      c.nextMetadataSha256,
      observation.title,
      observation.abstract,
      observation.publication_date,
      observation.publication_year,
      observation.document_type,
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
const executionSchema = EXECUTION_SCHEMA;
const executionRuntimeSchema = EXECUTION_RUNTIME_SCHEMA;
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
      ((catalog.schema_version === SCHEMA_V2_VERSION &&
        catalog.schema_fingerprint === SCHEMA_V2_FINGERPRINT) ||
        (catalog.schema_version === SCHEMA_V3_VERSION &&
          catalog.schema_fingerprint === SCHEMA_V3_FINGERPRINT) ||
        (catalog.schema_version === SCHEMA_V4_VERSION &&
          catalog.schema_fingerprint === SCHEMA_V4_FINGERPRINT) ||
        (catalog.schema_version === SCHEMA_V5_VERSION &&
          catalog.schema_fingerprint === SCHEMA_V5_FINGERPRINT) ||
        (catalog.schema_version === SCHEMA_V6_VERSION &&
          catalog.schema_fingerprint === SCHEMA_V6_FINGERPRINT) ||
        (catalog.schema_version === SCHEMA_V7_VERSION &&
          catalog.schema_fingerprint === SCHEMA_V7_FINGERPRINT) ||
        (catalog.schema_version === SCHEMA_V8_VERSION &&
          catalog.schema_fingerprint === SCHEMA_V8_FINGERPRINT) ||
        (catalog.schema_version === SCHEMA_V9_VERSION &&
          catalog.schema_fingerprint === SCHEMA_V9_FINGERPRINT)) &&
      !!identity &&
      identity.version === EXECUTION_RUNTIME_SCHEMA_VERSION &&
      identity.fingerprint === EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
    tables: names,
    counts,
  };
}
function migrationReceipt(action: Dynamic, fromVersion: Dynamic): Dynamic {
  return {
    migration_id: "catalog-v2-" + randomUUID(),
    action,
    from_version: fromVersion,
    to_version: SCHEMA_V2_VERSION,
    manifest_fingerprint: SCHEMA_V2_FINGERPRINT,
    applied_at: new Date().toISOString(),
    inspection: runtimeInspect(),
  };
}
function migrateRuntime(dryRun: Dynamic): Dynamic {
  const current = runtimeInspect();
  if (dryRun) return migrationReceipt("dry-run", current.catalog_version);
  if (current.migrated) {
    const existing = db
      .prepare(
        "SELECT migration_id,action,from_version,to_version,manifest_fingerprint,applied_at FROM execution_schema_migrations WHERE to_version=? AND action='migrate' ORDER BY applied_at DESC LIMIT 1",
      )
      .get(SCHEMA_V2_VERSION);
    if (existing) return { ...existing, inspection: current };
  }
  if (
    current.catalog_version !== 1 ||
    current.catalog_fingerprint !== SCHEMA_FINGERPRINT
  )
    fail();
  return transaction(() => {
    for (const statement of executionSchema) db.exec(statement);
    db.prepare(
      "INSERT INTO execution_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
    ).run(EXECUTION_SCHEMA_VERSION, EXECUTION_SCHEMA_FINGERPRINT);
    for (const statement of executionRuntimeSchema) db.exec(statement);
    db.prepare(
      "INSERT INTO execution_runtime_schema_identity(singleton,version,fingerprint) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,fingerprint=excluded.fingerprint",
    ).run(
      EXECUTION_RUNTIME_SCHEMA_VERSION,
      EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
    );
    const createdAt = db
      .prepare("SELECT created_at FROM schema_identity WHERE singleton=1")
      .get()?.created_at;
    if (typeof createdAt !== "string" || !createdAt.trim()) fail();
    db.exec("DROP TABLE schema_identity");
    db.exec(SCHEMA_IDENTITY_V2);
    db.prepare(
      "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',?,?,?)",
    ).run(SCHEMA_V2_VERSION, SCHEMA_V2_FINGERPRINT, createdAt);
    const receipt = migrationReceipt("migrate", current.catalog_version);
    db.prepare(
      "INSERT INTO execution_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,action,applied_at) VALUES(?,?,?,?,?,?)",
    ).run(
      receipt.migration_id,
      receipt.from_version,
      receipt.to_version,
      receipt.manifest_fingerprint,
      receipt.action,
      receipt.applied_at,
    );
    return { ...receipt, inspection: runtimeInspect() };
  });
}
function upgradeExecution(): Dynamic {
  migrateRuntime(false);
  requireExecution();
  requireRuntime();
  return true;
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
        (schema.schema_version === 1 &&
          schema.schema_fingerprint === SCHEMA_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V2_VERSION &&
          schema.schema_fingerprint === SCHEMA_V2_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V3_VERSION &&
          schema.schema_fingerprint === SCHEMA_V3_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V4_VERSION &&
          schema.schema_fingerprint === SCHEMA_V4_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V5_VERSION &&
          schema.schema_fingerprint === SCHEMA_V5_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V6_VERSION &&
          schema.schema_fingerprint === SCHEMA_V6_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V7_VERSION &&
          schema.schema_fingerprint === SCHEMA_V7_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V8_VERSION &&
          schema.schema_fingerprint === SCHEMA_V8_FINGERPRINT) ||
        (schema.schema_version === SCHEMA_V9_VERSION &&
          schema.schema_fingerprint === SCHEMA_V9_FINGERPRINT)
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
          ((schema.schema_version === SCHEMA_V2_VERSION &&
            schema.schema_fingerprint === SCHEMA_V2_FINGERPRINT) ||
            (schema.schema_version === SCHEMA_V3_VERSION &&
              schema.schema_fingerprint === SCHEMA_V3_FINGERPRINT) ||
            (schema.schema_version === SCHEMA_V4_VERSION &&
              schema.schema_fingerprint === SCHEMA_V4_FINGERPRINT) ||
            (schema.schema_version === SCHEMA_V5_VERSION &&
              schema.schema_fingerprint === SCHEMA_V5_FINGERPRINT) ||
            (schema.schema_version === SCHEMA_V6_VERSION &&
              schema.schema_fingerprint === SCHEMA_V6_FINGERPRINT) ||
            (schema.schema_version === SCHEMA_V7_VERSION &&
              schema.schema_fingerprint === SCHEMA_V7_FINGERPRINT) ||
            (schema.schema_version === SCHEMA_V8_VERSION &&
              schema.schema_fingerprint === SCHEMA_V8_FINGERPRINT) ||
            (schema.schema_version === SCHEMA_V9_VERSION &&
              schema.schema_fingerprint === SCHEMA_V9_FINGERPRINT)) &&
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
function rollbackExecution(backupPath: Dynamic): Dynamic {
  const current = runtimeInspect();
  if (current.catalog_version !== SCHEMA_V2_VERSION) fail();
  requireExecution();
  backupExecution(backupPath);
  return transaction(() => {
    const runtime = runtimeTables();
    for (const table of [
      "execution_leases",
      "execution_interventions",
      "execution_events",
      "execution_attempts",
      "execution_targets",
      "execution_budgets",
      "execution_policy_snapshots",
      "execution_jobs",
      "execution_schema_migrations",
      "execution_runtime_schema_identity",
    ]) {
      if (runtime.includes(table)) db.exec("DROP TABLE " + table);
    }
    db.exec(
      "DROP TABLE execution_receipts; DROP TABLE execution_candidates; DROP TABLE execution_schema_identity;",
    );
    const createdAt = db
      .prepare("SELECT created_at FROM schema_identity WHERE singleton=1")
      .get()?.created_at;
    if (typeof createdAt !== "string" || !createdAt.trim()) fail();
    db.exec("DROP TABLE schema_identity");
    db.exec(SCHEMA_MANIFEST[0]);
    db.prepare(
      "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',1,?,?)",
    ).run(SCHEMA_FINGERPRINT, createdAt);
    return true;
  });
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
function listExecutionJobs(limit: Dynamic): Dynamic {
  requireRuntime();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail();
  return db
    .prepare("SELECT * FROM execution_jobs ORDER BY created_at,job_id LIMIT ?")
    .all(limit)
    .map((row: Dynamic) => ({
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
  return db
    .prepare(
      "SELECT * FROM execution_events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?",
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
function currentParser(sourceId: Dynamic): Dynamic {
  const p = db
    .prepare("SELECT * FROM parser_results WHERE source_asset_id=?")
    .get(sourceId);
  if (!p) return null;
  const provenance = (id: Dynamic) =>
    db
      .prepare(
        "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
      )
      .get(id);
  return {
    source_asset_id: p.source_asset_id,
    source_sha256: p.source_sha256,
    page_count: p.page_count,
    result_sha256: p.result_sha256,
    markdown: {
      sha256: p.markdown_sha256,
      media_type: p.markdown_media_type,
      byte_size: p.markdown_byte_size,
    },
    resources: db
      .prepare(
        "SELECT reference,artifact_sha256,artifact_media_type,artifact_byte_size FROM parser_result_resources WHERE source_asset_id=? ORDER BY reference",
      )
      .all(p.source_asset_id)
      .map((r: Dynamic) => ({
        reference: r.reference,
        artifact: {
          sha256: r.artifact_sha256,
          media_type: r.artifact_media_type,
          byte_size: r.artifact_byte_size,
        },
      })),
    provenance: {
      provenance: provenance(p.provenance_id),
      parser_version: p.parser_version,
      mode: p.mode,
      model_identity: p.model_identity,
    },
  };
}
function requireDocumentV3(): void {
  const row = db
    .prepare(
      "SELECT schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get();
  if (
    !(
      (row?.schema_version === SCHEMA_V3_VERSION &&
        row.schema_fingerprint === SCHEMA_V3_FINGERPRINT) ||
      (row?.schema_version === SCHEMA_V4_VERSION &&
        row.schema_fingerprint === SCHEMA_V4_FINGERPRINT) ||
      (row?.schema_version === SCHEMA_V5_VERSION &&
        row.schema_fingerprint === SCHEMA_V5_FINGERPRINT) ||
      (row?.schema_version === SCHEMA_V6_VERSION &&
        row.schema_fingerprint === SCHEMA_V6_FINGERPRINT) ||
      (row?.schema_version === SCHEMA_V7_VERSION &&
        row.schema_fingerprint === SCHEMA_V7_FINGERPRINT) ||
      (row?.schema_version === SCHEMA_V8_VERSION &&
        row.schema_fingerprint === SCHEMA_V8_FINGERPRINT) ||
      (row?.schema_version === SCHEMA_V9_VERSION &&
        row.schema_fingerprint === SCHEMA_V9_FINGERPRINT)
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
    db
      .prepare("SELECT schema_version FROM schema_identity WHERE singleton=1")
      .get()?.schema_version !== SCHEMA_V9_VERSION
  )
    return null;
  const row = db
    .prepare(
      "SELECT i.assessment_json FROM article_identity_assessments i JOIN literature_metadata m ON m.literature_id=i.literature_id AND m.metadata_revision=i.metadata_revision AND m.metadata_sha256=i.metadata_sha256 JOIN literature_assets a ON a.literature_id=i.literature_id AND a.asset_id=i.asset_id JOIN document_versions d ON d.document_version_id=i.document_version_id JOIN parser_results p ON p.source_asset_id=i.asset_id AND p.source_sha256=i.asset_sha256 AND p.result_sha256=d.parser_result_sha256 WHERE i.literature_id=? AND i.asset_id=? ORDER BY i.created_at DESC,i.assessment_id DESC LIMIT 1",
    )
    .get(literatureId, assetId);
  return row ? JSON.parse(row.assessment_json) : null;
}
function articleIdentityGet(id: Dynamic): Dynamic {
  if (
    db
      .prepare("SELECT schema_version FROM schema_identity WHERE singleton=1")
      .get()?.schema_version !== SCHEMA_V9_VERSION
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
    db
      .prepare("SELECT schema_version FROM schema_identity WHERE singleton=1")
      .get()?.schema_version !== SCHEMA_V9_VERSION
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
function documentInput(material: Dynamic): Dynamic {
  requireDocumentV3();
  return readTransaction(() => documentInputSnapshot(material));
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
function documentInputSnapshot(material: Dynamic): Dynamic {
  const source = db
    .prepare(
      "SELECT a.asset_id,a.sha256,a.size_bytes,a.media_type,a.relative_path FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.asset_id=? AND l.role='primary-pdf'",
    )
    .get(material.literature_id, material.asset_id);
  if (
    !source ||
    source.sha256 !== material.asset_sha256 ||
    source.size_bytes !== material.byte_size ||
    source.media_type !== material.media_type ||
    material.artifact.sha256 !== source.sha256 ||
    material.artifact.byte_size !== source.size_bytes ||
    material.artifact.media_type !== source.media_type
  )
    return null;
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
  const row = db
    .prepare(
      "SELECT * FROM parser_results WHERE source_asset_id=? AND source_sha256=?",
    )
    .get(source.asset_id, source.sha256);
  const resources = row
    ? db
        .prepare(
          "SELECT reference,artifact_path FROM parser_result_resources WHERE source_asset_id=? ORDER BY reference",
        )
        .all(source.asset_id)
    : [];
  return {
    source_artifact_path: source.relative_path,
    parser: row
      ? {
          result: currentParser(source.asset_id),
          provenance_id: row.provenance_id,
          markdown_artifact_path: row.markdown_artifact_path,
          resource_artifact_paths: Object.fromEntries(
            resources.map((r: Dynamic) => [r.reference, r.artifact_path]),
          ),
        }
      : null,
  };
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
    parser_result_sha256: v.parser_result_sha256,
    parser_provenance_id: v.parser_provenance_id,
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
    const provenance = db
      .prepare(
        "SELECT source_kind,input_sha256 FROM provenances WHERE provenance_id=?",
      )
      .get(v.parser_provenance_id);
    if (
      provenance?.source_kind !== "parser" ||
      provenance.input_sha256 !== source.sha256
    )
      fail();
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
          parser_provenance_id: v.parser_provenance_id,
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
        "INSERT INTO document_versions(document_version_id,document_id,schema_version,literature_id,source_asset_id,source_sha256,source_byte_size,source_media_type,source_artifact_path,parser_result_sha256,parser_provenance_id,builder_version,locator_scheme,representation_sha256,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,structure_artifact_path,structure_sha256,structure_byte_size,structure_media_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        v.document_version_id,
        v.document_id,
        1,
        v.source_material_ref.literature_id,
        v.source_material_ref.asset_id,
        v.source_material_ref.asset_sha256,
        v.source_material_ref.byte_size,
        v.source_material_ref.media_type,
        p.source_artifact_path,
        v.parser_result_sha256,
        v.parser_provenance_id,
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
function putParserResult(
  p: Dynamic,
  literatureId: Dynamic = undefined,
): Dynamic {
  try {
    db.exec("BEGIN IMMEDIATE");
    if (literatureId !== undefined) {
      const primary = db
        .prepare(
          "SELECT a.asset_id,a.sha256 FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'",
        )
        .get(literatureId);
      if (
        !primary ||
        primary.asset_id !== p.source_asset_id ||
        primary.sha256 !== p.source_sha256
      ) {
        db.exec("ROLLBACK");
        return null;
      }
      const previous = currentParser(p.source_asset_id);
      if (previous?.result_sha256 === p.result_sha256) {
        db.exec("COMMIT");
        return previous;
      }
    }
    const provenance = p.provenance;
    insertExact("provenances", provenance, "provenance_id");
    const register = (a: Dynamic) => {
      const previous = db
        .prepare("SELECT * FROM artifact_objects WHERE sha256=?")
        .get(a.sha256);
      if (previous) {
        if (
          previous.byte_size !== a.byte_size ||
          previous.media_type !== a.media_type ||
          previous.relative_path !== a.relative_path
        )
          fail();
        return;
      }
      insertExact("artifact_objects", a, "artifact_id");
    };
    register({
      artifact_id: p.markdown_artifact_id,
      sha256: p.markdown_sha256,
      byte_size: p.markdown_byte_size,
      media_type: p.markdown_media_type,
      relative_path: p.markdown_artifact_path,
    });
    for (const resource of p.resources || [])
      register({
        artifact_id: resource.artifact_id,
        sha256: resource.artifact_sha256,
        byte_size: resource.artifact_byte_size,
        media_type: resource.artifact_media_type,
        relative_path: resource.artifact_path,
      });
    db.prepare(
      "INSERT INTO parser_results(source_asset_id,source_sha256,result_sha256,page_count,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,provenance_id,parser_version,mode,model_identity) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_asset_id) DO UPDATE SET source_sha256=excluded.source_sha256,result_sha256=excluded.result_sha256,page_count=excluded.page_count,markdown_artifact_path=excluded.markdown_artifact_path,markdown_sha256=excluded.markdown_sha256,markdown_byte_size=excluded.markdown_byte_size,markdown_media_type=excluded.markdown_media_type,provenance_id=excluded.provenance_id,parser_version=excluded.parser_version,mode=excluded.mode,model_identity=excluded.model_identity",
    ).run(
      p.source_asset_id,
      p.source_sha256,
      p.result_sha256,
      p.page_count,
      p.markdown_artifact_path,
      p.markdown_sha256,
      p.markdown_byte_size,
      p.markdown_media_type,
      provenance.provenance_id,
      p.parser_version,
      p.mode,
      p.model_identity,
    );
    db.prepare(
      "DELETE FROM parser_result_resources WHERE source_asset_id=?",
    ).run(p.source_asset_id);
    const resourceInsert = db.prepare(
      "INSERT INTO parser_result_resources(source_asset_id,ordinal,reference,artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) VALUES(?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < (p.resources || []).length; i++) {
      const resource = p.resources[i];
      resourceInsert.run(
        p.source_asset_id,
        i,
        resource.reference,
        resource.artifact_path,
        resource.artifact_sha256,
        resource.artifact_byte_size,
        resource.artifact_media_type,
      );
    }
    const committed =
      literatureId === undefined ? true : currentParser(p.source_asset_id);
    db.exec("COMMIT");
    return committed;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure when rollback also fails.
    }
    throw e;
  }
}
function writeLiteratureContent(c: Dynamic): Dynamic {
  const metadata = db
    .prepare(
      "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
    )
    .get(c.literature_id);
  const asset = db
    .prepare("SELECT sha256 FROM assets WHERE asset_id=?")
    .get(c.primary_asset_id);
  const parser = db
    .prepare(
      "SELECT source_asset_id,source_sha256,result_sha256 FROM parser_results WHERE result_sha256=?",
    )
    .get(c.parser_result_sha256);
  if (
    !metadata ||
    metadata.metadata_revision !== c.metadata_revision ||
    metadata.metadata_sha256 !== c.metadata_sha256 ||
    !asset ||
    asset.sha256 !== c.primary_asset_sha256 ||
    !parser ||
    parser.source_asset_id !== c.primary_asset_id ||
    parser.source_sha256 !== c.primary_asset_sha256
  )
    fail();
  const provenance = c.provenance;
  insertExact("provenances", provenance, "provenance_id");
  const artifacts = [
    {
      artifact_id: c.structured_artifact_id,
      relative_path: c.structured_artifact_path,
      sha256: c.structured_artifact_sha256,
      byte_size: c.structured_artifact_byte_size,
      media_type: c.structured_artifact_media_type,
    },
    {
      artifact_id: c.markdown_artifact_id,
      relative_path: c.markdown_artifact_path,
      sha256: c.markdown_artifact_sha256,
      byte_size: c.markdown_artifact_byte_size,
      media_type: c.markdown_artifact_media_type,
    },
  ];
  for (const a of artifacts) {
    const prior = db
      .prepare("SELECT * FROM artifact_objects WHERE sha256=?")
      .get(a.sha256);
    if (prior) {
      if (
        prior.relative_path !== a.relative_path ||
        prior.byte_size !== a.byte_size ||
        prior.media_type !== a.media_type
      )
        fail();
    } else insertExact("artifact_objects", a, "artifact_id");
  }
  const old = db
    .prepare(
      "SELECT literature_content_sha256 FROM literature_contents WHERE literature_id=?",
    )
    .get(c.literature_id);
  if (old && old.literature_content_sha256 !== c.literature_content_sha256) {
    const affected = db
      .prepare(
        "SELECT DISTINCT s.reference_id FROM content_reference_text_supports s JOIN literature_references r ON r.reference_id=s.reference_id WHERE s.literature_content_sha256=? AND r.source_literature_id=?",
      )
      .all(old.literature_content_sha256, c.literature_id);
    for (const r of affected) {
      db.prepare(
        "DELETE FROM content_reference_text_supports WHERE reference_id=? AND literature_content_sha256=?",
      ).run(r.reference_id, old.literature_content_sha256);
      db.prepare(
        "DELETE FROM literature_references WHERE reference_id=? AND NOT EXISTS(SELECT 1 FROM provider_relation_reference_supports s WHERE s.reference_id=literature_references.reference_id) AND NOT EXISTS(SELECT 1 FROM metadata_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) AND NOT EXISTS(SELECT 1 FROM content_reference_text_supports s WHERE s.reference_id=literature_references.reference_id)",
      ).run(r.reference_id);
    }
    if (
      !db
        .prepare(
          "SELECT 1 FROM literature_contents WHERE literature_content_sha256=? AND literature_id<>?",
        )
        .get(old.literature_content_sha256, c.literature_id)
    )
      db.prepare(
        "DELETE FROM literature_content_reference_texts WHERE literature_content_sha256=?",
      ).run(old.literature_content_sha256);
  }
  db.prepare(
    "INSERT INTO literature_contents(literature_id,literature_content_sha256,metadata_revision,metadata_sha256,primary_asset_id,primary_asset_sha256,parser_result_sha256,structured_artifact_path,structured_artifact_sha256,structured_artifact_byte_size,structured_artifact_media_type,markdown_artifact_path,markdown_artifact_sha256,markdown_artifact_byte_size,markdown_artifact_media_type,analysis_provenance_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id) DO UPDATE SET literature_content_sha256=excluded.literature_content_sha256,metadata_revision=excluded.metadata_revision,metadata_sha256=excluded.metadata_sha256,primary_asset_id=excluded.primary_asset_id,primary_asset_sha256=excluded.primary_asset_sha256,parser_result_sha256=excluded.parser_result_sha256,structured_artifact_path=excluded.structured_artifact_path,structured_artifact_sha256=excluded.structured_artifact_sha256,structured_artifact_byte_size=excluded.structured_artifact_byte_size,structured_artifact_media_type=excluded.structured_artifact_media_type,markdown_artifact_path=excluded.markdown_artifact_path,markdown_artifact_sha256=excluded.markdown_artifact_sha256,markdown_artifact_byte_size=excluded.markdown_artifact_byte_size,markdown_artifact_media_type=excluded.markdown_artifact_media_type,analysis_provenance_id=excluded.analysis_provenance_id",
  ).run(
    c.literature_id,
    c.literature_content_sha256,
    c.metadata_revision,
    c.metadata_sha256,
    c.primary_asset_id,
    c.primary_asset_sha256,
    c.parser_result_sha256,
    c.structured_artifact_path,
    c.structured_artifact_sha256,
    c.structured_artifact_byte_size,
    c.structured_artifact_media_type,
    c.markdown_artifact_path,
    c.markdown_artifact_sha256,
    c.markdown_artifact_byte_size,
    c.markdown_artifact_media_type,
    provenance.provenance_id,
  );
  const ref = db.prepare(
    "INSERT INTO literature_content_reference_texts(literature_content_sha256,reference_index,reference_text) VALUES(?,?,?)",
  );
  const existing = db
    .prepare(
      "SELECT reference_text FROM literature_content_reference_texts WHERE literature_content_sha256=? ORDER BY reference_index",
    )
    .all(c.literature_content_sha256)
    .map((r: Dynamic) => r.reference_text);
  if (existing.length) {
    if (JSON.stringify(existing) !== JSON.stringify(c.reference_texts)) fail();
  } else
    for (let i = 0; i < c.reference_texts.length; i++)
      ref.run(c.literature_content_sha256, i, c.reference_texts[i]);
}
function putLiteratureContent(c: Dynamic): Dynamic {
  return transaction(() => {
    writeLiteratureContent(c);
    return true;
  });
}
function acceptLiteratureContent(command: Dynamic): Dynamic {
  return transaction(() => {
    const c = command.content;
    const old = db
      .prepare(
        "SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?",
      )
      .get(c.literature_id);
    const primary = db
      .prepare(
        "SELECT a.asset_id,a.sha256 FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'",
      )
      .get(c.literature_id);
    const parser = primary ? currentParser(primary.asset_id) : null;
    if (
      !old ||
      old.metadata_revision !== command.input_metadata_revision ||
      old.metadata_sha256 !== command.input_metadata_sha256 ||
      !primary ||
      primary.asset_id !== c.primary_asset_id ||
      primary.sha256 !== c.primary_asset_sha256 ||
      !parser ||
      parser.source_sha256 !== primary.sha256 ||
      parser.result_sha256 !== c.parser_result_sha256
    )
      return false;
    if (c.metadata_revision !== old.metadata_revision + 1) fail();
    writeMetadata(c.literature_id, command.final_metadata, c.metadata_sha256);
    writeLiteratureContent(c);
    const count = db
      .prepare(
        "SELECT count(*) AS count FROM literature_search_fts WHERE literature_id=?",
      )
      .get(c.literature_id).count;
    if (count !== 1) fail();
    db.prepare(
      "UPDATE literature_search_fts SET content_body=? WHERE literature_id=?",
    ).run(command.content_body, c.literature_id);
    return true;
  });
}
function getLiteratureContent(id: Dynamic): Dynamic {
  const row = db
    .prepare(
      "SELECT literature_id,literature_content_sha256,metadata_revision,metadata_sha256,primary_asset_id,primary_asset_sha256,parser_result_sha256,structured_artifact_path,structured_artifact_sha256,structured_artifact_byte_size,structured_artifact_media_type,markdown_artifact_path,markdown_artifact_sha256,markdown_artifact_byte_size,markdown_artifact_media_type,analysis_provenance_id FROM literature_contents WHERE literature_id=?",
    )
    .get(id);
  if (!row) return null;
  const p = db
    .prepare(
      "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
    )
    .get(row.analysis_provenance_id);
  if (!p) fail();
  const refs = db
    .prepare(
      "SELECT reference_text FROM literature_content_reference_texts WHERE literature_content_sha256=? ORDER BY reference_index",
    )
    .all(row.literature_content_sha256)
    .map((x: Dynamic) => x.reference_text);
  const structured = db
    .prepare(
      "SELECT artifact_id FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?",
    )
    .get(
      row.structured_artifact_path,
      row.structured_artifact_sha256,
      row.structured_artifact_byte_size,
      row.structured_artifact_media_type,
    );
  if (!structured) fail();
  const markdown = db
    .prepare(
      "SELECT artifact_id FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?",
    )
    .get(
      row.markdown_artifact_path,
      row.markdown_artifact_sha256,
      row.markdown_artifact_byte_size,
      row.markdown_artifact_media_type,
    );
  if (!markdown) fail();
  return {
    literature_id: row.literature_id,
    literature_content_sha256: row.literature_content_sha256,
    metadata_revision: row.metadata_revision,
    metadata_sha256: row.metadata_sha256,
    primary_asset_id: row.primary_asset_id,
    primary_asset_sha256: row.primary_asset_sha256,
    parser_result_sha256: row.parser_result_sha256,
    structured_artifact_id: structured.artifact_id,
    structured_artifact_path: row.structured_artifact_path,
    structured_artifact_sha256: row.structured_artifact_sha256,
    structured_artifact_byte_size: row.structured_artifact_byte_size,
    structured_artifact_media_type: row.structured_artifact_media_type,
    markdown_artifact_id: markdown.artifact_id,
    markdown_artifact_path: row.markdown_artifact_path,
    markdown_artifact_sha256: row.markdown_artifact_sha256,
    markdown_artifact_byte_size: row.markdown_artifact_byte_size,
    markdown_artifact_media_type: row.markdown_artifact_media_type,
    provenance: p,
    reference_texts: refs,
  };
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
function putContentReferenceSupport(
  referenceId: Dynamic,
  contentSha: Dynamic,
  index: Dynamic,
): Dynamic {
  try {
    db.exec("BEGIN IMMEDIATE");
    const valid = db
      .prepare(
        "SELECT 1 FROM literature_references r JOIN literature_contents content ON content.literature_id=r.source_literature_id JOIN literature_content_reference_texts text ON text.literature_content_sha256=content.literature_content_sha256 AND text.reference_index=? WHERE r.reference_id=? AND content.literature_content_sha256=?",
      )
      .get(index, referenceId, contentSha);
    if (!valid) fail();
    db.prepare(
      "INSERT INTO content_reference_text_supports(reference_id,literature_content_sha256,reference_index) VALUES(?,?,?) ON CONFLICT DO NOTHING",
    ).run(referenceId, contentSha, index);
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
        "SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE EXISTS(SELECT 1 FROM provider_relation_reference_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM metadata_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM content_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) ORDER BY source_literature_id,target_literature_id,reference_id",
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
      for (const s of db
        .prepare(
          "SELECT literature_content_sha256,reference_index FROM content_reference_text_supports WHERE reference_id=? ORDER BY literature_content_sha256,reference_index",
        )
        .all(row.reference_id))
        supports.push({
          kind: "content_reference_text",
          literature_content_sha256: s.literature_content_sha256,
          reference_index: s.reference_index,
        });
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
    for (const s of db
      .prepare(
        "SELECT literature_content_sha256,reference_index FROM content_reference_text_supports WHERE reference_id=? ORDER BY literature_content_sha256,reference_index",
      )
      .all(reference.reference_id)) {
      if (
        !db
          .prepare(
            "SELECT 1 FROM literature_contents c JOIN literature_content_reference_texts text ON text.literature_content_sha256=c.literature_content_sha256 WHERE c.literature_id=? AND c.literature_content_sha256=? AND text.reference_index=?",
          )
          .get(
            reference.source_literature_id,
            s.literature_content_sha256,
            s.reference_index,
          )
      )
        fail();
      supports.push({
        reference_id: reference.reference_id,
        source: { kind: "content_reference_text", ...s },
      });
    }
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
    let parser_result = null;
    if (primary_pdf) {
      const p = db
        .prepare(
          "SELECT * FROM parser_results WHERE source_asset_id=? AND source_sha256=?",
        )
        .get(primary_pdf.asset.asset_id, primary_pdf.asset.sha256);
      if (p)
        parser_result = {
          source_asset_id: p.source_asset_id,
          source_sha256: p.source_sha256,
          page_count: p.page_count,
          result_sha256: p.result_sha256,
          markdown: {
            sha256: p.markdown_sha256,
            media_type: p.markdown_media_type,
            byte_size: p.markdown_byte_size,
          },
          resources: db
            .prepare(
              "SELECT reference,artifact_sha256,artifact_media_type,artifact_byte_size FROM parser_result_resources WHERE source_asset_id=? ORDER BY reference",
            )
            .all(p.source_asset_id)
            .map((r: Dynamic) => ({
              reference: r.reference,
              artifact: {
                sha256: r.artifact_sha256,
                media_type: r.artifact_media_type,
                byte_size: r.artifact_byte_size,
              },
            })),
          provenance: {
            provenance: provenance(p.provenance_id),
            parser_version: p.parser_version,
            mode: p.mode,
            model_identity: p.model_identity,
          },
        };
    }
    const other_versions = db
      .prepare(
        "SELECT literature_id FROM literatures WHERE meta_literature_id=? AND literature_id<>? ORDER BY CASE version_role WHEN 'published' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE 3 END,literature_id",
      )
      .all(literature.meta_literature_id, id)
      .map((row: Dynamic) => searchItem(row.literature_id));
    const content = getLiteratureContent(id);
    const detail = {
      ...searchItem(id),
      meta_literature,
      metadata_observations,
      primary_pdf,
      additional_assets: assets.filter(
        (a: Dynamic) => a.literature_asset.role !== "primary-pdf",
      ),
      parser_result,
      content: null,
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
    return { detail, content };
  } catch (error) {
    if (!nested) db.exec("ROLLBACK");
    throw error;
  }
}
function cleanupClosure(id: Dynamic): Dynamic {
  const snapshot = literatureDetailSnapshot(id, true);
  if (!snapshot) return null;
  const p = snapshot.detail.primary_pdf;
  if (!p || !snapshot.detail.parser_result) return null;
  const references = referenceQueryRows({
    literature_id: id,
    direction: "references",
  });
  const reference_count = db
    .prepare(
      "SELECT count(*) AS n FROM literature_references WHERE source_literature_id=?",
    )
    .get(id).n;
  const fts = db
    .prepare(
      "SELECT literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body FROM literature_search_fts WHERE literature_id=?",
    )
    .all(id);
  const parser = db
    .prepare("SELECT * FROM parser_results WHERE source_asset_id=?")
    .get(p.asset.asset_id);
  const resources = db
    .prepare(
      "SELECT * FROM parser_result_resources WHERE source_asset_id=? ORDER BY ordinal",
    )
    .all(p.asset.asset_id);
  const c = snapshot.content;
  const paths = [
    ...new Set<Dynamic>([
      p.asset.path,
      parser.markdown_artifact_path,
      ...resources.map((r: Dynamic) => r.artifact_path),
      ...(c ? [c.structured_artifact_path, c.markdown_artifact_path] : []),
    ]),
  ].sort();
  const artifacts = paths.map((path: Dynamic) => {
    const row = db
      .prepare("SELECT * FROM artifact_objects WHERE relative_path=?")
      .get(path);
    if (!row) fail();
    return row;
  });
  const exhausted =
    db
      .prepare(
        "SELECT * FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
      )
      .get(id) || null;
  const execution = candidateCleanupSnapshot();
  const closure = {
    snapshot,
    references,
    reference_count,
    fts,
    parser,
    resources,
    artifacts,
    exhausted,
    execution,
  };
  return {
    ...closure,
    token: createHash("sha256").update(JSON.stringify(closure)).digest("hex"),
  };
}
function contentCleanupSnapshot(id: Dynamic): Dynamic {
  // The legacy cleanup closure does not account for Document/Evidence dependencies.
  // No legacy accepted-material deletion is offered once v3 is installed.
  if (catalogHasDocuments()) return null;
  return transaction(() => {
    const c = cleanupClosure(id);
    return c
      ? {
          token: c.token,
          snapshot: c.snapshot,
          references: c.references,
          reference_count: c.reference_count,
          fts: c.fts,
          artifacts: c.artifacts.map((a: Dynamic) => ({
            reference: a.relative_path,
            artifact: {
              sha256: a.sha256,
              byte_size: a.byte_size,
              media_type: a.media_type,
            },
          })),
        }
      : null;
  });
}
function cleanupNoUsableContent(command: Dynamic): Dynamic {
  if (catalogHasDocuments()) fail();
  return transaction(() => {
    const id = command.input.literature_id,
      c = cleanupClosure(id);
    if (!c || c.token !== command.token || c.exhausted) return null;
    const d = c.snapshot.detail,
      p = d.primary_pdf,
      parser = d.parser_result,
      old = c.snapshot.content;
    const input = {
      literature_id: id,
      primary_asset_id: p.asset.asset_id,
      primary_pdf_sha256: p.asset.sha256,
      parser_result_sha256: parser.result_sha256,
      input_metadata_revision: d.metadata_revision,
      input_metadata_sha256: d.metadata_sha256,
    };
    const stable = (v: Dynamic): Dynamic =>
      Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, stable(v)]),
            )
          : v;
    const same = (a: Dynamic, b: Dynamic) =>
      JSON.stringify(stable(a)) === JSON.stringify(stable(b));
    if (!same(input, command.input)) return null;
    if (c.reference_count !== c.references.length) fail();
    // The Parser row is Asset-scoped; another current content binding must never be invalidated by this cleanup.
    if (
      db
        .prepare(
          "SELECT 1 FROM literature_contents WHERE primary_asset_id=? AND literature_id<>? LIMIT 1",
        )
        .get(p.asset.asset_id, id)
    )
      return null;
    const removed = c.references.flatMap((r: Dynamic) =>
      r.supports.filter(
        (s: Dynamic) =>
          s.source.kind === "content_reference_text" &&
          s.source.literature_content_sha256 === old?.literature_content_sha256,
      ),
    );
    const deleted = c.references
      .filter(
        (r: Dynamic) =>
          r.supports.length > 0 &&
          r.supports.every((s: Dynamic) => removed.includes(s)),
      )
      .map((r: Dynamic) => r.reference.reference_id)
      .sort();
    if (
      !same(removed, command.removed_supports) ||
      !same(deleted, command.deleted_reference_ids)
    )
      fail();
    const execution = c.execution;
    const candidateMap = new Map<Dynamic, Dynamic>(
      execution.candidates.map((r: Dynamic) => [
        r.transfer_id,
        JSON.parse(r.record_json),
      ]),
    );
    const removedReceipts = [],
      affectedTransfers = new Set<Dynamic>(),
      retainedTransfers = new Set<Dynamic>();
    for (const row of execution.receipts) {
      const intent = JSON.parse(row.intent_json);
      if (
        intent.literature_id === id &&
        intent.candidate.sha256 === input.primary_pdf_sha256
      ) {
        removedReceipts.push(row.receipt_id);
        affectedTransfers.add(row.transfer_id);
      } else retainedTransfers.add(row.transfer_id);
    }
    const removedTransfers = [...candidateMap]
      .filter(
        ([tid, candidate]) =>
          candidate.sha256 === input.primary_pdf_sha256 &&
          !retainedTransfers.has(tid) &&
          (candidate.capture?.article_id === id ||
            (candidate.capture === null && affectedTransfers.has(tid))),
      )
      .map(([tid]) => tid)
      .sort();
    const expectedCleanup = {
      receipt_ids: removedReceipts.sort(),
      transfer_ids: removedTransfers,
    };
    if (command.candidate_cleanup) {
      if (!same(expectedCleanup, command.candidate_cleanup)) fail();
    } else if (removedTransfers.length || removedReceipts.length) fail();
    for (const receipt of removedReceipts)
      requireCount(
        db
          .prepare("DELETE FROM execution_receipts WHERE receipt_id=?")
          .run(receipt),
        1,
      );
    for (const tid of removedTransfers)
      requireCount(
        db
          .prepare("DELETE FROM execution_candidates WHERE transfer_id=?")
          .run(tid),
        1,
      );
    for (const support of removed)
      requireCount(
        db
          .prepare(
            "DELETE FROM content_reference_text_supports WHERE reference_id=? AND literature_content_sha256=? AND reference_index=?",
          )
          .run(
            support.reference_id,
            support.source.literature_content_sha256,
            support.source.reference_index,
          ),
        1,
      );
    for (const ref of deleted)
      requireCount(
        db
          .prepare(
            "DELETE FROM literature_references WHERE reference_id=? AND source_literature_id=? AND NOT EXISTS(SELECT 1 FROM provider_relation_reference_supports WHERE reference_id=?) AND NOT EXISTS(SELECT 1 FROM metadata_reference_text_supports WHERE reference_id=?) AND NOT EXISTS(SELECT 1 FROM content_reference_text_supports WHERE reference_id=?)",
          )
          .run(ref, id, ref, ref, ref),
        1,
      );
    if (old) {
      requireCount(
        db
          .prepare(
            "DELETE FROM literature_contents WHERE literature_id=? AND literature_content_sha256=?",
          )
          .run(id, old.literature_content_sha256),
        1,
      );
      if (
        !db
          .prepare(
            "SELECT 1 FROM literature_contents WHERE literature_content_sha256=?",
          )
          .get(old.literature_content_sha256)
      )
        requireCount(
          db
            .prepare(
              "DELETE FROM literature_content_reference_texts WHERE literature_content_sha256=?",
            )
            .run(old.literature_content_sha256),
          old.reference_texts.length,
        );
    }
    requireCount(
      db
        .prepare("DELETE FROM parser_result_resources WHERE source_asset_id=?")
        .run(p.asset.asset_id),
      c.resources.length,
    );
    requireCount(
      db
        .prepare(
          "DELETE FROM parser_results WHERE source_asset_id=? AND result_sha256=?",
        )
        .run(p.asset.asset_id, parser.result_sha256),
      1,
    );
    requireCount(
      db
        .prepare(
          "DELETE FROM literature_assets WHERE literature_asset_id=? AND literature_id=? AND asset_id=? AND role='primary-pdf'",
        )
        .run(p.literature_asset.literature_asset_id, id, p.asset.asset_id),
      1,
    );
    requireCount(
      db
        .prepare(
          "UPDATE literature_search_fts SET content_body='' WHERE literature_id=?",
        )
        .run(id),
      1,
    );
    db.prepare(
      "DELETE FROM assets WHERE asset_id=? AND NOT EXISTS(SELECT 1 FROM literature_assets WHERE asset_id=?)",
    ).run(p.asset.asset_id, p.asset.asset_id);
    const retired = [];
    for (const a of c.artifacts) {
      const path = a.relative_path;
      const used = db
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM assets WHERE relative_path=?) OR EXISTS(SELECT 1 FROM parser_results WHERE markdown_artifact_path=?) OR EXISTS(SELECT 1 FROM parser_result_resources WHERE artifact_path=?) OR EXISTS(SELECT 1 FROM literature_contents WHERE structured_artifact_path=? OR markdown_artifact_path=?) AS used",
        )
        .get(path, path, path, path, path).used;
      if (!used) {
        requireCount(
          db
            .prepare("DELETE FROM artifact_objects WHERE relative_path=?")
            .run(path),
          1,
        );
        retired.push({
          reference: path,
          artifact: {
            sha256: a.sha256,
            byte_size: a.byte_size,
            media_type: a.media_type,
          },
        });
      }
    }
    for (const tid of removedTransfers) {
      const candidate = candidateMap.get(tid);
      if (!retired.some((r: Dynamic) => r.reference === candidate.reference))
        retired.push({
          reference: candidate.reference,
          artifact: {
            sha256: candidate.sha256,
            byte_size: candidate.size_bytes,
            media_type: "application/pdf",
          },
        });
    }
    const provenanceIds = [
      ...new Set<Dynamic>([
        p.literature_asset.provenance.provenance_id,
        parser.provenance.provenance.provenance_id,
        ...(old ? [old.provenance.provenance_id] : []),
      ]),
    ];
    for (const pid of provenanceIds) {
      const used = db
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM metadata_observations WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM provider_relation_observations WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM literature_assets WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM parser_results WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM literature_contents WHERE analysis_provenance_id=?) AS used",
        )
        .get(pid, pid, pid, pid, pid).used;
      if (!used)
        requireCount(
          db.prepare("DELETE FROM provenances WHERE provenance_id=?").run(pid),
          1,
        );
    }
    return retired;
  });
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
function catalogHasDocuments(): boolean {
  const identity = db
    .prepare(
      "SELECT schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get();
  return (
    (identity?.schema_version === SCHEMA_V3_VERSION &&
      identity?.schema_fingerprint === SCHEMA_V3_FINGERPRINT) ||
    (identity?.schema_version === SCHEMA_V4_VERSION &&
      identity?.schema_fingerprint === SCHEMA_V4_FINGERPRINT) ||
    (identity?.schema_version === SCHEMA_V5_VERSION &&
      identity?.schema_fingerprint === SCHEMA_V5_FINGERPRINT) ||
    (identity?.schema_version === SCHEMA_V6_VERSION &&
      identity?.schema_fingerprint === SCHEMA_V6_FINGERPRINT) ||
    (identity?.schema_version === SCHEMA_V7_VERSION &&
      identity?.schema_fingerprint === SCHEMA_V7_FINGERPRINT) ||
    (identity?.schema_version === SCHEMA_V8_VERSION &&
      identity?.schema_fingerprint === SCHEMA_V8_FINGERPRINT) ||
    (identity?.schema_version === SCHEMA_V9_VERSION &&
      identity?.schema_fingerprint === SCHEMA_V9_FINGERPRINT)
  );
}
function artifactReclamationSnapshot(reference: Dynamic): Dynamic {
  return transaction(() => {
    // Without an external evidence invalidation policy, no retired accepted
    // bytes are physically reclaimed in a document-aware catalog.
    if (catalogHasDocuments())
      return { registered: true, ...candidateCleanupSnapshot() };
    const registered = !!db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM artifact_objects WHERE relative_path=?) OR EXISTS(SELECT 1 FROM assets WHERE relative_path=?) OR EXISTS(SELECT 1 FROM parser_results WHERE markdown_artifact_path=?) OR EXISTS(SELECT 1 FROM parser_result_resources WHERE artifact_path=?) OR EXISTS(SELECT 1 FROM literature_contents WHERE structured_artifact_path=? OR markdown_artifact_path=?) AS used",
      )
      .get(reference, reference, reference, reference, reference, reference)
      .used;
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
    "parser_results",
    "parser_result_resources",
    "literature_contents",
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
          [
            "beginGeneration",
            "insertEntries",
            "publish",
            "knowledgeBegin",
            "knowledgeInsert",
            "knowledgePublish",
          ].includes(operation)
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
          "knowledgeRevision",
          "knowledgeSourcePage",
          "knowledgeBegin",
          "knowledgeInsert",
          "knowledgePublish",
          "knowledgeActive",
          "knowledgeCoverage",
          "knowledgeSearch",
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
      case "knowledge":
        try {
          value = {
            ok: true,
            value: knowledgeModule.runKnowledgeStorage(
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
              error.constructor?.name === "KnowledgeStorageFailure" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "storage-failed",
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
      case "document_material":
        value = documentMaterial(
          message.command.literatureId,
          message.command.assetId,
        );
        break;
      case "document_input":
        value = documentInput(message.command.material);
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
      case "execution_upgrade":
        value = upgradeExecution();
        break;
      case "execution_runtime_inspect":
        value = runtimeInspect();
        break;
      case "execution_runtime_migrate":
        value = migrateRuntime(message.command.dryRun);
        break;
      case "execution_backup":
        value = backupExecution(message.command.path);
        break;
      case "execution_restore_check":
        value = restoreCheck(message.command.path);
        break;
      case "execution_rollback":
        value = rollbackExecution(message.command.backupPath);
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
        value = listExecutionJobs(message.command.limit);
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
      case "library_snapshot":
        value = librarySnapshot(
          message.command.ftsQuery,
          message.command.discoveryRunIds,
          message.command.includeOtherVersions,
          message.command.literatureIds,
          message.command.metaLiteratureIds,
        );
        break;
      case "candidate_cleanup_snapshot":
        value = transaction(candidateCleanupSnapshot);
        break;
      case "artifact_reclamation_snapshot":
        value = artifactReclamationSnapshot(message.command.reference);
        break;
      case "content_cleanup_snapshot":
        value = contentCleanupSnapshot(message.command.literatureId);
        break;
      case "cleanup_no_usable_content":
        value = cleanupNoUsableContent(message.command.command);
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
      case "commit_current_parser":
        value = putParserResult(
          message.command.result,
          message.command.literatureId,
        );
        break;
      case "put_parser_result":
        value = putParserResult(message.command.result);
        break;
      case "accept_literature_content":
        value = acceptLiteratureContent(message.command.command);
        break;
      case "put_literature_content":
        value = putLiteratureContent(message.command.content);
        break;
      case "get_literature_content":
        value = getLiteratureContent(message.command.literatureId);
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
      case "put_content_reference_support":
        value = putContentReferenceSupport(
          message.command.referenceId,
          message.command.contentSha256,
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
