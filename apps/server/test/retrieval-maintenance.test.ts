import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseIndexVerificationResult } from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";

it("verifies through CLI/HTTP/MCP and exposes verified corruption as index-corrupt with a rebuild hint", async () => {
  const e = await coreProcessingFixture();
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let web: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
  try {
    await e.app.maintenance!.rebuildIndex();
    const cli = await runCli(["maintenance", "verify-index"], { home: e.home });
    expect(cli.code).toBe(0);
    parseIndexVerificationResult(cli.value);
    query = await createQueryApplication(e.home);
    web = await startQueryOnlyHttp({
      application: query,
      maintenance: e.app.maintenance!,
      assets: new Map([
        ["/", { contentType: "text/html", body: Buffer.from("synthetic") }],
      ]),
    });
    const root = await fetch(web.origin),
      cookie = root.headers.get("set-cookie")!.split(";")[0]!;
    const session = await fetch(`${web.origin}/api/v1/maintenance/session`, {
      headers: { Cookie: cookie },
    });
    const { csrf } = (await session.json()) as { csrf: string };
    const verify = () =>
      fetch(`${web!.origin}/api/v1/maintenance/verify-index`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: web!.origin,
          "Content-Type": "application/json",
          "X-SciRetriever-Csrf": csrf,
          "X-SciRetriever-Protocol-Version": "1",
        },
        body: JSON.stringify({
          protocol_version: 1,
          request: { kind: "verify" },
        }),
      });
    const response = await verify();
    expect(response.status).toBe(200);
    parseIndexVerificationResult(
      ((await response.json()) as { result: unknown }).result,
    );
    const server = createMcpServer({ home: e.home, maintenance: true }),
      client = new Client({ name: "verify-index", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "verify_index",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("verified");
    } finally {
      await client.close();
      await server.close();
    }
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      db.exec("UPDATE retrieval_fts SET title='changed synthetic text'");
    } finally {
      db.close();
    }
    const damaged = await verify();
    expect(damaged.status).toBe(422);
    expect(await damaged.json()).toMatchObject({ code: "index-corrupt" });
    expect(
      await query.context!.search({
        query: "synthetic",
        scope: { kind: "library" },
        kinds: ["metadata"],
        versions: { kind: "default" },
        budget: { max_items: 20, max_bytes: 65536, token_limit: null },
        continuation: null,
      }),
    ).toMatchObject({
      coverage: "index-corrupt",
      maintenance_hint: "rebuild-index",
    });
    const failed = await runCli(["maintenance", "verify-index"], {
      home: e.home,
    });
    expect(failed.code).not.toBe(0);
    await e.app.maintenance!.rebuildIndex();
    expect((await verify()).status).toBe(200);
  } finally {
    await web?.close();
    await query?.close();
    await e.close();
  }
}, 30000);
