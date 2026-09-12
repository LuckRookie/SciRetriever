import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  createServer as createTlsServer,
  connect as tlsConnect,
  type TLSSocket,
} from "node:tls";

import { describe, expect, it } from "vitest";

import {
  bindSocketAddress,
  classifyAddress,
  evaluateRedirect,
  NetworkPolicyError,
  normalizeUrl,
  resolveDestination,
} from "../src/network/policy.js";
import {
  connectVerified,
  NetworkConnectionError,
} from "../src/network/connection.js";
import { requestOnce } from "../src/network/http.js";

const publicPolicy = { allowed_schemes: ["https"] as const };
const loopbackPolicy = {
  allowed_schemes: ["http", "https"] as const,
  allowed_classes: ["loopback"] as const,
  allowed_addresses: ["127.0.0.1"] as const,
  allowed_ports: [
    { scheme: "http" as const, port: 80 },
    { scheme: "https" as const, port: 443 },
  ],
};
const execFileAsync = promisify(execFile);

describe("network destination admission", () => {
  it("normalizes safe URLs and rejects userinfo, query credentials, and traversal", () => {
    expect(
      normalizeUrl("https://Example.test/articles/1", publicPolicy).url,
    ).toBe("https://example.test/articles/1");
    expect(() =>
      normalizeUrl("https://user:pass@example.test", publicPolicy),
    ).toThrow(NetworkPolicyError);
    expect(() =>
      normalizeUrl("https://example.test/a/../b", publicPolicy),
    ).toThrow(NetworkPolicyError);
    expect(() =>
      normalizeUrl("https://example.test/a/%2f/b", publicPolicy),
    ).toThrow(NetworkPolicyError);
    expect(() =>
      normalizeUrl("https://example.test/a/%252e%252e/b", publicPolicy),
    ).toThrow(NetworkPolicyError);
    expect(() =>
      normalizeUrl("https://example.test/a/%E2%80%8B/b", publicPolicy),
    ).toThrow(NetworkPolicyError);
    expect(() =>
      normalizeUrl("https://example.test:0443/articles/1", publicPolicy),
    ).toThrow(NetworkPolicyError);
    expect(() =>
      normalizeUrl("https://example.test/?token=secret", publicPolicy),
    ).toThrow(NetworkPolicyError);
    expect(() => normalizeUrl("https://127.1", publicPolicy)).toThrow(
      NetworkPolicyError,
    );
  });

  it("classifies private, loopback, reserved, and public addresses", () => {
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("10.0.0.1")).toBe("private");
    expect(classifyAddress("192.0.2.1")).toBe("reserved");
    expect(classifyAddress("93.184.216.34")).toBe("public");
    expect(() => classifyAddress("127.1")).toThrow(NetworkPolicyError);
  });

  it("requires every DNS answer to satisfy the address policy and rejects rebinding", async () => {
    await expect(
      resolveDestination(
        "https://mixed.example",
        () => ["93.184.216.34", "10.0.0.1"],
        publicPolicy,
      ),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    const first = await resolveDestination(
      "https://stable.example",
      () => ["93.184.216.34"],
      publicPolicy,
    );
    await expect(
      resolveDestination(
        first.url,
        () => ["93.184.216.35"],
        publicPolicy,
        first,
      ),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it("admits explicit loopback policy and returns fixed socket IP with TLS SNI hostname", async () => {
    const destination = await resolveDestination(
      "https://127.0.0.1/resource",
      () => [],
      loopbackPolicy,
    );
    expect(bindSocketAddress(destination)).toEqual([
      { address: "127.0.0.1", port: 443, servername: "127.0.0.1" },
    ]);
  });

  it("connects a loopback socket to the admitted IP and preserves TLS hostname binding", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const destination = await resolveDestination(
      `http://127.0.0.1:${port}/resource`,
      () => [],
      {
        allowed_schemes: ["http"],
        allowed_classes: ["loopback"],
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http", port }],
      },
    );
    try {
      const connected = await connectVerified(destination, "127.0.0.1");
      expect(connected.address).toBe("127.0.0.1");
      expect(connected.servername).toBeNull();
      connected.socket.destroy();
      const response = await requestOnce(destination, "127.0.0.1");
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(response.body)).toBe("ok");
      await expect(
        connectVerified(destination, "127.0.0.2", 100),
      ).rejects.toBeInstanceOf(NetworkPolicyError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses the admitted loopback IP while TLS verifies the requested hostname", async () => {
    const directory = await mkdtemp(`${tmpdir()}/sciretriever-network-`);
    const keyPath = `${directory}/key.pem`;
    const certPath = `${directory}/cert.pem`;
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    let applicationRequests = 0;
    const server = createTlsServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      (socket) => {
        applicationRequests += 1;
        socket.on("data", () => {
          socket.end(
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\ntls",
          );
        });
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const destination = await resolveDestination(
      `https://localhost:${port}/resource`,
      () => ["127.0.0.1"],
      {
        allowed_schemes: ["https"],
        allowed_classes: ["loopback"],
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "https", port }],
      },
    );
    try {
      const certificate = await readFile(certPath);
      const connected = await connectVerified(destination, "127.0.0.1", 5_000, {
        tlsConnect: (options) => tlsConnect({ ...options, ca: certificate }),
      });
      expect(connected.address).toBe("127.0.0.1");
      expect(connected.servername).toBe("localhost");
      expect((connected.socket as TLSSocket).authorized).toBe(true);
      connected.socket.destroy();
      const response = await requestOnce(destination, "127.0.0.1", {
        timeoutMs: 5_000,
        connection: {
          tlsConnect: (options) => tlsConnect({ ...options, ca: certificate }),
        },
      });
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(response.body)).toBe("tls");
      const wrongHost = await resolveDestination(
        `https://wrong.example:${port}/resource`,
        () => ["127.0.0.1"],
        {
          allowed_schemes: ["https"],
          allowed_classes: ["loopback"],
          allowed_addresses: ["127.0.0.1"],
          allowed_ports: [{ scheme: "https", port }],
        },
      );
      await expect(
        requestOnce(wrongHost, "127.0.0.1", {
          timeoutMs: 5_000,
          connection: {
            tlsConnect: (options) =>
              tlsConnect({ ...options, ca: certificate }),
          },
        }),
      ).rejects.toBeInstanceOf(NetworkConnectionError);
      expect(applicationRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rechecks every redirect and forwards credentials only to the same or explicitly allowed origin", async () => {
    const resolver = (hostname: string) =>
      hostname === "first.example" || hostname === "second.example"
        ? ["93.184.216.34"]
        : ["10.0.0.1"];
    const first = await resolveDestination(
      "https://first.example/start",
      resolver,
      publicPolicy,
    );
    const redirected = await evaluateRedirect(
      first,
      "https://second.example/next",
      resolver,
      publicPolicy,
    );
    expect(redirected.same_origin).toBe(false);
    expect(redirected.forward_credentials).toBe(false);
    await expect(
      evaluateRedirect(
        first,
        "https://private.example/next",
        resolver,
        publicPolicy,
      ),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(
      evaluateRedirect(first, "../private", resolver, publicPolicy),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(
      evaluateRedirect(first, "/next", resolver, publicPolicy, () => {
        throw new Error("secret-bearing guard detail");
      }),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it("maps malformed runtime request options to a stable HTTP error", async () => {
    const invalidDestination = {} as never;
    await expect(
      requestOnce(invalidDestination, "127.0.0.1", null as never),
    ).rejects.toMatchObject({
      name: "NetworkHttpError",
      message: "network HTTP operation failed",
    });
    await expect(
      requestOnce(invalidDestination, "127.0.0.1", {
        headers: [null] as never,
      }),
    ).rejects.toMatchObject({
      name: "NetworkHttpError",
      message: "network HTTP operation failed",
    });
  });
});
