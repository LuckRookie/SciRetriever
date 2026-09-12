import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  lstat,
  readFile,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, relative, resolve, sep, join } from "node:path";

import type { RelativeArtifactPath, Sha256 } from "@sciretriever/contracts";
import { acquireFileLock } from "../locking.js";
import { FileStagingError, type StagingFile } from "./staging.js";

export class FilePublicationError extends Error {
  readonly code = "file-publication" as const;
  readonly conflict: boolean;
  constructor(conflict = false) {
    super("file publication operation failed");
    this.name = "FilePublicationError";
    this.conflict = conflict;
  }
}

export interface PublishedFile {
  readonly reference: RelativeArtifactPath;
  readonly sha256: Sha256;
  readonly size: number;
  readonly created: boolean;
}
export interface PublicationDependencies {
  readonly write?: (
    handle: FileHandle,
    data: Uint8Array,
    offset: number,
  ) => Promise<{ readonly bytesWritten: number }>;
  readonly syncFile?: (handle: FileHandle) => Promise<void>;
  readonly syncDirectory?: (path: string) => Promise<void>;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_PATH = 1024;

function invalid(conflict = false): never {
  throw new FilePublicationError(conflict);
}

function safeReference(root: string, value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_PATH ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    invalid();
  const rootPath = resolve(root);
  const result = resolve(rootPath, value);
  if (result !== rootPath && !result.startsWith(`${rootPath}${sep}`)) invalid();
  return result;
}

async function sha256File(path: string): Promise<Sha256> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex") as Sha256;
}

async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW,
    );
    await directory.sync();
  } catch {
    invalid();
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function ensureDirectoryChain(
  root: string,
  parent: string,
): Promise<void> {
  const rootPath = resolve(root);
  const parentPath = resolve(parent);
  const suffix = relative(rootPath, parentPath);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    suffix.startsWith(sep)
  )
    invalid();
  try {
    const rootMetadata = await lstat(rootPath);
    if (!rootMetadata.isDirectory()) invalid();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalid();
    await mkdir(rootPath, { mode: 0o700 });
  }
  if (suffix === "") return;
  let current = rootPath;
  for (const component of suffix.split(sep)) {
    if (!component || component === "." || component === "..") invalid();
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory()) invalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalid();
      await mkdir(current, { mode: 0o700 });
      const metadata = await lstat(current);
      if (!metadata.isDirectory()) invalid();
    }
  }
}

async function preserveConflictEvidence(
  root: string,
  targetReference: string,
  existingSha256: Sha256,
  incomingSha256: Sha256,
): Promise<void> {
  const evidenceDirectory = resolve(root, ".conflicts");
  await ensureDirectoryChain(root, evidenceDirectory);
  const reference = `${targetReference}:${existingSha256}:${incomingSha256}`;
  const evidenceName = createHash("sha256").update(reference).digest("hex");
  const evidencePath = join(evidenceDirectory, `${evidenceName}.json`);
  const evidence = JSON.stringify({
    target: targetReference,
    existing_sha256: existingSha256,
    incoming_sha256: incomingSha256,
  });
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      evidencePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await writeFile(handle, evidence, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(evidenceDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    invalid();
  }
}

async function removeOwnedFile(
  target: string,
  device: number,
  inode: number,
): Promise<void> {
  try {
    const metadata = await lstat(target);
    if (
      metadata.isFile() &&
      metadata.nlink === 1 &&
      Number(metadata.dev) === device &&
      Number(metadata.ino) === inode
    )
      await unlink(target);
  } catch {
    // Cleanup is best effort; a later integrity check reports the original failure.
  }
}

async function acquirePublicationLock(
  root: string,
  key: string,
): Promise<Awaited<ReturnType<typeof acquireFileLock>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await acquireFileLock(root, key);
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  invalid();
}

