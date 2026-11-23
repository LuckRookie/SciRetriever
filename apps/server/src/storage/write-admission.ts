import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import {
  open,
  mkdir,
  lstat,
  link,
  rename,
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
  waitMs = 0,
): Promise<void> {
  // flock(2) is attached to the inherited open file description; the parent keeps it after this child exits.
  const child = spawn(
    "/usr/bin/flock",
    [
      `--${mode}`,
      ...(waitMs > 0 ? ["--wait", String(waitMs / 1000)] : ["--nonblock"]),
      "--conflict-exit-code",
      "75",
      "3",
    ],
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
async function openDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return open(path, DIRECTORY);
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
  waitMs = 0,
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
    const directory = await openDirectory(lockDirPath);
    handles.push(directory);
    const directoryStat = await directory.stat({ bigint: true });
    const hash = createHash("sha256").update(path).digest("hex");
    const lockPath = `/proc/self/fd/${directory.fd}/catalog-${hash}.lock`;
    const marker = Buffer.from(`sciretriever-catalog-lock-v1\n${hash}\n`);
    const file = await protocolFile(lockPath, marker, directory);
    handles.push(file);
    await flock(file, mode, waitMs);
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
type WriteKind = "foreground" | "backfill";
interface Ticket {
  readonly name: string;
  readonly kind: WriteKind;
}
interface ShareWindow {
  readonly held_ms: number;
  readonly backfill_ms: number;
  readonly updated_ms: number;
}
const SHARE_WINDOW_MS = 2_000;
const FOREGROUND_SEGMENT_ALLOWANCE_MS = 200;
const BACKFILL_SHARE_DENOMINATOR = 5;
const QUEUE_POLL_MS = 8;
const FLOCK_WAIT_MS = 120;
const TICKET =
  /^(\d{20})-(foreground|backfill)-([1-9]\d*)-(\d+)-(\d+)-[a-f0-9-]{36}$/u;
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const noSuchFile = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

function processStart(pid: string): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Field 22 distinguishes a current process from an earlier user of this PID.
    return fields[0] === "Z" || fields[0] === "X" ? null : (fields[19] ?? null);
  } catch (error) {
    if (noSuchFile(error) || (error as NodeJS.ErrnoException).code === "ESRCH")
      return null;
    throw error;
  }
}

function removeTicket(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!noSuchFile(error)) throw error;
  }
}

/** Only the selected ticket contends for the original catalog flock. */
class CatalogWriteQueue {
  private readonly path: string;

  private constructor(
    private readonly directory: FileHandle,
    private readonly absolutePath: string,
    private readonly directoryStat: BigIntStats,
  ) {
    this.path = `/proc/self/fd/${directory.fd}`;
  }

  static async open(catalog: string) {
    if (
      process.platform !== "linux" ||
      typeof catalog !== "string" ||
      !catalog.startsWith("/") ||
      resolve(catalog) !== catalog
    )
      fail();
    const handles = await parentDirectory(catalog);
    let directory: FileHandle | undefined;
    try {
      const locks = await openDirectory(
        `/proc/self/fd/${handles.at(-1)!.fd}/.sciretriever-locks`,
      );
      handles.push(locks);
      const hash = createHash("sha256").update(catalog).digest("hex");
      const name = `catalog-${hash}.queue`;
      directory = await openDirectory(`/proc/self/fd/${locks.fd}/${name}`);
      return new CatalogWriteQueue(
        directory,
        resolve(dirname(catalog), ".sciretriever-locks", name),
        await directory.stat({ bigint: true }),
      );
    } catch {
      await directory?.close();
      return fail();
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    }
  }

  async close() {
    await this.directory.close();
  }

  private async verify() {
    const current = await lstat(this.absolutePath, { bigint: true });
    if (!current.isDirectory() || !identity(this.directoryStat, current))
      fail();
  }

