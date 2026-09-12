import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  open,
  mkdir,
  lstat,
  rename,
  unlink,
  readdir,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { parseArtifactRef, type ArtifactRef } from "@sciretriever/contracts";
import type { RetiredArtifact } from "../../literature/cleanup.js";
import type { CatalogWriteAdmission } from "../write-admission.js";
import { isRelativeArtifactReference } from "./publication.js";

export class ArtifactReclamationError extends Error {
  readonly code = "artifact-reclamation";
  constructor() {
    super("artifact reclamation failed; evidence retained");
  }
}
export interface ReclamationRepository {
  isArtifactUnregistered(value: RetiredArtifact): Promise<boolean>;
}
export interface ReclamationOptions {
  readonly signal?: AbortSignal;
  /** Fault injection and deterministic race tests; never receives paths or bytes. */
  readonly checkpoint?: (
    stage: "verified" | "quarantined" | "unlinked",
  ) => Promise<void>;
}
const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const MAX_BYTES = 512 * 1024 * 1024;
function fail(): never {
  throw new ArtifactReclamationError();
}
function inode(s: BigIntStats) {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
}
async function stat(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function chain(path: string): Promise<FileHandle[]> {
  const handles: FileHandle[] = [];
  try {
    handles.push(await open("/", DIRECTORY));
    for (const part of path.split("/").filter(Boolean))
      handles.push(
        await open(`/proc/self/fd/${handles.at(-1)!.fd}/${part}`, DIRECTORY),
      );
    return handles;
  } catch (error) {
    await Promise.allSettled(handles.map((h) => h.close()));
    throw error;
  }
}
async function scan(
  file: FileHandle,
  expected: ArtifactRef,
  signal?: AbortSignal,
): Promise<BigIntStats> {
  const before = await file.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size !== BigInt(expected.byte_size)
  )
    fail();
  const digest = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < expected.byte_size) {
    if (signal?.aborted) fail();
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, expected.byte_size - offset),
      offset,
    );
    if (!bytesRead) fail();
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await file.stat({ bigint: true });
  if (
    inode(before) !== inode(after) ||
    before.ctimeNs !== after.ctimeNs ||
    after.nlink !== 1n ||
    digest.digest("hex") !== expected.sha256
  )
    fail();
  return after;
}

