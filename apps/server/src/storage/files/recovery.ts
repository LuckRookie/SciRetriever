import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  open,
  readdir,
  lstat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";
import { parseArtifactRef } from "@sciretriever/contracts";
import type { RetiredArtifact } from "../../literature/cleanup.js";
import type { CatalogWriteAdmission } from "../write-admission.js";
import type { FileStore } from "./store.js";
import type { ArtifactReclaimer } from "./reclamation.js";
import { isRelativeArtifactReference } from "./publication.js";

const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACTS = 10000;
export class ArtifactRecoveryError extends Error {
  readonly code = "artifact-recovery";
  constructor() {
    super("artifact recovery failed; recovery evidence retained");
  }
}
function fail(): never {
  throw new ArtifactRecoveryError();
}
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.isFile() &&
    b.isFile() &&
    a.nlink === 1n &&
    b.nlink === 1n &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
export interface ReclamationTicket {
  readonly reference: string;
  readonly artifacts: readonly RetiredArtifact[];
}
/** Temporary technical write-ahead manifests. They contain no Literature, source, receipt, or invalidity decision. */
export class ArtifactRecovery {
  private readonly catalogKey: string;
  constructor(
    private readonly files: FileStore,
    private readonly reclaimer: ArtifactReclaimer,
    private readonly writes: CatalogWriteAdmission,
  ) {
    this.catalogKey = createHash("sha256")
      .update(writes.catalogPath)
      .digest("hex");
  }
  private encode(values: readonly RetiredArtifact[]): {
    bytes: Buffer;
    ticket: ReclamationTicket;
  } {
    if (!Array.isArray(values) || values.length > MAX_ARTIFACTS) fail();
    const unique = new Map<string, RetiredArtifact>();
    for (const v of values) {
      if (
        !v ||
        Object.keys(v).sort().join() !== "artifact,reference" ||
        !isRelativeArtifactReference(this.files.root, v.reference) ||
        !/^(objects|\.objects|\.candidates)\//.test(v.reference)
      )
        fail();
      const value = {
        reference: v.reference,
        artifact: parseArtifactRef(v.artifact),
      };
      if (
        value.artifact.byte_size < 1 ||
        value.artifact.byte_size > 512 * 1024 * 1024
      )
        fail();
      const old = unique.get(value.reference);
      if (old && JSON.stringify(old) !== JSON.stringify(value)) fail();
      unique.set(value.reference, value);
    }
    const artifacts = [...unique.values()].sort((a, b) =>
      a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
    );
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, catalog_key: this.catalogKey, artifacts }),
    );
    if (bytes.length > MAX_BYTES) fail();
    const hash = createHash("sha256").update(bytes).digest("hex");
    return {
      bytes,
      ticket: { reference: `.reclamation/${hash}.json`, artifacts },
    };
  }
  prepare(values: readonly RetiredArtifact[]): Promise<ReclamationTicket> {
    const copy = structuredClone(values);
    return this.writes.run(async () => {
      try {
        const { bytes, ticket } = this.encode(copy);
        const stage = await this.files.stage({ maxBytes: MAX_BYTES });
        try {
          await stage.write(bytes);
          await this.files.publish(stage, ticket.reference);
        } finally {
          await stage.discard();
        }
        return ticket;
      } catch {
        return fail();
      }
    });
  }
  complete(
    ticket: ReclamationTicket,
  ): Promise<Awaited<ReturnType<ArtifactReclaimer["reclaim"]>>> {
    const copy = structuredClone(ticket);
    return this.writes.run(async () => {
      try {
        const expected = this.encode(copy.artifacts);
        if (copy.reference !== expected.ticket.reference) fail();
        const results = await this.withDirectory(async (directory) => {
          const name = copy.reference.slice(".reclamation/".length);
          return this.process(directory, name, expected.bytes);
        });
        if (!results) fail();
        return results;
      } catch {
        return fail();
      }
    });
  }
  recover(): Promise<
    readonly {
      readonly reference: string;
      readonly result: Awaited<ReturnType<ArtifactReclaimer["reclaim"]>>;
    }[]
  > {
    return this.writes.run(async () => {
      try {
        return (
          (await this.withDirectory(async (directory) => {
            const names = await readdir(`/proc/self/fd/${directory.fd}`);
            if (names.some((n) => !/^[0-9a-f]{64}\.json$/.test(n))) fail();
            const results = [];
            for (const name of names.sort())
              results.push({
                reference: `.reclamation/${name}`,
                result: await this.process(directory, name),
              });
            return results;
          })) ?? []
        );
      } catch {
        return fail();
      }
    });
  }
  private async withDirectory<T>(
    operation: (directory: FileHandle) => Promise<T>,
  ): Promise<T | null> {
    if (
      process.platform !== "linux" ||
      resolve(this.files.root) !== this.files.root
    )
      fail();
    const handles: FileHandle[] = [];
    try {
      handles.push(await open("/", DIRECTORY));
      try {
        for (const part of [
          ...this.files.root.split("/").filter(Boolean),
          ".reclamation",
        ])
          handles.push(
            await open(
              `/proc/self/fd/${handles.at(-1)!.fd}/${part}`,
              DIRECTORY,
            ),
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
      return await operation(handles.at(-1)!);
    } finally {
      const results = await Promise.allSettled(
        handles.reverse().map((h) => h.close()),
      );
      if (results.some((r) => r.status === "rejected")) fail();
    }
  }
  private async process(
    directory: FileHandle,
    name: string,
    expected?: Buffer,
  ): Promise<Awaited<ReturnType<ArtifactReclaimer["reclaim"]>>> {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) fail();
    const path = `/proc/self/fd/${directory.fd}/${name}`;
    const file = await open(path, FILE);
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size < 1n ||
        before.size > BigInt(MAX_BYTES)
      )
        fail();
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      if (
        !same(before, await file.stat({ bigint: true })) ||
        offset !== Number(before.size) ||
        (expected && !bytes.equals(expected))
      )
        fail();
      const raw = JSON.parse(bytes.toString()) as {
        version: unknown;
        catalog_key: unknown;
        artifacts: readonly RetiredArtifact[];
      };
      if (
        !raw ||
        Object.keys(raw).sort().join() !== "artifacts,catalog_key,version" ||
        raw.version !== 1 ||
        raw.catalog_key !== this.catalogKey
      )
        fail();
      const parsed = this.encode(raw.artifacts);
      if (
        !bytes.equals(parsed.bytes) ||
        parsed.ticket.reference !== `.reclamation/${name}`
      )
        fail();
      const bound = async () => {
        const present = await this.withDirectory(async (fresh) => {
          const current = await fresh.stat({ bigint: true }),
            original = await directory.stat({ bigint: true });
          if (current.dev !== original.dev || current.ino !== original.ino)
            fail();
          return true;
        });
        if (!present) fail();
      };
      await bound();
      const result = await this.reclaimer.reclaim(parsed.ticket.artifacts);
      await bound();
      const parent = await lstat(`${this.files.root}/.reclamation`, {
        bigint: true,
      });
      const originalParent = await directory.stat({ bigint: true });
      if (
        !parent.isDirectory() ||
        parent.dev !== originalParent.dev ||
        parent.ino !== originalParent.ino ||
        !same(before, await lstat(path, { bigint: true }))
      )
        fail();
      await unlink(path);
      await directory.sync();
      return result;
    } finally {
      await file.close();
    }
  }
}
