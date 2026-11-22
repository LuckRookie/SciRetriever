import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve, parse, join } from "node:path";
import { parseArtifactRef, type ArtifactRef } from "@sciretriever/contracts";
import { isRelativeArtifactReference } from "./publication.js";

export class VerifiedReaderError extends Error {
  readonly code = "verified-artifact-read";
  constructor(readonly reason: "missing" | "invalid" = "invalid") {
    super("verified artifact read failed");
  }
}
export interface ArtifactReadOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}
export interface FileFingerprint {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}
const CHUNK = 1024 * 1024;
const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
function fail(): never {
  throw new VerifiedReaderError();
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) fail();
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === 1n &&
    b.nlink === 1n &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
interface OpenFile {
  readonly file: FileHandle;
  close(): Promise<void>;
}
export interface ScopedFileReader {
  readonly size: number;
  readonly sha256: string;
  /** Only a bounded range may be materialized, independently of total file size. */
  readRange(offset: number, length: number): Promise<Uint8Array>;
  chunks(): AsyncIterable<Uint8Array>;
  withDescriptor<T>(consume: (descriptor: number) => Promise<T>): Promise<T>;
  assertUnchanged(): Promise<void>;
}
export type FileRangeChunks = (
  offset: number,
  length: number,
) => AsyncIterable<Uint8Array>;

async function openFile(root: string, reference: string): Promise<OpenFile> {
  const handles: FileHandle[] = [];
  let openingFinalName = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const results = await Promise.allSettled(
        handles
          .splice(0)
          .reverse()
          .map((h) => h.close()),
      );
      if (results.some((r) => r.status === "rejected")) fail();
    })());
  try {
    if (!root.startsWith("/") || !isRelativeArtifactReference(root, reference))
      fail();
    const absolute = resolve(root);
    const base = parse(absolute).root;
    let current = base;
    let directory = await open(base, DIRECTORY);
    handles.push(directory);
    // Every component, including the configured root, is opened without following links.
    const parts = [
      ...absolute.slice(base.length).split("/").filter(Boolean),
      ...reference.split("/"),
    ];
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      directory = await open(
        process.platform === "linux"
          ? `/proc/self/fd/${directory.fd}/${part}`
          : current,
        DIRECTORY,
      );
      handles.push(directory);
    }
    openingFinalName = true;
    const file = await open(
      process.platform === "linux"
        ? `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`
        : join(current, parts.at(-1)!),
      FILE,
    );
    handles.push(file);
    return { file, close };
  } catch (error) {
    await close();
    if (openingFinalName && (error as NodeJS.ErrnoException).code === "ENOENT")
      throw new VerifiedReaderError("missing");
    return fail();
  }
}
async function scan(
  file: FileHandle,
  expected: ArtifactRef,
  signal?: AbortSignal,
): Promise<BigIntStats> {
  try {
    checkSignal(signal);
    const initial = await sizedFileStat(file, expected.byte_size);
    const digest = createHash("sha256");
    let total = 0;
    const buffer = Buffer.allocUnsafe(CHUNK);
    while (total < expected.byte_size) {
      checkSignal(signal);
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(CHUNK, expected.byte_size - total),
        total,
      );
      if (!bytesRead) fail();
      digest.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    checkSignal(signal);
    const final = await file.stat({ bigint: true });
    if (!same(initial, final) || digest.digest("hex") !== expected.sha256)
      fail();
    return final;
  } catch {
    return fail();
  }
}
async function sizedFileStat(file: FileHandle, size: number) {
  const stat = await file.stat({ bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(size)) fail();
  return stat;
}
async function verifyName(
  root: string,
  reference: string,
  identity: BigIntStats,
): Promise<void> {
  const named = await openFile(root, reference);
  try {
    if (!same(identity, await named.file.stat({ bigint: true }))) fail();
  } catch {
    fail();
  } finally {
    await named.close();
  }
}

/** Metadata proof only; uses the same no-link path traversal as verified reads. */
export async function storedFileFingerprint(
  root: string,
  reference: string,
  signal?: AbortSignal,
): Promise<FileFingerprint> {
  checkSignal(signal);
  const opened = await openFile(root, reference);
  try {
    const stat = await opened.file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) fail();
    await verifyName(root, reference, stat);
    checkSignal(signal);
    return Object.freeze({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    });
  } finally {
    await opened.close();
  }
}

