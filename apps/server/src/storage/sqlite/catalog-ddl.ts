import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const CATALOG_ADDITIONS_TABLE = "catalog_schema_additions";
export const CATALOG_ADDITION_REQUIRED = "catalog-addition-required";
export const CATALOG_ADDITIONS_DDL =
  "CREATE TABLE catalog_schema_additions(name TEXT PRIMARY KEY,ddl_fingerprint TEXT NOT NULL,applied_at TEXT NOT NULL,backfill_step INTEGER NOT NULL CHECK(backfill_step>=0),backfill_cursor_json TEXT NOT NULL CHECK(json_valid(backfill_cursor_json))) STRICT, WITHOUT ROWID";

export interface CatalogAdditionRequirement {
  readonly name: string;
  readonly ddl_fingerprint: string;
  readonly backfill_steps: readonly string[];
}

export interface CatalogAddition extends CatalogAdditionRequirement {
  readonly statements: readonly string[];
  readonly manifest: readonly string[];
}

export function defineCatalogAddition(
  name: string,
  statements: readonly string[],
  backfill_steps: readonly string[] = [],
  manifest = statements,
): CatalogAddition {
  return Object.freeze({
    name,
    statements,
    manifest,
    backfill_steps,
    ddl_fingerprint: createHash("sha256")
      .update(JSON.stringify(statements))
      .digest("hex"),
  });
}

export function registerCatalogAddition(
  db: DatabaseSync,
  addition: CatalogAdditionRequirement,
  appliedAt: string,
  backfilled = false,
) {
  db.prepare(
    "INSERT INTO catalog_schema_additions(name,ddl_fingerprint,applied_at,backfill_step,backfill_cursor_json) VALUES(?,?,?,?,'null')",
  ).run(
    addition.name,
    addition.ddl_fingerprint,
    appliedAt,
    backfilled ? addition.backfill_steps.length : 0,
  );
}

// Target column order from the frozen schema 19. Keep the migration inputs
// exact and apply the first-release trigger rewrite to their successor only.
const positionalColumns: Readonly<Record<string, string>> = {
  agent_view_revision: "singleton,revision",
  archive_content_heads: "literature_id,asset_id,source_json,part",
  archive_description_heads: "literature_id,source_json",
  library_collection_times: "literature_id,collected_at",
  library_discovery_invalid: "discovery_run_id,meta_literature_id",
  library_discovery_replaced:
    "source,discovery_run_id,meta_literature_id,actual_literature_id",
  library_state_changes: "literature_id,revision",
  literature_intake: "literature_id,intake_at",
  processor_result_freshness_reasons:
    "result_id,reason_key,event_sequence,literature_id,asset_id,kind,old_json,new_json,expected_version",
};

export function nameCatalogInsertColumns(sql: string): string {
  return sql.replace(
    /\b(INSERT (?:OR \w+ )?INTO )([a-z_][a-z0-9_]*)(?=\s+(?:VALUES\s*\(|SELECT\b))/gu,
    (_match, insert: string, table: string) => {
      const columns = positionalColumns[table];
      if (!columns)
        throw new Error(`unknown positional catalog insert: ${table}`);
      return `${insert}${table}(${columns})`;
    },
  );
}

export type CatalogObjectType = "table" | "index" | "trigger" | "view";
export interface CatalogObject {
  readonly type: CatalogObjectType;
  readonly name: string;
  readonly sql: string;
}

export function manifestObject(sql: string): CatalogObject {
  const match =
    /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(TABLE|INDEX|TRIGGER|VIEW) ([a-z_][a-z0-9_]*)\b/u.exec(
      sql,
    );
  if (!match) throw new Error("invalid catalog manifest statement");
  return {
    type: match[1]!.toLowerCase() as CatalogObjectType,
    name: match[2]!,
    sql,
  };
}

export const objectKey = (object: Pick<CatalogObject, "type" | "name">) =>
  `${object.type}:${object.name}`;

export function manifestWithAdditions(
  base: readonly string[],
  additions: readonly CatalogAddition[],
): readonly string[] {
  // An ALTER statement has the table's full resulting CREATE in its manifest.
  const objects = new Map<string, string>();
  for (const sql of [
    ...base,
    ...additions.flatMap((addition) => addition.manifest),
  ])
    objects.set(objectKey(manifestObject(sql)), sql);
  return [...objects.values()];
}

export function catalogObjects(db: DatabaseSync): Map<string, CatalogObject> {
  const objects = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
    )
    .all() as unknown as CatalogObject[];
  return new Map(objects.map((object) => [objectKey(object), object]));
}

function tableDefinition(sql: string) {
  const parts: string[] = [];
  let beginning = -1,
    start = -1,
    depth = 0;
  // Quoted identifiers, literals and comments cannot delimit a definition.
  const tokens =
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[(),]/gu;
  for (const token of sql.matchAll(tokens)) {
    if (token[0] === "(") {
      if (depth++ === 0) {
        beginning = token.index;
        start = beginning + 1;
      }
    } else if (token[0] === ")" && --depth === 0) {
      parts.push(sql.slice(start, token.index));
      return {
        head: sql.slice(0, beginning),
        parts,
        tail: sql.slice(token.index),
      };
    } else if (token[0] === "," && depth === 1) {
      parts.push(sql.slice(start, token.index));
      start = token.index + 1;
    }
  }
  return null;
}

export interface CatalogExtraColumn {
  readonly table: string;
  readonly name: string;
  readonly nullable: boolean;
  readonly default_sql: string | null;
}

/** SQLite inserts ADD COLUMN clauses at the end of columns, before table constraints. */
export function appendedColumns(
  db: DatabaseSync,
  expected: CatalogObject,
  actual: CatalogObject,
): readonly CatalogExtraColumn[] | null {
  if (
    expected.type !== "table" ||
    !expected.sql.startsWith("CREATE TABLE ") ||
    !actual.sql?.startsWith("CREATE TABLE ")
  )
    return null;
  const old = tableDefinition(expected.sql),
    next = tableDefinition(actual.sql);
  if (!old || !next || old.head !== next.head || old.tail !== next.tail)
    return null;
  const firstConstraint = old.parts.findIndex((part) =>
    /^\s*(?:CONSTRAINT\s|CHECK\s*\(|UNIQUE\s*\(|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b)/iu.test(
      part,
    ),
  );
  const columnCount = firstConstraint < 0 ? old.parts.length : firstConstraint;
  const added = next.parts.length - old.parts.length;
  if (
    added <= 0 ||
    old.parts.some(
      (part, i) => part !== next.parts[i < columnCount ? i : i + added],
    )
  )
    return null;
  const columns = db
    .prepare(
      "SELECT name, [notnull], dflt_value, pk FROM pragma_table_xinfo(?) WHERE cid>=? ORDER BY cid",
    )
    .all(actual.name, columnCount);
  if (
    columns.length !== added ||
    columns.some(
      (column) =>
        column.pk !== 0 ||
        (column.notnull === 1 &&
          (column.dflt_value === null ||
            /^\s*(?:\(\s*)*null(?:\s*\))*\s*$/iu.test(
              String(column.dflt_value),
            ))),
    )
  )
    return null;
  return columns.map((column) => ({
    table: actual.name,
    name: String(column.name),
    nullable: column.notnull === 0,
    default_sql: column.dflt_value === null ? null : String(column.dflt_value),
  }));
}
