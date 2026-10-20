import {
  workbenchTestAccess,
  WORKBENCH_TEST_PASSWORD,
} from "./workbench-auth-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PassThrough } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256, type WorkbenchView } from "@sciretriever/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import {
  MachineWorkbenchClient,
  workbenchOrigin,
} from "../src/workbench/machine-client.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import type { BrowserPageHandle } from "../src/browser/host.js";
import { createTaskOperations } from "../src/entry/task-operations.js";

beforeEach(() =>
  vi.stubEnv("SCIRETRIEVER_WEB_PASSWORD", WORKBENCH_TEST_PASSWORD),
);
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const session = new ProductionWorkbenchSession(
    FIXTURE_LITERATURE.literature_id,
    async () => ({ kind: "stop", reason: "user" }),
  );
  const apply = vi.fn(async () => undefined);
  const page: BrowserPageHandle = {
    id: "page-1",
    title: async () => "Synthetic article",
    url: () => "https://fixture.example.test/article",
    close: async () => undefined,
    apply,
    snapshot: async () => ({
      document_generation: 1,
      url: "https://fixture.example.test/article",
      title: "Synthetic article",
      text: "Synthetic text",
      viewport: { width: 800, height: 600, device_scale_factor: 1 },
      screenshot: new Uint8Array([1, 2, 3]),
      elements: [],
    }),
  };
  const opened = await session.open(
    {
      literature_id: FIXTURE_LITERATURE.literature_id,
      identifier: "doi:10.5555/parity-browser",
      version: "published",
      start_url: "https://fixture.example.test/article",
      signal: new AbortController().signal,
      metadata_snapshot: {
        revision: 1,
        sha256: await sha256(new Uint8Array()),
      },
    },
    page,
    Date.now() + 120000,
  );
  const tabs = vi.fn(async () => undefined);
  const http = await startWorkbenchHttp({
    access: workbenchTestAccess,
    session,
    assets: new Map([
      ["/", { contentType: "text/html", body: "offline fixture" }],
    ]),
    tabs: { list: async () => [], activate: tabs },
  });
  return {
    session,
    http,
    apply,
    tabs,
    close: async () => {
      await http.close();
      opened.close(false);
      await session.close();
    },
  };
}
async function connect(host: ReturnType<typeof createMcpServer>) {
  const [server, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "browser-parity", version: "1" });
  await host.connect(server);
  await client.connect(transport);
  return client;
}
type View = WorkbenchView & { controlled_by_client: boolean };
const binding = (view: View, kind: string) => ({
  kind,
  session_id: view.session_id,
  article_id: view.article_id,
  control_epoch: view.control.epoch,
});
function action(view: View, request_id: string) {
  const o = view.observation!;
  return {
    session_id: o.session_id,
    page_id: o.page_id,
    document_generation: o.document_generation,
    observation_revision: o.observation_revision,
    viewport_revision: o.viewport_revision,
    control_epoch: view.control.epoch,
    request_id,
    input: { kind: "press-key", key: "Tab", revision: o.observation_revision },
  };
}
describe("machine connections to the live Web owner", () => {
  it("creates through MCP and runs through CLI in the same Web runtime without a second execution owner", async () => {
    const env = await coreProcessingFixture();
    const session = new ProductionWorkbenchSession(null, undefined);
    const tasks = createTaskOperations(env.app)!;
    const web = await startWorkbenchHttp({
      access: workbenchTestAccess,
      session,
      tasks,
      assets: new Map([
        ["/", { contentType: "text/html", body: "offline tasks" }],
      ]),
    });
    const factory = vi.fn();
    const host = createMcpServer({
      workbenchUrl: web.origin,
      maintenance: true,
      applicationFactory: factory,
      queryFactory: factory,
    });
    const client = await connect(host);
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return (result.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      const saved = await call("runtime_create_task", {
        request: {
          kind: "processing",
          request: {
            schema_version: 1,
            idempotency_key: "runtime-parity",
            operations: [
              { operation: "parse-documents", request: env.rawParseRequest },
            ],
          },
        },
      });
      const job = saved.task as { job_id: string };
      expect(job.job_id).toBeTruthy();
      expect(env.parseCalls).toBe(0);
      async function* input() {
        yield Buffer.from(
          JSON.stringify({
            operation: "control",
            request: { job_id: job.job_id, action: "run" },
          }),
        );
      }
      const cli = await runCli(
        [
          "jobs",
          "runtime",
          "--workbench-url",
          web.origin,
          "--request",
          "-",
          "--maintenance",
        ],
        { home: env.home, stdin: input() },
      );
      expect(cli.code).toBe(0);
      await vi.waitFor(
        async () => {
          expect((await tasks.read(job.job_id))?.job.status).toBe("completed");
        },
        { timeout: 5000 },
      );
      const detail = await call("runtime_read_task", { job_id: job.job_id });
      expect(detail).toEqual({ task: await tasks.read(job.job_id) });
      expect(
        await call("runtime_list_tasks", { status_group: "ended", limit: 10 }),
      ).toMatchObject({ tasks: [{ job_id: job.job_id, status: "completed" }] });
      expect(env.parseCalls).toBe(2);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await host.close();
      await web.close();
      await session.close();
      await env.close();
    }
  }, 20000);
  it("shares observation, guidance, frames and control with Web, rejects stale actions and revokes leases on disconnect", async () => {
    const env = await fixture();
    const factory = vi.fn();
    const host = createMcpServer({
      maintenance: true,
      workbenchUrl: env.http.origin,
      applicationFactory: factory,
      queryFactory: factory,
    });
    const client = await connect(host);
    const viewer = new MachineWorkbenchClient(env.http.origin, true);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const wire = JSON.stringify(result);
      expect(wire).not.toMatch(/sr_workbench_|"csrf"|"cookie"/u);
      return (result.structuredContent as { result: unknown }).result;
    };
    try {
      let view = (await call("browser_view")) as View;
      expect(view.control.controller_id).toBeNull();
      expect(view.controlled_by_client).toBe(false);
      expect(view.observation?.text).toBe("Synthetic text");
      await call("browser_select", { session_id: view.session_id });
      expect(
        ((await viewer.execute("view", {})) as View).control.controller_id,
      ).toBeNull();
      const guidance = await call("browser_guidance", {
        guidance_id: "guide-1",
        session_id: view.session_id,
        article_id: view.article_id,
        control_epoch: view.control.epoch,
        text: "Inspect the visible download link.",
      });
      expect(guidance).toMatchObject({ guidance: { state: "accepted" } });
      expect(
        await call("browser_cancel_guidance", {
          guidance_id: "guide-1",
          session_id: view.session_id,
        }),
      ).toMatchObject({ guidance: { state: "cancelled" } });
      view = (await call("browser_view")) as View;
      const frame = await client.callTool({
        name: "browser_frame",
        arguments: {
          session_id: view.session_id,
          frame_seq: view.observation!.frame_seq,
        },
      });
      expect(frame.isError, JSON.stringify(frame)).not.toBe(true);
      expect(frame.content).toEqual([
        { type: "image", mimeType: "image/jpeg", data: "AQID" },
      ]);
      expect(frame.structuredContent).toMatchObject({
        result: { frame_seq: view.observation!.frame_seq, byte_size: 3 },
      });
      view = (
        (await call("browser_control", binding(view, "takeover"))) as {
          view: View;
        }
      ).view;
      expect(view.controlled_by_client).toBe(true);
      const stale = action(view, "stale-after-other-controller");
      const second = (await viewer.execute(
        "control",
        binding(view, "takeover"),
      )) as { view: View };
      expect(second.view.controlled_by_client).toBe(true);
      const denied = await client.callTool({
        name: "browser_action",
        arguments: stale,
      });
      expect(denied.isError).toBe(true);
      expect(env.apply).not.toHaveBeenCalled();
      await viewer.execute("control", binding(second.view, "release"));
      view = (await call("browser_view")) as View;
      view = (
        (await call("browser_control", binding(view, "takeover"))) as {
          view: View;
        }
      ).view;
      const applied = (await call(
        "browser_action",
        action(view, "valid-action"),
      )) as { view: View };
      expect(env.apply).toHaveBeenCalledTimes(1);
      expect(applied.view.controlled_by_client).toBe(true);
      await call("browser_control", binding(applied.view, "release"));
      expect(env.session.view().control.controller_id).toBeNull();
      view = (await call("browser_view")) as View;
      await call("browser_control", binding(view, "takeover"));
      await call("browser_disconnect");
      expect(env.session.view().control.controller_id).toBeNull();
      expect(env.session.view().state).toBe("paused");
      expect(factory).not.toHaveBeenCalled();
      await viewer.close();
      expect(env.session.view().control.viewers).toBe(0);
    } finally {
      await client.close();
      await host.close();
      await viewer.close();
      await env.close();
    }
  });
  it("keeps a noninteractive CLI connection across dependent commands and gives up its lease at EOF", async () => {
    const env = await fixture();
    const responses: { result: unknown }[] = [];
    let view: View;
    let replyReady!: () => void;
    let nextReply = new Promise<void>((resolve) => {
      replyReady = resolve;
    });
    const waitForReply = async () => {
      await nextReply;
      nextReply = new Promise<void>((resolve) => {
        replyReady = resolve;
      });
    };
    async function* requests() {
      yield Buffer.from(
        JSON.stringify({ operation: "view", request: {} }) + "\n",
      );
      await waitForReply();
      view = responses.at(-1)!.result as View;
      yield Buffer.from(
        JSON.stringify({
          operation: "control",
          request: binding(view, "takeover"),
        }) + "\n",
      );
      await waitForReply();
      view = (responses.at(-1)!.result as { view: View }).view;
      yield Buffer.from(
        JSON.stringify({
          operation: "action",
          request: action(view, "cli-action"),
        }) + "\n",
      );
    }
    try {
      const result = await runCli(
        [
          "browser",
          "session",
          "--workbench-url",
          env.http.origin,
          "--request",
          "-",
          "--maintenance",
        ],
        {
          stdin: requests(),
          stdout: (text) => {
            responses.push(JSON.parse(text));
            replyReady();
          },
        },
      );
      expect(result).toEqual({ code: 0, value: { completed: 3, failed: 0 } });
      expect(env.apply).toHaveBeenCalledTimes(1);
      expect(env.session.view().control.controller_id).toBeNull();
      expect(env.session.view().state).toBe("paused");
    } finally {
      await env.close();
    }
  });
  it("does not offer write tools in readonly mode, and rejects arbitrary origins, paths and browser scripts", async () => {
    for (const origin of [
      "https://127.0.0.1:1234",
      "http://example.test:1234",
      "http://127.0.0.1:1234/path",
      "http://u:p@127.0.0.1:1234/",
      "http://127.0.0.1:1234/?token=x",
    ])
      expect(() => workbenchOrigin(origin)).toThrow();
    const env = await fixture();
    const host = createMcpServer({ workbenchUrl: env.http.origin });
    const client = await connect(host);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("browser_view");
      expect(tools).not.toContain("browser_action");
      expect(
        (await client.callTool({ name: "browser_control", arguments: {} }))
          .isError,
      ).toBe(true);
      const view = await client.callTool({
        name: "browser_view",
        arguments: {},
      });
      expect(view.isError).not.toBe(true);
      expect(env.apply).not.toHaveBeenCalled();
      const machine = new MachineWorkbenchClient(env.http.origin, true);
      try {
        await expect(
          machine.execute("action", { script: "document.cookie" }),
        ).rejects.toThrow();
      } finally {
        await machine.close();
      }
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  });
  it("interrupts an idle CLI input stream and revokes the acquired control lease", async () => {
    const env = await fixture();
    const stream = new PassThrough();
    const controller = new AbortController();
    const errors: string[] = [];
    stream.write(JSON.stringify({ operation: "view", request: {} }) + "\n");
    try {
      const result = await runCli(
        [
          "browser",
          "session",
          "--workbench-url",
          env.http.origin,
          "--request",
          "-",
          "--maintenance",
        ],
        {
          stdin: stream,
          signal: controller.signal,
          stderr: (text) => errors.push(text),
          stdout: (text) => {
            const { result } = JSON.parse(text) as {
              result: View | { view: View };
            };
            if ("view" in result) {
              expect(result.view.controlled_by_client).toBe(true);
              controller.abort();
            } else
              stream.write(
                JSON.stringify({
                  operation: "control",
                  request: binding(result, "takeover"),
                }) + "\n",
              );
          },
        },
      );
      expect(result.code).toBe(130);
      expect(errors).toEqual(['{"code":"operation-cancelled"}\n']);
      expect(stream.destroyed).toBe(true);
      expect(env.session.view().control.controller_id).toBeNull();
      expect(env.session.view().state).toBe("paused");
      expect(env.session.view().control.viewers).toBe(0);
    } finally {
      stream.destroy();
      await env.close();
    }
  });
  it("reports cancellation while consuming a Browser response without losing connection cleanup", async () => {
    const env = await fixture();
    const machine = new MachineWorkbenchClient(env.http.origin);
    const controller = new AbortController();
    const fetchResponse = globalThis.fetch;
    const capture = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, options) => {
        const response = await fetchResponse(input, options);
        if (String(input).includes("/api/frame?")) controller.abort();
        return response;
      });
    try {
      const view = (await machine.execute("view", {})) as View;
      await expect(
        machine.execute(
          "frame",
          {
            session_id: view.session_id,
            frame_seq: view.observation!.frame_seq,
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "operation-cancelled" });
    } finally {
      capture.mockRestore();
      await machine.close();
      await env.close();
    }
    expect(env.session.view().control.viewers).toBe(0);
  });
});
