import { recoverSuzukiCitationCheckpoint } from "../apps/server/dist/entry/suzuki-citation-recovery.js";

const args = process.argv.slice(2);
const mode = args.length === 2 ? args.shift() : "--dry-run";
const [path] = args;
try {
  if (
    args.length !== 1 ||
    !["--dry-run", "--apply"].includes(mode) ||
    !path?.startsWith("/")
  )
    throw new Error(
      "usage: node scripts/recover-suzuki-citation-checkpoint.mjs [--dry-run|--apply] /absolute/path/to/catalog.sqlite",
    );
  const summary = await recoverSuzukiCitationCheckpoint(
    path,
    mode === "--apply",
  );
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      status: "refused",
      message: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
  process.exitCode = 1;
}
