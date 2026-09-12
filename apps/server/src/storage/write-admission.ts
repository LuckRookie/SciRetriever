import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, mkdir, lstat, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export class WriteAdmissionError extends Error {
  constructor(
    readonly code:
      | "write-admission-conflict"
      | "write-admission-security"
      | "write-admission-closed"
      | "write-admission-cancelled"
      | "write-admission-expired",
  ) {
    super("catalog write admission failed");
  }
}
const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
function fail(): never {
  throw new WriteAdmissionError("write-admission-security");
}
function identity(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino;
}
async function parentDirectory(path: string): Promise<FileHandle[]> {
  const handles: FileHandle[] = [];
  try {
    handles.push(await open("/", DIRECTORY));
    for (const part of dirname(path).split("/").filter(Boolean))
      handles.push(
        await open(`/proc/self/fd/${handles.at(-1)!.fd}/${part}`, DIRECTORY),
      );
    return handles;
  } catch {
    await Promise.allSettled(handles.map((h) => h.close()));
    return fail();
  }
}
async function regular(path: string): Promise<BigIntStats | null> {
  try {
    const s = await lstat(path, { bigint: true });
    if (!s.isFile() || s.nlink !== 1n) fail();
    return s;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function flock(handle: FileHandle): Promise<void> {
  // flock(2) is attached to the inherited open file description; the parent keeps it after this child exits.
  const child = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"],
    {
      stdio: ["ignore", "ignore", "ignore", handle.fd],
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new WriteAdmissionError("write-admission-security"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new WriteAdmissionError(
            code === 75
              ? "write-admission-conflict"
              : "write-admission-security",
          ),
        );
    });
  });
}
/** Same canonical catalog sidecar, marker and flock protocol as Python CatalogWriteLock. */
export async function acquireCatalogWriteLock(
  path: string,
): Promise<{ release(): Promise<void> }> {
  if (
    process.platform !== "linux" ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    resolve(path) !== path
  )
    fail();
  const handles = await parentDirectory(path);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const results = await Promise.allSettled(
      handles.reverse().map((h) => h.close()),
    );
    if (results.some((r) => r.status === "rejected")) fail();
  };
  try {
    const parent = handles.at(-1)!;
    const parentStat = await parent.stat({ bigint: true });
    const catalogPath = `/proc/self/fd/${parent.fd}/${basename(path)}`;
    const catalog = await regular(catalogPath);
    const lockDirPath = `/proc/self/fd/${parent.fd}/.sciretriever-locks`;
    try {
      await mkdir(lockDirPath, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const directory = await open(lockDirPath, DIRECTORY);
    handles.push(directory);
    const directoryStat = await directory.stat({ bigint: true });
    const hash = createHash("sha256").update(path).digest("hex");
    const lockPath = `/proc/self/fd/${directory.fd}/catalog-${hash}.lock`;
    const marker = Buffer.from(`sciretriever-catalog-lock-v1\n${hash}\n`);
    let file: FileHandle,
      created = false;
    try {
      file = await open(
        lockPath,
        FILE | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      file = await open(lockPath, FILE);
    }
    handles.push(file);
    const fileStat = await file.stat({ bigint: true });
    if (!fileStat.isFile() || fileStat.nlink !== 1n) fail();
    if (created) {
      await file.writeFile(marker);
      await file.sync();
      await directory.sync();
    }
    await flock(file);
    const bytes = Buffer.alloc(marker.length + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (
      bytesRead !== marker.length ||
      !bytes.subarray(0, bytesRead).equals(marker)
    )
      fail();
    const currentFile = await regular(lockPath);
    const currentCatalog = await regular(catalogPath);
    if (
      !currentFile ||
      !identity(fileStat, currentFile) ||
      !identity(directoryStat, await lstat(lockDirPath, { bigint: true })) ||
      (catalog === null
        ? currentCatalog !== null
        : !currentCatalog || !identity(catalog, currentCatalog))
    )
      fail();
    const fresh = await parentDirectory(path);
    try {
      if (!identity(parentStat, await fresh.at(-1)!.stat({ bigint: true })))
        fail();
    } finally {
      await Promise.all(fresh.map((h) => h.close()));
    }
    return { release };
  } catch (error) {
    await release();
    if (error instanceof WriteAdmissionError) throw error;
    return fail();
  }
}
interface Scope {
  active: boolean;
}
/** FIFO inside one process, non-blocking conflict against other writers, reentrant only within the active operation. */
export class CatalogWriteAdmission {
  private readonly context = new AsyncLocalStorage<Scope>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly catalogPath: string) {}
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const check = () => {
      if (this.closed) throw new WriteAdmissionError("write-admission-closed");
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
    };
    const current = this.context.getStore();
    if (current) {
      if (!current.active)
        return Promise.reject(
          new WriteAdmissionError("write-admission-expired"),
        );
      try {
        if (signal?.aborted)
          throw new WriteAdmissionError("write-admission-cancelled");
        return operation();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const pending = this.tail.then(async () => {
      check();
      const lock = await acquireCatalogWriteLock(this.catalogPath);
      const scope = { active: true };
      try {
        check();
        return await this.context.run(scope, operation);
      } finally {
        scope.active = false;
        await lock.release();
      }
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
