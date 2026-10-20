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
    for (const workspace of ["packages/contracts", "apps/server"]) {
      const manifest = JSON.parse(
        readFileSync(join(repository, workspace, "package.json"), "utf8"),
      ) as {
        name: string;
        version: string;
        dependencies?: Record<string, string>;
      };
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependency.startsWith("@sciretriever/")) continue;
        const child = await visit(dependency, join(repository, workspace));
        overrides[`${manifest.name}@${manifest.version}>${dependency}`] =
          `file:./${child.tarball}`;
      }
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
      const nativeHash = await sha256(bytes);
      const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
      assert.equal(await sha256(bytes), nativeHash);
      Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
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
      assert.match(assets.get('/').body.toString(), /id="root"/);
      for (const route of ['/live.js', '/workspace.css', '/reader.js', '/reading.css']) assert.equal(assets.has(route), false, route);
      for (const route of ['/auth', '/auth.js', '/auth.css']) assert.ok(assets.get(route)?.body.length > 100, route);
      assert.equal(assets.get('/auth').contentType, 'text/html; charset=utf-8');
      const readerFiles = ['/reader/pdf.worker.mjs', '/reader/katex.css', '/reader/text-layer.css', '/reader/third-party-notices.txt', '/reader/fonts/KaTeX_Main-Regular.woff2', '/reader/standard_fonts/LiberationSans-Regular.ttf'];
      for (const route of readerFiles) assert.ok(assets.get(route)?.body.length > 100, route);
      const serverRoot = dirname(fileURLToPath(import.meta.resolve('@sciretriever/server')));
      const reactFiles = JSON.parse(readFileSync(join(serverRoot, 'web/react/assets.json'), 'utf8'));
      assert.ok(reactFiles.includes('index.html'));
      assert.ok(reactFiles.includes('third-party-notices.txt'));
      for (const name of reactFiles) assert.ok(assets.get(name === 'index.html' ? '/' : '/' + name)?.body.length > 0, name);
      for (const route of assets.keys()) assert.ok(['/', '/auth', '/auth.js', '/auth.css'].includes(route) || route.startsWith('/reader/') || reactFiles.includes(route.slice(1)), route);
      assert.ok(reactFiles.some(name => name.endsWith('.woff2')));
      assert.ok(reactFiles.some(name => name.endsWith('.css')));
      assert.match(assets.get('/third-party-notices.txt').body.toString(), /react-aria-components@/);
      assert.match(assets.get('/third-party-notices.txt').body.toString(), /Apache License/);
      assert.match(assets.get('/third-party-notices.txt').body.toString(), /SIL OPEN FONT LICENSE/);
      assert.equal(assets.has('/assets.json'), false);
      assert.equal(existsSync(join(serverRoot, 'web/next')), false);
      assert.equal(assets.get('/reader/pdf.worker.mjs').contentType, 'text/javascript');
      assert.equal(assets.get('/reader/fonts/KaTeX_Main-Regular.woff2').contentType, 'font/woff2');
      assert.ok([...assets.keys()].some(route => route.startsWith('/reader/cmaps/') && route.endsWith('.bcmap')));
      assert.ok([...assets.keys()].some(route => route.startsWith('/reader/wasm/') && route.endsWith('.wasm')));
      assert.equal(assets.has('/package.json'), false);

      const http = await startWorkbenchHttp({ session, assets, access: { host: '127.0.0.1' } });
      assert.equal(typeof http.apiKey, 'string');
      const anonymous = await fetch(http.origin, { redirect: 'manual' });
      assert.equal(anonymous.status, 303);
      const login = await fetch(http.origin + '/auth/login', {
        method: 'POST', headers: { Origin: http.origin, 'Content-Type': 'application/json', 'X-Workbench-Init': '1' },
        body: JSON.stringify({ password: http.apiKey }),
      });
      assert.equal(login.status, 200);
      const authCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const rootResponse = await fetch(http.origin, { headers: { Cookie: authCookie } });
      assert.equal(rootResponse.status, 200);
      const workbenchPage = await rootResponse.text();
      assert.match(workbenchPage, /SciRetriever · 文献库/);
      assert.match(workbenchPage, /id="root"/);
      const cookie = authCookie + '; ' + (rootResponse.headers.get('set-cookie') ?? '').split(';')[0];
      for (const path of ['/next', '/next/', '/next/index.html']) {
        const alias = await fetch(http.origin + path + '?view=web&session=installed-page', { headers: { cookie }, redirect: 'manual' });
        assert.equal(alias.status, 404);
        assert.equal(alias.headers.has('location'), false);
      }
      const reactScript = reactFiles.find(name => name.startsWith('assets/index-') && name.endsWith('.js'));
      assert.ok(reactScript);
      const chunk = await fetch(http.origin + '/' + reactScript, { headers: { cookie } });
      assert.equal(chunk.status, 200);
      assert.ok((chunk.headers.get('content-type') ?? '').includes('text/javascript'));
      assert.ok((await chunk.arrayBuffer()).byteLength > 100);
      await http.close();
      await session.close();
      await application.close();
      const migrated = await createApplication(home, { executionSchema: 'upgrade-synthetic' });
      await migrated.close();
      const maintenanceAssets = await loadMaintenanceWorkbenchAssets();
      for (const route of ['/', '/query', '/reader/pdf.worker.mjs']) assert.ok(maintenanceAssets.has(route), route);
      assert.match(maintenanceAssets.get('/').body.toString(), /data-entry="maintenance"/);
      assert.match(maintenanceAssets.get('/query').body.toString(), /data-entry="query"/);
      for (const name of reactFiles) assert.ok(maintenanceAssets.has(name === 'index.html' ? '/' : '/' + name), name);
      const maintenance = await startMaintenanceWorkbench({ home });
      const maintenancePage = await fetch(maintenance.origin);
      assert.equal(maintenancePage.status, 200);
      assert.match(await maintenancePage.text(), /data-entry="maintenance"/);
      const oldQuery = await fetch(maintenance.origin + '/next/query?view=lib', { redirect: 'manual' });
      assert.equal(oldQuery.status, 404);
      assert.equal(oldQuery.headers.has('location'), false);
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
        if (name === 'server') {
          for (const module of ['service', 'publication']) {
            for (const suffix of ['.js', '.d.ts']) assert.equal(existsSync(join(root, 'dist', 'parsing', module + suffix)), false);
          }
        }
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
