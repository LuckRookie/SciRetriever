import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonBytes,
  parseLiteratureMetadata,
} from "@sciretriever/contracts";
import { readMetadataRow, readObservationRow } from "./metadata-rows.js";
import { projectMetadata } from "../../literature/metadata-rules.js";
import {
  normalizeQueryText,
  ftsIndexText,
} from "../../literature/unicode-casefold.js";
import {
  readMetadataFields,
  writeMetadataFields,
} from "./metadata-field-storage.js";
import {
  INSERT_LITERATURE_SEARCH_ROW,
  literatureSearchRowIds,
} from "./literature-search-rows.js";

/** Only used by the explicit offline migration; source response hashes are never changed. */
export function migrateKeywordLayers(db: DatabaseSync) {
  // The observation tables are decoded projections of provider bytes. Correct the
  // mapping, retaining the original source response and its provenance hash.
  const old =
    "SELECT o.observation_id FROM metadata_observations o JOIN provenances p ON p.provenance_id=o.provenance_id WHERE p.source_kind='metadata-provider' AND p.source_name IN ('openalex','datacite','springer')";
  db.exec(
    `INSERT INTO metadata_observation_subject_terms SELECT k.observation_id,row_number() OVER(PARTITION BY k.observation_id ORDER BY k.ordinal)-1,k.keyword FROM metadata_observation_keywords k WHERE k.observation_id IN (${old}) AND k.ordinal<8`,
  );
  db.exec(
    `DELETE FROM metadata_observation_keywords WHERE observation_id IN (${old}); DELETE FROM metadata_observation_declared_keywords WHERE observation_id IN (${old})`,
  );
  // Frozen v14 -> v15 predates the FTS content index.
  const statement = db.prepare(
    "SELECT rowid,literature_id FROM literature_search_fts",
  );
  statement.setReadBigInts(true);
  const legacyRows = new Map(
    statement
      .all()
      .map((row) => [String(row.literature_id), row.rowid as bigint]),
  );
  return reprojectKeywords(db, undefined, legacyRows);
}

/** Shared by explicit offline maintenance; the caller owns the single transaction. */
export function reprojectKeywordLayers(
  db: DatabaseSync,
  literatureIds: readonly string[],
) {
  return reprojectKeywords(db, literatureIds);
}

function reprojectKeywords(
  db: DatabaseSync,
  literatureIds: readonly string[] | undefined,
  legacyRows?: ReadonlyMap<string, bigint>,
) {
  if (literatureIds?.length === 0) return 0;
  let projected = 0;
  for (const row of db
    .prepare(
      `SELECT literature_id,metadata_revision FROM literature_metadata ${literatureIds ? "WHERE literature_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY literature_id`,
    )
    .all(...(literatureIds ? [JSON.stringify(literatureIds)] : []))) {
    const id = String(row.literature_id),
      current = readMetadataRow(db, "literature", id),
      states = readMetadataFields(db, id);
    const observations = db
      .prepare(
        "SELECT observation_id FROM literature_metadata_observations WHERE literature_id=? ORDER BY observation_id",
      )
      .all(id)
      .map((o) => readObservationRow(db, String(o.observation_id)));
    const result = projectMetadata(observations, {
      current_metadata: current,
      metadata_revision: Number(row.metadata_revision),
      field_states: states,
    });
    if (result.outcome === "rejected")
      throw new Error(`metadata migration rejected: ${result.reason}`);
    // The migration changes the keyword layers only. Other accepted fields and
    // their evidence/locks are preserved, regardless of current source order.
    const next = parseLiteratureMetadata({
      ...current,
      keywords: result.metadata.keywords,
      subject_terms: result.metadata.subject_terms,
    });
    const revision = Number(row.metadata_revision) + 1;
    db.prepare(
      "DELETE FROM literature_metadata_keywords WHERE literature_id=?",
    ).run(id);
    for (const [i, keyword] of next.keywords.entries())
      db.prepare("INSERT INTO literature_metadata_keywords VALUES(?,?,?)").run(
        id,
        i,
        keyword,
      );
    db.prepare(
      "DELETE FROM literature_metadata_subject_terms WHERE literature_id=?",
    ).run(id);
    for (const [i, term] of next.subject_terms.entries())
      db.prepare(
        "INSERT INTO literature_metadata_subject_terms VALUES(?,?,?,?)",
      ).run(id, i, term, normalizeQueryText(term));
    db.prepare(
      "UPDATE literature_metadata SET metadata_revision=?,metadata_sha256=? WHERE literature_id=?",
    ).run(
      revision,
      createHash("sha256").update(canonicalJsonBytes(next)).digest("hex"),
      id,
    );
    const keywordsState = result.field_states.filter(
      (s) => s.field === "keywords",
    );
    writeMetadataFields(db, id, revision, next, [
      ...states.filter((s) => s.field !== "keywords"),
      ...keywordsState,
    ]);
    const ftsId = legacyRows
      ? legacyRows.get(id)
      : literatureSearchRowIds(db, id).at(-1);
    const keywordsText = ftsIndexText(
      [...next.keywords, ...next.subject_terms].join(" "),
    );
    if (ftsId !== undefined)
      db.prepare(
        "UPDATE literature_search_fts SET keywords=? WHERE rowid=?",
      ).run(keywordsText, ftsId);
    else
      db.prepare(INSERT_LITERATURE_SEARCH_ROW).run(
        id,
        ftsIndexText(next.title ?? ""),
        ftsIndexText(next.abstract ?? ""),
        ftsIndexText(next.authors.map((a) => a.display_name).join(" ")),
        ftsIndexText(
          next.authors
            .flatMap((a) => a.affiliations.map((f) => f.name))
            .join(" "),
        ),
        ftsIndexText(next.identifiers.map((i) => i.value).join(" ")),
        keywordsText,
        ftsIndexText(next.venue ?? ""),
        ftsIndexText(next.publisher ?? ""),
        ftsIndexText(next.volume ?? ""),
        ftsIndexText(next.issue ?? ""),
        ftsIndexText(next.pages ?? ""),
        "",
      );
    projected++;
  }
  return projected;
}
