import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  IMPORT_LIMITS,
  ContractValidationError,
  type ImportRecord,
  type ImportData,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { decodeBibliography } from "../src/literature/bibliography-import.js";
import { StagingFile } from "../src/storage/files/staging.js";

function record(id: string, doi: string | null = id): ImportRecord {
  return {
    external_id: id,
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `Paper ${id}`,
      identifiers: doi ? [{ namespace: "doi", value: `10.5555/${doi}` }] : [],
      authors: [],
      publication_year: null,
    },
    source_type: null,
    groups: [],
    user_tags: [],
    files: [],
    annotations: [],
  };
}
function data(records: ImportRecord[], groups: ImportData["groups"] = []) {
  return { records, groups };
}
function pdfRecord(id: string): ImportRecord {
  return {
    ...record(id),
    files: [
      {
        external_id: `file-${id}`,
        file_name: `${id}.pdf`,
        media_type: "application/pdf",
        preferred: true,
        size_bytes: null,
        sha256: null,
      },
    ],
  };
}
async function fixture(availableBytes?: () => Promise<number>) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-import-session-"));
  let now = Date.parse("2026-11-10T12:00:00Z");
  const options = {
    indexRefreshIntervalMs: null,
    importSessions: {
      maintain: false,
      now: () => now,
      ...(availableBytes ? { availableBytes } : {}),
    },
  };
  let app = await createApplication(home, options);
  const create = (
    libraryId: string = randomUUID(),
    name = "Synthetic library",
    extra: Record<string, unknown> = {},
  ) =>
    app.importSessions.create(
      {
        format: "records",
        source: {
          system: "synthetic",
          library_id: libraryId,
          identity: "global",
          name,
        },
        scope: "synthetic test",
        ...extra,
      },
      { kind: "local", origin: "cli" },
    );
  const sql = <T>(query: string): T => {
    const db = new DatabaseSync(join(home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      return db.prepare(query).all() as T;
    } finally {
      db.close();
    }
  };
  return {
    home,
    get app() {
      return app;
    },
    create,
    sql,
    setNow: (value: number) => {
      now = value;
    },
    async reopen() {
      await app.close();
      app = await createApplication(home, options);
    },
    async close() {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
async function* chunks(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += 1024)
    yield bytes.subarray(offset, offset + 1024);
}

it("validates an imported group name exactly like FolderService before dispatching its reserved folder write", async () => {
  const f = await fixture();
  try {
    // Import strings allow format characters; folder names forbid them. This
    // reaches folder creation rather than failing the earlier import parser.
    const invalidName = "Group\u200b";
    expect(() =>
      f.app.folders.manage({
        operation: "create",
        request: { parent_id: null, name: invalidName, position: null },
      }),
    ).toThrow(ContractValidationError);
    const s = await f.create();
    await f.app.importSessions.putData(
      s.batch_id,
      0,
      data(
        [{ ...record("invalid-group"), groups: ["group"] }],
        [{ external_id: "group", name: invalidName, parent_external_id: null }],
      ),
    );
    const writes = vi.spyOn(f.app.database, "folders");
    await expect(
      f.app.importSessions.confirm(s.batch_id),
    ).rejects.toBeInstanceOf(ContractValidationError);
    expect(
      writes.mock.calls.filter(
        ([command]) =>
          command.operation === "create" &&
          (command.request as { name?: string }).name === invalidName,
      ),
    ).toHaveLength(0);
    expect(f.sql("SELECT name FROM folders WHERE name LIKE 'Group%'")).toEqual(
      [],
    );
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30000);

it.each([
  "root",
  "source:group",
  "user-tags",
  `tag:${createHash("sha256").update(JSON.stringify("topic")).digest("hex")}`,
])(
  "recovers interrupted %s folder creation without duplicates or claiming user folders",
  async (key) => {
    const f = await fixture();
    try {
      const s = await f.create("crash-folders", "Library", {
        import_user_tags: true,
      });
      await f.app.importSessions.putData(
        s.batch_id,
        0,
        data(
          [
            {
              ...record("crash-folder"),
              groups: ["group"],
              user_tags: ["topic"],
            },
          ],
          [{ external_id: "group", name: "Group", parent_external_id: null }],
        ),
      );
      const original = f.app.database.run.bind(f.app.database);
      let interrupted = false;
      const spy = vi
        .spyOn(f.app.database, "run")
        .mockImplementation(async (command, signal) => {
          if (
            !interrupted &&
            command.kind === "import_write" &&
            command.action.op === "mapping" &&
            command.action.mapping.external_id === key &&
            command.action.mapping.state === "settled"
          ) {
            interrupted = true;
            throw new Error("Synthetic interruption before group mapping");
          }
          return original(command, signal);
        });
      await expect(f.app.importSessions.confirm(s.batch_id)).rejects.toThrow(
        "Synthetic interruption",
      );
      expect(interrupted).toBe(true);
      expect(
        f.sql<{ state: string; content_sha256: string | null }[]>(
          `SELECT state,content_sha256 FROM external_object_mappings WHERE external_id='${key}'`,
        ),
      ).toEqual([{ state: "pending", content_sha256: null }]);
      spy.mockRestore();
      await f.reopen();
      await f.app.importSessions.sweep();
      const final = await f.app.importSessions.status(s.batch_id);
      expect(final.state).toBe("finished");
      expect(
        f
          .sql<
            { state: string }[]
          >("SELECT state FROM external_object_mappings WHERE object_kind='group'")
          .every((v) => v.state === "settled"),
      ).toBe(true);
      const folders = f.sql<{ folder_id: string; name: string }[]>(
        "SELECT folder_id,name FROM folders",
      );
      expect(folders.map((v) => v.name).sort()).toEqual(
        ["Group", "Library", "topic", "标签"].sort(),
      );
      expect(f.sql("SELECT * FROM folder_members")).toHaveLength(2);
      expect(f.sql("SELECT * FROM intake_batch_members")).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
  30000,
);

it("resumes a reserved folder ID before creation and preserves an unrelated user folder with the same name", async () => {
  const f = await fixture();
  try {
    const s = await f.create("reserved-folder", "Library");
    await f.app.importSessions.putData(
      s.batch_id,
      0,
      data(
        [
          {
            ...record("reserved-folder"),
            groups: ["group"],
          },
        ],
        [{ external_id: "group", name: "Group", parent_external_id: null }],
      ),
    );
    const original = f.app.database.folders.bind(f.app.database);
    const spy = vi
      .spyOn(f.app.database, "folders")
      .mockImplementation(async (command, signal) => {
        if (
          command.operation === "create" &&
          (command.request as { name?: string }).name === "Group"
        )
          throw new Error("Synthetic interruption after reservation");
        return original(command, signal);
      });
    await expect(f.app.importSessions.confirm(s.batch_id)).rejects.toThrow(
      "Synthetic interruption",
    );
    spy.mockRestore();
    const reserved = f.sql<{ internal_id: string }[]>(
      "SELECT internal_id FROM external_object_mappings WHERE external_id='source:group'",
    )[0]!;
    expect(reserved).toBeDefined();
    const root = f.sql<{ internal_id: string }[]>(
      "SELECT internal_id FROM external_object_mappings WHERE external_id='root'",
    )[0]!.internal_id;
    const user = (await f.app.folders.manage({
      operation: "create",
      request: { parent_id: root, name: "Group", position: null },
    })) as { folder_id: string };
    await f.reopen();
    await f.app.importSessions.sweep();
    expect((await f.app.importSessions.status(s.batch_id)).state).toBe(
      "finished",
    );
    expect(
      f.sql<{ internal_id: string }[]>(
        "SELECT internal_id FROM external_object_mappings WHERE external_id='source:group'",
      )[0]!.internal_id,
    ).toBe(reserved.internal_id);
    expect(reserved.internal_id).not.toBe(user.folder_id);
    const groups = f.sql<{ folder_id: string; name: string }[]>(
      "SELECT folder_id,name FROM folders WHERE name LIKE 'Group%'",
    );
    expect(groups).toEqual(
      expect.arrayContaining([
        { folder_id: user.folder_id, name: "Group" },
        { folder_id: reserved.internal_id, name: "Group (2)" },
      ]),
    );
    expect(
      f
        .sql<{ folder_id: string }[]>("SELECT folder_id FROM folder_members")
        .some((v) => v.folder_id === user.folder_id),
    ).toBe(false);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30000);

it("replaces numbered parts, keeps preview read-only and rechecks the library on confirmation", async () => {
  const f = await fixture();
  try {
    const s = await f.create();
    await f.app.importSessions.putData(s.batch_id, 0, data([record("old")]));
    await f.app.importSessions.putData(s.batch_id, 1, data([record("second")]));
    await f.app.importSessions.putData(s.batch_id, 0, data([record("first")]));
    const before = f.sql("SELECT * FROM literature_metadata");
    const revisions = f.sql("SELECT * FROM library_state_revision");
    const preview = await f.app.importSessions.preview(s.batch_id);
    expect(preview.summary.records).toMatchObject({ created: 2, matched: 0 });
    expect(f.sql("SELECT * FROM literature_metadata")).toEqual(before);
    expect(f.sql("SELECT * FROM library_state_revision")).toEqual(revisions);
    expect(f.sql("SELECT * FROM import_record_results")).toEqual([]);
    const observation = decodeBibliography(
      Buffer.from('[{"title":"Paper first","DOI":"10.5555/first"}]'),
      "csl-json",
    ).items[0]!.observation!;
    await f.app.identity.observe(observation);
    const confirmed = await f.app.importSessions.confirm(s.batch_id);
    expect(confirmed.state).toBe("finished");
    const report = await f.app.importSessions.report(s.batch_id);
    expect(report.items.map((i) => i.disposition)).toEqual([
      "enriched",
      "created",
    ]);
    expect(
      f.sql<{ n: number }[]>("SELECT count(*) n FROM literatures")[0]!.n,
    ).toBe(2);
    expect(f.sql("SELECT * FROM import_parts")).toEqual([]);
    expect(f.sql("SELECT * FROM import_staged_keys")).toEqual([]);
    expect((await f.app.importSessions.confirm(s.batch_id)).batch_id).toBe(
      confirmed.batch_id,
    );
  } finally {
    await f.close();
  }
}, 30000);

it("resumes persisted sessions and obeys seven-day cancellation/finish rules without retaining raw data", async () => {
  const f = await fixture();
  try {
    const cancelled = await f.create("cancelled");
    await f.app.importSessions.putData(
      cancelled.batch_id,
      0,
      data([record("cancelled")]),
    );
    const refs = f.sql<{ relative_path: string }[]>(
      "SELECT a.relative_path FROM import_parts p JOIN artifact_objects a USING(artifact_id)",
    );
    await f.reopen();
    expect((await f.app.importSessions.status(cancelled.batch_id)).state).toBe(
      "awaiting-confirmation",
    );
    await f.app.importSessions.cancel(cancelled.batch_id);
    expect((await f.app.importSessions.status(cancelled.batch_id)).state).toBe(
      "cancelled",
    );
    for (const ref of refs)
      await expect(
        readFile(join(f.app.files.root, ref.relative_path)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    const waiting = await f.create("waiting"),
      uploading = await f.create("uploading");
    await f.app.importSessions.putData(
      waiting.batch_id,
      0,
      data([record("waiting")]),
    );
    await f.app.importSessions.putData(
      uploading.batch_id,
      0,
      data([pdfRecord("uploading")]),
    );
    await f.app.importSessions.confirm(uploading.batch_id);
    f.setNow(Date.parse(waiting.created_at) + IMPORT_LIMITS.expiry_ms);
    await f.app.importSessions.sweep();
    expect((await f.app.importSessions.status(waiting.batch_id)).state).toBe(
      "cancelled",
    );
    const ended = await f.app.importSessions.report(uploading.batch_id);
    expect(ended.batch.state).toBe("finished");
    expect(ended.summary.files.missing).toBe(1);
    expect(
      (await f.app.importSessions.missingFiles(uploading.batch_id)).items,
    ).toHaveLength(1);
    expect(f.sql("SELECT * FROM import_parts")).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

it("checkpoints replay after an identity commit and deduplicates unchanged external records without identifiers", async () => {
  const f = await fixture();
  try {
    const s = await f.create("no-identifiers");
    await f.app.importSessions.putData(
      s.batch_id,
      0,
      data([record("external", null)]),
    );
    const original = f.app.database.run.bind(f.app.database);
    const spy = vi
      .spyOn(f.app.database, "run")
      .mockImplementation(async (command, signal) => {
        if (command.kind === "import_write" && command.action.op === "result")
          throw new Error("Synthetic interruption after identity commit");
        return original(command, signal);
      });
    await expect(f.app.importSessions.confirm(s.batch_id)).rejects.toThrow(
      "Synthetic interruption",
    );
    spy.mockRestore();
    await f.reopen();
    await f.app.importSessions.sweep();
    const first = await f.app.importSessions.report(s.batch_id),
      literature = first.items[0]!.literature_id;
    expect(first.summary.records.created).toBe(1);
    const count = () =>
      f.sql<{ n: number }[]>("SELECT count(*) n FROM metadata_observations")[0]!
        .n;
    expect(count()).toBe(1);
    const again = await f.create("no-identifiers");
    await f.app.importSessions.putData(
      again.batch_id,
      0,
      data([record("external", null)]),
    );
    await f.app.importSessions.confirm(again.batch_id);
    expect(
      (await f.app.importSessions.report(again.batch_id)).items[0]!.disposition,
    ).toBe("matched");
    expect(count()).toBe(1);
    const changed = await f.create("no-identifiers");
    await f.app.importSessions.putData(
      changed.batch_id,
      0,
      data([
        {
          ...record("external", null),
          metadata: {
            ...record("external", null).metadata,
            title: "Changed source title",
          },
        },
      ]),
    );
    await f.app.importSessions.confirm(changed.batch_id);
    expect(
      (await f.app.importSessions.report(changed.batch_id)).items[0]!
        .literature_id,
    ).toBe(literature);
    expect(count()).toBe(2);
    expect(
      f.sql<{ n: number }[]>("SELECT count(*) n FROM literatures")[0]!.n,
    ).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30000);

it("keeps imported folder hierarchy and multiple memberships without renaming or moving user organization", async () => {
  const f = await fixture();
  try {
    const groups = [
      { external_id: "a", parent_external_id: null, name: "😀".repeat(100) },
      { external_id: "b", parent_external_id: null, name: "😀".repeat(100) },
      { external_id: "nested", parent_external_id: "a", name: "Nested" },
      { external_id: "empty", parent_external_id: "b", name: "Empty group" },
    ];
    const incoming = {
      ...record("folders"),
      groups: ["a", "b", "nested"],
      user_tags: ["my tag"],
    };
    const s = await f.create("folders", "Library old");
    await f.app.importSessions.putData(s.batch_id, 0, data([incoming], groups));
    await f.app.importSessions.confirm(s.batch_id);
    const folders = f.sql<
      { folder_id: string; name: string; parent_id: string | null }[]
    >("SELECT * FROM folders");
    expect(folders).toHaveLength(7);
    expect(folders.every((v) => v.name.length <= 128)).toBe(true);
    expect(f.sql("SELECT * FROM folder_members")).toHaveLength(4);
    const mapping = f.sql<{ internal_id: string }[]>(
      "SELECT internal_id FROM external_object_mappings WHERE object_kind='group' AND external_id='source:a'",
    )[0]!;
    await f.app.folders.manage({
      operation: "rename",
      request: { folder_id: mapping.internal_id, name: "User renamed" },
    });
    const moved = f.sql<{ internal_id: string }[]>(
      "SELECT internal_id FROM external_object_mappings WHERE object_kind='group' AND external_id='source:b'",
    )[0]!;
    await f.app.folders.manage({
      operation: "move",
      request: {
        folder_id: moved.internal_id,
        parent_id: null,
        position: 0,
      },
    });
    const before = f.sql(
      "SELECT folder_id,parent_id,name FROM folders ORDER BY folder_id",
    );
    const again = await f.create("folders", "Library renamed");
    await f.app.importSessions.putData(
      again.batch_id,
      0,
      data(
        [incoming],
        groups.map((g) => ({ ...g, name: "source renamed" })),
      ),
    );
    await f.app.importSessions.confirm(again.batch_id);
    expect(
      f.sql("SELECT folder_id,parent_id,name FROM folders ORDER BY folder_id"),
    ).toEqual(before);
    expect(f.sql("SELECT * FROM folder_members")).toHaveLength(4);
    const cycle = await f.create("cycle");
    await f.app.importSessions.putData(
      cycle.batch_id,
      0,
      data(
        [record("cycle")],
        [{ external_id: "cycle", parent_external_id: "cycle", name: "cycle" }],
      ),
    );
    await expect(
      f.app.importSessions.preview(cycle.batch_id),
    ).rejects.toMatchObject({ code: "intake-group-cycle" });
  } finally {
    await f.close();
  }
}, 30000);

it("uploads a valid unverified PDF once, requests hashes for existing PDFs and reports conflicts/missing files", async () => {
  const f = await fixture();
  try {
    const bytes = workbenchPdf(),
      sha = createHash("sha256").update(bytes).digest("hex");
    const first = await f.create("pdf");
    await f.app.importSessions.putData(
      first.batch_id,
      0,
      data([pdfRecord("pdf")]),
    );
    await f.app.importSessions.confirm(first.batch_id);
    const file = (await f.app.importSessions.missingFiles(first.batch_id))
      .items[0]!;
    expect(file.action).toBe("upload");
    const uploaded = await f.app.importSessions.upload(
      first.batch_id,
      file.file_id,
      chunks(bytes),
    );
    expect(uploaded.status).toBe("uploaded");
    expect(
      (await f.app.library.detail(file.literature_id)).primary_pdf
        ?.article_identity_status,
    ).toBe("unverified");
    expect(
      (
        await f.app.importSessions.upload(
          first.batch_id,
          file.file_id,
          chunks(bytes),
        )
      ).status,
    ).toBe("uploaded");
    const existing = await f.create("pdf");
    await f.app.importSessions.putData(
      existing.batch_id,
      0,
      data([pdfRecord("pdf")]),
    );
    await f.app.importSessions.confirm(existing.batch_id);
    const hashFile = (
      await f.app.importSessions.missingFiles(existing.batch_id)
    ).items[0]!;
    expect(hashFile.action).toBe("hash");
    await expect(
      f.app.importSessions.upload(
        existing.batch_id,
        hashFile.file_id,
        chunks(bytes),
      ),
    ).rejects.toMatchObject({ code: "intake-file-hash-required" });
    expect(
      (
        await f.app.importSessions.reportHash(
          existing.batch_id,
          hashFile.file_id,
          sha,
        )
      ).status,
    ).toBe("existing");
    const conflict = await f.create("pdf");
    await f.app.importSessions.putData(
      conflict.batch_id,
      0,
      data([pdfRecord("pdf")]),
    );
    await f.app.importSessions.confirm(conflict.batch_id);
    const conflictFile = (
      await f.app.importSessions.missingFiles(conflict.batch_id)
    ).items[0]!;
    expect(
      (
        await f.app.importSessions.reportHash(
          conflict.batch_id,
          conflictFile.file_id,
          "b".repeat(64),
        )
      ).status,
    ).toBe("conflict");
    expect(f.sql<{ n: number }[]>("SELECT count(*) n FROM assets")[0]!.n).toBe(
      1,
    );
    const missing = await f.create("missing");
    await f.app.importSessions.putData(
      missing.batch_id,
      0,
      data([pdfRecord("missing")]),
    );
    await f.app.importSessions.confirm(missing.batch_id);
    await f.app.importSessions.finish(missing.batch_id);
    expect(
      (await f.app.importSessions.report(missing.batch_id)).summary.files
        .missing,
    ).toBe(1);
  } finally {
    await f.close();
  }
}, 30000);

it("streams beyond the manual 16 MiB limit without full-file reads and refuses insufficient disk space", async () => {
  const f = await fixture();
  try {
    const s = await f.create("large");
    await f.app.importSessions.putData(
      s.batch_id,
      0,
      data([pdfRecord("large")]),
    );
    await f.app.importSessions.confirm(s.batch_id);
    const file = (await f.app.importSessions.missingFiles(s.batch_id))
        .items[0]!,
      pdf = workbenchPdf();
    const xref = /startxref\s+(\d+)/u.exec(Buffer.from(pdf).toString())![1]!;
    async function* large() {
      yield pdf;
      const block = Buffer.alloc(64 * 1024, 32);
      for (let n = 0; n < 300; n++) yield block;
      yield Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`);
    }
    const noRead = vi
      .spyOn(StagingFile.prototype, "read")
      .mockRejectedValue(new Error("Whole-file read forbidden"));
    const uploaded = await f.app.importSessions.upload(
      s.batch_id,
      file.file_id,
      large(),
    );
    expect(uploaded.status).toBe("uploaded");
    expect(noRead).not.toHaveBeenCalled();
    noRead.mockRestore();
    expect(
      (await f.app.database.currentFacts(file.literature_id))!.primary_asset!
        .size_bytes,
    ).toBeGreaterThan(16 * 1024 * 1024);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
  const disk = await fixture(async () => 0);
  try {
    const s = await disk.create("disk");
    await disk.app.importSessions.putData(
      s.batch_id,
      0,
      data([pdfRecord("disk")]),
    );
    await disk.app.importSessions.confirm(s.batch_id);
    const file = (await disk.app.importSessions.missingFiles(s.batch_id))
      .items[0]!;
    await expect(
      disk.app.importSessions.upload(
        s.batch_id,
        file.file_id,
        chunks(workbenchPdf()),
      ),
    ).rejects.toMatchObject({ code: "intake-disk-space" });
    expect(
      (await disk.app.importSessions.missingFiles(s.batch_id)).items,
    ).toHaveLength(1);
    expect(disk.sql("SELECT * FROM assets")).toEqual([]);
  } finally {
    await disk.close();
  }
}, 30000);

it("cancels a stalled upload before publishing and waits for its cleanup", async () => {
  const f = await fixture();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const s = await f.create("cancel-upload");
    await f.app.importSessions.putData(
      s.batch_id,
      0,
      data([pdfRecord("cancel-upload")]),
    );
    await f.app.importSessions.confirm(s.batch_id);
    const file = (await f.app.importSessions.missingFiles(s.batch_id))
      .items[0]!;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    async function* slow() {
      yield workbenchPdf();
      started();
      await paused;
    }
    const cancelSource = vi.fn();
    const uploading = f.app.importSessions.upload(
      s.batch_id,
      file.file_id,
      slow(),
      undefined,
      cancelSource,
    );
    const rejected = expect(uploading).rejects.toMatchObject({
      code: "intake-upload-cancelled",
    });
    await waiting;
    expect((await f.app.importSessions.cancel(s.batch_id)).state).toBe(
      "cancelled",
    );
    await rejected;
    expect(cancelSource).toHaveBeenCalledOnce();
    expect(f.sql("SELECT * FROM assets")).toEqual([]);
    expect(f.sql("SELECT * FROM import_parts")).toEqual([]);
    expect(
      (await f.app.importSessions.report(s.batch_id)).summary.files.missing,
    ).toBe(1);
    await expect(
      f.app.importSessions.upload(
        s.batch_id,
        file.file_id,
        chunks(workbenchPdf()),
      ),
    ).rejects.toMatchObject({ code: "intake-batch-state" });
  } finally {
    release();
    await f.close();
  }
}, 30000);

it("binds PDF publication to the metadata at upload start and serializes conflicting acknowledgments", async () => {
  const f = await fixture();
  try {
    const s = await f.create("upload-cas");
    await f.app.importSessions.putData(
      s.batch_id,
      0,
      data([pdfRecord("upload-cas")]),
    );
    await f.app.importSessions.confirm(s.batch_id);
    const file = (await f.app.importSessions.missingFiles(s.batch_id))
      .items[0]!;
    async function* changed() {
      yield workbenchPdf();
      const metadata = await f.app.metadataFields.read(file.literature_id);
      await f.app.metadataFields.edit({
        literature_id: file.literature_id,
        expected_revision: metadata.metadata_revision,
        set: [{ field: "title", value: "Manual title during upload" }],
        unlock: [],
      });
    }
    await expect(
      f.app.importSessions.upload(s.batch_id, file.file_id, changed()),
    ).rejects.toMatchObject({ code: "intake-source-stale" });
    expect(f.sql("SELECT * FROM assets")).toEqual([]);
    const bytes = workbenchPdf();
    await f.app.importSessions.upload(s.batch_id, file.file_id, chunks(bytes));
    expect(
      (await f.app.database.currentFacts(file.literature_id))!.literature
        .metadata.title,
    ).toBe("Manual title during upload");
    const again = await f.create("upload-cas");
    await f.app.importSessions.putData(
      again.batch_id,
      0,
      data([pdfRecord("upload-cas")]),
    );
    await f.app.importSessions.confirm(again.batch_id);
    const existing = (await f.app.importSessions.missingFiles(again.batch_id))
      .items[0]!;
    const hashes = await Promise.allSettled([
      f.app.importSessions.reportHash(
        again.batch_id,
        existing.file_id,
        createHash("sha256").update(bytes).digest("hex"),
      ),
      f.app.importSessions.reportHash(
        again.batch_id,
        existing.file_id,
        "c".repeat(64),
      ),
    ]);
    expect(hashes.filter((h) => h.status === "fulfilled")).toHaveLength(1);
    expect(hashes.filter((h) => h.status === "rejected")).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ code: "intake-file-conflict" }),
      },
    ]);
    expect(f.sql<{ n: number }[]>("SELECT count(*) n FROM assets")[0]!.n).toBe(
      1,
    );
  } finally {
    await f.close();
  }
}, 30000);

it("isolates local libraries by device, rejects concurrent libraries and reports unsupported content without stranding metadata", async () => {
  const f = await fixture();
  try {
    const local = {
      format: "records",
      source: {
        system: "synthetic",
        library_id: "1",
        identity: "local",
        name: "Local",
      },
      scope: "test",
    };
    const a = await f.app.importSessions.create(local, {
        kind: "device",
        connection_id: randomUUID(),
      }),
      b = await f.app.importSessions.create(local, {
        kind: "device",
        connection_id: randomUUID(),
      });
    expect(a.batch_id).not.toBe(b.batch_id);
    const s = await f.create("busy", "Busy", { import_user_tags: false });
    await expect(f.create("busy")).rejects.toMatchObject({
      code: "intake-source-busy",
    });
    const valid = {
      ...record("content"),
      user_tags: ["disabled"],
      annotations: [
        {
          external_id: "a",
          file_external_id: "file",
          kind: "highlight" as const,
          quote: "quote",
          note: "",
          color: null,
          page_index: 0,
          coordinate_space: "pdf-bottom-left" as const,
          rects: [],
        },
        {
          external_id: "b",
          file_external_id: "file",
          kind: "ink" as const,
          quote: "",
          note: "",
          color: null,
          page_index: 0,
          coordinate_space: "pdf-bottom-left" as const,
          rects: [],
        },
      ],
    };
    await f.app.importSessions.putData(s.batch_id, 0, {
      records: [
        valid,
        {
          ...record("invalid", null),
          metadata: { ...record("invalid", null).metadata, title: null },
        },
      ],
      groups: [],
      excluded: [{ kind: "notes", count: 2 }],
    });
    await f.app.importSessions.confirm(s.batch_id);
    const report = await f.app.importSessions.report(s.batch_id);
    expect(report.batch.state).toBe("finished");
    expect(report.summary.records).toMatchObject({ created: 1, rejected: 1 });
    expect(report.items[1]).toMatchObject({
      external_id: "invalid",
      reason: "missing-title-or-doi",
    });
    expect(report.summary.annotations).toEqual({
      supported: 1,
      unsupported: 1,
      imported: 0,
      deferred: 1,
    });
    expect(report.summary.excluded).toEqual(
      expect.arrayContaining([
        { kind: "notes", count: 2 },
        { kind: "user-tags-disabled", count: 1 },
        { kind: "unsupported-annotation", count: 1 },
      ]),
    );
    expect(f.sql("SELECT * FROM reading_marks")).toEqual([]);
    const invalidPdf = await f.create("invalid-pdf");
    await f.app.importSessions.putData(
      invalidPdf.batch_id,
      0,
      data([pdfRecord("invalid-pdf")]),
    );
    await f.app.importSessions.confirm(invalidPdf.batch_id);
    const file = (await f.app.importSessions.missingFiles(invalidPdf.batch_id))
      .items[0]!;
    await expect(
      f.app.importSessions.upload(
        invalidPdf.batch_id,
        file.file_id,
        chunks(Buffer.from("not a PDF")),
      ),
    ).rejects.toMatchObject({ code: "intake-pdf-invalid" });
    expect(
      (await f.app.importSessions.missingFiles(invalidPdf.batch_id)).items,
    ).toHaveLength(1);
    expect(f.sql("SELECT * FROM assets")).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

it("uses one batch ID from collection through publication and keeps active in the state transaction", async () => {
  const f = await fixture();
  try {
    const batch = await f.create();
    expect(batch).toMatchObject({
      state: "collecting",
      result: null,
      confirmation: "batch",
      initiated_by: "local:cli",
      source: { system: "synthetic" },
      progress: null,
    });
    expect(batch).not.toHaveProperty("session_id");
    expect(batch).not.toHaveProperty("intake_batch_id");
    expect(batch).not.toHaveProperty("status");
    const rows = () =>
      f.sql<{ state: string; result: string | null; active: number }[]>(
        "SELECT b.state,b.result,s.active FROM intake_batches b JOIN import_sessions s USING(batch_id)",
      );
    expect(rows()).toEqual([{ state: "collecting", result: null, active: 1 }]);
    await f.app.importSessions.putData(
      batch.batch_id,
      0,
      data([pdfRecord("one-id")]),
    );
    expect(rows()).toEqual([
      { state: "awaiting-confirmation", result: null, active: 1 },
    ]);
    const running = await f.app.importSessions.confirm(batch.batch_id);
    expect(running).toMatchObject({
      batch_id: batch.batch_id,
      state: "running",
      result: null,
      progress: {
        phase: "files",
        processed_items: 1,
        total_items: 1,
        files: { pending: 1 },
      },
    });
    expect(
      await f.app.library.intakeBatches({
        operation: "get",
        request: { batch_id: batch.batch_id },
      }),
    ).toEqual(running);
    const ended = await f.app.importSessions.finish(batch.batch_id);
    expect(ended).toMatchObject({
      batch_id: batch.batch_id,
      state: "finished",
      result: "partial",
      progress: null,
    });
    expect(rows()).toEqual([
      { state: "finished", result: "partial", active: 0 },
    ]);
    const cancelled = await f.create();
    await f.app.importSessions.cancel(cancelled.batch_id);
    expect(await f.app.importSessions.status(cancelled.batch_id)).toMatchObject(
      { state: "cancelled", result: null },
    );
    expect(f.sql("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

it("keeps conflicting items distinct from rejected items in the unified batch counters", async () => {
  const f = await fixture();
  try {
    const first = await f.create("conflict-counters");
    await f.app.importSessions.putData(
      first.batch_id,
      0,
      data([record("external", "first"), record("other", "second")]),
    );
    await f.app.importSessions.confirm(first.batch_id);
    const next = await f.create("conflict-counters");
    await f.app.importSessions.putData(
      next.batch_id,
      0,
      data([record("external", "second")]),
    );
    const result = await f.app.importSessions.confirm(next.batch_id);
    expect(result).toMatchObject({
      state: "finished",
      result: "failed",
      counts: { hits: 0, conflicts: 1, rejected: 0 },
    });
    expect(
      (await f.app.importSessions.report(next.batch_id)).items[0],
    ).toMatchObject({ disposition: "conflict" });
  } finally {
    await f.close();
  }
}, 30000);
