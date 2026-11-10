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
      { format, library: null, file_name, scope: "one uploaded file" },
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
      await f.app.importSessions.putData(s.session_id, 0, source);
      const preview = await f.app.importSessions.preview(s.session_id);
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
      const confirmed = await f.app.importSessions.confirm(s.session_id);
      expect(confirmed).toMatchObject({ state: "importing", pending_files: 1 });
      const file = (await f.app.importSessions.missingFiles(s.session_id))
        .items[0]!;
      expect(file).toMatchObject({
        external_id: "files/123/Attached.pdf",
        file_name: "Attached.pdf",
        action: "upload",
      });
      await f.app.importSessions.upload(
        s.session_id,
        file.file_id,
        chunks(workbenchPdf()),
      );
      const report = await f.app.importSessions.report(s.session_id);
      expect(report.session.state).toBe("completed");
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
    expect(first.library).toEqual({
      system: "file",
      library_id: "",
      identity: "adhoc",
      name: "batch-fixture.bib",
    });
    expect(first.library_key).not.toBe(second.library_key);
    await f.app.importSessions.putData(first.session_id, 0, bibliography);
    expect(
      (await f.app.importSessions.preview(first.session_id)).summary.records,
    ).toMatchObject({ created: 1, matched: 0 });
    expect(f.count("literatures")).toBe(0);
    await f.app.importSessions.confirm(first.session_id);
    const result = (await f.app.importSessions.report(first.session_id))
      .items[0]!;
    await f.app.importSessions.putData(second.session_id, 0, bibliography);
    expect(
      (await f.app.importSessions.preview(second.session_id)).summary.records,
    ).toMatchObject({ created: 0, matched: 1 });
    await f.app.importSessions.confirm(second.session_id);
    expect(
      (await f.app.importSessions.report(second.session_id)).items[0]!
        .disposition,
    ).toBe("matched");
    expect(f.count("literatures")).toBe(1);
    expect(f.count("metadata_observations")).toBe(1);
    expect(f.count("external_object_mappings")).toBe(0);
    const batch = (await f.app.importSessions.status(first.session_id))
      .intake_batch_id;
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
    await f.app.importSessions.putData(third.session_id, 0, bibliography);
    await f.app.importSessions.confirm(third.session_id);
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
        { format: "bibtex", library: first.library, scope: "reuse source" },
        { kind: "local", origin: "web" },
      ),
    ).rejects.toThrow();
    await expect(
      f.app.importSessions.putData(first.session_id, 1, bibliography),
    ).rejects.toMatchObject({ code: "import-session-state" });
    const malformed = await f.create();
    await expect(
      f.app.importSessions.putData(malformed.session_id, 0, {
        legacy_decoded: [],
      }),
    ).rejects.toMatchObject({ code: "import-input-invalid" });
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
    await f.app.importSessions.putData(
      one.session_id,
      0,
      payload("First paper"),
    );
    await f.app.importSessions.confirm(one.session_id);
    await f.app.importSessions.putData(
      two.session_id,
      0,
      payload("Different paper"),
    );
    await f.app.importSessions.confirm(two.session_id);
    expect(f.count("literatures")).toBe(2);
    const a = (await f.app.importSessions.missingFiles(one.session_id))
        .items[0]!,
      b = (await f.app.importSessions.missingFiles(two.session_id)).items[0]!;
    expect(a.file_id).not.toBe(b.file_id);
    await expect(
      f.app.importSessions.upload(
        two.session_id,
        a.file_id,
        chunks(workbenchPdf()),
      ),
    ).rejects.toMatchObject({ code: "import-file-missing" });
    await f.app.importSessions.upload(
      one.session_id,
      a.file_id,
      chunks(workbenchPdf()),
    );
    await f.app.importSessions.upload(
      two.session_id,
      b.file_id,
      chunks(workbenchPdf()),
    );
    expect((await f.app.importSessions.status(one.session_id)).state).toBe(
      "completed",
    );
    expect((await f.app.importSessions.status(two.session_id)).state).toBe(
      "completed",
    );
    expect(f.count("folders")).toBe(0);
    expect(f.count("external_object_mappings")).toBe(0);
    const report = await f.app.importSessions.report(one.session_id);
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
        { format: "ris", library: null, file_name: null, scope: "local file" },
        { kind: "local", origin },
      );
      expect(s.library).toEqual({
        system: "file",
        library_id: "",
        identity: "adhoc",
        name: "",
      });
      expect(s.initiated_by).toBe(`local:${origin}`);
      await f.app.importSessions.cancel(s.session_id);
    }
    const device = await f.app.importSessions.create(
      { format: "ris", library: null, scope: "device file" },
      { kind: "device", connection_id: randomUUID() },
    );
    expect(device.library.identity).toBe("adhoc");
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
    expect(sessions.filter((s) => s.library.identity === "adhoc")).toHaveLength(
      sessions.length,
    );
    expect(
      sessions
        .filter((s) => s.file_name === "batch-fixture.bib")
        .map((s) => s.library.name),
    ).toEqual(["batch-fixture.bib", "batch-fixture.bib"]);
    for (const s of sessions.filter(
      (s) => s.file_name === "batch-fixture.bib",
    )) {
      expect(s).toMatchObject({ state: "completed", pending_files: 0 });
      expect(
        (await f.app.importSessions.missingFiles(s.session_id)).items,
      ).toEqual([]);
    }
  } finally {
    await client.close();
    await host.close();
    await f.close();
  }
}, 30000);
