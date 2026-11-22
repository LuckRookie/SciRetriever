import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  open,
  mkdir,
  lstat,
  link,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
async function flock(
  handle: FileHandle,
  mode: "shared" | "exclusive",
): Promise<void> {
  // flock(2) is attached to the inherited open file description; the parent keeps it after this child exits.
  const child = spawn(
    "/usr/bin/flock",
    [`--${mode}`, "--nonblock", "--conflict-exit-code", "75", "3"],
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
/** Publish a fully initialized marker. Readers never observe a zero-byte sentinel. */
async function protocolFile(
  path: string,
  marker: Buffer,
  directory: FileHandle,
): Promise<FileHandle> {
  try {
    return await open(path, FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    FILE | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let published = false;
  try {
    await flock(file, "exclusive");
    await file.writeFile(marker);
    await file.sync();
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await unlink(temporary);
    await directory.sync();
    if (published) return file;
    const existing = await open(path, FILE);
    await file.close();
    return existing;
  } catch (error) {
    await file.close();
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}
/** Same canonical catalog sidecar, marker and flock protocol as Python CatalogWriteLock. */
async function acquireProtocolLock(
  path: string,
  mode: "shared" | "exclusive",
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
    const file = await protocolFile(lockPath, marker, directory);
    handles.push(file);
    await flock(file, mode);
    const fileStat = await file.stat({ bigint: true });
    if (!fileStat.isFile() || fileStat.nlink !== 1n) fail();
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
/** Business writers always use the exclusive protocol. */
export function acquireCatalogWriteLock(path: string) {
  return acquireProtocolLock(path, "exclusive");
}
type CatalogWriteLock = Awaited<ReturnType<typeof acquireCatalogWriteLock>>;
/** Dedicated process handoff locks; never substitutes for the catalog business lock. */
export function acquireRestartLock(
  identity: string,
  phase: "intent" | "activity",
  mode: "shared" | "exclusive",
) {
  return acquireProtocolLock(`${identity}.restart-${phase}`, mode);
}
interface Scope {
  active: boolean;
}
/**
 * FIFO inside one process, reentrant only within the active operation. Another
 * holder of the lock is a conflict; with `waitMs` the operation backs off and
 * retries until that deadline instead of failing at once.
 */
export class CatalogWriteAdmission {
  private readonly context = new AsyncLocalStorage<Scope>();
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private backgroundPending = false;
  private backgroundYield: Int32Array<SharedArrayBuffer> | undefined;
  private lockForNextWriter: CatalogWriteLock | undefined;
  private closed = false;
  constructor(
    readonly catalogPath: string,
    private readonly options: { readonly waitMs?: number } = {},
  ) {}
  get hasQueuedWrites(): boolean {
    return this.waiting > 0;
  }
  get ownsWriteAdmission(): boolean {
    return this.context.getStore()?.active === true;
  }
  private async lock(check: () => void, signal?: AbortSignal) {
    const deadline = Date.now() + (this.options.waitMs ?? 0);
    for (let pause = 20; ; pause = Math.min(pause * 2, 500)) {
      try {
        return await acquireCatalogWriteLock(this.catalogPath);
      } catch (error) {
        if (
          !(error instanceof WriteAdmissionError) ||
          error.code !== "write-admission-conflict" ||
          Date.now() + pause > deadline
        )
          throw error;
      }
      await delay(pause, undefined, signal ? { signal } : {}).catch(() => {});
      check();
    }
  }
  private async admitted<T>(
    lock: CatalogWriteLock,
    operation: () => Promise<T>,
  ): Promise<T> {
    const scope = { active: true };
    try {
      return await this.context.run(scope, operation);
    } finally {
      scope.active = false;
      await lock.release();
    }
  }

  /** Try at the next release without asking the active writer to yield its segment. */
  runWhenIdle<T>(
    operation: (foregroundWaiting: SharedArrayBuffer) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.closed)
      return Promise.reject(new WriteAdmissionError("write-admission-closed"));
    if (this.context.getStore() || this.waiting || this.backgroundPending)
      return Promise.resolve(undefined);
    this.backgroundPending = true;
    const busy = () => this.closed || this.waiting > 0;
    const pending = this.tail
      .then(async () => {
        if (busy()) return undefined;
        let lock;
        try {
          lock = await acquireCatalogWriteLock(this.catalogPath);
        } catch (error) {
          if (
            error instanceof WriteAdmissionError &&
            error.code === "write-admission-conflict"
          )
            return undefined;
          throw error;
        }
        if (this.closed) {
          await lock.release();
          return undefined;
        }
        if (this.waiting) {
          // The first queued writer can use the verified lock directly.
          this.lockForNextWriter = lock;
          return undefined;
        }
        const foregroundWaiting = new Int32Array(new SharedArrayBuffer(4));
        this.backgroundYield = foregroundWaiting;
        try {
          return await this.admitted(lock, () =>
            operation(foregroundWaiting.buffer),
          );
        } finally {
          this.backgroundYield = undefined;
        }
      })
      .finally(() => {
        this.backgroundPending = false;
      });
    this.tail = pending.catch(() => undefined);
    return pending;
  }

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
    this.waiting++;
    if (this.backgroundYield) Atomics.store(this.backgroundYield, 0, 1);
    const pending = this.tail.then(async () => {
      this.waiting--;
      const reserved = this.lockForNextWriter;
      this.lockForNextWriter = undefined;
      if (!reserved) check();
      const lock = reserved ?? (await this.lock(check, signal));
      return this.admitted(lock, async () => {
        check();
        return operation();
      });
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
