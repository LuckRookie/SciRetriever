import { buildReaderAssets } from "./build-reader-assets.mjs";
import {
  buildAuthAssets,
  buildReactAssets,
  buildSampleAssets,
} from "./build-react-assets.mjs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const repository = resolve(new URL("..", import.meta.url).pathname);
const serverAssets = resolve(repository, "apps/server/dist/web");
const webDist = resolve(repository, "apps/web/dist");
for (const directory of [serverAssets, webDist]) {
  const metadata = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata && !metadata.isDirectory())
    throw new Error("Workbench build output must be a real directory");
}
await Promise.all([
  mkdir(serverAssets, { recursive: true }),
  mkdir(webDist, { recursive: true }),
]);
await buildAuthAssets(serverAssets);
await buildSampleAssets(webDist);
await buildReaderAssets(serverAssets);
await buildReactAssets(resolve(serverAssets, "react"), {
  readerNotices: resolve(serverAssets, "reader/third-party-notices.txt"),
});

// The retired parallel bundle must not enter packages through the JS file glob.
const retiredReact = resolve(serverAssets, "next");
const retiredMetadata = await lstat(retiredReact).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (retiredMetadata && !retiredMetadata.isDirectory())
  throw new Error("Retired React build output must be a real directory");
if (retiredMetadata) await rm(retiredReact, { recursive: true });

// Retired UI files are generated outputs; remove only this known legacy set.
for (const name of [
  "live.js",
  "query.js",
  "maintenance.js",
  "reader.js",
  "live.html",
  "query.html",
  "maintenance.html",
  "index.html",
  "styles.css",
  "live.css",
  "workspace.css",
  "reading.css",
])
  await rm(resolve(serverAssets, name), { force: true });
for (const name of [
  "live.bundle.js",
  "query.bundle.js",
  "maintenance.bundle.js",
])
  await rm(resolve(webDist, name), { force: true });
