import { resolve } from "node:path";
import { buildSampleAssets } from "./build-react-assets.mjs";

await buildSampleAssets(
  resolve(new URL("../apps/web/dist", import.meta.url).pathname),
);
