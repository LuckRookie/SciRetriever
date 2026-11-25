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
const { literatureWithdrawn }: typeof import("./intake-visibility.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-visibility.ts"
        : "./intake-visibility.js",
      import.meta.url,
    ).href
  );
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ARCHIVE_STEPS,
  parseLongDocumentInfo,
  type LongDocumentInfo,
  canonicalJsonBytes,
  archivePageCursor,
  parseDocumentReceipt,
  type ArchiveState,
  type ArchiveStepReceipt,
  type ArchiveIssue,
  type ArchiveIssueCount,
  type ArchiveVersionEvent,
} from "@sciretriever/contracts";
import type * as State from "../../literature/state.js";
import type * as DraftFacts from "./draft-facts.js";
const { DEFAULT_DOCUMENT_LEFT_JOIN }: typeof import("./document-defaults.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./document-defaults.ts"
        : "./document-defaults.js",
      import.meta.url,
    ).href
  );
const { readDefaultTextFacts }: typeof DraftFacts = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./draft-facts.ts" : "./draft-facts.js",
    import.meta.url,
  ).href
);
const {
  publishDocumentTranslation,
  readDocumentTranslation,
  readLatestDocumentTranslation,
}: typeof import("./document-translation-engine.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./document-translation-engine.ts"
      : "./document-translation-engine.js",
    import.meta.url,
  ).href
);
const { deriveCurrentState }: typeof State = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../literature/state.ts"
      : "../../literature/state.js",
    import.meta.url,
  ).href
);
export type ArchiveStorageAction =
  | "state"
  | "issue-count"
  | "issues"
  | "events"
  | "stats"
  | "revision"
  | "begin"
  | "step"
  | "finish"
  | "resolve"
  | "hook"
  | "parse"
  | "translation"
  | "translation-latest"
  | "translation-publish";
export const ARCHIVE_READ_ACTIONS: readonly ArchiveStorageAction[] = [
  "state",
  "issue-count",
  "issues",
  "events",
  "stats",
  "revision",
  "translation",
  "translation-latest",
];
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(v)).digest("hex");
const json = (v: unknown) =>
  Buffer.from(canonicalJsonBytes(v)).toString("utf8");
const version = (v: unknown): string | null =>
  typeof v === "string" ? hash(JSON.parse(v)) : null;
const rows = (db: DatabaseSync, sql: string, ...args: SQLInputValue[]) =>
  db.prepare(sql).all(...args);
const currentStep = (step: unknown) =>
  (ARCHIVE_STEPS as readonly unknown[]).includes(step);
function fail(code: string): never {
  throw Object.assign(new Error("archive storage refused"), { code });
}

function archiveIssueSource(includeResolved: boolean, scoped = false) {
  // archiveStates starts at metadata and counts an issue once if its asset
  // is still a PDF part. The default path only visits unresolved issue keys.
  return `FROM archive_issues i${includeResolved ? "" : " INDEXED BY archive_issues_unresolved"}
    WHERE ${includeResolved ? "" : "i.resolution IS NULL AND "}${scoped ? "i.literature_id=? AND " : ""}
    EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=i.literature_id)
    AND EXISTS(SELECT 1 FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
      WHERE la.literature_id=i.literature_id AND la.asset_id=i.asset_id
        AND la.role IN ('primary-pdf','supplementary-pdf') AND a.media_type='application/pdf')`;
}

function projectArchiveIssue(
  row: Record<string, unknown>,
  part: ArchiveIssue["part"],
  arranged: boolean,
): ArchiveIssue {
  const step = row.step as ArchiveIssue["step"],
    reason = String(row.reason);
  return {
    issue_id: String(row.issue_id),
    literature_id: String(row.literature_id),
    asset_id: String(row.asset_id),
    part,
    step,
    reason,
    detail: JSON.parse(String(row.detail_json)),
    affects_readiness:
      part === "main" &&
      step !== "references" &&
      step !== "translate" &&
      reason !== "page-content-missing" &&
      !(arranged && (step === "document" || step === "structure")),
    resolution: row.resolution as ArchiveIssue["resolution"],
  };
}

