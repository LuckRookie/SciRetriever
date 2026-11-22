import { mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { AsyncResource } from "node:async_hooks";
import { expect, it } from "vitest";
import { reclamationFixture as setup } from "./reclamation-fixture.js";
import { createApplication } from "../src/bootstrap/application.js";
import {
  acquireCatalogWriteLock,
  CatalogWriteAdmission,
} from "../src/storage/write-admission.js";
async function probe(path: string) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
const catalog = process.argv[1];
const hash = createHash("sha256").update(catalog).digest("hex");
const sidecar = join(dirname(catalog), ".sciretriever-locks", "catalog-" + hash + ".lock");
const handle = await open(sidecar, constants.O_RDWR | constants.O_NOFOLLOW);
const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd], env: { PATH: "/usr/bin:/bin" } });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
await handle.close();
console.log(code === 0 ? "acquired" : code === 75 ? "conflict" : "error");`,
      path,
    ],
    { env: { PATH: "/usr/bin:/bin" } },
  );
  return stdout.trim();
}
it("holds an OS lock after flock exits and shares the exact sidecar contract across Node processes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-lock-")),
    path = join(home, "catalog.sqlite");
  let lock: Awaited<ReturnType<typeof acquireCatalogWriteLock>> | undefined;
  try {
    lock = await acquireCatalogWriteLock(path);
    await expect(acquireCatalogWriteLock(path)).rejects.toMatchObject({
      code: "write-admission-conflict",
    });
    expect(await probe(path)).toBe("conflict");
    await lock.release();
    await lock.release();
    lock = undefined;
    expect(await probe(path)).toBe("acquired");
    lock = await acquireCatalogWriteLock(path);
  } finally {
    await lock?.release();
    await rm(home, { recursive: true, force: true });
  }
});
it("serializes sibling operations, allows scoped nesting, and rejects an escaped asynchronous context", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-lock-"));
  const admission = new CatalogWriteAdmission(join(home, "catalog.sqlite"));
  let release: () => void = () => {},
    started: () => void = () => {},
    escaped: () => Promise<void> = async () => {};
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const events: string[] = [];
  let late: Promise<unknown> = Promise.resolve();
  try {
    const first = admission.run(async () => {
      events.push("first");
      await admission.run(async () => {
        events.push("nested");
      });
      late = new Promise<void>((resolve, reject) => {
        escaped = AsyncResource.bind(async () => {
          try {
            await admission.run(async () => {});
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      started();
      await waiting;
      events.push("first-end");
    });
    await entered;
    const second = admission.run(async () => {
      events.push("second");
    });
    expect(events).toEqual(["first", "nested"]);
    release();
    await first;
    await second;
    expect(events).toEqual(["first", "nested", "first-end", "second"]);
    const expired = expect(late).rejects.toMatchObject({
      code: "write-admission-expired",
    });
    await escaped();
    await expired;
    await admission.run(async () => {});
    await admission.close();
    await expect(admission.run(async () => {})).rejects.toMatchObject({
      code: "write-admission-closed",
    });
  } finally {
    release();
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("leaves the next admission to a waiting foreground writer", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-lock-"));
  const admission = new CatalogWriteAdmission(join(home, "catalog.sqlite"));
  let start: () => void = () => {};
  let finish: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    start = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const write = admission.run(async () => {
    start();
    await waiting;
  });
  const backfill = async () => calls.push("backfill");
  try {
    await Promise.race([entered, write]);
    const background = admission.runWhenIdle(backfill);
    expect(admission.hasQueuedWrites).toBe(false);
    const foreground = admission.run(async () => calls.push("foreground"));
    expect(admission.hasQueuedWrites).toBe(true);
    await expect(admission.runWhenIdle(backfill)).resolves.toBeUndefined();
    finish();
    await write;
    await expect(background).resolves.toBeUndefined();
    await foreground;
    expect(calls).toEqual(["foreground"]);
    await admission.runWhenIdle(backfill);
    expect(calls).toEqual(["foreground", "backfill"]);

    const acquiring = admission.runWhenIdle(backfill);
    // Let the background attempt start the asynchronous lock acquisition.
    await Promise.resolve();
    await admission.run(async () => calls.push("arrived-during-acquisition"));
    await expect(acquiring).resolves.toBeUndefined();
    expect(calls).toEqual([
      "foreground",
      "backfill",
      "arrived-during-acquisition",
    ]);

    const interrupted = new AbortController();
    const backgroundForCancelledWriter = admission.runWhenIdle(backfill);
    await Promise.resolve();
    const writer = admission.run(
      async () => calls.push("cancelled"),
      interrupted.signal,
    );
    interrupted.abort();
    await expect(writer).rejects.toMatchObject({
      code: "write-admission-cancelled",
    });
    await expect(backgroundForCancelledWriter).resolves.toBeUndefined();
    await admission.run(async () => calls.push("after-cancellation"));
    expect(calls.slice(3)).toEqual(["after-cancellation"]);
  } finally {
    finish();
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("skips a background batch if another admission holds the catalog lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-lock-"));
  const path = join(home, "catalog.sqlite");
  const admission = new CatalogWriteAdmission(path, { waitMs: 10_000 });
  const lock = await acquireCatalogWriteLock(path);
  try {
    const backfill = async () => true;
    await expect(admission.runWhenIdle(backfill)).resolves.toBeUndefined();
    await lock.release();
    await expect(admission.runWhenIdle(backfill)).resolves.toBe(true);
  } finally {
    await lock.release();
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("signals a running background batch to commit when a writer joins", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-lock-"));
  const admission = new CatalogWriteAdmission(join(home, "catalog.sqlite"));
  let release: () => void = () => {};
  const committing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (flag: Int32Array) => void = () => {};
  const entering = new Promise<Int32Array>((resolve) => {
    started = resolve;
  });
  const batch = admission.runWhenIdle(async (foregroundWaiting) => {
    started(new Int32Array(foregroundWaiting));
    await committing;
  });
  try {
    const flag = await Promise.race([
      entering,
      batch.then(() => {
        throw new Error("background batch did not enter");
      }),
    ]);
    expect(Atomics.load(flag, 0)).toBe(0);
    const writer = admission.run(async () => "written");
    expect(Atomics.load(flag, 0)).toBe(1);
    release();
    await batch;
    await expect(writer).resolves.toBe("written");
  } finally {
    release();
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("rejects corrupt markers, linked catalogs and linked lock files without modifying their bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-lock-")),
    path = join(home, "catalog.sqlite");
  const hash = createHash("sha256").update(path).digest("hex"),
    sidecar = join(home, ".sciretriever-locks", `catalog-${hash}.lock`);
  try {
    const lock = await acquireCatalogWriteLock(path);
    await lock.release();
    await writeFile(sidecar, "wrong-marker");
    await expect(acquireCatalogWriteLock(path)).rejects.toMatchObject({
      code: "write-admission-security",
    });
    await rm(sidecar);
    await writeFile(join(home, "other"), "fixture");
    await symlink(join(home, "other"), sidecar);
    await expect(acquireCatalogWriteLock(path)).rejects.toMatchObject({
      code: "write-admission-security",
    });
    await rm(sidecar);
    await link(join(home, "other"), sidecar);
    await expect(acquireCatalogWriteLock(path)).rejects.toMatchObject({
      code: "write-admission-security",
    });
    await rm(sidecar);
    await symlink(join(home, "other"), path);
    await expect(acquireCatalogWriteLock(path)).rejects.toMatchObject({
      code: "write-admission-security",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("releases a subprocess-held admission on process death without stale lock-directory cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-lock-")),
    path = join(home, "catalog.sqlite");
  const hash = createHash("sha256").update(path).digest("hex");
  const sidecar = join(home, ".sciretriever-locks", `catalog-${hash}.lock`);
  const initialized = await acquireCatalogWriteLock(path);
  await initialized.release();
  const child = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      "--nonblock",
      sidecar,
      "/bin/sh",
      "-c",
      "echo locked; cat >/dev/null",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  const closed = new Promise<void>((r) => child.once("close", () => r()));
  child.stderr.resume();
  try {
    await new Promise<void>((r, j) => {
      child.stdout.once("data", () => r());
      child.once("error", j);
      child.once("exit", () =>
        j(new Error("fixture exited before acquisition")),
      );
    });
    await expect(acquireCatalogWriteLock(path)).rejects.toMatchObject({
      code: "write-admission-conflict",
    });
    child.kill("SIGKILL");
    await closed;
    const lock = await acquireCatalogWriteLock(path);
    await lock.release();
  } finally {
    child.kill("SIGKILL");
    await closed;
    await rm(home, { recursive: true, force: true });
  }
});
it("keeps file publication and registration in one admission before a queued maintenance read", async () => {
  const env = await setup();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  try {
    const publishing = env.app.files.withWrite(async () => {
      await expect(
        acquireCatalogWriteLock(join(env.home, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "write-admission-conflict" });
      const bytes = await env.app.files.read(
          env.primary.path,
          env.primary.size_bytes,
        ),
        stage = await env.app.files.stage();
      await stage.write(bytes);
      await env.app.files.publish(stage, env.primary.path);
      enter();
      await hold;
      await env.app.database.putAsset(env.primary);
    });
    await Promise.race([entered, publishing]);
    let maintenanceRan = false;
    const maintenance = env.app.writes.run(async () => {
      maintenanceRan = true;
      expect(await env.app.database.locateArtifact(env.primary)).not.toBeNull();
    });
    expect(maintenanceRan).toBe(false);
    release();
    await publishing;
    await maintenance;
    expect(maintenanceRan).toBe(true);
  } finally {
    release();
    await env.close();
  }
});
it("application shutdown waits for an admitted file registration to commit", async () => {
  const env = await setup();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const publishing = env.app.files.withWrite(async () => {
      enter();
      await hold;
      await env.app.database.putAsset(env.primary);
    });
    await entered;
    const closing = env.app.close();
    await Promise.resolve();
    release();
    await publishing;
    await closing;
    reopened = await createApplication(env.home);
    expect(await reopened.database.getAsset(env.primary.asset_id)).toEqual(
      env.primary,
    );
  } finally {
    release();
    await reopened?.close();
    await env.close();
  }
});
