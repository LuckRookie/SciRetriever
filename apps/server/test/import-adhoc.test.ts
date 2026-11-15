import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { EMPTY_METADATA } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";

const bibliography =
  "@article{same-local-key,title={One-off source},author={Lovelace, Ada},year={2026}}";

it("retains metadata_only across reopening and imports the raw bibliography with no file manifest", async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const source = bibliography.replace(
      "year={2026}",
      "year={2026},file={Full Text PDF:files/a.pdf:application/pdf}",
    );
    const batch = await f.app.importSessions.create(
      {
        format: "bibtex",
        source: null,
        scope: "Metadata only",
        metadata_only: true,
      },
      { kind: "local", origin: "web" },
    );
    await f.app.importSessions.putData(batch.batch_id, 0, source);
    await f.app.close();
    reopened = await createApplication(f.home, {
      indexRefreshIntervalMs: null,
      importSessions: { maintain: false },
    });
    const result = await reopened.importSessions.confirm(batch.batch_id);
    expect(result).toMatchObject({
      state: "finished",
      result: "completed",
      request: { format: "bibtex", metadata_only: true },
    });
    expect(
      (
        await reopened.importSessions.missingFiles(
          batch.batch_id,
          null,
          50,
          false,
        )
      ).items,
    ).toEqual([]);
    expect(
      (await reopened.importSessions.report(batch.batch_id)).summary.excluded,
    ).toEqual([{ kind: "metadata-only-attachment", count: 1 }]);
  } finally {
    await reopened?.close();
    await f.close();
  }
}, 30_000);

