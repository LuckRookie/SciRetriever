import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseIndexRefreshStatus } from "@sciretriever/contracts";
import {
  RetrievalIndexError,
  RetrievalIndexService,
} from "../src/retrieval/index.js";
import { archiveFixture } from "./archive-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";

it.each(["arranged-v2", "legacy-v1"] as const)(
  "does not block %s publication on a running refresh and exposes a durable retryable failure",
  async (format) => {
    const env =
      format === "arranged-v2"
        ? await archiveFixture()
        : await coreProcessingFixture();
    let release!: () => void, began!: () => void;
    const held = new Promise<void>((done) => {
        release = done;
      }),
      started = new Promise<void>((done) => {
        began = done;
      });
    const spy = vi
      .spyOn(RetrievalIndexService.prototype, "refresh")
      .mockImplementation(async () => {
        began();
        await held;
        throw new RetrievalIndexError("index-source-invalid");
      });
    try {
      // Isolate corrected publication's scheduling; draft scheduling has its
      // own tests and its public index reader is introduced separately.
      await env.app.rawParsing!.parseAsset(
        env.asset.asset_id,
        ["pipeline", "vlm-engine"],
        undefined,
        { force: false, expected_sha256: env.asset.sha256 },
      );
      let publish: () => Promise<{
        index_status: string;
        default_updated: boolean;
        [key: string]: unknown;
      }>;
      if (format === "arranged-v2") {
        await env.app.archiveText!.arrange(env.asset.asset_id, "full");
        await env.app.archiveText!.proofread(env.asset.asset_id, "full", null);
        publish = () =>
          env.app.archiveText!.render(
            env.rawParseRequest.literature_id,
            env.asset.asset_id,
          );
      } else {
        const output = await env.app.proofreading!.build({
          asset_id: env.asset.asset_id,
        });
        publish = () =>
          env.app.proofreadDocuments.publish({
            literature_id: env.rawParseRequest.literature_id,
            asset_id: env.asset.asset_id,
            proofread_id: output.version.proofread_id,
            expected_default_revision: null,
          });
      }
      const start = performance.now(),
        result = await publish();
      const elapsed_ms = Math.round(performance.now() - start);
      console.info(
        JSON.stringify({
          measurement: "publication-with-background-index",
          format,
          elapsed_ms,
        }),
      );
      expect(result).toMatchObject({
        default_updated: true,
        index_status: "scheduled",
      });
      await started;
      expect(await env.app.indexRefreshStatus!()).toMatchObject({
        status: "running",
      });
      release();
      await vi.waitFor(async () =>
        expect(await env.app.indexRefreshStatus!()).toMatchObject({
          status: "failed",
          technical_details: { code: "index-source-invalid" },
        }),
      );
      const current = await env.app.database.documentDefault(
        env.rawParseRequest.literature_id,
        env.asset.asset_id,
        env.asset.sha256,
      );
      expect(current).not.toBeNull();
      await env.app.documentRead.describe({
        document_version_id: current!.document_version_id,
      });

      // Read-only adapters all see the same persisted failure; none starts a refresh.
      const query = await createQueryApplication(env.home);
      let expected;
      try {
        expected = parseIndexRefreshStatus(
          await executeQuery(query, "index-status", {}),
        );
      } finally {
        await query.close();
      }
      expect(expected.status).toBe("failed");
      const web = await startQueryOnlyWorkbench({
        home: env.home,
        assets: new Map(),
      });
      try {
        const response = await fetch(
          `${web.origin}/api/v1/query/index-status`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-SciRetriever-Protocol-Version": "1",
            },
            body: JSON.stringify({ protocol_version: 1, request: {} }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          protocol_version: 1,
          result: expected,
        });
      } finally {
        await web.close();
      }
      let stdout = "";
      expect(
        (
          await runCli(["maintenance", "index-status"], {
            home: env.home,
            stdout: (text) => {
              stdout += text;
            },
          })
        ).code,
      ).toBe(0);
      expect(JSON.parse(stdout).result).toEqual(expected);
      const server = createMcpServer({ home: env.home }),
        client = new Client({ name: "index-refresh", version: "1" }),
        [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(a);
        await client.connect(b);
        const reply = await client.callTool({
          name: "index_status",
          arguments: {},
        });
        expect(reply.isError).not.toBe(true);
        expect(JSON.stringify(reply)).toContain("index-source-invalid");
      } finally {
        await client.close();
        await server.close();
      }
      expect(spy).toHaveBeenCalledTimes(1);
      await env.app.maintenance!.rebuildIndex();
      expect(await env.app.indexRefreshStatus!()).toMatchObject({
        status: "updated",
        technical_details: { code: null },
      });
    } finally {
      release();
      spy.mockRestore();
      await env.close();
    }
  },
  30000,
);
