import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  parseTagAssignment,
  type TagDraft,
} from "@sciretriever/contracts";
import type { Application } from "../src/bootstrap/application.js";

export async function facetTag(
  app: Pick<Application, "tags">,
  name: string,
  overrides: Partial<TagDraft> = {},
) {
  const result = await app.tags.change({
    mutation: {
      op: "create",
      tag: {
        name_en: name,
        name_zh: "",
        aliases: [],
        definition: { includes: name, excludes: "" },
        parent_id: null,
        category: null,
        kind: "topic",
        ...overrides,
      },
    },
    expected_version: (await app.tags.state()).version,
    reason: "Synthetic facets vocabulary",
  });
  return result.inverse[0]!.tag_id;
}

/** Seed read-projection assignments; no parsing or model is involved. */
export function facetAssignments(
  home: string,
  assignments: readonly { literature_id: string; tag_ids: readonly string[] }[],
  retired?: { tag_id: string; into: string },
) {
  const db = new DatabaseSync(join(home, "catalog.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys=ON;BEGIN");
    const version = Number(
      db.prepare("SELECT version FROM vocabulary_state").get()!.version,
    );
    for (const { literature_id, tag_ids } of assignments) {
      const items = tag_ids.map((tag_id, i) => ({
        tag_id,
        rank: i + 1,
        reason: "Synthetic projection",
        origin: "manual",
        locked: false,
        evidence: [
          {
            document_version_id: randomUUID(),
            segment_ids: ["synthetic-segment"],
          },
        ],
      }));
      const assignment = parseTagAssignment({
        literature_id,
        items,
        vocab_version: version,
        revision: 1,
        model: null,
        assignment_sha256: createHash("sha256")
          .update(canonicalJsonBytes({ literature_id, items }))
          .digest("hex"),
      });
      db.prepare(
        "INSERT INTO literature_tag_assignments VALUES(?,1,?,?,?)",
      ).run(
        literature_id,
        version,
        assignment.assignment_sha256,
        Buffer.from(canonicalJsonBytes(assignment)).toString("utf8"),
      );
      for (const item of items)
        db.prepare("INSERT INTO literature_tag_items VALUES(?,?,?,0)").run(
          literature_id,
          item.tag_id,
          item.rank,
        );
    }
    // Deliberately retain an old assignment/alias so active-only reads are tested.
    if (retired) {
      const tag = JSON.parse(
        String(
          db
            .prepare("SELECT row_json FROM tags WHERE tag_id=?")
            .get(retired.tag_id)!.row_json,
        ),
      );
      db.prepare(
        "UPDATE tags SET status='merged',merged_into=?,row_json=? WHERE tag_id=?",
      ).run(
        retired.into,
        JSON.stringify({ ...tag, status: "merged", merged_into: retired.into }),
        retired.tag_id,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
