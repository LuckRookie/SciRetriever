import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  loadAuthAssets,
  loadReactAssets,
  loadReadingAssets,
} from "../../server/src/workbench/assets.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";
import { nextAssets, readerProbeAssets } from "./next-workspace-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";

/**
 * An explicit built asset directory supports auditing a frozen checkout with this same page matrix.
 * `readerProbe` serves the test build whose reader carries measurement counters.
 */
export async function designSamplesAssets(
  options: { readerProbe?: boolean } = {},
) {
  const built = options.readerProbe
    ? undefined
    : process.env.SCIRETRIEVER_DESIGN_ASSETS_DIRECTORY;
  const base = built ? pathToFileURL(resolve(built) + "/") : null;
  const assets = new Map<string, WorkbenchStaticAsset>(
    base ? await loadReadingAssets(base) : await readingAssets(),
  );
  for (const [path, asset] of base
    ? await loadReactAssets(new URL("react/", base))
    : options.readerProbe
      ? await readerProbeAssets()
      : await nextAssets())
    assets.set(path, asset);
  const temporary = built
    ? null
    : await mkdtemp(join(tmpdir(), "sciretriever-design-auth-"));
  const directory = built ? resolve(built) : temporary!;
  try {
    if (temporary)
      await promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        "import { buildAuthAssets } from './scripts/build-react-assets.mjs'; await buildAuthAssets(process.argv[1]);",
        temporary,
      ]);
    for (const [route, asset] of await loadAuthAssets(
      pathToFileURL(`${directory}/`),
    ))
      assets.set(route, asset);
    return assets;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
