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
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  ArtifactRef,
  ProofreadVersion,
  ProofreadVersionV2,
} from "@sciretriever/contracts";
import type * as Defaults from "./document-defaults.js";
const { recomputeAssetDocumentDefaults }: typeof Defaults = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./document-defaults.ts"
      : "./document-defaults.js",
    import.meta.url,
  ).href
);
export type ProofreadStorageAction =
  | "cache-read"
  | "cache-write"
  | "binding"
  | "current"
  | "get"
  | "document-source"
  | "state"
  | "resources"
  | "render-resources"
  | "publish"
  | "decide"
  | "revoke";
export interface LocatedProofreadArtifact extends ArtifactRef {
  readonly reference: string;
}
export interface ProofreadPublication {
  readonly version: ProofreadVersion | ProofreadVersionV2;
  readonly expected_current_revision?: number | null;
  readonly manual_decisions?: {
    readonly expected_proofread_id: string;
    readonly actor: string;
    readonly items: readonly {
      readonly decision_id: string;
      readonly block_id: string;
      readonly scope_key: string;
      readonly manifest: LocatedProofreadArtifact;
    }[];
  };
  readonly manual_revision: number;
  readonly manifest: LocatedProofreadArtifact;
  readonly manual_edit?: {
    readonly expected_proofread_id: string;
    readonly actor: string;
    readonly replaced_scopes: readonly string[];
    readonly decision: {
      readonly decision_id: string;
      readonly block_id: string;
      readonly manifest: LocatedProofreadArtifact;
    };
  };
  readonly resources: readonly (LocatedProofreadArtifact & {
    readonly kind: "blocks" | "markdown" | "drafts" | "image";
    readonly logical_reference: string;
  })[];
}
export interface ProofreadDecisionPublication {
  readonly scope_key: string;
  readonly part_asset_id: string;
  readonly proofread_id: string;
  readonly expected_manual_revision: number;
  readonly decision_id: string;
  readonly block_id: string;
  readonly actor: string;
  readonly manifest: LocatedProofreadArtifact;
}
const one = (db: DatabaseSync, sql: string, ...args: SQLInputValue[]) =>
  db.prepare(sql).get(...args) ?? null;
