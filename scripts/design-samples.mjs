import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { dirname, resolve, relative, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = join(root, "sandbox/runs/design-samples");
const current = join(runs, "current.json");
const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const [command, ...args] = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (
    ![
      "--label",
      "--themes",
      "--port",
      "--repository",
      "--session",
      "--pages",
    ].includes(args[i]) ||
    !args[i + 1] ||
    flags.has(args[i])
  )
    throw new Error("Invalid design sample arguments");
  flags.set(args[i], args[i + 1]);
}
const sessionFile = resolve(flags.get("--session") ?? current);
if (relative(runs, sessionFile).startsWith(".."))
  throw new Error(
    "Session manifest must stay inside sandbox/runs/design-samples",
  );

async function bundle(directory, repository) {
  const output = join(directory, "fixture.mjs");
  await build({
    stdin: {
      contents:
        'export * from "./apps/web/test/design-samples-fixture.ts"; export * from "./apps/web/test/design-samples-pages.ts";',
      resolveDir: root,
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    target: "node22",
    plugins: [
      {
        name: "selected-server-build",
        setup(api) {
          api.onResolve({ filter: /^@sciretriever\/contracts$/ }, () => ({
            path: join(repository, "packages/contracts/dist/index.js"),
            external: true,
          }));
          api.onResolve({ filter: /\.\.?\// }, (arg) => {
            const full = resolve(arg.resolveDir, arg.path);
            const source = join(root, "apps/server/src/");
            if (full.startsWith(source))
              return {
                path: join(
                  repository,
                  "apps/server/dist",
                  relative(source, full),
                ),
                external: true,
              };
            return undefined;
          });
        },
      },
    ],
  });
  return output;
}

async function serve() {
  const repository = resolve(flags.get("--repository") ?? root);
  const port = Number(flags.get("--port") ?? 4175);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || port === 4174)
    throw new Error("Use a non-production sample port");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runs, "sciretriever-design-"));
  const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: repository,
  });
  const { stdout: status } = await exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: repository },
  );
  // Build the selected checkout: a baseline never loads another checkout's front-end assets.
  const buildResult = await exec("pnpm", ["build"], {
    cwd: repository,
    maxBuffer: 32 * 1024 * 1024,
  });
  await writeFile(
    join(directory, "build.log"),
    buildResult.stdout + buildResult.stderr,
  );
  const entry = await bundle(directory, repository);
  const { startDesignSamples } = await import(pathToFileURL(entry));
  const { loadWorkbenchAssets } = await import(
    pathToFileURL(join(repository, "apps/server/dist/workbench/assets.js"))
  );
  const password = randomBytes(32).toString("base64url");
  const passwordFile = join(directory, "password");
  await writeFile(passwordFile, password, { mode: 0o600 });
  // Fail closed for accidental fetches outside the synthetic loopback server.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (...input) => {
    const url = new URL(
      input[0] instanceof globalThis.Request ? input[0].url : String(input[0]),
    );
    if (url.origin !== `http://127.0.0.1:${port}`)
      throw new Error("Design sample external request blocked");
    return nativeFetch(...input);
  };
  let server;
  try {
    server = await startDesignSamples({
      assets: await loadWorkbenchAssets(),
      password,
      port,
      homeParent: directory,
    });
    const gallery = (
      await readFile(join(repository, "apps/web/src/app/data/url.ts"), "utf8")
    ).includes('"gallery"');
    const assetsManifest = await readFile(
      join(repository, "apps/server/dist/web/react/assets.json"),
    );
    const state = {
      origin: server.origin,
      passwordFile,
      directory,
      entry,
      pid: process.pid,
      commit: commit.trim(),
      source_dirty: status.trim().length > 0,
      gallery,
      assets_manifest_sha256: digest(assetsManifest),
      ids: server.ids,
      inventory: server.inventory,
      created_at: new Date().toISOString(),
    };
    await json(join(directory, "session.json"), state);
    await json(sessionFile, state);
    process.stdout.write(
      `设计样例库：${server.origin}/\n合成数据；外部服务禁用。口令文件（0600）：${passwordFile}\n会话：${sessionFile}\n`,
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    try {
      await server?.close();
    } finally {
      globalThis.fetch = nativeFetch;
      await rm(passwordFile, { force: true });
      const saved = await readFile(sessionFile, "utf8").catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (saved && JSON.parse(saved).pid === process.pid) await rm(sessionFile);
    }
  }
}
async function capture() {
  const label = flags.get("--label");
  if (!label || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(label))
    throw new Error(
      "capture requires --label with letters, digits, hyphens or underscores",
    );
  const themes = (flags.get("--themes") ?? "light").split(",");
  if (
    !themes.length ||
    themes.some((s) => !["light", "dark"].includes(s)) ||
    new Set(themes).size !== themes.length
  )
    throw new Error("Use --themes light,dark");
  const state = JSON.parse(await readFile(sessionFile, "utf8"));
  if (
    new URL(state.origin).hostname !== "127.0.0.1" ||
    new URL(state.origin).port === "4174"
  )
    throw new Error("Only the synthetic loopback service may be captured");
  if (relative(runs, state.passwordFile).startsWith(".."))
    throw new Error("Synthetic password path escaped sandbox");
  const stat = await lstat(state.passwordFile);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
    throw new Error("Synthetic password must be a private regular file");
  const password = await readFile(state.passwordFile, "utf8");
  const pagesFile = join(state.directory, "capture-pages.mjs");
  await build({
    entryPoints: [join(root, "apps/web/test/design-samples-pages.ts")],
    outfile: pagesFile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node22",
  });
  const { designSamplePages: allPages, reachDesignSample } = await import(
    pathToFileURL(pagesFile)
  );
  const selected = flags.get("--pages")?.split(",");
  if (selected?.some((id) => !allPages.some((p) => p.id === id)))
    throw new Error("Unknown screenshot page");
  const designSamplePages = selected
    ? allPages.filter((p) => selected.includes(p.id))
    : allPages;
  const date = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Shanghai",
  });
  const directory = join(
    root,
    "sandbox/reports/design-samples",
    `${date}-${label}`,
  );
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // Existing evidence is never overwritten.
  const browser = await chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  const manifest = {
    commit: state.commit,
    source_dirty: state.source_dirty,
    assets_manifest_sha256: state.assets_manifest_sha256,
    created_at: new Date().toISOString(),
    label,
    synthetic: true,
    gallery_route: state.gallery ? "gallery" : "lab",
    inventory: state.inventory,
    screenshots: [],
    failures: [],
  };
  const contexts = new Map(),
    loggedIn = new Set();
  try {
    for (const theme of themes)
      for (const width of [1440, 390])
        for (const [i, entry] of designSamplePages.entries()) {
          const height = width === 390 ? 844 : 900;
          const contextKey = `${theme}-${width}-${!!entry.anonymous}`;
          const context =
            contexts.get(contextKey) ??
            (await browser.newContext({
              viewport: { width, height },
              colorScheme: theme,
              reducedMotion: "reduce",
              locale: "zh-CN",
              timezoneId: "Asia/Shanghai",
              serviceWorkers: "block",
            }));
          contexts.set(contextKey, context);
          const page = await context.newPage();
          const errors = [],
            blocked = [];
          await page.route("**/*", async (route) => {
            if (new URL(route.request().url()).origin === state.origin)
              return route.continue();
            blocked.push(new URL(route.request().url()).origin);
            await route.abort("blockedbyclient");
          });
          page.setDefaultTimeout(15000);
          page.on("pageerror", (e) => errors.push(e.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          await page.addInitScript((value) => {
            globalThis.localStorage.clear();
            globalThis.localStorage.setItem(
              "sciretriever:react:sciretriever:theme:v1",
              value,
            );
          }, theme);
          try {
            if (!entry.anonymous && !loggedIn.has(context)) {
              const response = await context.request.post(
                state.origin + "/auth/login",
                {
                  headers: { Origin: state.origin, "X-Workbench-Init": "1" },
                  data: { password },
                },
              );
              if (!response.ok())
                throw new Error(`Synthetic login failed: ${response.status()}`);
              loggedIn.add(context);
            }
            await reachDesignSample(
              page,
              state.origin,
              state.ids,
              entry,
              state.gallery,
            );
            await page.evaluate((value) => {
              globalThis.document.documentElement.dataset.theme = value;
            }, theme);
            const filename = `${String(i + 1).padStart(2, "0")}-${entry.id}-${width}${theme === "light" ? "" : "-dark"}.png`;
            const bytes = await page.screenshot({
              path: join(directory, filename),
              animations: "disabled",
            });
            const colors = await page.evaluate(async (base64) => {
              const bitmap = await globalThis.createImageBitmap(
                new globalThis.Blob(
                  [
                    Uint8Array.from(globalThis.atob(base64), (c) =>
                      c.charCodeAt(0),
                    ),
                  ],
                  { type: "image/png" },
                ),
              );
              const canvas = globalThis.document.createElement("canvas");
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(bitmap, 0, 0);
              bitmap.close();
              const data = ctx.getImageData(
                  0,
                  0,
                  canvas.width,
                  canvas.height,
                ).data,
                found = new Set();
              for (let p = 0; p < data.length; p += 4 * 17) {
                found.add(`${data[p]},${data[p + 1]},${data[p + 2]}`);
                if (found.size > 16) break;
              }
              return found.size;
            }, bytes.toString("base64"));
            if (colors < 2) throw new Error("Screenshot is a single color");
            if (errors.length || blocked.length)
              throw new Error(JSON.stringify({ errors, blocked }));
            manifest.screenshots.push({
              page: entry.id,
              name: entry.name,
              route: entry.route(state.ids, state.gallery),
              interaction: entry.interaction ?? null,
              ready: entry.ready,
              width,
              height,
              theme,
              file: filename,
              sha256: digest(bytes),
              sampled_colors: colors,
            });
          } catch (error) {
            manifest.failures.push({
              page: entry.id,
              width,
              theme,
              error: String(error),
              errors,
              blocked,
            });
            await page
              .screenshot({
                path: join(
                  directory,
                  `failed-${entry.id}-${width}-${theme}.png`,
                ),
              })
              .catch(() => {});
          } finally {
            await page.close();
            await json(join(directory, "manifest.json"), manifest);
            process.stdout.write(
              `${entry.id} ${width} ${theme}: ${manifest.failures.some((f) => f.page === entry.id && f.width === width && f.theme === theme) ? "failed" : "ok"}\n`,
            );
          }
        }
  } finally {
    await browser.close();
  }
  await json(join(directory, "manifest.json"), manifest);
  const escape = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>设计样例 ${escape(label)}</title><style>body{font:16px/1.6 system-ui;background:#f7f6f2;color:#24252b;margin:32px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:24px}figure{margin:0;padding:16px;background:white}img{width:100%;height:340px;object-fit:contain;object-position:top}small{color:#666}</style><h1>设计样例 · ${escape(label)}</h1><p>全部为合成数据。提交 ${escape(state.commit)}；${designSamplePages.length} 页 × 2 宽度 × ${themes.length} 主题；成功 ${manifest.screenshots.length}，失败 ${manifest.failures.length}。</p><main>${designSamplePages
      .flatMap((entry) =>
        manifest.screenshots.filter((s) => s.page === entry.id),
      )
      .map(
        (s) =>
          `<figure><a href="${s.file}"><img loading="lazy" src="${s.file}" alt="${escape(s.name)}"></a><figcaption>${escape(s.name)}<br><small>${s.width} × ${s.height} · ${s.theme}</small></figcaption></figure>`,
      )
      .join(
        "",
      )}</main><p>详细就绪条件、缺口和失败见 <a href="manifest.json">manifest.json</a>。</p></html>`,
  );
  process.stdout.write(
    `${directory}\n${manifest.screenshots.length}/${designSamplePages.length * 2 * themes.length} 截图通过；失败 ${manifest.failures.length}\n`,
  );
  if (manifest.failures.length) process.exitCode = 1;
}
if (command === "serve") await serve();
else if (command === "capture") await capture();
else
  throw new Error(
    "Use: node scripts/design-samples.mjs serve [--port 4175] [--repository path]; or capture --label before [--themes light,dark]",
  );
