import { mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FilePublicationError,
  publishStagedFile,
} from "../src/storage/files/publication.js";
import { createStaging } from "../src/storage/files/staging.js";

describe("immutable file publication", () => {
  it("publishes once and refuses a different byte sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-publication-"));
    const first = await createStaging(root);
    await first.write(new TextEncoder().encode("first"));
    await first.flush();
    await expect(
      publishStagedFile(root, first, "objects/aa/item.bin"),
    ).resolves.toMatchObject({ created: true, size: 5 });

    const same = await createStaging(root);
    await same.write(new TextEncoder().encode("first"));
    await expect(
      publishStagedFile(root, same, "objects/aa/item.bin"),
    ).resolves.toMatchObject({ created: false });

    const different = await createStaging(root);
    await different.write(new TextEncoder().encode("other"));
    await expect(
      publishStagedFile(root, different, "objects/aa/item.bin"),
    ).rejects.toMatchObject({ conflict: true });
    await expect(
      readFile(join(root, "objects/aa/item.bin"), "utf8"),
    ).resolves.toBe("first");
    const conflicts = await readdir(join(root, ".conflicts"));
    expect(conflicts).toHaveLength(1);
    await expect(
      readFile(join(root, ".conflicts", conflicts[0]!), "utf8"),
    ).resolves.toContain('"incoming_sha256"');
    await different.discard().catch((error: unknown) => {
      if (!(error instanceof FilePublicationError)) throw error;
    });
  });

  it("rejects absolute and traversal references before creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-publication-"));
    const stage = await createStaging(root);
    await stage.write(new Uint8Array([1]));
    await expect(
      publishStagedFile(root, stage, "../outside"),
    ).rejects.toBeInstanceOf(FilePublicationError);
    await stage.discard();
  });

  it("rejects an ancestor symlink before creating a publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-publication-"));
    const outside = await mkdtemp(join(tmpdir(), "sciretriever-outside-"));
    await symlink(outside, join(root, "objects"));
    const stage = await createStaging(root);
    await stage.write(new Uint8Array([1]));
    await expect(
      publishStagedFile(root, stage, "objects/item.bin"),
    ).rejects.toBeInstanceOf(FilePublicationError);
    await stage.discard();
  });

  it("serializes competing publishers so the loser never reads a partial file", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-publication-"));
    const first = await createStaging(root);
    const second = await createStaging(root);
    const bytes = new TextEncoder().encode("same immutable content");
    await Promise.all([first.write(bytes), second.write(bytes)]);
    const results = await Promise.all([
      publishStagedFile(root, first, "objects/concurrent/item.bin"),
      publishStagedFile(root, second, "objects/concurrent/item.bin"),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      readFile(join(root, "objects/concurrent/item.bin"), "utf8"),
    ).resolves.toBe("same immutable content");
  });

  it("cleans only its own target after an injected publication failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-publication-"));
    const stage = await createStaging(root);
    await stage.write(new TextEncoder().encode("durable candidate"));
    await expect(
      publishStagedFile(root, stage, "objects/failure/item.bin", {
        syncFile: async () => {
          throw new Error("injected sync failure");
        },
      }),
    ).rejects.toBeInstanceOf(FilePublicationError);
    await expect(
      readFile(join(root, "objects/failure/item.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await stage.discard();
  });
});
