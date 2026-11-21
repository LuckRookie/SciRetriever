import { resolve } from "node:path";
import {
  migrateLiteratureSearchSchema,
  reconcileLiteratureSearchSchema,
} from "../apps/server/dist/storage/sqlite/literature-search-schema-migration.js";

const args = process.argv.slice(2);
const reconcile = args[0] === "--reconcile";
const path = args[reconcile ? 1 : 0];
if (args.length !== (reconcile ? 2 : 1) || !path?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-literature-search-indexes.mjs [--reconcile] /absolute/path/to/catalog.sqlite",
  );
}
process.stdout.write(
  JSON.stringify(
    await (
      reconcile
        ? reconcileLiteratureSearchSchema
        : migrateLiteratureSearchSchema
    )(resolve(path)),
    null,
    2,
  ) + "\n",
);
