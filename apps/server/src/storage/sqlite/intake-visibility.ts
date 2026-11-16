import type { DatabaseSync } from "node:sqlite";

/** Only static expressions from adapters belong here, never request SQL. */
export function visibleLiteratureSql(expression: string): string {
  return (
    "NOT EXISTS(SELECT 1 FROM intake_withdrawn_objects withdrawn WHERE withdrawn.object_kind='literature' AND withdrawn.object_id=" +
    expression +
    ")"
  );
}
export function visibleObjectSql(
  kind: "folder" | "folder-member" | "mark" | "literature-asset",
  expression: string,
): string {
  return (
    "NOT EXISTS(SELECT 1 FROM intake_withdrawn_objects withdrawn WHERE withdrawn.object_kind='" +
    kind +
    "' AND withdrawn.object_id=" +
    expression +
    ")"
  );
}
export function literatureWithdrawn(db: DatabaseSync, id: string): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM intake_withdrawn_objects WHERE object_kind='literature' AND object_id=?",
    )
    .get(id);
}
/** Read projection only: the identity owner retains its original representative. */
export function visibleMetaLiterature(db: DatabaseSync, id: string) {
  return (
    db
      .prepare(
        "SELECT m.meta_literature_id,l.literature_id AS representative_literature_id FROM meta_literatures m JOIN literatures l USING(meta_literature_id) WHERE m.meta_literature_id=? AND " +
          visibleLiteratureSql("l.literature_id") +
          " ORDER BY (l.literature_id=m.representative_literature_id) DESC,CASE l.version_role WHEN 'published' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE 3 END,l.literature_id LIMIT 1",
      )
      .get(id) ?? null
  );
}

export function visibleCitationSql(
  alias = "citation_discovery_causes",
): string {
  return (
    visibleLiteratureSql(alias + ".source_literature_id") +
    " AND " +
    visibleLiteratureSql(alias + ".target_literature_id")
  );
}
