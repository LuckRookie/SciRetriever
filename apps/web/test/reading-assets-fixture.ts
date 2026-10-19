import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import { loadReadingAssets } from "../../server/src/workbench/assets.js";

let assets: ReturnType<typeof loadReadingAssets> | undefined;
let directory: string | undefined;
/** Exercise the same build and static manifest used in the installed server. */
export function readingAssets() {
  assets ??= (async () => {
    directory = await mkdtemp(join(tmpdir(), "sciretriever-reading-assets-"));
    await promisify(execFile)(process.execPath, [
      "scripts/build-reader-assets.mjs",
      directory,
    ]);
    return loadReadingAssets(pathToFileURL(`${directory}/`));
  })();
  return assets;
}
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
