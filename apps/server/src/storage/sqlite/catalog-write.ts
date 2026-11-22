import type { DatabaseSync } from "node:sqlite";

type CommitHook = () => () => void;
const hooks = new WeakMap<DatabaseSync, CommitHook>();
const pending = new WeakMap<DatabaseSync, () => void>();

export function registerCatalogWriteHook(db: DatabaseSync, start: CommitHook) {
  hooks.set(db, start);
}

export function beginCatalogWrite(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const start = hooks.get(db);
    if (start) pending.set(db, start());
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function commitCatalogWrite(db: DatabaseSync) {
  const finish = pending.get(db);
  pending.delete(db);
  finish?.();
  db.exec("COMMIT");
}
