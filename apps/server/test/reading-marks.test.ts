import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseLiterature,
  parseLiteratureId,
  parseAsset,
  parseMarkOperation,
  MARK_LOCATE_METHOD,
  PROCESSOR_METHOD_REVISION,
  parseDeviceConnectionCode,
  type Asset,
  parseReadingMark,
  sha256,
  type ReadingMark,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { SdkTransportAdapter } from "../src/mcp/transport.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const paper = FIXTURE_LITERATURE.literature_id;

it("keeps a draft text anchor on its fixed version after corrected publication and rejects out-of-range or foreign anchors", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const parsed = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    if (parsed.draft.status !== "formed")
      throw new Error("Synthetic draft missing");
    const draftId = parsed.draft.document_version_id;
    const segments = await f.app.documentRead.segments({
      document_version_id: draftId,
      section_id: null,
      limit: 100,
      cursor: null,
    });
    const segment = segments.segments.find((s) => s.kind === "text")!;
    const document = {
      document_version_id: draftId,
      start_utf8: segment.start_utf8,
      end_utf8: segment.end_utf8,
    };
    const request = {
      literature_id: paper,
      kind: "highlight",
      color: "yellow",
      quote: "A synthetic finding.",
      document,
    };
    const mark = await f.app.marks.manage({ operation: "create", request });
    expect(mark.document).toEqual(document);
    await expect(
      f.app.marks.manage({
        operation: "create",
        request: {
          ...request,
          document: { ...document, end_utf8: 10_000_000 },
        },
      }),
    ).rejects.toMatchObject({ code: "mark-anchor-invalid" });
    const other = "00000000-0000-0000-0000-000000000099";
    await f.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: other,
        meta_literature_id: "00000000-0000-0000-0000-000000000098",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Another synthetic paper",
          identifiers: [],
        },
      }),
    );
    await expect(
      f.app.marks.manage({
        operation: "create",
        request: { ...request, literature_id: other },
      }),
    ).rejects.toMatchObject({ code: "mark-anchor-invalid" });
    const proofread = await f.app.proofreading!.build({
      asset_id: f.asset.asset_id,
    });
    const published = await f.app.proofreadDocuments.publish({
      literature_id: paper,
      asset_id: f.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: 1,
    });
    expect(published.document.document_version_id).not.toBe(draftId);
    expect(
      await f.app.marks.query({
        operation: "list",
        request: { literature_id: paper },
      }),
    ).toMatchObject({ items: [{ mark_id: mark.mark_id, document }] });
  } finally {
    await f.close();
  }
}, 30_000);

