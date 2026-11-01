import { resolve } from "node:path";
import { migrateIntakeSchema } from "../apps/server/dist/storage/sqlite/intake-schema-migration.js";
if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-intake-v15.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
process.stdout.write(
  `${JSON.stringify(await migrateIntakeSchema(resolve(process.argv[2])), null, 2)}\n`,
);
