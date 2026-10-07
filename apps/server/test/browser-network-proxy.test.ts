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
async function proxy(
  ports: number[],
  maxResponseBytes = 1024,
  addresses = ["127.0.0.1"],
) {
  const resolved: string[] = [];
  const owner = new BrowserNetworkProxy({
    resolver: (host) => {
      resolved.push(host);
      return addresses;
    },
    policy: {
      allowed_schemes: ["http", "https"],
      allowed_classes: ["loopback"],
      allowed_addresses: addresses,
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
  it("streams the first bytes before the origin completes and keeps an active transfer past connection timeout", async () => {
    let firstByte!: () => void;
    const observed = new Promise<void>((resolve) => {
      firstByte = resolve;
    });
    let finished = false;
    const origin = httpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.write("%PDF-1.7\n");
      void observed.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        finished = true;
        res.end("%%EOF");
      });
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          origin.closeAllConnections();
          origin.close(() => resolve());
        }),
    );
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const p = await proxy([address.port]);
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        p.connection.server,
        {
          path: `http://fixture.test:${address.port}/stream`,
          headers: { "proxy-authorization": auth(p.connection) },
        },
        (res) => {
          let received = "";
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => {
            if (!received) {
              expect(finished).toBe(false);
              firstByte();
            }
            received += chunk.toString();
          });
          res.on("end", () => resolve(received));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("%PDF-1.7\n%%EOF");
  });

  it("aborts the downstream response when a streamed origin truncates instead of completing a partial PDF", async () => {
    const origin = httpServer((_req, res) => {
      res.writeHead(200, { "content-length": "128" });
      res.write("%PDF-1.7\n");
      setTimeout(() => res.destroy(), 30);
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    cleanup.push(
      () => new Promise<void>((resolve) => origin.close(() => resolve())),
    );
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const p = await proxy([address.port]);
    await expect(
      new Promise((resolve, reject) => {
        const req = request(
          p.connection.server,
          {
            path: `http://fixture.test:${address.port}/truncated`,
            headers: { "proxy-authorization": auth(p.connection) },
          },
          (res) => {
            res.resume();
            res.on("error", reject);
            res.on("end", resolve);
          },
        );
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toThrow();
  });
  it("authenticates, falls back across admitted address families, and never forwards proxy credentials", async () => {
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
    const p = await proxy([address.port], 1024, ["::1", "127.0.0.1"]);
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

it("does not let idle CONNECT tunnels occupy all request permits or expire active traffic", async () => {
  const sockets = new Set<Socket>();
  const origin = tcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (bytes) => socket.write(bytes));
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        origin.close(() => resolve());
      }),
  );
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  const p = await proxy([address.port]);
  const tunnels: Socket[] = [];
  for (let index = 0; index < 4; index++) {
    const socket = await connect(p.connection, `fixture.test:${address.port}`);
    expect(String((await once(socket, "data"))[0])).toContain(
      "200 Connection Established",
    );
    tunnels.push(socket);
  }
  const active = tunnels.at(-1)!;
  // More than a single response limit over a connection, for longer than one
  // connection timeout: neither limit describes multiplexed/keepalive traffic.
  for (let index = 0; index < 5; index++) {
    await new Promise((resolve) => setTimeout(resolve, 260));
    const response = once(active, "data");
    active.write(Buffer.alloc(512, 1));
    expect((await response)[0]).toHaveLength(512);
  }
});

it("keeps browser navigation capabilities ephemeral while strict locators still reject them", async () => {
  const { resolveBrowserDestination, normalizeUrl } = await import(
    "../src/network/policy.js"
  );
  const policy = { allowed_schemes: ["http", "https"] as const };
  const url =
    "https://download.example/paper%2Fmain.pdf?token=synthetic%2Fvalue&key=synthetic";
  expect(() => normalizeUrl(url)).toThrow();
  expect(
    (await resolveBrowserDestination(url, () => ["8.8.8.8"], policy)).url.url,
  ).toBe(url);
  expect(
    (
      await resolveBrowserDestination(
        "http://article.example/path",
        () => ["8.8.8.8"],
        policy,
      )
    ).url.scheme,
  ).toBe("http");
  for (const unsafe of [
    "https://user:pass@article.example/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://article.example/%0aheader",
  ]) {
    await expect(
      resolveBrowserDestination(unsafe, () => ["8.8.8.8"], policy),
    ).rejects.toThrow();
  }
  await expect(
    resolveBrowserDestination(url, () => ["10.0.0.1"], policy),
  ).rejects.toThrow();
});
