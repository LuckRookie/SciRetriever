import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  TRANSLATION_CACHE_LIMIT,
  type TranslationLanguage,
} from "@sciretriever/contracts";

export interface CachedTranslation {
  readonly translation: string;
  readonly target_language: TranslationLanguage;
  readonly model: string;
}
/**
 * Disposable translation cache (ADR 0049): one SQLite file outside the catalog,
 * at most `limit` entries, evicting the one used longest ago. Deleting the file
 * empties the cache and touches no user data. The file and SQLite load on first
 * use, so commands that never translate neither create it nor load SQLite.
 */
export class TranslationCache {
  private opened: Promise<DatabaseSync> | null = null;
  private closed = false;
  constructor(
    private readonly path: string,
    private readonly limit = TRANSLATION_CACHE_LIMIT,
  ) {}
  private database(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("translation cache closed");
    this.opened ??= (async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.path);
      db.exec(
        "CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, target_language TEXT NOT NULL, translation TEXT NOT NULL, model TEXT NOT NULL, used INTEGER NOT NULL)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS translations_used ON translations(used)",
      );
      return db;
    })();
    return this.opened;
  }
  /** A use order that survives restarts and never ties within one millisecond. */
  private next(db: DatabaseSync): number {
    const row = db
      .prepare("SELECT COALESCE(MAX(used), 0) + 1 AS n FROM translations")
      .get() as { n: number };
    return Number(row.n);
  }
  async get(key: string): Promise<CachedTranslation | null> {
    const db = await this.database();
    const row = db
      .prepare(
        "SELECT target_language, translation, model FROM translations WHERE key = ?",
      )
      .get(key) as CachedTranslation | undefined;
    if (!row) return null;
    db.prepare("UPDATE translations SET used = ? WHERE key = ?").run(
      this.next(db),
      key,
    );
    return {
      translation: row.translation,
      target_language: row.target_language,
      model: row.model,
    };
  }
  async put(key: string, value: CachedTranslation): Promise<void> {
    const db = await this.database();
    db.prepare(
      "INSERT OR REPLACE INTO translations (key, target_language, translation, model, used) VALUES (?, ?, ?, ?, ?)",
    ).run(
      key,
      value.target_language,
      value.translation,
      value.model,
      this.next(db),
    );
    db.prepare(
      "DELETE FROM translations WHERE key NOT IN (SELECT key FROM translations ORDER BY used DESC LIMIT ?)",
    ).run(this.limit);
  }
  async size(): Promise<number> {
    const db = await this.database();
    return Number(
      (
        db.prepare("SELECT COUNT(*) AS n FROM translations").get() as {
          n: number;
        }
      ).n,
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    const db = await this.opened?.catch(() => null);
    if (db?.isOpen) db.close();
  }
}
