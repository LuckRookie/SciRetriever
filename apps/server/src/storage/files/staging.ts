import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RelativeArtifactPath, Sha256 } from "@sciretriever/contracts";

export class FileStagingError extends Error {
  readonly code = "file-staging" as const;
  constructor() {
    super("file staging operation failed");
    this.name = "FileStagingError";
  }
}

export interface StagingIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly links: number;
  readonly mtimeMs: number;
}

export interface StagedFile {
  readonly reference: RelativeArtifactPath;
  readonly size: number;
  readonly sha256: Sha256;
}
export interface StagingOptions {
  readonly maxBytes?: number;
}

const STAGING_DIRECTORY = ".staging";
const MAX_BYTES = 512 * 1024 * 1024;
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
  };
}
function sameIdentity(left: StagingIdentity, right: StagingIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.links === right.links &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}
function directoryIdentity(
  value: Awaited<ReturnType<FileHandle["stat"]>>,
): Pick<StagingIdentity, "device" | "inode"> {
  if (!value.isDirectory()) invalid();
  return { device: Number(value.dev), inode: Number(value.ino) };
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
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    directory: string,
    directoryHandle: FileHandle,
    directoryInitial: Pick<StagingIdentity, "device" | "inode">,
    name: string,
    handle: FileHandle,
    initial: StagingIdentity,
    maxBytes: number,
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
      if (this.handedOff) invalid();
      const current = await this.verify();
      if (current.size + bytes.byteLength > this.maxBytes) invalid();
      let offset = 0;
      while (offset < bytes.byteLength) {
        let written: number;
        try {
          ({ bytesWritten: written } = await this.handle.write(bytes, offset));
        } catch {
          invalid();
        }
        if (written <= 0) invalid();
        offset += written;
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
    const bytes = await this.read();
    const digest = createHash("sha256").update(bytes).digest("hex") as Sha256;
    return Object.freeze({
      reference: this.reference,
      size: bytes.byteLength,
      sha256: digest,
    });
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
    const cleanupPath = this.handedOff
      ? join(this.directory, this.name)
      : this.filePath;
    if (!this.handedOff) {
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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          failure ??=
            error instanceof FileStagingError ? error : new FileStagingError();
      }
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
      } catch (error) {
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
