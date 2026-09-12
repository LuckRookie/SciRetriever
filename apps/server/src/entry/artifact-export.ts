import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  link,
  rename,
  unlink,
  lstat,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve, isAbsolute } from "node:path";
import { parseAsset, parseArtifactRef } from "@sciretriever/contracts";
import type {
  LiteratureArtifactService,
  ArtifactReadOptions,
} from "../literature/artifacts.js";

export class ArtifactExportError extends Error {
  readonly code = "artifact-export";
  constructor(readonly published = false) {
    super("artifact export failed");
  }
}

/** Publish caller-owned bytes to an external target with the same atomic,
 * no-clobber semantics as artifact export. The bytes are never entered into
 * the catalog and the target is required to be an absolute path. */
export async function exportBytes(
  bytes: Uint8Array,
  target: string,
  options: { readonly overwrite?: boolean } = {},
): Promise<void> {
  if (
    !(bytes instanceof Uint8Array) ||
    !isAbsolute(target) ||
    target !== resolve(target)
  )
    throw new ArtifactExportError();
  const parentPath = dirname(target);
  let parent: FileHandle | undefined;
  let stage: FileHandle | undefined;
  let stagePath: string | undefined;
  let failed = false;
  try {
    parent = await directory(parentPath);
    const anchored =
      process.platform === "linux" ? `/proc/self/fd/${parent.fd}` : parentPath;
    stagePath = join(anchored, `.sciretriever-export-${randomUUID()}`);
    stage = await open(
      stagePath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await stage.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (!bytesWritten) throw new ArtifactExportError();
      offset += bytesWritten;
    }
    await stage.sync();
    const targetPath = join(anchored, basename(target));
    if (options.overwrite === true) {
      await rename(stagePath, targetPath);
      stagePath = undefined;
    } else {
      await link(stagePath, targetPath);
    }
    if (stagePath) {
      await unlink(stagePath);
      stagePath = undefined;
    }
    await parent.sync();
  } catch {
    failed = true;
  } finally {
    if (stagePath) await unlink(stagePath).catch(() => undefined);
    await stage?.close().catch(() => undefined);
    await parent?.close().catch(() => undefined);
  }
  if (failed) throw new ArtifactExportError();
}
export interface ArtifactExportOptions extends ArtifactReadOptions {
  readonly overwrite?: boolean;
}
const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
async function directory(path: string): Promise<FileHandle> {
  let handle = await open(parse(path).root, DIRECTORY);
  try {
    let current = parse(path).root;
    for (const part of path.slice(current.length).split("/").filter(Boolean)) {
      current = join(current, part);
      const next = await open(
        process.platform === "linux"
          ? `/proc/self/fd/${handle.fd}/${part}`
          : current,
        DIRECTORY,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Explicit external I/O at Entry. The target never enters catalog facts or query DTOs. */
export async function exportArtifact(
  reader: Pick<LiteratureArtifactService, "withArtifact">,
  value: unknown,
  target: string,
  options: ArtifactExportOptions = {},
): Promise<void> {
  const descriptor =
    value && typeof value === "object" && "asset_id" in value
      ? parseAsset(value)
      : parseArtifactRef(value);
  const expectedSize =
    "asset_id" in descriptor ? descriptor.size_bytes : descriptor.byte_size;
  let parent: FileHandle | undefined, stage: FileHandle | undefined;
  let stagePath: string | undefined;
  let stageIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
  let published = false;
  let failed = false;
  let cleanupFailed = false;
  try {
    if (
      !isAbsolute(target) ||
      target !== resolve(target) ||
      options.signal?.aborted
    )
      throw new ArtifactExportError();
    const parentPath = dirname(target);
    parent = await directory(parentPath);
    const identity = await parent.stat({ bigint: true });
    const anchored =
      process.platform === "linux" ? `/proc/self/fd/${parent.fd}` : parentPath;
    const targetPath = join(anchored, basename(target));
    stagePath = join(anchored, `.sciretriever-export-${randomUUID()}`);
    stage = await open(
      stagePath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    stageIdentity = await stage.stat({ bigint: true });
    let size = 0;
    const digest = createHash("sha256");
    const output = stage;
    await reader.withArtifact(
      descriptor,
      async (chunks) => {
        for await (const chunk of chunks) {
          if (options.signal?.aborted || size + chunk.length > expectedSize)
            throw new ArtifactExportError();
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await output.write(
              chunk,
              offset,
              chunk.length - offset,
              size + offset,
            );
            if (!bytesWritten) throw new ArtifactExportError();
            offset += bytesWritten;
          }
          digest.update(chunk);
          size += chunk.length;
        }
      },
      options,
    );
    if (size !== expectedSize || digest.digest("hex") !== descriptor.sha256)
      throw new ArtifactExportError();
    await stage.sync();
    // Re-read the staged descriptor before the atomic external publication.
    const check = createHash("sha256");
    let offset = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (offset < expectedSize) {
      if (options.signal?.aborted) throw new ArtifactExportError();
      const { bytesRead } = await stage.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - offset),
        offset,
      );
      if (!bytesRead) throw new ArtifactExportError();
      check.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const staged = await stage.stat({ bigint: true });
    if (
      !staged.isFile() ||
      staged.nlink !== 1n ||
      staged.size !== BigInt(expectedSize) ||
      check.digest("hex") !== descriptor.sha256
    )
      throw new ArtifactExportError();
    const namedStage = await lstat(stagePath, { bigint: true });
    if (
      !namedStage.isFile() ||
      namedStage.dev !== staged.dev ||
      namedStage.ino !== staged.ino ||
      namedStage.nlink !== 1n ||
      namedStage.size !== staged.size ||
      namedStage.mtimeNs !== staged.mtimeNs ||
      namedStage.ctimeNs !== staged.ctimeNs
    )
      throw new ArtifactExportError();
    const currentParent = await directory(parentPath);
    try {
      const current = await currentParent.stat({ bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino)
        throw new ArtifactExportError();
    } finally {
      await currentParent.close();
    }
    if (options.signal?.aborted) throw new ArtifactExportError();
    if (options.overwrite === true) {
      await rename(stagePath, targetPath);
      stagePath = undefined;
    } else {
      await link(stagePath, targetPath);
    }
    published = true;
    if (stagePath) {
      await unlink(stagePath);
      stagePath = undefined;
    }
    await parent.sync();
  } catch {
    failed = true;
  } finally {
    if (stagePath && stageIdentity) {
      try {
        const named = await lstat(stagePath, { bigint: true });
        if (named.dev === stageIdentity.dev && named.ino === stageIdentity.ino)
          await unlink(stagePath);
        else cleanupFailed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          cleanupFailed = true;
      }
    }
    const closed = await Promise.allSettled([stage?.close(), parent?.close()]);
    cleanupFailed ||= closed.some((r) => r.status === "rejected");
  }
  if (failed || cleanupFailed) throw new ArtifactExportError(published);
}
