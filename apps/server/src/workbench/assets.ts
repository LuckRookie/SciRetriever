import { readFile, readdir } from "node:fs/promises";
import type { WorkbenchStaticAsset } from "./http.js";

const manifest = [
  ["/", "live.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/live.css", "live.css", "text/css; charset=utf-8"],
  ["/workspace.css", "workspace.css", "text/css; charset=utf-8"],
  ["/live.js", "live.js", "text/javascript; charset=utf-8"],
] as const;
const queryManifest = [
  ["/", "query.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/live.css", "live.css", "text/css; charset=utf-8"],
  ["/query.js", "query.js", "text/javascript; charset=utf-8"],
] as const;
const maintenanceManifest = [
  ["/", "maintenance.html", "text/html; charset=utf-8"],
  ["/query", "query.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/live.css", "live.css", "text/css; charset=utf-8"],
  ["/maintenance.js", "maintenance.js", "text/javascript; charset=utf-8"],
  ["/query.js", "query.js", "text/javascript; charset=utf-8"],
] as const;

async function loadAssets(
  entries: readonly (readonly [string, string, string])[],
): Promise<ReadonlyMap<string, WorkbenchStaticAsset>> {
  const assets = new Map<string, WorkbenchStaticAsset>();
  for (const [route, name, contentType] of entries) {
    const body = await readFile(new URL(`../web/${name}`, import.meta.url));
    assets.set(route, Object.freeze({ contentType, body }));
  }
  return assets;
}

/** Reads the Browser/Jobs workbench files shipped beside the installed server module. */
export async function loadWorkbenchAssets(): Promise<
  ReadonlyMap<string, WorkbenchStaticAsset>
> {
  const assets = new Map(await loadAssets(manifest));
  for (const [route, asset] of await loadReadingAssets())
    assets.set(route, asset);
  return assets;
}

/** Reads the query-only reader files shipped beside the installed server module. */
export async function loadQueryWorkbenchAssets(): Promise<
  ReadonlyMap<string, WorkbenchStaticAsset>
> {
  return loadAssets(queryManifest);
}

/** Reads the independent maintenance page and the separate read-only library page. */
export async function loadMaintenanceWorkbenchAssets(): Promise<
  ReadonlyMap<string, WorkbenchStaticAsset>
> {
  return loadAssets(maintenanceManifest);
}

/** Enumerate only bundled reader resources. Request paths are never filesystem paths. */
export async function loadReadingAssets(
  base = new URL("../web/", import.meta.url),
): Promise<ReadonlyMap<string, WorkbenchStaticAsset>> {
  const assets = new Map<string, WorkbenchStaticAsset>();
  const types: Record<string, string> = {
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    txt: "text/plain; charset=utf-8",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    wasm: "application/wasm",
    bcmap: "application/octet-stream",
    pfb: "application/octet-stream",
  };
  const add = async (name: string) => {
    const type = types[name.split(".").at(-1)!];
    if (!type) return;
    assets.set(`/${name}`, {
      contentType: type,
      body: await readFile(new URL(name, base)),
    });
  };
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(new URL(dir, base), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) await walk(`${dir}${entry.name}/`);
      else if (entry.isFile()) await add(`${dir}${entry.name}`);
    }
  };
  await add("reader.js");
  await add("reading.css");
  await walk("reader/");
  return assets;
}
