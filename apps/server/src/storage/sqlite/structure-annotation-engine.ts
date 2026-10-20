import type * as StructureRules from "../../document/structure-extract.js";
const { structureSatisfied }: typeof StructureRules = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../document/structure-extract.ts"
      : "../../document/structure-extract.js",
    import.meta.url,
  ).href
);
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { StructureAnnotation, SectionRole } from "@sciretriever/contracts";
import type { LocatedProofreadArtifact } from "./proofread-engine.js";
export type AnnotationStorageAction = "get" | "state" | "find" | "publish";
export interface AnnotationState {
  readonly part: "main" | "supplementary" | null;
  readonly current: {
    readonly annotation_id: string;
    readonly revision: number;
  } | null;
  readonly manual_revision: number;
  readonly locks: readonly {
    readonly section_id: string;
    readonly role: SectionRole;
  }[];
}
export interface AnnotationPublication {
  readonly annotation: StructureAnnotation;
  readonly method_sha256: string;
  readonly manifest: LocatedProofreadArtifact;
  readonly expected_manual_revision: number;
  readonly expected_current_revision: number | null;
  readonly edit: {
    readonly section_id: string;
    readonly role: SectionRole | null;
    readonly actor: string;
  } | null;
}
const one = (db: DatabaseSync, sql: string, ...args: SQLInputValue[]) =>
  db.prepare(sql).get(...args) ?? null;
