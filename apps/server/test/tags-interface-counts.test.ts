import { expect, it } from "vitest";
import { parseTagListItem } from "@sciretriever/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tagFixture } from "./tag-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";

it("returns identical counts through HTTP, CLI and MCP after a merge deduplicates a paper", async () => {
  const e = await tagFixture();
  try {
    const parent = await e.create("Parent"),
      child = await e.create("Child", parent),
      source = await e.create("Source"),
      unused = await e.create("Unused");
    await e.assign([parent, child, source]);
    const change = await e.tags.change({
      mutation: { op: "merge", tag_id: source, into: child },
      expected_version: (await e.tags.state()).version,
      reason: "Synthetic merge",
    });
    const expected = await e.tags.list({ limit: 2, offset: 0 });
    expect(expected).toMatchObject({
      total: 3,
      next_offset: 2,
      items: [
        { tag_id: unused, uses: 0 },
        { tag_id: child, uses: 1 },
      ],
    });
    expect((await e.tags.get(source))!.tag.status).toBe("merged");
    expect((await e.tags.get(child))!.uses).toBe(1);
    const query = await createQueryApplication(e.home);
    const web = await startQueryOnlyHttp({ application: query });
    const server = createMcpServer({ home: e.home });
    const client = new Client({ name: "tag-counts-fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      for (const offset of [0, 2]) {
        const request = { limit: 2, offset };
        const page = await e.tags.list(request);
        const cli = await runCli(
          ["tags", "list", "--limit", "2", "--offset", String(offset)],
          { home: e.home },
        );
        expect(cli.code).toBe(0);
        expect(cli.value).toEqual(page);
        const response = await fetch(web.origin + "/api/v1/query/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: { operation: "list", request },
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          protocol_version: 1,
          result: page,
        });
        const mcp = await client.callTool({
          name: "tags_query",
          arguments: { operation: "list", request },
        });
        expect(mcp.isError).not.toBe(true);
        expect(mcp.structuredContent).toEqual({
          protocol_version: 1,
          result: page,
        });
        expect(page.items.map(parseTagListItem)).toEqual(page.items);
      }
      await e.tags.change({
        mutation: {
          op: "undo",
          change_version: change.version,
          cascade: false,
        },
        expected_version: (await e.tags.state()).version,
        reason: "Synthetic undo",
      });
      expect(
        (await e.tags.list()).items.find((t) => t.tag_id === source)?.uses,
      ).toBe(1);
      expect(
        (await e.tags.list()).items.find((t) => t.tag_id === child)?.uses,
      ).toBe(1);
    } finally {
      await client.close();
      await server.close();
      await web.close();
      await query.close();
    }
  } finally {
    await e.close();
  }
});
