import { resolve } from "node:path";
import { migrateDraftTextSchema } from "../apps/server/dist/storage/sqlite/draft-text-schema-migration.js";
if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-draft-text-v17.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
process.stdout.write(
  JSON.stringify(
    await migrateDraftTextSchema(resolve(process.argv[2])),
    null,
    2,
  ) + "\n",
);
