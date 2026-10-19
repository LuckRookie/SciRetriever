import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadReactAssets } from "../src/workbench/assets.js";

describe("React workbench static asset boundary", () => {
  it("retires only generated hashed files and refuses linked build directories", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-react-build-test-"),
    );
    const output = join(root, "output");
    const build = (directory: string) =>
      promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import assert from 'node:assert/strict'; import { buildReactAssets } from './scripts/build-react-assets.mjs'; await buildReactAssets(process.argv[1]); assert.equal(process.env.NODE_ENV, 'test');",
          directory,
        ],
        {
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NODE_ENV: "test" },
        },
      );
    try {
      await mkdir(join(output, "assets"), { recursive: true });
      const retired = join(output, "assets/Retired-12345678.js");
      const note = join(output, "assets/operator-note.txt");
      const outside = join(root, "outside.txt");
      const linkedFile = join(output, "assets/Linked-87654321.js");
      await writeFile(retired, "obsolete generated resource");
      await writeFile(note, "keep caller text");
      await writeFile(outside, "keep outside bytes");
      await symlink(outside, linkedFile);
      await build(output);
      await expect(readFile(retired)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(note, "utf8")).toBe("keep caller text");
      expect(await readFile(outside, "utf8")).toBe("keep outside bytes");
      expect((await lstat(linkedFile)).isSymbolicLink()).toBe(true);
      const assets = await loadReactAssets(pathToFileURL(`${output}/`));
      expect(assets.get("/")?.body.toString()).toContain('id="root"');
      for (const [path, asset] of assets) {
        if (path.endsWith(".js"))
          expect(asset.body.toString(), path).not.toMatch(
            /react_stack_bottom_frame|\.jsxDEV\(/u,
          );
      }
      expect(assets.has("/assets/operator-note.txt")).toBe(false);
      expect(assets.has("/assets/Linked-87654321.js")).toBe(false);

      const linkedOutput = join(root, "linked-output");
      await symlink(output, linkedOutput);
      await expect(build(linkedOutput)).rejects.toThrow("real directory");
      const linkedAssets = join(root, "linked-assets");
      await mkdir(linkedAssets);
      await symlink(join(output, "assets"), join(linkedAssets, "assets"));
      await expect(build(linkedAssets)).rejects.toThrow("real directory");
      expect(await readFile(outside, "utf8")).toBe("keep outside bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("loads only build-declared assets and maps the independent entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-react-assets-"));
    try {
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "index.html"), "<main>React workspace</main>");
      await writeFile(
        join(root, "assets/app-123.js"),
        "export const app = true;",
      );
      await writeFile(join(root, "private.txt"), "not published");
      await writeFile(
        join(root, "assets.json"),
        JSON.stringify(["index.html", "assets/app-123.js"]),
      );
      const assets = await loadReactAssets(pathToFileURL(`${root}/`));
      expect(assets.get("/")?.body.toString()).toContain("React workspace");
      expect(assets.has("/next")).toBe(false);
      expect(assets.has("/next/")).toBe(false);
      expect(assets.has("/next/index.html")).toBe(false);
      expect(assets.get("/assets/app-123.js")?.contentType).toContain(
        "javascript",
      );
      expect(assets.has("/private.txt")).toBe(false);
      expect(assets.has("/assets.json")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid manifests and paths before they can become static routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-react-assets-"));
    try {
      await writeFile(join(root, "index.html"), "workspace");
      for (const manifest of [
        {},
        [],
        ["index.html", "../private.txt"],
        ["index.html", "/private.txt"],
        ["index.html", "assets/%2e%2e/private.js"],
        ["index.html", "app.js?secret"],
        ["index.html", "source.map"],
        ["index.html", 42],
      ]) {
        await writeFile(join(root, "assets.json"), JSON.stringify(manifest));
        await expect(
          loadReactAssets(pathToFileURL(`${root}/`)),
        ).rejects.toThrow("Invalid React workbench asset");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
