import { expect, it } from "vitest";
import {
  parseLibrarySearchRequest,
  parseTag,
  type TagAssignment,
} from "@sciretriever/contracts";
import { tagFixture, topicDraft } from "./tag-fixture.js";
import type { TagModel } from "../src/tags/service.js";
import { runCli } from "../src/cli/main.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
const usage = { calls: 1, input_tokens: 20, output_tokens: 10 };
// Reached 2.1 s under Full (36/12) load, too close to the 5 s default.
it("uses two model steps, requires candidate rejection and corrected evidence, and reuses an existing alias", async () => {
  const calls: string[] = [];
  let observedCoverage: unknown;
  const model: TagModel = {
    identity: "a".repeat(64),
    async run(task, input) {
      calls.push(task);
      const v = input as {
        fragments?: { segment_id: string }[];
        topics?: { candidates: { tag_id: string }[] }[];
        coverage?: unknown;
      };
      if (task === "topics") observedCoverage = v.coverage;
      if (task === "select")
        for (const candidate of v.topics![0]!.candidates)
          expect(() => parseTag(candidate)).not.toThrow();
      return {
        value:
          task === "topics"
            ? {
                topics: [
                  {
                    name: "Photoredox",
                    reason: "Main topic",
                    segment_ids: [v.fragments![0]!.segment_id],
                  },
                ],
              }
            : {
                choices: [
                  {
                    topic_index: 0,
                    tag_id: v.topics![0]!.candidates[0]?.tag_id ?? null,
                    create: v.topics![0]!.candidates.length
                      ? null
                      : topicDraft("Photoredox"),
                    rejected_candidates: [],
                  },
                ],
              },
        usage,
      };
    },
  };
  const e = await tagFixture(model);
  try {
    const first = await e.tags.build(e.request);
    expect(first.input_coverage).toEqual({
      document_version_id: e.doc.document_version_id,
      annotation_id: e.annotation.annotation_id,
      ...(observedCoverage as object),
    });
    expect(first.input_coverage.truncated).toBe(false);
    expect(first.input_coverage.included_segment_ids.length).toBeGreaterThan(0);
    expect(first.usage).toEqual({
      calls: 2,
      input_tokens: 40,
      output_tokens: 20,
    });
    expect(first.created_tags).toBe(1);
    expect(first.assignment.items).toHaveLength(1);
    const second = await e.tags.build(e.request);
    expect(second.created_tags).toBe(0);
    expect(second.assignment.items[0]!.tag_id).toBe(
      first.assignment.items[0]!.tag_id,
    );
    expect(calls).toEqual(["topics", "select", "topics", "select"]);
    await expect(
      e.tags.assign({
        literature_id: e.id,
        items: [
          {
            ...second.assignment.items[0],
            evidence: [
              {
                document_version_id: e.doc.document_version_id,
                segment_ids: ["forged"],
              },
            ],
          },
        ],
        expected_revision: second.assignment.revision,
        expected_version: (await e.tags.state()).version,
        reason: "Invalid evidence",
        model: null,
      }),
    ).rejects.toMatchObject({ code: "tag-evidence-invalid" });
  } finally {
    await e.close();
  }
}, 30_000);
// Reached 2.7 s under Full (36/12) load, too close to the 5 s default.
it("filters primary/any/parent/aliases consistently for pages and frozen selection and reports unexamined old assignments", async () => {
  const e = await tagFixture();
  try {
    const primary = await e.create("Energy"),
      parent = await e.create("Catalysis"),
      child = await e.create("Photoredox", parent);
    await e.assign([primary, child]);
    const search = (ids: string[], mode: "primary" | "any") =>
      e.app.library.search({ query: { tags: { ids, mode } } });
    expect((await search([parent], "any")).total_count).toBe(1);
    expect((await search(["Photoredox"], "primary")).total_count).toBe(0);
    expect((await search(["Energy"], "primary")).total_count).toBe(1);
    const snapshot = await e.app.library.selectionSnapshot(
      parseLibrarySearchRequest({
        query: { tags: { ids: [parent], mode: "any" } },
      }).query,
    );
    expect(snapshot.matches.map((r) => r.literature.literature_id)).toEqual([
      e.id,
    ]);
    const newer = await e.create("Synthetic studies");
    expect(await search([newer], "any")).toMatchObject({
      total_count: 0,
      tag_backfill_pending: 1,
    });
    expect(
      (
        await runCli(["literature", "search", "--tag", parent], {
          home: e.home,
        })
      ).code,
    ).toBe(0);
    const mcp = createMcpServer({ home: e.home }),
      client = new Client({ name: "tags-fixture", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(a);
      await client.connect(b);
      const response = await client.callTool({
        name: "tags_query",
        arguments: { operation: "show", request: { tag_id: child } },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        result: { tag: { tag_id: child } },
      });
    } finally {
      await client.close();
      await mcp.close();
    }
  } finally {
    await e.close();
  }
}, 30_000);
// Reached 2.5 s under Full (36/12) load, too close to the 5 s default.
it("preserves locked assignments, atomically merges ranks, and detects an intervening manual edit before undo", async () => {
  const e = await tagFixture();
  try {
    const a = await e.create("Topic A"),
      b = await e.create("Topic B");
    await e.assign([a, b], true);
    const mutate = async (
      op: unknown,
      actor: "manual" | "consolidation" = "manual",
    ) =>
      e.tags.change(
        {
          mutation: op,
          expected_version: (await e.tags.state()).version,
          reason: "Synthetic merge",
        },
        actor,
      );
    expect(
      (await mutate({ op: "merge", tag_id: a, into: b }, "consolidation"))
        .outcome,
    ).toBe("skipped-locked");
    await e.assign([a, b], false);
    const merged = await mutate({ op: "merge", tag_id: a, into: b });
    expect(
      (await e.tags.assignment(e.id))!.items.map((i) => [i.tag_id, i.rank]),
    ).toEqual([[b, 1]]);
    await e.assign([b], true);
    await expect(
      mutate({ op: "undo", change_version: merged.version, cascade: false }),
    ).rejects.toMatchObject({ code: "tag-undo-assignment-conflict" });
    expect((await e.tags.get(a))!.tag.status).toBe("merged");
  } finally {
    await e.close();
  }
}, 30_000);
// Reached 2.3 s under Full (36/12) load, too close to the 5 s default.
it("previews backfill without a model and groups each paper with all candidate tags in one call", async () => {
  let calls = 0;
  const model: TagModel = {
    identity: "a".repeat(64),
    async run(task, input) {
      expect(task).toBe("backfill");
      calls++;
      const v = input as {
        tags: { tag_id: string }[];
        materials: { literature_id: string; assignment: TagAssignment }[];
      };
      return {
        value: {
          decisions: v.materials.map((m) => ({
            literature_id: m.literature_id,
            tag_ids: m.assignment.items.map((i) => i.tag_id),
            reason: "Keep existing scope",
          })),
        },
        usage,
      };
    },
  };
  const e = await tagFixture(model);
  try {
    await e.assign([await e.create("Photoredox")]);
    const tag = await e.create("Synthetic");
    expect(await e.tags.backfill([tag])).toMatchObject({
      candidate_count: 1,
      estimated_calls: 1,
      batch_size: 8,
    });
    expect(calls).toBe(0);
    expect(await e.tags.backfill([tag], false)).toMatchObject({
      examined: 1,
      updated: 0,
      usage,
    });
    expect(calls).toBe(1);
    expect(await e.tags.backfill([tag])).toMatchObject({ candidate_count: 0 });
    expect(
      (await e.tags.get(tag))!.tag.backfilled_vocab_version,
    ).not.toBeNull();
  } finally {
    await e.close();
  }
}, 30_000);

// Reached 2.8 s under Full (36/12) load, too close to the 5 s default.
it("absorbs a concurrently created vocabulary name across two corrected papers instead of creating duplicates", async () => {
  let selected = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: TagModel = {
    identity: "b".repeat(64),
    async run(task, input) {
      const v = input as { fragments?: { segment_id: string }[] };
      if (task === "topics")
        return {
          value: {
            topics: [
              {
                name: "Shared topic",
                reason: "Main topic",
                segment_ids: [v.fragments![0]!.segment_id],
              },
            ],
          },
          usage,
        };
      selected++;
      if (selected === 2) release();
      await barrier;
      return {
        value: {
          choices: [
            {
              topic_index: 0,
              tag_id: null,
              create: topicDraft("Shared topic"),
              rejected_candidates: [],
            },
          ],
        },
        usage,
      };
    },
  };
  const e = await tagFixture(model);
  try {
    const other = "00000000-0000-4000-9000-000000009999";
    const current = (await e.app.library.detail(e.id)).literature;
    await e.app.database.putLiterature({
      ...current,
      literature_id: other as typeof current.literature_id,
      meta_literature_id:
        "00000000-0000-4000-9000-000000009998" as typeof current.meta_literature_id,
      metadata: { ...current.metadata, identifiers: [] },
    });
    const source = (await e.app.library.detail(e.id)).primary_pdf!;
    await e.app.database.putLiteratureAsset({
      ...source.literature_asset,
      literature_id: other as typeof current.literature_id,
      literature_asset_id:
        "00000000-0000-4000-9000-000000009997" as typeof source.literature_asset.literature_asset_id,
      asset: source.asset,
    });
    const doc = (
      await e.app.proofreadDocuments.publish({
        literature_id: other,
        asset_id: e.asset.asset_id,
        proofread_id: e.doc.schema_version === 2 ? e.doc.proofread_id : null,
        expected_default_revision: null,
      })
    ).document;
    const annotation = await e.app.structureAnnotations!.build({
      document_version_id: doc.document_version_id,
      max_prefix_characters: 128,
    });
    const [a, b] = await Promise.all([
      e.tags.build(e.request),
      e.tags.build({
        literature_id: other,
        document_version_id: doc.document_version_id,
        annotation_id: annotation.annotation_id,
      }),
    ]);
    expect(a.assignment.items[0]!.tag_id).toBe(b.assignment.items[0]!.tag_id);
    expect((await e.tags.list()).total).toBe(1);
    expect(a.created_tags + b.created_tags).toBe(1);
  } finally {
    release();
    await e.close();
  }
}, 30_000);

// Reached 2.8 s under Full (36/12) load, too close to the 5 s default.
it("backfills a new tag using corrected abstract evidence, and can undo a chain of merges without rewinding assignment revisions", async () => {
  const model: TagModel = {
    identity: "c".repeat(64),
    async run(task, input) {
      expect(task).toBe("backfill");
      const v = input as {
        tags: { tag_id: string }[];
        materials: { literature_id: string; assignment: TagAssignment }[];
      };
      return {
        value: {
          decisions: v.materials.map((m) => ({
            literature_id: m.literature_id,
            tag_ids: [
              ...v.tags.map((t) => t.tag_id),
              ...m.assignment.items.map((i) => i.tag_id),
            ],
            reason: "The corrected abstract supports this theme",
          })),
        },
        usage,
      };
    },
  };
  const e = await tagFixture(model);
  try {
    const metadata = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: metadata.metadata_revision,
      set: [
        { field: "abstract", value: "Synthetic photoredox catalysis studies." },
      ],
      unlock: [],
    });
    const first = await e.create("Topic A");
    await e.assign([first]);
    const newer = await e.create("Synthetic");
    const result = await e.tags.backfill([newer], false);
    expect(result).toMatchObject({ updated: 1 });
    const assigned = (await e.tags.assignment(e.id))!;
    expect(assigned.items[0]).toMatchObject({
      tag_id: newer,
      origin: "backfill",
      evidence: [{ document_version_id: e.doc.document_version_id }],
    });
    const second = await e.create("Topic B"),
      third = await e.create("Topic C");
    const mutate = async (mutation: unknown) =>
      e.tags.change({
        mutation,
        expected_version: (await e.tags.state()).version,
        reason: "Synthetic inverse",
      });
    const a = await mutate({ op: "merge", tag_id: first, into: second });
    await mutate({ op: "merge", tag_id: second, into: third });
    await expect(
      mutate({ op: "undo", change_version: a.version, cascade: false }),
    ).rejects.toMatchObject({ code: "tag-undo-dependencies" });
    await mutate({ op: "undo", change_version: a.version, cascade: true });
    const restored = (await e.tags.assignment(e.id))!;
    expect(restored.items.map((i) => i.tag_id)).toEqual([newer, first]);
    expect(restored.revision).toBeGreaterThan(assigned.revision);
  } finally {
    await e.close();
  }
}, 30_000);

