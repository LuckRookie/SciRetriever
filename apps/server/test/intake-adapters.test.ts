import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import {
  parseIntakeBatchPage,
  parseLiterature,
  parseLibrarySearchRequest,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { startIntake, finishIntake } from "../src/literature/intake.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
it("shares batch, facets, preview and rename shapes over HTTP, CLI and MCP without starting external work", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-parity-")),
    app = await createApplication(home);
  const batch = await startIntake(
      app.database,
      "topic",
      "scope",
      { query: "scope" },
      "cli",
    ),
    id = randomUUID();
  await app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: id,
      meta_literature_id: randomUUID(),
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        keywords: ["Energy"],
        subject_terms: ["Physics"],
      },
    }),
  );
  await app.database.writeIntake({
    operation: "member",
    member: { batch_id: batch, literature_id: id, disposition: "created" },
  });
  await finishIntake(app.database, batch, "completed");
  const queryApp = await createQueryApplication(home);
  const http = await startQueryOnlyHttp({
    application: queryApp,
    maintenance: {
      ingestPdf: app.maintenance!.ingestPdf,
      parseDocuments: app.maintenance!.parseDocuments,
    },
    archiveOperation: (op, request, signal) =>
      import("../src/entry/maintenance-operations.js").then((m) =>
        m.executeMaintenance(app, op, request, signal),
      ),
  });
  const host = createMcpServer({
    home,
    maintenance: true,
    queryFactory: () => createQueryApplication(home),
    applicationFactory: async () => app,
  });
  const [server, clientTransport] = InMemoryTransport.createLinkedPair(),
    client = new Client({ name: "intake-test", version: "1" });
  const readonlyHost = createMcpServer({
      home,
      queryFactory: () => createQueryApplication(home),
    }),
    [readonlyServer, readonlyTransport] = InMemoryTransport.createLinkedPair(),
    readonlyClient = new Client({ name: "intake-reader-test", version: "1" });
  const input = async function* (value: unknown) {
    yield Buffer.from(JSON.stringify(value));
  };
  const cli = async (args: string[], request: unknown) => {
    const r = await runCli([...args, "--request", "-", "--json"], {
      home,
      stdin: input(request),
    });
    expect(r.code).toBe(0);
    return (r.value as { result: unknown }).result;
  };
  const web = async (operation: string, request: unknown) => {
    const r = await fetch(`${http.origin}/api/v1/query/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol_version: 1, request }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { result: unknown }).result;
  };
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, JSON.stringify(r)).not.toBe(true);
    return (r.structuredContent as { result: unknown }).result;
  };
  try {
    await host.connect(server);
    await client.connect(clientTransport);
    await readonlyHost.connect(readonlyServer);
    await readonlyClient.connect(readonlyTransport);
    expect(
      (await readonlyClient.listTools()).tools.map((tool) => tool.name),
    ).not.toContain("intake_batch_rename");
    for (const [operation, args, tool, request, mcpRequest] of [
      [
        "intake-batches",
        ["library", "batches"],
        "intake_batches",
        { operation: "list", request: {} },
        true,
      ],
      [
        "library-facets",
        ["library", "facets"],
        "library_facets",
        { query: { intake_batch_ids: [batch] }, limit: 10 },
        false,
      ],
      [
        "acquire-pdf-preview",
        ["acquire-pdf", "preview"],
        "acquire_pdf_preview",
        {
          selector: {
            kind: "query",
            query: parseLibrarySearchRequest({
              query: { intake_batch_ids: [batch] },
            }).query,
            sort: "title-asc",
            limit: 1,
          },
        },
        false,
      ],
    ] as const) {
      const expected = await web(operation, request);
      expect(await cli([...args], request)).toEqual(expected);
      expect(
        await mcp(tool, mcpRequest ? { request } : { ...request }),
      ).toEqual(expected);
      const readonlyResult = await readonlyClient.callTool({
        name: tool,
        arguments: mcpRequest ? { request } : { ...request },
      });
      expect(readonlyResult.isError, JSON.stringify(readonlyResult)).not.toBe(
        true,
      );
      expect(
        (readonlyResult.structuredContent as { result: unknown }).result,
      ).toEqual(expected);
    }
    const changed = await mcp("intake_batch_rename", {
      batch_id: batch,
      label: "Renamed",
    });
    expect(changed).toMatchObject({ label: "Renamed", renamed: true });
    expect(
      await cli(["library", "batch-rename"], { batch_id: batch, label: null }),
    ).toMatchObject({ label: "scope", renamed: false });
    const denied = await fetch(
      `${http.origin}/api/v1/maintenance/intake-batch-rename`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: { batch_id: batch, label: "forbidden" },
        }),
      },
    );
    expect(denied.status).toBe(403);
    expect(
      parseIntakeBatchPage(
        await app.library.intakeBatches({ operation: "list", request: {} }),
      ).items[0]?.label,
    ).toBe("scope");
  } finally {
    await readonlyClient.close();
    await readonlyHost.close();
    await client.close();
    await host.close();
    await http.close();
    await queryApp.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
