import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import type { TaskHistoryTransfer } from "./task-detail-engine.js";

// One immutable envelope binds the replay state to the exact scratch image.
// Bump the magic when the aggregator or its scratch representation changes.
const MAGIC = Buffer.from("SRTASK01");
const HEADER_BYTES = MAGIC.length + 4;
const DIGEST_BYTES = 32;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 32;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHECKPOINT = /^[0-9a-f]{64}\.checkpoint$/u;
const TEMPORARY = /^\.[0-9a-f-]{36}\.tmp$/u;

type Metadata = Omit<TaskHistoryTransfer, "path">;
export interface TaskSidecarFile {
  readonly name: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

function invalid(): never {
  throw new Error("task history checkpoint invalid");
}

export function taskScratchPath() {
  return join(
    mkdtempSync(join(tmpdir(), "sciretriever-task-history-")),
    "history.sqlite",
  );
}

export function removeTaskScratch(path: string) {
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch {
    // Scratch cleanup must not affect catalog reads.
  }
}

function readBytes(fd: number, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; ) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (!count) invalid();
    offset += count;
  }
  return bytes;
}

function writeBytes(fd: number, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; ) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) invalid();
    offset += count;
  }
}

function copyImage(
  source: number,
  destination: number,
  length: number,
  digest: ReturnType<typeof createHash>,
) {
  const buffer = Buffer.allocUnsafe(Math.min(length, 1024 * 1024));
  for (let left = length; left > 0; ) {
    const bytes = readBytes(
      source,
      buffer.subarray(0, Math.min(buffer.length, left)),
    );
    digest.update(bytes);
    writeBytes(destination, bytes);
    left -= bytes.length;
  }
}

function openDirectory(path: string, create: boolean) {
  let fd = openSync("/", DIRECTORY);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = `/proc/self/fd/${fd}/${part}`;
      let child: number;
      try {
        child = openSync(next, DIRECTORY);
      } catch (error) {
        if (!create || !absent(error)) throw error;
        try {
          mkdirSync(next, { mode: 0o700 });
        } catch (race) {
          if ((race as NodeJS.ErrnoException).code !== "EEXIST") throw race;
        }
        child = openSync(next, DIRECTORY);
      }
      closeSync(fd);
      fd = child;
    }
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) invalid();
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function unlinkIfCurrent(directory: string, file: TaskSidecarFile) {
  const path = join(directory, file.name);
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stat && stat.ino === file.ino && stat.dev === file.dev) unlinkSync(path);
}

