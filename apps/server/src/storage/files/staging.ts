import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  lstat,
  unlink,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseArtifactRef,
  type RelativeArtifactPath,
  type Sha256,
} from "@sciretriever/contracts";
import {
  openVerifiedFile,
  type ScopedFileReader,
  type ArtifactReadOptions,
} from "./reader.js";
import type { TemporaryFileBudget, TemporaryFileLease } from "./budget.js";

export class FileStagingError extends Error {
  readonly code = "file-staging" as const;
  constructor(cause?: unknown) {
    super("file staging operation failed", { cause });
    this.name = "FileStagingError";
  }
}

export interface StagingIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly links: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface StagedFile {
  readonly reference: RelativeArtifactPath;
  readonly size: number;
  readonly sha256: Sha256;
}
export interface StagingOptions {
  readonly maxBytes?: number;
  readonly budget?: TemporaryFileBudget;
  readonly signal?: AbortSignal;
}

const STAGING_DIRECTORY = ".staging";
const activeStages = new Set<string>();
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW;

function invalid(): never {
  throw new FileStagingError();
}
function checkRoot(root: string): string {
  if (typeof root !== "string" || !root || !root.startsWith("/")) invalid();
  return resolve(root);
}
function checkBytes(data: Uint8Array): Uint8Array {
  if (!(data instanceof Uint8Array)) invalid();
  return data;
}
function identity(
  value: Awaited<ReturnType<FileHandle["stat"]>>,
): StagingIdentity {
  if (!value.isFile() || value.nlink !== 1) invalid();
  return {
    device: Number(value.dev),
    inode: Number(value.ino),
    size: Number(value.size),
    links: Number(value.nlink),
    mtimeMs: Number(value.mtimeMs),
    ctimeMs: Number(value.ctimeMs),
  };
}
function sameIdentity(left: StagingIdentity, right: StagingIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.links === right.links &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
function directoryIdentity(
  value: Awaited<ReturnType<FileHandle["stat"]>>,
): Pick<StagingIdentity, "device" | "inode"> {
  if (!value.isDirectory()) invalid();
  return { device: Number(value.dev), inode: Number(value.ino) };
}

/** Called by the HTTP service only. Durable import data and candidates live
 * outside .staging; no supported catalog record registers these scratch names.
 * A writer in another process is protected by its recent write time (HTTP idle
 * limit: 60 s). Live stages in this process also retain explicit ownership.
 */
export async function cleanupStaging(rootValue: string, now = Date.now()) {
  const root = checkRoot(rootValue),
    directory = join(root, STAGING_DIRECTORY);
  const result = { files: 0, bytes: 0 };
  let handle: FileHandle;
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory()) invalid();
    handle = await open(directory, DIRECTORY_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw new FileStagingError(error);
  }
  try {
    directoryIdentity(await handle.stat());
    const scoped =
      process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : directory;
    for (const entry of await readdir(scoped, { withFileTypes: true })) {
      if (
        !/^stage-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(
          entry.name,
        ) ||
        !entry.isFile() ||
        activeStages.has(join(directory, entry.name))
      )
        continue;
      const path = join(scoped, entry.name);
      let file: FileHandle | undefined;
      try {
        file = await open(path, constants.O_RDONLY | NOFOLLOW);
        const before = identity(await file.stat());
        if (before.mtimeMs >= now - 3600000) continue;
        const named = identity(await lstat(path));
        if (
          !sameIdentity(before, named) ||
          activeStages.has(join(directory, entry.name))
        )
          continue;
        await unlink(path);
        result.files++;
        result.bytes += before.size;
      } catch (error) {
        if (
          ["ENOENT", "ELOOP"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        throw new FileStagingError(error);
      } finally {
        await file?.close();
      }
    }
    if (result.files) await handle.sync();
    return result;
  } finally {
    await handle.close();
  }
}

export class StagingFile {
  private readonly directory: string;
  private readonly directoryHandle: FileHandle;
  private readonly directoryInitial: Pick<StagingIdentity, "device" | "inode">;
  private readonly name: string;
  private readonly filePath: string;
  private readonly handle: FileHandle;
  private readonly initial: StagingIdentity;
  private readonly maxBytes: number;
  private closed = false;
  private handedOff = false;
  private sealed = false;
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    directory: string,
    directoryHandle: FileHandle,
    directoryInitial: Pick<StagingIdentity, "device" | "inode">,
    name: string,
    handle: FileHandle,
    initial: StagingIdentity,
    maxBytes: number,
    readonly temporaryBudget: TemporaryFileBudget | undefined,
    private readonly lease: TemporaryFileLease | undefined,
    readonly signal: AbortSignal | undefined,
  ) {
    this.directory = directory;
    this.directoryHandle = directoryHandle;
    this.directoryInitial = directoryInitial;
    this.name = name;
    this.filePath =
      process.platform === "linux"
        ? `/proc/self/fd/${directoryHandle.fd}/${name}`
        : join(directory, name);
    this.handle = handle;
    this.initial = initial;
    this.maxBytes = maxBytes;
    activeStages.add(join(directory, name));
  }

  static async create(
    rootValue: string,
    options: StagingOptions = {},
    maxAttempts = 32,
  ): Promise<StagingFile> {
    const root = checkRoot(rootValue);
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
      invalid();
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) invalid();
    const directory = join(root, STAGING_DIRECTORY);
    try {
      const rootMetadata = await lstat(root).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        },
      );
      if (rootMetadata !== undefined && !rootMetadata.isDirectory()) invalid();
      if (rootMetadata === undefined)
        await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryHandle = await open(directory, DIRECTORY_FLAGS);
      const directoryInitial = directoryIdentity(await directoryHandle.stat());
      const directoryMetadata = await lstat(directory);
      if (
        !directoryMetadata.isDirectory() ||
        Number(directoryMetadata.dev) !== directoryInitial.device ||
        Number(directoryMetadata.ino) !== directoryInitial.inode
      ) {
        await directoryHandle.close().catch(() => undefined);
        invalid();
      }
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const name = `stage-${randomUUID()}.tmp`;
        try {
          const handle = await open(
            process.platform === "linux"
              ? `/proc/self/fd/${directoryHandle.fd}/${name}`
              : join(directory, name),
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
            0o600,
          );
          try {
            const initial = identity(await handle.stat());
            return new StagingFile(
              directory,
              directoryHandle,
              directoryInitial,
              name,
              handle,
              initial,
              maxBytes,
              options.budget,
              options.budget?.open(directory, "staging"),
              options.signal,
            );
          } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(
              process.platform === "linux"
                ? `/proc/self/fd/${directoryHandle.fd}/${name}`
                : join(directory, name),
            ).catch(() => undefined);
            if (error instanceof FileStagingError) {
              await directoryHandle.close().catch(() => undefined);
              throw error;
            }
            invalid();
          }
        } catch (error) {
          if (error instanceof FileStagingError) throw error;
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          await directoryHandle.close().catch(() => undefined);
          invalid();
        }
      }
      await directoryHandle.close().catch(() => undefined);
    } catch (error) {
      if (error instanceof FileStagingError) throw error;
      invalid();
    }
    invalid();
  }

  get reference(): RelativeArtifactPath {
    if (this.closed) invalid();
    return `${STAGING_DIRECTORY}/${this.name}` as RelativeArtifactPath;
  }

  private async verify(): Promise<StagingIdentity> {
    if (this.closed) invalid();
    try {
      const current = identity(await this.handle.stat());
      const currentDirectory = directoryIdentity(
        await this.directoryHandle.stat(),
      );
      if (
        current.device !== this.initial.device ||
        current.inode !== this.initial.inode ||
        current.links !== 1 ||
        currentDirectory.device !== this.directoryInitial.device ||
        currentDirectory.inode !== this.directoryInitial.inode
      )
        invalid();
      const named = await lstat(join(this.directory, this.name));
      if (
        !named.isFile() ||
        Number(named.dev) !== this.initial.device ||
        Number(named.ino) !== this.initial.inode ||
        Number(named.nlink) !== 1
      )
        invalid();
      return current;
    } catch (error) {
      if (error instanceof FileStagingError) throw error;
      invalid();
    }
  }

  async write(data: Uint8Array): Promise<number> {
    const bytes = checkBytes(data);
    const operation = this.operationTail.then(async () => {
      if (this.handedOff || this.sealed) invalid();
      const current = await this.verify();
      if (current.size + bytes.byteLength > this.maxBytes) invalid();
      await this.lease?.reserve(current.size + bytes.byteLength);
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (this.signal?.aborted) invalid();
        let written: number;
        try {
          ({ bytesWritten: written } = await this.handle.write(bytes, offset));
        } catch (cause) {
          throw new FileStagingError(cause);
        }
        if (written <= 0) invalid();
        offset += written;
        this.lease?.written(current.size + offset);
      }
      await this.verify();
      return offset;
    });
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async flush(): Promise<void> {
    await this.operationTail;
    await this.verify();
    try {
      await this.handle.sync();
    } catch {
      invalid();
    }
    await this.verify();
  }

  async read(): Promise<Uint8Array> {
    await this.operationTail;
    const before = await this.verify();
    const chunks: Buffer[] = [];
    const digest = createHash("sha256");
    let total = 0;
    try {
      let position = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(
          Math.min(1024 * 1024, this.maxBytes - total + 1),
        );
        const { bytesRead } = await this.handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        total += bytesRead;
        if (total > this.maxBytes) invalid();
        const chunk = buffer.subarray(0, bytesRead);
        chunks.push(chunk);
        digest.update(chunk);
      }
    } catch (error) {
      if (error instanceof FileStagingError) throw error;
      invalid();
    }
    const final = await this.verify();
    if (final.size !== total || !sameIdentity(before, final)) invalid();
    return new Uint8Array(Buffer.concat(chunks));
  }

  async describe(): Promise<StagedFile> {
    await this.operationTail;
    const before = await this.verify();
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (size < before.size) {
      if (this.signal?.aborted) invalid();
      const { bytesRead } = await this.handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - size),
        size,
      );
      if (!bytesRead) invalid();
      size += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (!sameIdentity(before, await this.verify())) invalid();
    return Object.freeze({
      reference: this.reference,
      size,
      sha256: digest.digest("hex") as Sha256,
    });
  }

  async seal(): Promise<StagedFile> {
    const operation = this.operationTail.then(async () => {
      if (this.signal?.aborted) invalid();
      await this.verify();
      await this.handle.sync();
      this.sealed = true;
    });
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return this.describe();
  }

  async withFile<T>(
    consume: (file: ScopedFileReader) => Promise<T>,
    options: ArtifactReadOptions = {},
  ): Promise<T> {
    const description = await this.seal();
    const scope = await openVerifiedFile(
      dirname(this.directory),
      this.reference,
      parseArtifactRef({
        sha256: description.sha256,
        byte_size: description.size,
        media_type: "application/octet-stream",
      }),
      options,
    );
    return scope.useFile(consume);
  }

  async handoff(): Promise<RelativeArtifactPath> {
    await this.operationTail;
    if (this.handedOff) return this.reference;
    await this.flush();
    this.handedOff = true;
    return this.reference;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.operationTail;
    let failure: FileStagingError | undefined;
    try {
      await this.verify();
    } catch (error) {
      failure =
        error instanceof FileStagingError ? error : new FileStagingError();
    }
    await this.handle.close().catch(() => {
      failure ??= new FileStagingError();
    });
    this.closed = true;
    activeStages.delete(join(this.directory, this.name));
    const cleanupPath = this.handedOff
      ? join(this.directory, this.name)
      : this.filePath;
    if (!this.handedOff) {
      let removed = false;
      try {
        const named = await lstat(cleanupPath);
        if (
          !named.isFile() ||
          named.nlink !== 1 ||
          named.ino !== this.initial.inode ||
          named.dev !== this.initial.device
        )
          throw new FileStagingError();
        await unlink(cleanupPath);
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") removed = true;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          failure ??=
            error instanceof FileStagingError ? error : new FileStagingError();
      }
      if (removed) this.lease?.release();
    }
    await this.directoryHandle.close().catch(() => {
      failure ??= new FileStagingError();
    });
    if (failure) throw failure;
  }

  async discard(): Promise<void> {
    await this.operationTail;
    this.handedOff = false;
    if (this.closed) {
      try {
        const named = await lstat(join(this.directory, this.name));
        if (
          !named.isFile() ||
          named.nlink !== 1 ||
          named.ino !== this.initial.inode ||
          named.dev !== this.initial.device
        )
          invalid();
        await unlink(join(this.directory, this.name));
        this.lease?.release();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          this.lease?.release();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalid();
      }
      return;
    }
    await this.close();
  }
}

export async function createStaging(
  root: string,
  options: StagingOptions = {},
): Promise<StagingFile> {
  return StagingFile.create(root, options);
}
