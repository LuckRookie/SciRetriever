import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSyntheticWorkbench } from "../bootstrap/workbench.js";
import { verifyInstalledCloakRuntime } from "../configuration/cloak-runtime.js";
import type { WorkbenchStaticAsset } from "../workbench/http.js";

const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;
if (!bundle)
  throw new Error(
    "Set SCIRETRIEVER_CLOAK_BUNDLE to an operator-installed verified runtime bundle.",
  );
const runtime = await verifyInstalledCloakRuntime(bundle);
const home = await mkdtemp(join(tmpdir(), "sciretriever-live-preview-"));
const assets = new Map<string, WorkbenchStaticAsset>();
for (const [route, file, contentType] of [
  ["/", "public/live.html", "text/html; charset=utf-8"],
  ["/styles.css", "public/styles.css", "text/css; charset=utf-8"],
  ["/live.css", "public/live.css", "text/css; charset=utf-8"],
  ["/live.js", "dist/live.bundle.js", "text/javascript; charset=utf-8"],
] as const)
  assets.set(route, {
    contentType,
    body: await readFile(new URL(`../../../web/${file}`, import.meta.url)),
  });
let workbench: Awaited<ReturnType<typeof startSyntheticWorkbench>>;
try {
  workbench = await startSyntheticWorkbench({
    home,
    runtime,
    assets,
    port: 4174,
  });
} catch (error) {
  await rm(home, { recursive: true, force: true });
  throw error;
}
process.stdout.write(`Live synthetic Browser workbench: ${workbench.origin}\n`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void workbench
    .close()
    .then(() => rm(home, { recursive: true, force: true }))
    .then(() => {
      process.exitCode = 0;
    })
    .catch(() => {
      process.stderr.write("Preview shutdown failed.\n");
      process.exitCode = 1;
    });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
