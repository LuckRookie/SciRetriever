import { resolve } from "node:path";
import { migrateArchiveSchema } from "../apps/server/dist/storage/sqlite/archive-schema-migration.js";

if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-archive-v12.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
const result = await migrateArchiveSchema(resolve(process.argv[2]));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
