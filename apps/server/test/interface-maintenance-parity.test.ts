import { processorFixture } from "./processor-fixture.js";
import {
  EXTRACTION_SCHEMA_URI,
  extractionSpecHash,
  parseDocumentReceipt,
  parseDatabaseCompletionReport,
} from "@sciretriever/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import * as applicationBootstrap from "../src/bootstrap/application.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { taskHttpAdapters } from "../src/bootstrap/workbench.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import {
  factId,
  proofreadFactsFixture,
} from "./draft-proofread-facts-fixture.js";

async function* stdin(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}
async function connect(host: ReturnType<typeof createMcpServer>) {
  const [server, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "interface-parity", version: "1" });
  await host.connect(server);
  await client.connect(transport);
  return client;
}
describe("machine interfaces over shared maintenance owners", () => {
  it("returns identical draft facts, filters, ordered cursors, part defaults and archive state over CLI, authenticated Web and MCP", async () => {
    const e = await proofreadFactsFixture(),
      query = await createQueryApplication(e.f.e.home),
      screen = new ProductionWorkbenchSession(null, undefined);
    let web: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined,
      host: ReturnType<typeof createMcpServer> | undefined,
      client: Client | undefined;
    try {
      const b = await e.paper(2, "draft", {
        differs_segments: 2,
        differences: 4,
        image_only_pages: 1,
      });
      await e.paper(3, "draft", {
        differs_segments: 2,
        differences: 3,
        image_only_pages: 1,
      });
      await e.paper(4, "proofread");
      const result = e.result(1, [b.vid!]);
      e.unfound(result, b.vid!, "/value");
      web = await startWorkbenchHttp({
        session: screen,
        access: workbenchTestAccess,
        assets: new Map([
          ["/", { contentType: "text/html", body: "synthetic" }],
        ]),
        query: { application: query },
      });
      host = createMcpServer({
        home: e.f.e.home,
        sharedApplications: true,
        queryFactory: async () => query,
      });
      client = await connect(host);
      const login = await workbenchLogin(web.origin),
        landing = await fetch(web.origin, { headers: { Cookie: login } }),
        cookies = `${login}; ${landing.headers.get("set-cookie")!.split(";")[0]!}`,
        grant = await fetch(web.origin + "/api/clients", {
          method: "POST",
          headers: {
            Cookie: cookies,
            Origin: web.origin,
            "Content-Type": "application/json",
            "X-Workbench-Init": "1",
          },
          body: "{}",
        }),
        access = (await grant.json()) as { client_id: string; csrf: string };
      const post = async (path: string, request: unknown) => {
        const response = await fetch(
          `${web!.origin}/api/v1/query/${path}?client_id=${access.client_id}`,
          {
            method: "POST",
            headers: {
              Cookie: cookies,
              Origin: web!.origin,
              "Content-Type": "application/json",
              "X-Workbench-CSRF": access.csrf,
              "X-SciRetriever-Protocol-Version": "1",
            },
            body: JSON.stringify({ protocol_version: 1, request }),
          },
        );
        expect(response.status).toBe(200);
        return (await response.json()) as Record<string, unknown>;
      };
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client!.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        return result.structuredContent;
      };
      let cursor: string | null = null;
      const all: string[] = [];
      do {
        const request = {
            query: { text_levels: ["draft"], has_image_only_pages: true },
            sort: "draft-differences-desc",
            limit: 1,
            cursor,
          },
          cli = await runCli(
            ["literature", "search", "--request", "-", "--json"],
            { home: e.f.e.home, stdin: stdin(request) },
          );
        expect(cli.code).toBe(0);
        const page = (
          cli.value as {
            result: {
              next_cursor: string | null;
              items: {
                literature: { literature_id: string };
                draft_facts: unknown;
              }[];
            };
          }
        ).result;
        expect((await post("search", request)).page).toEqual(page);
        expect(await call("search_library", request)).toEqual(cli.value);
        expect(page.items[0]!.draft_facts).toBeTruthy();
        all.push(...page.items.map((row) => row.literature.literature_id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(all).toEqual([factId(2), factId(3)]);
      const input = { literature_id: b.lit },
        cli = await runCli(["literature", "read", "--request", "-", "--json"], {
          home: e.f.e.home,
          stdin: stdin(input),
        });
      expect(cli.code).toBe(0);
      expect((await post("read", input)).detail).toEqual(
        (cli.value as { result: unknown }).result,
      );
      expect(await call("read_literature", input)).toEqual(cli.value);
      expect(cli.value).toMatchObject({
        result: {
          draft_facts: { citing_results: 1, unfound_citations: 1 },
          primary_pdf: {
            default_text: { document_version_id: b.vid, text_level: "draft" },
          },
        },
      });
      const state = await runCli(["archive", "status", b.lit, "--json"], {
        home: e.f.e.home,
      });
      expect(state.code).toBe(0);
      expect(
        await post("archive", { operation: "status", request: input }),
      ).toEqual({ protocol_version: 1, result: state.value });
      expect(
        await call("archive_query", { operation: "status", request: input }),
      ).toEqual({ protocol_version: 1, result: state.value });
    } finally {
      await client?.close();
      await host?.close();
      await web?.close();
      await screen.close();
      await query.close();
      await e.close();
    }
  }, 60_000);
  it("previews and starts the same frozen draft task through CLI, authenticated Web and shared MCP", async () => {
    const env = await coreProcessingFixture({ offline: true });
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined,
      web: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined,
      host: ReturnType<typeof createMcpServer> | undefined,
      client: Client | undefined;
    const screen = new ProductionWorkbenchSession(null, undefined);
    try {
      await env.app.rawParsing!.parseAsset(
        env.asset.asset_id,
        ["vlm-engine"],
        undefined,
        { expected_sha256: env.asset.sha256, force: false },
      );
      const parses = env.parseCalls,
        calls = env.modelCalls;
      query = await createQueryApplication(env.home);
      web = await startWorkbenchHttp({
        ...taskHttpAdapters(env.app),
        session: screen,
        access: workbenchTestAccess,
        assets: new Map([
          ["/", { contentType: "text/html", body: "synthetic" }],
        ]),
        query: {
          application: query,
          maintenance: env.app.maintenance!,
          archiveOperation: (op, value, signal) =>
            executeMaintenance(env.app, op, value, signal),
        },
      });
      host = createMcpServer({
        home: env.home,
        maintenance: true,
        sharedApplications: true,
        applicationFactory: async () => env.app,
        queryFactory: async () => query!,
      });
      client = await connect(host);
      const login = await workbenchLogin(web.origin),
        landing = await fetch(web.origin, { headers: { Cookie: login } });
      const cookies = `${login}; ${landing.headers.get("set-cookie")!.split(";")[0]!}`;
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
      const access = (await grant.json()) as {
        client_id: string;
        csrf: string;
      };
      const post = (path: string, request: unknown, csrf = access.csrf) =>
        fetch(`${web!.origin}${path}?client_id=${access.client_id}`, {
          method: "POST",
          headers: {
            Cookie: cookies,
            Origin: web!.origin,
            "Content-Type": "application/json",
            "X-Workbench-CSRF": csrf,
            "X-SciRetriever-Protocol-Version": "1",
          },
          body: JSON.stringify({ protocol_version: 1, request }),
        });
      const preview = {
        selector: {
          kind: "literatures",
          literature_ids: [env.parseRequest.literature_id],
        },
      };
      const cliPreview = await runCli(
        ["form-drafts", "preview", "--request", "-", "--json"],
        { home: env.home, stdin: stdin(preview) },
      );
      expect(cliPreview.code).toBe(0);
      const httpPreview = await post(
        "/api/v1/query/form-drafts-preview",
        preview,
      );
      expect(httpPreview.status).toBe(200);
      expect(await httpPreview.json()).toEqual(cliPreview.value);
      const mcpPreview = await client.callTool({
        name: "form_drafts_preview",
        arguments: preview,
      });
      expect(mcpPreview.isError).not.toBe(true);
      expect(mcpPreview.structuredContent).toEqual(cliPreview.value);
      const request = { ...preview, idempotency_key: "drafts-three-ports" };
      // Reuse the real production graph and its fake external page port. Only
      // CLI ownership of this shared fixture's lifetime is suppressed.
      const factory = vi
        .spyOn(applicationBootstrap, "createApplication")
        .mockResolvedValueOnce({ ...env.app, close: async () => {} });
      let cli;
      try {
        cli = await runCli(
          ["form-drafts", "start", "--request", "-", "--json"],
          { home: env.home, stdin: stdin(request) },
        );
      } finally {
        factory.mockRestore();
      }
      expect(cli.code).toBe(0);
      const created = (
        cli.value as { result: { job_id: string; selector: unknown } }
      ).result;
      expect((await env.app.jobs!.getJob(created.job_id))!.status).toBe(
        "completed",
      );
      const httpCreated = await post(
        "/api/v1/maintenance/form-drafts",
        request,
      );
      expect(httpCreated.status).toBe(200);
      expect(await httpCreated.json()).toMatchObject({
        result: { job_id: created.job_id, selector: created.selector },
      });
      const mcpCreated = await client.callTool({
        name: "form_drafts",
        arguments: request,
      });
      expect(mcpCreated.isError).not.toBe(true);
      expect(mcpCreated.structuredContent).toMatchObject({
        result: { job_id: created.job_id, selector: created.selector },
      });
      const taskRequest = { job_id: created.job_id };
      const cliTask = await runCli(
        ["jobs", "inspect", "--request", "-", "--json"],
        { home: env.home, stdin: stdin(taskRequest) },
      );
      expect(cliTask.code).toBe(0);
      const webTask = await fetch(
        `${web.origin}/api/tasks/${created.job_id}?client_id=${access.client_id}`,
        { headers: { Cookie: cookies, Origin: web.origin } },
      );
      expect(webTask.status).toBe(200);
      const cliRead = (
        cliTask.value as { result: { scope: unknown; results: unknown } }
      ).result;
      expect(await webTask.json()).toMatchObject({
        task: { scope: cliRead.scope, results: cliRead.results },
      });
      const mcpTask = await client.callTool({
        name: "inspect_task",
        arguments: taskRequest,
      });
      expect(mcpTask.isError).not.toBe(true);
      expect(mcpTask.structuredContent).toEqual(cliTask.value);
      expect(cliTask.value).toMatchObject({
        result: {
          results: [
            {
              result: { parts: [{ status: "formed", default_changed: true }] },
            },
          ],
        },
      });
      expect(
        (await post("/api/v1/maintenance/form-drafts", request, "wrong"))
          .status,
      ).toBe(403);
      expect(
        (
          await fetch(web.origin + "/api/v1/query/form-drafts-preview", {
            method: "POST",
            headers: { Origin: web.origin, "Content-Type": "application/json" },
            body: JSON.stringify({ protocol_version: 1, request: preview }),
          })
        ).status,
      ).toBe(401);
      expect(env.parseCalls).toBe(parses);
      expect(env.modelCalls).toBe(calls);
    } finally {
      vi.restoreAllMocks();
      await client?.close();
      await host?.close();
      await web?.close();
      await screen.close();
      await query?.close();
      await env.close();
    }
  }, 60_000);
  it.each([false, true])(
    "prints the complete parser report with its unmodified receipt (draft failure: %s)",
    async (failDraft) => {
      const env = await coreProcessingFixture({
        offline: true,
        ...(failDraft
          ? {
              textLayer: () => {
                throw new Error("Synthetic page tools unavailable");
              },
            }
          : {}),
      });
      const parse = vi.spyOn(env.app.documentProcessing, "parseDocuments");
      const factory = vi
        .spyOn(applicationBootstrap, "createApplication")
        .mockResolvedValueOnce(env.app);
      try {
        const cli = await runCli(
          [
            "complete",
            "parser",
            "--literature-id",
            env.parseRequest.literature_id,
            "--json",
          ],
          { home: env.home },
        );
        expect(cli.code).toBe(0);
        const report = parseDatabaseCompletionReport(cli.value);
        expect(report.completed).toHaveLength(1);
        expect(report.failed).toEqual([]);
        expect(parse).toHaveBeenCalledOnce();
        expect(report.completed[0]!.receipt).toEqual(
          await parse.mock.results[0]!.value,
        );
        expect(report.completed[0]!.receipt!.draft.status).toBe(
          failDraft ? "failed" : "formed",
        );
        expect(env.modelCalls).toBe(0);
      } finally {
        factory.mockRestore();
        parse.mockRestore();
        await env.close();
      }
    },
    30_000,
  );
  it("returns the same verified draft receipt through CLI, HTTP, MCP and durable processing results", async () => {
    const env = await coreProcessingFixture({ offline: true });
    const input = { ...env.rawParseRequest, profiles: ["vlm-engine"] };
    try {
      expect(
        (await env.app.documentProcessing.parseDocuments(input)).draft.status,
      ).toBe("formed");
      // Supply the real graph, with fake external parser/page ports, to the CLI
      // lifecycle. No processing, publication or serialization is replaced.
      const factory = vi
        .spyOn(applicationBootstrap, "createApplication")
        .mockResolvedValueOnce(env.app);
      let cli;
      try {
        cli = await runCli(
          [
            "document",
            "parse",
            "--literature-id",
            input.literature_id,
            "--asset-id",
            input.asset_id,
            "--asset-sha256",
            input.asset_sha256,
            "--profiles",
            "vlm-engine",
            "--json",
          ],
          { home: env.home },
        );
      } finally {
        factory.mockRestore();
      }
      expect(cli.code).toBe(0);
      const expected = parseDocumentReceipt(cli.value);
      expect(expected.draft).toMatchObject({
        status: "reused",
        default_text_level: "draft",
        default_changed: false,
      });
      await env.reopen();
      const query = await createQueryApplication(env.home);
      const web = await startQueryOnlyHttp({
        application: query,
        maintenance: env.app.maintenance!,
        assets: new Map([
          ["/", { contentType: "text/html", body: "synthetic" }],
        ]),
      });
      const host = createMcpServer({
        home: env.home,
        maintenance: true,
        applicationFactory: async () => env.app,
        queryFactory: () => createQueryApplication(env.home),
      });
      const client = await connect(host);
      try {
        const landing = await fetch(web.origin);
        const cookie = landing.headers
          .getSetCookie()
          .map((c) => c.split(";")[0]!)
          .join("; ");
        const access = await fetch(web.origin + "/api/v1/maintenance/session", {
          headers: { Cookie: cookie },
        });
        const { csrf } = (await access.json()) as { csrf: string };
        const response = await fetch(
          web.origin + "/api/v1/maintenance/parse-document",
          {
            method: "POST",
            headers: {
              Origin: web.origin,
              Cookie: cookie,
              "Content-Type": "application/json",
              "X-Sciretriever-CSRF": csrf,
              "X-Sciretriever-Protocol-Version": "1",
            },
            body: JSON.stringify(input),
          },
        );
        expect(response.status).toBe(200);
        expect(
          parseDocumentReceipt(
            ((await response.json()) as { receipt: unknown }).receipt,
          ),
        ).toEqual(expected);
        const submitted = await client.callTool({
          name: "submit_processing",
          arguments: {
            schema_version: 1,
            idempotency_key: "draft-receipt-parity",
            operations: [{ operation: "parse-documents", request: input }],
          },
        });
        expect(submitted.isError).not.toBe(true);
        const { job_id } = (
          submitted.structuredContent as { result: { job_id: string } }
        ).result;
        await vi.waitFor(
          async () =>
            expect(
              (await env.app.processingTasks!.read(job_id)).job.status,
            ).toBe("completed"),
          { timeout: 30_000 },
        );
        const read = await client.callTool({
          name: "read_task",
          arguments: { job_id },
        });
        expect(read.isError).not.toBe(true);
        const results = (
          read.structuredContent as {
            result: { results: { result: unknown }[] };
          }
        ).result.results;
        expect(results).toHaveLength(1);
        expect(parseDocumentReceipt(results[0]!.result)).toEqual(expected);
        await host.close();
        await env.reopen();
        expect((await env.app.processingTasks!.read(job_id)).results).toEqual(
          results,
        );
        expect(env.modelCalls).toBe(0);
        expect(env.parseCalls).toBe(1);
      } finally {
        await client.close();
        await host.close();
        await web.close();
        await query.close();
      }
    } finally {
      vi.restoreAllMocks();
      await env.close();
    }
  }, 60_000);
  it("imports from MCP, reads through CLI/Web, and exposes saved task scope and policy without implicit execution", async () => {
    const env = await coreProcessingFixture();
    const host = createMcpServer({
      home: env.home,
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connect(host);
    const query = await createQueryApplication(env.home);
    const web = await startQueryOnlyHttp({ application: query });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      await call("import_bibliography", {
        format: "bibtex",
        content:
          "@article{fixture,title={A newly imported parity article},author={Tester, Agent},year={2026},doi={10.5555/parity-import}}",
      });
      const request = {
        query: {
          identifiers: [{ namespace: "doi", value: "10.5555/parity-import" }],
        },
        limit: 10,
        cursor: null,
        sort: "title-asc",
      };
      const cli = await runCli(
        ["literature", "search", "--request", "-", "--json"],
        { home: env.home, stdin: stdin(request) },
      );
      expect(cli.code).toBe(0);
      expect(cli.value).toMatchObject({ result: { total_count: 1 } });
      const response = await fetch(web.origin + "/api/v1/query/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { page: unknown }).page).toEqual(
        (cli.value as { result: unknown }).result,
      );
      const task = await call("create_task", {
        request: {
          kind: "processing",
          request: {
            schema_version: 1,
            idempotency_key: "parity-saved-task",
            operations: [
              { operation: "parse-documents", request: env.rawParseRequest },
            ],
          },
        },
      });
      expect(env.parseCalls).toBe(0);
      const listed = await call("list_tasks", {
        status_group: "active",
        limit: 1,
      });
      expect(listed.tasks).toMatchObject([
        {
          job_id: task.job_id,
          status: "queued",
          progress: { total: 1, done: 0 },
        },
      ]);
      const cliList = await runCli(["jobs", "list", "--request", "-"], {
        home: env.home,
        stdin: stdin({ status_group: "active", limit: 1 }),
      });
      expect(cliList.code).toBe(0);
      expect(cliList.value).toEqual({ protocol_version: 1, result: listed });
      const detail = await call("inspect_task", { job_id: task.job_id });
      const inspected = await runCli(["jobs", "inspect", "--request", "-"], {
        home: env.home,
        stdin: stdin({ job_id: task.job_id }),
      });
      expect(inspected.code).toBe(0);
      expect(inspected.value).toEqual({ protocol_version: 1, result: detail });
      expect(detail).toHaveProperty("policy");
      expect(detail).toHaveProperty("events");
      expect(env.parseCalls).toBe(0);
      expect(env.modelCalls).toBe(0);
      const cancelled = await call("control_task", {
        job_id: task.job_id,
        action: "cancel",
      });
      expect(cancelled.job).toMatchObject({ status: "cancelled" });
      expect(
        (
          await client.callTool({
            name: "resolve_intervention",
            arguments: {
              job_id: task.job_id,
              intervention_id: "unrelated",
              resolution: "continue",
            },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await host.close();
      await web.close();
      await query.close();
      await env.close();
    }
  }, 30000);
  it("publishes noninteractive configuration through the same CAS owner, refuses stale edits and never returns credential values", async () => {
    const env = await coreProcessingFixture();
    const owner = new TypeScriptConfigurationOwner(env.home);
    const host = createMcpServer({
      home: env.home,
      maintenance: true,
      configurationOwner: owner,
    });
    const client = await connect(host);
    try {
      const snapshot = await owner.read();
      const configuration = {
        ...snapshot.configuration,
        providers: {
          ...snapshot.configuration.providers,
          "credential-fixture": {
            api: "openai-chat-completions",
            base_url: "https://synthetic.example.invalid/v1",
          },
        },
        sources: {
          ...snapshot.configuration.sources,
          metadata: { ...snapshot.configuration.sources.metadata, limit: 123 },
        },
      };
      const preview = await client.callTool({
        name: "configuration_preview",
        arguments: { baseline: snapshot.revision, configuration },
      });
      expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
      expect((await owner.read()).revision).toBe(snapshot.revision);
      const published = await runCli(
        ["config", "publish", "--request", "-", "--json"],
        {
          home: env.home,
          stdin: stdin({
            baseline: snapshot.revision,
            configuration,
            sections: ["sources", "providers"],
          }),
        },
      );
      expect(published.code, JSON.stringify(published)).toBe(0);
      expect((await owner.read()).configuration.sources.metadata.limit).toBe(
        123,
      );
      const stale = await client.callTool({
        name: "configuration_publish",
        arguments: {
          baseline: snapshot.revision,
          configuration,
          sections: ["sources", "providers"],
        },
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({
        result: { failure: { code: "configuration-conflict" } },
      });
      const baseline = (await owner.read()).revision;
      const secret = "synthetic-interface-key-not-for-output";
      const edit = {
        namespace: "model",
        target: "credential-fixture",
        kind: "set",
        value: secret,
      };
      const credential = await client.callTool({
        name: "configuration_credential",
        arguments: { baseline, edit },
      });
      expect(credential.isError, JSON.stringify(credential)).not.toBe(true);
      expect(JSON.stringify(credential)).not.toContain(secret);
      const read = await client.callTool({
        name: "configuration_read",
        arguments: {},
      });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).not.toContain(secret);
      const removed = await runCli(["config", "credential", "--request", "-"], {
        home: env.home,
        stdin: stdin({
          baseline,
          edit: {
            namespace: "model",
            target: "credential-fixture",
            kind: "remove",
          },
        }),
      });
      expect(removed.code).toBe(0);
      expect(JSON.stringify(removed)).not.toContain(secret);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  }, 30000);
  it("delivers the same evidence-linked extraction candidates through MCP and CLI with persistent receipts", async () => {
    const env = await processorFixture();
    await env.build(env.parseRequest);
    const setupParseCalls = env.parseCalls;
    const host = createMcpServer({
      home: env.home,
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connect(host);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      const content = {
        schema_version: 1 as const,
        spec_id: "parity.spec",
        spec_version: "1",
        record_meaning: "Synthetic observation",
        output_schema: {
          $schema: EXTRACTION_SCHEMA_URI,
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        field_instructions: [],
        inclusion_rules: [],
        missing_value_rules: [],
        evidence_policy: {
          field_granularity: "file" as const,
          required_pointers: "record-root" as const,
          cross_input_relation: "optional" as const,
        },
        required_capabilities: ["material-file-v1" as const],
      };
      const spec = {
        ...content,
        spec_sha256: await extractionSpecHash(content),
      };
      const prepared = await call("prepare_extraction", {
        request: {
          spec,
          inputs: [
            {
              input_id: "source-1",
              literature_id: env.parseRequest.literature_id,
              asset_id: env.asset.asset_id,
              asset_sha256: env.asset.sha256,
              document_version_id: null,
            },
          ],
        },
      });
      const created = await runCli(["extraction", "create", "--request", "-"], {
        home: env.home,
        stdin: stdin({
          caller_id: "parity.caller",
          spec: prepared.spec,
          manifest: prepared.manifest,
        }),
      });
      expect(created.code).toBe(0);
      const operation = (created.value as { result: { operation_id: string } })
        .result;
      expect(
        await call("read_extraction", { operation_id: operation.operation_id }),
      ).toEqual(operation);
      const material = await env.app.documentRead.materialEvidence({
        literature_id: env.parseRequest.literature_id,
        asset_id: env.asset.asset_id,
      });
      const batch = {
        schema_version: 1,
        operation_id: operation.operation_id,
        submission_key: "parity-key",
        batch_id: "parity-batch",
        records: [
          {
            record_id: "record-1",
            payload: { value: "fixture" },
            field_evidence: [
              {
                pointer: "",
                sources: [
                  { input_id: "source-1", evidence: material.evidence },
                ],
              },
            ],
          },
        ],
        relations: [],
        coverage: [
          {
            input_id: "source-1",
            status: "processed-with-records",
            reason: null,
          },
        ],
        producer: { method_id: "parity", method_version: "1", usage: {} },
      };
      const accepted = await call("submit_extraction", { request: batch });
      const repeated = await runCli(
        ["extraction", "submit", "--request", "-"],
        { home: env.home, stdin: stdin(batch) },
      );
      expect(repeated.code).toBe(0);
      expect(repeated.value).toEqual({ protocol_version: 1, result: accepted });
      const receipt = accepted.receipt as { receipt_id: string };
      expect(
        await call("read_extraction_receipt", {
          receipt_id: receipt.receipt_id,
        }),
      ).toEqual(accepted.receipt);
      const closed = await call("close_extraction", {
        operation_id: operation.operation_id,
      });
      expect(closed.status).toBe("closed");
      const rejected = await runCli(
        ["extraction", "submit", "--request", "-"],
        {
          home: env.home,
          stdin: stdin({
            ...batch,
            submission_key: "after-close",
            batch_id: "after-close",
          }),
        },
      );
      expect(rejected.code).toBe(3);
      expect(env.parseCalls).toBe(setupParseCalls);
      expect(env.modelCalls).toBe(0);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  }, 30000);
  it("keeps configuration writes and maintenance tools unavailable in read-only MCP mode", async () => {
    const env = await coreProcessingFixture();
    const host = createMcpServer({ home: env.home });
    const client = await connect(host);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("configuration_read");
      for (const name of [
        "configuration_publish",
        "configuration_credential",
        "configuration_probe",
        "create_task",
        "import_bibliography",
        "submit_extraction",
      ]) {
        expect(names).not.toContain(name);
        expect((await client.callTool({ name, arguments: {} })).isError).toBe(
          true,
        );
      }
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  });
});
