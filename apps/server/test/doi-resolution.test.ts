import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { createServer } from "node:https";
import {
  createConnection,
  type AddressInfo,
  type NetConnectOpts,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resolveDoiLanding } from "../src/acquisition/doi-resolution.js";
import { DEFAULT_PDF_DOWNLOAD_MAX_BYTES } from "../src/acquisition/sources/public.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import type { HttpResponse } from "../src/network/http.js";
import { publicWebService } from "../src/providers/registry.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";

const doiUrl = "https://doi.org/10.5555/fixture";
const publicAddress = "93.184.216.34";
const service = publicWebService(doiUrl);
const limits = {
  ...service.policy,
  maxResponseBytes: DEFAULT_PDF_DOWNLOAD_MAX_BYTES,
  maxRedirects: 0,
  maxRetries: 0,
};

describe("DOI first-hop acquisition resolution", () => {
  let root: string;
  let certificate: Buffer;
  let server: ReturnType<typeof createServer>;
  let port: number;
  let coordinator: NetworkBudgetCoordinator;
  let now: number;
  let respond: (request: IncomingMessage, response: ServerResponse) => void;
  const received: {
    host: string | undefined;
    path: string | undefined;
    method: string | undefined;
  }[] = [];
  const resolver = vi.fn((hostname: string) => {
    expect(hostname).toBe("doi.org");
    return [publicAddress];
  });
  const connection = {
    connect: vi.fn((options: NetConnectOpts) => {
      expect(options).toEqual({ host: publicAddress, port: 443 });
      return createConnection({ host: "127.0.0.1", port });
    }),
    tlsConnect: (options: ConnectionOptions) =>
      tlsConnect({ ...options, ca: certificate }),
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sciretriever-doi-resolution-"));
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=doi.org",
      "-addext",
      "subjectAltName=DNS:doi.org",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    certificate = await readFile(cert);
    server = createServer(
      { key: await readFile(key), cert: certificate },
      (request, response) => {
        received.push({
          host: request.headers.host,
          path: request.url,
          method: request.method,
        });
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        respond(request, response);
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  beforeEach(() => {
    now = 0;
    coordinator = new NetworkBudgetCoordinator({
      now: () => now,
      setTimeout,
      clearTimeout,
    });
    received.length = 0;
    resolver.mockClear();
    connection.connect.mockClear();
    respond = (_request, response) => {
      response.writeHead(302, {
        location: "https://publisher.example/article",
      });
      response.end();
    };
  });

  afterEach(() => {
    coordinator.close();
    server.closeAllConnections();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const resolve = (
    onResponse?: (response: HttpResponse) => void,
    signal = new AbortController().signal,
  ) =>
    resolveDoiLanding(doiUrl, coordinator, signal, {
      resolver,
      connection,
      ...(onResponse ? { on_response: onResponse } : {}),
    });

  it.each([301, 302, 303, 307, 308])(
    "returns a %i Location without resolving or requesting the publisher",
    async (status) => {
      const location =
        "https://publisher.example/article.PDF?download=1&id=paper%2B1#page=3";
      respond = (_request, response) => {
        response.writeHead(status, { location });
        response.end();
      };
      const observed = vi.fn();
      await expect(resolve(observed)).resolves.toBe(location.split("#")[0]);
      expect(resolver).toHaveBeenCalledExactlyOnceWith("doi.org");
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(received).toEqual([
        { host: "doi.org", path: "/10.5555/fixture", method: "GET" },
      ]);
      expect(observed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status }),
      );
    },
  );

  it.each([
    ["/article?download=1#view=FitH", "https://doi.org/article?download=1"],
    ["article", "https://doi.org/10.5555/article"],
    ["//publisher.example/article", "https://publisher.example/article"],
    ["http://publisher.example/article", "http://publisher.example/article"],
    ["#page=1", doiUrl],
  ])(
    "retains safe relative or HTTP Location %s without a second hop",
    async (location, expected) => {
      respond = (_request, response) => {
        response.writeHead(302, { location });
        response.end();
      };
      await expect(resolve()).resolves.toBe(expected);
      expect(received).toHaveLength(1);
      expect(resolver).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 204, 302, 403, 404, 410])(
    "retains the %i response without a usable redirect for later delivery classification",
    async (status) => {
      const body = new TextEncoder().encode(
        '<html><a href="/article.pdf">PDF</a></html>',
      );
      respond = (_request, response) => {
        response.writeHead(status, { "content-type": "text/html" });
        response.end(body);
      };
      const observed: HttpResponse[] = [];
      await expect(
        resolve((response) => observed.push(response)),
      ).resolves.toBeNull();
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ status });
      if (status !== 204) expect(observed[0]!.body).toEqual(body);
      expect(received).toHaveLength(1);
    },
  );

  it("keeps an already-delivered PDF larger than the former locator limit, including rate feedback", async () => {
    const pdf = new Uint8Array(
      Buffer.concat([workbenchPdf(), Buffer.alloc(1024 * 1024 + 1, 32)]),
    );
    respond = (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "retry-after": "60",
      });
      response.end(pdf);
    };
    const observed: HttpResponse[] = [];
    await expect(
      resolve((response) => observed.push(response)),
    ).resolves.toBeNull();
    expect(Buffer.from(observed[0]!.body).equals(pdf)).toBe(true);
    expect(received).toHaveLength(1);
    now = 10_000;
    await expect(
      coordinator.acquire(service.quotaGroup, "sibling.example", limits, {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "network-budget" });
  });

  it.each([
    { status: 429, retry: undefined, code: "rate-limited", independent: true },
    { status: 302, retry: "60", code: "rate-limited", independent: true },
    { status: 503, retry: "60", code: "rate-limited", independent: true },
    {
      status: 503,
      retry: undefined,
      code: "http-response-failed",
      independent: true,
    },
  ])(
    "reports $status feedback before classification and shares the service cooldown",
    async ({ status, retry, code, independent }) => {
      respond = (_request, response) => {
        response.writeHead(status, {
          location: "https://publisher.example/article",
          ...(retry ? { "retry-after": retry } : {}),
        });
        response.end("private response body");
      };
      const observed = vi.fn();
      await expect(resolve(observed)).rejects.toMatchObject({
        code,
        allows_independent_fallback: independent,
      });
      expect(observed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status }),
      );
      now = 10_000;
      await expect(
        coordinator.acquire(service.quotaGroup, "sibling.example", limits, {
          timeoutMs: 20,
        }),
      ).rejects.toMatchObject({ code: "network-budget" });
      expect(received).toHaveLength(1);
    },
  );

  it("preserves authentication failure evidence while allowing independent sources", async () => {
    respond = (_request, response) => {
      response.writeHead(401);
      response.end();
    };
    const observed = vi.fn();
    await expect(resolve(observed)).rejects.toMatchObject({
      code: "http-response-failed",
      retryable: false,
      allows_independent_fallback: true,
    });
    expect(observed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("uses the existing DOI service permit and cancels while queued without a socket", async () => {
    const permit = await coordinator.acquire(
      service.quotaGroup,
      "doi.org",
      limits,
    );
    const controller = new AbortController();
    const acquire = vi.spyOn(coordinator, "acquire");
    const pending = resolve(undefined, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      reason: "cancelled",
    });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    expect(connection.connect).not.toHaveBeenCalled();
    controller.abort();
    await rejected;
    permit.release();
    expect(received).toHaveLength(0);
  });

  it("checks pre-cancellation before parsing, DNS, quota or connection", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Fixture cancelled", "AbortError");
    controller.abort(reason);
    const acquire = vi.spyOn(coordinator, "acquire");
    await expect(
      resolveDoiLanding("not a URL", coordinator, controller.signal, {
        resolver,
        connection,
      }),
    ).rejects.toBe(reason);
    expect(resolver).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(connection.connect).not.toHaveBeenCalled();
  });

  it("checks cancellation after DNS before acquiring a permit", async () => {
    const controller = new AbortController();
    const acquire = vi.spyOn(coordinator, "acquire");
    const cancelledResolver = vi.fn(() => {
      controller.abort();
      return [publicAddress];
    });
    await expect(
      resolveDoiLanding(doiUrl, coordinator, controller.signal, {
        resolver: cancelledResolver,
        connection,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(acquire).not.toHaveBeenCalled();
    expect(connection.connect).not.toHaveBeenCalled();
  });

  it("cancels an in-flight response and never emits a partial body as reusable", async () => {
    const controller = new AbortController();
    respond = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html>");
      controller.abort();
    };
    const observed = vi.fn();
    await expect(resolve(observed, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(observed).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
  });

  it.each([
    "not a URL",
    "https://publisher.example/article",
    "http://doi.org/10.5555/fixture",
    "https://doi.org:444/10.5555/fixture",
    "https://user:password@doi.org/10.5555/fixture",
    "https://doi.org/10.5555/fixture?download=1",
    "https://doi.org/10.5555/fixture#page=1",
    "https://doi.org/10.5555/%2e%2e/private",
  ])("rejects invalid resolver URL %s before DNS", async (url) => {
    await expect(
      resolveDoiLanding(url, coordinator, new AbortController().signal, {
        resolver,
        connection,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(resolver).not.toHaveBeenCalled();
    expect(connection.connect).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:password@publisher.example/article",
    "https://publisher.example/article?token=fixture",
    "https://publisher.example:8443/article",
    "javascript:alert(1)",
    "file:///private/article.pdf",
    "https://127.0.0.1/article",
    "https://[::1]/article",
    "https://publisher.example/%2e%2e/article",
    "../article",
    "https:\\publisher.example\\article",
  ])(
    "keeps unsafe Location %s as a Network policy rejection",
    async (location) => {
      respond = (_request, response) => {
        response.writeHead(302, { location });
        response.end();
      };
      const observed = vi.fn();
      await expect(resolve(observed)).rejects.toMatchObject({
        code: "network-policy",
      });
      expect(observed).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledExactlyOnceWith("doi.org");
      expect(received).toHaveLength(1);
    },
  );

  it("converts malformed upstream Location into a stable independent source failure", async () => {
    respond = (_request, response) => {
      response.writeHead(302, { location: "https://[invalid" });
      response.end();
    };
    const observed = vi.fn();
    const failure = await resolve(observed).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "source-discovery-failed",
      retryable: true,
      allows_independent_fallback: true,
      cause: expect.any(TypeError),
    });
    expect(String(failure)).not.toContain("[invalid");
    expect(observed).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
  });

  it("blocks a private DNS result for doi.org before any connection", async () => {
    await expect(
      resolveDoiLanding(doiUrl, coordinator, new AbortController().signal, {
        resolver: () => ["127.0.0.1"],
        connection,
      }),
    ).rejects.toMatchObject({ code: "network-policy" });
    expect(connection.connect).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
});
