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
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonBytes,
  normalizedTagName,
  parseTag,
  parseTagListItem,
  parseTagAssignment,
  parseTagAssignmentItem,
  parseVocabularyMutation,
  parseLiteratureId,
  tagInteger,
  tagText,
  type Tag,
  type TagAssignment,
  type VocabularyChange,
  type VocabularyActor,
} from "@sciretriever/contracts";
import type { VocabularyStore } from "../../tags/vocabulary.js";
import type * as Vocabulary from "../../tags/vocabulary.js";
import type * as Rules from "../../tags/rules.js";
const { changeVocabulary, vocabularyUndoDependencies }: typeof Vocabulary =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../../tags/vocabulary.ts"
        : "../../tags/vocabulary.js",
      import.meta.url,
    ).href
  );
const { TagError, orderedTagItems, tagNames }: typeof Rules = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../tags/rules.ts"
      : "../../tags/rules.js",
    import.meta.url,
  ).href
);
export type TagStorageAction =
  | "state"
  | "list"
  | "get"
  | "resolve"
  | "assignment"
  | "change"
  | "assign"
  | "changes"
  | "undo-preview"
  | "backfill-candidates"
  | "cover"
  | "consolidated";
export const TAG_READ_ACTIONS: readonly TagStorageAction[] = [
  "state",
  "list",
  "get",
  "resolve",
  "assignment",
  "changes",
  "undo-preview",
  "backfill-candidates",
];
const json = (v: unknown) =>
  Buffer.from(canonicalJsonBytes(v)).toString("utf8");
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(v)).digest("hex");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TagError("tags-invalid");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, fallback: number, max: number) {
  const n = tagInteger(value ?? fallback, 1);
  if (n > max) throw new TagError("tag-limit");
  return n;
}
function tx<T>(db: DatabaseSync, write: boolean, work: () => T): T {
  if (write) beginCatalogWrite(db);
  else db.exec("BEGIN");
  try {
    const v = work();
    if (write) commitCatalogWrite(db);
    else db.exec("COMMIT");
    return v;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
function vocabularyStore(db: DatabaseSync): VocabularyStore {
  const getTag = (id: string): Tag | null => {
    const row = db.prepare("SELECT row_json FROM tags WHERE tag_id=?").get(id);
    return row ? parseTag(JSON.parse(String(row.row_json))) : null;
  };
  const assignment = (id: string): TagAssignment | null => {
    const row = db
      .prepare(
        "SELECT row_json FROM literature_tag_assignments WHERE literature_id=?",
      )
      .get(id);
    if (!row) return null;
    const a = parseTagAssignment(JSON.parse(String(row.row_json)));
    if (
      hash({ literature_id: a.literature_id, items: a.items }) !==
      a.assignment_sha256
    )
      throw new TagError("tag-assignment-corrupt");
    return a;
  };
  const store: VocabularyStore = {
    version: () =>
      Number(
        db
          .prepare("SELECT version FROM vocabulary_state WHERE singleton=1")
          .get()!.version,
      ),
    tag: getTag,
    children: (id) =>
      db
        .prepare(
          "SELECT row_json FROM tags WHERE parent_id=? AND status='active' ORDER BY tag_id",
        )
        .all(id)
        .map((r) => parseTag(JSON.parse(String(r.row_json)))),
    nameOwner: (name) => {
      const r = db
        .prepare("SELECT tag_id FROM tag_aliases WHERE normalized_name=?")
        .get(normalizedTagName(name));
      return r ? String(r.tag_id) : null;
    },
    clearNames: (ids) => {
      for (const id of ids)
        db.prepare("DELETE FROM tag_aliases WHERE tag_id=?").run(id);
    },
    saveTag: (value) => {
      const t = parseTag(value),
        body = json(t);
      if (Buffer.byteLength(body) > 65536) throw new TagError("tag-limit");
      db.prepare(
        "INSERT INTO tags(tag_id,parent_id,status,merged_into,locked,created_vocab_version,backfilled_vocab_version,row_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tag_id) DO UPDATE SET parent_id=excluded.parent_id,status=excluded.status,merged_into=excluded.merged_into,locked=excluded.locked,backfilled_vocab_version=excluded.backfilled_vocab_version,row_json=excluded.row_json",
      ).run(
        t.tag_id,
        t.parent_id,
        t.status,
        t.merged_into,
        t.locked ? 1 : 0,
        t.created_vocab_version,
        t.backfilled_vocab_version,
        body,
      );
      db.prepare("DELETE FROM tag_aliases WHERE tag_id=?").run(t.tag_id);
      db.prepare("DELETE FROM tag_search WHERE tag_id=?").run(t.tag_id);
      if (t.status === "active") {
        for (const name of tagNames(t))
          db.prepare(
            "INSERT INTO tag_aliases(normalized_name,tag_id) VALUES(?,?)",
          ).run(name, t.tag_id);
        db.prepare(
          "INSERT INTO tag_search(tag_id,names,definition) VALUES(?,?,?)",
        ).run(
          t.tag_id,
          [t.name_zh, t.name_en, ...t.aliases].join(" "),
          [t.definition.includes, t.definition.excludes].join(" "),
        );
      }
    },
    removeTag: (id) => {
      db.prepare("DELETE FROM tag_search WHERE tag_id=?").run(id);
      db.prepare("DELETE FROM tags WHERE tag_id=?").run(id);
    },
    assignmentUses: (id) =>
      Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM literature_tag_items WHERE tag_id=?",
          )
          .get(id)!.n,
      ),
    lockedAssignments: (ids) =>
      !!db
        .prepare(
          "SELECT 1 FROM literature_tag_items WHERE locked=1 AND tag_id IN (SELECT value FROM json_each(?)) LIMIT 1",
        )
        .get(JSON.stringify(ids)),
    *assignments(id) {
      let after = "";
      for (;;) {
        const page = db
          .prepare(
            "SELECT a.row_json,a.literature_id FROM literature_tag_assignments a JOIN literature_tag_items i ON i.literature_id=a.literature_id WHERE i.tag_id=? AND a.literature_id>? ORDER BY a.literature_id LIMIT 128",
          )
          .all(id, after);
        if (!page.length) return;
        for (const row of page) {
          after = String(row.literature_id);
          yield parseTagAssignment(JSON.parse(String(row.row_json)));
        }
      }
    },
    assignment,
    saveAssignment(value) {
      const before = assignment(value.literature_id),
        items = value.items.map(parseTagAssignmentItem);
      const next = parseTagAssignment({
        ...value,
        items,
        revision: (before?.revision ?? 0) + 1,
        assignment_sha256: hash({ literature_id: value.literature_id, items }),
      });
      const body = json(next);
      if (Buffer.byteLength(body) > 262144) throw new TagError("tag-limit");
      db.prepare(
        "INSERT INTO literature_tag_assignments(literature_id,revision,vocab_version,assignment_sha256,row_json) VALUES(?,?,?,?,?) ON CONFLICT(literature_id) DO UPDATE SET revision=excluded.revision,vocab_version=excluded.vocab_version,assignment_sha256=excluded.assignment_sha256,row_json=excluded.row_json",
      ).run(
        next.literature_id,
        next.revision,
        next.vocab_version,
        next.assignment_sha256,
        body,
      );
      return next;
    },
    rememberAssignment(version, before, after) {
      db.prepare(
        "INSERT INTO vocabulary_change_assignments(version,literature_id,before_json,after_sha256,after_revision) VALUES(?,?,?,?,?)",
      ).run(
        version,
        before.literature_id,
        json(before),
        after.assignment_sha256,
        after.revision,
      );
    },
    *savedAssignments(version) {
      for (const row of db
        .prepare(
          "SELECT before_json,after_sha256,after_revision FROM vocabulary_change_assignments WHERE version=? ORDER BY literature_id",
        )
        .iterate(version))
        yield {
          before: parseTagAssignment(JSON.parse(String(row.before_json))),
          after_sha256: String(row.after_sha256),
          after_revision: Number(row.after_revision),
        };
    },
    record(change, touched) {
      db.prepare(
        "INSERT INTO vocabulary_changes(version,row_json,undone_by) VALUES(?,?,NULL)",
      ).run(change.version, json(change));
      for (const id of new Set(touched))
        db.prepare(
          "INSERT INTO vocabulary_change_tags(version,tag_id) VALUES(?,?)",
        ).run(change.version, id);
      db.prepare("UPDATE vocabulary_state SET version=? WHERE singleton=1").run(
        change.version,
      );
    },
    change: (version) => {
      const row = db
        .prepare(
          "SELECT row_json,undone_by FROM vocabulary_changes WHERE version=?",
        )
        .get(version);
      return row
        ? ({
            ...JSON.parse(String(row.row_json)),
            undone_by: row.undone_by === null ? null : Number(row.undone_by),
          } as VocabularyChange)
        : null;
    },
    laterChanges: (version) =>
      db
        .prepare(
          "SELECT DISTINCT c.version FROM vocabulary_changes c JOIN vocabulary_change_tags t ON t.version=c.version WHERE c.version>? AND c.undone_by IS NULL AND json_extract(c.row_json,'$.op')<>'undo' AND json_extract(c.row_json,'$.outcome')='applied' AND t.tag_id IN (SELECT tag_id FROM vocabulary_change_tags WHERE version=?) ORDER BY c.version",
        )
        .all(version, version)
        .map((r) => Number(r.version)),
    markUndone: (version, by) => {
      db.prepare(
        "UPDATE vocabulary_changes SET undone_by=? WHERE version=?",
      ).run(by, version);
    },
  };
  const save = store.saveAssignment;
  store.saveAssignment = (value, actor, reason) => {
    const before = assignment(value.literature_id),
      next = save(value, actor, reason);
    db.prepare("DELETE FROM literature_tag_items WHERE literature_id=?").run(
      next.literature_id,
    );
    for (const item of next.items)
      db.prepare(
        "INSERT INTO literature_tag_items(literature_id,tag_id,rank,locked) VALUES(?,?,?,?)",
      ).run(next.literature_id, item.tag_id, item.rank, item.locked ? 1 : 0);
    db.prepare(
      "INSERT INTO tag_assignment_changes(change_id,literature_id,revision,actor,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      next.literature_id,
      next.revision,
      actor,
      before ? json(before) : null,
      json(next),
      reason,
      new Date().toISOString(),
    );
    for (const item of next.items) {
      const t = getTag(item.tag_id)!;
      if (
        t.examples.length < 8 &&
        !t.examples.some((e) => e.literature_id === next.literature_id)
      )
        store.saveTag({
          ...t,
          examples: [
            ...t.examples,
            { literature_id: next.literature_id, evidence: item.evidence[0]! },
          ],
        });
    }
    return next;
  };
  return store;
}
function resolveTags(
  store: VocabularyStore,
  values: unknown,
  children: boolean,
): string[] {
  if (!Array.isArray(values) || values.length > 64)
    throw new TagError("tags-invalid");
  const result = new Set<string>();
  for (const value of values) {
    const name = tagText(value),
      key = store.tag(name) ? name : store.nameOwner(name);
    if (!key) throw new TagError("tag-unavailable");
    let t = store.tag(key);
    const seen = new Set<string>();
    while (t?.status === "merged") {
      if (seen.has(t.tag_id)) throw new TagError("tag-merge-cycle");
      seen.add(t.tag_id);
      t = store.tag(t.merged_into!);
    }
    if (!t) throw new TagError("tag-unavailable");
    result.add(t.tag_id);
    if (children)
      for (const child of store.children(t.tag_id)) result.add(child.tag_id);
  }
  return [...result];
}
export function runTagStorage(
  db: DatabaseSync,
  action: TagStorageAction,
  args: unknown,
): unknown {
  return tx(db, !TAG_READ_ACTIONS.includes(action), () => {
    const store = vocabularyStore(db),
      r = record(args);
    if (action === "undo-preview")
      return {
        version: store.version(),
        change_version: Number(r.change_version),
        dependencies: vocabularyUndoDependencies(
          store,
          Number(r.change_version),
        ),
      };
    if (action === "state")
      return db
        .prepare(
          "SELECT version,consolidated_version FROM vocabulary_state WHERE singleton=1",
        )
        .get();
    if (action === "assignment")
      return store.assignment(parseLiteratureId(r.literature_id));
    if (action === "resolve")
      return resolveTags(store, r.values, r.children === true);
    if (action === "get") {
      const t = store.tag(tagText(r.tag_id));
      if (!t) return null;
      const uncovered = Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM literature_tag_assignments a WHERE a.vocab_version<? AND NOT EXISTS(SELECT 1 FROM tag_backfill_coverage c WHERE c.literature_id=a.literature_id AND c.tag_id=? AND c.vocab_version>=?) AND NOT EXISTS(SELECT 1 FROM literature_tag_items i WHERE i.literature_id=a.literature_id AND i.tag_id=?)",
          )
          .get(
            t.created_vocab_version,
            t.tag_id,
            t.created_vocab_version,
            t.tag_id,
          )!.n,
      );
      return {
        tag: t,
        uses: store.assignmentUses(t.tag_id),
        uncovered_literatures: uncovered,
      };
    }
    if (action === "list") {
      const limit = bounded(r.limit, 50, 200),
        offset = tagInteger(r.offset ?? 0),
        q = typeof r.query === "string" ? tagText(r.query, true, 512) : "";
      const clauses = ["t.status=?"],
        bindings: (string | number)[] = [
          r.status === "merged" ? "merged" : "active",
        ];
      if (typeof r.parent_id === "string") {
        clauses.push("t.parent_id=?");
        bindings.push(r.parent_id);
      }
      if (typeof r.category === "string") {
        clauses.push("json_extract(t.row_json,'$.category')=?");
        bindings.push(r.category);
      }
      if (q) {
        const terms = q.match(/[\p{L}\p{N}]+/gu) ?? [];
        if (!terms.length) return { items: [], total: 0, next_offset: null };
        clauses.push(
          "(t.tag_id IN (SELECT tag_id FROM tag_search WHERE tag_search MATCH ?) OR t.tag_id IN (SELECT tag_id FROM tag_aliases WHERE instr(normalized_name,?)>0))",
        );
        bindings.push(
          terms.map((w) => '"' + w.replaceAll('"', '""') + '"').join(" OR "),
          normalizedTagName(q),
        );
      }
      const where = clauses.join(" AND "),
        total = Number(
          db
            .prepare(`SELECT count(*) AS n FROM tags t WHERE ${where}`)
            .get(...bindings)!.n,
        );
      const items = db
        .prepare(
          `WITH page AS MATERIALIZED (
            SELECT t.tag_id,t.row_json,t.created_vocab_version FROM tags t
            WHERE ${where} ORDER BY t.created_vocab_version DESC,t.tag_id LIMIT ? OFFSET ?
          )
          SELECT p.row_json,count(i.literature_id) AS uses
          FROM page p LEFT JOIN literature_tag_items i ON i.tag_id=p.tag_id
          GROUP BY p.tag_id ORDER BY p.created_vocab_version DESC,p.tag_id`,
        )
        .all(...bindings, limit, offset)
        .map((row) =>
          parseTagListItem({
            ...JSON.parse(String(row.row_json)),
            uses: Number(row.uses),
          }),
        );
      return {
        items,
        total,
        next_offset:
          offset + items.length < total ? offset + items.length : null,
      };
    }
    if (action === "change") {
      const actor = r.actor;
      if (
        !["manual", "tagging", "consolidation", "backfill"].includes(
          String(actor),
        )
      )
        throw new TagError("tags-invalid");
      return changeVocabulary(store, {
        mutation: parseVocabularyMutation(r.mutation),
        expected_version: tagInteger(r.expected_version),
        actor: actor as VocabularyActor,
        reason: tagText(r.reason),
      });
    }
    if (action === "changes") {
      const since = tagInteger(r.since ?? 0),
        limit = bounded(r.limit, 100, 200);
      return db
        .prepare(
          "SELECT version FROM vocabulary_changes WHERE version>? ORDER BY version LIMIT ?",
        )
        .all(since, limit)
        .map((v) => store.change(Number(v.version)));
    }
    if (action === "assign") {
      const id = parseLiteratureId(r.literature_id),
        before = store.assignment(id),
        max = bounded(r.max, 6, 64);
      if (
        (before?.revision ?? 0) !== tagInteger(r.expected_revision) ||
        store.version() !== tagInteger(r.expected_version)
      )
        throw new TagError("tag-assignment-stale");
      if (
        !Array.isArray(r.items) ||
        !["auto", "manual", "backfill"].includes(String(r.actor))
      )
        throw new TagError("tags-invalid");
      const items = r.items.map(parseTagAssignmentItem),
        tags = new Map(items.map((i) => [i.tag_id, store.tag(i.tag_id)!]));
      for (const item of items)
        for (const evidence of item.evidence) {
          if (
            !db
              .prepare(
                "SELECT 1 FROM document_versions d JOIN document_defaults f ON f.document_version_id=d.document_version_id WHERE d.document_version_id=? AND d.literature_id=? AND d.schema_version=2",
              )
              .get(evidence.document_version_id, id)
          )
            throw new TagError("tag-evidence-stale");
        }
      if (r.source !== undefined) {
        const source = record(r.source);
        if (
          db
            .prepare(
              "SELECT metadata_revision FROM literature_metadata WHERE literature_id=?",
            )
            .get(id)?.metadata_revision !== source.metadata_revision
        )
          throw new TagError("tag-input-stale");
        if (
          source.document_version_id !== undefined &&
          !db
            .prepare(
              "SELECT 1 FROM document_defaults d JOIN structure_annotation_current a ON a.document_version_id=d.document_version_id JOIN document_versions v ON v.document_version_id=d.document_version_id JOIN literature_assets l ON l.literature_id=v.literature_id AND l.asset_id=v.source_asset_id AND l.role='primary-pdf' WHERE d.document_version_id=? AND d.revision=? AND a.annotation_id=?",
            )
            .get(
              String(source.document_version_id),
              Number(source.default_revision),
              String(source.annotation_id),
            )
        )
          throw new TagError("tag-input-stale");
      }
      const ordered = orderedTagItems(
        items,
        before?.items ?? [],
        tags,
        max,
        r.actor as "auto" | "manual" | "backfill",
      );
      const assignment = store.saveAssignment(
        {
          literature_id: id,
          items: ordered,
          vocab_version: store.version(),
          revision: 1,
          assignment_sha256: "0".repeat(64),
          model: r.model === null ? null : tagText(r.model),
        },
        String(r.actor),
        tagText(r.reason),
      );
      if (
        r.actor === "manual" &&
        assignment.items.some(
          (item) =>
            item.origin === "manual" &&
            !before?.items.some(
              (previous) =>
                previous.tag_id === item.tag_id && previous.origin === "manual",
            ),
        )
      )
        db.prepare(
          `INSERT INTO library_collected(literature_id,intake_at) VALUES(
            ?, (SELECT intake_at FROM literature_intake WHERE literature_id=?)
          ) ON CONFLICT(literature_id) DO NOTHING`,
        ).run(id, id);
      return assignment;
    }
    if (action === "backfill-candidates") {
      const ids = resolveTags(store, r.tag_ids, false),
        after = typeof r.after === "string" ? r.after : "",
        limit = bounded(r.limit, 50, 200),
        tagList = ids.map((id) => store.tag(id)!);
      // Candidate generation is deterministic and contains no model call. Keyset pages remain stable as covered rows disappear.
      const where: string[] = [],
        params: (string | number)[] = [];
      for (const t of tagList) {
        const words =
          t.kind === "compound"
            ? tagNames(t)
            : [
                ...tagNames(t),
                ...(t.definition.includes.match(/[\p{L}\p{N}]{3,}/gu) ?? []),
              ].slice(0, 64);
        const match =
          words
            .map(
              () =>
                "instr(lower(coalesce(m.title,'')||' '||coalesce(m.abstract,'')||' '||coalesce((SELECT group_concat(keyword,' ') FROM literature_metadata_keywords k WHERE k.literature_id=m.literature_id),'')),?)>0",
            )
            .join(" OR ") || "0";
        if (r.recheck_assigned === true) {
          where.push(
            "EXISTS(SELECT 1 FROM literature_tag_items i WHERE i.literature_id=a.literature_id AND i.tag_id=? AND a.literature_id>?)",
          );
          params.push(t.tag_id, after);
        } else {
          where.push(
            `(a.vocab_version<? AND NOT EXISTS(SELECT 1 FROM tag_backfill_coverage c WHERE c.literature_id=a.literature_id AND c.tag_id=? AND c.vocab_version>=?) AND ((${match}) OR (?=0 AND EXISTS(SELECT 1 FROM literature_tag_items i JOIN tags n ON n.tag_id=i.tag_id WHERE i.literature_id=a.literature_id AND (i.tag_id=? OR (? IS NOT NULL AND json_extract(n.row_json,'$.category')=?))))))`,
          );
          params.push(
            t.created_vocab_version,
            t.tag_id,
            t.created_vocab_version,
            ...words,
            t.kind === "compound" ? 1 : 0,
            t.parent_id ?? "",
            t.category ?? "",
            t.category ?? "",
          );
        }
      }
      if (!where.length) return { total: 0, literature_ids: [], next: null };
      const from = `FROM literature_tag_assignments a JOIN literature_metadata m ON m.literature_id=a.literature_id WHERE (${where.join(" OR ")})`;
      const total = Number(
        db.prepare(`SELECT count(*) AS n ${from}`).get(...params)!.n,
      );
      const rows = db
        .prepare(
          `SELECT a.literature_id ${from} AND a.literature_id>? ORDER BY a.literature_id LIMIT ?`,
        )
        .all(...params, after, limit + 1);
      const values = rows.slice(0, limit).map((v) => String(v.literature_id));
      return {
        total,
        literature_ids: values,
        next: rows.length > limit ? values.at(-1) : null,
      };
    }
    if (action === "cover") {
      const version = tagInteger(r.version);
      if (
        version > store.version() ||
        !Array.isArray(r.literature_ids) ||
        r.literature_ids.length > 200
      )
        throw new TagError("tags-invalid");
      const ids = resolveTags(store, r.tag_ids, false);
      for (const value of r.literature_ids)
        for (const id of ids)
          db.prepare(
            "INSERT INTO tag_backfill_coverage(tag_id,literature_id,vocab_version) VALUES(?,?,?) ON CONFLICT(tag_id,literature_id) DO UPDATE SET vocab_version=max(vocab_version,excluded.vocab_version)",
          ).run(id, parseLiteratureId(value), version);
      if (r.complete === true)
        for (const id of ids) {
          const t = store.tag(id)!;
          store.saveTag({ ...t, backfilled_vocab_version: version });
        }
      return { covered: r.literature_ids.length };
    }
    if (action === "consolidated") {
      const version = tagInteger(r.version);
      if (version > store.version()) throw new TagError("tags-invalid");
      db.prepare(
        "UPDATE vocabulary_state SET consolidated_version=max(consolidated_version,?) WHERE singleton=1",
      ).run(version);
      return { version };
    }
    throw new TagError("tags-invalid");
  });
}

export function resolveLibraryTagIds(
  db: DatabaseSync,
  values: readonly string[],
): string[] {
  return resolveTags(vocabularyStore(db), values, true);
}
export function tagBackfillPending(
  db: DatabaseSync,
  ids: readonly string[],
  mode: string,
): number {
  if (!ids.length) return 0;
  const wanted = JSON.stringify(ids);
  return Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM literature_tag_assignments a WHERE EXISTS(SELECT 1 FROM tags t WHERE t.tag_id IN (SELECT value FROM json_each(?)) AND a.vocab_version<t.created_vocab_version AND NOT EXISTS(SELECT 1 FROM tag_backfill_coverage c WHERE c.tag_id=t.tag_id AND c.literature_id=a.literature_id AND c.vocab_version>=t.created_vocab_version)) AND NOT EXISTS(SELECT 1 FROM literature_tag_items i WHERE i.literature_id=a.literature_id AND i.tag_id IN (SELECT value FROM json_each(?)) ${mode === "primary" ? "AND i.rank=1" : ""})`,
      )
      .get(wanted, wanted)!.n,
  );
}
