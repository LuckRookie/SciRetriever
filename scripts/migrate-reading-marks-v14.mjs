import { resolve } from "node:path";
import { migrateReadingMarksSchema } from "../apps/server/dist/storage/sqlite/reading-marks-schema-migration.js";

if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-reading-marks-v14.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
const result = await migrateReadingMarksSchema(resolve(process.argv[2]));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
