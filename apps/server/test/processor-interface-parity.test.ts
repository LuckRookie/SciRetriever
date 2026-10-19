import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import {
  parseProcessorInvocation,
  parseProcessorResult,
  parseProcessorTransferChunk,
  processorComparison,
  processorResultBytes,
  sha256,
  type ProcessorTransferFormat,
  type ProcessorTransferRequest,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteProcessorStorage } from "../src/storage/processor-results.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { queryProcessors } from "../src/entry/processor-operations.js";

async function* stdin(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}

it("reassembles results larger than the MCP response budget through HTTP, CLI and MCP, with fixed hashes and complete export envelopes", async () => {
  const env = await coreProcessingFixture();
  const store = new SqliteProcessorStorage(
    env.app.database,
    env.app.files,
    env.app.documentRead,
    env.app.synthesisRead!,
  );
  const query = await createQueryApplication(env.home);
  const web = await startQueryOnlyHttp({ application: query });
  const mcp = createMcpServer({
    queryFactory: () => createQueryApplication(env.home),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "processor-transfer-test", version: "1" });
  await mcp.connect(a);
  await client.connect(b);
  try {
    const material = await env.app.documentRead.materialEvidence({
      literature_id: env.parseRequest.literature_id,
      asset_id: env.asset.asset_id,
    });
    if (material.evidence.target_kind !== "material")
      throw new Error("expected material");
    const invocation = parseProcessorInvocation({
      schema_version: 1,
      processor: { id: "synthetic-transfer", version: "1" },
      spec: {},
      inputs: [
        {
          kind: "material",
          input_id: "source",
          material: material.evidence.material,
        },
      ],
      execution: { method_sha256: "a".repeat(64), model: null },
    });
    const make = async (large: boolean) =>
      store.publish(
        await parseProcessorResult({
          schema_version: 1,
          result_id: randomUUID(),
          invocation,
          comparison_sha256: await processorComparison(invocation),
          status: "ok",
          producer: "external",
          literature_ids: [env.parseRequest.literature_id],
          created_at: "2026-10-19T00:00:00.000Z",
          provenance: { fixture: "synthetic transport content only" },
          content: {
            kind: "records",
            schema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
            records: Array.from({ length: large ? 8 : 1 }, (_, i) => ({
              record_id: `r${i}`,
              payload: {
                text: '文献 α🙂 "quoted"\n'.repeat(large ? 24000 : 1),
              },
              evidence: [
                {
                  pointer: "/text",
                  sources: [{ kind: "document", evidence: material.evidence }],
                },
              ],
              missing: {},
            })),
          },
          coverage: [
            {
              input_id: "source",
              status: "partial",
              read_segments: [],
              gaps: ["synthetic-material-only"],
            },
          ],
        }),
      );
    const large = await make(true),
      small = await make(false);
    const relatedRequest = {
      literature_id: env.parseRequest.literature_id,
      limit: 1,
    };
    const related = await queryProcessors(query, "results", relatedRequest);
    expect(related).toHaveProperty(
      "items",
      expect.arrayContaining([
        expect.objectContaining({ result_id: expect.any(String) }),
      ]),
    );
    const httpRelated = await fetch(`${web.origin}/api/v1/query/processors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        operation: "results",
        request: relatedRequest,
      }),
    });
    expect(((await httpRelated.json()) as { result: unknown }).result).toEqual(
      related,
    );
    const cliRelated = await runCli(
      ["processors", "results", "--request", "-", "--json"],
      { home: env.home, stdin: stdin(relatedRequest) },
    );
    expect(cliRelated.code).toBe(0);
    expect(cliRelated.value).toEqual(related);
    const mcpRelated = await client.callTool({
      name: "processor_query",
      arguments: { action: "results", request: relatedRequest },
    });
    expect(mcpRelated.isError).not.toBe(true);
    expect(
      (mcpRelated.structuredContent as { result: unknown }).result,
    ).toEqual(related);
    expect(
      await queryProcessors(query, "results", { literature_id: randomUUID() }),
    ).toEqual({ items: [], next_after: null });
    expect(processorResultBytes(large.result).length).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    expect(processorResultBytes(large.result).length).toBeLessThan(
      8 * 1024 * 1024,
    );
    const read = await client.callTool({
      name: "processor_query",
      arguments: {
        action: "read",
        request: { result_id: large.ref.result_id },
      },
    });
    expect(read.isError).toBe(true);
    const transports = {
      http: async (request: ProcessorTransferRequest) => {
        const r = await fetch(`${web.origin}/api/v1/query/processors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            operation: "transfer",
            request,
          }),
        });
        expect(r.status).toBe(200);
        return ((await r.json()) as { result: unknown }).result;
      },
      cli: async (request: ProcessorTransferRequest) => {
        const r = await runCli(
          ["processors", "transfer", "--request", "-", "--json"],
          { home: env.home, stdin: stdin(request) },
        );
        expect(r.code, JSON.stringify(r)).toBe(0);
        return r.value;
      },
      mcp: async (request: ProcessorTransferRequest) => {
        const r = await client.callTool({
          name: "processor_query",
          arguments: { action: "transfer", request: { ...request } },
        });
        expect(r.isError, JSON.stringify(r)).not.toBe(true);
        expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(
          4 * 1024 * 1024,
        );
        return (r.structuredContent as { result: unknown }).result;
      },
    };
    for (const [name, transport] of Object.entries(transports)) {
      for (const format of ["result", "json", "csv", "markdown"] as const) {
        const stored = format === "result" ? large : small;
        let continuation: string | null = null,
          start = 0,
          hash = "",
          total = 0;
        const parts: string[] = [];
        do {
          const request: ProcessorTransferRequest = {
            ...stored.ref,
            format,
            max_bytes: format === "result" ? 262144 : 1009,
            continuation,
          };
          const chunk = parseProcessorTransferChunk(await transport(request));
          expect(chunk.result_id).toBe(stored.ref.result_id);
          expect(chunk.content_sha256).toBe(stored.ref.content_sha256);
          expect(chunk.format).toBe(format);
          expect(chunk.start).toBe(start);
          expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(
            request.max_bytes,
          );
          expect(chunk.text).not.toContain("\ufffd");
          if (hash) {
            expect(chunk.transfer_sha256).toBe(hash);
            expect(chunk.total_bytes).toBe(total);
          }
          hash = chunk.transfer_sha256;
          total = chunk.total_bytes;
          start = chunk.end;
          continuation = chunk.next;
          parts.push(chunk.text);
        } while (continuation);
        const text = parts.join("");
        expect(Buffer.byteLength(text), name).toBe(total);
        expect(await sha256(Buffer.from(text))).toBe(hash);
        const expected =
          format === "result"
            ? stored
            : await queryProcessors(query, "export", {
                result_id: stored.ref.result_id,
                format,
              });
        expect(JSON.parse(text)).toEqual(expected);
        if (format === "csv" || format === "markdown")
          expect(JSON.parse(text)).toHaveProperty("metadata.coverage");
      }
    }
    const request: ProcessorTransferRequest = {
      ...small.ref,
      format: "result",
      max_bytes: 17,
      continuation: null,
    };
    const first = parseProcessorTransferChunk(
      await queryProcessors(query, "transfer", request),
    );
    const full = Buffer.from(JSON.stringify(small));
    const brokenOffset = full.indexOf(Buffer.from("文")) + 1;
    const cursor = JSON.parse(
      Buffer.from(first.next!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const brokenCursor = Buffer.from(
      JSON.stringify({ ...cursor, offset: brokenOffset }),
    ).toString("base64url");
    for (const invalid of [
      { ...request, continuation: "invalid" },
      { ...request, continuation: brokenCursor },
      {
        ...request,
        continuation: first.next,
        format: "csv" as ProcessorTransferFormat,
      },
      { ...request, continuation: first.next, ...large.ref },
      { ...request, content_sha256: "0".repeat(64) },
    ]) {
      const cli = await runCli(
        ["processors", "transfer", "--request", "-", "--json"],
        { home: env.home, stdin: stdin(invalid) },
      );
      expect(cli.code).not.toBe(0);
      const response = await client.callTool({
        name: "processor_query",
        arguments: { action: "transfer", request: invalid },
      });
      expect(response.isError).toBe(true);
      const http = await fetch(`${web.origin}/api/v1/query/processors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          operation: "transfer",
          request: invalid,
        }),
      });
      const code = (
        response.structuredContent as { result: { failure: { code: string } } }
      ).result.failure.code;
      expect((await http.json()) as unknown).toMatchObject({ code });
    }
    await expect(
      queryProcessors(query, "transfer", request, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "processor-cancelled" });
    for (const max_bytes of [0, 3, 262145])
      await expect(
        queryProcessors(query, "transfer", { ...request, max_bytes }),
      ).rejects.toThrow();
    expect(env.modelCalls).toBe(0);
    expect(env.parseCalls).toBe(0);
    expect(await env.app.jobs!.listJobs(10)).toHaveLength(0);
  } finally {
    await client.close();
    await mcp.close();
    await web.close();
    await query.close();
    await store.close();
    await env.close();
  }
}, 120000);
