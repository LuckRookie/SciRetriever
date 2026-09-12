import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  readFile,
  readdir,
  writeFile,
  rename,
  symlink,
  link,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseAnalysisInputIdentity } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { ArtifactRecovery } from "../src/storage/files/recovery.js";
import {
  CatalogWriteAdmission,
  acquireCatalogWriteLock,
} from "../src/storage/write-admission.js";
import { setup, lit } from "./content-fixture.js";
async function prepared() {
  const env = await setup();
  const before = await env.app.library.detail(lit),
    primary = before.primary_pdf!.asset;
  const decision = {
    outcome: "no_usable_content",
    input: parseAnalysisInputIdentity({
      literature_id: lit,
      primary_asset_id: primary.asset_id,
      primary_pdf_sha256: primary.sha256,
      parser_result_sha256: before.parser_result!.result_sha256,
      input_metadata_revision: before.metadata_revision,
      input_metadata_sha256: before.metadata_sha256,
    }),
  };
  const snapshot = await env.app.database.contentCleanupSnapshot(lit);
  return {
    ...env,
    before,
    primary,
    decision,
    artifacts: snapshot!.artifacts,
    journal: join(env.app.files.root, ".reclamation"),
  };
}
it.each([
  "before-commit",
  "after-commit",
  "partial-reclamation",
  "after-reclamation",
] as const)(
  "automatically recovers a stopped cleanup at %s without caller-retained descriptors",
  async (point) => {
    const env = await prepared();
    let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const commit = env.app.database.cleanupNoUsableContent.bind(
        env.app.database,
      );
      const reclaim = env.app.artifactReclaimer.reclaim.bind(
        env.app.artifactReclaimer,
      );
      if (point === "before-commit" || point === "after-commit")
        env.app.database.cleanupNoUsableContent = async (command) => {
          if (point === "after-commit") await commit(command);
          throw new Error("fixture process stop");
        };
      else
        env.app.artifactReclaimer.reclaim = async (values) => {
          if (point === "partial-reclamation")
            await reclaim(values, {
              checkpoint: async (stage) => {
                if (stage === "unlinked")
                  throw new Error("fixture process stop");
              },
            });
          else await reclaim(values);
          throw new Error("fixture process stop");
        };
      await expect(
        env.app.noUsableContent.cleanup(env.decision),
      ).rejects.toBeInstanceOf(Error);
      expect(await readdir(env.journal)).toHaveLength(1);
      const bytes = await readFile(
        join(env.journal, (await readdir(env.journal))[0]!),
        "utf8",
      );
      const manifest = JSON.parse(bytes) as Record<string, unknown>;
      expect(Object.keys(manifest).sort()).toEqual([
        "artifacts",
        "catalog_key",
        "version",
      ]);
      expect(bytes).not.toContain(lit);
      expect(bytes).not.toContain("no_usable_content");
      expect(bytes).not.toContain("https:");
      await env.app.close();
      reopened = await createApplication(env.home);
      expect(await readdir(env.journal)).toEqual([]);
      if (point === "before-commit") {
        expect(await reopened.library.detail(lit)).toEqual(env.before);
        for (const a of env.artifacts)
          expect(
            (await reopened.files.read(a.reference, a.artifact.byte_size))
              .length,
          ).toBe(a.artifact.byte_size);
      } else {
        expect((await reopened.library.detail(lit)).primary_pdf).toBeNull();
        for (const a of env.artifacts)
          await expect(
            readFile(join(reopened.files.root, a.reference)),
          ).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await reopened.artifactRecovery.recover()).toEqual([]);
    } finally {
      await reopened?.close();
      await env.close();
    }
  },
);
it("rechecks current registration during recovery and preserves a newly registered file", async () => {
  const env = await prepared();
  let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    env.app.artifactReclaimer.reclaim = async () => {
      throw new Error("fixture process stop");
    };
    await expect(
      env.app.noUsableContent.cleanup(env.decision),
    ).rejects.toMatchObject({ code: "no-usable-content-reclamation" });
    await env.app.database.putAsset(env.primary);
    await env.app.close();
    reopened = await createApplication(env.home);
    expect(
      (await reopened.files.read(env.primary.path, env.primary.size_bytes))
        .length,
    ).toBe(env.primary.size_bytes);
    expect(await reopened.database.getAsset(env.primary.asset_id)).toEqual(
      env.primary,
    );
    expect(await readdir(env.journal)).toEqual([]);
  } finally {
    await reopened?.close();
    await env.close();
  }
});
it.each(["corrupt", "symlink", "hardlink"])(
  "fails closed on a %s manifest and releases application resources",
  async (kind) => {
    const env = await prepared();
    try {
      const ticket = await env.app.artifactRecovery.prepare(env.artifacts);
      const path = join(env.app.files.root, ticket.reference),
        saved = join(env.home, "saved-manifest.json");
      const bytes = await readFile(path);
      if (kind === "corrupt") await writeFile(path, "incomplete");
      else {
        await rename(path, saved);
        if (kind === "symlink") await symlink(saved, path);
        else await link(saved, path);
      }
      await env.app.close();
      await expect(createApplication(env.home)).rejects.toMatchObject({
        code: "artifact-recovery",
      });
      const lock = await acquireCatalogWriteLock(
        join(env.home, "catalog.sqlite"),
      );
      await lock.release();
      expect(await readFile(path)).toEqual(
        kind === "corrupt" ? Buffer.from("incomplete") : bytes,
      );
      for (const a of env.artifacts)
        expect(
          (await readFile(join(env.app.files.root, a.reference))).length,
        ).toBe(a.artifact.byte_size);
    } finally {
      await env.close();
    }
  },
);
it("rejects a validly hashed manifest containing a traversal path", async () => {
  const env = await prepared();
  try {
    const ticket = await env.app.artifactRecovery.prepare(env.artifacts);
    const raw = JSON.parse(
      await readFile(join(env.app.files.root, ticket.reference), "utf8"),
    ) as { artifacts: unknown[] };
    raw.artifacts = [{ ...env.artifacts[0]!, reference: "../outside.bin" }];
    const bytes = Buffer.from(JSON.stringify(raw)),
      hash = createHash("sha256").update(bytes).digest("hex");
    const malicious = join(env.journal, `${hash}.json`);
    await writeFile(malicious, bytes);
    await expect(env.app.artifactRecovery.recover()).rejects.toMatchObject({
      code: "artifact-recovery",
    });
    expect(await readFile(malicious)).toEqual(bytes);
    for (const a of env.artifacts)
      expect(
        (await env.app.files.read(a.reference, a.artifact.byte_size)).length,
      ).toBe(a.artifact.byte_size);
  } finally {
    await env.close();
  }
});
it("rejects recovery through a different catalog and leaves the original manifest intact", async () => {
  const env = await prepared(),
    other = new CatalogWriteAdmission(join(env.home, "other.sqlite"));
  try {
    const ticket = await env.app.artifactRecovery.prepare(env.artifacts);
    await expect(
      new ArtifactRecovery(
        env.app.files,
        env.app.artifactReclaimer,
        other,
      ).recover(),
    ).rejects.toMatchObject({ code: "artifact-recovery" });
    expect(await readdir(env.journal)).toEqual([
      ticket.reference.split("/").at(-1),
    ]);
    await env.app.artifactRecovery.complete(ticket);
    expect(await readdir(env.journal)).toEqual([]);
  } finally {
    await other.close();
    await env.close();
  }
});
it.each([false, true])(
  "recovers after SIGKILL with catalog commit=%s using only on-disk evidence",
  async (committed) => {
    const env = await prepared();
    let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
    const source = `
    const {createApplication}=await import(process.argv[1]);
    const app=await createApplication(process.argv[2]);
    const commit=app.database.cleanupNoUsableContent.bind(app.database);
    app.database.cleanupNoUsableContent=async command=>{
      if(process.argv[4]==="true")await commit(command);
      process.stdout.write("boundary\\n");
      await new Promise(()=>{});
    };
    await app.noUsableContent.cleanup(JSON.parse(process.argv[3]));
  `;
    await env.app.close();
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        source,
        pathToFileURL(resolve("apps/server/dist/bootstrap/application.js"))
          .href,
        env.home,
        JSON.stringify(env.decision),
        String(committed),
      ],
      {
        env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((res, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => res({ code, signal }));
    });
    try {
      await new Promise<void>((res, reject) => {
        const timer = setTimeout(
          () => reject(new Error("fixture boundary timeout")),
          10000,
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("boundary")) {
            clearTimeout(timer);
            res();
          }
        });
        void exited.then(() => {
          clearTimeout(timer);
          reject(new Error("fixture exited before boundary"));
        }, reject);
      });
      expect(await readdir(env.journal)).toHaveLength(1);
      child.kill("SIGKILL");
      expect((await exited).signal).toBe("SIGKILL");
      reopened = await createApplication(env.home);
      expect(await readdir(env.journal)).toEqual([]);
      expect((await reopened.library.detail(lit)).primary_pdf === null).toBe(
        committed,
      );
      for (const a of env.artifacts) {
        const reading = readFile(join(reopened.files.root, a.reference));
        if (committed)
          await expect(reading).rejects.toMatchObject({ code: "ENOENT" });
        else expect((await reading).length).toBe(a.artifact.byte_size);
      }
    } finally {
      child.kill("SIGKILL");
      await exited;
      await reopened?.close();
      await env.close();
    }
  },
);