  async register(
    kind: WriteKind,
    deadline: number,
    check: () => void,
    signal: AbortSignal,
  ) {
    const directory = await open(this.path + "/.", DIRECTORY);
    try {
      for (;;) {
        check();
        try {
          await flock(
            directory,
            "exclusive",
            Math.min(FLOCK_WAIT_MS, deadline - monotonicMs()),
          );
          break;
        } catch (error) {
          if (
            !(error instanceof WriteAdmissionError) ||
            error.code !== "write-admission-conflict"
          )
            throw error;
          await waitForTurn(signal);
        }
      }
      check();
      await this.verify();
      const pid = String(process.pid);
      const start = processStart(pid);
      if (!start) fail();
      // Serialize publication of the ticket, including the assignment of its
      // monotonic timestamp, so later registrations cannot pass this one.
      const order = process.hrtime.bigint().toString().padStart(20, "0");
      const name = `${order}-${kind}-${pid}-${start}-${deadline}-${randomUUID()}`;
      const ticket = await open(
        `${this.path}/${name}`,
        FILE | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await ticket.close();
      return { kind, name } satisfies Ticket;
    } finally {
      await directory.close();
    }
  }

  remove(ticket: Ticket) {
    removeTicket(`${this.path}/${ticket.name}`);
  }

  hasWaiting(kind?: WriteKind) {
    const now = monotonicMs();
    return readdirSync(this.path).some((name) => {
      const match = TICKET.exec(name);
      return match && (!kind || match[2] === kind) && Number(match[5]) > now;
    });
  }

  private window(): ShareWindow {
    const now = monotonicMs();
    const empty = { held_ms: 0, backfill_ms: 0, updated_ms: now };
    let file: number;
    try {
      file = openSync(this.path + "/share.json", FILE);
    } catch (error) {
      if (noSuchFile(error)) return empty;
      return fail();
    }
    try {
      const stat = fstatSync(file);
      // rename can unlink the previous snapshot after open. Its descriptor
      // still refers to a complete version of the window.
      if (!stat.isFile() || stat.nlink > 1 || stat.size > 512) fail();
      const bytes = Buffer.alloc(513);
      const length = readSync(file, bytes);
      if (length > 512) fail();
      const value = JSON.parse(
        bytes.subarray(0, length).toString("utf8"),
      ) as ShareWindow;
      if (
        !Number.isFinite(value.held_ms) ||
        !Number.isFinite(value.backfill_ms) ||
        !Number.isFinite(value.updated_ms) ||
        value.backfill_ms < 0 ||
        value.held_ms < value.backfill_ms ||
        value.updated_ms > now ||
        now - value.updated_ms >= SHARE_WINDOW_MS ||
        (value.held_ms >= SHARE_WINDOW_MS &&
          value.backfill_ms * BACKFILL_SHARE_DENOMINATOR >= value.held_ms)
      )
        return empty;
      return value;
    } finally {
      closeSync(file);
    }
  }

  next(): string | undefined {
    const now = monotonicMs();
    let foreground: string | undefined;
    let backfill: string | undefined;
    for (const name of readdirSync(this.path).sort()) {
      const match = TICKET.exec(name);
      if (!match) continue;
      const [, , kind, pid, start, deadline] = match;
      if (kind === "foreground" ? foreground : backfill) continue;
      if (Number(deadline) <= now || processStart(pid!) !== start) {
        removeTicket(`${this.path}/${name}`);
        continue;
      }
      if (kind === "foreground") foreground ??= name;
      else backfill ??= name;
      if (foreground && backfill) break;
    }
    if (!foreground || !backfill) return foreground ?? backfill;
    const share = this.window();
    // Reserve enough backfill time for the next whole foreground segment.
    // Close a contended window only once the actual measured share is met.
    return share.backfill_ms * BACKFILL_SHARE_DENOMINATOR <
      share.held_ms + FOREGROUND_SEGMENT_ALLOWANCE_MS
      ? backfill
      : foreground;
  }

  async claim(ticket: Ticket) {
    if (this.next() !== ticket.name) return false;
    await this.verify();
    try {
      await unlink(`${this.path}/${ticket.name}`);
      return true;
    } catch (error) {
      if (!noSuchFile(error)) throw error;
      return false;
    }
  }

  async record(ticket: Ticket, held: number) {
    if (ticket.kind === "foreground" && !this.hasWaiting("backfill")) {
      // Uncontended foreground work creates no debt for a future backfill.
      removeTicket(this.path + "/share.json");
      return;
    }
    const share = this.window();
    const value: ShareWindow = {
      held_ms: share.held_ms + held,
      backfill_ms: share.backfill_ms + (ticket.kind === "backfill" ? held : 0),
      updated_ms: monotonicMs(),
    };
    // Only the catalog flock holder updates accounting. An interrupted
    // replace leaves the previous complete window available to the next one.
    const temporary = this.path + "/share.tmp";
    removeTicket(temporary);
    const file = await open(
      temporary,
      FILE | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(value));
    } finally {
      await file.close();
    }
    await rename(temporary, this.path + "/share.json");
  }
}

