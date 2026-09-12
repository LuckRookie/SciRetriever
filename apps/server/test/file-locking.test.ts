import { mkdtemp, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { acquireFileLock, FileLockError } from "../src/storage/locking.js";

describe("catalog file locking", () => {
  it("excludes a second owner and releases idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-lock-"));
    const first = await acquireFileLock(root, "catalog");
    await expect(acquireFileLock(root, "catalog")).rejects.toBeInstanceOf(
      FileLockError,
    );
    await expect(first.release()).resolves.toBeUndefined();
    await first.release();
    const second = await acquireFileLock(root, "catalog");
    await second.release();
  });

  it("rejects malformed lock keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-lock-"));
    await expect(acquireFileLock(root, "../catalog")).rejects.toBeInstanceOf(
      FileLockError,
    );
  });

  it("fails closed when the lock directory is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-lock-"));
    const outside = await mkdtemp(join(tmpdir(), "sciretriever-lock-outside-"));
    await symlink(outside, join(root, ".locks"));
    await expect(acquireFileLock(root, "catalog")).rejects.toBeInstanceOf(
      FileLockError,
    );
  });

  it("excludes an independent process and leaves an unconfirmed crash lock intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-lock-"));
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        'import { acquireFileLock } from "./apps/server/src/storage/locking.ts"; const lock = await acquireFileLock(process.argv[1], "catalog"); process.stdout.write("acquired\\n"); process.stdin.resume(); process.stdin.on("end", async () => { await lock.release(); process.exit(0); });',
        root,
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout, "data");
      await expect(acquireFileLock(root, "catalog")).rejects.toBeInstanceOf(
        FileLockError,
      );
      child.stdin.end();
      await once(child, "exit");
      const afterNormalExit = await acquireFileLock(root, "catalog");
      await afterNormalExit.release();

      const crashed = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          'import { acquireFileLock } from "./apps/server/src/storage/locking.ts"; await acquireFileLock(process.argv[1], "catalog"); process.stdout.write("acquired\\n"); setInterval(() => {}, 1000);',
          root,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      await once(crashed.stdout, "data");
      crashed.kill("SIGKILL");
      await once(crashed, "exit");
      await expect(acquireFileLock(root, "catalog")).rejects.toBeInstanceOf(
        FileLockError,
      );
    } finally {
      child.kill("SIGKILL");
    }
  });
});
