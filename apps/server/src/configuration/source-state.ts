import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  LITERATURE_SOURCE_IDS,
  parseSourceTestResult,
  parseStrictJsonObject,
  type SourceTestResult,
  type SourceTestTarget,
} from "@sciretriever/contracts";
import { credentialPath } from "./credentials.js";

export const SOURCE_METHOD_VERSION = "source-probe-v1";
export function sourceDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export interface SourceFileIdentity {
  readonly configuration_revision: string;
  readonly credential_identity: string;
}
export interface SourceStateCache extends SourceFileIdentity {
  readonly schema_version: 1;
  readonly generations: Readonly<Record<string, string>>;
  readonly results: Readonly<
    Partial<Record<SourceTestTarget, SourceTestResult>>
  >;
}
export async function sourceFileIdentity(
  home: string,
  configuration_revision: string,
): Promise<SourceFileIdentity> {
  const stat = await lstat(credentialPath(home), { bigint: true }).catch(
    (e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    },
  );
  if (
    stat &&
    (!stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      (stat.mode & 0o777n) !== 0o600n)
  )
    throw new Error("source-identity-invalid");
  return {
    configuration_revision,
    credential_identity: stat
      ? sourceDigest([
          String(stat.dev),
          String(stat.ino),
          String(stat.mtimeNs),
          String(stat.ctimeNs),
        ])
      : "missing",
  };
}
export function sameSourceFiles(
  a: SourceFileIdentity,
  b: SourceFileIdentity,
): boolean {
  return (
    a.configuration_revision === b.configuration_revision &&
    a.credential_identity === b.credential_identity
  );
}
export async function readSourceState(
  home: string,
): Promise<{ cache: SourceStateCache | null; code: string | null }> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(
      join(home, ".sciretriever"),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const d = await directory.stat();
    if (
      !d.isDirectory() ||
      (d.mode & 0o077) !== 0 ||
      d.uid !== process.getuid?.()
    )
      throw new Error("unsafe");
    file = await open(
      `/proc/self/fd/${directory.fd}/source-state.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const s = await file.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      (s.mode & 0o777) !== 0o600 ||
      s.uid !== process.getuid?.() ||
      s.size > 262144
    )
      throw new Error("unsafe");
    const buffer = Buffer.alloc(262145);
    const read = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (
      read.bytesRead !== s.size ||
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs
    )
      throw new Error("unstable");
    const v: unknown = parseStrictJsonObject(
      buffer.subarray(0, read.bytesRead),
    );
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new Error("schema");
    const r = v as SourceStateCache;
    const allowed = [...LITERATURE_SOURCE_IDS, "browser"];
    if (
      Object.keys(r).sort().join() !==
        [
          "schema_version",
          "configuration_revision",
          "credential_identity",
          "generations",
          "results",
        ]
          .sort()
          .join() ||
      r.schema_version !== 1 ||
      typeof r.configuration_revision !== "string" ||
      typeof r.credential_identity !== "string" ||
      !r.generations ||
      !r.results
    )
      throw new Error("schema");
    if (
      Object.keys(r.generations).length !== 16 ||
      Object.entries(r.generations).some(
        ([k, v]) =>
          !allowed.includes(k) ||
          typeof v !== "string" ||
          !/^[a-zA-Z0-9-]{1,128}$/u.test(v),
      ) ||
      Object.keys(r.results).length > 16
    )
      throw new Error("schema");
    const results: SourceStateCache["results"] = {};
    for (const [k, v] of Object.entries(r.results)) {
      if (!allowed.includes(k)) throw new Error("schema");
      const result = parseSourceTestResult(v);
      if (result.source !== k) throw new Error("schema");
      (results as Record<string, SourceTestResult>)[k] = result;
    }
    return { cache: { ...r, results }, code: null };
  } catch (e) {
    return {
      cache: null,
      code:
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? null
          : "source-state-invalid",
    };
  } finally {
    await file?.close();
    await directory?.close();
  }
}
export function currentSourceState(
  identity: SourceFileIdentity,
  cache: SourceStateCache | null,
): SourceStateCache {
  if (cache && sameSourceFiles(identity, cache)) return cache;
  return {
    ...identity,
    schema_version: 1,
    generations: Object.fromEntries(
      [...LITERATURE_SOURCE_IDS, "browser"].map((id) => [
        id,
        sourceDigest(identity),
      ]),
    ),
    results: {},
  };
}
/** Caller owns the configuration lock; this cache never contains credentials or response bodies. */
export async function writeSourceState(
  home: string,
  state: SourceStateCache,
): Promise<void> {
  const path = join(home, ".sciretriever");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let temporary: string | undefined;
  try {
    const d = await directory.stat();
    if (
      !d.isDirectory() ||
      (d.mode & 0o077) !== 0 ||
      d.uid !== process.getuid?.()
    )
      throw new Error("source-state-write-failed");
    const target = `/proc/self/fd/${directory.fd}/source-state.json`;
    const old = await lstat(target).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    });
    if (
      old &&
      (!old.isFile() ||
        old.nlink !== 1 ||
        (old.mode & 0o777) !== 0o600 ||
        old.uid !== process.getuid?.())
    )
      throw new Error("source-state-write-failed");
    temporary = `/proc/self/fd/${directory.fd}/.source-state-${randomUUID()}.tmp`;
    const staged = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await staged.writeFile(JSON.stringify(state));
      await staged.sync();
    } finally {
      await staged.close();
    }
    await rename(temporary, target);
    temporary = undefined;
    await directory.sync();
  } finally {
    if (temporary) await unlink(temporary);
    await directory.close();
  }
}
export async function sourceStateChanged(
  home: string,
  before: SourceFileIdentity,
  after: SourceFileIdentity,
  sources: readonly string[],
): Promise<void> {
  const state = currentSourceState(before, (await readSourceState(home)).cache);
  const generations = { ...state.generations },
    results = { ...state.results };
  for (const source of sources) {
    generations[source] = randomUUID();
    delete results[source as SourceTestTarget];
  }
  await writeSourceState(home, {
    ...after,
    schema_version: 1,
    generations,
    results,
  });
}
