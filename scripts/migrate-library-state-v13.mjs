import { resolve } from "node:path";
import { migrateLibraryStateSchema } from "../apps/server/dist/storage/sqlite/library-state-schema-migration.js";

if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-library-state-v13.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
const result = await migrateLibraryStateSchema(resolve(process.argv[2]));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
