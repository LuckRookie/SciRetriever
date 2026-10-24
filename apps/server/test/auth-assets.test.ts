import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { loadAuthAssets } from "../src/workbench/assets.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { workbenchTestAccess } from "./workbench-auth-fixture.js";

it(
  "builds and packages every login font referenced by CSS with a content hash",
  { timeout: 0 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-auth-build-"));
    const directory = join(root, "dist/web");
    try {
      await promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        "import { buildAuthAssets } from './scripts/build-react-assets.mjs'; await buildAuthAssets(process.argv[1]);",
        directory,
      ]);
      const assets = await loadAuthAssets(pathToFileURL(`${directory}/`));
      const css = assets.get("/auth.css")!.body.toString();
      const urls = [...css.matchAll(/url\(([^)]+)\)/gu)].map((match) =>
        match[1]!.replace(/["']/gu, ""),
      );
      expect(urls.length).toBeGreaterThan(4);
      for (const url of urls) {
        expect(url).toMatch(
          /^\/auth-fonts\/[A-Za-z0-9_-]+-[A-Z0-9]{8}\.woff2$/u,
        );
        const font = assets.get(url)!;
        expect(font.contentType).toBe("font/woff2");
        expect(Buffer.from(font.body).subarray(0, 4).toString()).toBe("wOF2");
      }
      expect(
        [...assets.keys()]
          .filter((path) => path.startsWith("/auth-fonts/"))
          .sort(),
      ).toEqual([...new Set(urls)].sort());
      for (const family of [
        "Source Sans 3",
        "Source Serif 4",
        "Noto Sans SC",
        "Noto Serif SC",
      ])
        expect(css).toContain(family);
      const source = await readFile(
        new URL(
          "../../web/src/app/styles/fonts/source-serif-4-latin-wght-normal.woff2",
          import.meta.url,
        ),
      );
      const serif = [...assets.entries()].find(([path]) =>
        path.startsWith("/auth-fonts/source-serif-4-latin-wght-normal-"),
      );
      expect(serif?.[1].body).toEqual(source);

      // Verify the real package allowlist without rebuilding/installing the whole runtime.
      await writeFile(
        join(root, "package.json"),
        await readFile(new URL("../package.json", import.meta.url)),
      );
      const packed = await promisify(execFile)(
        "npm",
        [
          "pack",
          "--dry-run",
          "--json",
          "--ignore-scripts",
          "--offline",
          "--cache",
          join(root, "cache"),
        ],
        { cwd: root },
      );
      const packages = JSON.parse(packed.stdout) as {
        files: { path: string }[];
      }[];
      const files = packages[0]!.files.map((file) => file.path);
      for (const file of [
        "auth.html",
        "auth.js",
        "auth.css",
        "auth-fonts.json",
        ...urls.map((url) => url.slice(1)),
      ])
        expect(files, file).toContain(`dist/web/${file}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("serves only registered login fonts before authentication with the unchanged CSP and private cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-auth-registry-"));
  const session = new ProductionWorkbenchSession(null, undefined);
  let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
  const font = "auth-fonts/font-ABCDEFGH.woff2";
  try {
    await mkdir(join(root, "auth-fonts"));
    for (const name of [
      "auth.html",
      "auth.js",
      "auth.css",
      font,
      "auth-fonts/unregistered-ABCDEFGH.woff2",
    ])
      await writeFile(join(root, name), `Synthetic ${name}`);
    await writeFile(join(root, "auth-fonts.json"), JSON.stringify([font]));
    const assets = new Map(await loadAuthAssets(pathToFileURL(`${root}/`)));
    expect(assets.has("/auth-fonts/unregistered-ABCDEFGH.woff2")).toBe(false);
    assets.set("/assets/private-ABCDEFGH.woff2", {
      contentType: "font/woff2",
      body: "private font",
    });
    assets.set("/auth-fonts/private-ABCDEFGH.woff2", {
      contentType: "application/json",
      body: "private data",
    });
    assets.set("/auth-fonts/unhashed.woff2", {
      contentType: "font/woff2",
      body: "unhashed font",
    });
    server = await startWorkbenchHttp({
      session,
      assets,
      access: workbenchTestAccess,
    });
    const response = await fetch(`${server.origin}/${font}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(
      response.headers
        .get("content-security-policy")
        ?.match(/font-src [^;]+/u)?.[0],
    ).toBe("font-src 'self' blob:");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(`Synthetic ${font}`);
    for (const path of [
      "/auth-fonts.json",
      "/auth-fonts/",
      "/auth-fonts/unregistered-ABCDEFGH.woff2",
      "/auth-fonts/private-ABCDEFGH.woff2",
      "/auth-fonts/unhashed.woff2",
      "/assets/private-ABCDEFGH.woff2",
      "/api/view",
      "/api/v1/query/status",
      `/${font}?download=1`,
      "/auth-fonts/%2e%2e/private.woff2",
    ]) {
      const denied = await fetch(server.origin + path);
      expect(denied.status, path).toBe(401);
      expect(denied.headers.get("cache-control"), path).toBe("no-store");
      expect(await denied.json(), path).toEqual({ code: "login-required" });
    }
    for (const init of [
      { method: "POST" },
      { method: "GET", headers: { Origin: "https://external.invalid" } },
    ]) {
      const denied = await fetch(`${server.origin}/${font}`, init);
      expect(denied.status).toBe(init.method === "POST" ? 401 : 403);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      await denied.text();
    }
  } finally {
    await server?.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects manifests that try to expose anything other than hashed login WOFF2 files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-auth-manifest-"));
  try {
    for (const names of [
      {},
      [42],
      ["../private.woff2"],
      ["/auth-fonts/font-ABCDEFGH.woff2"],
      ["auth-fonts/../font-ABCDEFGH.woff2"],
      ["auth-fonts/%2e%2e/font-ABCDEFGH.woff2"],
      ["auth-fonts/font-ABCDEFGH.js"],
      ["auth-fonts/font.woff2"],
      ["auth-fonts/font-ABCDEFGH.woff2?download=1"],
      ["assets/font-ABCDEFGH.woff2"],
      ["auth-fonts/font-ABCDEFGH.woff2", "auth.js"],
    ]) {
      await writeFile(join(root, "auth-fonts.json"), JSON.stringify(names));
      await expect(loadAuthAssets(pathToFileURL(`${root}/`))).rejects.toThrow(
        "Invalid login font asset manifest",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
