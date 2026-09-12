import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

it("builds a Python-free portable runtime and executes its bundled Node CLI", () => {
  const parent = mkdtempSync(join(tmpdir(), "sciretriever-portable-test-"));
  const output = join(parent, "runtime");
  const home = join(parent, "home");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SCIRETRIEVER_HOME: home,
  };
  delete environment.SCIRETRIEVER_CLOAK_BUNDLE;
  try {
    const built = spawnSync(
      process.execPath,
      ["scripts/package/build-portable.mjs", "--output", output],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 120_000,
        env: environment,
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
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 150_000);