/** Explicit retired descriptors only. No directory sweep or deletion of technical rows. */
export class ArtifactReclaimer {
  constructor(
    private readonly root: string,
    private readonly repository: ReclamationRepository,
    private readonly admission: CatalogWriteAdmission,
  ) {}
  reclaim(
    values: readonly RetiredArtifact[],
    options: ReclamationOptions = {},
  ): Promise<{
    readonly deleted: readonly string[];
    readonly preserved: readonly string[];
    readonly missing: readonly string[];
  }> {
    const copy = structuredClone(values);
    return this.admission.run(async () => {
      try {
        if (
          process.platform !== "linux" ||
          resolve(this.root) !== this.root ||
          !Array.isArray(copy) ||
          copy.length > 10000
        )
          fail();
        const unique = new Map<string, RetiredArtifact>();
        for (const value of copy) {
          const artifact = parseArtifactRef(value.artifact);
          if (
            !isRelativeArtifactReference(this.root, value.reference) ||
            !/^(objects|\.objects|\.candidates)\//.test(value.reference) ||
            artifact.byte_size < 1 ||
            artifact.byte_size > MAX_BYTES
          )
            fail();
          const previous = unique.get(value.reference);
          if (
            previous &&
            JSON.stringify(previous.artifact) !== JSON.stringify(artifact)
          )
            fail();
          unique.set(value.reference, { reference: value.reference, artifact });
        }
        const deleted: string[] = [],
          preserved: string[] = [],
          missing: string[] = [];
        for (const value of unique.values()) {
          if (options.signal?.aborted) fail();
          if (!(await this.repository.isArtifactUnregistered(value))) {
            preserved.push(value.reference);
            continue;
          }
          const outcome = await this.remove(value, options);
          (outcome === "deleted" ? deleted : missing).push(value.reference);
        }
        return { deleted, preserved, missing };
      } catch {
        return fail();
      }
    }, options.signal);
  }
  private async remove(
    value: RetiredArtifact,
    options: ReclamationOptions,
  ): Promise<"deleted" | "missing"> {
    const parentPath = dirname(resolve(this.root, value.reference));
    const handles = await chain(parentPath);
    const parent = handles.at(-1)!,
      parentIdentity = await parent.stat({ bigint: true });
    const original = `/proc/self/fd/${parent.fd}/${basename(value.reference)}`;
    const key = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    const quarantinePath = `/proc/self/fd/${parent.fd}/.reclaim-${key}`;
    const bound = async () => {
      const fresh = await chain(parentPath);
      try {
        const s = await fresh.at(-1)!.stat({ bigint: true });
        if (s.dev !== parentIdentity.dev || s.ino !== parentIdentity.ino)
          fail();
      } finally {
        await Promise.all(fresh.map((h) => h.close()));
      }
    };
    try {
      let directory = await stat(quarantinePath);
      let originalStat = await stat(original);
      if (!directory && !originalStat) return "missing";
      if (!directory) {
        await mkdir(quarantinePath, { mode: 0o700 });
        await parent.sync();
        directory = await stat(quarantinePath);
      }
      if (!directory?.isDirectory()) fail();
      const quarantine = await open(quarantinePath, DIRECTORY);
      handles.push(quarantine);
      const qStat = await quarantine.stat({ bigint: true });
      if (qStat.dev !== directory.dev || qStat.ino !== directory.ino) fail();
      const q = `/proc/self/fd/${quarantine.fd}`;
      const quarantined = await stat(`${q}/object`);
      const markerStat = await stat(`${q}/identity.json`);
      let markerIdentity: BigIntStats | undefined;
      const finish = async () => {
        await bound();
        const named = await stat(quarantinePath);
        if (
          !named?.isDirectory() ||
          named.dev !== qStat.dev ||
          named.ino !== qStat.ino
        )
          fail();
        const names = await readdir(q);
        if (markerIdentity) {
          if (names.length !== 1 || names[0] !== "identity.json") fail();
          const marker = await stat(`${q}/identity.json`);
          if (
            !marker?.isFile() ||
            marker.nlink !== 1n ||
            inode(marker) !== inode(markerIdentity)
          )
            fail();
          await unlink(`${q}/identity.json`);
          await quarantine.sync();
        } else if (names.length !== 0) fail();
        await rmdir(quarantinePath);
        await parent.sync();
      };
      if (!quarantined && !originalStat && !markerStat) {
        await finish();
        return "missing";
      }
      let marker: {
        reference: string;
        artifact: ArtifactRef;
        identity: string;
      };
      if (markerStat) {
        if (
          !markerStat.isFile() ||
          markerStat.nlink !== 1n ||
          markerStat.size > 4096n
        )
          fail();
        const file = await open(`${q}/identity.json`, FILE);
        handles.push(file);
        const openedMarker = await file.stat({ bigint: true });
        if (
          !openedMarker.isFile() ||
          openedMarker.nlink !== 1n ||
          inode(openedMarker) !== inode(markerStat)
        )
          fail();
        markerIdentity = openedMarker;
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        marker = JSON.parse(
          buffer.subarray(0, bytesRead).toString(),
        ) as typeof marker;
        if (
          JSON.stringify({
            reference: marker.reference,
            artifact: marker.artifact,
          }) !== JSON.stringify(value) ||
          typeof marker.identity !== "string"
        )
          fail();
      } else {
        if (quarantined || !originalStat) fail();
        const source = await open(original, FILE);
        handles.push(source);
        originalStat = await scan(source, value.artifact, options.signal);
        marker = { ...value, identity: inode(originalStat) };
        const file = await open(
          `${q}/identity.json`,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        handles.push(file);
        await file.writeFile(JSON.stringify(marker));
        await file.sync();
        await quarantine.sync();
        markerIdentity = await file.stat({ bigint: true });
      }
      if (!quarantined && !originalStat) {
        await finish();
        return "missing";
      }
      // Never overwrite an existing quarantined object. An unexpected new original is preserved.
      if (quarantined && originalStat) fail();
      const file = await open(quarantined ? `${q}/object` : original, FILE);
      handles.push(file);
      const verified = await scan(file, value.artifact, options.signal);
      if (inode(verified) !== marker.identity) fail();
      await options.checkpoint?.("verified");
      await bound();
      const namedDirectory = await stat(quarantinePath);
      if (
        !namedDirectory ||
        namedDirectory.dev !== qStat.dev ||
        namedDirectory.ino !== qStat.ino
      )
        fail();
      if (!quarantined) {
        if (await stat(`${q}/object`)) fail();
        await rename(original, `${q}/object`);
        await quarantine.sync();
        await parent.sync();
      }
      await options.checkpoint?.("quarantined");
      const moved = await stat(`${q}/object`);
      const rescanned = await scan(file, value.artifact, options.signal);
      if (
        !moved?.isFile() ||
        moved.nlink !== 1n ||
        inode(moved) !== inode(rescanned) ||
        inode(moved) !== marker.identity
      )
        fail();
      await bound();
      const finalDirectory = await stat(quarantinePath);
      const finalName = await stat(`${q}/object`);
      if (
        !finalDirectory?.isDirectory() ||
        finalDirectory.dev !== qStat.dev ||
        finalDirectory.ino !== qStat.ino ||
        !finalName?.isFile() ||
        finalName.nlink !== 1n ||
        inode(finalName) !== marker.identity
      )
        fail();
      await unlink(`${q}/object`);
      await quarantine.sync();
      await options.checkpoint?.("unlinked");
      // Completed cleanup keeps no durable record of the rejected PDF. Interrupted/conflicting work retains its marker.
      await finish();
      return "deleted";
    } finally {
      const results = await Promise.allSettled(
        handles.reverse().map((h) => h.close()),
      );
      if (results.some((r) => r.status === "rejected")) fail();
    }
  }
}