function readArchiveIssues(db: DatabaseSync, request: Record<string, unknown>) {
  const scope =
    typeof request.literature_id === "string" ? [request.literature_id] : [];
  const offset = Number(request.offset ?? 0),
    limit = Math.min(200, Number(request.limit ?? 50));
  // Keep the archiveStates traversal order, including first occurrence for
  // each reason. A PDF linked in both roles was classified as main.
  const issues =
    db.prepare(`SELECT i.issue_id,i.literature_id,i.asset_id,i.step,i.reason,i.detail_json,i.resolution,
      CASE WHEN EXISTS(SELECT 1 FROM literature_assets la WHERE la.literature_id=i.literature_id
        AND la.asset_id=i.asset_id AND la.role='primary-pdf') THEN 'main' ELSE 'supplementary' END AS part,
      EXISTS(SELECT 1 FROM archive_steps s WHERE s.literature_id=i.literature_id
        AND s.asset_id=i.asset_id AND s.step='arrange') AS arranged
    ${archiveIssueSource(Boolean(request.include_resolved), scope.length > 0)}
    ORDER BY i.literature_id,i.asset_id,i.step,i.rowid`);
  const groups = new Map<string, number>();
  const items: ArchiveIssue[] = [];
  let total_count = 0;
  for (const row of issues.iterate(...scope)) {
    const reason = String(row.reason),
      part = row.part as ArchiveIssue["part"];
    groups.set(reason, (groups.get(reason) ?? 0) + 1);
    if (
      (request.reason && reason !== request.reason) ||
      (request.part && part !== request.part)
    )
      continue;
    if (total_count >= offset && items.length < limit)
      items.push(projectArchiveIssue(row, part, row.arranged === 1));
    total_count++;
  }
  return {
    items,
    groups: [...groups].map(([reason, count]) => ({ reason, count })),
    total_count,
    next_offset: offset + limit < total_count ? offset + limit : null,
  };
}

/** Read the same parts as archive_current_parts starting with the requested
 *  literature's assets. Keep proofread and draft eligibility in the default
 *  version's ON clause so an ineligible version still leaves the PDF row.
 */
