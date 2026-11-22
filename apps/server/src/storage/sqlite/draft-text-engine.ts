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
const { visibleLiteratureSql }: typeof import("./intake-visibility.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-visibility.ts"
        : "./intake-visibility.js",
      import.meta.url,
    ).href
  );
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  parseDraftDocumentRef,
  type ArtifactRef,
  type DraftDocumentRef,
  type TextLevel,
  type AcquirePdfSelector,
  type VersionRole,
} from "@sciretriever/contracts";
import type * as Logging from "../../logging/index.js";
import type * as Defaults from "./document-defaults.js";
import type { DocumentDefaultRequest } from "./document-defaults.js";
import type * as LibraryPage from "./library-page.js";
const { libraryPageIds }: typeof LibraryPage = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./library-page.ts" : "./library-page.js",
    import.meta.url,
  ).href
);
const { createLogger }: typeof Logging = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../logging/index.ts"
      : "../../logging/index.js",
    import.meta.url,
  ).href
);
const {
  DEFAULT_DOCUMENT_LEFT_JOIN,
  recomputeDocumentDefault,
  recomputeAssetDocumentDefaults,
}: typeof Defaults = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./document-defaults.ts"
      : "./document-defaults.js",
    import.meta.url,
  ).href
);

export interface DraftVersionFacts {
  readonly differs_segments: number;
  readonly differences: number;
  readonly image_only_pages: number;
}
export interface DraftVersionPublication {
  readonly version: DraftDocumentRef;
  readonly source_artifact_path: string;
  readonly markdown_artifact_path: string;
  readonly structure_artifact_path: string;
  readonly draft_content_artifact_path: string;
  readonly resource_artifact_paths: Readonly<Record<string, string>>;
  readonly facts: DraftVersionFacts;
  readonly expected_current_revision: number | null;
  readonly expected_default_revision: number | null;
}
export interface DraftVersionCommit {
  readonly published: boolean;
  readonly current_revision: number;
  readonly default_changed: boolean;
  readonly default_text_level: TextLevel;
  readonly index_refresh_required: boolean;
}
export interface PrimaryDocumentDefault {
  readonly literature_id: string;
  readonly asset_id: string | null;
  readonly document_version_id: string | null;
  readonly text_level: TextLevel | null;
}
/** Catalog facts only; the application owns eligibility, limits and execution. */
export interface DraftBackfillCandidate {
  readonly literature_id: string;
  readonly version_role: VersionRole;
  readonly parts: readonly {
    readonly asset_id: string;
    readonly asset_sha256: string;
    readonly part: "main" | "supplementary";
    readonly raw_parse_id: string | null;
    readonly raw_result_sha256: string | null;
    readonly has_draft: boolean;
    readonly known_version_ids: readonly string[];
    readonly current_method_sha256: string | null;
  }[];
}
export type DraftTextRead =
  | { readonly kind: "facts"; readonly document_version_id: string }
  | { readonly kind: "current"; readonly asset_id: string }
  | {
      readonly kind: "backfill-candidates";
      readonly selector: AcquirePdfSelector;
      readonly ftsQuery: string | null;
      readonly profile: string;
    }
  | {
      readonly kind: "primary-defaults";
      readonly literature_ids: readonly string[];
    };
export type DraftTextWrite =
  | { readonly kind: "commit"; readonly publication: DraftVersionPublication }
  | {
      readonly kind: "recompute-default";
      readonly request: DocumentDefaultRequest;
    };
