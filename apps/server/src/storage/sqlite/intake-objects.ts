import type { DatabaseSync } from "node:sqlite";
export type IntakeObjectKind =
  | "literature"
  | "folder"
  | "folder-member"
  | "literature-asset"
  | "mark";
export const intakeMemberObjectId = (folder: string, literature: string) =>
  JSON.stringify([folder, literature]);
/** Called only after a new object was inserted, in that same owner transaction. */
export function recordIntakeObject(
  db: DatabaseSync,
  batch: string | undefined,
  kind: IntakeObjectKind,
  id: string,
): void {
  if (batch === undefined) return;
  if (!db.isTransaction)
    throw new Error("intake object registration requires a transaction");
  db.prepare(
    "INSERT INTO intake_batch_objects(object_kind,object_id,batch_id) VALUES(?,?,?) ON CONFLICT(object_kind,object_id) DO UPDATE SET batch_id=excluded.batch_id",
  ).run(kind, id, batch);
}