/** Publish bytes using create-if-absent semantics; an existing different file is never replaced. */
async function publishStagedFileUnlocked(
  rootValue: string,
  stage: StagingFile,
  targetReference: string,
  dependencies: PublicationDependencies,
): Promise<PublishedFile> {
  if (typeof rootValue !== "string" || !rootValue.startsWith("/")) invalid();
  const root = resolve(rootValue);
  const target = safeReference(root, targetReference);
  const parent = dirname(target);
  const bytes = await stage.read().catch((error) => {
    if (error instanceof FileStagingError) throw error;
    invalid();
  });
  const digest = createHash("sha256").update(bytes).digest("hex") as Sha256;
  await ensureDirectoryChain(root, parent);
  let handle: FileHandle | undefined;
  let createdDevice: number | undefined;
  let createdInode: number | undefined;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    const createdMetadata = await handle.stat();
    createdDevice = Number(createdMetadata.dev);
    createdInode = Number(createdMetadata.ino);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = dependencies.write
        ? await dependencies.write(handle, bytes, offset)
        : await handle.write(bytes, offset);
      if (result.bytesWritten <= 0) invalid();
      offset += result.bytesWritten;
    }
    if (dependencies.syncFile) await dependencies.syncFile(handle);
    else await handle.sync();
    await handle.close();
    handle = undefined;
    if (dependencies.syncDirectory) await dependencies.syncDirectory(parent);
    else await syncDirectory(parent);
    await stage.discard();
    return Object.freeze({
      reference: targetReference as RelativeArtifactPath,
      sha256: digest,
      size: bytes.byteLength,
      created: true,
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const metadata = await lstat(target);
        if (!metadata.isFile() || metadata.nlink !== 1) invalid();
        const existing = await sha256File(target);
        if (existing !== digest) {
          await preserveConflictEvidence(
            root,
            targetReference,
            existing,
            digest,
          );
          invalid(true);
        }
        await stage.discard();
        return Object.freeze({
          reference: targetReference as RelativeArtifactPath,
          sha256: existing,
          size: Number(metadata.size),
          created: false,
        });
      } catch (conflict) {
        if (conflict instanceof FilePublicationError) throw conflict;
        invalid();
      }
    }
    if (createdDevice !== undefined && createdInode !== undefined)
      await removeOwnedFile(target, createdDevice, createdInode);
    if (error instanceof FileStagingError) throw error;
    if (error instanceof FilePublicationError) throw error;
    invalid();
  }
  invalid();
}

export async function publishStagedFile(
  rootValue: string,
  stage: StagingFile,
  targetReference: string,
  dependencies: PublicationDependencies = {},
): Promise<PublishedFile> {
  if (typeof rootValue !== "string" || !rootValue.startsWith("/")) invalid();
  const key = `publish-${createHash("sha256")
    .update(targetReference)
    .digest("hex")}`;
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquirePublicationLock(resolve(rootValue), key);
  } catch {
    invalid();
  }
  try {
    return await publishStagedFileUnlocked(
      rootValue,
      stage,
      targetReference,
      dependencies,
    );
  } finally {
    await lock!.release().catch(() => undefined);
  }
}

export async function readPublishedFile(
  rootValue: string,
  reference: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid();
  safeReference(rootValue, reference);
  const handles: FileHandle[] = [];
  try {
    const directoryFlags =
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW;
    let directory = await open(resolve(rootValue), directoryFlags);
    handles.push(directory);
    let current = resolve(rootValue);
    const parts = reference.split("/");
    for (const component of parts.slice(0, -1)) {
      current = join(current, component);
      directory = await open(
        process.platform === "linux"
          ? `/proc/self/fd/${directory.fd}/${component}`
          : current,
        directoryFlags,
      );
      handles.push(directory);
    }
    const name = parts.at(-1)!;
    const file = await open(
      process.platform === "linux"
        ? `/proc/self/fd/${directory.fd}/${name}`
        : join(current, name),
      constants.O_RDONLY | NOFOLLOW,
    );
    handles.push(file);
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes)
      invalid();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(
        Math.min(1024 * 1024, maxBytes - total + 1),
      );
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) invalid();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      after.size !== total ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.nlink !== 1
    )
      invalid();
    return new Uint8Array(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof FilePublicationError) throw error;
    throw new FilePublicationError();
  } finally {
    const results = await Promise.allSettled(
      handles.reverse().map((handle) => handle.close()),
    );
    if (results.some((result) => result.status === "rejected")) invalid();
  }
}

export function isRelativeArtifactReference(
  root: string,
  reference: string,
): boolean {
  try {
    const path = safeReference(root, reference);
    return relative(resolve(root), path) !== "";
  } catch {
    return false;
  }
}