function fail(code: string): never {
  throw Object.assign(new Error("structure annotation storage refused"), {
    code,
  });
}
function tx<T>(db: DatabaseSync, write: boolean, fn: () => T): T {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
function state(db: DatabaseSync, id: string): AnnotationState {
  const current = one(
    db,
    "SELECT annotation_id,revision FROM structure_annotation_current WHERE document_version_id=?",
    id,
  );
  const binding = one(
    db,
    "SELECT l.role FROM document_versions d JOIN literature_assets l ON l.literature_id=d.literature_id AND l.asset_id=d.source_asset_id WHERE d.document_version_id=? AND d.schema_version=2 AND l.role IN ('primary-pdf','supplementary-pdf')",
    id,
  );
  return {
    part:
      binding?.role === "primary-pdf"
        ? "main"
        : binding?.role === "supplementary-pdf"
          ? "supplementary"
          : null,
    current: current as AnnotationState["current"],
    manual_revision: Number(
      one(
        db,
        "SELECT revision FROM structure_role_state WHERE document_version_id=?",
        id,
      )?.revision ?? 0,
    ),
    locks: db
      .prepare(
        "SELECT section_id,role FROM structure_role_decisions WHERE document_version_id=? AND active=1 ORDER BY section_id",
      )
      .all(id) as unknown as AnnotationState["locks"],
  };
}
export function runAnnotationStorage(
  db: DatabaseSync,
  action: AnnotationStorageAction,
  args: unknown,
): unknown {
  if (
    ![11].includes(
      Number(
        one(db, "SELECT schema_version FROM schema_identity WHERE singleton=1")
          ?.schema_version,
      ),
    )
  )
    fail("catalog-current-required");
  if (action === "get")
    return one(
      db,
      "SELECT * FROM structure_annotations WHERE annotation_id=?",
      String(args),
    );
  if (action === "state") return tx(db, false, () => state(db, String(args)));
  if (action === "find") {
    const r = args as {
      document_version_id: string;
      method_sha256: string;
      manual_revision: number;
    };
    return one(
      db,
      "SELECT * FROM structure_annotations WHERE document_version_id=? AND method_sha256=? AND manual_revision=?",
      r.document_version_id,
      r.method_sha256,
      r.manual_revision,
    );
  }
  return tx(db, true, () => {
    const p = args as AnnotationPublication,
      a = p.annotation,
      id = a.document_version_id,
      now = new Date().toISOString();
    const document = one(
      db,
      "SELECT schema_version FROM document_versions WHERE document_version_id=?",
      id,
    );
    if (document?.schema_version !== 2) fail("annotation-proofread-required");
    const before = state(db, id);
    if (
      p.edit
        ? a.method.mode !== "manual" ||
          a.method.base_annotation_id !== before.current?.annotation_id
        : a.method.mode !== "automatic" || a.method.base_annotation_id !== null
    )
      fail("annotation-method-conflict");
    if (before.part !== a.part) fail("annotation-part-stale");
    if (before.manual_revision !== p.expected_manual_revision)
      fail("annotation-manual-stale");
    const existing = one(
      db,
      "SELECT * FROM structure_annotations WHERE document_version_id=? AND method_sha256=? AND manual_revision=?",
      id,
      p.method_sha256,
      a.manual_revision,
    );
    // A racing identical build reuses the first published model decision; never overwrite it.
    if (
      before.current &&
      !p.edit &&
      existing &&
      before.current?.annotation_id === existing.annotation_id
    )
      return {
        annotation_id: existing.annotation_id,
        published: false,
        revision: before.current.revision,
        manual_revision: before.manual_revision,
      };
    if ((before.current?.revision ?? null) !== p.expected_current_revision)
      fail("annotation-current-stale");
    const locks = new Map(before.locks.map((l) => [l.section_id, l.role]));
    if (p.edit) {
      if (!a.sections.some((s) => s.section_id === p.edit!.section_id))
        fail("annotation-section-missing");
      if (p.edit.role === null) {
        if (!locks.delete(p.edit.section_id)) fail("annotation-lock-missing");
      } else locks.set(p.edit.section_id, p.edit.role);
    }
    if (
      a.manual_revision !== before.manual_revision + (p.edit ? 1 : 0) ||
      a.sections.filter((s) => s.locked).length !== locks.size ||
      a.sections.some(
        (s) =>
          s.locked &&
          (locks.get(s.section_id) !== s.role || s.role_source !== "manual"),
      )
    )
      fail("annotation-manual-conflict");
    if (p.edit) {
      db.prepare(
        "UPDATE structure_role_decisions SET active=0,revoked_by=?,revoked_at=? WHERE document_version_id=? AND section_id=? AND active=1",
      ).run(p.edit.actor, now, id, p.edit.section_id);
      if (p.edit.role !== null)
        db.prepare(
          "INSERT INTO structure_role_decisions(decision_id,document_version_id,section_id,role,active,actor,created_at) VALUES(?,?,?,?,1,?,?)",
        ).run(
          randomUUID(),
          id,
          p.edit.section_id,
          p.edit.role,
          p.edit.actor,
          now,
        );
      db.prepare(
        "INSERT INTO structure_role_state(document_version_id,revision) VALUES(?,?) ON CONFLICT(document_version_id) DO UPDATE SET revision=excluded.revision",
      ).run(id, a.manual_revision);
    }
    if (!existing) {
      const m = p.manifest,
        prior = one(
          db,
          "SELECT * FROM artifact_objects WHERE sha256=? OR relative_path=?",
          m.sha256,
          m.reference,
        );
      if (prior) {
        if (
          prior.sha256 !== m.sha256 ||
          prior.relative_path !== m.reference ||
          prior.byte_size !== m.byte_size ||
          prior.media_type !== m.media_type
        )
          fail("annotation-artifact-conflict");
      } else
        db.prepare(
          "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
        ).run(randomUUID(), m.sha256, m.byte_size, m.media_type, m.reference);
      db.prepare(
        "INSERT INTO structure_annotations(annotation_id,document_version_id,method_sha256,manual_revision,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,created_at,structure_satisfied) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        a.annotation_id,
        id,
        p.method_sha256,
        a.manual_revision,
        m.reference,
        m.sha256,
        m.byte_size,
        m.media_type,
        now,
        Number(structureSatisfied(a.part, a.sections)),
      );
    }
    const chosen = String(existing?.annotation_id ?? a.annotation_id),
      revision =
        (before.current?.revision ?? 0) +
        (before.current?.annotation_id === chosen ? 0 : 1);
    db.prepare(
      "INSERT INTO structure_annotation_current(document_version_id,annotation_id,revision) VALUES(?,?,?) ON CONFLICT(document_version_id) DO UPDATE SET annotation_id=excluded.annotation_id,revision=excluded.revision",
    ).run(id, chosen, revision);
    return {
      annotation_id: chosen,
      published: !existing,
      revision,
      manual_revision: a.manual_revision,
    };
  });
}
