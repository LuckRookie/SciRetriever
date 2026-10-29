import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseLiterature,
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
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const paper = FIXTURE_LITERATURE.literature_id;

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