// Reached 2.1 s under Full (36/12) load, too close to the 5 s default.
it("consolidates changed tags once and rechecks assigned papers after a definition change with combined usage", async () => {
  const calls: string[] = [];
  let source = "",
    target = "";
  const model: TagModel = {
    identity: "d".repeat(64),
    async run(task, input) {
      calls.push(task);
      if (task === "consolidate")
        return {
          value: {
            operations: [
              {
                mutation: { op: "merge", tag_id: source, into: target },
                reason: "Equivalent theme",
              },
              {
                mutation: {
                  op: "edit-definition",
                  tag_id: target,
                  definition: {
                    includes: "Synthetic catalysis",
                    excludes: "Unrelated themes",
                  },
                },
                reason: "Clarify scope",
              },
            ],
          },
          usage,
        };
      const v = input as {
        materials: { literature_id: string; assignment: TagAssignment }[];
      };
      return {
        value: {
          decisions: v.materials.map((m) => ({
            literature_id: m.literature_id,
            tag_ids: m.assignment.items.map((i) => i.tag_id),
            reason: "Still applicable",
          })),
        },
        usage,
      };
    },
  };
  const e = await tagFixture(model);
  try {
    source = await e.create("Topic one");
    target = await e.create("Topic two");
    await e.assign([source]);
    expect(calls).toEqual([]);
    const result = await e.tags.consolidate();
    expect(calls).toEqual(["consolidate", "backfill"]);
    expect(result.usage).toEqual({
      calls: 2,
      input_tokens: 40,
      output_tokens: 20,
    });
    expect((await e.tags.assignment(e.id))!.items[0]!.tag_id).toBe(target);
  } finally {
    await e.close();
  }
}, 30_000);

// Reached 2.4 s under Full (36/12) load, too close to the 5 s default.
it("rejects model output whose metadata input changed while the model was reading", async () => {
  let edit: () => Promise<void> = async () => {};
  const model: TagModel = {
    identity: "e".repeat(64),
    async run(task, input) {
      if (task === "topics") {
        const v = input as { fragments: { segment_id: string }[] };
        return {
          value: {
            topics: [
              {
                name: "Synthetic",
                reason: "Main topic",
                segment_ids: [v.fragments[0]!.segment_id],
              },
            ],
          },
          usage,
        };
      }
      await edit();
      return {
        value: {
          choices: [
            {
              topic_index: 0,
              tag_id: null,
              create: topicDraft("Synthetic"),
              rejected_candidates: [],
            },
          ],
        },
        usage,
      };
    },
  };
  const e = await tagFixture(model);
  edit = async () => {
    const before = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: before.metadata_revision,
      set: [{ field: "title", value: "A newer manual title" }],
      unlock: [],
    });
  };
  try {
    await expect(e.tags.build(e.request)).rejects.toMatchObject({
      code: "tag-input-stale",
    });
    expect(await e.tags.assignment(e.id)).toBeNull();
  } finally {
    await e.close();
  }
}, 30_000);
