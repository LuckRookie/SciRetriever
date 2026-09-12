import { createServer as httpServer, request } from "node:http";
import {
  createServer as tcpServer,
  createConnection,
  type Socket,
} from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserNetworkProxy,
  type BrowserProxyConnection,
} from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const auth = (connection: BrowserProxyConnection) =>
  `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`;
async function proxy(ports: number[], maxResponseBytes = 1024) {
  const resolved: string[] = [];
  const owner = new BrowserNetworkProxy({
    resolver: (host) => {
      resolved.push(host);
      return ["127.0.0.1"];
    },
    policy: {
      allowed_schemes: ["http", "https"],
      allowed_classes: ["loopback"],
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: ports.flatMap((port) => [
        { scheme: "http" as const, port },
        { scheme: "https" as const, port },
      ]),
    },
    coordinator: new NetworkBudgetCoordinator(),
    limits: {
      maxConcurrency: 2,
      maxHostConcurrency: 2,
      maxResponseBytes,
      maxRedirects: 0,
      maxRetries: 0,
    },
    timeoutMs: 1000,
  });
  const connection = await owner.start();
  cleanup.push(() => owner.close());
  return { owner, connection, resolved };
}
async function through(
  connection: BrowserProxyConnection,
  url: string,
  authorized = true,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      connection.server,
      {
        path: url,
        headers: authorized ? { "proxy-authorization": auth(connection) } : {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
async function connect(
  connection: BrowserProxyConnection,
  authority: string,
): Promise<Socket> {
  const address = new URL(connection.server);
  const socket = createConnection({
    host: address.hostname,
    port: Number(address.port),
  });
  socket.on("error", () => socket.destroy());
  cleanup.push(async () => {
    socket.destroy();
  });
  await once(socket, "connect");
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${auth(connection)}\r\n\r\n`,
  );
  return socket;
}

describe("browser DNS-pinned network proxy", () => {
  it("authenticates locally, pins admitted HTTP, and never forwards proxy credentials", async () => {
    let requests = 0;
    const origin = httpServer((req, res) => {
      requests++;
      expect(req.headers["proxy-authorization"]).toBeUndefined();
      res.end("fixture");
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    cleanup.push(
      () => new Promise<void>((resolve) => origin.close(() => resolve())),
    );
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const p = await proxy([address.port]);
    const url = `http://fixture.test:${address.port}/paper`;
    expect(await through(p.connection, url, false)).toMatchObject({
      status: 407,
    });
    expect(requests).toBe(0);
    expect(await through(p.connection, url)).toEqual({
      status: 200,
      body: "fixture",
    });
    expect(p.resolved).toEqual(["fixture.test"]);
    expect(requests).toBe(1);
    expect(
      await through(p.connection, "http://169.254.169.254/latest"),
    ).toMatchObject({ status: 502 });
    expect(requests).toBe(1);
  });
  it("preserves opaque CONNECT bytes on an admitted IP without a second DNS lookup", async () => {
    const origin = tcpServer((socket) =>
      socket.on("data", (bytes) => socket.end(bytes)),
    );
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    cleanup.push(
      () => new Promise<void>((resolve) => origin.close(() => resolve())),
    );
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const p = await proxy([address.port]);
    const socket = await connect(p.connection, `fixture.test:${address.port}`);
    const [header] = await once(socket, "data");
    expect(String(header)).toContain("200 Connection Established");
    socket.write("opaque TLS fixture bytes");
    const [bytes] = await once(socket, "data");
    expect(String(bytes)).toBe("opaque TLS fixture bytes");
    expect(p.resolved).toEqual(["fixture.test"]);
  });
  it("rejects a disallowed CONNECT before contacting the destination and closes active tunnels", async () => {
    const p = await proxy([]);
    const socket = await connect(p.connection, "169.254.169.254:443");
    await once(socket, "close");
    expect(p.resolved).toEqual([]);
    await p.owner.close();
    await p.owner.close();
  });
  it("bounds a proxied response without returning a successful partial body", async () => {
    const origin = httpServer((_req, res) => res.end("oversized fixture"));
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    cleanup.push(
      () => new Promise<void>((resolve) => origin.close(() => resolve())),
    );
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const p = await proxy([address.port], 4);
    expect(
      await through(p.connection, `http://fixture.test:${address.port}/large`),
    ).toMatchObject({ status: 502 });
  });
});