/** Scope-bound, read-only chunks. No descriptor or machine path crosses this boundary. */
export interface VerifiedFileScope {
  readonly file: ScopedFileReader;
  verify(): Promise<void>;
  use<T>(
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<T>;
  useFile<T>(consume: (file: ScopedFileReader) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface FileRangeScope {
  use<T>(consume: (chunks: FileRangeChunks) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function openVerifiedFile(
  root: string,
  reference: string,
  value: ArtifactRef,
  options: ArtifactReadOptions = {},
): Promise<VerifiedFileScope> {
  return openArtifactScope(root, reference, value, options, true);
}

/** Check the fixed size and file identity. The caller owns digest validation. */
export async function openFileForRanges(
  root: string,
  reference: string,
  value: ArtifactRef,
  options: ArtifactReadOptions = {},
): Promise<FileRangeScope> {
  const scope = await openArtifactScope(root, reference, value, options, false);
  return { use: scope.useRanges, close: scope.close };
}

async function openArtifactScope(
  root: string,
  reference: string,
  value: ArtifactRef,
  options: ArtifactReadOptions,
  verifyContents: boolean,
): Promise<
  VerifiedFileScope & {
    useRanges<T>(consume: (chunks: FileRangeChunks) => Promise<T>): Promise<T>;
  }
> {
  const expected = parseArtifactRef(value);
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    expected.byte_size < 1 ||
    expected.byte_size > maxBytes
  )
    fail();
  checkSignal(options.signal);
  const opened = await openFile(root, reference);
  let active = true;
  let iteratorStarted = false;
  let used = false;
  const close = async () => {
    active = false;
    await opened.close();
  };
  try {
    const identity = verifyContents
      ? await scan(opened.file, expected, options.signal)
      : await sizedFileStat(opened.file, expected.byte_size);
    await verifyName(root, reference, identity);
    const assertUnchanged = async () => {
      checkSignal(options.signal);
      if (!active || !same(identity, await opened.file.stat({ bigint: true })))
        fail();
      await verifyName(root, reference, identity);
    };
    const rangeChunks: FileRangeChunks = (start, length) =>
      Object.freeze({
        async *[Symbol.asyncIterator]() {
          if (!active || iteratorStarted) fail();
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(length) ||
            start < 0 ||
            length < 1 ||
            start + length > expected.byte_size
          )
            fail();
          iteratorStarted = true;
          const end = start + length;
          let offset = start;
          while (offset < end) {
            checkSignal(options.signal);
            if (!active) fail();
            try {
              if (!same(identity, await opened.file.stat({ bigint: true })))
                fail();
              const buffer = Buffer.allocUnsafe(Math.min(CHUNK, end - offset));
              const { bytesRead } = await opened.file.read(
                buffer,
                0,
                buffer.length,
                offset,
              );
              if (
                !bytesRead ||
                !same(identity, await opened.file.stat({ bigint: true }))
              )
                fail();
              offset += bytesRead;
              yield new Uint8Array(buffer.subarray(0, bytesRead));
            } catch {
              fail();
            }
          }
          if (!active) fail();
        },
      });
    const stream = rangeChunks(0, expected.byte_size);
    const file: ScopedFileReader = Object.freeze({
      size: expected.byte_size,
      sha256: expected.sha256,
      assertUnchanged,
      chunks: () => stream,
      async readRange(offset: number, length: number) {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          length > 2 * CHUNK ||
          offset + length > expected.byte_size
        )
          fail();
        await assertUnchanged();
        const bytes = Buffer.alloc(length);
        let total = 0;
        while (total < length) {
          checkSignal(options.signal);
          const { bytesRead } = await opened.file.read(
            bytes,
            total,
            length - total,
            offset + total,
          );
          if (!bytesRead) fail();
          total += bytesRead;
        }
        await assertUnchanged();
        return new Uint8Array(bytes);
      },
      async withDescriptor<T>(consume: (descriptor: number) => Promise<T>) {
        await assertUnchanged();
        // The inherited descriptor is read-only and belongs to this callback only.
        const readonly = await open(
          `/proc/self/fd/${opened.file.fd}`,
          constants.O_RDONLY,
        );
        try {
          if (!same(identity, await readonly.stat({ bigint: true }))) fail();
          const result = await consume(readonly.fd);
          await assertUnchanged();
          return result;
        } finally {
          await readonly.close();
        }
      },
    });
    const verify = async () => {
      await assertUnchanged();
      if (!verifyContents) return;
      const final = await scan(opened.file, expected, options.signal);
      if (!same(identity, final)) fail();
      await verifyName(root, reference, identity);
    };
    const useFile = async <T>(
      consume: (file: ScopedFileReader) => Promise<T>,
    ) => {
      if (!active || used) fail();
      used = true;
      try {
        const result = await consume(file);
        await verify();
        return result;
      } finally {
        await close();
      }
    };
    return {
      file,
      verify,
      close,
      useFile,
      async use<T>(
        consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
      ): Promise<T> {
        return useFile(() => consume(stream));
      },
      useRanges: (consume) => useFile(() => consume(rangeChunks)),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Inspect unknown existing bytes without reading them into one array. */
export async function describeStoredFile(
  root: string,
  reference: string,
  options: ArtifactReadOptions = {},
): Promise<{ readonly sha256: string; readonly size: number }> {
  const opened = await openFile(root, reference);
  try {
    const before = await opened.file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(options.maxBytes ?? Number.MAX_SAFE_INTEGER)
    )
      fail();
    const size = Number(before.size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    let offset = 0;
    while (offset < size) {
      checkSignal(options.signal);
      const { bytesRead } = await opened.file.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (!bytesRead) fail();
      offset += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (!same(before, await opened.file.stat({ bigint: true }))) fail();
    await verifyName(root, reference, before);
    return { sha256: hash.digest("hex"), size };
  } finally {
    await opened.close();
  }
}
