import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { ArtifactRecovery } from "../src/storage/files/recovery.js";
import {
  CatalogWriteAdmission,
  acquireCatalogWriteLock,
} from "../src/storage/write-admission.js";
import { lit, reclamationFixture } from "./reclamation-fixture.js";
const prepared = () => reclamationFixture(true);
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
      const ticket = await env.app.artifactRecovery.prepare(env.artifacts);
      if (point !== "before-commit") await env.unregister();
      if (point === "partial-reclamation")
        await expect(
          env.app.artifactReclaimer.reclaim(env.artifacts, {
            checkpoint: async (stage) => {
              if (stage === "unlinked") throw new Error("fixture process stop");
            },
          }),
        ).rejects.toThrow();
      if (point === "after-reclamation")
        await env.app.artifactReclaimer.reclaim(env.artifacts);
      expect(ticket.artifacts).toEqual(env.artifacts);
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
        expect((await reopened.library.detail(lit)).primary_pdf).toEqual(
          env.before.primary_pdf,
        );
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
    await env.app.artifactRecovery.prepare(env.artifacts);
    await env.unregister();
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
    const {DatabaseSync}=await import("node:sqlite");
    const values=JSON.parse(process.argv[3]);
    await app.artifactRecovery.prepare(values);
    if(process.argv[4]==="true")await app.writes.run(async()=>{const db=new DatabaseSync(app.configuration.paths.catalog_path ?? process.argv[2]+"/catalog.sqlite");try{db.exec("PRAGMA foreign_keys=ON;BEGIN IMMEDIATE");for(const a of values){db.prepare("DELETE FROM assets WHERE relative_path=?").run(a.reference);db.prepare("DELETE FROM artifact_objects WHERE relative_path=?").run(a.reference);}db.exec("COMMIT");}finally{db.close();}});
    process.stdout.write("boundary\\n");
    await new Promise(()=>{});
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
        JSON.stringify(env.artifacts),
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
      expect((await reopened.library.detail(lit)).primary_pdf).toEqual(
        env.before.primary_pdf,
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
