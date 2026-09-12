import { constants } from "node:fs";
import { mkdir, open, readFile, rm, rmdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class FileLockError extends Error {
  readonly code = "file-lock" as const;
  constructor() {
    super("file lock operation failed");
    this.name = "FileLockError";
  }
}

export interface FileLock {
  readonly key: string;
  readonly owner: string;
  release(): Promise<void>;
}

function invalid(): never {
  throw new FileLockError();
}

function lockPath(root: string, key: string): string {
  if (
    typeof root !== "string" ||
    !root.startsWith("/") ||
    typeof key !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(key)
  )
    invalid();
  return join(resolve(root), ".locks", `${key}.lock`);
}

export async function acquireFileLock(
  root: string,
  key: string,
): Promise<FileLock> {
  const path = lockPath(root, key);
  const rootPath = resolve(root);
  const locksDirectory = join(rootPath, ".locks");
  try {
    const rootMetadata = await lstat(rootPath);
    if (!rootMetadata.isDirectory()) invalid();
    try {
      const locksMetadata = await lstat(locksDirectory);
      if (!locksMetadata.isDirectory()) invalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(locksDirectory, { mode: 0o700 });
    }
    const locksMetadata = await lstat(locksDirectory);
    if (!locksMetadata.isDirectory()) invalid();
  } catch (error) {
    if (error instanceof FileLockError) throw error;
    throw new FileLockError();
  }
  const owner = `${process.pid}:${randomUUID()}`;
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
    const ownerHandle = await open(
      join(path, "owner"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await ownerHandle.writeFile(owner, "utf8");
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    const locksHandle = await open(
      locksDirectory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await locksHandle.sync();
    } finally {
      await locksHandle.close();
    }
  } catch {
    if (created) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new FileLockError();
  }
  let released = false;
  return {
    key,
    owner,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const stored = await readFile(join(path, "owner"), "utf8");
        if (stored !== owner) invalid();
        await rm(join(path, "owner"), { force: false });
        await rmdir(path);
        const locksHandle = await open(
          locksDirectory,
          constants.O_RDONLY |
            (constants.O_DIRECTORY ?? 0) |
            (constants.O_NOFOLLOW ?? 0),
        );
        try {
          await locksHandle.sync();
        } finally {
          await locksHandle.close();
        }
      } catch (error) {
        if (error instanceof FileLockError) throw error;
        throw new FileLockError();
      }
    },
  };
}