it(
  "keeps a paper's highlights, regions and notes as user data with the same reads on every interface",
  { timeout: 0 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-marks-")),
      app = await createApplication(home);
    const server = createMcpServer({ home, maintenance: true }),
      client = new Client({ name: "marks-tests", version: "1" });
    let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    const manage = async (operation: string, request: unknown) =>
      parseReadingMark(
        await executeMaintenance(app, "marks", { operation, request }),
      );
    const list = async () =>
      (
        (await app.marks.query({
          operation: "list",
          request: { literature_id: paper },
        })) as { items: ReadingMark[] }
      ).items;
    try {
      await app.database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
      const pdf = workbenchPdf();
      await app.maintenance!.ingestPdf({ literature_id: paper, bytes: pdf });
      const digest = await sha256(pdf);
      const anchor = (page: number, y: number) => ({
        sha256: digest,
        page,
        rects: [[72, y, 240.123, 12]],
      });

      const highlight = await manage("create", {
        literature_id: paper,
        kind: "highlight",
        color: "yellow",
        quote: "retained 88 % of the pristine conductivity",
        quote_prefix: "barrier ",
        pdf: anchor(2, 300),
      });
      expect(highlight).toMatchObject({
        kind: "highlight",
        note: "",
        tags: [],
        deleted_at: null,
        pdf: { page: 2, rects: [[72, 300, 240.12, 12]] },
        document: null,
      });
      const region = await manage("create", {
        literature_id: paper,
        kind: "region",
        color: "purple",
        note: "曲线复现时核对单位 #图表",
        pdf: anchor(1, 120),
      });
      expect(region.tags).toEqual(["图表"]);

      // Anchors must belong to this paper; a highlight needs its words.
      await expect(
        manage("create", {
          literature_id: paper,
          kind: "highlight",
          color: "blue",
          quote: "words",
          pdf: { ...anchor(1, 10), sha256: "0".repeat(64) },
        }),
      ).rejects.toMatchObject({ code: "mark-anchor-invalid" });
      await expect(
        manage("create", {
          literature_id: paper,
          kind: "highlight",
          color: "blue",
          pdf: anchor(1, 10),
        }),
      ).rejects.toThrow();
      await expect(
        manage("create", {
          literature_id: paper,
          kind: "region",
          color: "blue",
          document: {
            document_version_id: "missing",
            start_utf8: 0,
            end_utf8: 4,
          },
        }),
      ).rejects.toThrow();

      const noted = await manage("update", {
        mark_id: highlight.mark_id,
        color: "green",
        note: "讨论第二段用 #综述 #待补实验",
      });
      expect(noted).toMatchObject({
        color: "green",
        tags: ["综述", "待补实验"],
      });
      // Reading order: page first, then top to bottom.
      expect((await list()).map((m) => m.mark_id)).toEqual([
        region.mark_id,
        highlight.mark_id,
      ]);

      const removed = await manage("delete", { mark_id: region.mark_id });
      expect(removed.deleted_at).not.toBeNull();
      expect((await list()).map((m) => m.mark_id)).toEqual([highlight.mark_id]);
      await expect(
        manage("update", { mark_id: region.mark_id, note: "x" }),
      ).rejects.toMatchObject({ code: "mark-deleted" });
      expect(
        (await manage("restore", { mark_id: region.mark_id })).deleted_at,
      ).toBeNull();

      const markdown = (await app.marks.query({
        operation: "export",
        request: { literature_id: paper, format: "markdown" },
      })) as { format: string; content: string };
      expect(markdown.format).toBe("markdown");
      expect(markdown.content).toContain("## 第 1 页");
      expect(markdown.content).toContain("- **待查** 框选区域（第 1 页）");
      expect(markdown.content).toContain(
        "- **结论** > retained 88 % of the pristine conductivity",
      );
      expect(markdown.content).toContain("  讨论第二段用 #综述 #待补实验");

      // The independent query application, the CLI and MCP read the same marks.
      const items = await list();
      q = await createQueryApplication(home);
      expect(
        await executeQuery(q, "marks", {
          operation: "list",
          request: { literature_id: paper },
        }),
      ).toEqual({ items });
      const request = join(home, "marks-request.json");
      await writeFile(request, JSON.stringify({ literature_id: paper }));
      const cli = await runCli(
        ["marks", "list", "--request", request, "--json"],
        { home, stdout: () => {}, stderr: () => {} },
      );
      expect(cli.code).toBe(0);
      expect(cli.value).toEqual({ items });
      await writeFile(
        request,
        JSON.stringify({ literature_id: paper, format: "markdown" }),
      );
      const printed: string[] = [];
      const exported = await runCli(["marks", "export", "--request", request], {
        home,
        stdout: (text) => printed.push(text),
        stderr: () => {},
      });
      expect(exported.code).toBe(0);
      expect(printed.join("")).toBe(markdown.content);

      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      const created = await client.callTool({
        name: "marks_manage",
        arguments: {
          operation: "create",
          request: {
            literature_id: paper,
            kind: "highlight",
            color: "red",
            quote: "understate the damage",
            pdf: anchor(1, 400),
          },
        },
      });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      const read = await client.callTool({
        name: "marks_query",
        arguments: { operation: "list", request: { literature_id: paper } },
      });
      expect(read.isError, JSON.stringify(read)).not.toBe(true);
      expect(await list()).toHaveLength(3);

      // Marks are user data on the paper, and go with it.
      const raw = new DatabaseSync(join(home, "catalog.sqlite"));
      try {
        expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          raw.prepare("SELECT count(*) AS n FROM reading_marks").get()!.n,
        ).toBe(3);
      } finally {
        raw.close();
      }
    } finally {
      await q?.close();
      await client.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

async function relocationFixture(withPdfOnly = false) {
  const f = await coreProcessingFixture({ offline: true });
  let database: DatabaseSync | undefined;
  try {
    const first = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    if (first.draft.status !== "formed")
      throw new Error("Synthetic first draft missing");
    const original = await f.app.marks.manage({
      operation: "create",
      request: {
        literature_id: paper,
        kind: "highlight",
        color: "blue",
        quote: "A synthetic finding.",
        quote_prefix: "before",
        quote_suffix: "after",
        note: "Original note #fixture",
        pdf: { sha256: f.asset.sha256, page: 1, rects: [[0, 0, 20, 10]] },
        document: {
          document_version_id: first.draft.document_version_id,
          start_utf8: 0,
          end_utf8: 20,
        },
      },
    });
    const pdfOnly = withPdfOnly
      ? await f.app.marks.manage({
          operation: "create",
          request: {
            literature_id: paper,
            kind: "highlight",
            color: "yellow",
            quote: "PDF-only original",
            pdf: { sha256: f.asset.sha256, page: 1, rects: [[1, 1, 20, 10]] },
          },
        })
      : null;
    const asset = async (name: string, literature = paper) => {
      const bytes = workbenchPdf(`10.5555/${name}`),
        path = `objects/${name}.pdf`;
      const stage = await f.app.files.stage({ maxBytes: bytes.length });
      try {
        await stage.write(bytes);
        await f.app.files.publish(stage, path);
      } finally {
        await stage.discard();
      }
      const value = parseAsset({
        asset_id: randomUUID(),
        sha256: await sha256(bytes),
        size_bytes: bytes.length,
        media_type: "application/pdf",
        path,
      });
      await f.app.database.putLiteratureAsset({
        literature_asset_id: randomUUID(),
        literature_id: literature,
        asset: value,
        role: "supplementary-pdf",
        source_url: null,
        provenance: {
          provenance_id: randomUUID(),
          source_kind: "user",
          source_name: "relocation-fixture",
          source_record_id: null,
          observed_at: "2026-11-16T00:00:00Z",
          input_sha256: value.sha256,
          parameters_sha256: null,
        },
      });
      return value;
    };
    const next = await asset("next"),
      supplement = await asset("supplement"),
      otherSupplement = await asset("other-supplement");
    const foreign = parseLiteratureId("00000000-0000-0000-0000-000000000088");
    await f.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: foreign,
        meta_literature_id: "00000000-0000-0000-0000-000000000089",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Foreign paper",
          identifiers: [],
        },
      }),
    );
    const foreignPdf = await asset("foreign", foreign);
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"));
    database = db;
    db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=20000;BEGIN");
    // Simulate replacing the main material; the original immutable anchors stay.
    db.prepare(
      "DELETE FROM literature_assets WHERE literature_id=? AND asset_id=?",
    ).run(paper, f.asset.asset_id);
    db.prepare(
      "UPDATE literature_assets SET role='primary-pdf' WHERE literature_id=? AND asset_id=?",
    ).run(paper, next.asset_id);
    db.exec("COMMIT");
    f.setText(
      "A relocated synthetic finding. More text for a second fixed version.",
    );
    const parse = async (value: Asset, literature = paper) => {
      const parsed = await f.app.documentProcessing.parseDocuments({
        literature_id: literature,
        asset_id: value.asset_id,
        asset_sha256: value.sha256,
        profiles: ["vlm-engine"],
        force: false,
      });
      if (parsed.draft.status !== "formed")
        throw new Error("Synthetic target draft missing");
      return {
        document_version_id: parsed.draft.document_version_id,
        start_utf8: 0,
        end_utf8: 20,
      };
    };
    const document = await parse(next),
      supplementDocument = await parse(supplement),
      foreignDocument = await parse(foreignPdf, foreign);
    await f.app.maintenance!.refreshIndex!();
    return {
      f,
      db,
      original,
      pdfOnly,
      next,
      supplement,
      otherSupplement,
      foreignPdf,
      document,
      supplementDocument,
      foreignDocument,
      pdf: { sha256: next.sha256, page: 1, rects: [[0, 0, 20, 10]] },
      manage: (request: unknown) =>
        executeMaintenance(f.app, "marks", { operation: "place", request }),
      list: async () =>
        (await f.app.marks.query({
          operation: "list",
          request: { literature_id: paper },
        })) as { items: ReadingMark[] },
      close: async () => {
        db.close();
        await f.close();
      },
    };
  } catch (error) {
    database?.close();
    await f.close();
    throw error;
  }
}

