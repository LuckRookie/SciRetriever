import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import {
  loadReactAssets,
  loadIndependentReactAssets,
} from "../../server/src/workbench/assets.js";
import { workspace } from "./processor-workspace-fixture.js";

let assets: ReturnType<typeof loadReactAssets> | undefined;
let directory: string | undefined;
/** Lets the same browser journeys verify the system reduced-motion preference. */
export function motionOptions(): { reducedMotion?: "reduce" } {
  return process.env.SCIRETRIEVER_REDUCED_MOTION === "reduce"
    ? { reducedMotion: "reduce" }
    : {};
}
/** Production Vite resources, served with the existing authentication and CSP. */
export function nextAssets() {
  assets ??= (async () => {
    directory = await mkdtemp(join(tmpdir(), "sciretriever-next-web-"));
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { buildReactAssets } from './scripts/build-react-assets.mjs'; await buildReactAssets(process.argv[1]);",
        directory,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return loadReactAssets(pathToFileURL(`${directory}/`));
  })();
  return assets;
}
export async function nextWorkspace(
  options: {
    analysisModel?: boolean;
    setup?: Parameters<typeof workspace>[1];
    path?: string;
    ready?: string;
    configuration?: NonNullable<
      Parameters<typeof workspace>[2]
    >["configuration"];
  } = {},
) {
  return workspace(options.analysisModel ?? true, options.setup, {
    assets: await nextAssets(),
    path: options.path ?? "/",
    ready: options.ready ?? '[aria-label="文献列表"] .paper-row:first-child',
    ...(options.configuration ? { configuration: options.configuration } : {}),
  });
}
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

export async function independentNextAssets(kind: "query" | "maintenance") {
  await nextAssets();
  if (!directory) throw new Error("React fixture directory is unavailable");
  return loadIndependentReactAssets(kind, pathToFileURL(`${directory}/`));
}