function waitForTurn(signal: AbortSignal) {
  return delay(QUEUE_POLL_MS, undefined, { signal }).catch(() => {});
}

async function waitForLocalTurn(previous: Promise<void>, signal: AbortSignal) {
  let wake!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const listener = addAbortListener(signal, wake);
  try {
    await Promise.race([previous, interrupted]);
  } finally {
    listener[Symbol.dispose]();
  }
}

interface Scope {
  active: boolean;
}

/** FIFO across processes, with reentrancy limited to the admitted operation. */
export class CatalogWriteAdmission {
  private readonly context = new AsyncLocalStorage<Scope>();
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private registration: Promise<unknown> = Promise.resolve();
  private foregroundTail = Promise.resolve();
  private tail: Promise<unknown> = Promise.resolve();
  private foregroundWaiting = 0;
  private activeQueue: CatalogWriteQueue | undefined;
  constructor(
    readonly catalogPath: string,
    private readonly options: { readonly waitMs?: number } = {},
  ) {}

  get hasQueuedWrites(): boolean {
    return (
      this.foregroundWaiting > 0 || this.activeQueue?.hasWaiting() === true
    );
  }

  hasQueuedForegroundWrites(includeOtherProcesses: boolean): boolean {
    return (
      this.foregroundWaiting > 0 ||
      (includeOtherProcesses &&
        this.activeQueue?.hasWaiting("foreground") === true)
    );
  }

  get ownsWriteAdmission(): boolean {
    return this.context.getStore()?.active === true;
  }

  private check(signal?: AbortSignal) {
    if (this.stop.signal.aborted)
      throw new WriteAdmissionError("write-admission-closed");
    if (signal?.aborted)
      throw new WriteAdmissionError("write-admission-cancelled");
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.pending.add(pending);
    const done = () => this.pending.delete(pending);
    void pending.then(done, done);
    return pending;
  }

  private async admitted<T>(
    operation: () => Promise<T>,
    queue?: CatalogWriteQueue,
  ) {
    const scope: Scope = { active: true };
    this.activeQueue = queue;
    try {
      return await this.context.run(scope, operation);
    } finally {
      scope.active = false;
      this.activeQueue = undefined;
    }
  }

  private async takeTurn(
    queue: CatalogWriteQueue,
    ticket: Ticket,
    deadline: number,
    check: () => void,
    signal: AbortSignal,
  ): Promise<CatalogWriteLock> {
    for (;;) {
      check();
      if (queue.next() === ticket.name) {
        let lock: CatalogWriteLock | undefined;
        try {
          lock = await acquireProtocolLock(
            this.catalogPath,
            "exclusive",
            Math.min(FLOCK_WAIT_MS, deadline - monotonicMs()),
          );
        } catch (error) {
          if (
            !(error instanceof WriteAdmissionError) ||
            error.code !== "write-admission-conflict"
          )
            throw error;
        }
        if (lock) {
          let claimed = false;
          try {
            check();
            claimed = await queue.claim(ticket);
            if (claimed) return lock;
          } finally {
            if (!claimed) await lock.release();
          }
        }
      }
      await waitForTurn(signal);
    }
  }

