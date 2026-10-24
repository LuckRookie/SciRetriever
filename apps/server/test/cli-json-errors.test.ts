import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

const server = fileURLToPath(new URL("..", import.meta.url));
let root: string;
let entry: string;
let environment: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sciretriever-cli-json-"));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  environment = { ...process.env, HOME: home, USERPROFILE: home };
  // Compile without bundling: eager/lazy imports must match the shipped CLI.
  const sources: string[] = [];
  const collect = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await collect(path);
      else if (path.endsWith(".ts")) sources.push(path);
    }
  };
  await collect(join(server, "src"));
  await build({
    entryPoints: sources,
    outbase: join(server, "src"),
    outdir: join(root, "dist"),
    bundle: false,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  await symlink(join(server, "node_modules"), join(root, "node_modules"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  entry = join(root, "dist/cli/main.js");
}, 0);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("keeps a missing-catalog CLI error as JSON without eagerly loading SQLite", () => {
  const result = spawnSync(
    process.execPath,
    ["--trace-warnings", entry, "literature", "search", "--json"],
    { env: environment, encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(3);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe('{"code":"query-not-initialized"}\n');
});

it("preserves SQLite and unrelated Node warnings when modules explicitly request them", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(entry).href)}); await import('node:sqlite'); process.emitWarning('Synthetic diagnostic remains visible', {type:'Warning',code:'SCIRETRIEVER_TEST_WARNING'});`,
    ],
    { cwd: dirname(entry), env: environment, encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("SQLite is an experimental feature");
  expect(result.stderr).toContain("Synthetic diagnostic remains visible");
  expect(result.stderr).toContain("SCIRETRIEVER_TEST_WARNING");
});
