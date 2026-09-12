import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteWorker,
  SqliteWorkerError,
} from "../src/storage/sqlite/worker.js";

const literature = {
  literature_id: "00000000-0000-0000-0000-000000000004" as never,
  meta_literature_id: "00000000-0000-0000-0000-000000000006" as never,
  version_role: "published" as const,
  status: "UNREVIEWED" as const,
  metadata: {
    title: "Worker fixture",
    authors: [
      {
        kind: "person" as const,
        display_name: "Ada Lovelace",
        given_name: "Ada",
        family_name: "Lovelace",
        orcid: null,
        affiliations: [],
      },
    ],
    abstract: null,
    publication_date: null,
    publication_year: 2026,
    document_type: "article",
    language: "en",
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [{ namespace: "doi", value: "10.1234/worker" }],
    keywords: ["offline"],
  },
};

describe("typed sqlite worker", () => {
  it("owns the connection in a worker and round trips normalized rows", async () => {
    const worker = new SqliteWorker();
    try {
      await expect(worker.schema()).resolves.toMatchObject({
        product: "sciretriever",
        schema_version: 1,
      });
      await expect(worker.putLiterature(literature)).resolves.toBe(true);
      await expect(
        worker.getLiterature(literature.literature_id),
      ).resolves.toMatchObject({
        literature_id: literature.literature_id,
        metadata: {
          title: "Worker fixture",
          authors: [{ display_name: "Ada Lovelace" }],
          keywords: ["offline"],
        },
      });
      await expect(worker.snapshotCounts()).resolves.toMatchObject({
        tables: { literatures: 1, literature_metadata_authors: 1 },
      });
    } finally {
      await worker.close();
    }
  });

  it("rejects unknown commands and commands after close", async () => {
    const worker = new SqliteWorker();
    await expect(
      worker.run({ kind: "arbitrary_sql" } as never),
    ).rejects.toBeInstanceOf(SqliteWorkerError);
    await worker.close();
    await expect(worker.schema()).rejects.toBeInstanceOf(SqliteWorkerError);
  });

  it("returns a stable ordered page and signed continuation cursor", async () => {
    const worker = new SqliteWorker();
    try {
      await worker.putLiterature(literature);
      await worker.putLiterature({
        ...literature,
        literature_id: "00000000-0000-0000-0000-000000000005" as never,
        metadata: { ...literature.metadata, title: "Second fixture" },
      });
      const first = await worker.listLiterature(null, 1);
      expect(first.items).toHaveLength(1);
      expect(first.next_cursor).toEqual(expect.any(String));
      const second = await worker.listLiterature(first.next_cursor, 1);
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.literature_id).not.toBe(
        first.items[0]?.literature_id,
      );
      await expect(
        worker.listLiterature(`${first.next_cursor}=`, 1),
      ).rejects.toBeInstanceOf(SqliteWorkerError);
    } finally {
      await worker.close();
    }
  });

  it("propagates worker initialization failure instead of silently falling back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sciretriever-sqlite-"));
    const worker = new SqliteWorker(directory);
    await expect(worker.schema()).rejects.toBeInstanceOf(SqliteWorkerError);
    await worker.close();
  });
});
