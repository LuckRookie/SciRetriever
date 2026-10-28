import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import {
  parseConfiguration,
  configurationDiagnostics,
} from "../src/configuration/index.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
it("recognizes the removed field by name without using, validating or echoing its value, and keeps other keys strict", () => {
  for (const value of [
    "-99",
    '"synthetic-canary-removed-value"',
    '{ ignored = "synthetic-canary-removed-value" }',
  ]) {
    const config = parseConfiguration(
      `[proofread]\nmax_calls_per_document=${value}\n`,
    );
    expect(config.proofread).toEqual({ model: null, max_concurrent_pages: 3 });
    expect(configurationDiagnostics(config)).toMatchObject([
      {
        code: "configuration-option-removed",
        path: "proofread.max_calls_per_document",
      },
    ]);
    expect(
      JSON.stringify([config, configurationDiagnostics(config)]),
    ).not.toContain("synthetic-canary-removed-value");
  }
  expect(() => parseConfiguration("[proofread]\nunknown_option=1\n")).toThrow();
});
it("exposes the fixed warning through config status and MCP without starting a catalog or service", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-removed-option-"));
  try {
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    await writeFile(
      join(home, ".sciretriever", "config.toml"),
      '[proofread]\nmax_calls_per_document="synthetic-canary-removed-value"\n',
      { mode: 0o600 },
    );
    const owner = new TypeScriptConfigurationOwner(home),
      status = await owner.status();
    expect(status.diagnostics).toMatchObject([
      {
        code: "configuration-option-removed",
        path: "proofread.max_calls_per_document",
      },
    ]);
    let out = "";
    expect(
      (
        await runCli(["config", "status"], {
          home,
          stdout: (t) => {
            out += t;
          },
        })
      ).code,
    ).toBe(0);
    expect(out).toContain("configuration-option-removed");
    expect(out).not.toContain("synthetic-canary-removed-value");
    const server = createMcpServer({ home }),
      client = new Client({ name: "removed-option", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "configuration_status",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("configuration-option-removed");
      expect(JSON.stringify(result)).not.toContain(
        "synthetic-canary-removed-value",
      );
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
