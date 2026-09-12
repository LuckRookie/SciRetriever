import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import {
  readFile,
  unlink,
  writeFile,
  rename,
  symlink,
  link,
  readdir,
  mkdir,
} from "node:fs/promises";
import {
  parseAnalysisInputIdentity,
  parseDurableCandidate,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { setup, proposal, lit } from "./content-fixture.js";

async function prepared() {
  const env = await setup();
  const p = await proposal(await env.app.library.detail(lit));
  await env.app.literatureContent.accept(p.value, p.bytes);
  const d = await env.app.library.detail(lit);
  const result = await env.app.literatureCleanup.cleanup({
    outcome: "no_usable_content",
    input: parseAnalysisInputIdentity({
      literature_id: lit,
      primary_asset_id: d.primary_pdf!.asset.asset_id,
      primary_pdf_sha256: d.primary_pdf!.asset.sha256,
      parser_result_sha256: d.parser_result!.result_sha256,
      input_metadata_revision: d.metadata_revision,
      input_metadata_sha256: d.metadata_sha256,
    }),
  });
  return {
    ...env,
    retired: result.retired_artifacts,
    before: d,
    primary: d.primary_pdf!.asset,
  };
}
it("reclaims retired PDF, Parser and content bytes, preserving metadata and replaying after restart", async () => {
  const env = await prepared();
  let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const result = await env.app.artifactReclaimer.reclaim(env.retired);
    expect(result.deleted).toEqual(env.retired.map((a) => a.reference));
    expect(result.preserved).toEqual([]);
    for (const a of env.retired)
      await expect(
        readFile(join(env.app.files.root, a.reference)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    const after = await env.app.library.detail(lit);
    expect(after.literature.metadata).toEqual(env.before.literature.metadata);
    expect(after.content).toBeNull();
    await env.app.close();
    reopened = await createApplication(env.home);
    expect(await reopened.artifactReclaimer.reclaim(env.retired)).toEqual({
      deleted: [],
      preserved: [],
      missing: result.deleted,
    });
    expect(await reopened.library.detail(lit)).toEqual(after);
  } finally {
    await reopened?.close();
    await env.close();
  }
});
it.each(["verified", "quarantined", "unlinked"] as const)(
  "retries from a durable identity marker after interruption at %s",
  async (stage) => {
    const env = await prepared();
    let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const a = env.retired[0]!;
      await expect(
        env.app.artifactReclaimer.reclaim([a], {
          checkpoint: async (s) => {
            if (s === stage) throw new Error("fixture stop");
          },
        }),
      ).rejects.toMatchObject({ code: "artifact-reclamation" });
      await env.app.close();
      reopened = await createApplication(env.home);
      const result = await reopened.artifactReclaimer.reclaim([a]);
      expect(stage === "unlinked" ? result.missing : result.deleted).toEqual([
        a.reference,
      ]);
      await expect(
        readFile(join(reopened.files.root, a.reference)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await reopened?.close();
      await env.close();
    }
  },
);
it("preserves a descriptor re-registered after catalog cleanup", async () => {
  const env = await prepared();
  try {
    await env.app.database.putAsset(env.primary);
    const a = env.retired.find((a) => a.reference === env.primary.path)!;
    expect(await env.app.artifactReclaimer.reclaim([a])).toEqual({
      deleted: [],
      missing: [],
      preserved: [a.reference],
    });
    expect(
      (await env.app.files.read(a.reference, a.artifact.byte_size)).length,
    ).toBe(a.artifact.byte_size);
  } finally {
    await env.close();
  }
});
it("preserves bytes protected by Candidate identity even when the formal target differs", async () => {
  const env = await prepared();
  try {
    await env.app.database.upgradeExecutionSchema();
    const a = env.retired[0]!;
    await env.app.database.putCandidate(
      parseDurableCandidate({
        transfer_id: "protected",
        state: "durable-ready",
        reference: `.candidates/${a.artifact.sha256}.bin`,
        sha256: a.artifact.sha256,
        size_bytes: a.artifact.byte_size,
        capture: null,
        source_name: "fixture",
        source_record_id: null,
      }),
    );
    expect((await env.app.artifactReclaimer.reclaim([a])).preserved).toEqual([
      a.reference,
    ]);
    const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
    try {
      db.prepare("UPDATE execution_candidates SET record_json=?").run(
        '{"invalid":true}',
      );
    } finally {
      db.close();
    }
    await expect(
      env.app.artifactReclaimer.reclaim(env.retired),
    ).rejects.toMatchObject({ code: "artifact-reclamation" });
    for (const a of env.retired)
      expect(
        (await env.app.files.read(a.reference, a.artifact.byte_size)).length,
      ).toBe(a.artifact.byte_size);
  } finally {
    await env.close();
  }
});
it.each(["hash", "symlink", "hardlink"])(
  "rejects %s corruption without removing the replacement",
  async (kind) => {
    const env = await prepared();
    try {
      const a = env.retired[0]!,
        path = join(env.app.files.root, a.reference),
        saved = `${path}.saved`;
      const bytes = await readFile(path);
      if (kind === "hash")
        await writeFile(path, Buffer.alloc(bytes.length, 88));
      else {
        await rename(path, saved);
        if (kind === "symlink") await symlink(saved, path);
        else await link(saved, path);
      }
      await expect(
        env.app.artifactReclaimer.reclaim([a]),
      ).rejects.toMatchObject({ code: "artifact-reclamation" });
      expect(await readFile(path)).toEqual(
        kind === "hash" ? Buffer.alloc(bytes.length, 88) : bytes,
      );
    } finally {
      await env.close();
    }
  },
);
it("quarantines a replacement that wins before rename and preserves its evidence", async () => {
  const env = await prepared();
  try {
    const a = env.retired[0]!,
      path = join(env.app.files.root, a.reference),
      bytes = await readFile(path);
    await expect(
      env.app.artifactReclaimer.reclaim([a], {
        checkpoint: async (s) => {
          if (s === "verified") {
            await rename(path, `${path}.saved`);
            await writeFile(path, Buffer.alloc(bytes.length, 89));
          }
        },
      }),
    ).rejects.toMatchObject({ code: "artifact-reclamation" });
    const names = await readdir(dirname(path));
    const q = names.find((n) => n.startsWith(".reclaim-"))!;
    expect(await readFile(join(dirname(path), q, "object"))).toEqual(
      Buffer.alloc(bytes.length, 89),
    );
    expect(await readFile(`${path}.saved`)).toEqual(bytes);
    await expect(env.app.artifactReclaimer.reclaim([a])).rejects.toMatchObject({
      code: "artifact-reclamation",
    });
  } finally {
    await env.close();
  }
});
it("leaves a new original name intact after the verified file has moved", async () => {
  const env = await prepared();
  try {
    const a = env.retired[0]!,
      path = join(env.app.files.root, a.reference);
    expect(
      (
        await env.app.artifactReclaimer.reclaim([a], {
          checkpoint: async (s) => {
            if (s === "quarantined") await writeFile(path, "replacement");
          },
        })
      ).deleted,
    ).toEqual([a.reference]);
    expect(await readFile(path, "utf8")).toBe("replacement");
    await expect(env.app.artifactReclaimer.reclaim([a])).rejects.toMatchObject({
      code: "artifact-reclamation",
    });
    expect(await readFile(path, "utf8")).toBe("replacement");
  } finally {
    await env.close();
  }
});
it("rejects a parent replacement before rename and preserves both directories", async () => {
  const env = await prepared();
  try {
    const a = env.retired[0]!,
      parent = dirname(join(env.app.files.root, a.reference));
    await expect(
      env.app.artifactReclaimer.reclaim([a], {
        checkpoint: async (s) => {
          if (s === "verified") {
            await rename(parent, `${parent}.saved`);
            await mkdir(parent);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "artifact-reclamation" });
    expect(
      (await readFile(join(`${parent}.saved`, a.reference.split("/").at(-1)!)))
        .length,
    ).toBe(a.artifact.byte_size);
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await env.close();
  }
});
it("cancels before mutation and rejects references outside the managed object namespaces", async () => {
  const env = await prepared();
  try {
    await expect(
      env.app.artifactReclaimer.reclaim(env.retired, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "write-admission-cancelled" });
    await expect(
      env.app.artifactReclaimer.reclaim([
        { ...env.retired[0]!, reference: "../config.toml" },
      ]),
    ).rejects.toMatchObject({ code: "artifact-reclamation" });
    await expect(
      env.app.artifactReclaimer.reclaim([
        { ...env.retired[0]!, reference: "config.toml" },
      ]),
    ).rejects.toMatchObject({ code: "artifact-reclamation" });
    for (const a of env.retired)
      expect(
        (await env.app.files.read(a.reference, a.artifact.byte_size)).length,
      ).toBe(a.artifact.byte_size);
  } finally {
    await env.close();
  }
});
it("preserves a pending receipt target even when its incoming hash differs", async () => {
  const env = await prepared();
  try {
    await env.app.database.upgradeExecutionSchema();
    const a = env.retired[0]!;
    const candidate = parseDurableCandidate({
      transfer_id: "receipt-protected",
      state: "durable-ready",
      reference: `.candidates/${"1".repeat(64)}.bin`,
      sha256: "1".repeat(64),
      size_bytes: 10,
      capture: null,
      source_name: "fixture",
      source_record_id: null,
    });
    await env.app.database.putCandidate(candidate);
    await env.app.database.prepareReceipt({
      metadata_snapshot: {
        revision: env.before.metadata_revision,
        sha256: env.before.metadata_sha256,
      },
      receipt_id: "pending",
      candidate,
      literature_id: lit,
      asset_id: env.primary.asset_id,
      literature_asset_id:
        env.before.primary_pdf!.literature_asset.literature_asset_id,
      target: a.reference,
      provenance: env.before.primary_pdf!.literature_asset.provenance,
      source_url: null,
      identity: "accepted",
    });
    expect((await env.app.artifactReclaimer.reclaim([a])).preserved).toEqual([
      a.reference,
    ]);
    const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
    try {
      db.prepare("UPDATE execution_receipts SET result_json=?").run(
        '{"invalid":true}',
      );
    } finally {
      db.close();
    }
    await expect(env.app.artifactReclaimer.reclaim([a])).rejects.toMatchObject({
      code: "artifact-reclamation",
    });
    expect((await readFile(join(env.app.files.root, a.reference))).length).toBe(
      a.artifact.byte_size,
    );
  } finally {
    await env.close();
  }
});
it("waits for an admitted publication to register its file before deciding reclamation", async () => {
  const env = await prepared();
  let resume: () => void = () => {},
    entered: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    resume = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  try {
    const a = env.retired.find((a) => a.reference === env.primary.path)!;
    const publishing = env.app.writes.run(async () => {
      entered();
      await waiting;
      await env.app.database.putAsset(env.primary);
    });
    await started;
    let finished = false;
    const reclaiming = env.app.artifactReclaimer.reclaim([a]).then((r) => {
      finished = true;
      return r;
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(finished).toBe(false);
    resume();
    await publishing;
    expect((await reclaiming).preserved).toEqual([a.reference]);
    expect((await readFile(join(env.app.files.root, a.reference))).length).toBe(
      a.artifact.byte_size,
    );
  } finally {
    resume();
    await env.close();
  }
});
it("rejects replacement of the quarantine directory before unlink", async () => {
  const env = await prepared();
  try {
    const a = env.retired[0]!,
      parent = dirname(join(env.app.files.root, a.reference));
    let saved = "";
    await expect(
      env.app.artifactReclaimer.reclaim([a], {
        checkpoint: async (s) => {
          if (s === "quarantined") {
            const name = (await readdir(parent)).find((n) =>
              n.startsWith(".reclaim-"),
            )!;
            const path = join(parent, name);
            saved = `${path}.saved`;
            await rename(path, saved);
            await mkdir(path);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "artifact-reclamation" });
    expect((await readFile(join(saved, "object"))).length).toBe(
      a.artifact.byte_size,
    );
  } finally {
    await env.close();
  }
});
it("finishes a retry when only an empty quarantine directory remains after marker removal", async () => {
  const env = await prepared();
  try {
    const a = env.retired[0]!,
      parent = dirname(join(env.app.files.root, a.reference));
    await expect(
      env.app.artifactReclaimer.reclaim([a], {
        checkpoint: async (s) => {
          if (s === "unlinked") throw new Error("fixture interruption");
        },
      }),
    ).rejects.toMatchObject({ code: "artifact-reclamation" });
    const q = join(
      parent,
      (await readdir(parent)).find((n) => n.startsWith(".reclaim-"))!,
    );
    await unlink(join(q, "identity.json"));
    expect((await env.app.artifactReclaimer.reclaim([a])).missing).toEqual([
      a.reference,
    ]);
    await expect(readdir(q)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await env.close();
  }
});
