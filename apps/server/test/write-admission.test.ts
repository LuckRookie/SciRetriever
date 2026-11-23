import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  link,
} from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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
function childWriter(
  catalog: string,
  mode: "series" | "hold" | "legacy" | "backfill",
) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--input-type=module",
      "--eval",
      `import { appendFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
const [module, catalog, mode] = process.argv.slice(1);
const { acquireCatalogWriteLock, CatalogWriteAdmission } = await import(module);
const writes = new CatalogWriteAdmission(catalog, { waitMs: 10000 });
const hold = async () => {
  const release = once(process, "message");
  process.send("held");
  await release;
};
if (mode === "legacy") {
  const lock = await acquireCatalogWriteLock(catalog);
  try { await hold(); }
  finally { await lock.release(); }
} else if (mode === "hold") {
  await writes.run(hold);
} else if (mode === "series") {
  for (let i = 0; i < 12; i++) {
    const started = performance.now();
    await writes.run(async () => {
      await appendFile(catalog + ".turns", "remote:" + (performance.now() - started) + "\\n");
      await delay(25);
    });
  }
} else {
  const until = performance.now() + 3400;
  await writes.runBackfill(async () => {
    const start = performance.now();
    await delay(15);
    await appendFile(catalog + ".turns", "backfill:" + (performance.now() - start) + "\\n");
    return performance.now() < until;
  });
}
await writes.close();
process.disconnect();`,
      new URL("../src/storage/write-admission.ts", import.meta.url).href,
      catalog,
      mode,
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const messages: unknown[] = [];
  child.on("message", (message) => messages.push(message));
  const exit = once(child, "exit");
  return {
    child,
    exit,
    messages,
    async finish() {
      await expect(exit, stderr).resolves.toEqual([0, null]);
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exit;
    },
  };
}

function queueDirectory(home: string, catalog: string) {
  const hash = createHash("sha256").update(catalog).digest("hex");
  return join(home, ".sciretriever-locks", `catalog-${hash}.queue`);
}

async function queuedTickets(home: string, catalog: string) {
  const names = await readdir(queueDirectory(home, catalog)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    },
  );
  return names.filter((name) => /^\d+-/u.test(name));
}

