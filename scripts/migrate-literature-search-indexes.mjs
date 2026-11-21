import { resolve } from "node:path";
import { migrateLiteratureSearchSchema } from "../apps/server/dist/storage/sqlite/literature-search-schema-migration.js";

if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-literature-search-indexes.mjs /absolute/path/to/catalog.sqlite",
  );
}
process.stdout.write(
  JSON.stringify(
    await migrateLiteratureSearchSchema(resolve(process.argv[2])),
    null,
    2,
  ) + "\n",
);
