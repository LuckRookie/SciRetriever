import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  mkdir,
  readdir,
  open,
  lstat,
  link,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, relative, resolve, sep, join } from "node:path";

import type { RelativeArtifactPath, Sha256 } from "@sciretriever/contracts";
import { acquireFileLock } from "../locking.js";
import { FileStagingError, type StagingFile } from "./staging.js";
import {
  describeStoredFile,
  openVerifiedFile,
  VerifiedReaderError,
  type ArtifactReadOptions,
  type VerifiedFileScope,
} from "./reader.js";
import { parseArtifactRef } from "@sciretriever/contracts";
import type { TemporaryFileLease } from "./budget.js";

export class FilePublicationError extends Error {
  readonly code = "file-publication" as const;
  readonly conflict: boolean;
  constructor(conflict = false, cause?: unknown) {
    super("file publication operation failed", { cause });
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
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (creation) {
        if ((creation as NodeJS.ErrnoException).code !== "EEXIST")
          throw creation;
      }
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

export class FilePublicationRetryError extends Error {
  constructor() {
    super("publication destination changed during preparation");
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === 1n &&
    b.nlink === 1n &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
async function openDirectories(path: string): Promise<FileHandle[]> {
  const handles: FileHandle[] = [];
  try {
    handles.push(
      await open("/", constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW),
    );
    for (const part of path.split("/").filter(Boolean))
      handles.push(
        await open(
          `/proc/self/fd/${handles.at(-1)!.fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW,
        ),
      );
    return handles;
  } catch {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    return invalid();
  }
}

/** Private copied bytes and live read-only source guards. Large work finishes before admission. */
export class PreparedFilePublication {
  private existing: VerifiedFileScope | null = null;
  private closed = false;
  private published = false;
  private adopted = false;
  private readonly sourceGuards = new Set<VerifiedFileScope>();
  private readonly temporaryPath: string;
  private readonly targetPath: string;
  private constructor(
    private readonly root: string,
    private readonly stage: StagingFile,
    readonly reference: RelativeArtifactPath,
    readonly sha256: Sha256,
    readonly size: number,
    private readonly source: VerifiedFileScope,
    private readonly output: FileHandle,
    private readonly identity: BigIntStats,
    private readonly directories: FileHandle[],
    private readonly parentPath: string,
    temporaryName: string,
    private readonly dependencies: PublicationDependencies,
    private readonly options: ArtifactReadOptions,
    private readonly lease: TemporaryFileLease | undefined,
  ) {
    const anchored = `/proc/self/fd/${directories.at(-1)!.fd}`;
    this.temporaryPath = join(anchored, temporaryName);
    this.targetPath = join(anchored, reference.split("/").at(-1)!);
  }

  static async create(
    rootValue: string,
    stage: StagingFile,
    targetReference: string,
    dependencies: PublicationDependencies = {},
    options: ArtifactReadOptions = {},
  ): Promise<PreparedFilePublication> {
    if (!rootValue.startsWith("/")) invalid();
    const root = resolve(rootValue);
    const target = safeReference(root, targetReference);
    const parent = dirname(target);
    const description = await stage.seal();
    const expected = parseArtifactRef({
      sha256: description.sha256,
      byte_size: description.size,
      media_type: "application/octet-stream",
    });
    const source = await openVerifiedFile(
      root,
      stage.reference,
      expected,
      options,
    );
    let directories: FileHandle[] = [];
    let output: FileHandle | undefined;
    let temporaryPath: string | undefined;
    let lease: TemporaryFileLease | undefined;
    try {
      await ensureDirectoryChain(root, parent);
      directories = await openDirectories(parent);
      const temporaryName = `.sciretriever-publication-${randomUUID()}`;
      temporaryPath = `/proc/self/fd/${directories.at(-1)!.fd}/${temporaryName}`;
      output = await open(
        temporaryPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      lease = stage.temporaryBudget?.open(parent, "publication-preparation");
      const hash = createHash("sha256");
      let position = 0;
      for await (const chunk of source.file.chunks()) {
        await lease?.reserve(position + chunk.length);
        let offset = 0;
        while (offset < chunk.length) {
          if (options.signal?.aborted) invalid();
          const result = dependencies.write
            ? await dependencies.write(output, chunk, offset)
            : await output.write(
                chunk,
                offset,
                chunk.length - offset,
                position + offset,
              );
          if (
            result.bytesWritten <= 0 ||
            result.bytesWritten > chunk.length - offset
          )
            invalid();
          offset += result.bytesWritten;
          lease?.written(position + offset);
        }
        hash.update(chunk);
        position += chunk.length;
      }
      await source.verify();
      if (
        position !== description.size ||
        hash.digest("hex") !== description.sha256
      )
        invalid();
      if (dependencies.syncFile) await dependencies.syncFile(output);
      else await output.sync();
      const outputScope = await openVerifiedFile(
        root,
        relative(root, join(parent, temporaryName)),
        expected,
        options,
      );
      await outputScope.close();
      const identity = await output.stat({ bigint: true });
      if (
        !identity.isFile() ||
        identity.nlink !== 1n ||
        identity.size !== BigInt(position)
      )
        invalid();
      const prepared = new PreparedFilePublication(
        root,
        stage,
        targetReference as RelativeArtifactPath,
        description.sha256,
        description.size,
        source,
        output,
        identity,
        directories,
        parent,
        temporaryName,
        dependencies,
        options,
        lease,
      );
      await prepared.refreshDestination();
      return prepared;
    } catch (error) {
      if (temporaryPath && output) {
        const current = await output.stat().catch(() => undefined);
        if (current)
          await removeOwnedFile(
            temporaryPath,
            Number(current.dev),
            Number(current.ino),
          );
      }
      const unlinked =
        output && (await output.stat().catch(() => undefined))?.nlink === 0;
      await Promise.allSettled([
        source.close(),
        output?.close(),
        ...directories.map((handle) => handle.close()),
      ]);
      if (unlinked) lease?.release();
      if (
        error instanceof FileStagingError ||
        error instanceof FilePublicationError
      )
        throw error;
      throw new FilePublicationError(false, error);
    }
  }

  async refreshDestination(): Promise<void> {
    if (this.closed || this.published || this.options.signal?.aborted)
      invalid();
    await this.existing?.close();
    this.existing = null;
    const key = `publish-${createHash("sha256").update(this.reference).digest("hex")}`;
    const lock = await acquirePublicationLock(this.root, key);
    try {
      await this.recoverInterruptedLink();
      const existing = await describeStoredFile(
        this.root,
        this.reference,
        this.options,
      );
      this.existing = await openVerifiedFile(
        this.root,
        this.reference,
        parseArtifactRef({
          sha256: existing.sha256,
          byte_size: existing.size,
          media_type: "application/octet-stream",
        }),
        this.options,
      );
    } catch (error) {
      if (error instanceof VerifiedReaderError && error.reason === "missing")
        return;
      throw error;
    } finally {
      await lock.release();
    }
  }

  private async recoverInterruptedLink(): Promise<void> {
    let target: BigIntStats;
    try {
      target = await lstat(this.targetPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (target.nlink !== 2n) return;
    if (
      !target.isFile() ||
      target.uid !== BigInt(process.getuid!()) ||
      (target.mode & 0o777n) !== 0o600n
    )
      invalid();
    const parent = `/proc/self/fd/${this.directories.at(-1)!.fd}`;
    const matches: string[] = [];
    for (const name of await readdir(parent)) {
      if (
        !/^\.sciretriever-publication-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
          name,
        )
      )
        continue;
      const metadata = await lstat(join(parent, name), { bigint: true });
      if (
        metadata.isFile() &&
        metadata.dev === target.dev &&
        metadata.ino === target.ino &&
        metadata.nlink === 2n
      )
        matches.push(name);
    }
    if (matches.length !== 1) invalid();
    const current = await lstat(this.targetPath, { bigint: true });
    if (
      current.dev !== target.dev ||
      current.ino !== target.ino ||
      current.nlink !== 2n ||
      current.ctimeNs !== target.ctimeNs ||
      current.mtimeNs !== target.mtimeNs ||
      current.size !== target.size
    )
      invalid();
    // A crash after exclusive link can leave precisely our private preparation entry.
    // Only unlink that reserved entry; keep the complete target for receipt reconciliation.
    await unlink(join(parent, matches[0]!));
    await this.directories.at(-1)!.sync();
  }

  retainSourceGuard(scope: VerifiedFileScope): void {
    if (
      this.closed ||
      this.published ||
      scope.file.sha256 !== this.sha256 ||
      scope.file.size !== this.size
    )
      invalid();
    this.sourceGuards.add(scope);
  }

  /** Only identity checks, exclusive linking and fsync occur under the catalog admission. */
  async commit(): Promise<PublishedFile> {
    if (this.closed || this.published || this.options.signal?.aborted)
      invalid();
    const key = `publish-${createHash("sha256").update(this.reference).digest("hex")}`;
    const lock = await acquirePublicationLock(this.root, key);
    let created = false;
    try {
      await this.source.file.assertUnchanged();
      for (const guard of this.sourceGuards) await guard.file.assertUnchanged();
      const fresh = await openDirectories(this.parentPath);
      try {
        const a = await fresh.at(-1)!.stat({ bigint: true });
        const b = await this.directories.at(-1)!.stat({ bigint: true });
        if (a.dev !== b.dev || a.ino !== b.ino) invalid();
      } finally {
        await Promise.all(fresh.map((handle) => handle.close()));
      }
      if (
        !sameFile(this.identity, await this.output.stat({ bigint: true })) ||
        !sameFile(
          this.identity,
          await lstat(this.temporaryPath, { bigint: true }),
        )
      )
        invalid();
      if (this.existing) {
        try {
          await this.existing.file.assertUnchanged();
        } catch {
          throw new FilePublicationRetryError();
        }
        if (
          this.existing.file.sha256 !== this.sha256 ||
          this.existing.file.size !== this.size
        ) {
          await preserveConflictEvidence(
            this.root,
            this.reference,
            this.existing.file.sha256 as Sha256,
            this.sha256,
          );
          invalid(true);
        }
      } else {
        try {
          await link(this.temporaryPath, this.targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new FilePublicationRetryError();
          throw error;
        }
        created = true;
        await unlink(this.temporaryPath);
        if (this.dependencies.syncDirectory)
          await this.dependencies.syncDirectory(this.parentPath);
        else await this.directories.at(-1)!.sync();
      }
      await this.stage.discard();
      this.published = true;
      if (created) {
        this.adopted = true;
        this.lease?.release();
      }
      return Object.freeze({
        reference: this.reference,
        sha256: this.sha256,
        size: this.size,
        created,
      });
    } catch (error) {
      if (created)
        await removeOwnedFile(
          this.targetPath,
          Number(this.identity.dev),
          Number(this.identity.ino),
        );
      if (
        error instanceof FilePublicationRetryError ||
        error instanceof FilePublicationError ||
        error instanceof FileStagingError
      )
        throw error;
      return invalid();
    } finally {
      await lock.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await removeOwnedFile(
      this.temporaryPath,
      Number(this.identity.dev),
      Number(this.identity.ino),
    );
    const unlinked =
      (await this.output.stat().catch(() => undefined))?.nlink === 0;
    const results = await Promise.allSettled([
      this.source.close(),
      this.existing?.close(),
      this.output.close(),
      ...[...this.sourceGuards].map((scope) => scope.close()),
      ...this.directories.map((handle) => handle.close()),
    ]);
    if (unlinked || this.adopted) this.lease?.release();
    if (results.some((result) => result.status === "rejected")) invalid();
  }
}

export async function publishStagedFile(
  rootValue: string,
  stage: StagingFile,
  targetReference: string,
  dependencies: PublicationDependencies = {},
): Promise<PublishedFile> {
  const prepared = await PreparedFilePublication.create(
    rootValue,
    stage,
    targetReference,
    dependencies,
  );
  try {
    return await settlePreparedPublication(prepared, () => prepared.commit());
  } finally {
    await prepared.close();
  }
}

/** Destination races are retried outside admission; a permanently changing name is a stable failure. */
export async function settlePreparedPublication<T>(
  prepared: PreparedFilePublication,
  commit: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await commit();
    } catch (error) {
      if (!(error instanceof FilePublicationRetryError)) throw error;
      if (attempt === 2) throw new FilePublicationError(false, error);
      await prepared.refreshDestination();
    }
  }
  return invalid();
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
