import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect } from "vitest";
import type { StoredProcessorResult } from "../src/analysis/processor.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
export async function assertMachineReadsWebResult(
  home: string,
  expected: StoredProcessorResult,
) {
  async function* stdin() {
    yield Buffer.from(JSON.stringify({ result_id: expected.ref.result_id }));
  }
  const cli = await runCli(["processors", "read", "--request", "-", "--json"], {
    home,
    stdin: stdin(),
  });
  expect(cli.code).toBe(0);
  expect(cli.value).toEqual(expected);
  const server = createMcpServer({
    queryFactory: () => createQueryApplication(home),
  });
  const client = new Client({ name: "web-result-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const response = await client.callTool({
      name: "processor_query",
      arguments: {
        action: "read",
        request: { result_id: expected.ref.result_id },
      },
    });
    expect(response.isError).not.toBe(true);
    expect((response.structuredContent as { result: unknown }).result).toEqual(
      expected,
    );
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
      "submit_processor",
    );
  } finally {
    await client.close();
    await server.close();
  }
}
