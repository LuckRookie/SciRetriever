import { DatabaseSync } from "node:sqlite";
import {
  readFile,
  writeFile,
  stat,
  utimes,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { sha256, parseDocumentRef } from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { archiveFixture } from "./archive-fixture.js";
import { correctedDocumentFixture } from "./corrected-document-fixture.js";
import { imageBytes } from "./archive-text-fixture.js";
import { FileStore } from "../src/storage/files/store.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { SqliteProofreadStorage } from "../src/storage/proofread.js";
import { DocumentReadService } from "../src/document/read.js";
import * as legacyBuilder from "../src/document/proofread-builder.js";
import * as arrangedBuilder from "../src/archive/render.js";

function deferred() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
function gateFingerprint(
  f: Awaited<ReturnType<typeof fixture>>,
  occurrence = 1,
) {
  const entered = deferred(),
    gate = deferred();
  const real = f.files.fingerprint.bind(f.files);
  let count = 0;
  let sharedSignal: AbortSignal | undefined;
  vi.spyOn(f.files, "fingerprint").mockImplementation(async (path, signal) => {
    const fp = await real(path, signal);
    if (path === f.paths.pdf && ++count === occurrence) {
      sharedSignal = signal;
      entered.release();
      await gate.promise;
      signal?.throwIfAborted();
    }
    return fp;
  });
  return {
    entered: entered.promise,
    release: gate.release,
    signal: () => sharedSignal,
  };
}

async function fixture(arranged = false) {
  const archived = arranged ? await archiveFixture({ offline: true }) : null;
  const e =
    archived ??
    (await coreProcessingFixture({ offline: true, analysisModel: false }));
  let files: FileStore | undefined, database: SqliteWorker | undefined;
  try {
    e.setText(
      "# Methods\n\nA synthetic result.\n\n![one](one.png)\n\n![two](two.png)\n",
    );
    const other = Buffer.from(imageBytes);
    other[other.length - 1] = other[other.length - 1]! ^ 1;
    e.setResources(
      await Promise.all(
        [imageBytes, other].map(async (bytes, i) => ({
          reference: i ? "two.png" : "one.png",
          content: {
            bytes,
            artifact: {
              sha256: await sha256(bytes),
              byte_size: bytes.length,
              media_type: "image/png",
            },
          },
        })),
      ),
    );
    let versionId: string;
    if (archived) {
      // This fixture verifies v2 cache behavior, including its index setup.
      await e.app.rawParsing!.parseAsset(
        e.asset.asset_id,
        ["pipeline", "vlm-engine"],
        undefined,
        { force: false, expected_sha256: e.asset.sha256 },
      );
      await archived.submit("cache-arranged");
      versionId = (await e.app.archive.status(e.rawParseRequest.literature_id))
        .parts[0]!.document_version_id!;
    } else {
      versionId = (
        await correctedDocumentFixture(e.app).parseDocuments(e.parseRequest)
      ).document.document_version_id;
    }
    await expect
      .poll(async () => (await e.app.indexRefreshStatus!()).status, {
        timeout: 20_000,
      })
      .toBe("updated");
    database = new SqliteWorker(join(e.home, "catalog.sqlite"), undefined, {
      readOnly: true,
    });
    const row = (await database.documentVersion(versionId))!;
    const snapshot = { ...row, version: parseDocumentRef(row.version) };
    files = new FileStore(e.app.files.root);
    const storage = new SqliteDocumentStorage(database, files);
    const binding = await new SqliteProofreadStorage(
      database,
      files,
    ).documentBinding(snapshot.version.proofread_id);
    const paths = {
      pdf: snapshot.source_artifact_path,
      image:
        snapshot.resource_artifact_paths[
          snapshot.version.resources[0]!.reference
        ]!,
      markdown: snapshot.markdown_artifact_path,
      structure: snapshot.structure_artifact_path,
      manifest: binding.manifest.reference,
      blocks: binding.blocks.reference,
    };
    return {
      e,
      database,
      files,
      storage,
      snapshot,
      paths,
      id: versionId,
      read: () =>
        storage.withVerifiedDocument(
          versionId,
          async (_v, markdown, structure) => ({
            markdown: Buffer.from(markdown),
            structure,
          }),
        ),
      async close() {
        await files?.close();
        await database?.close();
        await e.close();
      },
    };
  } catch (error) {
    await files?.close();
    await database?.close();
    await e.close();
    throw error;
  }
}

it.each([false, true])(
  "reuses a proof without streaming or rebuilding, with unchanged budgets and private return values (arranged=%s)",
  async (arranged) => {
    const f = await fixture(arranged);
    try {
      const reads = vi.spyOn(f.files, "withVerified");
      const build = arranged
        ? vi.spyOn(arrangedBuilder, "renderArrangement")
        : vi.spyOn(legacyBuilder, "buildProofreadStructure");
      const coldBudget: number[] = [],
        warmBudget: number[] = [];
      const cold = await f.storage.withVerifiedDocument(
        f.id,
        async (_v, markdown, structure) => ({
          markdown: Buffer.from(markdown),
          structure,
        }),
        undefined,
        (n) => coldBudget.push(n),
      );
      expect(reads.mock.calls.some(([path]) => path === f.paths.pdf)).toBe(
        true,
      );
      expect(reads.mock.calls.some(([path]) => path === f.paths.image)).toBe(
        true,
      );
      expect(build).toHaveBeenCalledTimes(1);
      reads.mockClear();
      build.mockClear();
      const warm = await f.storage.withVerifiedDocument(
        f.id,
        async (_v, markdown, structure) => ({
          markdown: Buffer.from(markdown),
          structure,
        }),
        undefined,
        (n) => warmBudget.push(n),
      );
      expect(warm).toEqual(cold);
      expect(reads).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(warmBudget).toEqual(coldBudget);
      expect(coldBudget.reduce((a, b) => a + b, 0)).toBeGreaterThan(
        f.snapshot.version.source_material_ref.byte_size,
      );
      await f.storage.withVerifiedDocument(
        f.id,
        async (_v, markdown, structure) => {
          markdown.fill(0);
          Object.assign(structure.sections[0]!, { title: "consumer mutation" });
        },
      );
      expect(await f.read()).toEqual(cold);
      await expect(
        f.storage.withVerifiedDocument(
          f.id,
          async () => null,
          undefined,
          () => {
            throw new Error("budget exhausted");
          },
        ),
      ).rejects.toThrow("budget exhausted");
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
  30000,
);

it.each([
  "image",
  "pdf",
  "markdown",
  "structure",
  "manifest",
  "blocks",
] as const)(
  "invalidates a proof after same-size %s corruption, retains no failed proof, and rechecks after repair",
  async (part) => {
    const f = await fixture();
    try {
      const expected = await f.read();
      const path = join(f.files.root, f.paths[part]),
        original = await readFile(path),
        changed = Buffer.from(original);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      await writeFile(path, changed);
      const reads = vi.spyOn(f.files, "withVerified");
      await expect(f.read()).rejects.toThrow();
      expect(reads).toHaveBeenCalled();
      reads.mockClear();
      await expect(f.read()).rejects.toThrow();
      expect(reads).toHaveBeenCalled();
      await writeFile(path, original);
      reads.mockClear();
      expect(await f.read()).toEqual(expected);
      expect(reads.mock.calls.some(([p]) => p === f.paths.pdf)).toBe(true);
      reads.mockClear();
      expect(await f.read()).toEqual(expected);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("detects ctime changes even when size, inode and mtime were restored with utimes", async () => {
  const f = await fixture();
  try {
    const path = join(f.files.root, f.paths.image),
      fixed = new Date("2026-01-01T00:00:00Z");
    await utimes(path, fixed, fixed);
    await f.read();
    const before = await stat(path, { bigint: true }),
      bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);
    await utimes(path, fixed, fixed);
    const after = await stat(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    await expect(f.read()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("revalidates a replacement inode and refuses symlinks even when their bytes match", async () => {
  const f = await fixture();
  try {
    const expected = await f.read(),
      path = join(f.files.root, f.paths.image),
      bytes = await readFile(path),
      before = await stat(path, { bigint: true });
    await writeFile(`${path}.replacement`, bytes);
    await rename(`${path}.replacement`, path);
    expect((await stat(path, { bigint: true })).ino).not.toBe(before.ino);
    const reads = vi.spyOn(f.files, "withVerified");
    expect(await f.read()).toEqual(expected);
    expect(reads.mock.calls.some(([p]) => p === f.paths.pdf)).toBe(true);
    await rename(path, `${path}.moved`);
    await symlink(`${path}.moved`, path);
    await expect(f.read()).rejects.toThrow();
    await unlink(path);
    await rename(`${path}.moved`, path);
    reads.mockClear();
    expect(await f.read()).toEqual(expected);
    expect(reads).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("rechecks source status and block bindings from SQLite rather than trusting an old proof", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.e.home, "catalog.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys=OFF"); // Deliberate corruption of a synthetic catalog.
    await f.read();
    db.prepare(
      "UPDATE proofread_versions SET status='failed' WHERE proofread_id=?",
    ).run(f.snapshot.version.proofread_id);
    await expect(f.read()).rejects.toThrow(
      "document proofread binding mismatch",
    );
    db.prepare(
      "UPDATE proofread_versions SET status='complete' WHERE proofread_id=?",
    ).run(f.snapshot.version.proofread_id);
    const reads = vi.spyOn(f.files, "withVerified");
    await f.read();
    expect(reads).toHaveBeenCalled();
    db.prepare(
      "UPDATE proofread_resources SET sha256=? WHERE proofread_id=? AND kind='blocks' AND reference=''",
    ).run("f".repeat(64), f.snapshot.version.proofread_id);
    await expect(f.read()).rejects.toThrow();
  } finally {
    vi.restoreAllMocks();
    db.close();
    await f.close();
  }
});

it("keeps size limits and representation declarations active on cache hits", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.e.home, "catalog.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys=OFF"); // Exercise read-time guards beyond publication FKs.
    await f.read();
    db.prepare(
      "UPDATE document_versions SET representation_sha256=? WHERE document_version_id=?",
    ).run("f".repeat(64), f.id);
    await expect(f.read()).rejects.toThrow(
      "document representation hash mismatch",
    );
    db.prepare(
      "UPDATE document_versions SET representation_sha256=?,source_byte_size=? WHERE document_version_id=?",
    ).run(f.snapshot.version.representation_sha256, 257 * 1024 * 1024, f.id);
    await expect(f.read()).rejects.toThrow("document artifact limit exceeded");
  } finally {
    db.close();
    await f.close();
  }
});

it("bounds retained proofs by both entry count and bytes", async () => {
  const f = await fixture();
  try {
    const first = f.id;
    f.e.setText("# Methods\n\nA second fixed synthetic result.\n");
    f.e.setResources([]);
    const second = (
      await correctedDocumentFixture(f.e.app).parseDocuments({
        ...f.e.parseRequest,
        expected_default_revision: 1,
      })
    ).document.document_version_id;
    const storage = new SqliteDocumentStorage(f.database, f.files, {
      maxEntries: 1,
    });
    const reads = vi.spyOn(f.files, "withVerified");
    await storage.withVerifiedDocument(first, async () => null);
    await storage.withVerifiedDocument(second, async () => null);
    reads.mockClear();
    await storage.withVerifiedDocument(second, async () => null);
    expect(reads).not.toHaveBeenCalled();
    await storage.withVerifiedDocument(first, async () => null);
    expect(reads).toHaveBeenCalled();
    const tiny = new SqliteDocumentStorage(f.database, f.files, {
      maxBytes: 1,
    });
    await tiny.withVerifiedDocument(first, async () => null);
    reads.mockClear();
    await tiny.withVerifiedDocument(first, async () => null);
    expect(reads).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30000);

it("hashes the actually delivered resource even when its document proof is warm", async () => {
  const f = await fixture();
  try {
    await f.read();
    const reader = new DocumentReadService(f.database, f.storage);
    const reads = vi.spyOn(f.files, "withVerified");
    const selected = {
      document_version_id: f.id,
      resource_id: f.snapshot.version.resources[0]!.resource_id,
    };
    const bytes = await reader.withResourceBytes(
      selected,
      async (_v, _r, chunks) => {
        const parts: Uint8Array[] = [];
        for await (const part of chunks) parts.push(part);
        return Buffer.concat(parts);
      },
    );
    expect(await sha256(bytes)).toBe(
      f.snapshot.version.resources[0]!.artifact.sha256,
    );
    expect(reads.mock.calls.map(([p]) => p)).toEqual([f.paths.image]);
    await expect(
      reader.withResourceBytes(selected, async (_v, _r, chunks) => {
        for await (const part of chunks) void part;
        await writeFile(
          join(f.files.root, f.paths.image),
          Buffer.alloc(bytes.length),
        );
      }),
    ).rejects.toMatchObject({ code: "document-integrity" });
    await reader.close();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("coalesces concurrent first reads and lets one caller cancel without cancelling another", async () => {
  const f = await fixture();
  const gate = gateFingerprint(f);
  try {
    const bindings = deferred();
    let calls = 0;
    const real = f.database.proofread.bind(f.database);
    vi.spyOn(f.database, "proofread").mockImplementation(
      async <T>(...args: Parameters<SqliteWorker["proofread"]>): Promise<T> => {
        const value = await real<T>(...args);
        if (args[0] === "document-source" && ++calls === 2) bindings.release();
        return value;
      },
    );
    const reads = vi.spyOn(f.files, "withVerified");
    const stop = new AbortController();
    const first = f.storage.withVerifiedDocument(
      f.id,
      async () => null,
      stop.signal,
    );
    const other = f.read();
    await gate.entered;
    await bindings.promise;
    await yieldToEventLoop();
    stop.abort();
    await expect(first).rejects.toThrow();
    expect(gate.signal()?.aborted).toBe(false);
    gate.release();
    const expected = await other;
    expect(reads.mock.calls.filter(([p]) => p === f.paths.pdf)).toHaveLength(1);
    reads.mockClear();
    expect(await f.read()).toEqual(expected);
    expect(reads).not.toHaveBeenCalled();
  } finally {
    gate.release();
    vi.restoreAllMocks();
    await f.close();
  }
});

it("settles the final cancelled verification before returning and does not retain its proof", async () => {
  const f = await fixture();
  const gate = gateFingerprint(f, 2);
  try {
    const reads = vi.spyOn(f.files, "withVerified"),
      stop = new AbortController();
    let settled = false;
    const pending = f.storage.withVerifiedDocument(
      f.id,
      async () => null,
      stop.signal,
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await gate.entered;
    stop.abort();
    await yieldToEventLoop();
    expect(settled).toBe(false);
    gate.release();
    await expect(pending).rejects.toThrow();
    reads.mockClear();
    await f.read();
    expect(reads.mock.calls.filter(([p]) => p === f.paths.pdf)).toHaveLength(1);
    reads.mockClear();
    await f.read();
    expect(reads).not.toHaveBeenCalled();
  } finally {
    gate.release();
    vi.restoreAllMocks();
    await f.close();
  }
});

it("rejects warm proofs and in-flight proofs after their FileStore closes", async () => {
  const f = await fixture();
  const gate = gateFingerprint(f, 2);
  try {
    const pending = f.read();
    await gate.entered;
    await f.files.close();
    gate.release();
    await expect(pending).rejects.toThrow();
    await expect(f.read()).rejects.toThrow();
    const otherFiles = new FileStore(f.files.root);
    try {
      const storage = new SqliteDocumentStorage(f.database, otherFiles);
      await storage.withVerifiedDocument(f.id, async () => null);
      await otherFiles.close();
      await expect(
        storage.withVerifiedDocument(f.id, async () => null),
      ).rejects.toThrow();
    } finally {
      await otherFiles.close();
    }
  } finally {
    gate.release();
    vi.restoreAllMocks();
    await f.close();
  }
});
