import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAsset, parseLiterature, sha256 } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import {
  archiveLongDocuments,
  readArchiveCurrentParts,
} from "../src/storage/sqlite/archive-engine.js";
import { readDefaultTextFacts } from "../src/storage/sqlite/draft-facts.js";
import { runDraftTextRead } from "../src/storage/sqlite/draft-text-engine.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

const VIEW_PARTS = `SELECT p.*,
  (SELECT d.schema_version FROM document_versions d WHERE d.document_version_id=p.document_version_id) AS document_schema_version,
  (SELECT json_group_array(profile) FROM raw_parse_current r WHERE r.source_asset_id=p.asset_id AND r.source_sha256=p.asset_sha256 AND r.raw_parse_id IS NOT NULL) AS profiles_json
  FROM archive_current_parts p`;
const PART_ORDER = "ORDER BY p.part<>'main',p.asset_id";
const VIEW_DEFAULT_JOIN = `LEFT JOIN (document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id)
  ON d.literature_id=la.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256`;

function matchOriginalReads(db: DatabaseSync, id: string, otherId: string) {
  const ids = [otherId, id];
  const batch = JSON.stringify(ids);
  const parts = readArchiveCurrentParts(db, id);
  expect(parts).toEqual(
    db.prepare(`${VIEW_PARTS} WHERE p.literature_id=? ${PART_ORDER}`).all(id),
  );
  expect(readArchiveCurrentParts(db, ids)).toEqual(
    db
      .prepare(
        `${VIEW_PARTS} WHERE p.literature_id IN (SELECT value FROM json_each(?)) ${PART_ORDER}`,
      )
      .all(batch),
  );
  expect(readArchiveCurrentParts(db, [])).toEqual([]);

  const oldFacts = db
    .prepare(
      `SELECT la.literature_id,a.asset_id,CASE la.role WHEN 'primary-pdf' THEN 'main' ELSE 'supplementary' END AS part,
        d.document_version_id AS document_version_id,d.schema_version AS schema_version,
        df.differs_segments,df.differences,df.image_only_pages
      FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
      ${VIEW_DEFAULT_JOIN}
      LEFT JOIN draft_version_facts df ON df.document_version_id=d.document_version_id AND d.schema_version=3
      WHERE a.media_type='application/pdf' AND la.role IN ('primary-pdf','supplementary-pdf')
        AND la.literature_id IN (SELECT value FROM json_each(?))
      ORDER BY la.literature_id,part,a.asset_id`,
    )
    .all(batch);
  expect(readDefaultTextFacts(db, ids)).toEqual(
    oldFacts.map((row) => ({
      literature_id: row.literature_id,
      asset_id: row.asset_id,
      part: row.part,
      default_text:
        row.document_version_id === null
          ? null
          : {
              document_version_id: row.document_version_id,
              text_level: row.schema_version === 3 ? "draft" : "proofread",
              draft_facts:
                row.schema_version === 3
                  ? {
                      differs_segments: row.differs_segments,
                      differences: row.differences,
                      image_only_pages: row.image_only_pages,
                      citing_results: 0,
                      unfound_citations: 0,
                    }
                  : null,
            },
    })),
  );
  expect(
    runDraftTextRead(db, { kind: "primary-defaults", literature_ids: ids }),
  ).toEqual(
    db
      .prepare(
        `SELECT l.literature_id,a.asset_id,d.document_version_id AS document_version_id,
          CASE d.schema_version WHEN 3 THEN 'draft' WHEN 2 THEN 'proofread' ELSE NULL END AS text_level
        FROM json_each(?) requested JOIN literatures l ON l.literature_id=requested.value
        LEFT JOIN literature_assets la ON la.literature_id=l.literature_id AND la.role='primary-pdf'
        LEFT JOIN assets a ON a.asset_id=la.asset_id AND a.media_type='application/pdf'
        LEFT JOIN (document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id)
          ON d.literature_id=l.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256
        ORDER BY l.literature_id`,
      )
      .all(batch),
  );
  return parts;
}

