import { readFile } from "node:fs/promises";
import type { WorkbenchStaticAsset } from "./http.js";

const manifest = [
  ["/", "live.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/live.css", "live.css", "text/css; charset=utf-8"],
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
  return loadAssets(manifest);
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
