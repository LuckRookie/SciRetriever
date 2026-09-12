import { createHash, randomInt } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  canonicalJsonBytes,
  parseStrictJsonObject,
} from "@sciretriever/contracts";

export const CLOAK_VERSION = "146.0.7680.177.5";
const ARCHIVE_SHA256 =
  "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e";
const MANIFEST = ".sciretriever-binary-manifest.json";
const verified = new WeakSet<object>();
export interface VerifiedCloakRuntime {
  readonly executablePath: string;
  readonly version: typeof CLOAK_VERSION;
}
export class CloakRuntimeError extends Error {
  readonly code = "cloak-runtime";
  constructor() {
    super("local CloakBrowser runtime is unavailable or invalid");
  }
}
const nofollow = constants.O_RDONLY | constants.O_NOFOLLOW;
function fail(): never {
  throw new CloakRuntimeError();
}
function privateMetadata(meta: Stats, directory = false): void {
  if (
    (directory ? !meta.isDirectory() : !meta.isFile()) ||
    meta.mode & 0o077 ||
    meta.uid !== process.getuid?.() ||
    (!directory && meta.nlink !== 1)
  )
    fail();
}
async function readPrivate(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, nofollow);
  try {
    const meta = await file.stat();
    privateMetadata(meta);
    if (meta.size > limit) fail();
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) fail();
    }
    const after = await file.stat();
    if (
      total !== meta.size ||
      after.mtimeMs !== meta.mtimeMs ||
      after.size !== meta.size
    )
      fail();
    return new Uint8Array(buffer.subarray(0, total));
  } finally {
    await file.close();
  }
}

/** Read-only validation of an operator-installed bundle; never installs or chooses a fallback. */
export async function verifyInstalledCloakRuntime(
  bundle: string,
): Promise<VerifiedCloakRuntime> {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    !bundle.startsWith("/")
  )
    fail();
  privateMetadata(await lstat(bundle), true);
  const manifest = parseStrictJsonObject(
    new TextDecoder().decode(await readPrivate(join(bundle, MANIFEST), 65536)),
  );
  const expected = [
    "archive_sha256",
    "binary_version",
    "bundle_sha256",
    "compatible_playwright",
    "executable_sha256",
    "origin",
    "platform",
    "playwright_version",
    "signature_algorithm",
    "signature_verified",
    "verified_at",
    "wrapper_version",
  ];
  if (
    Object.keys(manifest).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(manifest, key)) ||
    manifest.archive_sha256 !== ARCHIVE_SHA256 ||
    manifest.binary_version !== CLOAK_VERSION ||
    manifest.signature_verified !== true ||
    manifest.signature_algorithm !== "ed25519" ||
    manifest.platform !== "linux-x64" ||
    manifest.origin !== "https://cloakbrowser.dev" ||
    manifest.playwright_version !== "1.55.0" ||
    manifest.compatible_playwright !== "==1.55.0" ||
    manifest.wrapper_version !== "0.5.8"
  )
    fail();
  const entries: { path: string; mode: number; size: number }[] = [];
  const pending = [bundle];
  let total = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const meta = await lstat(path);
      if (meta.isDirectory()) {
        privateMetadata(meta, true);
        pending.push(path);
        continue;
      }
      privateMetadata(meta);
      if (path === join(bundle, MANIFEST)) continue;
      if (meta.size > 512 * 1024 * 1024) fail();
      total += meta.size;
      if (total > 2 * 1024 * 1024 * 1024) fail();
      entries.push({ path, mode: meta.mode & 0o7777, size: meta.size });
    }
  }
  entries.sort((a, b) =>
    relative(bundle, a.path) < relative(bundle, b.path) ? -1 : 1,
  );
  const digest = createHash("sha256");
  let executableDigest: string | undefined;
  for (const entry of entries) {
    const name = Buffer.from(relative(bundle, entry.path));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(name.byteLength);
    const mode = Buffer.alloc(2);
    mode.writeUInt16BE(entry.mode);
    digest.update(size).update(name).update(mode);
    const file = await open(entry.path, nofollow);
    const executable = createHash("sha256");
    try {
      const before = await file.stat();
      privateMetadata(before);
      if (before.size !== entry.size || (before.mode & 0o7777) !== entry.mode)
        fail();
      let read = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        read += chunk.length;
        if (read > entry.size) fail();
        digest.update(chunk);
        executable.update(chunk);
      }
      const after = await file.stat();
      if (
        read !== entry.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      )
        fail();
      if (entry.path === join(bundle, "chrome")) {
        if (!(entry.mode & 0o100)) fail();
        executableDigest = executable.digest("hex");
      }
    } finally {
      await file.close();
    }
  }
  if (
    digest.digest("hex") !== manifest.bundle_sha256 ||
    executableDigest !== manifest.executable_sha256 ||
    !executableDigest
  )
    fail();
  const result = Object.freeze({
    executablePath: join(bundle, "chrome"),
    version: CLOAK_VERSION,
  });
  verified.add(result);
  return result;
}
export function assertVerifiedCloakRuntime(
  runtime: VerifiedCloakRuntime,
): void {
  if (!verified.has(runtime)) fail();
}

/** Called under the sole Profile lease. The seed stays inside this owner-only file. */
export async function loadCloakIdentity(
  profile: string,
): Promise<{ readonly seed: number; readonly digest: string }> {
  const path = join(profile, "identity-manifest.json");
  let payload: Record<string, unknown>;
  try {
    payload = parseStrictJsonObject(
      new TextDecoder().decode(await readPrivate(path, 65536)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new CloakRuntimeError();
    if ((await readdir(profile)).some((name) => name !== ".locks")) fail();
    const base = {
      browser_version_policy: { mode: "exact", version: CLOAK_VERSION },
      fingerprint_seed: randomInt(1, 2147483647),
      identity_schema: "sciretriever.browser-identity.v1",
      languages: ["en-US", "en", "zh-CN", "zh", "ja", "ko"],
      locale: "en-US",
      persona: "linux",
      schema_version: 1,
      screen: { height: 1080, width: 1920 },
      timezone: "UTC",
    };
    payload = {
      ...base,
      identity_digest: createHash("sha256")
        .update(canonicalJsonBytes(base))
        .digest("hex"),
    };
    let file: FileHandle | undefined;
    try {
      file = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(canonicalJsonBytes(payload));
      await file.sync();
    } finally {
      await file?.close();
    }
    const directory = await open(
      profile,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  const { identity_digest: digest, ...base } = payload;
  if (
    typeof digest !== "string" ||
    createHash("sha256").update(canonicalJsonBytes(base)).digest("hex") !==
      digest ||
    typeof base.fingerprint_seed !== "number" ||
    !Number.isSafeInteger(base.fingerprint_seed) ||
    base.fingerprint_seed < 1 ||
    base.fingerprint_seed > 2147483647
  )
    fail();
  const expected = {
    browser_version_policy: { mode: "exact", version: CLOAK_VERSION },
    fingerprint_seed: base.fingerprint_seed,
    identity_schema: "sciretriever.browser-identity.v1",
    languages: ["en-US", "en", "zh-CN", "zh", "ja", "ko"],
    locale: "en-US",
    persona: "linux",
    schema_version: 1,
    screen: { height: 1080, width: 1920 },
    timezone: "UTC",
  };
  if (
    Buffer.compare(
      Buffer.from(canonicalJsonBytes(base)),
      Buffer.from(canonicalJsonBytes(expected)),
    )
  )
    fail();
  return Object.freeze({ seed: base.fingerprint_seed, digest });
}
