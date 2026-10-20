import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { TagDraft, VocabularyMutation } from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
const draft = (name: string, parent_id: string | null = null): TagDraft => ({
  name_zh: "",
  name_en: name,
  aliases: [],
  definition: { includes: name, excludes: "" },
  kind: "topic",
  parent_id,
  category: null,
});
it("serializes vocabulary names, validates hierarchy and locks, and reverses dependent edits without losing aliases", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-tags-"));
  const app = await createApplication(home, {
    browserHost: () => null,
    metadata: {},
  });
  const tags = app.tags;
  const change = async (
    mutation: VocabularyMutation,
    actor: "manual" | "consolidation" = "manual",
  ) =>
    tags.change(
      {
        mutation,
        reason: "Synthetic change",
        expected_version: (await tags.state()).version,
      },
      actor,
    );
  try {
    const a = await change({ op: "create", tag: draft("Catalysis") }),
      id = a.inverse[0]!.tag_id;
    await expect(
      change({ op: "create", tag: draft(" CATALYSIS ") }),
    ).rejects.toMatchObject({ code: "tag-name-conflict" });
    expect(
      (await tags.list({ query: "catalysis" })).items.map((t) => t.tag_id),
    ).toEqual([id]);
    const b = await change({ op: "create", tag: draft("Photoredox", id) }),
      child = b.inverse[0]!.tag_id;
    await expect(
      change({ op: "create", tag: draft("Third level", child) }),
    ).rejects.toMatchObject({ code: "tag-hierarchy-invalid" });
    const renamed = await change({
      op: "rename",
      tag_id: child,
      name_en: "Photocatalysis",
      name_zh: "",
      aliases: ["Photoredox"],
    });
    await expect(
      change({ op: "undo", change_version: b.version, cascade: false }),
    ).rejects.toMatchObject({
      code: "tag-undo-dependencies",
      details: { versions: [renamed.version] },
    });
    await change({ op: "undo", change_version: b.version, cascade: true });
    expect(await tags.get(child)).toBeNull();
    const c = await change({ op: "create", tag: draft("Another topic") }),
      other = c.inverse[0]!.tag_id;
    await change({ op: "set-lock", tag_id: other, locked: true });
    expect(
      (await change({ op: "merge", tag_id: other, into: id }, "consolidation"))
        .outcome,
    ).toBe("skipped-locked");
    await change({ op: "set-lock", tag_id: other, locked: false });
    const merged = await change({ op: "merge", tag_id: other, into: id });
    expect(await tags.resolve(["Another topic", other])).toEqual([id]);
    await change({
      op: "undo",
      change_version: merged.version,
      cascade: false,
    });
    expect(await tags.resolve(["Another topic"])).toEqual([other]);
    const query = await createQueryApplication(home);
    try {
      expect((await query.tags!.list()).total).toBe(2);
      await expect(
        query.tags!.change({
          mutation: { op: "create", tag: draft("Forbidden") },
          reason: "Read-only",
          expected_version: (await tags.state()).version,
        }),
      ).rejects.toMatchObject({ code: "tag-read-only" });
    } finally {
      await query.close();
    }
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