function fail(code: string): never {
  throw Object.assign(new Error("draft text storage refused"), { code });
}
function requireSchema(db: DatabaseSync) {
  if (
    db
      .prepare("SELECT schema_version FROM schema_identity WHERE singleton=1")
      .get()?.schema_version !== 19
  )
    fail("catalog-current-required");
}
export function runDraftTextRead(db: DatabaseSync, request: DraftTextRead) {
  requireSchema(db);
  if (request.kind === "backfill-candidates") {
    const selector = request.selector;
    const ids =
      selector.kind === "query"
        ? libraryPageIds(db, {
            query: selector.query,
            sort: selector.sort,
            after: null,
            limit: Number.MAX_SAFE_INTEGER,
            ftsQuery: request.ftsQuery,
          }).rows.map((row) => String(row.literature_id))
        : [...selector.literature_ids];
    const members = db
      .prepare(
        `SELECT literature_id,version_role FROM literatures WHERE ${visibleLiteratureSql("literature_id")} AND literature_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids));
    if (members.length !== ids.length) fail("literature-not-found");
    const parts = db
      .prepare(
        `SELECT la.literature_id,a.asset_id,a.sha256 AS asset_sha256,CASE la.role WHEN 'primary-pdf' THEN 'main' ELSE 'supplementary' END AS part,
       r.raw_parse_id,r.result_sha256 AS raw_result_sha256,
       EXISTS(SELECT 1 FROM document_versions v WHERE v.schema_version=3 AND v.raw_parse_id=r.raw_parse_id AND v.raw_parse_result_sha256=r.result_sha256 AND v.literature_id=la.literature_id) AS has_draft,
       (SELECT json_group_array(v.document_version_id) FROM document_versions v WHERE v.schema_version=3 AND v.raw_parse_id=r.raw_parse_id AND v.raw_parse_result_sha256=r.result_sha256 AND v.literature_id=la.literature_id) AS known_versions_json,
       d.draft_method_sha256 AS current_method_sha256
       FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
       LEFT JOIN raw_parse_current rc ON rc.source_asset_id=a.asset_id AND rc.source_sha256=a.sha256 AND rc.profile=?
       LEFT JOIN raw_parse_current legacy ON legacy.source_asset_id=a.asset_id AND legacy.source_sha256=a.sha256 AND legacy.profile='vlm-engine-markdown-only'
       LEFT JOIN raw_parses r ON r.raw_parse_id=coalesce(rc.raw_parse_id,legacy.raw_parse_id)
       LEFT JOIN draft_current dc ON dc.part_asset_id=a.asset_id AND dc.part_sha256=a.sha256
       LEFT JOIN document_versions d ON d.document_version_id=dc.document_version_id AND d.literature_id=la.literature_id
       WHERE la.literature_id IN (SELECT value FROM json_each(?)) AND la.role IN ('primary-pdf','supplementary-pdf') AND a.media_type='application/pdf'
       ORDER BY la.literature_id,CASE la.role WHEN 'primary-pdf' THEN 0 ELSE 1 END,a.asset_id`,
      )
      .all(request.profile, JSON.stringify(ids));
    const byId = new Map(
      members.map((row) => [String(row.literature_id), row]),
    );
    const byLiterature = new Map<
      string,
      DraftBackfillCandidate["parts"][number][]
    >();
    for (const row of parts) {
      const id = String(row.literature_id);
      const list = byLiterature.get(id) ?? [];
      list.push({
        asset_id: String(row.asset_id),
        asset_sha256: String(row.asset_sha256),
        part: row.part as "main" | "supplementary",
        raw_parse_id: row.raw_parse_id as string | null,
        raw_result_sha256: row.raw_result_sha256 as string | null,
        has_draft: row.has_draft === 1,
        known_version_ids: JSON.parse(
          String(row.known_versions_json),
        ) as string[],
        current_method_sha256: row.current_method_sha256 as string | null,
      });
      byLiterature.set(id, list);
    }
    return ids.map((id) => ({
      literature_id: id,
      version_role: byId.get(id)!.version_role as VersionRole,
      parts: byLiterature.get(id) ?? [],
    }));
  }
  if (request.kind === "facts") {
    const row = db
      .prepare(
        "SELECT differs_segments,differences,image_only_pages FROM draft_version_facts WHERE document_version_id=?",
      )
      .get(request.document_version_id);
    return row ?? null;
  }
  if (request.kind === "current")
    return (
      db
        .prepare(
          "SELECT part_asset_id,part_sha256,document_version_id,revision FROM draft_current WHERE part_asset_id=?",
        )
        .get(request.asset_id) ?? null
    );
  // A page of IDs, including entries with no primary PDF or no default, is read
  // in one snapshot without loading Markdown, structures or any artifact.
  return db
    .prepare(
      `SELECT l.literature_id,a.asset_id,d.document_version_id AS document_version_id,CASE d.schema_version WHEN 3 THEN 'draft' WHEN 2 THEN 'proofread' ELSE NULL END AS text_level
      FROM json_each(?) requested JOIN literatures l ON l.literature_id=requested.value
      LEFT JOIN literature_assets la ON la.literature_id=l.literature_id AND la.role='primary-pdf'
      LEFT JOIN assets a ON a.asset_id=la.asset_id AND a.media_type='application/pdf'
      ${DEFAULT_DOCUMENT_LEFT_JOIN}
      ORDER BY l.literature_id`,
    )
    .all(JSON.stringify([...new Set(request.literature_ids)]));
}
function exactArtifact(db: DatabaseSync, path: string, artifact: ArtifactRef) {
  return !!db
    .prepare(
      "SELECT 1 FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?",
    )
    .get(path, artifact.sha256, artifact.byte_size, artifact.media_type);
}
function register(db: DatabaseSync, path: string, artifact: ArtifactRef) {
  if (exactArtifact(db, path, artifact)) return;
  if (
    db
      .prepare(
        "SELECT 1 FROM artifact_objects WHERE relative_path=? OR sha256=?",
      )
      .get(path, artifact.sha256)
  )
    fail("document-version-conflict");
  db.prepare(
    "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
  ).run(
    randomUUID(),
    artifact.sha256,
    artifact.byte_size,
    artifact.media_type,
    path,
  );
}
function commit(
  db: DatabaseSync,
  publication: DraftVersionPublication,
): DraftVersionCommit {
  const v = parseDraftDocumentRef(publication.version);
  const p = publication;
  const material = v.source_material_ref;
  const source = db
    .prepare(
      "SELECT 1 FROM assets a JOIN literature_assets la ON la.asset_id=a.asset_id WHERE la.literature_id=? AND a.asset_id=? AND a.sha256=? AND a.size_bytes=? AND a.media_type=? AND a.relative_path=? AND la.role IN ('primary-pdf','supplementary-pdf')",
    )
    .get(
      material.literature_id,
      material.asset_id,
      material.asset_sha256,
      material.byte_size,
      material.media_type,
      p.source_artifact_path,
    );
  if (!source || !exactArtifact(db, p.source_artifact_path, material.artifact))
    fail("document-source-stale");
  if (
    !db
      .prepare(
        "SELECT 1 FROM raw_parses r JOIN raw_parse_current c ON c.source_asset_id=r.source_asset_id AND c.source_sha256=r.source_sha256 AND c.profile=r.profile AND c.raw_parse_id=r.raw_parse_id WHERE r.raw_parse_id=? AND r.result_sha256=? AND r.source_asset_id=? AND r.source_sha256=?",
      )
      .get(
        v.raw_parse_id,
        v.raw_parse_result_sha256,
        material.asset_id,
        material.asset_sha256,
      )
  )
    fail("document-raw-stale");
  const current = db
    .prepare(
      "SELECT part_asset_id,part_sha256,document_version_id,revision FROM draft_current WHERE part_asset_id=?",
    )
    .get(material.asset_id);
  if ((current?.revision ?? null) !== p.expected_current_revision)
    fail("draft-current-conflict");
  if (
    Object.values(p.facts).length !== 3 ||
    Object.values(p.facts).some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    fail("document-version-invalid");
  if (Object.keys(p.resource_artifact_paths).length !== v.resources.length)
    fail("document-resources-mismatch");
  for (const resource of v.resources) {
    const path = p.resource_artifact_paths[resource.reference];
    if (
      !path ||
      !db
        .prepare(
          "SELECT 1 FROM raw_parse_resources WHERE raw_parse_id=? AND kind='image' AND reference=? AND artifact_reference=? AND sha256=? AND byte_size=? AND media_type=?",
        )
        .get(
          v.raw_parse_id,
          resource.reference,
          path,
          resource.artifact.sha256,
          resource.artifact.byte_size,
          resource.artifact.media_type,
        ) ||
      !exactArtifact(db, path, resource.artifact)
    )
      fail("document-resources-mismatch");
  }
  register(db, p.draft_content_artifact_path, v.draft_content);
  register(db, p.markdown_artifact_path, v.markdown);
  register(db, p.structure_artifact_path, v.structure);
  const row: Record<string, SQLInputValue> = {
    document_version_id: v.document_version_id,
    document_id: v.document_id,
    schema_version: 3,
    literature_id: material.literature_id,
    source_asset_id: material.asset_id,
    source_sha256: material.asset_sha256,
    source_byte_size: material.byte_size,
    source_media_type: material.media_type,
    source_artifact_path: p.source_artifact_path,
    builder_version: v.builder_version,
    locator_scheme: v.locator_scheme,
    representation_sha256: v.representation_sha256,
    markdown_artifact_path: p.markdown_artifact_path,
    markdown_sha256: v.markdown.sha256,
    markdown_byte_size: v.markdown.byte_size,
    markdown_media_type: v.markdown.media_type,
    structure_artifact_path: p.structure_artifact_path,
    structure_sha256: v.structure.sha256,
    structure_byte_size: v.structure.byte_size,
    structure_media_type: v.structure.media_type,
    proofread_id: null,
    proofread_content_sha256: null,
    raw_parse_id: v.raw_parse_id,
    raw_parse_result_sha256: v.raw_parse_result_sha256,
    page_layer_sha256: v.page_layer_sha256,
    draft_method_sha256: v.draft_method_sha256,
    draft_content_artifact_path: p.draft_content_artifact_path,
    draft_content_sha256: v.draft_content.sha256,
    draft_content_byte_size: v.draft_content.byte_size,
    draft_content_media_type: v.draft_content.media_type,
  };
  const prior = db
    .prepare(
      "SELECT document_version_id,document_id,schema_version,literature_id,source_asset_id,source_sha256,source_byte_size,source_media_type,source_artifact_path,builder_version,locator_scheme,representation_sha256,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,structure_artifact_path,structure_sha256,structure_byte_size,structure_media_type,proofread_id,proofread_content_sha256,created_at,raw_parse_id,raw_parse_result_sha256,page_layer_sha256,draft_method_sha256,draft_content_artifact_path,draft_content_sha256,draft_content_byte_size,draft_content_media_type FROM document_versions WHERE document_version_id=?",
    )
    .get(v.document_version_id);
  if (prior && Object.entries(row).some(([key, value]) => prior[key] !== value))
    fail("document-version-conflict");
  if (!prior) {
    const columns = [...Object.keys(row), "created_at"];
    db.prepare(
      "INSERT INTO document_versions(" +
        columns.join(",") +
        ") VALUES(" +
        columns.map(() => "?").join(",") +
        ")",
    ).run(...Object.values(row), new Date().toISOString());
    v.resources.forEach((resource, ordinal) => {
      db.prepare(
        "INSERT INTO document_version_resources(document_version_id,ordinal,resource_id,reference,relation,artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        v.document_version_id,
        ordinal,
        resource.resource_id,
        resource.reference,
        resource.relation,
        p.resource_artifact_paths[resource.reference]!,
        resource.artifact.sha256,
        resource.artifact.byte_size,
        resource.artifact.media_type,
      );
    });
    db.prepare(
      "INSERT INTO draft_version_facts(document_version_id,differs_segments,differences,image_only_pages) VALUES(?,?,?,?)",
    ).run(
      v.document_version_id,
      p.facts.differs_segments,
      p.facts.differences,
      p.facts.image_only_pages,
    );
  } else {
    const resources = db
      .prepare(
        "SELECT document_version_id,ordinal,resource_id,reference,relation,artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type FROM document_version_resources WHERE document_version_id=? ORDER BY ordinal",
      )
      .all(v.document_version_id);
    if (
      resources.length !== v.resources.length ||
      resources.some((r, ordinal) => {
        const resource = v.resources[ordinal]!;
        return (
          r.ordinal !== ordinal ||
          r.resource_id !== resource.resource_id ||
          r.reference !== resource.reference ||
          r.relation !== resource.relation ||
          r.artifact_path !== p.resource_artifact_paths[resource.reference] ||
          r.artifact_sha256 !== resource.artifact.sha256 ||
          r.artifact_byte_size !== resource.artifact.byte_size ||
          r.artifact_media_type !== resource.artifact.media_type
        );
      })
    )
      fail("document-version-conflict");
    const facts = db
      .prepare(
        "SELECT document_version_id,differs_segments,differences,image_only_pages FROM draft_version_facts WHERE document_version_id=?",
      )
      .get(v.document_version_id);
    if (
      !facts ||
      facts.differs_segments !== p.facts.differs_segments ||
      facts.differences !== p.facts.differences ||
      facts.image_only_pages !== p.facts.image_only_pages
    )
      fail("document-version-conflict");
  }
  const revision =
    current?.document_version_id === v.document_version_id
      ? Number(current.revision)
      : Number(current?.revision ?? 0) + 1;
  if (current?.document_version_id !== v.document_version_id)
    db.prepare(
      "INSERT INTO draft_current(part_asset_id,part_sha256,document_version_id,revision) VALUES(?,?,?,?) ON CONFLICT(part_asset_id) DO UPDATE SET part_sha256=excluded.part_sha256,document_version_id=excluded.document_version_id,revision=excluded.revision",
    ).run(
      material.asset_id,
      material.asset_sha256,
      v.document_version_id,
      revision,
    );
  const defaults = recomputeAssetDocumentDefaults(
    db,
    material.asset_id,
    material.asset_sha256,
    {
      literature_id: material.literature_id,
      asset_id: material.asset_id,
      asset_sha256: material.asset_sha256,
      expected_default_revision: p.expected_default_revision,
    },
  );
  const own = defaults.find((d) => d.literature_id === material.literature_id);
  if (!own?.text_level) fail("document-version-invalid");
  return {
    published: !prior,
    current_revision: revision,
    default_changed: own.default_changed,
    default_text_level: own.text_level,
    index_refresh_required: defaults.some((d) => d.default_changed),
  };
}
export function runDraftTextWrite(db: DatabaseSync, request: DraftTextWrite) {
  requireSchema(db);
  beginCatalogWrite(db);
  try {
    const result =
      request.kind === "commit"
        ? commit(db, request.publication)
        : recomputeDocumentDefault(db, request.request);
    commitCatalogWrite(db);
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        createLogger("draft-text-storage").warn(
          "Rollback failed; preserving original error",
        );
      }
    }
    throw error;
  }
}
