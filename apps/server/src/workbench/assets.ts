import { readFile } from "node:fs/promises";
import type { WorkbenchStaticAsset } from "./http.js";

const manifest = [
  ["/", "live.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/live.css", "live.css", "text/css; charset=utf-8"],
  ["/live.js", "live.js", "text/javascript; charset=utf-8"],
] as const;

/** Reads only build-owned static files shipped beside the installed server module. */
export async function loadWorkbenchAssets(): Promise<
  ReadonlyMap<string, WorkbenchStaticAsset>
> {
  const assets = new Map<string, WorkbenchStaticAsset>();
  for (const [route, name, contentType] of manifest) {
    const body = await readFile(new URL(`../web/${name}`, import.meta.url));
    assets.set(route, Object.freeze({ contentType, body }));
  }
  return assets;
}
