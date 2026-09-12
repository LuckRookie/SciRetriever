import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createStaging,
  FileStagingError,
} from "../src/storage/files/staging.js";

describe("staged file lifecycle", () => {
  it("serializes concurrent writes and seals a handed-off stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    const stage = await createStaging(root, { maxBytes: 8 });
    try {
      await Promise.all([
        stage.write(new TextEncoder().encode("abc")),
        stage.write(new TextEncoder().encode("def")),
      ]);
      await stage.handoff();
      await expect(stage.write(new Uint8Array([1]))).rejects.toBeInstanceOf(
        FileStagingError,
      );
      await expect(stage.read()).resolves.toEqual(
        new TextEncoder().encode("abcdef"),
      );
    } finally {
      await stage.close();
    }
  });

  it("does not delete a replacement after a failed cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    const stage = await createStaging(root);
    const name = stage.reference.split("/").at(-1)!;
    const path = join(root, ".staging", name);
    const replacement = join(root, ".staging", "replacement.tmp");
    await writeFile(replacement, "replacement");
    await rename(replacement, path);
    await expect(stage.discard()).rejects.toBeInstanceOf(FileStagingError);
    await expect(readFile(path, "utf8")).resolves.toBe("replacement");
  });
});
