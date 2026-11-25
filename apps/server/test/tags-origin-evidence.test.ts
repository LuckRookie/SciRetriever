import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseLiteratureSearchItem,
  parseTagAssignmentDetail,
} from "@sciretriever/contracts";
import { tagFixture, topicDraft } from "./tag-fixture.js";
import type { TagModel } from "../src/tags/service.js";
import { manageTags } from "../src/entry/tag-operations.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";

const usage = { calls: 1, input_tokens: 1, output_tokens: 1 };
const model: TagModel = {
  identity: "b".repeat(64),
  async run(task, input) {
    const v = input as {
      fragments?: { segment_id: string }[];
      topics?: { candidates: { tag_id: string }[] }[];
    };
    return {
      value:
        task === "topics"
          ? {
              topics: [
                {
                  name: "Photoredox",
                  reason: "Model reason",
                  segment_ids: [v.fragments![0]!.segment_id],
                },
              ],
            }
          : {
              choices: [
                {
                  topic_index: 0,
                  tag_id: null,
                  create: topicDraft("Photoredox"),
                  rejected_candidates: (v.topics![0]!.candidates ?? []).map(
                    (c) => ({ tag_id: c.tag_id, reason: "Different" }),
                  ),
                },
              ],
            },
      usage,
    };
  },
};

it("gives each listed tag its origin, lock and evidence count, and a detail read with reasons and stale evidence", async () => {
  const e = await tagFixture(model);
  try {
    const query = await createQueryApplication(e.home);
    const web = await startQueryOnlyHttp({ application: query });
    const post = async (name: string, request: unknown) => {
      const response = await fetch(`${web.origin}/api/v1/query/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: unknown }).result;
    };
    const detail = async () =>
      parseTagAssignmentDetail(
        await post("tags", {
          operation: "assignment-detail",
          request: { literature_id: e.id },
        }),
      );
    const listed = async () => {
      const page = await e.app.library.search({ query: {} });
      const item = page.items.find((i) => i.literature.literature_id === e.id)!;
      expect(parseLiteratureSearchItem(item)).toEqual(item);
      return item.tags;
    };
    try {
      // Full text but no assignment: an explicit empty result.
      expect(await detail()).toEqual({
        literature_id: e.id,
        current_document_version_id: e.doc.document_version_id,
        revision: null,
        vocab_version: null,
        model: null,
        items: [],
      });
      expect(await listed()).toEqual([]);

      const built = await e.tags.build(e.request);
      const auto = built.assignment.items[0]!;
      expect(auto.origin).toBe("auto");
      const added = await e.create("Manual topic");
      await e.tags.assign({
        literature_id: e.id,
        items: [
          auto,
          {
            tag_id: added,
            rank: 2,
            reason: "Person reason",
            evidence: [
              {
                document_version_id: e.doc.document_version_id,
                segment_ids: e.segments,
              },
            ],
            origin: "manual",
            locked: true,
          },
        ],
        expected_revision: built.assignment.revision,
        expected_version: (await e.tags.state()).version,
        reason: "Add one",
        model: null,
      });
      const tags = await listed();
      expect(tags).toEqual([
        {
          tag_id: auto.tag_id,
          name: "Photoredox",
          rank: 1,
          origin: "auto",
          locked: false,
          evidence_count: 1,
        },
        {
          tag_id: added,
          name: "Manual topic",
          rank: 2,
          origin: "manual",
          locked: true,
          evidence_count: e.segments.length,
        },
      ]);

      const before = await detail();
      expect(before).toMatchObject({
        current_document_version_id: e.doc.document_version_id,
        revision: 2,
        items: [
          {
            tag_id: auto.tag_id,
            reason: "Model reason",
            origin: "auto",
            locked: false,
            evidence_stale: false,
            evidence: [
              {
                document_version_id: e.doc.document_version_id,
                segment_ids: auto.evidence[0]!.segment_ids,
                stale: false,
              },
            ],
          },
          {
            tag_id: added,
            reason: "Person reason",
            origin: "manual",
            locked: true,
            evidence_stale: false,
          },
        ],
      });
      // The locator is read with the reading page's own segment slice query.
      const evidence = before.items[0]!.evidence[0]!;
      const sliceRequest = parseDocumentReadRequest("slice", {
        document_version_id: evidence.document_version_id,
        selector: { kind: "segment", segment_id: evidence.segment_ids[0] },
        max_bytes: 4096,
        continuation: null,
      });
      const slice = parseDocumentReadResult(
        "slice",
        await post("document-slice", sliceRequest),
        sliceRequest,
      );
      expect(slice.text.length).toBeGreaterThan(0);
      expect(slice.evidence[0]).toMatchObject({
        target_kind: "document",
        document_version_id: evidence.document_version_id,
        locator: { kind: "segment", segment_id: evidence.segment_ids[0] },
      });

      // A person locking the model's tag: stored origin becomes manual.
      await manageTags(e.tags, {
        operation: "lock",
        request: {
          literature_id: e.id,
          tag_id: auto.tag_id,
          locked: true,
          expected_revision: before.revision,
        },
      });
      expect((await listed())![0]).toMatchObject({
        tag_id: auto.tag_id,
        origin: "manual",
        locked: true,
      });

      // The full text the evidence cites is no longer current.
      const catalog = new DatabaseSync(join(e.home, "catalog.sqlite"));
      try {
        catalog
          .prepare("DELETE FROM document_defaults WHERE document_version_id=?")
          .run(e.doc.document_version_id);
      } finally {
        catalog.close();
      }
      const stale = await detail();
      expect(stale.current_document_version_id).toBeNull();
      expect(stale.items.map((i) => i.evidence_stale)).toEqual([true, true]);
      expect(stale.items[0]!.evidence[0]!.stale).toBe(true);
    } finally {
      await web.close();
      await query.close();
    }
  } finally {
    await e.close();
  }
}, 30_000);
