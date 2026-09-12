import { createReadStream } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const repository = resolve(new URL("../../..", import.meta.url).pathname);

async function pythonFiles(relative: string): Promise<string[]> {
  const directory = join(repository, relative);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) files.push(...(await pythonFiles(child)));
      else if (entry.isFile() && entry.name.endsWith(".py")) files.push(child);
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(digest.digest("hex")));
  });
}

it("verifies the Python retirement archive and leaves no active Python owner", async () => {
  const report = JSON.parse(
    await readFile(
      join(repository, "migration/retirement-report.json"),
      "utf8",
    ),
  ) as {
    production_runtime: { language: string; entry: string };
    python_policy: {
      status: string;
      historical_files_are_not_packaged: boolean;
      historical_files_are_archived: boolean;
      archive_root: string;
    };
    archive: {
      status: string;
      root: string;
      manifest: string;
      file_count: number;
      active_python_files: number;
    };
    records: readonly {
      path: string;
      kind: string;
      disposition: string;
      archive_path: string;
      ts_targets?: readonly string[];
    }[];
  };
  expect(report.production_runtime).toMatchObject({
    language: "typescript",
    entry: "apps/server/src/cli/main.ts",
  });
  expect(report.python_policy).toMatchObject({
    status: "retired-from-production",
    historical_files_are_not_packaged: true,
    historical_files_are_archived: true,
  });
  expect(report.archive).toMatchObject({
    status: "archived",
    root: "archive/2026-09-12-typescript-python-retirement",
    file_count: 413,
    active_python_files: 0,
  });
  expect(report.python_policy.archive_root).toBe(report.archive.root);
  const sources = report.records.filter(
    (item) => item.kind === "python-source",
  );
  const tests = report.records.filter(
    (item) => item.kind === "python-test-oracle",
  );
  expect(sources).toHaveLength(242);
  expect(tests).toHaveLength(161);
  expect(
    sources.every((item) => item.disposition === "historical-nonruntime"),
  ).toBe(true);
  expect(tests.every((item) => item.disposition === "historical-oracle")).toBe(
    true,
  );
  const archiveManifest = JSON.parse(
    await readFile(join(repository, report.archive.manifest), "utf8"),
  ) as {
    file_count: number;
    files: readonly {
      source_path: string;
      archive_path: string;
      sha256: string;
    }[];
  };
  expect(archiveManifest.file_count).toBe(report.archive.file_count);
  expect(archiveManifest.files).toHaveLength(report.archive.file_count);
  expect(report.records).toHaveLength(report.archive.file_count);
  expect(
    new Set(archiveManifest.files.map((item) => item.archive_path)).size,
  ).toBe(report.archive.file_count);
  const manifestBySource = new Map(
    archiveManifest.files.map((item) => [item.source_path, item]),
  );
  expect(manifestBySource.size).toBe(report.archive.file_count);
  for (const item of report.records) {
    const archived = manifestBySource.get(item.path);
    expect(archived, item.path).toBeDefined();
    expect(item.archive_path).toBe(archived?.archive_path);
    await expect(
      access(join(repository, item.archive_path)),
    ).resolves.toBeUndefined();
    expect(await sha256(join(repository, item.archive_path))).toBe(
      archived?.sha256,
    );
  }
  for (const relative of ["src", "tests", "scripts"]) {
    expect(await pythonFiles(relative)).toEqual([]);
  }
  await expect(
    access(join(repository, "pyproject.toml")),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(access(join(repository, "uv.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  for (const item of sources) {
    expect(item.ts_targets?.length, item.path).toBeGreaterThan(0);
    for (const target of item.ts_targets ?? [])
      await expect(access(join(repository, target))).resolves.toBeUndefined();
  }
  const pyproject = await readFile(
    join(repository, report.archive.root, "pyproject.toml"),
    "utf8",
  );
  expect(pyproject).not.toMatch(/\[project\.scripts\]/u);
  expect(pyproject).not.toMatch(/sciretriever\.entry\.cli\.main/u);
});
