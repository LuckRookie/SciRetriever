import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve, parse, join } from "node:path";
import { parseArtifactRef, type ArtifactRef } from "@sciretriever/contracts";
import { isRelativeArtifactReference } from "./publication.js";

export class VerifiedReaderError extends Error {
  readonly code = "verified-artifact-read";
  constructor() {
    super("verified artifact read failed");
  }
}
export interface ArtifactReadOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
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
async function openFile(root: string, reference: string): Promise<OpenFile> {
  const handles: FileHandle[] = [];
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
    const file = await open(
      process.platform === "linux"
        ? `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`
        : join(current, parts.at(-1)!),
      FILE,
    );
    handles.push(file);
    return { file, close };
  } catch {
    await close();
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
    const initial = await file.stat({ bigint: true });
    if (
      !initial.isFile() ||
      initial.nlink !== 1n ||
      initial.size !== BigInt(expected.byte_size)
    )
      fail();
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

/** Scope-bound, read-only chunks. No descriptor or machine path crosses this boundary. */
export interface VerifiedFileScope {
  use<T>(
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
export async function openVerifiedFile(
  root: string,
  reference: string,
  value: ArtifactRef,
  options: ArtifactReadOptions = {},
): Promise<VerifiedFileScope> {
  const expected = parseArtifactRef(value);
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
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
    const identity = await scan(opened.file, expected, options.signal);
    await verifyName(root, reference, identity);
    const stream: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        if (!active || iteratorStarted) fail();
        iteratorStarted = true;
        let offset = 0;
        while (offset < expected.byte_size) {
          checkSignal(options.signal);
          if (!active) fail();
          try {
            if (!same(identity, await opened.file.stat({ bigint: true })))
              fail();
            const buffer = Buffer.allocUnsafe(
              Math.min(CHUNK, expected.byte_size - offset),
            );
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
    };
    return {
      close,
      async use<T>(
        consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
      ): Promise<T> {
        if (!active || used) fail();
        used = true;
        try {
          const result = await consume(Object.freeze(stream));
          if (!active) fail();
          active = false;
          const final = await scan(opened.file, expected, options.signal);
          if (!same(identity, final)) fail();
          await verifyName(root, reference, identity);
          return result;
        } finally {
          await close();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
