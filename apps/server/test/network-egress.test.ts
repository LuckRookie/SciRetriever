import {
  createServer as httpServer,
  request,
  type RequestListener,
} from "node:http";
import { createServer as tlsServer, connect as tlsConnect } from "node:tls";
import { createConnection, type Socket, type NetConnectOpts } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  connectVerified,
  NetworkConnectionError,
} from "../src/network/connection.js";
import {
  resolveDestination,
  NetworkPolicyError,
} from "../src/network/policy.js";
import {
  ProxyUnavailableError,
  observeNetworkEgress,
} from "../src/network/egress.js";
import { requestFollowingRedirects } from "../src/network/http.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { connectProxyFixture } from "./network-egress-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const publicPolicy = {
  allowed_schemes: ["http", "https"] as const,
  allowed_classes: ["public"] as const,
};
async function fixture(
  options: Parameters<typeof connectProxyFixture>[0] = {},
) {
  const p = await connectProxyFixture(options);
  cleanup.push(p.close);
  return p;
}
function pinnedProxy(port: number) {
  return (options: NetConnectOpts) => {
    if (
      !("host" in options) ||
      options.host !== "127.0.0.1" ||
      options.port !== port
    )
      throw new Error("unexpected direct connection");
    return createConnection(options);
  };
}
async function origin(handle: RequestListener) {
  const server = httpServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return address.port;
}
it("uses CONNECT for cleartext HTTP too, authenticates only the proxy, and retains requester egress on redirects", async () => {
  const targets: {
    host: string | undefined;
    auth: string | undefined;
    proxy: string | undefined;
  }[] = [];
  const port = await origin((req, res) => {
    targets.push({
      host: req.headers.host,
      auth: req.headers.authorization,
      proxy: req.headers["proxy-authorization"],
    });
    if (req.headers.host === "article.test") {
      res.writeHead(302, { location: "http://cdn.test/final" });
      res.end();
    } else res.end("fixture target body");
  });
  const p = await fixture({ targetPort: port });
  const egresses: string[] = [];
  const result = await observeNetworkEgress(
    (v) => egresses.push(v),
    () =>
      requestFollowingRedirects(
        "http://article.test/start",
        () => ["93.184.216.34"],
        publicPolicy,
        {
          egress: {
            mode: "proxy",
            proxy: {
              origin: p.origin,
              authorization: async () => "fixture-user:fixture-password",
            },
          },
          headers: [["authorization", "Bearer synthetic-target"]],
          connection: { connect: pinnedProxy(p.port) },
          maxRedirects: 2,
          maxResponseBytes: 1024,
          timeoutMs: 20000,
        },
      ),
  );
  expect(new TextDecoder().decode(result.body)).toBe("fixture target body");
  expect(p.connections).toEqual(
    ["article.test:80", "cdn.test:80"].map((authority) => ({
      authority,
      authorization: `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`,
    })),
  );
  expect(targets).toEqual([
    { host: "article.test", auth: "Bearer synthetic-target", proxy: undefined },
    { host: "cdn.test", auth: undefined, proxy: undefined },
  ]);
  expect(egresses).toEqual(["proxy", "proxy"]);
});
it.each([407, 403, 500])(
  "maps CONNECT %s to proxy-unavailable without a direct attempt",
  async (status) => {
    const p = await fixture({ status });
    let attempts = 0;
    const d = await resolveDestination(
      "https://target.test/",
      () => ["93.184.216.34"],
      publicPolicy,
    );
    await expect(
      connectVerified(
        d,
        d.addresses[0]!,
        20000,
        {
          connect: (options) => {
            attempts++;
            return pinnedProxy(p.port)(options);
          },
        },
        undefined,
        { mode: "proxy", proxy: { origin: p.origin } },
      ),
    ).rejects.toBeInstanceOf(ProxyUnavailableError);
    expect(attempts).toBe(1);
    expect(p.connections).toHaveLength(1);
  },
);
it("maps unreachable and timed out proxy peers to proxy-unavailable and cancels a pending CONNECT", async () => {
  const p = await fixture();
  await p.close();
  cleanup.pop();
  const d = await resolveDestination(
    "http://target.test/",
    () => ["93.184.216.34"],
    publicPolicy,
  );
  await expect(
    connectVerified(d, d.addresses[0]!, 20000, {}, undefined, {
      mode: "proxy",
      proxy: { origin: p.origin },
    }),
  ).rejects.toMatchObject({ code: "proxy-unavailable" });
  const hung = await fixture({ hang: true });
  await expect(
    connectVerified(d, d.addresses[0]!, 50, {}, undefined, {
      mode: "proxy",
      proxy: { origin: hung.origin },
    }),
  ).rejects.toMatchObject({ code: "proxy-unavailable" });
  const abort = new AbortController();
  const pending = connectVerified(d, d.addresses[0]!, 20000, {}, abort.signal, {
    mode: "proxy",
    proxy: { origin: hung.origin },
  });
  abort.abort();
  await expect(pending).rejects.toThrow();
});
it("rejects private target DNS before contacting the proxy and keeps admitted local services direct", async () => {
  const p = await fixture({ status: 500 });
  await expect(
    resolveDestination("http://target.test/", () => ["10.1.2.3"], publicPolicy),
  ).rejects.toBeInstanceOf(NetworkPolicyError);
  expect(p.connections).toEqual([]);
  const port = await origin((_req, res) => res.end("local"));
  const d = await resolveDestination(`http://127.0.0.1:${port}/`, () => [], {
    allowed_schemes: ["http"],
    allowed_classes: ["loopback"],
    allowed_addresses: ["127.0.0.1"],
    allowed_ports: [{ scheme: "http", port }],
  });
  const v = await connectVerified(d, "127.0.0.1", 20000, {}, undefined, {
    mode: "proxy",
    proxy: { origin: p.origin },
  });
  v.socket.destroy();
  expect(p.connections).toEqual([]);
});
it("still rejects an untrusted or wrong-name certificate behind a successful CONNECT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sciretriever-proxy-cert-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir, "key.pem"),
    cert = join(dir, "cert.pem");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=wrong.test",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  const requireCertificate = await readFile(cert);
  const sockets = new Set<Socket>();
  const server = tlsServer({
    key: await readFile(key),
    cert: await readFile(cert),
  });
  server.on("tlsClientError", () => undefined);
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  const p = await fixture({ targetPort: address.port });
  const d = await resolveDestination(
    "https://target.test/",
    () => ["93.184.216.34"],
    publicPolicy,
  );
  await expect(
    connectVerified(d, d.addresses[0]!, 20000, {}, undefined, {
      mode: "proxy",
      proxy: { origin: p.origin },
    }),
  ).rejects.toBeInstanceOf(NetworkConnectionError);
  await expect(
    connectVerified(
      d,
      d.addresses[0]!,
      20000,
      {
        tlsConnect: (options) =>
          tlsConnect({ ...options, ca: requireCertificate }),
      },
      undefined,
      { mode: "proxy", proxy: { origin: p.origin } },
    ),
  ).rejects.toBeInstanceOf(NetworkConnectionError);
  expect(p.connections[0]?.authority).toBe("target.test:443");
});
it("switches the browser loopback upstream for both HTTP and opaque CONNECT and reports proxy refusal", async () => {
  const port = await origin((req, res) => {
    expect(req.headers["proxy-authorization"]).toBeUndefined();
    res.end("browser body");
  });
  const p = await fixture({ targetPort: port });
  const budget = new NetworkBudgetCoordinator();
  cleanup.push(async () => budget.close());
  const owner = new BrowserNetworkProxy({
    egress: { mode: "proxy", proxy: { origin: p.origin } },
    resolver: () => ["93.184.216.34"],
    policy: publicPolicy,
    coordinator: budget,
    limits: {
      maxConcurrency: 2,
      maxHostConcurrency: 2,
      maxResponseBytes: 1024,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  const local = await owner.start();
  cleanup.push(() => owner.close());
  const auth = `Basic ${Buffer.from(`${local.username}:${local.password}`).toString("base64")}`;
  const response = await new Promise<string>((resolve, reject) => {
    const r = request(
      local.server,
      {
        path: "http://article.test/",
        headers: { "proxy-authorization": auth },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () => resolve(body));
      },
    );
    r.on("error", reject);
    r.end();
  });
  expect(response).toBe("browser body");
  const tunnel = await new Promise<Socket>((resolve, reject) => {
    const r = request(local.server, {
      method: "CONNECT",
      path: "article.test:443",
      headers: { "proxy-authorization": auth },
    });
    r.on("connect", (res, s) =>
      res.statusCode === 200
        ? resolve(s)
        : reject(new Error("CONNECT refused")),
    );
    r.on("error", reject);
    r.end();
  });
  cleanup.push(async () => {
    tunnel.destroy();
  });
  const reply = once(tunnel, "data");
  tunnel.write(
    "GET / HTTP/1.1\r\nHost: article.test\r\nConnection: close\r\n\r\n",
  );
  expect(String((await reply)[0])).toContain("browser body");
  expect(p.connections.map((c) => c.authority)).toEqual([
    "article.test:80",
    "article.test:443",
  ]);
  const refused = await fixture({ status: 407 });
  const blocked = new BrowserNetworkProxy({
    egress: { mode: "proxy", proxy: { origin: refused.origin } },
    resolver: () => ["93.184.216.34"],
    policy: publicPolicy,
    coordinator: budget,
    limits: {
      maxConcurrency: 1,
      maxHostConcurrency: 1,
      maxResponseBytes: 1024,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  const c = await blocked.start();
  cleanup.push(() => blocked.close());
  const rejection = await new Promise<{
    status: number | undefined;
    code: string | undefined;
  }>((resolve, reject) => {
    const r = request(c.server, {
      method: "CONNECT",
      path: "article.test:443",
      headers: {
        "proxy-authorization": `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`,
      },
    });
    r.on("connect", (res, s) => {
      s.destroy();
      resolve({
        status: res.statusCode,
        code: res.headers["x-sciretriever-network-error"] as string | undefined,
      });
    });
    r.on("error", reject);
    r.end();
  });
  expect(rejection).toEqual({ status: 502, code: "proxy-unavailable" });
  expect(blocked.failureFor("https://article.test/paper")).toBe(
    "proxy-unavailable",
  );
});

it("keeps the browser proxy-timeout diagnosis even when the downstream socket closes first", async () => {
  const p = await fixture({ hang: true });
  const budget = new NetworkBudgetCoordinator();
  cleanup.push(async () => budget.close());
  const owner = new BrowserNetworkProxy({
    egress: { mode: "proxy", proxy: { origin: p.origin } },
    resolver: () => ["93.184.216.34"],
    policy: publicPolicy,
    coordinator: budget,
    timeoutMs: 50,
    limits: {
      maxConcurrency: 1,
      maxHostConcurrency: 1,
      maxResponseBytes: 1024,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  const c = await owner.start();
  cleanup.push(() => owner.close());
  await new Promise<void>((resolve) => {
    const r = request(c.server, {
      method: "CONNECT",
      path: "article.test:443",
      headers: {
        "proxy-authorization": `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`,
      },
    });
    r.on("error", () => resolve());
    r.on("connect", (_res, s) => {
      s.destroy();
      resolve();
    });
    r.end();
  });
  expect(owner.failureFor("https://article.test/paper")).toBe(
    "proxy-unavailable",
  );
  expect(p.connections).toHaveLength(1);
});
