import { resolve } from "node:path";
import { migrateCitationLimitsSchema } from "../apps/server/dist/storage/sqlite/citation-limits-schema-migration.js";
if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-citation-limits-v19.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
process.stdout.write(
  JSON.stringify(
    await migrateCitationLimitsSchema(resolve(process.argv[2])),
    null,
    2,
  ) + "\n",
);
