import { resolve } from "node:path";
import { migrateImportSchema } from "../apps/server/dist/storage/sqlite/import-schema-migration.js";
if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-import-v16.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
process.stdout.write(
  `${JSON.stringify(await migrateImportSchema(resolve(process.argv[2])), null, 2)}\n`,
);
