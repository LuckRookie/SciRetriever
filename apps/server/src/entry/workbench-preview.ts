import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkbenchAssets } from "../workbench/assets.js";
import { startSyntheticWorkbench } from "../bootstrap/workbench.js";
import { verifyInstalledCloakRuntime } from "../configuration/cloak-runtime.js";

const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;
if (!bundle)
  throw new Error(
    "Set SCIRETRIEVER_CLOAK_BUNDLE to an operator-installed verified runtime bundle.",
  );
const runtime = await verifyInstalledCloakRuntime(bundle);
const home = await mkdtemp(join(tmpdir(), "sciretriever-live-preview-"));
const assets = await loadWorkbenchAssets();
let workbench: Awaited<ReturnType<typeof startSyntheticWorkbench>>;
try {
  workbench = await startSyntheticWorkbench({
    home,
    runtime,
    assets,
    port: 4174,
    access: { host: "127.0.0.1" },
  });
} catch (error) {
  await rm(home, { recursive: true, force: true });
  throw error;
}
process.stdout.write(
  `Live synthetic Browser workbench: ${workbench.origin}\nAPI key: ${workbench.apiKey}\n`,
);
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