  private async queued<T>(
    kind: WriteKind,
    operation: () => Promise<T>,
    waitMs: number,
    signal?: AbortSignal,
    hasMore?: (result: T) => boolean,
  ): Promise<T> {
    this.check(signal);
    const waitSignal = AbortSignal.any(
      signal ? [signal, this.stop.signal] : [this.stop.signal],
    );
    if (kind === "foreground") this.foregroundWaiting++;
    let waiting = kind === "foreground";
    const doneWaiting = () => {
      if (waiting) this.foregroundWaiting--;
      waiting = false;
    };

    let queue: CatalogWriteQueue | undefined;
    let ticket: Ticket | undefined;
    let previous: Promise<void> | undefined;
    let releaseForeground: (() => void) | undefined;
    if (kind === "foreground") {
      // Only the front of the local FIFO registers a timed, shared ticket.
      previous = this.foregroundTail;
      const finished = new Promise<void>((resolve) => {
        releaseForeground = resolve;
      });
      this.foregroundTail = previous.then(() => finished);
    }
    try {
      if (previous) await waitForLocalTurn(previous, waitSignal);
      this.check(signal);
      let deadline = monotonicMs() + waitMs;
      const check = () => {
        this.check(signal);
        if (monotonicMs() >= deadline)
          throw new WriteAdmissionError("write-admission-conflict");
      };
      const registered = this.registration.then(async () => {
        check();
        queue = await CatalogWriteQueue.open(this.catalogPath);
        ticket = await queue.register(kind, deadline, check, waitSignal);
        return { queue, ticket };
      });
      this.registration = registered.catch(() => {});
      const turn = await registered;
      let next = turn.ticket;
      for (;;) {
        const lock = await this.takeTurn(
          turn.queue,
          next,
          deadline,
          check,
          waitSignal,
        );
        ticket = undefined;
        doneWaiting();
        try {
          check();
          const started = performance.now();
          let result: T;
          try {
            result = await this.admitted(operation, turn.queue);
          } finally {
            await turn.queue.record(next, performance.now() - started);
          }
          if (!hasMore?.(result) || waitSignal.aborted) return result;
          // Publish the next bounded backfill batch before releasing this one.
          // Otherwise an active backfill momentarily disappears between turns.
          deadline = monotonicMs() + waitMs;
          ticket = next = await turn.queue.register(
            kind,
            deadline,
            check,
            waitSignal,
          );
        } finally {
          await lock.release();
        }
      }
    } finally {
      doneWaiting();
      try {
        if (ticket) queue?.remove(ticket);
      } finally {
        try {
          await queue?.close();
        } finally {
          releaseForeground?.();
        }
      }
    }
  }

  /** Each call to batch commits one bounded unit and reports whether more is due. */
  async runBackfill(
    batch: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.context.getStore())
      throw new WriteAdmissionError("write-admission-expired");
    await this.track(
      this.queued(
        "backfill",
        batch,
        this.options.waitMs ?? 10_000,
        signal,
        (more) => more,
      ),
    );
  }

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
    if (this.options.waitMs)
      return this.track(
        this.queued("foreground", operation, this.options.waitMs, signal),
      );
    // Fail-fast locks (for example the retrieval-generation owner) still
    // serialize siblings locally, with no waiting across processes.
    this.foregroundWaiting++;
    const next = this.tail.then(async () => {
      this.foregroundWaiting--;
      this.check(signal);
      const lock = await acquireCatalogWriteLock(this.catalogPath);
      try {
        this.check(signal);
        return await this.admitted(operation);
      } finally {
        await lock.release();
      }
    });
    this.tail = next.catch(() => {});
    return this.track(next);
  }

  async close(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled(this.pending);
  }
}
