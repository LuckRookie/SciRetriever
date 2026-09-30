import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

it("builds a Python-free portable runtime and executes its bundled Node CLI", () => {
  const parent = mkdtempSync(join(tmpdir(), "sciretriever-portable-test-"));
  const output = join(parent, "runtime");
  const home = join(parent, "home");
  // The packaged CLI must resolve its fixed home from the OS user profile, never from a
  // test-only override. Only the CLI invocations are sandboxed that way: the packaging
  // toolchain keeps the real host environment (its package store and cache live under
  // HOME), while every internal SCI* hook is stripped from both.
  const buildEnvironment: NodeJS.ProcessEnv = { ...process.env };
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  for (const sandboxed of [buildEnvironment, environment]) {
    delete sandboxed.SCIRETRIEVER_HOME;
    delete sandboxed.SCIRETRIEVER_CLOAK_BUNDLE;
  }
  try {
    const built = spawnSync(
      process.execPath,
      ["scripts/package/build-portable.mjs", "--output", output],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 120_000,
        env: buildEnvironment,
      },
    );
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(output, "release-manifest.json"), "utf8"),
    ) as {
      files: readonly { readonly path: string }[];
      node_version: string;
    };
    expect(manifest.node_version).toBe(process.version);
    expect(
      manifest.files.some((file) =>
        /(?:^|\/)python(?:\d|$)|\.py[co]?$/u.test(file.path),
      ),
    ).toBe(false);
    expect(
      manifest.files.some((file) =>
        file.path.endsWith(
          "/@sciretriever/server/dist/storage/sqlite/worker-runtime.js",
        ),
      ),
    ).toBe(true);
    expect(
      manifest.files.some((file) =>
        file.path.endsWith("/dist/web/maintenance.html"),
      ),
    ).toBe(true);
    expect(
      manifest.files.some((file) =>
        file.path.endsWith("/dist/web/maintenance.js"),
      ),
    ).toBe(true);
    const doctor = spawnSync(
      join(output, "bin", "sciretriever"),
      ["doctor", "--json"],
      { encoding: "utf8", timeout: 30_000, env: environment },
    );
    expect(doctor.status, doctor.stdout + doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      platform: "linux",
      architecture: "x64",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "pdfinfo", status: "ready" }),
        expect.objectContaining({ name: "cloakbrowser", status: "blocked" }),
      ]),
    });
    const status = spawnSync(
      join(output, "bin", "sciretriever"),
      ["config", "status", "--json"],
      { encoding: "utf8", timeout: 30_000, env: environment },
    );
    expect(status.status, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      version: 1,
      network_performed: false,
      browser_launched: false,
    });
    const library = spawnSync(
      join(output, "bin", "sciretriever"),
      ["literature", "search", "--json"],
      { encoding: "utf8", timeout: 30_000, env: environment },
    );
    expect(library.status, library.stdout + library.stderr).toBe(3);
    expect(JSON.parse(library.stderr)).toEqual({
      code: "query-not-initialized",
    });
    expect(existsSync(join(home, "catalog.sqlite"))).toBe(false);

    const imported = spawnSync(
      join(output, "bin", "sciretriever"),
      ["import", "metadata", "bibtex", "-", "--json"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: environment,
        input:
          "@article{portable, title={Portable synthetic paper}, year={2026}, doi={10.5555/portable.synthetic}}",
      },
    );
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({
      items: [{ disposition: "created" }],
    });
    expect(existsSync(join(home, "catalog.sqlite"))).toBe(true);

    const searched = spawnSync(
      join(output, "bin", "sciretriever"),
      ["literature", "search", "--text", "Portable synthetic paper", "--json"],
      { encoding: "utf8", timeout: 30_000, env: environment },
    );
    expect(searched.status, searched.stdout + searched.stderr).toBe(0);
    expect(JSON.parse(searched.stdout)).toMatchObject({
      items: [
        {
          literature: { metadata: { title: "Portable synthetic paper" } },
        },
      ],
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 150_000);