it("hands off to a registered remote writer before later callers and bounds handoff waits", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-queue-"));
  const catalog = join(home, "catalog.sqlite");
  const admission = new CatalogWriteAdmission(catalog, { waitMs: 10_000 });
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const initial = admission.run(async () => {
    started();
    await held;
  });
  let remote: ReturnType<typeof childWriter> | undefined;
  try {
    await Promise.race([entered, initial]);
    expect(admission.hasQueuedWrites).toBe(false);
    remote = childWriter(catalog, "series");
    await expect
      .poll(() => admission.hasQueuedWrites, { timeout: 20_000 })
      .toBe(true);
    const local = (async () => {
      for (let i = 0; i < 12; i++) {
        const start = performance.now();
        await admission.run(async () => {
          await appendFile(
            catalog + ".turns",
            `local:${performance.now() - start}\n`,
          );
          await delay(25);
        });
      }
    })();
    await expect
      .poll(async () => (await queuedTickets(home, catalog)).length, {
        timeout: 20_000,
      })
      .toBe(2);
    release();
    await initial;
    await local;
    await remote.finish();
    const turns = (await readFile(catalog + ".turns", "utf8"))
      .trim()
      .split("\n");
    expect(turns).toHaveLength(24);
    expect(turns[0]).toMatch(/^remote:/u);
    expect(turns[1]).toMatch(/^local:/u);
    expect(
      Math.max(...turns.map((turn) => Number(turn.split(":")[1]))),
    ).toBeLessThanOrEqual(1_000);
    expect(await queuedTickets(home, catalog)).toEqual([]);
  } finally {
    release();
    await remote?.close();
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("reaps a dead waiter and automatically releases a crashed holder", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-queue-"));
  const catalog = join(home, "catalog.sqlite");
  const admission = new CatalogWriteAdmission(catalog, { waitMs: 10_000 });
  let localLock:
    | Awaited<ReturnType<typeof acquireCatalogWriteLock>>
    | undefined;
  let remote: ReturnType<typeof childWriter> | undefined;
  try {
    localLock = await acquireCatalogWriteLock(catalog);
    remote = childWriter(catalog, "hold");
    await expect
      .poll(async () => (await queuedTickets(home, catalog)).length, {
        timeout: 20_000,
      })
      .toBe(1);
    await remote.close();
    await localLock.release();
    await expect(admission.run(async () => "after dead waiter")).resolves.toBe(
      "after dead waiter",
    );
    expect(await queuedTickets(home, catalog)).toEqual([]);

    remote = childWriter(catalog, "hold");
    const holder = remote;
    await expect
      .poll(() => holder.messages, { timeout: 20_000 })
      .toEqual(["held"]);
    const next = admission.run(async () => performance.now());
    await expect
      .poll(async () => (await queuedTickets(home, catalog)).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const killedAt = performance.now();
    await remote.close();
    expect((await next) - killedAt).toBeLessThanOrEqual(1_000);
    expect(await queuedTickets(home, catalog)).toEqual([]);
  } finally {
    await remote?.close();
    await localLock?.release();
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("shares the original flock with an unqueued writer and removes a cancelled ticket", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-queue-"));
  const catalog = join(home, "catalog.sqlite");
  const admission = new CatalogWriteAdmission(catalog, { waitMs: 10_000 });
  const deadline = new CatalogWriteAdmission(catalog, { waitMs: 100 });
  const legacy = childWriter(catalog, "legacy");
  try {
    await expect
      .poll(() => legacy.messages, { timeout: 20_000 })
      .toEqual(["held"]);
    await expect(deadline.run(async () => "unexpected")).rejects.toMatchObject({
      code: "write-admission-conflict",
    });
    expect(await queuedTickets(home, catalog)).toEqual([]);
    const cancel = new AbortController();
    const cancelled = admission.run(async () => {
      throw new Error("cancelled writer was admitted");
    }, cancel.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({
      code: "write-admission-cancelled",
    });
    await expect
      .poll(async () => (await queuedTickets(home, catalog)).length, {
        timeout: 20_000,
      })
      .toBe(1);
    cancel.abort();
    await rejected;
    expect(await queuedTickets(home, catalog)).toEqual([]);
    const writing = admission.run(async () => {
      expect(await probe(catalog)).toBe("conflict");
      return "new writer";
    });
    await expect
      .poll(async () => (await queuedTickets(home, catalog)).length, {
        timeout: 20_000,
      })
      .toBe(1);
    legacy.child.send("release");
    await legacy.finish();
    await expect(writing).resolves.toBe("new writer");
    expect(await probe(catalog)).toBe("acquired");
  } finally {
    await legacy.close();
    await deadline.close();
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("reserves at least one fifth of held time for backfill despite continuously queued writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-queue-"));
  const catalog = join(home, "catalog.sqlite");
  const admission = new CatalogWriteAdmission(catalog, { waitMs: 10_000 });
  const backfill = childWriter(catalog, "backfill");
  let stopped = false;
  const foreground = async () => {
    while (!stopped) {
      await admission.run(async () => {
        const start = performance.now();
        await delay(90);
        await appendFile(
          catalog + ".turns",
          `foreground:${performance.now() - start}\n`,
        );
      });
    }
  };
  const writers = Promise.all([foreground(), foreground()]);
  void writers.catch(() => {});
  try {
    await backfill.finish();
    stopped = true;
    await writers;
    const turns = (await readFile(catalog + ".turns", "utf8"))
      .trim()
      .split("\n");
    const isBackfill = (turn: string) => turn.startsWith("backfill:");
    const contended = turns.slice(
      turns.findIndex(isBackfill),
      turns.map(isBackfill).lastIndexOf(true) + 1,
    );
    const held = (rows: readonly string[]) =>
      rows.reduce((sum, row) => sum + Number(row.split(":")[1]), 0);
    expect(held(contended)).toBeGreaterThan(2_000);
    expect(
      held(contended.filter(isBackfill)) / held(contended),
    ).toBeGreaterThanOrEqual(0.2);
    expect(await queuedTickets(home, catalog)).toEqual([]);
  } finally {
    stopped = true;
    await backfill.close();
    await writers.catch(() => {});
    await admission.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("clears the share window when foreground writing has no backfill waiting", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-write-queue-"));
  const catalog = join(home, "catalog.sqlite");
  const admission = new CatalogWriteAdmission(catalog, { waitMs: 10_000 });
  const share = join(queueDirectory(home, catalog), "share.json");
  try {
    await admission.runBackfill(async () => false);
    await expect(readFile(share, "utf8")).resolves.toContain("backfill_ms");
    await admission.run(async () => {});
    await expect(readFile(share)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
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
