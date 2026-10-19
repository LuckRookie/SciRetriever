import { readFile, readdir } from "node:fs/promises";
import type { WorkbenchStaticAsset } from "./http.js";

const manifest = [
  ["/auth", "auth.html", "text/html; charset=utf-8"],
  ["/auth.js", "auth.js", "text/javascript; charset=utf-8"],
  ["/auth.css", "auth.css", "text/css; charset=utf-8"],
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
  for (const [route, asset] of await loadReactAssets())
    assets.set(route, asset);
  return assets;
}

/** Only build-declared React files are exposed, never request-controlled paths. */
export async function loadReactAssets(
  base = new URL("../web/react/", import.meta.url),
): Promise<ReadonlyMap<string, WorkbenchStaticAsset>> {
  const names: unknown = JSON.parse(
    await readFile(new URL("assets.json", base), "utf8"),
  );
  if (
    !Array.isArray(names) ||
    names.length > 2000 ||
    !names.includes("index.html")
  )
    throw new Error("Invalid React workbench asset manifest");
  const types: Readonly<Record<string, string>> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    woff: "font/woff",
    woff2: "font/woff2",
  };
  const assets = new Map<string, WorkbenchStaticAsset>();
  for (const name of names) {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:html|js|css|txt|woff2?)$/u.test(
        name,
      )
    )
      throw new Error("Invalid React workbench asset path");
    const contentType = types[name.split(".").at(-1)!]!;
    const asset = Object.freeze({
      contentType,
      body: await readFile(new URL(name, base)),
    });
    assets.set(name === "index.html" ? "/" : `/${name}`, asset);
  }
  return assets;
}

/** Reads the query-only reader files shipped beside the installed server module. */
export async function loadQueryWorkbenchAssets(): Promise<
  ReadonlyMap<string, WorkbenchStaticAsset>
> {
  const assets = new Map<string, WorkbenchStaticAsset>();
  for (const [route, asset] of await loadReadingAssets())
    assets.set(route, asset);
  for (const [route, asset] of await loadIndependentReactAssets("query"))
    assets.set(route, asset);
  return assets;
}

/** Reads the independent maintenance page and the separate read-only library page. */
export async function loadMaintenanceWorkbenchAssets(): Promise<
  ReadonlyMap<string, WorkbenchStaticAsset>
> {
  const assets = new Map<string, WorkbenchStaticAsset>();
  for (const [route, asset] of await loadReadingAssets())
    assets.set(route, asset);
  for (const [route, asset] of await loadIndependentReactAssets("maintenance"))
    assets.set(route, asset);
  return assets;
}

/** The same React application exposes only the capabilities of its existing service. */
export async function loadIndependentReactAssets(
  kind: "query" | "maintenance",
  base = new URL("../web/react/", import.meta.url),
): Promise<ReadonlyMap<string, WorkbenchStaticAsset>> {
  const assets = new Map(await loadReactAssets(base));
  const html = assets.get("/");
  if (!html) throw new Error("React workbench entry is missing");
  const entry = (entryKind: "query" | "maintenance"): WorkbenchStaticAsset => ({
    contentType: html.contentType,
    body: html.body
      .toString()
      .replace(
        '<html lang="zh-CN">',
        `<html lang="zh-CN" data-entry="${entryKind}">`,
      ),
  });
  assets.set("/", entry(kind));
  if (kind === "maintenance") assets.set("/query", entry("query"));
  return assets;
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
  await walk("reader/");
  return assets;
}
