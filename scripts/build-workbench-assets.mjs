import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repository = resolve(new URL("..", import.meta.url).pathname);
const serverAssets = resolve(repository, "apps/server/dist/web");
const webDist = resolve(repository, "apps/web/dist");
await Promise.all([
  mkdir(serverAssets, { recursive: true }),
  mkdir(webDist, { recursive: true }),
]);
await build({
  entryPoints: [resolve(repository, "apps/web/src/live.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: resolve(serverAssets, "live.js"),
});
await build({
  entryPoints: [resolve(repository, "apps/web/src/query.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: resolve(serverAssets, "query.js"),
});
await build({
  entryPoints: [resolve(repository, "apps/web/src/maintenance.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: resolve(serverAssets, "maintenance.js"),
});
await Promise.all([
  copyFile(
    resolve(repository, "apps/web/public/live.html"),
    resolve(serverAssets, "live.html"),
  ),
  copyFile(
    resolve(repository, "apps/web/public/styles.css"),
    resolve(serverAssets, "styles.css"),
  ),
  copyFile(
    resolve(repository, "apps/web/public/live.css"),
    resolve(serverAssets, "live.css"),
  ),
  copyFile(
    resolve(repository, "apps/web/public/query.html"),
    resolve(serverAssets, "query.html"),
  ),
  copyFile(
    resolve(repository, "apps/web/public/maintenance.html"),
    resolve(serverAssets, "maintenance.html"),
  ),
  copyFile(
    resolve(serverAssets, "live.js"),
    resolve(webDist, "live.bundle.js"),
  ),
  copyFile(
    resolve(serverAssets, "query.js"),
    resolve(webDist, "query.bundle.js"),
  ),
  copyFile(
    resolve(serverAssets, "maintenance.js"),
    resolve(webDist, "maintenance.bundle.js"),
  ),
]);
