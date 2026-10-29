import { runCli } from "../src/cli/main.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parseLiterature, type SnapshotMember } from "@sciretriever/contracts";
import {
  archiveFixture,
  moveIntroductionToMethods,
} from "./archive-fixture.js";
// Reached 2.8 s under Full (36/12) load, too close to the 5 s default.
it("freezes ready members, reports exclusions and separates content from description differences", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    const missing = randomUUID(),
      other = randomUUID(),
      current = (await e.app.library.detail(e.id)).literature;
    await e.app.database.putLiterature(
      parseLiterature({
        ...current,
        literature_id: other,
        meta_literature_id: randomUUID(),
        metadata: { ...current.metadata, identifiers: [] },
      }),
    );
    const first = await e.app.snapshots.create({
      kind: "literatures",
      literature_ids: [missing, other, e.id],
    });
    expect(first).toMatchObject({ member_count: 1, excluded_count: 2 });
    expect(first.excluded.map((x) => x.reason).sort()).toEqual([
      "UNREVIEWED",
      "not-found",
    ]);
    const before = await e.app.snapshots.all(first.snapshot_id);
    expect(before.members[0]!.parts[0]!.content_version).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const meta = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: meta.metadata_revision,
      set: [{ field: "title", value: "An updated synthetic title" }],
      unlock: [],
    });
    const second = await e.app.snapshots.create({
      kind: "literatures",
      literature_ids: [e.id],
    });
    expect(
      await e.app.snapshots.diff({
        before: first.snapshot_id,
        after: second.snapshot_id,
      }),
    ).toEqual({
      added: [],
      removed: [],
      content_changed: [],
      description_changed: [e.id],
    });
    expect((await e.app.snapshots.all(first.snapshot_id)).members).toEqual(
      before.members,
    );
    // Flow X (06ca0af) derives section roles from the arrangement; the v1
    // annotation role edit is retired, so move the introduction text there.
    await moveIntroductionToMethods(e, "snapshot-fixture");
    const third = await e.app.snapshots.create({
      kind: "literatures",
      literature_ids: [e.id],
    });
    expect(
      await e.app.snapshots.diff({
        before: second.snapshot_id,
        after: third.snapshot_id,
      }),
    ).toMatchObject({ content_changed: [e.id], description_changed: [] });
    expect(
      (
        await e.app.snapshots.read({
          snapshot_id: first.snapshot_id,
          offset: 0,
          limit: 1,
          max_bytes: 262144,
        })
      ).next_offset,
    ).toBeNull();
    expect(
      (await e.app.snapshots.list({ after: null, limit: 2 })).items,
    ).toHaveLength(2);
  } finally {
    await e.close();
  }
}, 30_000);
// Reached 2.2 s under Full (36/12) load, too close to the 5 s default.
it("rejects a changed publication input and leaves no partial snapshot", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    const captured = await e.app.database.snapshot<{
      members: SnapshotMember[];
    }>("capture", { ids: [e.id] });
    const meta = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: meta.metadata_revision,
      set: [{ field: "title", value: "A newer title" }],
      unlock: [],
    });
    await expect(
      e.app.database.snapshot("publish", {
        snapshot_id: randomUUID(),
        definition: { kind: "literatures", literature_ids: [e.id] },
        created_at: new Date().toISOString(),
        members: captured.members,
        content_sha256: "0".repeat(64),
        excluded_count: 0,
      }),
    ).rejects.toMatchObject({ code: "snapshot-input-changed" });
    expect(
      (await e.app.snapshots.list({ after: null, limit: 10 })).items,
    ).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
}, 30_000);

it("serves bounded pages through the shared query boundary and CLI without models", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    const snapshot = await e.app.snapshots.create({
        kind: "literatures",
        literature_ids: [e.id],
      }),
      calls = e.modelCalls;
    const q = await createQueryApplication(e.home);
    try {
      expect(
        await executeQuery(q, "snapshots", {
          operation: "read",
          request: {
            snapshot_id: snapshot.snapshot_id,
            offset: 0,
            limit: 1,
            max_bytes: 262144,
          },
        }),
      ).toMatchObject({
        snapshot_id: snapshot.snapshot_id,
        member_count: 1,
        next_offset: null,
      });
    } finally {
      await q.close();
    }
    let output = "";
    expect(
      await runCli(["snapshot", "show", snapshot.snapshot_id], {
        home: e.home,
        stdout: (text) => {
          output += text;
        },
      }),
    ).toMatchObject({ code: 0 });
    expect(JSON.parse(output).members).toHaveLength(1);
    expect(e.modelCalls).toBe(calls);
    await expect(
      e.app.snapshots.read({
        snapshot_id: snapshot.snapshot_id,
        offset: 0,
        limit: 1,
        max_bytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "snapshot-member-budget" });
  } finally {
    await e.close();
  }
}, 0);
