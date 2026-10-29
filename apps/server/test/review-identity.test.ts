import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { processorFixture } from "./processor-fixture.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { withActivity, activityContext } from "../src/logging/activity.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import * as applicationBootstrap from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";

it(
  "attributes CLI and MCP proofreading to machine entry identity and retains the job creator across contexts",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    try {
      await e.build(e.parseRequest);
      const id = e.parseRequest.literature_id,
        asset = e.parseRequest.asset_id;
      const invoke = async (args: string[], request: unknown) => {
        let output = "",
          error = "";
        const result = await runCli(args, {
          home: e.home,
          stdin: (async function* () {
            yield Buffer.from(JSON.stringify(request));
          })(),
          stdout: (t) => {
            output += t;
          },
          stderr: (t) => {
            error += t;
          },
        });
        expect({ code: result.code, error }).toEqual({ code: 0, error: "" });
        return JSON.parse(output);
      };
      const read = await invoke(["proofread", "text", "--request", "-"], {
        asset_id: asset,
      });
      expect(read.result.text).toContain("A synthetic finding.");
      // Flow X (06ca0af): proofread save is the arranged whole-Markdown save,
      // bound to the arrangement and manual revision, and renders at once.
      expect(read.result.format).toBe("arranged-v2");
      // The arranged save re-reads the PDF pages, so the CLI's Application
      // gets the fixture's synthetic page source instead of a real browser.
      const boot = vi
        .spyOn(applicationBootstrap, "createApplication")
        .mockImplementationOnce(() => e.openAnother());
      const saved = await invoke(["proofread", "save", "--request", "-"], {
        schema_version: 2,
        literature_id: id,
        asset_id: asset,
        proofread_id: read.result.proofread_id,
        expected_arrangement_id: read.result.arrangement_id,
        expected_manual_revision: read.result.manual_revision,
        markdown: read.result.text.replace(
          "A synthetic finding.",
          "A synthetic finding, CLI revision.",
        ),
      });
      boot.mockRestore();
      expect(saved).toMatchObject({
        saved: true,
        changed: true,
        rebuild: { status: "done" },
      });
      const server = createMcpServer({
          home: e.home,
          maintenance: true,
          // Same synthetic page source as the CLI save above.
          applicationFactory: () => e.openAnother(),
        }),
        client = new Client({ name: "review-test", version: "1" }),
        [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(a);
        await client.connect(b);
        const read = await client.callTool({
          name: "proofread_text",
          arguments: { asset_id: asset },
        });
        expect(read.isError).not.toBe(true);
        const latest = (
          read.structuredContent as {
            result: {
              proofread_id: string;
              arrangement_id: string;
              manual_revision: number;
              text: string;
            };
          }
        ).result;
        expect(latest.proofread_id).toBe(saved.proofread_id);
        const write = await client.callTool({
          name: "proofread_save",
          arguments: {
            schema_version: 2,
            literature_id: id,
            asset_id: asset,
            proofread_id: latest.proofread_id,
            expected_arrangement_id: latest.arrangement_id,
            expected_manual_revision: latest.manual_revision,
            markdown: latest.text.replace(
              "CLI revision.",
              "CLI and MCP revision.",
            ),
          },
        });
        expect(write.isError, JSON.stringify(write)).not.toBe(true);
        expect(write.structuredContent).toMatchObject({
          result: { saved: true, changed: true },
        });
        const history = await client.callTool({
          name: "operation_history",
          arguments: { operation: "proofread-save" },
        });
        expect(history.isError).not.toBe(true);
        expect(JSON.stringify(history)).toContain("mcp:");
        const pending = await e.app.processors!.submit({
          schema_version: 1,
          idempotency_key: "machine-review-queries",
          name: "Machine queries",
          processor: { id: "summary", version: "2" },
          spec: {},
          inputs: [{ kind: "literature", literature_id: id }],
        });
        const operations = [
          {
            cli: ["agents", "sessions"],
            tool: "agent_sessions",
            request: { operation: "list", request: { limit: 10 } },
            field: "items",
          },
          {
            cli: ["jobs", "progress"],
            tool: "task_run",
            request: { job_id: pending.job_id },
            field: "items",
          },
          {
            cli: ["usage", "estimate"],
            tool: "usage_estimate",
            request: {
              kind: "archive",
              request: {
                selector: { kind: "literatures", literature_ids: [id] },
              },
            },
            field: "components",
          },
          {
            cli: ["processor", "runs"],
            tool: "processor_runs",
            request: { literature_id: id },
            field: "items",
          },
          {
            cli: ["literature", "results"],
            tool: "literature_results",
            request: { literature_id: id },
            field: "items",
          },
        ];
        const calls = e.modelCalls,
          jobs = await e.app.jobs!.listJobs();
        for (const operation of operations) {
          const cli = await invoke(
            [...operation.cli, "--request", "-"],
            operation.request,
          );
          expect(cli.result).toHaveProperty(operation.field);
          const mcp = await client.callTool({
            name: operation.tool,
            arguments: operation.request,
          });
          expect(mcp.isError, operation.tool).not.toBe(true);
          expect(JSON.stringify(mcp)).toContain(operation.field);
        }
        expect(e.modelCalls).toBe(calls);
        expect(await e.app.jobs!.listJobs()).toEqual(jobs);
      } finally {
        await client.close();
        await server.close();
      }
      const records = await e.app.database.review<{
        items: { actor: string; status: string }[];
      }>("audit-list", { operation: "proofread-save" });
      expect(records.items.map((i) => i.actor.split(":")[0])).toEqual([
        "cli",
        "mcp",
      ]);
      expect(records.items.every((i) => i.status === "completed")).toBe(true);
      const job = await withActivity({ actor: "web-session:first" }, () =>
        e.app.processingTasks!.submit({
          schema_version: 1,
          idempotency_key: "origin-restoration",
          operations: [
            {
              operation: "build-archive",
              request: {
                schema_version: 2,
                literature_id: id,
                mode: "full",
                from_step: null,
              },
            },
          ],
        }),
      );
      const restored = await withActivity({ actor: "web-session:later" }, () =>
        e.app.jobs!.withOrigin(job.job_id, async () => activityContext()),
      );
      expect(restored).toMatchObject({
        actor: "web-session:first",
        job_id: job.job_id,
      });
      const query = await createQueryApplication(e.home);
      try {
        expect(
          await executeQuery(query, "task-run", { job_id: job.job_id }),
        ).toMatchObject({
          job: {
            actor: "web-session:first",
            actor_label: "网页登录 · 历史会话",
          },
        });
      } finally {
        await query.close();
      }
      await withActivity({ actor: "web-session:later" }, () =>
        e.app.processingTasks!.control(job.job_id, "cancel"),
      );
      expect(
        (await e.app.jobs!.listEvents(job.job_id, -1, 100)).find(
          (v) => v.kind === "task-control-requested",
        )!.payload,
      ).toMatchObject({ actor: "web-session:later", action: "cancel" });
      const fields = await e.app.metadataFields.read(id);
      await withActivity({ actor: "web-session:metadata" }, () =>
        executeMaintenance(e.app, "metadata-edit", {
          literature_id: id,
          set: [{ field: "title", value: "Edited title" }],
          unlock: [],
          expected_revision: fields.metadata_revision,
        }),
      );
      expect(
        await e.app.database.review("audit-list", {
          operation: "metadata-edit",
        }),
      ).toMatchObject({
        items: [
          {
            actor: "web-session:metadata",
            scope: { literature_id: id },
            status: "completed",
          },
        ],
      });
    } finally {
      await e.close();
    }
  },
);
