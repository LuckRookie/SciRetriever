import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

it("installs packed workspace modules and exercises their public boundaries without source files", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "sciretriever-package-entrypoints-"),
  );
  const runPnpm = async (args: string[], cwd: string): Promise<string> => {
    const result = await promisify(execFile)(
      "pnpm",
      [
        "--config.userconfig=/dev/null",
        "--config.globalconfig=/dev/null",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, npm_config_ignore_scripts: "true" },
      },
    );
    return result.stdout;
  };
  try {
    await runPnpm(["build"], repository);
    for (const workspace of ["packages/contracts", "apps/server"]) {
      await runPnpm(
        ["pack", "--pack-destination", directory],
        join(repository, workspace),
      );
    }
    const packed = new Map<string, { version: string; tarball: string }>();
    const overrides: Record<string, string> = {};
    const visit = async (
      name: string,
      from: string,
    ): Promise<{ version: string; tarball: string }> => {
      let root = from;
      while (!existsSync(join(root, "node_modules", name, "package.json"))) {
        const parent = dirname(root);
        if (parent === root)
          throw new Error(`Missing runtime dependency: ${name}`);
        root = parent;
      }
      const packageDirectory = realpathSync(join(root, "node_modules", name));
      const manifest: unknown = JSON.parse(
        readFileSync(join(packageDirectory, "package.json"), "utf8"),
      );
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !("version" in manifest) ||
        typeof manifest.version !== "string"
      )
        throw new Error("Invalid runtime package manifest");
      const identity = `${name}@${manifest.version}`;
      const previous = packed.get(identity);
      if (previous) return previous;
      const tarball = `${name.replace(/^@/u, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
      const entry = { version: manifest.version, tarball };
      packed.set(identity, entry);
      await runPnpm(
        ["pack", "--pack-destination", directory],
        packageDirectory,
      );
      const runtimeManifest = manifest as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      const runtimeDependencies = new Set([
        ...Object.keys(runtimeManifest.dependencies ?? {}),
        ...Object.keys(runtimeManifest.peerDependencies ?? {}).filter(
          (name) => !runtimeManifest.peerDependenciesMeta?.[name]?.optional,
        ),
      ]);
      for (const dependency of runtimeDependencies) {
        const child = await visit(dependency, packageDirectory);
        overrides[`${identity}>${dependency}`] = `file:./${child.tarball}`;
      }
      return entry;
    };
    const serverManifest = JSON.parse(
      readFileSync(join(repository, "apps/server/package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(serverManifest.dependencies ?? {})) {
      if (dependency.startsWith("@sciretriever/")) continue;
      const child = await visit(dependency, join(repository, "apps/server"));
      overrides[
        `${serverManifest.name}@${serverManifest.version}>${dependency}`
      ] = `file:./${child.tarball}`;
    }
    const dependencies = Object.fromEntries(
      ["contracts", "server"].map((name) => {
        const tarball = readdirSync(directory).find(
          (entry) =>
            entry.startsWith(`sciretriever-${name}-`) && entry.endsWith(".tgz"),
        );
        if (!tarball) throw new Error("workspace package was not created");
        return [`@sciretriever/${name}`, `file:./${tarball}`];
      }),
    );
    for (const [name, { tarball }] of packed) {
      if (!existsSync(join(directory, tarball)))
        throw new Error(`${name} package was not created`);
      dependencies[name.slice(0, name.lastIndexOf("@"))] ??=
        `file:./${tarball}`;
    }
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies,
        pnpm: {
          overrides: { ...dependencies, ...overrides },
        },
      }),
    );
    await runPnpm(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--store-dir",
        join(directory, "store"),
        "--cache-dir",
        join(directory, "cache"),
      ],
      directory,
    );
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { dirname, join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import { canonicalJsonBytes, sha256 } from '@sciretriever/contracts';
      import { ConfigurationBoundaryError, createApplication, loadMaintenanceWorkbenchAssets, loadWorkbenchAssets, parseConfiguration, startMaintenanceWorkbench, startWorkbenchHttp, WorkbenchSession } from '@sciretriever/server';

      const sdk = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js');
      const express = createRequire(sdk).resolve('express');
      const bodyParser = createRequire(express).resolve('body-parser');
      const dependencyVersion = (from, name) => {
        let directory = dirname(createRequire(from).resolve(name));
        while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
        return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
      };
      assert.equal(dependencyVersion(sdk, 'content-type'), '1.0.5');
      assert.equal(dependencyVersion(bodyParser, 'content-type'), '2.1.0');

      const bytes = canonicalJsonBytes({ z: '末', a: 1 });
      assert.equal(new TextDecoder().decode(bytes), '{"a":1,"z":"末"}');
      assert.match(await sha256(bytes), /^[0-9a-f]{64}$/);
      assert.equal(parseConfiguration('').sources.metadata.limit, 500);
      const home = mkdtempSync(join(tmpdir(), 'sciretriever-installed-smoke-'));
      const application = await createApplication(home);
      const session = new WorkbenchSession('installed-fixture', {
        id: 'installed-page', close: async () => {}, title: async () => 'Installed fixture',
        url: () => 'http://127.0.0.1/fixture',
        snapshot: async () => ({ document_generation: 1, url: 'http://127.0.0.1/fixture', title: 'Installed fixture', viewport: { width: 800, height: 600, device_scale_factor: 1 }, screenshot: null }),
        apply: async () => {},
      }, { max_actions: 2, max_model_calls: 1, max_retries: 1, max_bytes: 1024, deadline_ms: 10000 });
      await session.refresh();
      const assets = await loadWorkbenchAssets();
      assert.deepEqual([...assets.keys()], ['/', '/styles.css', '/live.css', '/workspace.css', '/live.js']);
      const http = await startWorkbenchHttp({ session, assets });
      const rootResponse = await fetch(http.origin);
      assert.equal(rootResponse.status, 200);
      const workbenchPage = await rootResponse.text();
      assert.match(workbenchPage, /SciRetriever 文献库/);
      assert.match(workbenchPage, /id="side"/);
      assert.match(workbenchPage, /id="main"/);
      const cookie = (rootResponse.headers.get('set-cookie') ?? '').split(';')[0];
      const scriptResponse = await fetch(http.origin + '/live.js', { headers: { cookie } });
      assert.equal(scriptResponse.status, 200);
      assert.ok((scriptResponse.headers.get('content-type') ?? '').includes('text/javascript'));
      assert.ok((await scriptResponse.text()).includes('/api/candidate/'));
      await http.close();
      await session.close();
      await application.close();
      const migrated = await createApplication(home, { executionSchema: 'upgrade-synthetic' });
      await migrated.close();
      const maintenanceAssets = await loadMaintenanceWorkbenchAssets();
      assert.deepEqual([...maintenanceAssets.keys()], ['/', '/query', '/styles.css', '/live.css', '/maintenance.js', '/query.js']);
      const maintenance = await startMaintenanceWorkbench({ home });
      const maintenancePage = await fetch(maintenance.origin);
      assert.equal(maintenancePage.status, 200);
      assert.match(await maintenancePage.text(), /手动 PDF 接纳/);
      assert.equal((await fetch(maintenance.origin + '/maintenance.js')).status, 200);
      assert.equal((await fetch(maintenance.origin + '/query')).status, 200);
      await maintenance.close();
      rmSync(home, { recursive: true, force: true });
      assert.throws(() => parseConfiguration('[unknown]\\nvalue = 1'), ConfigurationBoundaryError);
      const manifests = {};
      for (const name of ['contracts', 'server']) {
        const entry = fileURLToPath(import.meta.resolve('@sciretriever/' + name));
        const root = dirname(dirname(entry));
        manifests[name] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        assert.equal(existsSync(join(root, 'src')), false);
        assert.equal(existsSync(join(root, 'test')), false);
        assert.equal(existsSync(join(root, 'dist', 'tsconfig.tsbuildinfo')), false);
      }
      assert.equal(manifests.server.dependencies['@sciretriever/contracts'], manifests.contracts.version);
      await assert.rejects(import('@sciretriever/server/dist/configuration/credentials.js'),
        { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      process.stdout.write('public package boundaries verified');
    `,
      ],
      { cwd: directory, encoding: "utf8", timeout: 30_000 },
    );
    expect(output).toBe("public package boundaries verified");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 150_000);