it("preserves UTF-16 and malformed-record receipts through the thin bibliography wrapper", async () => {
  const f = await fixture();
  try {
    const utf16 = Buffer.from("\ufeff" + bibliography, "utf16le");
    const imported = await f.app.importSessions.importBibliography(
      utf16,
      "bibtex",
      "utf16.bib",
      "cli",
    );
    expect(imported).toMatchObject({
      format: "bibtex",
      items: [{ record_index: 0, disposition: "created", reason: null }],
    });
    expect(
      (await f.app.importSessions.status(imported.intake_batch_id!)).request,
    ).toMatchObject({ format: "bibtex", metadata_only: true });
    const malformed = await f.app.importSessions.importBibliography(
      Buffer.from('[{"title":"Valid raw entry"},"invalid"]'),
      "csl-json",
      "mixed.json",
      "mcp",
    );
    expect(malformed.items).toMatchObject([
      { record_index: 0, disposition: "created" },
      { record_index: 1, disposition: "rejected", reason: "malformed-record" },
    ]);
    const invalidEncoding = await f.app.importSessions.importBibliography(
      Buffer.from([0xc0, 0x80]),
      "bibtex",
      "invalid.bib",
      "cli",
    );
    expect(invalidEncoding).toEqual({
      format: "bibtex",
      items: [
        {
          record_index: 0,
          disposition: "rejected",
          literature_id: null,
          meta_literature_id: null,
          reason: "malformed-document",
        },
      ],
    });
  } finally {
    await f.close();
  }
}, 30_000);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-import-adhoc-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: false },
  });
  const create = (
    file_name: string | null = "batch-fixture.bib",
    format = "bibtex",
  ) =>
    app.importSessions.create(
      { format, source: null, file_name, scope: "one uploaded file" },
      { kind: "local", origin: "web" },
    );
  const count = (table: string) => {
    const db = new DatabaseSync(join(home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      return Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
    } finally {
      db.close();
    }
  };
  return {
    home,
    app,
    create,
    count,
    async close() {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
async function* chunks(bytes: Uint8Array) {
  yield bytes;
}

it.each(["bibtex", "biblatex", "ris"] as const)(
  "delivers a PDF named by the %s export through the one-off session file channel",
  async (format) => {
    const f = await fixture();
    try {
      const source =
        format === "ris"
          ? "TY  - JOUR\nID  - attachment\nTI  - Attached paper\nL1  - files/123/Attached.pdf\nL1  - files/123/other.pdf\nL1  - files/123/note.html\nER  -\n"
          : "@article{attachment,title={Attached paper},file={Full Text PDF:files/123/Attached.pdf:application/pdf;Other:files/123/other.pdf:PDF;Snapshot:files/123/note.html:text/html}}";
      const s = await f.create(
        `attachments.${format === "ris" ? "ris" : "bib"}`,
        format,
      );
      await f.app.importSessions.putData(s.batch_id, 0, source);
      const preview = await f.app.importSessions.preview(s.batch_id);
      expect(preview.summary.records.created).toBe(1);
      expect(preview.summary.files).toMatchObject({
        upload: 1,
        hash: 0,
        missing: 1,
      });
      expect(preview.summary.excluded).toEqual([
        { kind: "additional-file", count: 1 },
        { kind: "non-pdf-file", count: 1 },
      ]);
      expect(f.count("literatures")).toBe(0);
      const confirmed = await f.app.importSessions.confirm(s.batch_id);
      expect(confirmed).toMatchObject({
        state: "running",
        progress: { files: { pending: 1 } },
      });
      const file = (await f.app.importSessions.missingFiles(s.batch_id))
        .items[0]!;
      expect(file).toMatchObject({
        external_id: "files/123/Attached.pdf",
        file_name: "Attached.pdf",
        action: "upload",
      });
      await f.app.importSessions.upload(
        s.batch_id,
        file.file_id,
        chunks(workbenchPdf()),
      );
      const report = await f.app.importSessions.report(s.batch_id);
      expect(report.batch.state).toBe("finished");
      expect(report.summary.files).toMatchObject({ uploaded: 1, missing: 0 });
      expect(report.summary.excluded).toEqual(preview.summary.excluded);
      expect(
        (await f.app.library.detail(file.literature_id)).primary_pdf!
          .article_identity_status,
      ).toBe("unverified");
    } finally {
      await f.close();
    }
  },
  30000,
);

it("isolates simultaneous file sessions while deduplicating repeated bibliography and preserving manual metadata", async () => {
  const f = await fixture();
  try {
    const first = await f.create(),
      second = await f.create();
    expect(first.source).toEqual({
      system: "file",
      library_id: "",
      identity: "adhoc",
      name: "batch-fixture.bib",
    });
    expect(first.batch_id).not.toBe(second.batch_id);
    await f.app.importSessions.putData(first.batch_id, 0, bibliography);
    expect(
      (await f.app.importSessions.preview(first.batch_id)).summary.records,
    ).toMatchObject({ created: 1, matched: 0 });
    expect(f.count("literatures")).toBe(0);
    await f.app.importSessions.confirm(first.batch_id);
    const result = (await f.app.importSessions.report(first.batch_id))
      .items[0]!;
    await f.app.importSessions.putData(second.batch_id, 0, bibliography);
    expect(
      (await f.app.importSessions.preview(second.batch_id)).summary.records,
    ).toMatchObject({ created: 0, matched: 1 });
    await f.app.importSessions.confirm(second.batch_id);
    expect(
      (await f.app.importSessions.report(second.batch_id)).items[0]!
        .disposition,
    ).toBe("matched");
    expect(f.count("literatures")).toBe(1);
    expect(f.count("metadata_observations")).toBe(1);
    expect(f.count("external_object_mappings")).toBe(0);
    const batch = (await f.app.importSessions.status(first.batch_id)).batch_id;
    expect(
      await f.app.library.intakeBatches({
        operation: "get",
        request: { batch_id: batch },
      }),
    ).toMatchObject({ label: "batch-fixture.bib", origin: "web" });
    const current = await f.app.metadataFields.read(result.literature_id!);
    await f.app.metadataFields.edit({
      literature_id: result.literature_id,
      expected_revision: current.metadata_revision,
      set: [{ field: "title", value: "Manual title" }],
      unlock: [],
    });
    const third = await f.create();
    await f.app.importSessions.putData(third.batch_id, 0, bibliography);
    await f.app.importSessions.confirm(third.batch_id);
    const facts = (await f.app.database.currentFacts(result.literature_id!))!;
    expect(facts.literature.metadata.title).toBe("Manual title");
    const detail = await f.app.library.detail(result.literature_id!);
    expect(
      detail.metadata_observations.filter(
        (o) => o.provenance.source_name === "bibliographic-import",
      ),
    ).toHaveLength(1);
    for (const o of detail.metadata_observations.filter(
      (o) => o.provenance.source_name === "bibliographic-import",
    ))
      expect(o.provenance).toMatchObject({
        source_kind: "user",
        source_record_id: null,
        input_sha256: null,
        parameters_sha256: null,
      });
    await expect(
      f.app.importSessions.create(
        { format: "bibtex", source: first.source, scope: "reuse source" },
        { kind: "local", origin: "web" },
      ),
    ).rejects.toThrow();
    await expect(
      f.app.importSessions.putData(first.batch_id, 1, bibliography),
    ).rejects.toMatchObject({ code: "intake-batch-state" });
    const malformed = await f.create();
    await expect(
      f.app.importSessions.putData(malformed.batch_id, 0, {
        legacy_decoded: [],
      }),
    ).rejects.toMatchObject({ code: "intake-input-invalid" });
  } finally {
    await f.close();
  }
}, 30000);

it("keeps file channels session-bound without importing groups or reusable external mappings", async () => {
  const f = await fixture();
  try {
    const one = await f.create("same-file.json", "records"),
      two = await f.create("same-file.json", "records");
    const payload = (title: string) => ({
      groups: [
        {
          external_id: "group",
          parent_external_id: null,
          name: "Ignored group",
        },
      ],
      records: [
        {
          external_id: "same-external-id",
          metadata: { ...EMPTY_METADATA, title },
          groups: ["group"],
          user_tags: ["Ignored tag"],
          files: [
            {
              external_id: "same-file-id",
              file_name: "paper.pdf",
              media_type: "application/pdf",
              preferred: true,
            },
          ],
        },
      ],
    });
    await f.app.importSessions.putData(one.batch_id, 0, payload("First paper"));
    await f.app.importSessions.confirm(one.batch_id);
    await f.app.importSessions.putData(
      two.batch_id,
      0,
      payload("Different paper"),
    );
    await f.app.importSessions.confirm(two.batch_id);
    expect(f.count("literatures")).toBe(2);
    const a = (await f.app.importSessions.missingFiles(one.batch_id)).items[0]!,
      b = (await f.app.importSessions.missingFiles(two.batch_id)).items[0]!;
    expect(a.file_id).not.toBe(b.file_id);
    await expect(
      f.app.importSessions.upload(
        two.batch_id,
        a.file_id,
        chunks(workbenchPdf()),
      ),
    ).rejects.toMatchObject({ code: "intake-file-missing" });
    await f.app.importSessions.upload(
      one.batch_id,
      a.file_id,
      chunks(workbenchPdf()),
    );
    await f.app.importSessions.upload(
      two.batch_id,
      b.file_id,
      chunks(workbenchPdf()),
    );
    expect((await f.app.importSessions.status(one.batch_id)).state).toBe(
      "finished",
    );
    expect((await f.app.importSessions.status(two.batch_id)).state).toBe(
      "finished",
    );
    expect(f.count("folders")).toBe(0);
    expect(f.count("external_object_mappings")).toBe(0);
    const report = await f.app.importSessions.report(one.batch_id);
    expect(report.summary.files.uploaded).toBe(1);
    expect(report.summary.excluded).toContainEqual({
      kind: "groups",
      count: 1,
    });
    expect(report.summary.excluded).toContainEqual({
      kind: "user-tags-disabled",
      count: 1,
    });
    expect(
      (await f.app.library.detail(a.literature_id)).primary_pdf!
        .article_identity_status,
    ).toBe("unverified");
  } finally {
    await f.close();
  }
}, 30000);

it("allows file sessions for all local actors and preserves real CLI/stdio bibliography entry semantics", async () => {
  const f = await fixture();
  const host = createMcpServer({
    home: f.home,
    maintenance: true,
    sharedApplications: true,
    applicationFactory: async () => f.app,
  });
  const [server, transport] = InMemoryTransport.createLinkedPair(),
    client = new Client({ name: "adhoc-fixture", version: "1" });
  try {
    for (const origin of ["web", "cli", "mcp"] as const) {
      const s = await f.app.importSessions.create(
        { format: "ris", source: null, file_name: null, scope: "local file" },
        { kind: "local", origin },
      );
      expect(s.source).toEqual({
        system: "file",
        library_id: "",
        identity: "adhoc",
        name: "",
      });
      expect(s.initiated_by).toBe(`local:${origin}`);
      await f.app.importSessions.cancel(s.batch_id);
    }
    const device = await f.app.importSessions.create(
      { format: "ris", source: null, scope: "device file" },
      { kind: "device", connection_id: randomUUID() },
    );
    expect(device.source?.identity).toBe("adhoc");
    const path = join(f.home, "batch-fixture.bib"),
      withAttachment = bibliography.replace(
        "year={2026}",
        "year={2026},file={Full Text PDF:files/123/never-read.pdf:application/pdf}",
      );
    await writeFile(path, withAttachment);
    const cli = await runCli(["import", "metadata", "bibtex", path, "--json"], {
      home: f.home,
    });
    expect(cli.code).toBe(0);
    await host.connect(server);
    await client.connect(transport);
    const mcp = await client.callTool({
      name: "import_bibliography",
      arguments: {
        format: "bibtex",
        content: withAttachment,
        file_name: "batch-fixture.bib",
      },
    });
    expect(mcp.isError).not.toBe(true);
    const result = (
      mcp.structuredContent as { result: { intake_batch_id: string } }
    ).result;
    expect(
      await f.app.library.intakeBatches({
        operation: "get",
        request: { batch_id: result.intake_batch_id },
      }),
    ).toMatchObject({ label: "batch-fixture.bib", origin: "mcp" });
    expect(f.count("literatures")).toBe(1);
    expect(f.count("metadata_observations")).toBe(1);
    const sessions = (await f.app.importSessions.list()).items;
    expect(sessions.filter((s) => s.source?.identity === "adhoc")).toHaveLength(
      sessions.length,
    );
    expect(
      sessions
        .filter((s) => s.request.file_name === "batch-fixture.bib")
        .map((s) => s.source?.name),
    ).toEqual(["batch-fixture.bib", "batch-fixture.bib"]);
    for (const s of sessions.filter(
      (s) => s.request.file_name === "batch-fixture.bib",
    )) {
      expect(s).toMatchObject({ state: "finished", progress: null });
      expect(s.request.metadata_only).toBe(true);
      expect(
        (await f.app.importSessions.missingFiles(s.batch_id)).items,
      ).toEqual([]);
      expect(
        (await f.app.importSessions.report(s.batch_id)).summary.excluded,
      ).toContainEqual({ kind: "metadata-only-attachment", count: 1 });
    }
  } finally {
    await client.close();
    await host.close();
    await f.close();
  }
}, 30000);
