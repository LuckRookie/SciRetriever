import { createRequire } from "node:module";
import { build as bundle } from "esbuild";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

const repository = resolve(new URL("..", import.meta.url).pathname);
const webRequire = createRequire(resolve(repository, "apps/web/package.json"));
const runtimePackages = [
  "react",
  "react-dom",
  "react-aria-components",
  "motion",
  "@tanstack/react-query",
  "@tanstack/react-virtual",
  "@tanstack/react-table",
];

/** The login entry uses shared primitives without importing application pages. */
export async function buildAuthAssets(outdir) {
  await mkdir(outdir, { recursive: true });
  const result = await bundle({
    entryPoints: [
      resolve(repository, "apps/web/src/app/features/auth/main.tsx"),
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome140",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: resolve(outdir, "auth.js"),
    loader: { ".woff2": "file" },
    assetNames: "auth-fonts/[name]-[hash]",
    publicPath: "/",
    metafile: true,
  });
  await copyFile(
    resolve(repository, "apps/web/entry/auth.html"),
    resolve(outdir, "auth.html"),
  );
  // Register only fonts emitted by this build, never arbitrary files in outdir.
  const fonts = Object.keys(result.metafile.outputs)
    .filter((name) => name.endsWith(".woff2"))
    .map((name) =>
      relative(resolve(outdir), resolve(name)).replaceAll("\\", "/"),
    )
    .sort();
  await writeFile(resolve(outdir, "auth-fonts.json"), JSON.stringify(fonts));
}

/** The synthetic preview has no API transport and keeps the production CSP. */
export async function buildSampleAssets(outdir) {
  await mkdir(outdir, { recursive: true });
  await bundle({
    entryPoints: [
      resolve(repository, "apps/web/src/app/features/sample/main.tsx"),
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome140",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: resolve(outdir, "sample.js"),
  });
  await copyFile(
    resolve(repository, "apps/web/entry/sample.html"),
    resolve(outdir, "sample.html"),
  );
}

async function packageFile(name, require) {
  try {
    return require.resolve(`${name}/package.json`);
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let directory = dirname(require.resolve(name));
    while (directory !== dirname(directory)) {
      const candidate = resolve(directory, "package.json");
      try {
        const metadata = JSON.parse(await readFile(candidate, "utf8"));
        if (metadata.name === name) return candidate;
      } catch (readError) {
        if (readError.code !== "ENOENT") throw readError;
      }
      directory = dirname(directory);
    }
    throw new Error(`Package manifest not found: ${name}`);
  }
}

async function notices() {
  const seen = new Set(),
    sections = [];
  const visit = async (name, require) => {
    const file = await packageFile(name, require);
    const metadata = JSON.parse(await readFile(file, "utf8"));
    const id = `${metadata.name}@${metadata.version}`;
    if (seen.has(id)) return;
    seen.add(id);
    const directory = dirname(file);
    const licenseFiles = (await readdir(directory))
      .filter((entry) =>
        /^(license|copying|notice|copyrightnotice)(\.|$)/iu.test(entry),
      )
      .sort();
    const licenseTexts = await Promise.all(
      licenseFiles.map((entry) => readFile(resolve(directory, entry), "utf8")),
    );
    if (!licenseTexts.length && name !== "client-only")
      throw new Error(`License text not found: ${id}`);
    sections.push(
      `${id} (${metadata.license})\n${licenseTexts.join("\n\n") || "Package metadata declares MIT; its browser entry is empty and the published package contains no separate license file."}`,
    );
    for (const child of Object.keys(metadata.dependencies ?? {}).sort())
      await visit(child, createRequire(file));
  };
  for (const name of runtimePackages) await visit(name, webRequire);
  sections.push(
    "SciRetriever compatibility change: react-aria@3.52.1 usePreventScroll fixed CSS is shipped externally; the dependency toggles a root data attribute rather than injecting a style element. Copyright and Apache-2.0 license above remain unchanged.",
  );
  for (const name of ["ibm-plex-sans", "source-serif-4"])
    sections.push(
      `${name} (SIL OFL 1.1)\n${await readFile(resolve(repository, `apps/web/src/app/styles/fonts/${name}-OFL.txt`), "utf8")}`,
    );
  return sections.join("\n\n");
}

/** Build in isolation, then publish complete files; requests never resolve paths on disk. */
export async function buildReactAssets(outdir, { readerNotices } = {}) {
  // Only this build's flat Vite assets directory is eligible for pruning.
  // Refuse links before publishing so cleanup cannot escape into other data.
  const assetsDirectory = resolve(outdir, "assets");
  for (const directory of [outdir, assetsDirectory]) {
    const metadata = await lstat(directory).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata && !metadata.isDirectory())
      throw new Error("React build output must be a real directory");
  }
  const previousAssets = await readdir(assetsDirectory, {
    withFileTypes: true,
  }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const staging = await mkdtemp(resolve(tmpdir(), "sciretriever-react-build-"));
  let publication;
  const failures = [];
  try {
    // Vite inherits NODE_ENV when its caller is a test runner. A distributable
    // build must still use React's production runtime and JSX transform.
    const callerNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const { build } = await import(
        pathToFileURL(webRequire.resolve("vite")).href
      );
      await build({
        mode: "production",
        configFile: resolve(repository, "apps/web/vite.config.mjs"),
        build: { outDir: staging, emptyOutDir: true },
      });
    } finally {
      if (callerNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = callerNodeEnv;
    }
    const sources = [];
    const collect = async (directory, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const name = prefix + entry.name;
        if (entry.isDirectory())
          await collect(resolve(directory, entry.name), `${name}/`);
        else if (entry.isFile() && /\.(?:html|js|css|woff2?|txt)$/u.test(name))
          sources.push(name);
      }
    };
    const reader = readerNotices ? await readFile(readerNotices, "utf8") : "";
    await writeFile(
      resolve(staging, "third-party-notices.txt"),
      `${await notices()}\n\n${reader}`,
    );
    await collect(staging);
    await writeFile(
      resolve(staging, "assets.json"),
      JSON.stringify(sources.sort()) + "\n",
    );
    await mkdir(outdir, { recursive: true });
    publication = await mkdtemp(resolve(outdir, ".publish-"));
    // Publish the HTML and manifest last, after every hashed resource exists.
    const order = [
      ...sources.filter((name) => name !== "index.html"),
      "index.html",
      "assets.json",
    ];
    for (const [index, name] of order.entries()) {
      const target = resolve(outdir, name),
        temporary = resolve(publication, String(index));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(staging, name), temporary);
      await rename(temporary, target);
    }
    // Retire only generated hashed resources after the new manifest is live.
    // Do not prune caller files, directories, or links in the output tree.
    for (const entry of previousAssets) {
      if (
        entry.isFile() &&
        /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?)$/u.test(
          entry.name,
        ) &&
        !sources.includes(`assets/${entry.name}`)
      )
        await rm(resolve(assetsDirectory, entry.name), { force: true });
    }
  } catch (error) {
    failures.push(error);
  }
  for (const result of await Promise.allSettled(
    [staging, publication]
      .filter(Boolean)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "React workbench build and cleanup failed",
      { cause: failures[0] },
    );
}
