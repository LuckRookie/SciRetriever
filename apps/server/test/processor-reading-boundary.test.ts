import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
  queryProcessors,
  submitProcessor,
} from "../src/entry/processor-operations.js";

it(
  "removes caller chunk size from the registry and rejects it consistently before a job is created",
  { timeout: 0 },
  async () => {
    const e = await coreProcessingFixture();
    const server = createMcpServer({ home: e.home, maintenance: true });
    const client = new Client({ name: "reading-boundary-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      const registry = await queryProcessors({}, "list", {});
      expect(JSON.stringify(registry)).not.toContain("max_chunk_bytes");
      const request = {
        schema_version: 1,
        idempotency_key: "obsolete-reading-limit",
        name: "Boundary",
        processor: { id: "records", version: "2" },
        spec: {
          record_meaning: "observations",
          fields: [{ name: "note", description: "reported note" }],
          reading: { max_chunk_bytes: 12000 },
        },
        inputs: [
          { kind: "literature", literature_id: e.parseRequest.literature_id },
        ],
      };
      await expect(
        submitProcessor(e.app, request, false),
      ).rejects.toMatchObject({ code: "processor-spec" });
      let errors = "";
      const cli = await runCli(["processor", "submit", "--request", "-"], {
        home: e.home,
        stdin: (async function* () {
          yield Buffer.from(JSON.stringify(request));
        })(),
        stdout: () => {},
        stderr: (value) => {
          errors += value;
        },
      });
      expect(cli.code).not.toBe(0);
      expect(errors).toContain("processor-spec");
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "submit_processor",
        arguments: { request },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("processor-spec");
      expect(await e.app.jobs!.listJobs()).toEqual([]);
      expect(e.modelCalls).toBe(0);
    } finally {
      await client.close();
      await server.close();
      await e.close();
    }
  },
);
