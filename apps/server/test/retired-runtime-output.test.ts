import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const prune = (root: string) =>
  run(process.execPath, [
    "--input-type=module",
    "--eval",
    "const { pruneRetiredRuntime } = await import(process.argv[1]); await pruneRetiredRuntime(process.argv[2]);",
    pathToFileURL(resolve("scripts/prune-retired-runtime.mjs")).href,
    root,
  ]);
it("removes only retired compiled parser modules and remains idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-retired-output-"));
  const directory = join(root, "apps/server/dist/parsing");
  try {
    await mkdir(directory, { recursive: true });
    const retired = [
      "service.js",
      "publication.d.ts",
      "service.js.map",
      "publication.d.ts.map",
    ];
    for (const name of retired)
      await writeFile(join(directory, name), "retired output");
    await writeFile(join(directory, "raw-service.js"), "current output");
    await prune(root);
    await prune(root);
    for (const name of retired)
      await expect(access(join(directory, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(await readFile(join(directory, "raw-service.js"), "utf8")).toBe(
      "current output",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each(["directory", "file"] as const)(
  "refuses a symlink %s and preserves outside bytes",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-retired-symlink-"));
    const directory = join(root, "apps/server/dist/parsing");
    const outside = join(root, "outside");
    try {
      await mkdir(outside);
      await writeFile(join(outside, "service.js"), "protected bytes");
      if (kind === "directory") {
        await mkdir(join(root, "apps/server/dist"), { recursive: true });
        await symlink(outside, directory);
      } else {
        await mkdir(directory, { recursive: true });
        await symlink(
          join(outside, "service.js"),
          join(directory, "service.js"),
        );
        await writeFile(
          join(directory, "publication.js"),
          "unmodified on refusal",
        );
      }
      await expect(prune(root)).rejects.toBeDefined();
      expect(await readFile(join(outside, "service.js"), "utf8")).toBe(
        "protected bytes",
      );
      if (kind === "file")
        expect(await readFile(join(directory, "publication.js"), "utf8")).toBe(
          "unmodified on refusal",
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("prunes the moved bibliography output without requiring a parsing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-moved-output-"));
  try {
    const directory = join(root, "apps/server/dist/entry");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "bibliography.js"), "obsolete entry");
    await writeFile(
      join(directory, "bibliography-export.js"),
      "current export",
    );
    await prune(root);
    await expect(
      access(join(directory, "bibliography.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(directory, "bibliography-export.js"), "utf8"),
    ).toBe("current export");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("prunes retired contract artifacts even when no server output exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-retired-contract-"));
  try {
    const path = join(root, "packages/contracts/dist");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "knowledge.js"), "retired");
    await writeFile(join(path, "summary.js"), "current");
    await prune(root);
    await expect(access(join(path, "knowledge.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(path, "summary.js"), "utf8")).toBe("current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