function prune(directory: string) {
  const files = [];
  const expired = Date.now() - TEMP_MAX_AGE_MS;
  for (const name of readdirSync(directory)) {
    if (!CHECKPOINT.test(name) && !TEMPORARY.test(name)) continue;
    const stat = lstatSync(join(directory, name), {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!stat?.isFile()) continue;
    const file = {
      name,
      dev: stat.dev,
      ino: stat.ino,
      size: Number(stat.size),
      at: Number(stat.mtimeMs),
    };
    if (CHECKPOINT.test(name)) files.push(file);
    else if (file.at < expired) unlinkIfCurrent(directory, file);
  }
  files.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  let bytes = 0;
  for (const [i, file] of files.entries()) {
    bytes += file.size;
    if (i >= MAX_FILES || bytes > MAX_CACHE_BYTES)
      unlinkIfCurrent(directory, file);
  }
}

/** Disposable, private cache shared by independent workers and processes. */
export class TaskDetailSidecars {
  private readonly directory: string;
  private readonly catalog: string;

  constructor(directory: string, catalog: string) {
    this.directory = directory;
    this.catalog = catalog;
  }

  private name(jobId: string) {
    return (
      createHash("sha256")
        .update(JSON.stringify([this.catalog, jobId]))
        .digest("hex") + ".checkpoint"
    );
  }

  load(
    jobId: string,
    identity: string,
    schemaVersion: number,
    through: string,
  ):
    | {
        readonly transfer: TaskHistoryTransfer;
        readonly file: TaskSidecarFile;
      }
    | undefined {
    let directoryFd: number | undefined;
    let fd: number | undefined;
    let scratch: string | undefined;
    let file: TaskSidecarFile | undefined;
    let restored = false;
    const name = this.name(jobId);
    try {
      directoryFd = openDirectory(this.directory, false);
      const directory = `/proc/self/fd/${directoryFd}`;
      fd = openSync(join(directory, name), READ);
      const stat = fstatSync(fd, { bigint: true });
      file = { name, dev: stat.dev, ino: stat.ino };
      const size = Number(stat.size);
      if (
        !stat.isFile() ||
        stat.nlink > 1n ||
        Number(stat.uid) !== process.getuid?.() ||
        (stat.mode & 0o777n) !== 0o600n ||
        size > MAX_FILE_BYTES
      )
        invalid();
      const header = readBytes(fd, Buffer.alloc(HEADER_BYTES));
      const stateSize = header.readUInt32LE(MAGIC.length);
      const imageSize = size - HEADER_BYTES - stateSize - DIGEST_BYTES;
      if (
        !header.subarray(0, MAGIC.length).equals(MAGIC) ||
        stateSize < 1 ||
        stateSize > MAX_STATE_BYTES ||
        imageSize < 512
      )
        invalid();
      const state = readBytes(fd, Buffer.allocUnsafe(stateSize));
      const digest = createHash("sha256").update(header).update(state);
      scratch = taskScratchPath();
      const image = openSync(scratch, "wx", 0o600);
      try {
        copyImage(fd, image, imageSize, digest);
      } finally {
        closeSync(image);
      }
      if (!readBytes(fd, Buffer.alloc(DIGEST_BYTES)).equals(digest.digest()))
        invalid();
      const metadata: unknown = deserialize(state);
      if (!metadata || typeof metadata !== "object") invalid();
      const value = metadata as Metadata;
      if (
        value.jobId !== jobId ||
        value.identity !== identity ||
        value.schemaVersion !== schemaVersion ||
        typeof value.through !== "string" ||
        typeof value.created !== "string" ||
        !value.state?.head ||
        !Number.isSafeInteger(value.state.storedEvents) ||
        value.state.storedEvents < 1
      )
        invalid();
      // An older time cutoff is a cache miss, with no invalidation of this file.
      if (value.through > through) return undefined;
      restored = true;
      return { transfer: { ...value, path: scratch }, file };
    } catch {
      if (directoryFd !== undefined && file) {
        try {
          unlinkIfCurrent(`/proc/self/fd/${directoryFd}`, file);
        } catch {
          // A competing worker or an unavailable cache can only cause a miss.
        }
      }
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (directoryFd !== undefined) closeSync(directoryFd);
      if (scratch && !restored) removeTaskScratch(scratch);
    }
  }

  discard(file: TaskSidecarFile) {
    let fd: number | undefined;
    try {
      fd = openDirectory(this.directory, false);
      unlinkIfCurrent(`/proc/self/fd/${fd}`, file);
    } catch {
      // Cache eviction and deletion are best effort.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  save({ path, ...metadata }: TaskHistoryTransfer) {
    if (!metadata.state.head) return;
    let directoryFd: number | undefined;
    let source: number | undefined;
    let temporary: string | undefined;
    try {
      const state = serialize(metadata);
      if (state.length > MAX_STATE_BYTES) return;
      source = openSync(path, READ);
      const { size } = fstatSync(source);
      if (size + state.length + HEADER_BYTES + DIGEST_BYTES > MAX_FILE_BYTES)
        return;
      directoryFd = openDirectory(this.directory, true);
      const directory = `/proc/self/fd/${directoryFd}`;
      temporary = join(directory, `.${randomUUID()}.tmp`);
      const file = openSync(temporary, "wx", 0o600);
      try {
        const header = Buffer.alloc(HEADER_BYTES);
        MAGIC.copy(header);
        header.writeUInt32LE(state.length, MAGIC.length);
        const digest = createHash("sha256").update(header).update(state);
        writeBytes(file, header);
        writeBytes(file, state);
        copyImage(source, file, size, digest);
        writeBytes(file, digest.digest());
      } finally {
        closeSync(file);
      }
      renameSync(temporary, join(directory, this.name(metadata.jobId)));
      temporary = undefined;
      prune(directory);
    } catch {
      // A disposable checkpoint never decides whether a catalog read succeeds.
    } finally {
      if (temporary) {
        try {
          unlinkSync(temporary);
        } catch {
          /* Retried by pruning. */
        }
      }
      if (source !== undefined) closeSync(source);
      if (directoryFd !== undefined) closeSync(directoryFd);
    }
  }
}
