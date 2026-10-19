import type { WorkbenchStaticAsset } from "../src/workbench/http.js";
import { independentNextAssets } from "../../web/test/next-workspace-fixture.js";
import { readingAssets } from "../../web/test/reading-assets-fixture.js";

/** Real Vite/reader resources on the existing independent HTTP service, no second backend. */
export async function reactWorkbenchAssets(
  kind: "query" | "maintenance",
): Promise<Map<string, WorkbenchStaticAsset>> {
  const assets = new Map(await readingAssets());
  for (const [path, value] of await independentNextAssets(kind))
    assets.set(path, value);
  return assets;
}
