import { resolve } from "node:path";
import { migrateUserOrganizationSchema } from "../apps/server/dist/storage/sqlite/user-organization-schema-migration.js";
if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  throw new Error(
    "usage: node scripts/migrate-user-organization-v18.mjs /absolute/path/to/offline-catalog.sqlite",
  );
}
process.stdout.write(
  JSON.stringify(
    await migrateUserOrganizationSchema(resolve(process.argv[2])),
    null,
    2,
  ) + "\n",
);
