import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readlink, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

it("builds a Python-free portable runtime and executes its bundled Node CLI", async () => {
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
    await promisify(execFile)(
      process.execPath,
      ["scripts/package/build-portable.mjs", "--output", output],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 120_000,
        env: buildEnvironment,
      },
    );
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
    for (const module of ["service", "publication"]) {
      for (const suffix of [".js", ".d.ts"])
        expect(
          manifest.files.some((file) =>
            file.path.endsWith(`/dist/parsing/${module}${suffix}`),
          ),
        ).toBe(false);
    }
    for (const retired of [
      "live.html",
      "live.js",
      "query.html",
      "query.js",
      "maintenance.html",
      "maintenance.js",
      "reader.js",
      "reading.css",
      "workspace.css",
      "styles.css",
      "live.css",
    ])
      expect(
        manifest.files.some((file) =>
          file.path.endsWith(`/dist/web/${retired}`),
        ),
        retired,
      ).toBe(false);
    for (const resource of [
      "auth.html",
      "auth.js",
      "auth.css",
      "reader/pdf.worker.mjs",
      "reader/katex.css",
      "reader/text-layer.css",
      "reader/fonts/KaTeX_Main-Regular.woff2",
      "reader/standard_fonts/LiberationSans-Regular.ttf",
    ]) {
      expect(
        manifest.files.some((file) =>
          file.path.endsWith(`/dist/web/${resource}`),
        ),
        resource,
      ).toBe(true);
    }
    expect(
      manifest.files.some((file) =>
        /\/dist\/web\/reader\/cmaps\/.*\.bcmap$/.test(file.path),
      ),
    ).toBe(true);
    expect(
      manifest.files.some((file) =>
        /\/dist\/web\/reader\/wasm\/.*\.wasm$/.test(file.path),
      ),
    ).toBe(true);

    const serverRoot = join(
      output,
      "app/node_modules/@sciretriever/server/dist/web",
    );
    const reactFiles: string[] = JSON.parse(
      readFileSync(join(serverRoot, "react/assets.json"), "utf8"),
    );
    expect(reactFiles).toContain("index.html");
    expect(reactFiles).toContain("third-party-notices.txt");
    expect(reactFiles.some((name) => name.endsWith(".js"))).toBe(true);
    expect(reactFiles.some((name) => name.endsWith(".css"))).toBe(true);
    expect(reactFiles.some((name) => name.endsWith(".woff2"))).toBe(true);
    for (const name of reactFiles) {
      expect(
        manifest.files.some((file) =>
          file.path.endsWith(`/dist/web/react/${name}`),
        ),
        name,
      ).toBe(true);
      expect(
        readFileSync(join(serverRoot, "react", name)).byteLength,
        name,
      ).toBeGreaterThan(0);
    }
    expect(
      manifest.files
        .filter((file) => file.path.includes("/dist/web/react/"))
        .map((file) => file.path.split("/dist/web/react/")[1])
        .sort(),
    ).toEqual([...reactFiles, "assets.json"].sort());
    expect(
      manifest.files.some((file) => file.path.includes("/dist/web/next/")),
    ).toBe(false);
    expect(
      readFileSync(join(serverRoot, "react/third-party-notices.txt"), "utf8"),
    ).toContain("react-aria-components@");
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
        expect.objectContaining({ name: "mupdf", status: "ready" }),
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

    // Launch outside the checkout and installed app directory. Both generations must
    // use the package's Node and its private worker, with no checkout-relative entry.
    const web = spawn(
      join(output, "bin", "sciretriever"),
      ["web", "--host", "127.0.0.1", "--port", "0", "--json"],
      {
        cwd: parent,
        env: {
          ...environment,
          SCIRETRIEVER_WEB_PASSWORD: workbenchTestAccess.password,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const ready: { urls: string[] }[] = [];
    let stdout = "",
      stderr = "",
      incomplete = "";
    web.stdout.on("data", (bytes) => {
      const text = String(bytes);
      stdout += text;
      incomplete += text;
      const lines = incomplete.split("\n");
      incomplete = lines.pop()!;
      for (const line of lines)
        if (line.trim()) ready.push(JSON.parse(line) as { urls: string[] });
    });
    web.stderr.on("data", (bytes) => {
      stderr += String(bytes);
    });
    const exit = new Promise<number | null>((done) => web.once("exit", done));
    try {
      await expect.poll(() => ready.length, { timeout: 20000 }).toBe(1);
      const packagedNode = await realpath(join(output, "runtime/bin/node"));
      expect(await readlink(`/proc/${web.pid}/exe`)).toBe(packagedNode);
      const parentChildren = readFileSync(
        `/proc/${web.pid}/task/${web.pid}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/u);
      expect(parentChildren).toHaveLength(1);
      expect(await readlink(`/proc/${parentChildren[0]}/exe`)).toBe(
        packagedNode,
      );
      const origin = new URL(
        ready[0]!.urls.find((u) => u.startsWith("http://127.0.0.1:"))!,
      ).origin;
      const auth = await workbenchLogin(origin),
        root = await fetch(origin, { headers: { Cookie: auth } });
      const cookie = `${auth}; ${root.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ")}`;
      const registration = await fetch(`${origin}/api/clients`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-Workbench-Init": "1",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const grant = (await registration.json()) as {
        client_id: string;
        csrf: string;
      };
      const directoryResponse = await fetch(
        `${origin}/api/configuration/sources?client_id=${grant.client_id}`,
        { headers: { Cookie: cookie } },
      );
      const directory = (await directoryResponse.json()) as {
        result: { binding_revision: string; runtime: { runtime_id: string } };
      };
      const response = await fetch(
        `${origin}/api/configuration/apply?client_id=${grant.client_id}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "X-Workbench-Csrf": grant.csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            request_id: randomUUID(),
            runtime_id: directory.result.runtime.runtime_id,
            target_binding_revision: directory.result.binding_revision,
          }),
        },
      );
      expect(response.status).toBe(202);
      await response.arrayBuffer();
      await expect.poll(() => ready.length, { timeout: 20000 }).toBe(2);
      expect(ready[1]!.urls).toEqual(ready[0]!.urls);
      expect(
        (
          await fetch(`${origin}/api/configuration/sources`, {
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(401);
      const nextChildren = readFileSync(
        `/proc/${web.pid}/task/${web.pid}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/u);
      expect(nextChildren).toHaveLength(1);
      expect(nextChildren).not.toEqual(parentChildren);
      expect(await readlink(`/proc/${nextChildren[0]}/exe`)).toBe(packagedNode);
      expect(stdout + stderr).not.toContain(workbenchTestAccess.password);
    } finally {
      if (web.exitCode === null && web.signalCode === null) web.kill("SIGTERM");
      expect(await exit, stderr).toBe(0);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 150_000);