it("matches the original archive parts and default joins across document states", async () => {
  const fixture = await coreProcessingFixture({
    offline: true,
    analysisModel: false,
    textLayer: (text) => (text === "Yield 67%." ? "Yield 97%." : text),
  });
  const { app } = fixture;
  const id = fixture.parseRequest.literature_id;
  const otherId = randomUUID();
  const db = new DatabaseSync(join(fixture.home, "catalog.sqlite"));
  try {
    await app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: otherId,
        version_role: "preprint",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          identifiers: [],
          title: "Synthetic archive parity preprint",
        },
      }),
    );
    const bytes = workbenchPdf("10.1000/archive-parity-supplement");
    const staged = await app.files.stage({ maxBytes: bytes.length });
    await staged.write(bytes);
    const path = "objects/archive-parity-supplement.pdf";
    await app.files.publish(staged, path);
    const supplement = parseAsset({
      asset_id: randomUUID(),
      sha256: await sha256(bytes),
      size_bytes: bytes.length,
      media_type: "application/pdf",
      path,
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: id,
      asset: supplement,
      role: "supplementary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-11-21T00:00:00Z",
        input_sha256: supplement.sha256,
        parameters_sha256: null,
      },
    });
    expect(matchOriginalReads(db, id, otherId)).toMatchObject([
      { part: "main", document_version_id: null },
      { part: "supplementary", document_version_id: null },
    ]);

    const draft = await app.documentProcessing.parseDocuments({
      ...fixture.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    if (draft.draft.status !== "formed")
      throw new Error("Synthetic draft missing");
    expect(matchOriginalReads(db, id, otherId)[0]).toMatchObject({
      document_version_id: draft.draft.document_version_id,
      document_schema_version: 3,
    });
    const proofread = await app.proofreading!.build({
      asset_id: fixture.asset.asset_id,
    });
    expect(proofread.version.status).toBe("complete");
    const corrected = await app.proofreadDocuments.publish({
      literature_id: id,
      asset_id: fixture.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: 1,
    });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM document_versions WHERE literature_id=?",
        )
        .get(id),
    ).toEqual({ n: 2 });

    fixture.setText("Yield 67%.");
    await app.rawParsing!.parseAsset(
      supplement.asset_id,
      ["vlm-engine"],
      undefined,
      { force: false, expected_sha256: supplement.sha256 },
    );
    const incomplete = await app.proofreading!.build({
      asset_id: supplement.asset_id,
    });
    expect(incomplete.version.status).toBe("incomplete");
    expect(matchOriginalReads(db, id, otherId)).toMatchObject([
      {
        part: "main",
        document_version_id: corrected.document.document_version_id,
        document_schema_version: 2,
      },
      {
        part: "supplementary",
        proofread_status: "incomplete",
        document_version_id: null,
      },
    ]);

    const marker = { pages: 51, arrange_input_bytes: 1, reasons: ["pages"] };
    db.prepare(
      `INSERT INTO archive_steps VALUES(?,?,'arrange','pending',?, ?,NULL,0,0,0,0,?)`,
    ).run(
      id,
      fixture.asset.asset_id,
      "a".repeat(64),
      JSON.stringify({ long_document: marker }),
      "2026-11-21T00:00:00Z",
    );
    const oldMarkers = db
      .prepare(
        `SELECT p.literature_id,json_extract(s.output_json,'$.long_document') AS marker
        FROM archive_current_parts p JOIN archive_steps s
          ON s.literature_id=p.literature_id AND s.asset_id=p.asset_id AND s.step='arrange'
        WHERE p.part='main' AND p.literature_id IN (SELECT value FROM json_each(?))
          AND json_type(s.output_json,'$.long_document')='object'`,
      )
      .all(JSON.stringify([id, otherId]));
    expect(archiveLongDocuments(db, [id, otherId])).toEqual(
      new Map(
        oldMarkers.map((row) => [
          row.literature_id,
          JSON.parse(String(row.marker)),
        ]),
      ),
    );
    expect(archiveLongDocuments(db, [id, otherId]).get(id)).toEqual(marker);
  } finally {
    db.close();
    await fixture.close();
  }
}, 30_000);
