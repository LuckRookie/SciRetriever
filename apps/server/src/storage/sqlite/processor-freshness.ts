import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonBytes,
  type ProcessorInput,
  type ProcessorReads,
  type SnapshotMember,
} from "@sciretriever/contracts";
const json = (v: unknown) =>
  Buffer.from(canonicalJsonBytes(v)).toString("utf8");
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(v)).digest("hex");
const digest = (v: unknown) =>
  typeof v === "string" ? hash(JSON.parse(v)) : null;
export function bindProcessorFreshness(
  db: DatabaseSync,
  id: string,
  inputs: readonly ProcessorInput[],
  reads: ProcessorReads | undefined,
  usesDescription = false,
) {
  db.prepare("INSERT INTO processor_result_freshness VALUES(?,'current')").run(
    id,
  );
  const bind = (
    literature: string,
    parts: readonly {
      asset_id: string;
      part: string;
      document_version_id: string | null;
      structure_annotation_id: string | null;
    }[],
    description: string,
    selected: ProcessorReads["parts"] | "none",
    uses: boolean,
  ) => {
    db.prepare(
      "INSERT OR IGNORE INTO processor_result_archive_scopes VALUES(?,?,?,?,?)",
    ).run(id, literature, selected, Number(uses), description);
    for (const p of parts)
      db.prepare(
        "INSERT OR IGNORE INTO processor_result_archive_parts VALUES(?,?,?,?,?)",
      ).run(
        id,
        literature,
        p.asset_id,
        p.part,
        p.document_version_id && p.structure_annotation_id
          ? json({
              document_version_id: p.document_version_id,
              structure_annotation_id: p.structure_annotation_id,
            })
          : null,
      );
  };
  for (const input of inputs) {
    if (input.kind === "archive-document")
      bind(
        input.literature_id,
        input.parts,
        input.description_version,
        reads?.parts ?? "main",
        false,
      );
    if (input.kind === "snapshot") {
      // Watch exactly the scopes of map results, including an absent supplementary part.
      for (const mapped of input.mapped_results) {
        db.prepare(
          "INSERT OR IGNORE INTO processor_result_archive_scopes SELECT ?,literature_id,parts,?,description_version FROM processor_result_archive_scopes WHERE result_id=?",
        ).run(id, Number(usesDescription), mapped.result_id);
        db.prepare(
          "INSERT OR IGNORE INTO processor_result_archive_parts SELECT ?,literature_id,asset_id,part,source_json FROM processor_result_archive_parts WHERE result_id=?",
        ).run(id, mapped.result_id);
      }
      if (usesDescription && input.mapped_results.length)
        db.prepare(
          "UPDATE processor_result_archive_scopes SET description_version=(SELECT json_extract(member_json,'$.description_version') FROM snapshot_members m WHERE m.snapshot_id=? AND m.literature_id=processor_result_archive_scopes.literature_id) WHERE result_id=?",
        ).run(input.snapshot_id, id);
      if (usesDescription && !input.mapped_results.length)
        for (const row of db
          .prepare(
            "SELECT member_json FROM snapshot_members WHERE snapshot_id=?",
          )
          .all(input.snapshot_id)) {
          const member = JSON.parse(String(row.member_json)) as SnapshotMember;
          bind(
            member.literature_id,
            [],
            member.description_version,
            "none",
            true,
          );
        }
    }
  }
  // A fixed snapshot may already be older than the current catalog when its result is published.
  for (const s of db
    .prepare("SELECT * FROM processor_result_archive_scopes WHERE result_id=?")
    .all(id)) {
    const literature = String(s.literature_id);
    const expected = db
        .prepare(
          "SELECT asset_id,part,source_json FROM processor_result_archive_parts WHERE result_id=? AND literature_id=?",
        )
        .all(id, literature),
      current = db
        .prepare(
          "SELECT asset_id,part,source_json FROM archive_content_heads WHERE literature_id=? AND (?='all' OR part=?)",
        )
        .all(literature, String(s.parts), String(s.parts));
    for (const asset of new Set(
      [...expected, ...current].map((p) => String(p.asset_id)),
    )) {
      const a = expected.find((p) => p.asset_id === asset),
        b = current.find((p) => p.asset_id === asset);
      if (a && b && a.part === b.part && a.source_json === b.source_json)
        continue;
      db.prepare(
        "INSERT OR IGNORE INTO processor_result_freshness_reasons VALUES(?,?,NULL,?,?,'content-version-changed',?,?,NULL)",
      ).run(
        id,
        `published:${asset}`,
        literature,
        asset,
        a?.source_json ?? null,
        b?.source_json ?? null,
      );
    }
    if (s.uses_description === 1) {
      const d = db
        .prepare(
          "SELECT source_json FROM archive_description_heads WHERE literature_id=?",
        )
        .get(literature);
      if (digest(d?.source_json) !== s.description_version)
        db.prepare(
          "INSERT OR IGNORE INTO processor_result_freshness_reasons VALUES(?,?,NULL,?,NULL,'description-version-changed',NULL,?,?)",
        ).run(
          id,
          `published-description:${literature}`,
          literature,
          d?.source_json ?? null,
          String(s.description_version),
        );
    }
  }
  db.prepare(
    "UPDATE processor_result_freshness SET state='stale' WHERE result_id=? AND EXISTS(SELECT 1 FROM processor_result_freshness_reasons WHERE result_id=?)",
  ).run(id, id);
}
export function readProcessorFreshness(db: DatabaseSync, id: string) {
  const row = db
    .prepare("SELECT state FROM processor_result_freshness WHERE result_id=?")
    .get(id);
  if (!row)
    throw Object.assign(new Error("processor freshness missing"), {
      code: "processor-freshness-missing",
    });
  const reasons = db
    .prepare(
      "SELECT * FROM processor_result_freshness_reasons WHERE result_id=? ORDER BY reason_key LIMIT 101",
    )
    .all(id);
  return {
    state: row.state as "current" | "stale",
    reasons: reasons.slice(0, 100).map((r) => ({
      event_sequence: r.event_sequence,
      literature_id: r.literature_id,
      asset_id: r.asset_id,
      kind: r.kind,
      old_version: r.expected_version ?? digest(r.old_json),
      new_version: digest(r.new_json),
    })),
    reasons_truncated: reasons.length > 100,
  };
}
