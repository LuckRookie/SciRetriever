import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import {
  parseDeviceConnectionCode,
  type DevicePurpose,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { McpHttpService, type McpHttpOptions } from "../src/mcp/http.js";
import { SdkTransportAdapter } from "../src/mcp/transport.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
  httpMcpAllowed,
  QUERY_TOOLS,
  MAINTENANCE_TOOLS,
  BROWSER_QUERY_TOOLS,
  BROWSER_MAINTENANCE_TOOLS,
} from "../src/mcp/tools.js";
import { DeviceRouteRegistry } from "../src/workbench/device-http.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { workbenchTestAccess } from "./workbench-auth-fixture.js";

async function fixture(
  options?: McpHttpOptions,
  metadata?: import("../src/bootstrap/application.js").ApplicationOptions["metadata"],
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-mcp-http-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: false },
    ...(metadata ? { metadata } : {}),
  });
  const query = await createQueryApplication(home);
  const screen = new ProductionWorkbenchSession(null, undefined);
  const endpoint = options ? new McpHttpService(app, query, options) : null;
  const routes = endpoint
    ? new DeviceRouteRegistry(endpoint.routes(), () => endpoint.close())
    : deviceBusinessRoutes(app, query);
  const http = await startWorkbenchHttp({
    session: screen,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "test" }]]),
    devices: { service: app.deviceConnections, routes },
  });
  const clients: {
    client: Client;
    transport: StreamableHTTPClientTransport;
  }[] = [];
  const token = async (purposes: DevicePurpose[]) => {
    const pairing = await app.deviceConnections.create({
      address: http.origin,
      name: "Synthetic MCP",
      purposes,
    });
    return app.deviceConnections.exchange(
      {
        pairing_code: parseDeviceConnectionCode(pairing.connection_code)
          .pairing_code,
      },
      "synthetic-peer",
    );
  };
  const connect = async (secret: string, name = "synthetic-http-client") => {
    const transport = new StreamableHTTPClientTransport(
      new URL("/mcp", http.origin),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${secret}`,
            Cookie: `synthetic_cookie=${secret}`,
            Origin: "chrome-extension://synthetic",
          },
        },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      },
    );
    const client = new Client({ name, version: "1" });
    client.onerror = () => {};
    clients.push({ client, transport });
    await client.connect(new SdkTransportAdapter(transport));
    return { client, transport };
  };
  const rpc = (secret: string | null, body: unknown, sessionId?: string) =>
    fetch(http.origin + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    home,
    app,
    query,
    http,
    token,
    connect,
    rpc,
    async close() {
      await Promise.allSettled(clients.map((c) => c.client.close()));
      await http.close();
      await screen.close();
      await query.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
function structured(result: unknown): unknown {
  return (result as { structuredContent: unknown }).structuredContent;
}
it("status names the bibliographic sources in use to a read device, names only", async () => {
  const f = await fixture(undefined, {
    lookup_ports: [],
    topic_search_ports: [],
  });
  try {
    const paired = await f.token(["read"]),
      remote = await f.connect(paired.token);
    const result = await remote.client.callTool({
      name: "status",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    // The running Application's registry: this library was built with none.
    expect(structured(result)).toMatchObject({
      result: {
        status: "ready",
        metadata_sources: { topic_search: [], lookup: [] },
      },
    });
    expect([
      ...f.app.metadata.topic_selection,
      ...f.app.metadata.lookup_selection,
    ]).toEqual([]);
    // Without a shared Application the query side reads configuration.
    const configured = (await f.query.metadataSources!()) as {
      topic_search: string[];
      lookup: string[];
    };
    expect(configured.topic_search).toContain("crossref");
    expect(configured.lookup.length).toBeGreaterThan(0);
    for (const name of [...configured.topic_search, ...configured.lookup])
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/u);
  } finally {
    await f.close();
  }
}, 30000);

it("keeps draft preview in read and creation in operate without registering either direct HTTP device route", async () => {
  const f = await fixture();
  try {
    for (const purposes of [
      ["read"],
      ["operate"],
      ["read", "operate"],
    ] as DevicePurpose[][]) {
      const paired = await f.token(purposes),
        remote = await f.connect(paired.token);
      const names = (await remote.client.listTools()).tools.map((t) => t.name);
      expect(names.includes("form_drafts_preview")).toBe(
        purposes.includes("read"),
      );
      expect(names.includes("form_drafts")).toBe(purposes.includes("operate"));
      const selector = {
        kind: "query",
        query: {},
        sort: "title-asc",
        limit: null,
      };
      for (const [name, args, purpose] of [
        ["form_drafts_preview", { selector }, "read"],
        [
          "form_drafts",
          { selector, idempotency_key: `draft-purpose-${purposes.join("-")}` },
          "operate",
        ],
      ] as const) {
        const result = await remote.client.callTool({ name, arguments: args });
        if (purposes.includes(purpose)) {
          expect(result.isError).not.toBe(true);
          if (purpose === "read")
            expect(structured(result)).toMatchObject({
              result: { matched: 0, process: 0, process_parts: 0 },
            });
          else
            expect(structured(result)).toMatchObject({
              result: {
                selector: { goal: "draft", scope: { counts: { process: 0 } } },
              },
            });
        } else {
          expect(result.isError).toBe(true);
          expect(structured(result)).toMatchObject({
            result: { failure: { code: "device-purpose-forbidden" } },
          });
        }
      }
      for (const path of [
        "/api/v1/query/form-drafts-preview",
        "/api/v1/maintenance/form-drafts",
      ]) {
        const denied = await fetch(f.http.origin + path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paired.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({
          code: "device-purpose-forbidden",
        });
      }
    }
    const intake = await f.token(["intake"]);
    expect(
      (
        await f.rpc(intake.token, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "synthetic-intake", version: "1" },
          },
        })
      ).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
}, 60_000);
it("separates saved filter read/operate tools and refuses direct device query/maintenance HTTP", async () => {
  const f = await fixture();
  try {
    for (const purposes of [
      ["read"],
      ["operate"],
      ["read", "operate"],
    ] as DevicePurpose[][]) {
      const paired = await f.token(purposes),
        remote = await f.connect(paired.token);
      const names = (await remote.client.listTools()).tools.map((t) => t.name);
      expect(names.includes("filters_query")).toBe(purposes.includes("read"));
      expect(names.includes("filters_manage")).toBe(
        purposes.includes("operate"),
      );
      for (const [name, args, purpose] of [
        ["filters_query", { operation: "list", request: {} }, "read"],
        [
          "filters_manage",
          {
            operation: "import",
            request: {
              items: [{ name: "Synthetic", query: {}, sort: "title-asc" }],
            },
          },
          "operate",
        ],
      ] as const) {
        const result = await remote.client.callTool({ name, arguments: args });
        expect(result.isError === true).toBe(!purposes.includes(purpose));
        if (!purposes.includes(purpose))
          expect(structured(result)).toMatchObject({
            result: { failure: { code: "device-purpose-forbidden" } },
          });
      }
      for (const path of [
        "/api/v1/query/filters",
        "/api/v1/maintenance/filters",
      ]) {
        const denied = await fetch(f.http.origin + path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paired.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({
          code: "device-purpose-forbidden",
        });
      }
    }
  } finally {
    await f.close();
  }
}, 60000);
it("uses the official HTTP client, lists independent read/operate tools and matches the shared stdio implementation", async () => {
  const f = await fixture();
  const stdio = createMcpServer({
    home: f.home,
    maintenance: true,
    sharedApplications: true,
    applicationFactory: async () => f.app,
    queryFactory: async () => f.query,
  });
  const [server, transport] = InMemoryTransport.createLinkedPair();
  const local = new Client({ name: "synthetic-stdio", version: "1" });
  try {
    await stdio.connect(server);
    await local.connect(transport);
    for (const purposes of [
      ["read"],
      ["operate"],
      ["read", "operate"],
    ] as DevicePurpose[][]) {
      const paired = await f.token(purposes),
        remote = await f.connect(paired.token);
      const tools = (await remote.client.listTools()).tools;
      expect(tools.map((t) => t.name)).toEqual(
        [...QUERY_TOOLS, ...MAINTENANCE_TOOLS]
          .filter((t) => httpMcpAllowed(t.name, purposes))
          .map((t) => t.name),
      );
      for (const tool of tools)
        expect(tool).toEqual(
          (await local.listTools()).tools.find((t) => t.name === tool.name),
        );
      expect(tools.some((t) => t.name === "status")).toBe(
        purposes.includes("read"),
      );
      expect(tools.some((t) => t.name === "folders_manage")).toBe(
        purposes.includes("operate"),
      );
      if (purposes.includes("read"))
        for (const [name, args] of [
          ["status", {}],
          ["search_library", { text: null, limit: 20, cursor: null }],
          ["library_counts", { query: {} }],
        ] as const) {
          const response = await remote.client.callTool({
            name,
            arguments: args,
          });
          expect(response.isError).not.toBe(true);
          expect(structured(response)).toEqual(
            structured(await local.callTool({ name, arguments: args })),
          );
        }
      const denied = await remote.client.callTool({
        name: !purposes.includes("operate")
          ? "folders_manage"
          : !purposes.includes("read")
            ? "status"
            : "configuration_status",
        arguments: {},
      });
      expect(denied.isError).toBe(true);
      expect(structured(denied)).toMatchObject({
        result: { failure: { code: "device-purpose-forbidden" } },
      });
      await remote.transport.terminateSession();
      await remote.client.close();
    }
    console.info(
      "Official MCP SDK 1.27.1: HTTP initialize, tools/list, read/operate filtering, three read-tool parity checks and DELETE completed; credentials omitted.",
    );
  } finally {
    await local.close();
    await stdio.close();
    await f.close();
  }
}, 30000);

it("keeps import status/report read-only and shared with stdio, including report continuation", async () => {
  const f = await fixture();
  const localHost = createMcpServer({
    home: f.home,
    applicationFactory: async () => {
      throw new Error("Write application must not open");
    },
    queryFactory: async () => f.query,
    sharedApplications: true,
  });
  const [server, transport] = InMemoryTransport.createLinkedPair(),
    local = new Client({ name: "reader", version: "1" });
  try {
    const s = await f.app.importSessions.create(
      {
        format: "csl-json",
        source: {
          system: "synthetic",
          library_id: "global",
          identity: "global",
          name: "MCP import",
        },
        scope: "two records",
      },
      { kind: "local", origin: "cli" },
    );
    await f.app.importSessions.putData(
      s.batch_id,
      0,
      '[{"id":"one","title":"Paper one"},{"id":"two","title":"Paper two"}]',
    );
    await f.app.importSessions.confirm(s.batch_id);
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
      readOnly: true,
    });
    const before = db.prepare("SELECT * FROM library_state_revision").all();
    await localHost.connect(server);
    await local.connect(transport);
    const paired = await f.token(["read"]),
      remote = await f.connect(paired.token);
    for (const old of ["import_session_status", "import_session_report"]) {
      expect(
        (
          await local.callTool({
            name: old,
            arguments: { session_id: s.batch_id },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await remote.client.callTool({
            name: old,
            arguments: { session_id: s.batch_id },
          })
        ).isError,
      ).toBe(true);
    }
    expect(
      (
        await local.callTool({
          name: "intake_batch_status",
          arguments: { session_id: s.batch_id },
        })
      ).isError,
    ).toBe(true);
    for (const name of ["intake_batch_status", "intake_batch_report"]) {
      const args = {
        batch_id: s.batch_id,
        ...(name.endsWith("report") ? { limit: 1 } : {}),
      };
      const actual = await remote.client.callTool({ name, arguments: args });
      expect(actual.isError).not.toBe(true);
      expect(structured(actual)).toEqual(
        structured(await local.callTool({ name, arguments: args })),
      );
      if (name.endsWith("report")) {
        const result = (
          structured(actual) as {
            result: { next_cursor: string; items: unknown[] };
          }
        ).result;
        expect(result.items).toHaveLength(1);
        expect(result.next_cursor).toBeTypeOf("string");
        const second = await remote.client.callTool({
          name,
          arguments: { ...args, cursor: result.next_cursor },
        });
        expect(second.isError).not.toBe(true);
        expect(structured(second)).toMatchObject({
          result: { items: [expect.any(Object)], next_cursor: null },
        });
      }
    }
    expect(db.prepare("SELECT * FROM library_state_revision").all()).toEqual(
      before,
    );
    db.close();
  } finally {
    await local.close();
    await localHost.close();
    await f.close();
  }
}, 30000);

it("refuses missing/invalid/purpose-only credentials and every forbidden tool on calls as well as lists", async () => {
  const f = await fixture();
  try {
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    };
    for (const secret of [null, "invalid"])
      expect((await f.rpc(secret, init)).status).toBe(401);
    for (const purpose of ["intake"] as const) {
      const paired = await f.token([purpose]);
      expect((await f.rpc(paired.token, init)).status).toBe(403);
    }
    const paired = await f.token(["read", "operate"]),
      remote = await f.connect(paired.token);
    const forbidden = [
      ...QUERY_TOOLS.filter((tool) => tool.name.startsWith("configuration_")),
      ...MAINTENANCE_TOOLS.filter((tool) =>
        tool.name.startsWith("configuration_"),
      ),
      ...BROWSER_QUERY_TOOLS,
      ...BROWSER_MAINTENANCE_TOOLS,
      ...[
        "import_bibliography",
        "begin_pdf_upload",
        "append_pdf_upload",
        "commit_pdf_upload",
        "discard_pdf_upload",
        "device_connections",
        "device_revoke",
      ].map((name) => ({ name })),
    ];
    for (const tool of forbidden) {
      const result = await remote.client.callTool({
        name: tool.name,
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        result: { failure: { code: "device-purpose-forbidden" } },
      });
    }
    const stolen = await f.token(["read"]);
    const attempted = await f.rpc(
      stolen.token,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      remote.transport.sessionId,
    );
    expect(attempted.status).toBe(403);
    const noToken = await f.rpc(
      null,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      remote.transport.sessionId,
    );
    expect(noToken.status).toBe(401);
    const url = await fetch(f.http.origin + "/mcp?token=" + paired.token, {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    expect(url.status).toBe(400);
  } finally {
    await f.close();
  }
}, 30000);

it("immediately invalidates established sessions on revocation, cancels an active call, and keeps borrowed Web owners alive", async () => {
  const f = await fixture();
  try {
    const paired = await f.token(["read"]),
      remote = await f.connect(paired.token);
    let began!: () => void, aborted!: () => void;
    const started = new Promise<void>((r) => {
        began = r;
      }),
      cancelled = new Promise<void>((r) => {
        aborted = r;
      });
    vi.spyOn(f.query.query!, "counts").mockImplementation(
      async (_query, signal) => {
        began();
        return new Promise((_resolve, reject) => {
          const end = () => {
            aborted();
            reject(new Error("Synthetic cancellation"));
          };
          signal!.addEventListener("abort", end, { once: true });
          if (signal!.aborted) end();
        });
      },
    );
    const pending = remote.client
      .callTool({ name: "library_counts", arguments: { query: {} } })
      .then(
        () => "completed",
        () => "disconnected",
      );
    await started;
    await f.app.deviceConnections.revoke({
      connection_id: paired.connection.connection_id,
    });
    await cancelled;
    expect(await pending).toBe("disconnected");
    expect(
      (
        await f.rpc(
          paired.token,
          { jsonrpc: "2.0", id: 5, method: "tools/list" },
          remote.transport.sessionId,
        )
      ).status,
    ).toBe(401);
    expect((await f.app.importSessions.list()).items).toEqual([]);
    expect(
      (
        await f.query.query!.search({
          query: {},
          limit: 1,
          cursor: null,
          sort: "intake-desc",
        })
      ).items,
    ).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30000);

it("bounds HTTP sessions and request bytes, expires idle sessions, and closes active SSE when the service stops", async () => {
  let now = Date.now();
  const f = await fixture({
    now: () => now,
    limits: { sessions: 1, sessions_per_device: 1, idle_ms: 1000 },
  });
  try {
    const paired = await f.token(["read"]),
      remote = await f.connect(paired.token);
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    };
    const limited = await f.rpc(paired.token, init);
    expect(limited.status).toBe(429);
    // The open session holds a stream: the slot frees a full idle time after it closes.
    expect(limited.headers.get("retry-after")).toBe("1");
    const refusal = (await limited.json()) as {
      error: { message: string; data: Record<string, unknown> };
    };
    expect(refusal.error.data).toMatchObject({
      code: "mcp-session-limit",
      open_sessions: 1,
      limit: 1,
      scope: "device",
      retry_after_s: 1,
    });
    expect(refusal.error.message).toContain("DELETE /mcp");
    expect(refusal.error.message).toContain("Mcp-Session-Id");
    // Close the client's standalone SSE before checking the idle deadline.
    await remote.client.close();
    now += 2000;
    const replacement = await vi.waitFor(
      async () => {
        now += 2000;
        return f.connect(paired.token);
      },
      { timeout: 20000, interval: 50 },
    );
    expect(replacement.transport.sessionId).not.toBe(
      remote.transport.sessionId,
    );
    const old = await f.rpc(
      paired.token,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      remote.transport.sessionId,
    );
    expect(old.status).toBe(404);
    const huge = await fetch(f.http.origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paired.token}`,
        "Content-Type": "application/json",
      },
      body: " ".repeat(10 * 1024 * 1024 + 1),
    });
    expect(huge.status).toBe(413);
    await f.http.close();
    await expect(replacement.client.listTools()).rejects.toThrow();
    expect(
      (
        await f.query.query!.search({
          query: {},
          limit: 1,
          cursor: null,
          sort: "intake-desc",
        })
      ).items,
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

it("rechecks revocation after a request body arrives instead of trusting the earlier authentication snapshot", async () => {
  const f = await fixture();
  let req: ReturnType<typeof httpRequest> | undefined;
  try {
    const paired = await f.token(["read"]);
    let admitted!: () => void;
    const authenticated = new Promise<void>((r) => {
      admitted = r;
    });
    const original = f.app.deviceConnections.authenticate.bind(
      f.app.deviceConnections,
    );
    vi.spyOn(f.app.deviceConnections, "authenticate").mockImplementation(
      async (secret) => {
        const value = await original(secret);
        admitted();
        return value;
      },
    );
    const pending = new Promise<number>((resolve, reject) => {
      req = httpRequest(
        new URL("/mcp", f.http.origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paired.token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      req.on("error", reject);
      req.write('{"jsonrpc":"2.0","id":1,');
    });
    await authenticated;
    await f.app.deviceConnections.revoke({
      connection_id: paired.connection.connection_id,
    });
    req!.end(
      '"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}',
    );
    expect(await pending).toBe(401);
  } finally {
    req?.destroy();
    vi.restoreAllMocks();
    await f.close();
  }
}, 30000);

it("keeps token and Cookie material out of SDK context, tool results, audit rows and logs", async () => {
  const f = await fixture();
  const logs: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  try {
    const paired = await f.token(["read", "operate"]);
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    const captured: string[] = [];
    vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementation(function (
      this: StreamableHTTPServerTransport,
      req,
      res,
      body,
    ) {
      captured.push(
        JSON.stringify({ headers: req.headers, rawHeaders: req.rawHeaders }),
      );
      return original.call(this, req, res, body);
    });
    const remote = await f.connect(paired.token, paired.token);
    const output = await remote.client.callTool({
      name: "folders_manage",
      arguments: {
        operation: "create",
        request: { name: "Safe folder", parent_id: null },
      },
    });
    expect(output.isError).not.toBe(true);
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
      readOnly: true,
    });
    let audit: string;
    try {
      audit = JSON.stringify(
        db.prepare("SELECT * FROM operation_records").all(),
      );
    } finally {
      db.close();
    }
    for (const value of [...captured, JSON.stringify(output), audit!, ...logs])
      expect(value.includes(paired.token)).toBe(false);
    for (const value of captured) {
      expect(/authorization|cookie/iu.test(value)).toBe(false);
    }
    expect(captured.length).toBeGreaterThan(1);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30000);

it("runs an operate discovery through the existing task owner with MCP/device attribution and no external service", async () => {
  const open = vi.fn(() => ({
    pull_raw_item: () => null,
    convert_raw_item: () => ({ observations: [], relations: [] }),
  }));
  const f = await fixture(undefined, {
    topic_search_ports: [
      { provider_name: "crossref", open_topic_search: open },
    ],
  });
  try {
    const paired = await f.token(["operate"]),
      remote = await f.connect(paired.token);
    const response = await remote.client.callTool({
      name: "discover_metadata",
      arguments: {
        query: "synthetic-only",
        year_from: null,
        year_to: null,
        providers: [{ provider_name: "crossref", scan_limit: 1 }],
      },
    });
    expect(response.isError).not.toBe(true);
    expect(open).toHaveBeenCalledOnce();
    const result = (
      structured(response) as { result: { intake_batch_id: string } }
    ).result;
    expect(
      await f.app.library.intakeBatches({
        operation: "get",
        request: { batch_id: result.intake_batch_id },
      }),
    ).toMatchObject({
      origin: "mcp",
      kind: "topic",
      state: "finished",
      result: "completed",
      initiated_by: `device:${paired.connection.connection_id}`,
    });
  } finally {
    await f.close();
  }
}, 30000);
