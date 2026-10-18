import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
export class KnowledgeStorageFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super("knowledge storage operation refused");
    this.code = code;
  }
}
function fail(code: string): never {
  throw new KnowledgeStorageFailure(code);
}
function one(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number)[]
): Row | null {
  return (db.prepare(sql).get(...args) as Row | undefined) ?? null;
}
function tx<T>(db: DatabaseSync, mode: "" | " IMMEDIATE", work: () => T): T {
  db.exec(`BEGIN${mode}`);
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function requireV6(db: DatabaseSync): void {
  if (
    ![6, 7, 8, 9, 10].includes(
      Number(
        one(db, "SELECT schema_version FROM schema_identity WHERE singleton=1")
          ?.schema_version,
      ),
    )
  )
    fail("catalog-v6-required");
}
function read(
  db: DatabaseSync,
  where: "artifact_id" | "comparison_sha256",
  key: string,
): unknown {
  return tx(db, "", () => {
    const row = one(
      db,
      `SELECT * FROM knowledge_artifacts WHERE ${where}=?`,
      key,
    );
    if (!row) return null;
    const id = String(row.artifact_id);
    return {
      row,
      materials: db
        .prepare(
          "SELECT input_id,literature_id,asset_id,asset_sha256 FROM knowledge_input_materials WHERE artifact_id=? ORDER BY input_id",
        )
        .all(id),
      documents: db
        .prepare(
          "SELECT input_id,document_version_id,representation_sha256 FROM knowledge_input_documents WHERE artifact_id=? ORDER BY input_id",
        )
        .all(id),
      artifacts: db
        .prepare(
          "SELECT input_id,source_artifact_id,source_content_sha256,compression_depth FROM knowledge_input_artifacts WHERE artifact_id=? ORDER BY input_id",
        )
        .all(id),
    };
  });
}
interface Publish {
  readonly artifact_id: string;
  readonly comparison_sha256: string;
  readonly scope_kind: "literature" | "manifest";
  readonly scope_key: string;
  readonly purpose: string;
  readonly question_sha256: string;
  readonly question_text: string | null;
  readonly manifest_sha256: string;
  readonly manifest_json: string;
  readonly method_id: string;
  readonly method_version: string;
  readonly parameters_sha256: string;
  readonly method_json: string;
  readonly content_sha256: string;
  readonly content_size: number;
  readonly content_media_type: string;
  readonly content_reference: string;
  readonly coverage_json: string;
  readonly provenance_json: string;
  readonly created_at: string;
  readonly input: {
    readonly input_id: string;
    readonly literature_id: string;
    readonly asset_id: string;
    readonly asset_sha256: string;
    readonly asset_byte_size: number;
    readonly document_version_id: string;
    readonly representation_sha256: string;
  };
}
interface SynthesisPublish extends Omit<Publish, "input"> {
  readonly input: {
    readonly missing_knowledge: readonly string[];
    readonly missing_pdf_literatures: readonly string[];
    readonly missing_documents: readonly {
      readonly literature_id: string;
      readonly asset_id: string;
      readonly asset_sha256: string;
    }[];
    readonly materials: readonly {
      readonly input_id: string;
      readonly literature_id: string;
      readonly asset_id: string;
      readonly asset_sha256: string;
      readonly asset_byte_size: number;
    }[];
    readonly documents: readonly {
      readonly input_id: string;
      readonly document_version_id: string;
      readonly representation_sha256: string;
      readonly asset_id: string;
      readonly asset_sha256: string;
      readonly literature_id: string;
      readonly asset_byte_size: number;
    }[];
    readonly artifacts: readonly {
      readonly input_id: string;
      readonly source_artifact_id: string;
      readonly source_content_sha256: string;
      readonly source_manifest_sha256: string;
      readonly compression_depth: number;
    }[];
  };
}
function publishSynthesis(
  db: DatabaseSync,
  p: SynthesisPublish,
): { readonly artifact_id: string; readonly published: boolean } {
  return tx(db, " IMMEDIATE", () => {
    if (
      ![7, 8, 9, 10].includes(
        Number(
          one(
            db,
            "SELECT schema_version FROM schema_identity WHERE singleton=1",
          )?.schema_version,
        ),
      ) ||
      p.scope_kind !== "manifest" ||
      p.scope_key !== p.manifest_sha256 ||
      p.purpose !== "synthesis" ||
      !p.question_text
    )
      fail("catalog-v7-required");
    const previous = one(
      db,
      "SELECT artifact_id FROM knowledge_artifacts WHERE comparison_sha256=?",
      p.comparison_sha256,
    );
    if (previous)
      return { artifact_id: String(previous.artifact_id), published: false };
    for (const input of p.input.materials) {
      const asset = one(
        db,
        "SELECT sha256,size_bytes,media_type FROM assets WHERE asset_id=?",
        input.asset_id,
      );
      const relation = one(
        db,
        "SELECT 1 AS present FROM literature_assets WHERE literature_id=? AND asset_id=? AND role IN ('primary-pdf','supplementary-pdf')",
        input.literature_id,
        input.asset_id,
      );
      if (
        !asset ||
        !relation ||
        asset.sha256 !== input.asset_sha256 ||
        asset.size_bytes !== input.asset_byte_size ||
        asset.media_type !== "application/pdf"
      )
        fail("input-invalidated");
    }
    for (const id of p.input.missing_knowledge)
      if (
        one(
          db,
          "SELECT 1 AS present FROM knowledge_artifacts WHERE artifact_id=?",
          id,
        )
      )
        fail("input-invalidated");
    for (const id of p.input.missing_pdf_literatures)
      if (
        !one(
          db,
          "SELECT 1 AS present FROM literatures WHERE literature_id=?",
          id,
        ) ||
        one(
          db,
          "SELECT 1 AS present FROM literature_assets WHERE literature_id=? AND role IN ('primary-pdf','supplementary-pdf')",
          id,
        )
      )
        fail("input-invalidated");
    for (const input of p.input.missing_documents)
      if (
        one(
          db,
          "SELECT 1 AS present FROM document_defaults d JOIN document_versions v ON v.document_version_id=d.document_version_id WHERE v.literature_id=? AND v.source_asset_id=? AND v.source_sha256=?",
          input.literature_id,
          input.asset_id,
          input.asset_sha256,
        )
      )
        fail("input-invalidated");
    for (const input of p.input.documents) {
      const source = one(
        db,
        "SELECT literature_id,source_asset_id,source_sha256,source_byte_size,representation_sha256 FROM document_versions WHERE document_version_id=?",
        input.document_version_id,
      );
      if (
        !source ||
        source.literature_id !== input.literature_id ||
        source.source_asset_id !== input.asset_id ||
        source.source_sha256 !== input.asset_sha256 ||
        source.source_byte_size !== input.asset_byte_size ||
        source.representation_sha256 !== input.representation_sha256
      )
        fail("input-invalidated");
    }
    for (const input of p.input.artifacts) {
      const source = one(
        db,
        "SELECT content_sha256,manifest_sha256,scope_kind FROM knowledge_artifacts WHERE artifact_id=?",
        input.source_artifact_id,
      );
      const child = one(
        db,
        "SELECT MAX(compression_depth) AS depth FROM knowledge_input_artifacts WHERE artifact_id=?",
        input.source_artifact_id,
      );
      const depth =
        source?.scope_kind === "literature" ? 1 : Number(child?.depth ?? 0) + 1;
      if (
        !source ||
        source.content_sha256 !== input.source_content_sha256 ||
        source.manifest_sha256 !== input.source_manifest_sha256 ||
        input.source_artifact_id === p.artifact_id ||
        input.compression_depth !== depth ||
        depth < 1 ||
        depth > 32
      )
        fail("input-invalidated");
    }
    const existingContent = one(
      db,
      "SELECT relative_path,byte_size,media_type FROM artifact_objects WHERE sha256=?",
      p.content_sha256,
    );
    if (existingContent) {
      if (
        existingContent.relative_path !== p.content_reference ||
        existingContent.byte_size !== p.content_size ||
        existingContent.media_type !== p.content_media_type
      )
        fail("content-conflict");
    } else {
      db.prepare(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
      ).run(
        p.artifact_id,
        p.content_sha256,
        p.content_size,
        p.content_media_type,
        p.content_reference,
      );
    }
    db.prepare(
      "INSERT INTO knowledge_artifacts(artifact_id,comparison_sha256,scope_kind,scope_key,purpose,question_sha256,question_text,manifest_sha256,manifest_json,method_id,method_version,parameters_sha256,method_json,content_sha256,content_size,content_media_type,content_reference,coverage_json,provenance_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      p.artifact_id,
      p.comparison_sha256,
      p.scope_kind,
      p.scope_key,
      p.purpose,
      p.question_sha256,
      p.question_text,
      p.manifest_sha256,
      p.manifest_json,
      p.method_id,
      p.method_version,
      p.parameters_sha256,
      p.method_json,
      p.content_sha256,
      p.content_size,
      p.content_media_type,
      p.content_reference,
      p.coverage_json,
      p.provenance_json,
      p.created_at,
    );
    for (const input of p.input.materials)
      db.prepare(
        "INSERT INTO knowledge_input_materials(artifact_id,input_id,literature_id,asset_id,asset_sha256) VALUES(?,?,?,?,?)",
      ).run(
        p.artifact_id,
        input.input_id,
        input.literature_id,
        input.asset_id,
        input.asset_sha256,
      );
    for (const input of p.input.documents)
      db.prepare(
        "INSERT INTO knowledge_input_documents(artifact_id,input_id,document_version_id,representation_sha256) VALUES(?,?,?,?)",
      ).run(
        p.artifact_id,
        input.input_id,
        input.document_version_id,
        input.representation_sha256,
      );
    for (const input of p.input.artifacts)
      db.prepare(
        "INSERT INTO knowledge_input_artifacts(artifact_id,input_id,source_artifact_id,source_content_sha256,compression_depth) VALUES(?,?,?,?,?)",
      ).run(
        p.artifact_id,
        input.input_id,
        input.source_artifact_id,
        input.source_content_sha256,
        input.compression_depth,
      );
    return { artifact_id: p.artifact_id, published: true };
  });
}
function publish(
  db: DatabaseSync,
  p: Publish,
): { readonly artifact_id: string; readonly published: boolean } {
  return tx(db, " IMMEDIATE", () => {
    const previous = one(
      db,
      "SELECT artifact_id FROM knowledge_artifacts WHERE comparison_sha256=?",
      p.comparison_sha256,
    );
    if (previous)
      return { artifact_id: String(previous.artifact_id), published: false };
    const input = p.input;
    const source = one(
      db,
      "SELECT literature_id,source_asset_id,source_sha256,source_byte_size,representation_sha256 FROM document_versions WHERE document_version_id=?",
      input.document_version_id,
    );
    const asset = one(
      db,
      "SELECT sha256,size_bytes,media_type FROM assets WHERE asset_id=?",
      input.asset_id,
    );
    if (
      !source ||
      source.literature_id !== input.literature_id ||
      source.source_asset_id !== input.asset_id ||
      source.source_sha256 !== input.asset_sha256 ||
      source.source_byte_size !== input.asset_byte_size ||
      source.representation_sha256 !== input.representation_sha256 ||
      !asset ||
      asset.sha256 !== input.asset_sha256 ||
      asset.size_bytes !== input.asset_byte_size ||
      asset.media_type !== "application/pdf" ||
      p.scope_kind !== "literature" ||
      p.scope_key !== input.literature_id ||
      p.purpose === "synthesis"
    )
      fail("input-invalidated");
    const existingContent = one(
      db,
      "SELECT relative_path,byte_size,media_type FROM artifact_objects WHERE sha256=?",
      p.content_sha256,
    );
    if (existingContent) {
      if (
        existingContent.relative_path !== p.content_reference ||
        existingContent.byte_size !== p.content_size ||
        existingContent.media_type !== p.content_media_type
      )
        fail("content-conflict");
    } else {
      db.prepare(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
      ).run(
        p.artifact_id,
        p.content_sha256,
        p.content_size,
        p.content_media_type,
        p.content_reference,
      );
    }
    db.prepare(
      "INSERT INTO knowledge_artifacts(artifact_id,comparison_sha256,scope_kind,scope_key,purpose,question_sha256,question_text,manifest_sha256,manifest_json,method_id,method_version,parameters_sha256,method_json,content_sha256,content_size,content_media_type,content_reference,coverage_json,provenance_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      p.artifact_id,
      p.comparison_sha256,
      p.scope_kind,
      p.scope_key,
      p.purpose,
      p.question_sha256,
      p.question_text,
      p.manifest_sha256,
      p.manifest_json,
      p.method_id,
      p.method_version,
      p.parameters_sha256,
      p.method_json,
      p.content_sha256,
      p.content_size,
      p.content_media_type,
      p.content_reference,
      p.coverage_json,
      p.provenance_json,
      p.created_at,
    );
    db.prepare(
      "INSERT INTO knowledge_input_materials(artifact_id,input_id,literature_id,asset_id,asset_sha256) VALUES(?,?,?,?,?)",
    ).run(
      p.artifact_id,
      input.input_id,
      input.literature_id,
      input.asset_id,
      input.asset_sha256,
    );
    db.prepare(
      "INSERT INTO knowledge_input_documents(artifact_id,input_id,document_version_id,representation_sha256) VALUES(?,?,?,?)",
    ).run(
      p.artifact_id,
      input.input_id,
      input.document_version_id,
      input.representation_sha256,
    );
    return { artifact_id: p.artifact_id, published: true };
  });
}
function updateDefault(
  db: DatabaseSync,
  p: {
    scope_key: string;
    purpose: string;
    question_sha256: string;
    artifact_id: string;
    expected_revision: number | null;
  },
): { updated: boolean; revision: number | null } {
  return tx(db, " IMMEDIATE", () => {
    const artifact = one(
      db,
      "SELECT 1 AS present FROM knowledge_artifacts WHERE artifact_id=? AND scope_kind='literature' AND scope_key=? AND purpose=? AND question_sha256=?",
      p.artifact_id,
      p.scope_key,
      p.purpose,
      p.question_sha256,
    );
    if (!artifact) fail("default-artifact-mismatch");
    const row = one(
      db,
      "SELECT revision FROM knowledge_defaults WHERE scope_kind='literature' AND scope_key=? AND purpose=? AND question_sha256=?",
      p.scope_key,
      p.purpose,
      p.question_sha256,
    );
    const current = row ? Number(row.revision) : null;
    if (current !== p.expected_revision)
      return { updated: false, revision: current };
    if (current === null)
      db.prepare(
        "INSERT INTO knowledge_defaults(scope_kind,scope_key,purpose,question_sha256,artifact_id,revision) VALUES('literature',?,?,?,?,1)",
      ).run(p.scope_key, p.purpose, p.question_sha256, p.artifact_id);
    else
      db.prepare(
        "UPDATE knowledge_defaults SET artifact_id=?,revision=? WHERE scope_kind='literature' AND scope_key=? AND purpose=? AND question_sha256=?",
      ).run(
        p.artifact_id,
        current + 1,
        p.scope_key,
        p.purpose,
        p.question_sha256,
      );
    return { updated: true, revision: current === null ? 1 : current + 1 };
  });
}
export function runKnowledgeStorage(
  db: DatabaseSync,
  action:
    | "id"
    | "comparison"
    | "default"
    | "list"
    | "list-synthesis"
    | "publish"
    | "publish-synthesis"
    | "update-default",
  args: unknown,
): unknown {
  requireV6(db);
  if (action === "id") return read(db, "artifact_id", String(args));
  if (action === "comparison")
    return read(db, "comparison_sha256", String(args));
  if (action === "default") {
    const p = args as {
      scope_key: string;
      purpose: string;
      question_sha256: string;
    };
    return tx(db, "", () =>
      one(
        db,
        "SELECT artifact_id,revision FROM knowledge_defaults WHERE scope_kind='literature' AND scope_key=? AND purpose=? AND question_sha256=?",
        p.scope_key,
        p.purpose,
        p.question_sha256,
      ),
    );
  }
  if (action === "list") {
    const p = args as { literature_id: string; limit: number };
    if (!Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 100)
      fail("knowledge-input");
    return tx(db, "", () =>
      db
        .prepare(
          "SELECT artifact_id,purpose,question_text,manifest_sha256,method_id,method_version,content_sha256,created_at FROM knowledge_artifacts WHERE scope_kind='literature' AND scope_key=? ORDER BY created_at DESC,artifact_id DESC LIMIT ?",
        )
        .all(p.literature_id, p.limit),
    );
  }
  if (action === "list-synthesis") {
    const p = args as { manifest_sha256: string | null; limit: number };
    if (
      ![7, 8, 9, 10].includes(
        Number(
          one(
            db,
            "SELECT schema_version FROM schema_identity WHERE singleton=1",
          )?.schema_version,
        ),
      ) ||
      !Number.isSafeInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > 20 ||
      (p.manifest_sha256 !== null &&
        (typeof p.manifest_sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(p.manifest_sha256)))
    )
      fail("knowledge-input");
    return tx(db, "", () =>
      p.manifest_sha256 === null
        ? db
            .prepare(
              "SELECT artifact_id FROM knowledge_artifacts WHERE scope_kind='manifest' AND purpose='synthesis' ORDER BY created_at DESC,artifact_id DESC LIMIT ?",
            )
            .all(p.limit)
        : db
            .prepare(
              "SELECT artifact_id FROM knowledge_artifacts WHERE scope_kind='manifest' AND purpose='synthesis' AND manifest_sha256=? ORDER BY created_at DESC,artifact_id DESC LIMIT ?",
            )
            .all(p.manifest_sha256, p.limit),
    );
  }
  if (action === "publish") return publish(db, args as Publish);
  if (action === "publish-synthesis")
    return publishSynthesis(db, args as SynthesisPublish);
  if (action === "update-default")
    return updateDefault(db, args as Parameters<typeof updateDefault>[1]);
  return fail("knowledge-input");
}