function fail(code: string): never {
  throw Object.assign(new Error("proofread storage refused"), { code });
}
function transaction<T>(db: DatabaseSync, write: boolean, fn: () => T): T {
  if (write) beginCatalogWrite(db);
  else db.exec("BEGIN");
  try {
    const result = fn();
    if (write) commitCatalogWrite(db);
    else db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function register(db: DatabaseSync, a: LocatedProofreadArtifact) {
  const old = one(
    db,
    "SELECT artifact_id,sha256,byte_size,media_type,relative_path FROM artifact_objects WHERE sha256=? OR relative_path=?",
    a.sha256,
    a.reference,
  );
  if (old) {
    if (
      old.sha256 !== a.sha256 ||
      old.relative_path !== a.reference ||
      old.byte_size !== a.byte_size ||
      old.media_type !== a.media_type
    )
      fail("proofread-artifact-conflict");
  } else
    db.prepare(
      "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
    ).run(randomUUID(), a.sha256, a.byte_size, a.media_type, a.reference);
}
function revision(db: DatabaseSync, asset: string) {
  return Number(
    one(
      db,
      "SELECT revision FROM proofread_manual_state WHERE part_asset_id=?",
      asset,
    )?.revision ?? 0,
  );
}
export function runProofreadStorage(
  db: DatabaseSync,
  action: ProofreadStorageAction,
  args: unknown,
): unknown {
  if (
    ![19].includes(
      Number(
        one(db, "SELECT schema_version FROM schema_identity WHERE singleton=1")
          ?.schema_version,
      ),
    )
  )
    fail("catalog-current-required");
  if (action === "cache-read")
    return one(
      db,
      "SELECT cache_key,cache_id,artifact_reference,sha256,byte_size,media_type FROM proofread_correction_cache WHERE cache_key=? OR cache_id=?",
      String(args),
      String(args),
    );
  if (action === "cache-write")
    return transaction(db, true, () => {
      const r = args as { key: string; artifact: LocatedProofreadArtifact };
      if (!/^[a-f0-9]{64}$/u.test(r.key)) fail("proofread-cache-invalid");
      const id = `${r.key.slice(0, 8)}-${r.key.slice(8, 12)}-${r.key.slice(12, 16)}-${r.key.slice(16, 20)}-${r.key.slice(20, 32)}`;
      const old = one(
        db,
        "SELECT cache_key,cache_id,artifact_reference,sha256,byte_size,media_type FROM proofread_correction_cache WHERE cache_key=?",
        r.key,
      );
      if (old) {
        if (old.sha256 !== r.artifact.sha256) fail("proofread-cache-conflict");
        return String(old.cache_id);
      }
      register(db, r.artifact);
      db.prepare(
        "INSERT INTO proofread_correction_cache(cache_key,cache_id,artifact_reference,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?)",
      ).run(
        r.key,
        id,
        r.artifact.reference,
        r.artifact.sha256,
        r.artifact.byte_size,
        r.artifact.media_type,
      );
      return id;
    });
  if (action === "binding")
    return one(
      db,
      "SELECT d.document_version_id,dv.proofread_id FROM document_defaults d JOIN document_versions dv ON dv.document_version_id=d.document_version_id WHERE dv.source_asset_id=? ORDER BY d.document_version_id LIMIT 1",
      String(args),
    );
  if (action === "current")
    return one(
      db,
      "SELECT c.part_asset_id,c.manual_revision,c.part_sha256,c.proofread_id,c.revision,v.content_sha256,v.status FROM proofread_current c JOIN proofread_versions v ON v.proofread_id=c.proofread_id WHERE c.part_asset_id=?",
      String(args),
    );
  if (action === "get")
    return one(
      db,
      "SELECT proofread_id,part_asset_id,part_sha256,content_sha256,status,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,created_at FROM proofread_versions WHERE proofread_id=?",
      String(args),
    );
  if (action === "document-source")
    return transaction(db, false, () => ({
      version: one(
        db,
        "SELECT proofread_id,part_asset_id,part_sha256,content_sha256,status,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,created_at FROM proofread_versions WHERE proofread_id=?",
        String(args),
      ),
      blocks: one(
        db,
        "SELECT proofread_id,kind,reference,artifact_reference,sha256,byte_size,media_type FROM proofread_resources WHERE proofread_id=? AND kind='blocks' AND reference=''",
        String(args),
      ),
    }));
  if (action === "resources")
    return db
      .prepare(
        "SELECT proofread_id,kind,reference,artifact_reference,sha256,byte_size,media_type FROM proofread_resources WHERE proofread_id=? ORDER BY kind,reference",
      )
      .all(String(args));
  if (action === "state")
    return transaction(db, false, () => ({
      current: one(
        db,
        "SELECT c.part_asset_id,c.manual_revision,c.part_sha256,c.proofread_id,c.revision,v.content_sha256,v.status FROM proofread_current c JOIN proofread_versions v ON v.proofread_id=c.proofread_id WHERE c.part_asset_id=?",
        String(args),
      ),
      last_manual_edit:
        db
          .prepare(
            "SELECT actor,at FROM (SELECT actor,created_at AS at FROM proofread_manual_decisions WHERE part_asset_id=? UNION ALL SELECT revoked_by AS actor,revoked_at AS at FROM proofread_manual_decisions WHERE part_asset_id=? AND revoked_at IS NOT NULL) ORDER BY at DESC LIMIT 1",
          )
          .get(String(args), String(args)) ?? null,
      manual_revision: revision(db, String(args)),
      decisions: db
        .prepare(
          "SELECT decision_id,part_asset_id,block_id,scope_key,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,active,actor,created_at,revoked_by,revoked_at FROM proofread_manual_decisions WHERE part_asset_id=? AND active=1 ORDER BY decision_id",
        )
        .all(String(args)),
    }));
  return transaction(db, true, () => {
    if (action === "render-resources") {
      const p = args as {
        proofread_id: string;
        manual_revision: number;
        resources: ProofreadPublication["resources"];
      };
      const current = one(
        db,
        "SELECT p.proofread_id,p.part_asset_id,p.part_sha256,p.content_sha256,p.status,p.manifest_reference,p.manifest_sha256,p.manifest_size,p.manifest_media_type,p.created_at FROM proofread_current c JOIN proofread_versions p USING(proofread_id) WHERE p.proofread_id=?",
        p.proofread_id,
      );
      if (
        !current ||
        current.status !== "complete" ||
        revision(db, String(current.part_asset_id)) !== p.manual_revision
      )
        fail("proofread-current-stale");
      for (const r of p.resources) {
        register(db, r);
        const old = one(
          db,
          "SELECT proofread_id,kind,reference,artifact_reference,sha256,byte_size,media_type FROM proofread_resources WHERE proofread_id=? AND kind=? AND reference=?",
          p.proofread_id,
          r.kind,
          r.logical_reference,
        );
        if (
          old &&
          (old.sha256 !== r.sha256 || old.artifact_reference !== r.reference)
        )
          fail("proofread-artifact-conflict");
        if (!old)
          db.prepare(
            "INSERT INTO proofread_resources(proofread_id,kind,reference,artifact_reference,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?,?)",
          ).run(
            p.proofread_id,
            r.kind,
            r.logical_reference,
            r.reference,
            r.sha256,
            r.byte_size,
            r.media_type,
          );
      }
      return { registered: true };
    }
    if (action === "publish") {
      const p = args as ProofreadPublication,
        v = p.version;
      if (revision(db, v.part_asset_id) !== p.manual_revision)
        fail("proofread-manual-stale");
      const head = one(
        db,
        "SELECT part_asset_id,manual_revision,part_sha256,proofread_id,revision FROM proofread_current WHERE part_asset_id=?",
        v.part_asset_id,
      );
      if (
        Object.hasOwn(p, "expected_current_revision") &&
        (head?.revision ?? null) !== p.expected_current_revision &&
        head?.proofread_id !== v.proofread_id
      )
        fail("proofread-current-stale");
      let manualRevision = p.manual_revision;
      if (p.manual_decisions) {
        const e = p.manual_decisions;
        if (head?.proofread_id !== e.expected_proofread_id)
          fail("proofread-manual-stale");
        const now = new Date().toISOString();
        for (const item of e.items) {
          register(db, item.manifest);
          db.prepare(
            "UPDATE proofread_manual_decisions SET active=0,revoked_by=?,revoked_at=? WHERE part_asset_id=? AND scope_key=? AND active=1",
          ).run(e.actor, now, v.part_asset_id, item.scope_key);
          const m = item.manifest;
          db.prepare(
            "INSERT INTO proofread_manual_decisions(decision_id,part_asset_id,block_id,scope_key,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,active,actor,created_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
          ).run(
            item.decision_id,
            v.part_asset_id,
            item.block_id,
            item.scope_key,
            m.reference,
            m.sha256,
            m.byte_size,
            m.media_type,
            e.actor,
            now,
          );
        }
        db.prepare(
          "INSERT INTO proofread_manual_state(part_asset_id,revision) VALUES(?,1) ON CONFLICT(part_asset_id) DO UPDATE SET revision=revision+1",
        ).run(v.part_asset_id);
        manualRevision = revision(db, v.part_asset_id);
        const active = db
          .prepare(
            "SELECT decision_id FROM proofread_manual_decisions WHERE part_asset_id=? AND active=1 ORDER BY decision_id",
          )
          .all(v.part_asset_id)
          .map((r) => String(r.decision_id));
        if (
          JSON.stringify(active) !==
          JSON.stringify([...v.manual_decision_ids].sort())
        )
          fail("proofread-manual-stale");
      }
      if (p.manual_edit) {
        const e = p.manual_edit;
        if (
          one(
            db,
            "SELECT proofread_id FROM proofread_current WHERE part_asset_id=?",
            v.part_asset_id,
          )?.proofread_id !== e.expected_proofread_id
        )
          fail("proofread-manual-stale");
        const now = new Date().toISOString();
        register(db, e.decision.manifest);
        for (const scope of ["document-edit", ...e.replaced_scopes])
          db.prepare(
            "UPDATE proofread_manual_decisions SET active=0,revoked_by=?,revoked_at=? WHERE part_asset_id=? AND scope_key=? AND active=1",
          ).run(e.actor, now, v.part_asset_id, scope);
        const m = e.decision.manifest;
        db.prepare(
          "INSERT INTO proofread_manual_decisions(decision_id,part_asset_id,block_id,scope_key,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,active,actor,created_at) VALUES(?,?,?,'document-edit',?,?,?,?,1,?,?)",
        ).run(
          e.decision.decision_id,
          v.part_asset_id,
          e.decision.block_id,
          m.reference,
          m.sha256,
          m.byte_size,
          m.media_type,
          e.actor,
          now,
        );
        db.prepare(
          "INSERT INTO proofread_manual_state(part_asset_id,revision) VALUES(?,1) ON CONFLICT(part_asset_id) DO UPDATE SET revision=revision+1",
        ).run(v.part_asset_id);
        manualRevision = revision(db, v.part_asset_id);
        const active = db
          .prepare(
            "SELECT decision_id FROM proofread_manual_decisions WHERE part_asset_id=? AND active=1 ORDER BY decision_id",
          )
          .all(v.part_asset_id)
          .map((r) => String(r.decision_id));
        if (
          JSON.stringify(active) !==
          JSON.stringify([...v.manual_decision_ids].sort())
        )
          fail("proofread-manual-stale");
      }
      for (const input of [v.draft_input]) {
        const raw = one(
          db,
          "SELECT p.source_asset_id,p.source_sha256,p.result_sha256,c.raw_parse_id AS current_id FROM raw_parses p LEFT JOIN raw_parse_current c ON c.source_asset_id=p.source_asset_id AND c.profile=p.profile WHERE p.raw_parse_id=?",
          input.raw_parse_id,
        );
        if (
          !raw ||
          raw.source_asset_id !== v.part_asset_id ||
          raw.source_sha256 !== v.part_sha256 ||
          raw.result_sha256 !== input.result_sha256 ||
          raw.current_id !== input.raw_parse_id
        )
          fail("proofread-input-stale");
      }
      const old = one(
        db,
        "SELECT content_sha256 FROM proofread_versions WHERE proofread_id=?",
        v.proofread_id,
      );
      if (old && old.content_sha256 !== v.content_sha256)
        fail("proofread-conflict");
      if (!old) {
        register(db, p.manifest);
        for (const r of p.resources) register(db, r);
        db.prepare(
          "INSERT INTO proofread_versions(proofread_id,part_asset_id,part_sha256,content_sha256,status,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          v.proofread_id,
          v.part_asset_id,
          v.part_sha256,
          v.content_sha256,
          v.status,
          p.manifest.reference,
          p.manifest.sha256,
          p.manifest.byte_size,
          p.manifest.media_type,
          new Date().toISOString(),
        );
        for (const r of p.resources)
          db.prepare(
            "INSERT INTO proofread_resources(proofread_id,kind,reference,artifact_reference,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?,?)",
          ).run(
            v.proofread_id,
            r.kind,
            r.logical_reference,
            r.reference,
            r.sha256,
            r.byte_size,
            r.media_type,
          );
        for (const r of [v.draft_input])
          db.prepare(
            "INSERT INTO raw_parse_pins(raw_parse_id,proofread_id) VALUES(?,?) ON CONFLICT DO NOTHING",
          ).run(r.raw_parse_id, v.proofread_id);
      }
      const current = one(
        db,
        "SELECT part_asset_id,manual_revision,part_sha256,proofread_id,revision FROM proofread_current WHERE part_asset_id=?",
        v.part_asset_id,
      );
      if (
        current?.proofread_id !== v.proofread_id ||
        current?.manual_revision !== manualRevision
      )
        db.prepare(
          "INSERT INTO proofread_current(part_asset_id,part_sha256,proofread_id,revision,manual_revision) VALUES(?,?,?,1,?) ON CONFLICT(part_asset_id) DO UPDATE SET part_sha256=excluded.part_sha256,proofread_id=excluded.proofread_id,revision=proofread_current.revision+1,manual_revision=excluded.manual_revision",
        ).run(v.part_asset_id, v.part_sha256, v.proofread_id, manualRevision);
      const defaults = recomputeAssetDocumentDefaults(
        db,
        v.part_asset_id,
        v.part_sha256,
      );
      return {
        published: !old,
        default_changed: defaults.some((d) => d.default_changed),
        revision: Number(
          one(
            db,
            "SELECT revision FROM proofread_current WHERE part_asset_id=?",
            v.part_asset_id,
          )!.revision,
        ),
      };
    }
    if (action === "decide") {
      const p = args as ProofreadDecisionPublication;
      if (
        revision(db, p.part_asset_id) !== p.expected_manual_revision ||
        one(
          db,
          "SELECT proofread_id FROM proofread_current WHERE part_asset_id=?",
          p.part_asset_id,
        )?.proofread_id !== p.proofread_id
      )
        fail("proofread-manual-stale");
      register(db, p.manifest);
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE proofread_manual_decisions SET active=0,revoked_by=?,revoked_at=? WHERE part_asset_id=? AND scope_key=? AND active=1",
      ).run(p.actor, now, p.part_asset_id, p.scope_key);
      db.prepare(
        "INSERT INTO proofread_manual_decisions(decision_id,part_asset_id,block_id,scope_key,manifest_reference,manifest_sha256,manifest_size,manifest_media_type,active,actor,created_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
      ).run(
        p.decision_id,
        p.part_asset_id,
        p.block_id,
        p.scope_key,
        p.manifest.reference,
        p.manifest.sha256,
        p.manifest.byte_size,
        p.manifest.media_type,
        p.actor,
        now,
      );
      db.prepare(
        "INSERT INTO proofread_manual_state(part_asset_id,revision) VALUES(?,1) ON CONFLICT(part_asset_id) DO UPDATE SET revision=revision+1",
      ).run(p.part_asset_id);
      return {
        decision_id: p.decision_id,
        manual_revision: revision(db, p.part_asset_id),
      };
    }
    if (action === "revoke") {
      const p = args as {
        part_asset_id: string;
        decision_id: string;
        expected_manual_revision: number;
        actor: string;
      };
      if (revision(db, p.part_asset_id) !== p.expected_manual_revision)
        fail("proofread-manual-stale");
      const changed = db
        .prepare(
          "UPDATE proofread_manual_decisions SET active=0,revoked_by=?,revoked_at=? WHERE decision_id=? AND part_asset_id=? AND active=1",
        )
        .run(
          p.actor,
          new Date().toISOString(),
          p.decision_id,
          p.part_asset_id,
        ).changes;
      if (!changed) fail("proofread-decision-missing");
      db.prepare(
        "UPDATE proofread_manual_state SET revision=revision+1 WHERE part_asset_id=?",
      ).run(p.part_asset_id);
      return { manual_revision: revision(db, p.part_asset_id) };
    }
    return fail("proofread-invalid-operation");
  });
}
