import {
  LIBRARY_STATE_SCHEMA,
  SCHEMA_MANIFEST_V13,
  LIBRARY_STATE_INPUT_TABLES_V16 as LIBRARY_STATE_INPUT_TABLES,
} from "./schema.js";

/** Frozen offline input/target only. Never accepted by the current catalog opener. */
export const LIBRARY_STATE_PREVIOUS_FINGERPRINT =
  "a52523c3c8c6fd991141b7dee768294f624f38b62d1b05c74e0c33159ee50666";
const previousState = [
  "CREATE TABLE library_state_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0)) STRICT",
  ...LIBRARY_STATE_INPUT_TABLES.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (event) =>
        `CREATE TRIGGER library_state_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN INSERT INTO library_state_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END`,
    ),
  ),
];
export const libraryStatePreviousManifest = SCHEMA_MANIFEST_V13.flatMap(
  (sql) => {
    if (sql === LIBRARY_STATE_SCHEMA[0]) return previousState;
    if ((LIBRARY_STATE_SCHEMA as readonly string[]).includes(sql)) return [];
    return [
      sql.replace("CHECK(schema_version=13)", "CHECK(schema_version=12)"),
    ];
  },
);
