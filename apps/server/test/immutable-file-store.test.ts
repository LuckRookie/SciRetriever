import {
  link as hardlink,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileStagingError,
  createStaging,
} from "../src/storage/files/staging.js";

describe("immutable file staging", () => {
  it("writes, hashes, and bounds a private relative stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    try {
      const stage = await createStaging(root, { maxBytes: 32 });
      expect(stage.reference).toMatch(/^\.staging\/stage-[0-9a-f-]+\.tmp$/u);
      await expect(
        stage.write(new TextEncoder().encode("staged bytes")),
      ).resolves.toBe(12);
      await stage.flush();
      await expect(stage.read()).resolves.toEqual(
        new TextEncoder().encode("staged bytes"),
      );
      await expect(stage.describe()).resolves.toMatchObject({ size: 12 });
      await expect(stage.describe()).resolves.toMatchObject({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      await stage.close();
      await expect(stage.close()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly handed off stage until discard", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    try {
      const stage = await createStaging(root);
      const reference = await stage.handoff();
      await stage.close();
      await expect(lstat(join(root, reference))).resolves.toMatchObject({
        nlink: 1,
      });
      await stage.discard();
      await expect(lstat(join(root, reference))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized write and a symlinked staging directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    const outside = await mkdtemp(
      join(tmpdir(), "sciretriever-staging-outside-"),
    );
    try {
      const stage = await createStaging(root, { maxBytes: 3 });
      await expect(stage.write(new Uint8Array(4))).rejects.toBeInstanceOf(
        FileStagingError,
      );
      await stage.close();
      await rm(join(root, ".staging"), { recursive: true, force: true });
      await symlink(outside, join(root, ".staging"));
      await expect(createStaging(root)).rejects.toBeInstanceOf(
        FileStagingError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a staging directory replacement and cleans the original stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    try {
      const stage = await createStaging(root);
      const name = stage.reference.split("/").at(-1)!;
      await stage.write(new TextEncoder().encode("bound"));
      await rename(join(root, ".staging"), join(root, ".staging-replaced"));
      await mkdir(join(root, ".staging"));
      await expect(
        stage.write(new TextEncoder().encode(" directory")),
      ).rejects.toBeInstanceOf(FileStagingError);
      await expect(stage.close()).rejects.toBeInstanceOf(FileStagingError);
      await expect(
        lstat(join(root, ".staging-replaced")),
      ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await expect(
        lstat(join(root, ".staging-replaced", name)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(root, ".staging", name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked stage and preserves the competing directory entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    try {
      const stage = await createStaging(root);
      const name = stage.reference.split("/").at(-1)!;
      const path = join(root, ".staging", name);
      const linked = join(root, ".staging", "linked.tmp");
      await stage.write(new TextEncoder().encode("linked"));
      await hardlink(path, linked);
      await expect(stage.read()).rejects.toBeInstanceOf(FileStagingError);
      await expect(stage.discard()).rejects.toBeInstanceOf(FileStagingError);
      await expect(lstat(linked)).resolves.toMatchObject({ nlink: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