it("records and replaces relocation caches without rewriting anchors or literature facts, bounds targets and preserves exports", async () => {
  const e = await relocationFixture(true);
  try {
    const { organizationRows } = await import(
      "./user-organization-schema-fixture.js"
    );
    const snapshot = () => {
      const rows = organizationRows(e.db);
      delete rows.reading_marks;
      delete rows.operation_records;
      return rows;
    };
    const originalRow = e.db
      .prepare("SELECT * FROM reading_marks WHERE mark_id=?")
      .get(e.original.mark_id);
    // Synthetic current/stale result closures, without invoking a processor.
    for (const state of ["current", "stale"]) {
      const id = `relocation-result-${state}`,
        path = `results/${id}.json`,
        bytes = Buffer.from(JSON.stringify({ synthetic: state })),
        hash = await sha256(bytes);
      const stage = await e.f.app.files.stage({ maxBytes: bytes.length });
      try {
        await stage.write(bytes);
        await e.f.app.files.publish(stage, path);
      } finally {
        await stage.discard();
      }
      e.db
        .prepare(
          "INSERT INTO artifact_objects VALUES(?,?,?,'application/json',?)",
        )
        .run(randomUUID(), hash, bytes.length, path);
      e.db
        .prepare(
          "INSERT INTO processor_results VALUES(?,?, 'synthetic','1',1,'external',?,?,?,'application/json',?)",
        )
        .run(id, hash, path, hash, bytes.length, "2026-11-16T00:00:00Z");
      e.db
        .prepare("INSERT INTO processor_result_freshness VALUES(?,?)")
        .run(id, state);
      e.db
        .prepare("INSERT INTO processor_result_summaries VALUES(?,NULL,'[]',?)")
        .run(id, PROCESSOR_METHOD_REVISION);
      e.db
        .prepare("INSERT INTO processor_result_literatures VALUES(?,?)")
        .run(id, paper);
      e.db
        .prepare(
          "INSERT INTO processor_result_documents SELECT ?,literature_id,source_asset_id,source_sha256,document_version_id,representation_sha256 FROM document_versions WHERE document_version_id=?",
        )
        .run(id, e.document.document_version_id);
    }
    const freshness = e.db
      .prepare("SELECT * FROM processor_result_currentness ORDER BY result_id")
      .all();
    expect(freshness.map((row) => row.state)).toEqual(["current", "stale"]);
    const before = snapshot();
    const markdown = await e.f.app.marks.query({
      operation: "export",
      request: { literature_id: paper, format: "markdown" },
    });
    const base = {
      mark_id: e.original.mark_id,
      similarity: 0.85,
      method: MARK_LOCATE_METHOD,
    };
    await e.manage({ ...base, target: { pdf: e.pdf } });
    await e.manage({
      ...base,
      target: { document: e.document },
      similarity: 0.7,
    });
    const changedPdf = { ...e.pdf, rects: [[1, 2, 30, 12]] };
    const replaced = parseReadingMark(
      await e.manage({ ...base, target: { pdf: changedPdf }, similarity: 1 }),
    );
    expect(replaced.places).toHaveLength(2);
    expect(replaced.places.find((p) => "pdf" in p.target)).toMatchObject({
      target: { pdf: changedPdf },
      similarity: 1,
      method: MARK_LOCATE_METHOD,
      located_at: expect.any(String),
    });
    expect(
      e.db
        .prepare(
          "SELECT count(*) n FROM reading_mark_places WHERE mark_id=? AND target_id=?",
        )
        .get(base.mark_id, e.next.sha256)!.n,
    ).toBe(1);
    expect(
      e.db
        .prepare("SELECT * FROM reading_marks WHERE mark_id=?")
        .get(base.mark_id),
    ).toEqual(originalRow);
    expect({ ...replaced, places: [] }).toEqual(e.original);
    const invalid = [
      { pdf: { ...e.pdf, sha256: e.foreignPdf.sha256 } },
      { document: e.foreignDocument },
      { pdf: { ...e.pdf, sha256: e.supplement.sha256 } },
      { document: e.supplementDocument },
      { pdf: { ...e.pdf, page: 2 } },
      { document: { ...e.document, end_utf8: 1_000_000 } },
    ];
    for (const target of invalid)
      await expect(e.manage({ ...base, target })).rejects.toMatchObject({
        code: "mark-anchor-invalid",
      });
    for (const similarity of [0.69, 1.01, NaN, Infinity])
      await expect(
        e.manage({ ...base, target: { pdf: e.pdf }, similarity }),
      ).rejects.toMatchObject({ code: "invalid-contract" });
    for (const target of [
      {},
      { pdf: e.pdf, document: e.document },
      { pdf: { ...e.pdf, rects: [] } },
    ])
      expect(() =>
        parseMarkOperation({
          operation: "place",
          request: { ...base, target },
        }),
      ).toThrow();
    await e.manage({
      ...base,
      target: { pdf: e.pdf },
      method: "mark-locate-v0",
    });
    const listed = await e.list();
    expect(listed.items.map(parseReadingMark)[0]!.places).toEqual([
      expect.objectContaining({
        target: { document: e.document },
        similarity: 0.7,
      }),
    ]);
    await e.manage({ ...base, target: { pdf: changedPdf }, similarity: 1 });
    const exported = (await e.f.app.marks.query({
      operation: "export",
      request: { literature_id: paper, format: "json" },
    })) as { content: string };
    expect(JSON.parse(exported.content).items.map(parseReadingMark)).toEqual(
      (await e.list()).items,
    );
    expect(
      await e.f.app.marks.query({
        operation: "export",
        request: { literature_id: paper, format: "markdown" },
      }),
    ).toEqual(markdown);
    await e.manage({
      ...base,
      mark_id: e.pdfOnly!.mark_id,
      target: { pdf: e.pdf },
    });
    expect(
      e.db
        .prepare("SELECT count(*) n FROM reading_mark_places WHERE mark_id=?")
        .get(e.pdfOnly!.mark_id)!.n,
    ).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(
      e.db
        .prepare(
          "SELECT * FROM processor_result_currentness ORDER BY result_id",
        )
        .all(),
    ).toEqual(freshness);
    expect(e.f.modelCalls).toBe(0);
    const audit = JSON.stringify(
      e.db
        .prepare(
          "SELECT scope_json,result_json FROM operation_records WHERE operation='marks'",
        )
        .all(),
    );
    expect(audit).toContain(base.mark_id);
    expect(audit).not.toContain("Original note");
    expect(audit).not.toContain("rects");
    // Each supplementary material is a separate part, including for text-only anchors.
    const supplementary = await e.f.app.marks.manage({
      operation: "create",
      request: {
        literature_id: paper,
        kind: "highlight",
        color: "yellow",
        quote: "words",
        document: e.supplementDocument,
      },
    });
    await expect(
      e.manage({
        ...base,
        mark_id: supplementary.mark_id,
        target: { pdf: { ...e.pdf, sha256: e.otherSupplement.sha256 } },
      }),
    ).rejects.toMatchObject({ code: "mark-anchor-invalid" });
    await e.manage({
      ...base,
      mark_id: supplementary.mark_id,
      target: { pdf: { ...e.pdf, sha256: e.supplement.sha256 } },
    });
    const pdfSupplement = await e.f.app.marks.manage({
      operation: "create",
      request: {
        literature_id: paper,
        kind: "highlight",
        color: "green",
        quote: "Supplement quote",
        pdf: { ...e.pdf, sha256: e.supplement.sha256 },
      },
    });
    await e.manage({
      ...base,
      mark_id: pdfSupplement.mark_id,
      target: { document: e.supplementDocument },
    });
    await expect(
      e.manage({
        ...base,
        mark_id: pdfSupplement.mark_id,
        target: { pdf: { ...e.pdf, sha256: e.otherSupplement.sha256 } },
      }),
    ).rejects.toMatchObject({ code: "mark-anchor-invalid" });
    const region = await e.f.app.marks.manage({
      operation: "create",
      request: {
        literature_id: paper,
        kind: "region",
        color: "red",
        pdf: { ...e.pdf, sha256: e.supplement.sha256 },
      },
    });
    for (const target of [{ document: e.supplementDocument }, { pdf: e.pdf }])
      await expect(
        e.manage({ ...base, mark_id: region.mark_id, target }),
      ).rejects.toMatchObject({ code: "mark-anchor-invalid" });
    await e.f.app.marks.manage({
      operation: "delete",
      request: { mark_id: base.mark_id },
    });
    await expect(
      e.manage({ ...base, target: { pdf: e.pdf } }),
    ).rejects.toMatchObject({ code: "mark-deleted" });
    e.db
      .prepare("UPDATE reading_marks SET deleted_at=? WHERE mark_id=?")
      .run(new Date(Date.now() - 31 * 86400000).toISOString(), base.mark_id);
    await e.f.app.marks.manage({
      operation: "update",
      request: { mark_id: region.mark_id, note: "trigger retention" },
    });
    expect(
      e.db
        .prepare("SELECT 1 FROM reading_marks WHERE mark_id=?")
        .get(base.mark_id),
    ).toBeUndefined();
    expect(
      e.db
        .prepare("SELECT * FROM reading_mark_places WHERE mark_id=?")
        .all(base.mark_id),
    ).toEqual([]);
    expect(e.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    await e.close();
  }
}, 90000);

it("shares place writes, complete lists and JSON exports across Web, CLI, actual stdio and HTTP MCP with independent device purposes", async () => {
  const e = await relocationFixture(),
    q = await createQueryApplication(e.f.home),
    screen = new ProductionWorkbenchSession(null, undefined);
  const web = await startWorkbenchHttp({
    session: screen,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
    devices: {
      service: e.f.app.deviceConnections,
      routes: deviceBusinessRoutes(e.f.app, q),
    },
    query: {
      application: q,
      maintenance: e.f.app.maintenance!,
      archiveOperation: (op, value, signal) =>
        executeMaintenance(e.f.app, op, value, signal),
    },
  });
  const entry = new URL("../dist/cli/main.js", import.meta.url).href;
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      `import {runCli} from ${JSON.stringify(entry)}; process.exitCode=(await runCli(['mcp','--maintenance'],{home:process.argv[1]})).code;`,
      e.f.home,
    ],
    stderr: "pipe",
  });
  const local = new Client({ name: "relocation-stdio", version: "1" }),
    remotes: { client: Client; transport: StreamableHTTPClientTransport }[] =
      [];
  const connect = async (purposes: ("read" | "operate" | "intake")[]) => {
    const pairing = await e.f.app.deviceConnections.create({
      address: web.origin,
      name: "Synthetic relocation",
      purposes,
    });
    const paired = await e.f.app.deviceConnections.exchange(
      {
        pairing_code: parseDeviceConnectionCode(pairing.connection_code)
          .pairing_code,
      },
      "synthetic-peer",
    );
    if (purposes[0] === "intake") return { paired, client: null };
    const transport = new StreamableHTTPClientTransport(
        new URL("/mcp", web.origin),
        {
          requestInit: { headers: { Authorization: `Bearer ${paired.token}` } },
        },
      ),
      client = new Client({ name: "relocation-http", version: "1" });
    client.onerror = () => {};
    remotes.push({ client, transport });
    await client.connect(new SdkTransportAdapter(transport));
    return { paired, client };
  };
  const base = {
    mark_id: e.original.mark_id,
    similarity: 0.9,
    method: MARK_LOCATE_METHOD,
  };
  async function* stdin(value: unknown) {
    yield Buffer.from(JSON.stringify(value));
  }
  try {
    const login = await workbenchLogin(web.origin),
      landing = await fetch(web.origin, { headers: { Cookie: login } }),
      cookies = `${login}; ${landing.headers.get("set-cookie")!.split(";")[0]!}`;
    const grant = await fetch(web.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookies,
        Origin: web.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const access = (await grant.json()) as { client_id: string; csrf: string };
    const post = (kind: string, request: unknown, csrf = access.csrf) =>
      fetch(
        `${web.origin}/api/v1/${kind}/marks?client_id=${access.client_id}`,
        {
          method: "POST",
          headers: {
            Cookie: cookies,
            Origin: web.origin,
            "Content-Type": "application/json",
            "X-Workbench-CSRF": csrf,
            "X-SciRetriever-Protocol-Version": "1",
          },
          body: JSON.stringify({ protocol_version: 1, request }),
        },
      );
    const envelope = {
      operation: "place",
      request: { ...base, target: { pdf: e.pdf } },
    };
    const webWrite = await post("maintenance", envelope);
    expect(webWrite.status).toBe(200);
    expect(await webWrite.json()).toEqual({
      protocol_version: 1,
      result: (await e.list()).items[0],
    });
    const cliWrite = await runCli(
      ["marks", "place", "--request", "-", "--json"],
      { home: e.f.home, stdin: stdin(envelope.request) },
    );
    expect(cliWrite.code).toBe(0);
    expect(cliWrite.value).toEqual((await e.list()).items[0]);
    await local.connect(stdio);
    const textEnvelope = {
      operation: "place",
      request: { ...base, target: { document: e.document } },
    };
    const stdioWrite = await local.callTool({
      name: "marks_manage",
      arguments: textEnvelope,
    });
    expect(stdioWrite.isError).not.toBe(true);
    expect(stdioWrite.structuredContent).toEqual({
      protocol_version: 1,
      result: (await e.list()).items[0],
    });
    const both = await connect(["read", "operate"]),
      reader = await connect(["read"]),
      operator = await connect(["operate"]);
    expect(
      (await reader.client!.listTools()).tools.some(
        (t) => t.name === "marks_manage",
      ),
    ).toBe(false);
    const denied = await reader.client!.callTool({
      name: "marks_manage",
      arguments: textEnvelope,
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      result: { failure: { code: "device-purpose-forbidden" } },
    });
    expect(
      (await operator.client!.listTools()).tools.some(
        (t) => t.name === "marks_query",
      ),
    ).toBe(false);
    const deniedRead = await operator.client!.callTool({
      name: "marks_query",
      arguments: { operation: "list", request: { literature_id: paper } },
    });
    expect(deniedRead.isError).toBe(true);
    expect(deniedRead.structuredContent).toMatchObject({
      result: { failure: { code: "device-purpose-forbidden" } },
    });
    const remoteWrite = await operator.client!.callTool({
      name: "marks_manage",
      arguments: textEnvelope,
    });
    expect(remoteWrite.isError).not.toBe(true);
    expect(remoteWrite.structuredContent).toEqual({
      protocol_version: 1,
      result: (await e.list()).items[0],
    });
    const final = await e.list();
    expect(final.items[0]!.places).toHaveLength(2);
    for (const operation of ["list", "export"] as const) {
      const request = {
        literature_id: paper,
        ...(operation === "export" ? { format: "json" } : {}),
      };
      const cli = await runCli(
        ["marks", operation, "--request", "-", "--json"],
        { home: e.f.home, stdin: stdin(request) },
      );
      expect(cli.code).toBe(0);
      expect(
        await (await post("query", { operation, request })).json(),
      ).toEqual({ protocol_version: 1, result: cli.value });
      for (const client of [local, both.client!, reader.client!]) {
        const result = await client.callTool({
          name: "marks_query",
          arguments: { operation, request },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
          protocol_version: 1,
          result: cli.value,
        });
      }
      if (operation === "export")
        expect(
          JSON.parse((cli.value as { content: string }).content).items.map(
            parseReadingMark,
          ),
        ).toEqual(final.items);
      else expect(cli.value).toEqual(final);
    }
    expect((await post("maintenance", envelope, "invalid")).status).toBe(403);
    const intake = await connect(["intake"]);
    expect(
      (
        await fetch(web.origin + "/mcp", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${intake.paired.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "fixture", version: "1" },
            },
          }),
        })
      ).status,
    ).toBe(403);
    for (const kind of ["query", "maintenance"]) {
      const response = await fetch(`${web.origin}/api/v1/${kind}/marks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${both.paired.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ protocol_version: 1, request: envelope }),
      });
      expect(response.status).toBe(403);
    }
    expect(e.f.modelCalls).toBe(0);
  } finally {
    await local.close();
    await stdio.close();
    for (const remote of remotes) {
      await remote.client.close();
      await remote.transport.close();
    }
    await web.close();
    await screen.close();
    await q.close();
    await e.close();
  }
}, 90000);
