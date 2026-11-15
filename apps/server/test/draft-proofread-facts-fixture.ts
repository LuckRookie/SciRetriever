import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import {
  parseLiterature,
  PROCESSOR_METHOD_REVISION,
} from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { draftStorageFixture } from "./draft-text-storage-fixture.js";

export const factId = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const hash = (n: number) => n.toString(16).padStart(64, "0");
type Counts = {
  differs_segments: number;
  differences: number;
  image_only_pages: number;
};
export async function proofreadFactsFixture() {
  const f = await draftStorageFixture();
  await f.storage.commitDraftVersion(f.publication);
  const db = new DatabaseSync(join(f.e.home, "catalog.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=20000");
  const template = db
    .prepare("SELECT * FROM document_versions WHERE document_version_id=?")
    .get(f.output.document.document_version_id)!;
  const raw = db
    .prepare("SELECT * FROM raw_parses WHERE raw_parse_id=?")
    .get(template.raw_parse_id!)!;
  const provenance = db
    .prepare(
      "SELECT provenance_id FROM literature_assets WHERE literature_id=?",
    )
    .get(f.e.parseRequest.literature_id)!.provenance_id!;
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    ).run(...Object.values(row));
  };
  // Catalog-only synthetic closures deliberately have no PDF/result files.
  // Fact queries must not read any of those bytes or admit processor inputs.
  const part = (
    lit: string,
    n: number,
    kind: "draft" | "proofread" | "missing",
    counts: Counts = {
      differs_segments: 0,
      differences: 0,
      image_only_pages: 0,
    },
    role = "primary-pdf",
  ) => {
    const aid = factId(n + 10000),
      sha = hash(n + 10000),
      path = `objects/facts-${n}.pdf`,
      vid = factId(n + 20000),
      doc = factId(n + 30000),
      rid = factId(n + 40000);
    insert("artifact_objects", {
      artifact_id: factId(n + 50000),
      sha256: sha,
      byte_size: 123,
      media_type: "application/pdf",
      relative_path: path,
    });
    insert("assets", {
      asset_id: aid,
      sha256: sha,
      size_bytes: 123,
      media_type: "application/pdf",
      relative_path: path,
    });
    insert("literature_assets", {
      literature_asset_id: factId(n + 60000),
      literature_id: lit,
      asset_id: aid,
      role,
      provenance_id: provenance,
      source_url: null,
    });
    if (kind === "missing") return { lit, aid, vid: null };
    insert("raw_parses", {
      ...raw,
      raw_parse_id: rid,
      source_asset_id: aid,
      source_sha256: sha,
    });
    insert("raw_parse_current", {
      source_asset_id: aid,
      source_sha256: sha,
      profile: raw.profile!,
      raw_parse_id: rid,
      last_failure_code: null,
      last_parameters_sha256: null,
    });
    const row: Record<string, SQLInputValue> = {
      ...template,
      document_version_id: vid,
      document_id: doc,
      literature_id: lit,
      source_asset_id: aid,
      source_sha256: sha,
      source_byte_size: 123,
      source_artifact_path: path,
      raw_parse_id: rid,
    };
    if (kind === "proofread") {
      const pid = factId(n + 70000),
        contentHash = hash(n + 70000);
      insert("proofread_versions", {
        proofread_id: pid,
        part_asset_id: aid,
        part_sha256: sha,
        content_sha256: contentHash,
        status: "complete",
        manifest_reference: raw.manifest_reference!,
        manifest_sha256: raw.manifest_sha256!,
        manifest_size: raw.manifest_size!,
        manifest_media_type: "application/json",
        created_at: "2026-11-15T00:00:00Z",
      });
      insert("proofread_current", {
        part_asset_id: aid,
        manual_revision: 0,
        part_sha256: sha,
        proofread_id: pid,
        revision: 1,
      });
      Object.assign(row, {
        schema_version: 2,
        proofread_id: pid,
        proofread_content_sha256: contentHash,
        builder_version: "source-order-leaves-v4",
      });
      for (const key of [
        "raw_parse_id",
        "raw_parse_result_sha256",
        "page_layer_sha256",
        "draft_method_sha256",
        "draft_content_artifact_path",
        "draft_content_sha256",
        "draft_content_byte_size",
        "draft_content_media_type",
      ])
        row[key] = null;
    }
    insert("document_versions", row);
    if (kind === "draft") {
      insert("draft_version_facts", { document_version_id: vid, ...counts });
      insert("draft_current", {
        part_asset_id: aid,
        part_sha256: sha,
        document_version_id: vid,
        revision: 1,
      });
    }
    insert("document_defaults", {
      document_id: doc,
      document_version_id: vid,
      revision: 1,
    });
    return { lit, aid, vid };
  };
  const paper = async (
    n: number,
    kind: "draft" | "proofread" | "missing" | "no-pdf",
    counts?: Counts,
  ) => {
    const lit = factId(n);
    await f.e.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: lit,
        meta_literature_id: factId(n + 100000),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: `Synthetic facts ${n}`,
          identifiers: [],
        },
      }),
    );
    if (kind === "no-pdf") return { lit, aid: null, vid: null };
    db.exec("BEGIN");
    try {
      const p = part(lit, n, kind, counts);
      db.exec("COMMIT");
      return p;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const result = (
    n: number,
    versions: readonly string[],
    state = "current",
    method: string = PROCESSOR_METHOD_REVISION,
  ) => {
    const resultId = `synthetic-result-${n}`,
      sha = hash(n + 900000),
      path = `results/facts-${n}.json`;
    insert("artifact_objects", {
      artifact_id: factId(n + 800000),
      sha256: sha,
      byte_size: 1,
      media_type: "application/json",
      relative_path: path,
    });
    insert("processor_results", {
      result_id: resultId,
      comparison_sha256: hash(n + 900001),
      processor_id: "synthetic",
      processor_version: "1",
      complete: 1,
      producer: "external",
      content_reference: path,
      content_sha256: sha,
      content_size: 1,
      content_media_type: "application/json",
      created_at: "2026-11-15T00:00:00Z",
    });
    insert("processor_result_freshness", { result_id: resultId, state });
    insert("processor_result_summaries", {
      result_id: resultId,
      usage_json: null,
      outcomes_json: "[]",
      method_revision: method,
    });
    for (const version of versions)
      db.prepare(
        "INSERT OR IGNORE INTO processor_result_documents SELECT ?,literature_id,source_asset_id,source_sha256,document_version_id,representation_sha256 FROM document_versions WHERE document_version_id=?",
      ).run(resultId, version);
    return resultId;
  };
  const unfound = (
    result: string,
    version: string,
    pointer: string,
    record = "record",
  ) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO processor_unfound_citations VALUES(?,?,?,?)",
      )
      .run(result, record, pointer, version);
  return {
    f,
    db,
    paper,
    part,
    result,
    unfound,
    insert,
    async close() {
      db.close();
      await f.close();
    },
  };
}
