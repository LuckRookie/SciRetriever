import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  ensureMupdf,
  MupdfBuildError,
  mupdfBundleReady,
} from "../../../scripts/vendor/ensure-mupdf.mjs";
import { runCli } from "../src/cli/main.js";
import { MUPDF_VERSION, resolveMupdfRuntime } from "../src/proofread/mupdf.js";

afterEach(() => vi.unstubAllEnvs());
const platform = `${process.platform}-${process.arch}`;
const workspaceBundle = fileURLToPath(
  new URL(`../../../build/vendor/mupdf/${platform}/`, import.meta.url),
);

it("keeps a verified MuPDF bundle without building, judged as the server judges it", async () => {
  const build = vi.fn(async () => {
    throw new Error("must not build");
  });
  const log: string[] = [];
  await expect(
    ensureMupdf({
      output: workspaceBundle,
      build,
      log: (text) => log.push(text),
    }),
  ).resolves.toEqual({ built: false, output: workspaceBundle });
  expect(build).not.toHaveBeenCalled();
  expect(log.join("")).toContain("不再编译");

  // A synthetic bundle: both checks accept it, and both refuse one changed byte.
  const root = await mkdtemp(join(tmpdir(), "sciretriever-mupdf-check-"));
  try {
    const bundle = join(root, "bundle"),
      executable = join(bundle, "bin", "mutool"),
      bytes = Buffer.from("#!/bin/sh\nexit 0\n");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await writeFile(executable, bytes);
    await chmod(executable, 0o755);
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({
        name: "mupdf",
        version: MUPDF_VERSION,
        platform,
        executable: "bin/mutool",
        executable_sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    expect(await mupdfBundleReady(bundle)).toBe(true);
    expect(await resolveMupdfRuntime([bundle])).toBeDefined();
    await writeFile(executable, Buffer.from("#!/bin/sh\nexit 1\n"));
    expect(await mupdfBundleReady(bundle)).toBe(false);
    expect(await resolveMupdfRuntime([bundle])).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fails the build with what is missing, why and what to do when MuPDF cannot be built", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-mupdf-missing-"));
  try {
    const output = join(root, "linux-x64");
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const failure = ensureMupdf({ output, build: offline, log: () => {} });
    await expect(failure).rejects.toBeInstanceOf(MupdfBuildError);
    await expect(failure).rejects.toThrow(
      /^构建失败：缺少 MuPDF 1\.28\.6。[\s\S]*\n原因：下载 MuPDF 源码失败，可能不能联网（fetch failed）。\n办法：不能联网时，在能联网的机器上下载 https:\/\/github\.com\/[\s\S]*--source[\s\S]*`pnpm build`/u,
    );
    expect(offline).toHaveBeenCalledWith({ output });

    const compile = vi.fn(async () => ({}));
    await expect(
      ensureMupdf({
        output,
        build: compile,
        findTool: async (name) =>
          name !== "make" && name !== "cc" && name !== "gcc",
        log: () => {},
      }),
    ).rejects.toThrow(
      /原因：编译 MuPDF 需要的命令找不到：gcc、make。\n办法：安装/u,
    );
    expect(compile).not.toHaveBeenCalled();

    // A build that reports success but leaves no verified bundle still fails.
    await expect(
      ensureMupdf({ output, build: compile, log: () => {} }),
    ).rejects.toThrow(/没有通过核对/u);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to start Web without MuPDF, flock or prlimit, listing each with its remedy, before creating any file", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-web-incomplete-"));
  const empty = await mkdtemp(join(tmpdir(), "sciretriever-no-parts-"));
  let output = "";
  try {
    vi.stubEnv("SCIRETRIEVER_MUPDF", empty);
    const missingMupdf = await runCli(["web", "--port", "0"], {
      home,
      stdin: Readable.from([]),
      stderr: (text) => {
        output += text;
      },
    });
    expect(missingMupdf.code).toBe(4);
    expect(output).toBe(
      "无法启动：缺少以下本机部件。\n- MuPDF：在仓库目录执行 `pnpm build`\n",
    );
    expect(await readdir(home)).toEqual([]);

    output = "";
    vi.stubEnv("PATH", empty);
    const missingAll = await runCli(["web", "--port", "0"], {
      home,
      stdin: Readable.from([]),
      stderr: (text) => {
        output += text;
      },
    });
    expect(missingAll.code).toBe(4);
    expect(output).toBe(
      "无法启动：缺少以下本机部件。\n- flock：安装系统的 util-linux\n- prlimit：安装系统的 util-linux\n- MuPDF：在仓库目录执行 `pnpm build`\n",
    );
    expect(await readdir(home)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});
