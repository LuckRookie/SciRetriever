import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  parseLibraryFacets,
  parseLiterature,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { startIntake, finishIntake } from "../src/literature/intake.js";
import { facetTag, facetAssignments } from "./library-facets-fixture.js";

it("counts direct active tags and complete layer coverage over whole and filtered scopes, with bounded keyword alias links", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-library-facets-"));
  const app = await createApplication(home, {
    browserHost: () => null,
    metadata: {},
    indexRefreshIntervalMs: null,
  });
  try {
    const empty = {
      total: 0,
      coverage: { tags: 0, keywords: 0, subject_terms: 0 },
      tags: [],
      keywords: [],
      subject_terms: [],
    };
    expect(
      parseLibraryFacets(await app.library.facets({ query: {}, limit: 30 })),
    ).toEqual(empty);
    const papers = [
      ["Scope A", ["Energy", "energy", "ＡＩ"], ["Physics", "Materials"]],
      ["Scope B", ["AI", "Unmapped"], ["physics"]],
      ["Other C", ["Artificial   intelligence"], []],
      ["Scope D", [], ["Biology"]],
      ["Other E", ["Retired"], ["Biology"]],
      ["Empty F", [], []],
    ].map(([title, keywords, subject_terms]) =>
      parseLiterature({
        literature_id: randomUUID(),
        meta_literature_id: randomUUID(),
        version_role: "published",
        status: "UNREVIEWED",
        metadata: { ...EMPTY_METADATA, title, keywords, subject_terms },
      }),
    );
    for (const paper of papers) await app.database.putLiterature(paper);
    const energy = await facetTag(app, "Energy", { name_zh: "能量" });
    const ai = await facetTag(app, "AI", {
      aliases: ["Artificial intelligence"],
    });
    const parent = await facetTag(app, "Parent");
    const child = await facetTag(app, "Leaf", { parent_id: parent });
    const retired = await facetTag(app, "Retired");
    facetAssignments(
      home,
      [
        { literature_id: papers[0]!.literature_id, tag_ids: [energy, ai] },
        { literature_id: papers[1]!.literature_id, tag_ids: [ai] },
        { literature_id: papers[2]!.literature_id, tag_ids: [child] },
        { literature_id: papers[3]!.literature_id, tag_ids: [parent] },
        { literature_id: papers[4]!.literature_id, tag_ids: [retired] },
      ],
      { tag_id: retired, into: ai },
    );
    const read = async (query: unknown, limit = 30) =>
      parseLibraryFacets(await app.library.facets({ query, limit }));
    const all = await read({});
    expect(all.total).toBe(6);
    expect(all.coverage).toEqual({ tags: 5, keywords: 4, subject_terms: 4 });
    expect(all.tags).toEqual([
      { tag_id: ai, value: "AI", count: 2 },
      { tag_id: child, value: "Leaf", count: 1 },
      { tag_id: parent, value: "Parent", count: 1 },
      { tag_id: energy, value: "能量", count: 1 },
    ]);
    expect(all.keywords).toContainEqual({
      value: "Energy",
      count: 1,
      tag: { tag_id: energy, name: "能量" },
    });
    expect(all.keywords).toContainEqual({
      value: "AI",
      count: 1,
      tag: { tag_id: ai, name: "AI" },
    });
    expect(all.keywords).toContainEqual({
      value: "ＡＩ",
      count: 1,
      tag: { tag_id: ai, name: "AI" },
    });
    expect(all.keywords).toContainEqual({
      value: "Artificial   intelligence",
      count: 1,
      tag: { tag_id: ai, name: "AI" },
    });
    expect(all.keywords).toContainEqual({
      value: "Retired",
      count: 1,
      tag: null,
    });
    expect(all.keywords).toContainEqual({
      value: "Unmapped",
      count: 1,
      tag: null,
    });
    const short = await read({}, 1);
    expect(short.coverage).toEqual(all.coverage);
    expect(short.tags).toEqual(all.tags.slice(0, 1));
    expect(short.keywords).toEqual(all.keywords.slice(0, 1));
    expect(short.subject_terms).toEqual(all.subject_terms.slice(0, 1));
    // Leaves are directly usable filters. Parent/child filtering is deliberately unchanged.
    for (const tag of all.tags.filter((t) => t.tag_id !== parent)) {
      const filtered = await read({ tags: { ids: [tag.tag_id], mode: "any" } });
      expect(filtered.total).toBe(tag.count);
    }
    expect((await read({ tags: { ids: [parent], mode: "any" } })).total).toBe(
      2,
    );
    const partial = await read({ title: "Scope" });
    expect(partial.total).toBe(3);
    expect(partial.coverage).toEqual({
      tags: 3,
      keywords: 2,
      subject_terms: 3,
    });
    expect(partial.tags.map((t) => [t.value, t.count])).toEqual([
      ["AI", 2],
      ["Parent", 1],
      ["能量", 1],
    ]);
    expect(await read({ text: "Scope" })).toEqual(partial);
    expect((await read({ title: "Scope" }, 1)).coverage).toEqual(
      partial.coverage,
    );
    expect((await read({ title: "Other C" })).keywords[0]?.tag).toEqual({
      tag_id: ai,
      name: "AI",
    });
    expect((await read({ subject_terms: ["biology"] })).coverage).toEqual({
      tags: 2,
      keywords: 1,
      subject_terms: 2,
    });
    expect(await read({ title: "does not exist" })).toEqual(empty);
    expect(await read({ text: "!!!" })).toEqual(empty);
    const batch = await startIntake(
      app.database,
      "topic",
      "All",
      { query: "All" },
      "cli",
    );
    for (const paper of papers)
      await app.database.writeIntake({
        operation: "member",
        member: {
          batch_id: batch,
          literature_id: paper.literature_id,
          disposition: "matched",
        },
      });
    await finishIntake(app.database, batch, "completed");
    expect(await read({ intake_batch_ids: [batch] })).toEqual(all);
    await app.tags.change({
      mutation: {
        op: "rename",
        tag_id: ai,
        name_zh: "人工智能",
        name_en: "AI",
        aliases: ["Artificial intelligence"],
      },
      expected_version: (await app.tags.state()).version,
      reason: "Synthetic rename",
    });
    const renamed = await read({ title: "Scope" });
    expect(renamed.tags).toContainEqual({
      tag_id: ai,
      value: "人工智能",
      count: 2,
    });
    expect(renamed.keywords.find((k) => k.value === "AI")?.tag).toEqual({
      tag_id: ai,
      name: "人工智能",
    });
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
