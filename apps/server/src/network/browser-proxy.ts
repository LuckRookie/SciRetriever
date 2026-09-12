import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import {
  NetworkBudgetCoordinator,
  type BudgetLimits,
  type BudgetPermit,
} from "./budget.js";
import { requestOnce } from "./http.js";
import {
  resolveDestination,
  type DestinationPolicy,
  type Resolver,
} from "./policy.js";

export class BrowserProxyError extends Error {
  readonly code = "browser-proxy";
  constructor() {
    super("browser network operation failed");
  }
}
export interface BrowserProxyOptions {
  readonly resolver: Resolver;
  readonly policy: DestinationPolicy;
  readonly coordinator: NetworkBudgetCoordinator;
  readonly limits: BudgetLimits;
  readonly timeoutMs?: number;
}
/** A process-local capability. Never serialize this in readiness, logs or Web DTOs. */
export interface BrowserProxyConnection {
  readonly server: string;
  readonly username: string;
  readonly password: string;
}
const HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "host",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

/** DNS-pinned CONNECT preserves Chromium's own TLS and the original network exit. */
export class BrowserNetworkProxy {
  private readonly username = randomBytes(16).toString("hex");
  private readonly password = randomBytes(32).toString("hex");
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly abort = new AbortController();
  private closed = false;
  private readonly timeoutMs: number;
  constructor(private readonly options: BrowserProxyOptions) {
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120000
    )
      throw new BrowserProxyError();
  }
  async start(): Promise<BrowserProxyConnection> {
    if (this.server || this.closed) throw new BrowserProxyError();
    const server = createServer((request, response) => {
      void this.forward(request, response);
    });
    this.server = server;
    server.on("connection", (socket) => this.track(socket));
    server.on("connect", (request, socket, head) => {
      void this.tunnel(request, socket as Socket, head);
    });
    server.on("upgrade", (_request, socket) => socket.destroy());
    server.on("clientError", (_error, socket) => socket.destroy());
    server.requestTimeout = this.timeoutMs;
    server.headersTimeout = this.timeoutMs;
    server.maxHeadersCount = 100;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new BrowserProxyError();
    return Object.freeze({
      server: `http://127.0.0.1:${address.port}`,
      username: this.username,
      password: this.password,
    });
  }
  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }
  private authenticated(request: IncomingMessage): boolean {
    const actual = Buffer.from(request.headers["proxy-authorization"] ?? "");
    const expected = Buffer.from(
      `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
    );
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.authenticated(request)) {
      response.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="SciRetriever"',
      });
      response.end();
      return;
    }
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      request.destroy();
    };
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    response.once("close", cancel);
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      if (
        this.closed ||
        request.headers.upgrade ||
        !request.url?.startsWith("http://")
      )
        throw new BrowserProxyError();
      const destination = await resolveDestination(
        request.url,
        this.options.resolver,
        this.options.policy,
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of request) {
        const chunk: Buffer = Buffer.isBuffer(part)
          ? part
          : Buffer.from(part as string);
        size += chunk.byteLength;
        if (size > 1048576 || abort.signal.aborted)
          throw new BrowserProxyError();
        chunks.push(chunk);
      }
      const headers: [string, string][] = [];
      for (const [key, value] of Object.entries(request.headers)) {
        if (HOP_HEADERS.has(key) || value === undefined) continue;
        if (Array.isArray(value))
          for (const item of value) headers.push([key, item]);
        else headers.push([key, value]);
      }
      const result = await requestOnce(destination, destination.addresses[0]!, {
        method: request.method ?? "GET",
        headers,
        body: Buffer.concat(chunks),
        signal: abort.signal,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.options.limits.maxResponseBytes,
        budget: {
          coordinator: this.options.coordinator,
          scope: "browser",
          limits: this.options.limits,
        },
      });
      const outgoing: Record<string, string[]> = {};
      for (const [key, value] of result.headers)
        if (!HOP_HEADERS.has(key.toLowerCase()))
          (outgoing[key] ??= []).push(value);
      response.writeHead(result.status, outgoing);
      response.end(result.body);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    } finally {
      clearTimeout(timer);
      response.removeListener("close", cancel);
      this.abort.signal.removeEventListener("abort", cancel);
    }
  }
  private async tunnel(
    request: IncomingMessage,
    client: Socket,
    head: Buffer,
  ): Promise<void> {
    if (!this.authenticated(request)) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="SciRetriever"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    let upstream: Socket | undefined;
    let permit: BudgetPermit | undefined;
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      client.destroy();
      upstream?.destroy();
    };
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    client.once("close", cancel);
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      if (
        this.closed ||
        !request.url ||
        /[/?#@\s]/u.test(request.url) ||
        head.byteLength > 65536
      )
        throw new BrowserProxyError();
      const destination = await resolveDestination(
        `https://${request.url}/`,
        this.options.resolver,
        this.options.policy,
      );
      permit = await this.options.coordinator.acquire(
        "browser",
        destination.url.hostname,
        this.options.limits,
        { signal: abort.signal, timeoutMs: this.timeoutMs },
      );
      if (abort.signal.aborted) throw new BrowserProxyError();
      upstream = createConnection({
        host: destination.addresses[0]!,
        port: destination.url.port,
      });
      this.track(upstream);
      await once(upstream, "connect", { signal: abort.signal });
      if (abort.signal.aborted) throw new BrowserProxyError();
      const usage = permit;
      let sent = head.byteLength;
      upstream.on("data", (chunk: Buffer) => {
        try {
          usage.consumeResponse(chunk.byteLength);
        } catch {
          cancel();
        }
      });
      client.on("data", (chunk: Buffer) => {
        sent += chunk.byteLength;
        if (sent > 1048576) cancel();
      });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      await once(upstream, "close");
    } catch {
      cancel();
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", cancel);
      client.removeListener("close", cancel);
      permit?.release();
      upstream?.destroy();
      client.destroy();
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
