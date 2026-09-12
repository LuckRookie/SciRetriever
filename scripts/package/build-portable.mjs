import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function pnpm(args, cwd) {
  const result = spawnSync(
    "pnpm",
    [
      "--config.userconfig=/dev/null",
      "--config.globalconfig=/dev/null",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `portable package dependency step failed\n${result.stdout}${result.stderr}`,
    );
}

async function packageDependencies(directory) {
  for (const workspace of ["packages/contracts", "apps/server"])
    pnpm(
      ["pack", "--pack-destination", directory],
      join(repository, workspace),
    );
  const packed = new Map();
  async function visit(name, from) {
    let root = from;
    while (!existsSync(join(root, "node_modules", name, "package.json"))) {
      const parent = dirname(root);
      if (parent === root)
        throw new Error(`missing runtime dependency: ${name}`);
      root = parent;
    }
    const packageDirectory = await realpath(join(root, "node_modules", name));
    const manifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    const prior = packed.get(name);
    if (prior) {
      if (prior.version !== manifest.version)
        throw new Error(`conflicting runtime dependency: ${name}`);
      return;
    }
    const tarball = `${name.replace(/^@/u, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
    packed.set(name, { version: manifest.version, tarball });
    pnpm(["pack", "--pack-destination", directory], packageDirectory);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await visit(dependency, packageDirectory);
  }
  for (const dependency of ["playwright", "playwright-core", "cloakbrowser"])
    await visit(dependency, join(repository, "apps/server"));
  const dependencies = {};
  for (const name of ["contracts", "server"]) {
    const tarball = (await readdir(directory)).find(
      (entry) =>
        entry.startsWith(`sciretriever-${name}-`) && entry.endsWith(".tgz"),
    );
    if (!tarball) throw new Error(`workspace package was not packed: ${name}`);
    dependencies[`@sciretriever/${name}`] = `file:./${tarball}`;
  }
  for (const [name, value] of packed)
    dependencies[name] = `file:./${value.tarball}`;
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies,
        pnpm: { overrides: dependencies },
      },
      null,
      2,
    )}\n`,
  );
  pnpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--store-dir",
      join(directory, ".store"),
      "--cache-dir",
      join(directory, ".cache"),
    ],
    directory,
  );
  await rm(join(directory, ".store"), { recursive: true, force: true });
  await rm(join(directory, ".cache"), { recursive: true, force: true });
  for (const entry of await readdir(directory))
    if (entry.endsWith(".tgz")) await rm(join(directory, entry));
}

async function sha256(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function files(root, current = root) {
  const result = [];
  for (const name of (await readdir(current)).sort()) {
    if (name === "release-manifest.json") continue;
    const path = join(current, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      const resolved = resolve(dirname(path), target);
      if (
        target.startsWith("/") ||
        (resolved !== root && !resolved.startsWith(`${root}/`))
      )
        throw new Error(
          `portable package contains an escaping symlink: ${path}`,
        );
      result.push({
        path: path.slice(root.length + 1),
        type: "symlink",
        target,
      });
    } else if (metadata.isDirectory())
      result.push(...(await files(root, path)));
    else if (metadata.isFile())
      result.push({
        path: path.slice(root.length + 1),
        size_bytes: metadata.size,
        sha256: await sha256(path),
      });
    else
      throw new Error(
        `portable package contains an unsupported entry: ${path}`,
      );
  }
  return result;
}

async function main() {
  const rawOutput = option("--output");
  if (!rawOutput || !rawOutput.startsWith("/"))
    throw new Error(
      "usage: build-portable.mjs --output /absolute/new-directory [--cloak-bundle /absolute/directory]",
    );
  const output = resolve(rawOutput);
  if (existsSync(output))
    throw new Error("portable package output already exists");
  pnpm(["build"], repository);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), "sciretriever-portable-stage-"));
  try {
    const app = join(staging, "app");
    await mkdir(app);
    await packageDependencies(app);
    await mkdir(join(staging, "runtime", "bin"), { recursive: true });
    await copyFile(process.execPath, join(staging, "runtime", "bin", "node"));
    await chmod(join(staging, "runtime", "bin", "node"), 0o755);
    await mkdir(join(staging, "bin"));
    const launcher = join(staging, "bin", "sciretriever");
    await writeFile(
      launcher,
      '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$base/runtime/bin/node" "$base/app/node_modules/@sciretriever/server/dist/cli/main.js" "$@"\n',
      { mode: 0o755 },
    );
    await mkdir(join(staging, "manifests"));
    await copyFile(
      join(repository, "release", "manifests", "runtime-support.json"),
      join(staging, "manifests", "runtime-support.json"),
    );
    const cloakBundle = option("--cloak-bundle");
    if (cloakBundle) {
      if (!cloakBundle.startsWith("/"))
        throw new Error("CloakBrowser bundle path must be absolute");
      await cp(cloakBundle, join(staging, "runtime", "cloakbrowser"), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    }
    const manifest = {
      schema_version: 1,
      product: "sciretriever",
      version: "0.1.0",
      platform: `${process.platform}-${process.arch}`,
      node_version: process.version,
      cloakbrowser: cloakBundle
        ? "bundled-operator-runtime"
        : "operator-installed",
      files: await files(staging),
    };
    await writeFile(
      join(staging, "release-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await rename(staging, output);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

await main();
