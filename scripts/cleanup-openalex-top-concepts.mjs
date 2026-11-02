import { resolve } from "node:path";
import { cleanupOpenAlexTopConcepts } from "../apps/server/dist/storage/sqlite/openalex-top-concepts-cleanup.js";
if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/cleanup-openalex-top-concepts.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
process.stdout.write(
  `${JSON.stringify(await cleanupOpenAlexTopConcepts(resolve(process.argv[2])), null, 2)}\n`,
);