export function readArchiveCurrentParts(
  db: DatabaseSync,
  id?: string | readonly string[],
) {
  const args = id ? [typeof id === "string" ? id : JSON.stringify(id)] : [];
  const scope = !id
    ? ""
    : typeof id === "string"
      ? "AND la.literature_id=?"
      : "AND la.literature_id IN (SELECT value FROM json_each(?))";
  return rows(
    db,
    `SELECT la.literature_id,a.asset_id,a.sha256 AS asset_sha256,
      CASE WHEN la.role='primary-pdf' THEN 'main' ELSE 'supplementary' END AS part,
      pc.proofread_id,pv.status AS proofread_status,d.document_version_id,
      ac.annotation_id,COALESCE(an.structure_satisfied,0) AS structure_satisfied,
      CASE WHEN d.schema_version=3 THEN json_object('text_level','draft','document_version_id',d.document_version_id)
        WHEN ac.annotation_id IS NOT NULL THEN json_object('document_version_id',d.document_version_id,'structure_annotation_id',ac.annotation_id)
        ELSE NULL END AS version_json,
      d.schema_version AS document_schema_version,
      (SELECT json_group_array(profile) FROM raw_parse_current r
        WHERE r.source_asset_id=a.asset_id AND r.source_sha256=a.sha256 AND r.raw_parse_id IS NOT NULL) AS profiles_json
    FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
    LEFT JOIN proofread_current pc ON pc.part_asset_id=a.asset_id AND pc.part_sha256=a.sha256
      AND pc.manual_revision=COALESCE((SELECT revision FROM proofread_manual_state WHERE part_asset_id=a.asset_id),0)
      AND NOT EXISTS(
        SELECT 1 FROM raw_parse_pins rp JOIN raw_parses r ON r.raw_parse_id=rp.raw_parse_id
        LEFT JOIN raw_parse_current rc ON rc.source_asset_id=r.source_asset_id AND rc.profile=r.profile
        WHERE rp.proofread_id=pc.proofread_id AND (rc.raw_parse_id IS NULL OR rc.raw_parse_id!=rp.raw_parse_id))
    LEFT JOIN proofread_versions pv ON pv.proofread_id=pc.proofread_id
    ${DEFAULT_DOCUMENT_LEFT_JOIN}
      AND ((d.schema_version=2 AND d.proofread_content_sha256=pv.content_sha256 AND pv.status='complete')
        OR (d.schema_version=3 AND EXISTS(
          SELECT 1 FROM draft_current dc
          JOIN raw_parses r ON r.raw_parse_id=d.raw_parse_id AND r.result_sha256=d.raw_parse_result_sha256
          JOIN raw_parse_current rc ON rc.source_asset_id=r.source_asset_id AND rc.source_sha256=r.source_sha256
            AND rc.profile=r.profile AND rc.raw_parse_id=r.raw_parse_id
          WHERE dc.document_version_id=d.document_version_id AND dc.part_asset_id=a.asset_id AND dc.part_sha256=a.sha256)))
    LEFT JOIN structure_annotation_current ac ON ac.document_version_id=d.document_version_id AND d.schema_version=2
    LEFT JOIN structure_annotations an ON an.annotation_id=ac.annotation_id
    WHERE la.role IN ('primary-pdf','supplementary-pdf') AND a.media_type='application/pdf' ${scope}
    ORDER BY part<>'main',a.asset_id`,
    ...args,
  );
}
export function archiveStates(
  db: DatabaseSync,
  id?: string | readonly string[],
  checkpoint: () => void = () => {},
  includeDraftFacts = false,
): Map<string, ArchiveState> {
  checkpoint();
  const args = id ? [typeof id === "string" ? id : JSON.stringify(id)] : [],
    where = !id
      ? ""
      : typeof id === "string"
        ? " WHERE m.literature_id=?"
        : " WHERE m.literature_id IN (SELECT value FROM json_each(?))";
  const all = rows(
    db,
    `SELECT m.literature_id,m.metadata_revision,m.metadata_sha256,m.title,m.abstract,m.publication_date,m.publication_year,m.publication_form,m.article_kind,m.language,m.venue,m.publisher,m.volume,m.issue,m.pages, EXISTS(SELECT 1 FROM literature_metadata_authors a WHERE a.literature_id=m.literature_id) AS has_authors, r.mode, r.asset_id AS run_asset, r.state AS run_state, r.job_id, j.status AS job_status, (SELECT count(*) FROM literature_tag_items i WHERE i.literature_id=m.literature_id) AS tag_count, dh.source_json AS description_json FROM literature_metadata m LEFT JOIN archive_runs r ON r.literature_id=m.literature_id LEFT JOIN execution_jobs j ON j.job_id=r.job_id LEFT JOIN archive_description_heads dh ON dh.literature_id=m.literature_id ${where}`,
    ...args,
  );
  checkpoint();
  const filter = !id
    ? ""
    : typeof id === "string"
      ? " WHERE literature_id=?"
      : " WHERE literature_id IN (SELECT value FROM json_each(?))";
  const parts = readArchiveCurrentParts(db, id);
  const defaults = includeDraftFacts
    ? new Map(
        readDefaultTextFacts(
          db,
          all.map((row) => String(row.literature_id)),
        ).map((row) => [
          `${row.literature_id}:${row.asset_id}`,
          row.default_text,
        ]),
      )
    : null;
  checkpoint();
  const steps = rows(
    db,
    `SELECT literature_id,asset_id,step,status,input_sha256,output_json,reason,elapsed_ms,calls,input_tokens,output_tokens,updated_at FROM archive_steps${filter}`,
    ...args,
  );
  checkpoint();
  const issues = rows(
    db,
    `SELECT issue_id,literature_id,asset_id,step,reason,detail_json,resolution,updated_at FROM archive_issues${filter}`,
    ...args,
  );
  const byLit = <T extends { literature_id: unknown }>(list: T[]) => {
    const map = new Map<string, T[]>();
    for (const item of list) {
      const key = String(item.literature_id);
      const group = map.get(key) ?? [];
      group.push(item);
      map.set(key, group);
    }
    return map;
  };
  const groupedParts = byLit(
      parts as ({ literature_id: string } & Record<string, unknown>)[],
    ),
    groupedSteps = byLit(
      steps as ({ literature_id: string } & Record<string, unknown>)[],
    ),
    groupedIssues = byLit(
      issues as ({ literature_id: string } & Record<string, unknown>)[],
    );
  const result = new Map<string, ArchiveState>();
  const textLevel = (schema: unknown) =>
    schema === 3
      ? ("draft" as const)
      : schema === 2
        ? ("proofread" as const)
        : null;
  for (const m of all) {
    checkpoint();
    const key = String(m.literature_id),
      material = groupedParts.get(key) ?? [],
      stepRows = groupedSteps.get(key) ?? [];
    const main = material.find((p) => p.part === "main"),
      started = !!main && main.asset_id === m.run_asset;
    const longDocument = (asset: unknown) => {
      const step = stepRows.find(
        (s) => s.asset_id === asset && s.step === "arrange",
      );
      const marker = step
        ? JSON.parse(String(step.output_json)).long_document
        : null;
      return marker ? parseLongDocumentInfo(marker) : null;
    };
    result.set(key, {
      ...(defaults
        ? {
            draft_facts: main
              ? (defaults.get(`${key}:${String(main.asset_id)}`)?.draft_facts ??
                null)
              : null,
          }
        : {}),
      text_level: textLevel(main?.document_schema_version),
      long_document: longDocument(main?.asset_id),
      literature_id: key,
      mode: m.mode === "legacy-vlm-markdown" ? m.mode : "full",
      started,
      running:
        started &&
        m.run_state === "running" &&
        (!m.job_id || m.job_status === "running"),
      article_kind: m.article_kind as string | null,
      metadata_missing: [
        "title",
        "publication_year",
        "publication_form",
        "article_kind",
      ]
        .filter((f) => m[f] === null)
        .concat(m.has_authors ? [] : ["authors"])
        .map((f) => `metadata-missing:${f}`),
      tag_count: Number(m.tag_count),
      description_version: version(m.description_json),
      parts: material.map((p) => ({
        ...(defaults
          ? {
              draft_facts:
                defaults.get(`${key}:${String(p.asset_id)}`)?.draft_facts ??
                null,
            }
          : {}),
        text_level: textLevel(p.document_schema_version),
        long_document: longDocument(p.asset_id),
        format: stepRows.some(
          (s) => s.asset_id === p.asset_id && s.step === "arrange",
        )
          ? "arranged-v2"
          : p.proofread_id
            ? "legacy-v1"
            : "not-built",
        // Historical rows and step names this release does not know are read
        // as old steps, never refused.
        legacy_steps: stepRows
          .filter(
            (s) =>
              s.asset_id === p.asset_id &&
              (JSON.parse(String(s.output_json)).schema_version !== 2 ||
                !currentStep(s.step)),
          )
          .map(
            (s) =>
              ({
                literature_id: key,
                asset_id: String(p.asset_id),
                step: s.step,
                status: s.status,
                input_sha256: s.input_sha256,
                output: JSON.parse(String(s.output_json)),
                reason: s.reason,
                elapsed_ms: s.elapsed_ms,
                calls: s.calls,
                input_tokens: s.input_tokens,
                output_tokens: s.output_tokens,
              }) as ArchiveStepReceipt,
          ),
        asset_id: String(p.asset_id),
        asset_sha256: String(p.asset_sha256),
        part: p.part as "main" | "supplementary",
        raw_profiles: JSON.parse(String(p.profiles_json)),
        proofread_id: p.proofread_id as string | null,
        proofread_complete: p.proofread_status === "complete",
        document_version_id: p.document_version_id as string | null,
        structure_annotation_id: p.annotation_id as string | null,
        structure_satisfied: p.structure_satisfied === 1,
        content_version: version(p.version_json),
        steps: stepRows
          .filter(
            (s) =>
              s.asset_id === p.asset_id &&
              JSON.parse(String(s.output_json)).schema_version === 2 &&
              currentStep(s.step),
          )
          .map(
            (s) =>
              ({
                ...projectArchiveReceipt(JSON.parse(String(s.output_json))),
                literature_id: key,
                asset_id: String(p.asset_id),
                step: s.step,
                status: s.status,
                input_sha256: s.input_sha256,
                output: JSON.parse(String(s.output_json)),
                reason: s.reason,
                elapsed_ms: s.elapsed_ms,
                calls: s.calls,
                input_tokens: s.input_tokens,
                output_tokens: s.output_tokens,
              }) as ArchiveStepReceipt,
          ),
      })),
      issues: (groupedIssues.get(key) ?? []).flatMap((i) => {
        const part = material.find((p) => p.asset_id === i.asset_id);
        return part
          ? [
              projectArchiveIssue(
                i,
                part.part as ArchiveIssue["part"],
                stepRows.some(
                  (s) => s.asset_id === i.asset_id && s.step === "arrange",
                ),
              ),
            ]
          : [];
      }),
    });
  }
  return result;
}
/** One bounded page projection; marker is produced by arrangement, never inferred from titles. */
export function archiveLongDocuments(
  db: DatabaseSync,
  ids: readonly string[],
): Map<string, LongDocumentInfo> {
  const markers = new Map<string, LongDocumentInfo>();
  if (!ids.length) return markers;
  // The view's main part is the primary PDF link. Its left joins cannot
  // change which arrangement step supplies the marker for that PDF.
  for (const row of rows(
    db,
    `SELECT la.literature_id,s.output_json
    FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
    JOIN archive_steps s ON s.literature_id=la.literature_id AND s.asset_id=a.asset_id AND s.step='arrange'
    WHERE la.role='primary-pdf' AND a.media_type='application/pdf'
      AND la.literature_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  )) {
    const marker = JSON.parse(String(row.output_json)).long_document;
    if (marker)
      markers.set(String(row.literature_id), parseLongDocumentInfo(marker));
  }
  return markers;
}
export function archiveState(
  db: DatabaseSync,
  id: string,
  maxTags = 6,
  archiveProfile: "pipeline" | "vlm-engine" = "vlm-engine",
  includeDraftFacts = true,
) {
  const state = archiveStates(db, id, undefined, includeDraftFacts).get(id);
  if (!state) fail("archive-literature-missing");
  return { ...state, ...deriveCurrentState(state, maxTags, archiveProfile) };
}
function transaction<T>(db: DatabaseSync, write: boolean, fn: () => T): T {
  if (write) beginCatalogWrite(db);
  else db.exec("BEGIN");
  try {
    const result = fn();
    if (write) commitCatalogWrite(db);
    else db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function runArchiveStorage(
  db: DatabaseSync,
  action: ArchiveStorageAction,
  args: unknown,
  maxTags = 6,
  archiveProfile: "pipeline" | "vlm-engine" = "vlm-engine",
): unknown {
  const r = args as Record<string, unknown>;
  return transaction(db, !ARCHIVE_READ_ACTIONS.includes(action), () => {
    if (
      typeof r.literature_id === "string" &&
      literatureWithdrawn(db, r.literature_id)
    )
      fail("archive-literature-missing");
    if (action === "state")
      return archiveState(db, String(r.literature_id), maxTags, archiveProfile);
    if (action === "translation") return readDocumentTranslation(db, r);
    if (action === "translation-latest")
      return readLatestDocumentTranslation(db, r);
    if (action === "translation-publish")
      return publishDocumentTranslation(db, r);
    if (action === "events")
      return rows(
        db,
        "SELECT sequence,kind,literature_id,asset_id,old_part,new_part,old_json,new_json,created_at FROM archive_version_events WHERE sequence>? ORDER BY sequence LIMIT ?",
        Number(r.after ?? 0),
        Math.min(1000, Number(r.limit ?? 100)),
      ).map(
        (e) =>
          ({
            sequence: Number(e.sequence),
            kind: e.kind,
            literature_id: e.literature_id,
            asset_id: e.asset_id,
            old_part: e.old_part,
            new_part: e.new_part,
            old_version: version(e.old_json),
            new_version: version(e.new_json),
            created_at: e.created_at,
          }) as ArchiveVersionEvent,
      );
    // Reading history is not material: counting it here made every opened paper
    // invalidate every open page within one poll. Attached files and raw parses
    // are: a PDF that arrives, or a parse that finishes, must refresh the open
    // paper and its library row.
    if (action === "revision")
      return {
        revision: JSON.stringify(
          db
            .prepare(
              "SELECT (SELECT COALESCE(MAX(sequence),0) FROM archive_version_events) AS facts,(SELECT count(*) FROM processor_results) AS results,(SELECT count(*) FROM snapshots) AS snapshots,(SELECT rowid||status FROM operation_records WHERE operation IN ('folders','snapshot-rename') ORDER BY rowid DESC LIMIT 1) AS organization,(SELECT version FROM vocabulary_state WHERE singleton=1) AS vocabulary,(SELECT MAX(started_at||COALESCE(finished_at,'')||state) FROM archive_runs) AS runs,(SELECT count(*)||':'||COALESCE(MAX(rowid),0) FROM literature_assets) AS files,(SELECT count(*)||':'||COALESCE(MAX(rowid),0) FROM raw_parses) AS parses,(SELECT revision FROM retrieval_source_revision WHERE singleton=1) AS visibility",
            )
            .get(),
        ),
      };
    if (action === "issue-count") {
      const count = db
        .prepare(`SELECT count(*) AS total_count ${archiveIssueSource(false)}`)
        .get()!;
      return {
        total_count: Number(count.total_count),
      } satisfies ArchiveIssueCount;
    }
    if (action === "issues") return readArchiveIssues(db, r);
    if (action === "stats")
      return {
        parsing: rows(
          db,
          "SELECT profile,status,count(*) AS executions,sum(page_count) AS pages,sum(elapsed_ms) AS elapsed_ms FROM raw_parse_attempts GROUP BY profile,status",
        ),
        arrangement: rows(
          db,
          "SELECT sum(COALESCE(json_extract(stats_json,'$.dropped_count'),0)) AS dropped_count FROM archive_attempts WHERE step='arrange'",
        ),
        corrections: rows(
          db,
          "SELECT sum(COALESCE(json_extract(stats_json,'$.correction_count'),0)) AS correction_count FROM archive_attempts WHERE step='proofread'",
        ),
        proofreading: rows(
          db,
          "SELECT sum(COALESCE(json_extract(stats_json,'$.text_layer_pages'),0)) AS text_layer_pages,sum(COALESCE(json_extract(stats_json,'$.image_only_pages'),0)) AS image_only_pages,sum(COALESCE(json_extract(stats_json,'$.blank_pages'),0)) AS blank_pages,sum(COALESCE(json_extract(stats_json,'$.missing'),0)) AS missing,sum(COALESCE(json_extract(stats_json,'$.extra'),0)) AS extra,sum(COALESCE(json_extract(stats_json,'$.token_mismatch'),0)) AS token_mismatch,sum(COALESCE(json_extract(stats_json,'$.page_misplaced'),0)) AS page_misplaced,sum(COALESCE(json_extract(stats_json,'$.fixed'),0)) AS fixed,sum(COALESCE(json_extract(stats_json,'$.draft_correct'),0)) AS draft_correct,sum(COALESCE(json_extract(stats_json,'$.agent_deletions'),0)) AS agent_deletions FROM archive_attempts WHERE step='proofread'",
        ),
        steps: rows(
          db,
          "SELECT step,count(*) AS executions,sum(elapsed_ms) AS elapsed_ms,sum(calls) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens FROM archive_attempts GROUP BY step",
        ),
        hooks: rows(
          db,
          "SELECT state,count(*) AS count FROM archive_batch_hooks GROUP BY state",
        ),
      };
    if (action === "begin") {
      const current = archiveState(
        db,
        String(r.literature_id),
        maxTags,
        archiveProfile,
        false,
      );
      const main = current.parts.find((p) => p.part === "main");
      if (!main || main.asset_id !== r.asset_id) fail("archive-primary-stale");
      if (current.running) fail("archive-busy");
      db.prepare(
        "INSERT INTO archive_runs(literature_id,asset_id,mode,run_id,job_id,state,started_at,finished_at) VALUES(?,?,?,?,?,'running',?,NULL) ON CONFLICT(literature_id) DO UPDATE SET asset_id=excluded.asset_id,mode=excluded.mode,run_id=excluded.run_id,job_id=excluded.job_id,state='running',started_at=excluded.started_at,finished_at=NULL",
      ).run(
        String(r.literature_id),
        String(r.asset_id),
        String(r.mode),
        String(r.run_id),
        r.job_id as string | null,
        new Date().toISOString(),
      );
      return current;
    }
    if (action === "finish") {
      db.prepare(
        "UPDATE archive_runs SET state=?,finished_at=? WHERE literature_id=? AND run_id=?",
      ).run(
        r.interrupted ? "interrupted" : "finished",
        new Date().toISOString(),
        String(r.literature_id),
        String(r.run_id),
      );
      return null;
    }
    // Parsing runs as the first archive step (Owner 2026-10-30). It keeps its own
    // raw-parse attempts; here it only reports task progress, without a step row.
    if (action === "parse") {
      const receipt =
        r.receipt === undefined ? undefined : parseDocumentReceipt(r.receipt);
      if (
        receipt &&
        (receipt.literature_id !== r.literature_id ||
          receipt.asset_id !== r.asset_id ||
          receipt.asset_sha256 !==
            db
              .prepare("SELECT sha256 FROM assets WHERE asset_id=?")
              .get(String(r.asset_id))?.sha256)
      )
        fail("archive-parse-receipt-invalid");
      const now = new Date().toISOString(),
        job = db
          .prepare(
            "SELECT job_id FROM archive_runs WHERE literature_id=? AND run_id=?",
          )
          .get(String(r.literature_id), String(r.run_id))?.job_id;
      if (!job) return null;
      const status = String(r.status),
        elapsed = Math.max(0, Math.round(Number(r.elapsed_ms) || 0));
      db.prepare(
        "INSERT INTO task_steps(job_id,literature_id,asset_id,step,status,reason,calls,input_tokens,output_tokens,elapsed_ms,updated_at) VALUES(?,?,?,'parse',?,?,0,0,0,?,?) ON CONFLICT(job_id,literature_id,asset_id,step) DO UPDATE SET status=excluded.status,reason=excluded.reason,elapsed_ms=task_steps.elapsed_ms+excluded.elapsed_ms,updated_at=excluded.updated_at",
      ).run(
        job,
        String(r.literature_id),
        String(r.asset_id),
        status,
        r.reason === null ? null : String(r.reason),
        elapsed,
        now,
      );
      const sequence = Number(
        db
          .prepare(
            "SELECT COALESCE(max(sequence),-1)+1 AS n FROM execution_events WHERE job_id=?",
          )
          .get(job)!.n,
      );
      db.prepare(
        "INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        `${String(r.run_id)}:${String(r.asset_id)}:parse:${sequence}`,
        job,
        sequence,
        "archive-progress",
        json({
          schema_version: 2,
          run_id: r.run_id,
          attempt_id: `${String(r.run_id)}:${String(r.asset_id)}:parse`,
          literature_id: r.literature_id,
          asset_id: r.asset_id,
          step: "parse",
          phase:
            status === "running"
              ? "started"
              : status === "done"
                ? "completed"
                : "stopped",
          status,
          reason: r.reason ?? null,
          ...(receipt ? { receipt } : {}),
          usage: {
            calls: 0,
            compaction_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
            usage_complete: true,
            elapsed_ms: elapsed,
          },
          stop: null,
          part: onePart(db, String(r.literature_id), String(r.asset_id)),
          page_index: null,
          pages: null,
          page_status: null,
        }),
        now,
      );
      return null;
    }
    if (action === "step") {
      const s = r.receipt as unknown as ArchiveStepReceipt,
        now = new Date().toISOString();
      // The table checks only the form of a name; the valid names are here.
      if (!ARCHIVE_STEPS.includes(s.step as (typeof ARCHIVE_STEPS)[number]))
        fail("archive-step-invalid");
      if (
        !db
          .prepare(
            "SELECT 1 FROM archive_runs WHERE literature_id=? AND run_id=? AND state='running'",
          )
          .get(s.literature_id, String(r.run_id))
      )
        fail("archive-run-stale");
      db.prepare(
        "INSERT INTO archive_steps(literature_id,asset_id,step,status,input_sha256,output_json,reason,elapsed_ms,calls,input_tokens,output_tokens,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id,asset_id,step) DO UPDATE SET status=excluded.status,input_sha256=excluded.input_sha256,output_json=excluded.output_json,reason=excluded.reason,elapsed_ms=excluded.elapsed_ms,calls=excluded.calls,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,updated_at=excluded.updated_at",
      ).run(
        s.literature_id,
        s.asset_id,
        s.step,
        s.status,
        s.input_sha256,
        json(s.output),
        s.reason,
        s.elapsed_ms,
        s.calls,
        s.input_tokens,
        s.output_tokens,
        now,
      );
      const job = db
        .prepare(
          "SELECT job_id FROM archive_runs WHERE literature_id=? AND run_id=?",
        )
        .get(s.literature_id, String(r.run_id))?.job_id;
      if (job)
        db.prepare(
          "INSERT INTO task_steps(job_id,literature_id,asset_id,step,status,reason,calls,input_tokens,output_tokens,elapsed_ms,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,literature_id,asset_id,step) DO UPDATE SET status=excluded.status,reason=excluded.reason,calls=task_steps.calls+excluded.calls,input_tokens=task_steps.input_tokens+excluded.input_tokens,output_tokens=task_steps.output_tokens+excluded.output_tokens,elapsed_ms=task_steps.elapsed_ms+excluded.elapsed_ms,updated_at=excluded.updated_at",
        ).run(
          job,
          s.literature_id,
          s.asset_id,
          s.step,
          s.status,
          s.reason,
          r.record_attempt ? s.calls : 0,
          r.record_attempt ? s.input_tokens : 0,
          r.record_attempt ? s.output_tokens : 0,
          r.record_attempt ? s.elapsed_ms : 0,
          now,
        );
      if (r.record_attempt)
        db.prepare(
          "INSERT INTO archive_attempts(literature_id,asset_id,step,elapsed_ms,calls,input_tokens,output_tokens,stats_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          s.literature_id,
          s.asset_id,
          s.step,
          s.elapsed_ms,
          s.calls,
          s.input_tokens,
          s.output_tokens,
          json(s.output.stats ?? {}),
          now,
        );
      if (job && s.output.schema_version === 2) {
        const sequence = Number(
          db
            .prepare(
              "SELECT COALESCE(max(sequence),-1)+1 AS n FROM execution_events WHERE job_id=?",
            )
            .get(job)!.n,
        );
        const payload = {
          schema_version: 2,
          run_id: r.run_id,
          attempt_id: `${r.run_id}:${s.asset_id}:${s.step}`,
          literature_id: s.literature_id,
          asset_id: s.asset_id,
          step: s.step,
          phase:
            s.status === "running"
              ? "started"
              : s.status === "done"
                ? "completed"
                : "stopped",
          usage: s.output.usage ?? {
            calls: 0,
            compaction_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
            usage_complete: true,
            elapsed_ms: 0,
          },
          page_status: Array.isArray(s.output.pages)
            ? {
                items: s.output.pages.slice(0, 200),
                next_cursor:
                  s.output.pages.length > 200
                    ? archivePageCursor(String(s.output.proofread_id), 200)
                    : null,
              }
            : null,
          stop: s.output.stop ?? null,
          part: onePart(db, s.literature_id, s.asset_id),
          page_index: null,
          pages: Array.isArray(s.output.pages)
            ? {
                ...(s.output.pages.some((p) => p.status === "unreviewed")
                  ? {
                      unreviewed: s.output.pages.filter(
                        (p) => p.status === "unreviewed",
                      ).length,
                    }
                  : {}),
                required: s.output.pages.filter(
                  (p) => p.status !== "not-required",
                ).length,
                accepted: s.output.pages.filter((p) => p.status === "accepted")
                  .length,
                reused: s.output.pages.filter((p) => p.reused).length,
              }
            : null,
        };
        db.prepare(
          "INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
          `${r.run_id}:${s.asset_id}:${s.step}:${sequence}`,
          job,
          sequence,
          "archive-progress",
          json(payload),
          now,
        );
      }
      for (const item of Array.isArray(s.output.issues)
        ? s.output.issues
        : []) {
        const issue = item as { code?: unknown; page_index?: unknown };
        if (issue.code !== "page-content-missing") continue;
        db.prepare(
          "INSERT INTO archive_issues(issue_id,literature_id,asset_id,step,reason,detail_json,resolution,updated_at) VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(issue_id) DO UPDATE SET detail_json=excluded.detail_json,updated_at=excluded.updated_at",
        ).run(
          hash([s.literature_id, s.asset_id, issue.code, issue.page_index]),
          s.literature_id,
          s.asset_id,
          s.step,
          issue.code,
          json(issue),
          now,
        );
      }
      const issue = hash([s.literature_id, s.asset_id, s.step]);
      if (s.status === "failed" || s.status === "unavailable")
        db.prepare(
          "INSERT INTO archive_issues(issue_id,literature_id,asset_id,step,reason,detail_json,resolution,updated_at) VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(issue_id) DO UPDATE SET reason=excluded.reason,detail_json=excluded.detail_json,resolution=NULL,updated_at=excluded.updated_at",
        ).run(
          issue,
          s.literature_id,
          s.asset_id,
          s.step,
          s.reason ?? "archive-step-failed",
          json(s.output),
          now,
        );
      else if (s.status === "done")
        db.prepare(
          "UPDATE archive_issues SET resolution='continue',updated_at=? WHERE issue_id=?",
        ).run(now, issue);
      return null;
    }
    if (action === "resolve") {
      const result = db
        .prepare(
          "UPDATE archive_issues SET resolution=?,updated_at=? WHERE issue_id=?",
        )
        .run(
          String(r.resolution),
          new Date().toISOString(),
          String(r.issue_id),
        );
      if (!result.changes) fail("archive-issue-missing");
      return (
        db
          .prepare(
            "SELECT r.job_id,j.status FROM archive_issues i JOIN archive_runs r ON r.literature_id=i.literature_id JOIN execution_jobs j ON j.job_id=r.job_id WHERE i.issue_id=?",
          )
          .get(String(r.issue_id)) ?? null
      );
    }
    if (action === "hook") {
      if (r.state === "running")
        return {
          claimed:
            db
              .prepare(
                "INSERT INTO archive_batch_hooks(job_id,state,result_json) VALUES(?,'running','{}') ON CONFLICT DO NOTHING",
              )
              .run(String(r.job_id)).changes === 1,
        };
      db.prepare(
        "UPDATE archive_batch_hooks SET state=?,result_json=? WHERE job_id=?",
      ).run(String(r.state), json(r.result), String(r.job_id));
      return null;
    }
    return fail("archive-operation-invalid");
  });
}

function onePart(db: DatabaseSync, literature: string, asset: string) {
  return db
    .prepare(
      "SELECT role FROM literature_assets WHERE literature_id=? AND asset_id=?",
    )
    .get(literature, asset)?.role === "primary-pdf"
    ? "main"
    : "supplementary";
}

function projectArchiveReceipt(o: Record<string, unknown>) {
  const pages = Array.isArray(o.pages)
    ? (o.pages as { status: string; reused?: boolean }[])
    : null;
  return {
    schema_version: 2,
    run_id: o.run_id,
    attempt_id: o.attempt_id,
    usage: o.usage,
    stop: o.stop ?? null,
    output_ids: {
      arrangement_id: o.arrangement_id ?? null,
      proofread_id: o.proofread_id ?? null,
      document_version_id: o.document_version_id ?? null,
      annotation_id: o.annotation_id ?? null,
    },
    pages: pages
      ? {
          ...(pages.some((p) => p.status === "unreviewed")
            ? {
                unreviewed: pages.filter((p) => p.status === "unreviewed")
                  .length,
              }
            : {}),
          required: pages.filter((p) => p.status !== "not-required").length,
          accepted: pages.filter((p) => p.status === "accepted").length,
          reused: pages.filter((p) => p.reused).length,
          pending: pages.filter((p) => p.status === "pending").length,
          failed: pages.filter((p) => p.status === "failed").length,
        }
      : null,
  };
}
