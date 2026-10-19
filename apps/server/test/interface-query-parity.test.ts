import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

async function* input(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}

describe("shared Web, CLI and MCP query operations", () => {
  it("returns the same filtered library, fixed document and knowledge through all three transports without querying external services", async () => {
    const env = await coreProcessingFixture();
    const query = await createQueryApplication(env.home);
    const web = await startQueryOnlyHttp({ application: query });
    const maintenance = vi.fn(async () => env.app);
    const mcp = createMcpServer({
      queryFactory: () => createQueryApplication(env.home),
      applicationFactory: maintenance,
    });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "parity-test", version: "1" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const machine = async (name: string, request: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: request });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      return (reply.structuredContent as { result: unknown }).result;
    };
    const cli = async (args: string[], request: unknown) => {
      const messages: string[] = [];
      const reply = await runCli([...args, "--request", "-", "--json"], {
        home: env.home,
        stdin: input(request),
        stderr: (s) => messages.push(s),
      });
      expect(reply.code, messages.join("\n")).toBe(0);
      return (reply.value as { result: unknown }).result;
    };
    const http = async (
      operation: string,
      request: unknown,
      key = "result",
    ) => {
      const response = await fetch(web.origin + "/api/v1/query/" + operation, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as Record<string, unknown>)[key];
    };
    try {
      const literature_id = env.parseRequest.literature_id;
      const search = {
        query: {
          identifiers: [
            { namespace: "doi", value: "10.5555/synthetic-browser-loop" },
          ],
        },
        sort: "title-asc",
        limit: 1,
        cursor: null,
      };
      // Use the actual fixture identity, including non-text filtering and sorting.
      search.query.identifiers = (
        await env.app.library.detail(literature_id)
      ).literature.metadata.identifiers.map((i) => ({
        namespace: i.namespace,
        value: i.value,
      }));
      const expected = await http("search", search, "page");
      expect(expected).toMatchObject({
        total_count: 1,
        items: [{ literature: { literature_id } }],
      });
      expect(await cli(["literature", "search"], search)).toEqual(expected);
      expect(await machine("search_library", search)).toEqual(expected);
      const miss = {
        ...search,
        query: { title: "nonexistent synthetic title" },
      };
      expect(await machine("search_library", miss)).toMatchObject({
        total_count: 0,
      });
      expect(env.parseCalls).toBe(0);
      expect(env.modelCalls).toBe(0);
      await env.app.documentProcessing.parseDocuments(env.parseRequest);
      const source = {
        literature_id,
        asset_id: env.asset.asset_id,
        asset_sha256: env.asset.sha256,
      };
      const document = await http("document-default", source);
      expect(await cli(["document", "default"], source)).toEqual(document);
      expect(
        await machine("document_read", {
          operation: "default",
          request: source,
        }),
      ).toEqual(document);
      const prepared = (await cli(["analysis", "prepare"], {
        literature_ids: [literature_id],
      })) as { input: unknown };
      expect(
        await machine("prepare_analysis_inputs", {
          literature_ids: [literature_id],
        }),
      ).toEqual(prepared);
      const analyzed = await env.app.knowledgeAnalysis.analyze({
        schema_version: 1,
        input: prepared.input,
        purpose: "overview",
        question: null,
        default_update: { expected_revision: null },
      });
      const selection = { literature_id, limit: 20 };
      const knowledge = await http("knowledge-list", selection);
      expect(knowledge).toMatchObject([
        { artifact_id: analyzed.artifact.artifact_id },
      ]);
      expect(await cli(["knowledge", "list"], selection)).toEqual(knowledge);
      expect(await machine("list_knowledge", selection)).toEqual(knowledge);
      const defaults = { literature_id, purpose: "overview", question: null };
      expect(await cli(["knowledge", "default"], defaults)).toEqual(
        await http("knowledge-default", defaults),
      );
      expect(await machine("default_knowledge", defaults)).toEqual(
        await http("knowledge-default", defaults),
      );
      const syntheses = { manifest_sha256: null, limit: 20 };
      expect(await cli(["synthesis", "list"], syntheses)).toEqual([]);
      expect(await machine("list_syntheses", syntheses)).toEqual(
        await http("synthesis-list", syntheses),
      );
      expect(maintenance).not.toHaveBeenCalled();
      expect(env.parseCalls).toBe(1);
      expect(env.modelCalls).toBe(2);
    } finally {
      await client.close();
      await mcp.close();
      await web.close();
      await query.close();
      await env.close();
    }
  }, 30000);
  it("rejects unknown fields and operations, respects cancellation, and never opens a missing library for read-only calls", async () => {
    const env = await coreProcessingFixture();
    try {
      expect(
        (
          await runCli(["knowledge", "list", "--request", "-"], {
            home: env.home,
            stdin: input({
              literature_id: env.parseRequest.literature_id,
              limit: 20,
              sql: "forbidden",
            }),
          })
        ).code,
      ).toBe(2);
      expect(
        (
          await runCli(["document", "sql", "--request", "-"], {
            home: env.home,
            stdin: input({}),
          })
        ).code,
      ).toBe(2);
      expect(
        (
          await runCli(["knowledge", "list", "--request", "-"], {
            home: env.home,
            stdin: input({
              literature_id: env.parseRequest.literature_id,
              limit: 20,
            }),
            signal: AbortSignal.abort(),
          })
        ).code,
      ).toBe(130);
      const missing = join(env.home, "uninitialized");
      const status = await runCli(["literature", "status"], { home: missing });
      expect(status.code).toBe(0);
      expect(status.value).toMatchObject({
        result: { status: "not-initialized" },
      });
      await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await env.close();
    }
  });
});
