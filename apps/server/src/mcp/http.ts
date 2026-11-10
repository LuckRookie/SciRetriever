import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  parseStrictJsonObject,
  type DeviceConnection,
} from "@sciretriever/contracts";
import {
  createQueryApplication,
  type Application,
  type QueryApplication,
} from "../bootstrap/application.js";
import { createLogger } from "../logging/index.js";
import { requireDevicePurpose } from "../workbench/device-connections.js";
import type { DeviceRoute } from "../workbench/device-http.js";
import { createMcpServer } from "./server.js";

import { SdkTransportAdapter } from "./transport.js";

export const MCP_HTTP_LIMITS = {
  request_bytes: 10 * 1024 * 1024,
  sessions: 64,
  sessions_per_device: 8,
  idle_ms: 30 * 60 * 1000,
} as const;
interface Session {
  readonly id: string;
  readonly connectionId: string;
  readonly host: ReturnType<typeof createMcpServer>;
  readonly transport: StreamableHTTPServerTransport;
  readonly responses: Set<ServerResponse>;
  touched: number;
  closing?: Promise<void>;
}
export interface McpHttpOptions {
  readonly now?: () => number;
  readonly limits?: {
    readonly sessions?: number;
    readonly sessions_per_device?: number;
    readonly idle_ms?: number;
  };
}
function failure(
  res: ServerResponse,
  status: number,
  code: string,
  rpc = -32000,
) {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  if (status === 429) res.setHeader("Retry-After", "60");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: rpc, message: "MCP request rejected", data: { code } },
    }),
  );
}
async function body(req: IncomingMessage) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      String(req.headers["content-type"]),
    ) ||
    req.headers["content-encoding"] !== undefined
  )
    throw new Error("invalid");
  if (
    Number(req.headers["content-length"] ?? 0) > MCP_HTTP_LIMITS.request_bytes
  ) {
    req.resume();
    throw Object.assign(new Error("large"), { code: "mcp-request-too-large" });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > MCP_HTTP_LIMITS.request_bytes) {
      req.resume();
      throw Object.assign(new Error("large"), {
        code: "mcp-request-too-large",
      });
    }
    chunks.push(Buffer.from(chunk));
  }
  return parseStrictJsonObject(Buffer.concat(chunks));
}
/** The SDK receives protocol headers only, after authentication has completed. */
function protocolHeaders(req: IncomingMessage) {
  const allowed = new Set([
    "host",
    "accept",
    "content-type",
    "content-length",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
  ]);
  req.rawHeaders = req.rawHeaders.flatMap((value, index, all) =>
    index % 2 === 0 && allowed.has(value.toLowerCase())
      ? [value, all[index + 1]!]
      : [],
  );
  for (const key of Object.keys(req.headers))
    if (!allowed.has(key)) delete req.headers[key];
}
/** HTTP transport sessions contain protocol state only; all facts remain in borrowed owners. */
export class McpHttpService {
  private readonly sessions = new Map<string, Session>();
  private readonly finishing = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly limits;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly logger = createLogger("mcp-http");
  private ownQuery: Promise<QueryApplication> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly app: Application,
    private readonly query?: QueryApplication,
    options: McpHttpOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.limits = { ...MCP_HTTP_LIMITS, ...options.limits };
    this.unsubscribe = app.deviceConnections.onRevoked((id) => {
      for (const session of this.sessions.values())
        if (session.connectionId === id) this.retire(session);
    });
  }
  private reading() {
    if (this.query) return Promise.resolve(this.query);
    this.ownQuery ??= createQueryApplication(this.app.home, {
      catalog_path:
        this.app.configuration.paths.catalog_path ??
        join(this.app.home, "catalog.sqlite"),
      artifact_root:
        this.app.configuration.paths.artifact_root ??
        join(this.app.home, "artifacts"),
    });
    return this.ownQuery;
  }
  private retire(session: Session) {
    if (session.closing) return session.closing;
    this.sessions.delete(session.id);
    // Abort active requests before awaiting a non-cancellable committed operation.
    for (const res of session.responses) res.destroy();
    session.closing = session.host.close();
    this.finishing.add(session.closing);
    void session.closing.then(
      () => this.finishing.delete(session.closing!),
      () => {
        this.finishing.delete(session.closing!);
        this.logger.warn("MCP session cleanup failed");
      },
    );
    return session.closing;
  }
  private sweep() {
    for (const session of this.sessions.values())
      if (
        !session.responses.size &&
        this.now() - session.touched >= this.limits.idle_ms
      )
        this.retire(session);
  }
  routes(): DeviceRoute[] {
    return (["GET", "POST", "DELETE"] as const).map((method) => ({
      method,
      path: "/mcp",
      purposes: ["read", "operate"],
      handle: (req, res, connection) => this.handle(req, res, connection),
    }));
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    connection: DeviceConnection,
  ) {
    if (this.closed) {
      failure(res, 503, "mcp-unavailable");
      return;
    }
    this.sweep();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let payload: Record<string, unknown> | undefined;
    if (req.method === "POST") {
      try {
        payload = await body(req);
      } catch (error) {
        const large =
          !!error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "mcp-request-too-large";
        if (large) res.setHeader("Connection", "close");
        failure(
          res,
          large ? 413 : 400,
          large ? "mcp-request-too-large" : "mcp-input-invalid",
          -32700,
        );
        return;
      }
    }
    // Re-check the public owner after body collection: revocation may have happened during upload.
    connection = (
      await this.app.deviceConnections.requireActive(connection.connection_id)
    ).connection;
    requireDevicePurpose(connection, ["read", "operate"]);
    const header = req.headers["mcp-session-id"];
    let session =
      typeof header === "string" ? this.sessions.get(header) : undefined;
    if (header !== undefined && !session) {
      failure(res, 404, "mcp-session-missing");
      return;
    }
    if (session && session.connectionId !== connection.connection_id) {
      failure(res, 403, "device-purpose-forbidden");
      return;
    }
    if (!session) {
      if (req.method !== "POST" || !isInitializeRequest(payload)) {
        failure(res, 400, "mcp-session-required");
        return;
      }
      if (
        this.sessions.size >= this.limits.sessions ||
        [...this.sessions.values()].filter(
          (s) => s.connectionId === connection.connection_id,
        ).length >= this.limits.sessions_per_device
      ) {
        failure(res, 429, "mcp-session-limit");
        return;
      }
      if (!this.timer) {
        this.timer = setInterval(() => this.sweep(), 60_000);
        this.timer.unref();
      }
      const id = randomUUID();
      const host = createMcpServer({
        home: this.app.home,
        maintenance: true,
        sharedApplications: true,
        deviceAccess: {
          purposes: connection.purposes,
          actor: `mcp:device:${connection.connection_id}`,
          authorize: async () =>
            (
              await this.app.deviceConnections.requireActive(
                connection.connection_id,
              )
            ).connection.purposes,
        },
        applicationFactory: async () => this.app,
        queryFactory: () => this.reading(),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        enableJsonResponse: true,
      });
      session = {
        id,
        connectionId: connection.connection_id,
        host,
        transport,
        responses: new Set(),
        touched: this.now(),
      };
      this.sessions.set(id, session);
      const opened = session;
      host.server.onclose = () => {
        this.retire(opened);
      };
      await host.connect(new SdkTransportAdapter(transport));
    }
    const current = session;
    if (current.closing || this.closed) {
      failure(res, 503, "mcp-unavailable");
      return;
    }
    if (req.method !== "DELETE") current.responses.add(res);
    const ended = () => {
      current.responses.delete(res);
      current.touched = this.now();
    };
    res.once("close", ended);
    res.once("finish", ended);
    protocolHeaders(req);
    try {
      await current.transport.handleRequest(req, res, payload);
    } catch {
      failure(res, 503, "mcp-unavailable");
    } finally {
      if (!current.transport.sessionId) this.retire(current);
      if (req.method === "DELETE") this.retire(current);
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      this.unsubscribe();
      await Promise.allSettled(
        [...this.sessions.values()].map((s) => this.retire(s)),
      );
      await Promise.allSettled([...this.finishing]);
      if (this.ownQuery) {
        const opened = await Promise.allSettled([this.ownQuery]);
        if (opened[0]?.status === "fulfilled") await opened[0].value.close();
      }
    })();
    return this.closing;
  }
}
