import { SCHEMA_VERSION } from "../src/storage/sqlite/schema.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";

it("starts the compiled CLI MCP command over actual stdio without touching the user's home", async () => {
  const env = await coreProcessingFixture();
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  await promisify(execFile)("pnpm", ["exec", "tsc", "-b"], { cwd: root });
  const entry = new URL("../dist/cli/main.js", import.meta.url).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      `import { runCli } from ${JSON.stringify(entry)}; const result=await runCli(['mcp'],{home:process.argv[1]}); process.exitCode=result.code;`,
      env.home,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-fixture", version: "1" });
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      protocol_version: 1,
      result: { status: "ready", schema_version: SCHEMA_VERSION },
    });
    expect(
      (await client.listTools()).tools.some(
        (t) => t.name === "submit_processing",
      ),
    ).toBe(false);
  } finally {
    await client.close();
    await transport.close();
    await env.close();
  }
}, 60000);
