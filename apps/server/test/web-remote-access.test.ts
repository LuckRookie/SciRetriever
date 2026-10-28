import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  validateWorkbenchAccess,
  WEB_SESSION_TTL_MS,
} from "../src/workbench/access.js";
import {
  MachineWorkbenchClient,
  workbenchOrigin,
} from "../src/workbench/machine-client.js";
import { parseWebOptions } from "../src/cli/web-access.js";
import { runCli } from "../src/cli/main.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASSWORD = "synthetic-fixture-password";
const assets = new Map([
  ["/", { contentType: "text/html", body: "private workspace" }],
  ["/auth", { contentType: "text/html", body: "login form" }],
  ["/auth.js", { contentType: "text/javascript", body: "// login" }],
  ["/live.js", { contentType: "text/javascript", body: "// private" }],
]);
async function fixture(query = false) {
  const session = new ProductionWorkbenchSession(null, undefined);
  const home = query
    ? await mkdtemp(join(tmpdir(), "sciretriever-remote-auth-"))
    : undefined;
  if (home) {
    await initializeCatalogSchema(join(home, "catalog.sqlite"));
    await mkdir(join(home, "artifacts"));
  }
  const application = home
    ? await createQueryApplication(home, {
        catalog_path: join(home, "catalog.sqlite"),
        artifact_root: join(home, "artifacts"),
      })
    : undefined;
  const server = await startWorkbenchHttp({
    session,
    assets,
    access: { host: "127.0.0.2", password: PASSWORD },
    ...(application ? { query: { application } } : {}),
  });
  return {
    ...server,
    session,
    async close() {
      await server.close();
      await session.close();
      await application?.close();
      if (home) await rm(home, { recursive: true, force: true });
    },
  };
}
function request(
  origin: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      origin + path,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
async function login(origin: string, password = PASSWORD) {
  return request(origin, "/auth/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "X-Workbench-Init": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
}
function cookies(response: Awaited<ReturnType<typeof request>>): string {
  return (response.headers["set-cookie"] ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
}
async function client(origin: string) {
  const logged = await login(origin);
  expect(logged.status).toBe(200);
  const authCookie = cookies(logged);
  const root = await request(origin, "/", { headers: { Cookie: authCookie } });
  expect(root.text).toBe("private workspace");
  const cookie = `${authCookie}; ${cookies(root)}`;
  const attached = await request(origin, "/api/clients", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "X-Workbench-Init": "1",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(attached.status).toBe(201);
  const grant = JSON.parse(attached.text) as {
    client_id: string;
    csrf: string;
  };
  return { cookie, grant };
}

describe("one authenticated Web service", () => {
  describe("built CLI and its native worker", () => {
    let runBuiltCli: typeof import("../dist/cli/main.js").runCli;
    beforeAll(async () => {
      const cwd = fileURLToPath(new URL("../../..", import.meta.url));
      // Native fork resolves the worker beside the built supervisor; in-process
      // Vitest asset mocks cannot supply resources to that child process.
      await promisify(execFile)("pnpm", ["exec", "tsc", "-b"], {
        cwd,
        timeout: 90000,
      });
      await promisify(execFile)(
        process.execPath,
        ["scripts/build-workbench-assets.mjs"],
        { cwd, timeout: 90000 },
      );
      ({ runCli: runBuiltCli } = await import("../dist/cli/main.js"));
    }, 120000);
    it.each(["generated", "configured"] as const)(
      "starts the real CLI with %s credentials, no prompt, and all-interface listening",
      async (credential) => {
        const home = await mkdtemp(join(tmpdir(), "sciretriever-web-cli-"));
        const stop = new AbortController();
        let check: Promise<void> | undefined;
        let output = "";
        vi.stubEnv(
          "SCIRETRIEVER_WEB_PASSWORD",
          credential === "configured" ? PASSWORD : undefined,
        );
        try {
          const launched = await runBuiltCli(["web", "--port", "0"], {
            home,
            stdin: Readable.from([]),
            signal: stop.signal,
            stdout: (text) => {
              output += text;
              const value = JSON.parse(text) as {
                listen: string;
                url: string;
                urls: string[];
                api_key?: string;
              };
              check = (async () => {
                expect(value.listen).toMatch(/^0\.0\.0\.0:[0-9]+$/);
                expect(value.urls).toContain(value.url);
                expect(
                  value.urls.every((url) => !url.includes("0.0.0.0")),
                ).toBe(true);
                if (credential === "generated")
                  expect(value.api_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
                else expect(value.api_key).toBeUndefined();
                const origin = `http://127.0.0.1:${new URL(value.url).port}`;
                expect((await request(origin, "/")).status).toBe(303);
                expect(
                  (await login(origin, value.api_key ?? PASSWORD)).status,
                ).toBe(200);
                // Binding all interfaces also accepts a second loopback address, with the same authentication.
                const alias = origin.replace("127.0.0.1", "127.0.0.2");
                expect((await request(alias, "/api/view")).status).toBe(401);
                expect(
                  (await login(alias, value.api_key ?? PASSWORD)).status,
                ).toBe(200);
                const config = await readFile(
                  join(home, ".sciretriever", "config.toml"),
                  "utf8",
                );
                expect(config).not.toContain(value.api_key ?? PASSWORD);
              })().finally(() => stop.abort());
            },
          });
          expect(launched.code).toBe(0);
          expect(check).toBeDefined();
          await check;
          expect(output).not.toContain(PASSWORD);
          expect(process.env.SCIRETRIEVER_WEB_PASSWORD).toBeUndefined();
        } finally {
          stop.abort();
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          await rm(home, { recursive: true, force: true });
        }
      },
      15000,
    );
  });

  it("rejects an invalid supplied password before creating a library instead of silently replacing it", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-web-invalid-"));
    let output = "";
    vi.stubEnv("SCIRETRIEVER_WEB_PASSWORD", "short");
    try {
      const result = await runCli(["web", "--port", "0"], {
        home,
        stdin: Readable.from([]),
        stderr: (text) => {
          output += text;
        },
      });
      expect(result.code).toBe(2);
      expect(output).toContain("web-password-required");
      expect(output).not.toContain("short");
      expect(await readdir(home)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("has no local bypass or fixed-origin option; accepts an optional bind address", () => {
    expect(parseWebOptions([])).toEqual({
      port: 4174,
      access: { host: "0.0.0.0" },
    });
    expect(
      parseWebOptions(["--host", "192.0.2.1", "--port", "4000"]).access.host,
    ).toBe("192.0.2.1");
    expect(parseWebOptions(["--host", "0.0.0.0"]).access.host).toBe("0.0.0.0");
    for (const args of [
      ["--password", PASSWORD],
      ["--origin", "http://192.0.2.1:4174"],
      ["--port", "5", "--port", "6"],
      ["--port", "NaN"],
      ["--port", "65536"],
      ["--host", "hostname.test"],
    ])
      expect(() => parseWebOptions(args)).toThrow();
    expect(() => validateWorkbenchAccess({})).not.toThrow();
    expect(() =>
      validateWorkbenchAccess({ host: "127.0.0.1", password: PASSWORD }),
    ).not.toThrow();
    for (const password of ["", "short", "a".repeat(1025)])
      expect(() => validateWorkbenchAccess({ password })).toThrow(
        "web-password-required",
      );
    expect(workbenchOrigin("http://192.0.2.1:4174")).toBe(
      "http://192.0.2.1:4174",
    );
  });

  it("generates a fresh key per startup, protects loopback too, and accepts IP/NAT origins without configuring an allowlist", async () => {
    const session = new ProductionWorkbenchSession(null, undefined);
    let server = await startWorkbenchHttp({
      session,
      assets,
      access: { host: "127.0.0.1" },
    });
    try {
      const key = server.apiKey!;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await request(server.origin, "/")).status).toBe(303);
      const logged = await login(server.origin, key);
      expect(logged.status).toBe(200);
      expect(logged.text).not.toContain(key);
      const nat = await request(server.origin, "/auth/login", {
        method: "POST",
        headers: {
          Host: "192.0.2.99:4567",
          Origin: "http://192.0.2.99:4567",
          "X-Workbench-Init": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: key }),
      });
      expect(nat.status).toBe(200);
      expect(
        (
          await request(server.origin, "/auth/status", {
            headers: { Host: "localhost:4174" },
          })
        ).status,
      ).toBe(200);
      const machine = new MachineWorkbenchClient(server.origin);
      vi.stubEnv("SCIRETRIEVER_WEB_PASSWORD", key);
      try {
        expect(await machine.execute("view", {})).toHaveProperty(
          "article_id",
          null,
        );
      } finally {
        await machine.close();
        vi.unstubAllEnvs();
      }
      await server.close();
      server = await startWorkbenchHttp({
        session,
        assets,
        access: { host: "127.0.0.1" },
      });
      expect(server.apiKey).not.toBe(key);
      expect((await login(server.origin, key)).status).toBe(401);
      expect(
        (
          await request(server.origin, "/api/view", {
            headers: { Cookie: cookies(logged) },
          })
        ).status,
      ).toBe(401);
      expect((await login(server.origin, server.apiKey!)).status).toBe(200);
    } finally {
      await server.close();
      await session.close();
    }
  });

  it("protects HTML, files, settings, query, maintenance and Browser streams before any application read", async () => {
    const server = await fixture(true);
    try {
      const root = await request(server.origin, "/?view=lib");
      expect(root.status).toBe(303);
      expect(root.headers.location).toBe("/auth?next=%2F%3Fview%3Dlib");
      expect(root.headers["set-cookie"]).toBeUndefined();
      expect((await request(server.origin, "/auth")).text).toBe("login form");
      expect((await request(server.origin, "/auth.js")).status).toBe(200);
      for (const path of [
        "/api/clients",
        "/live.js",
        "/api/workspace",
        "/api/configuration/read",
        "/api/events",
        "/api/frame",
        "/api/v1/query/status",
        "/api/v1/maintenance/session",
      ])
        expect((await request(server.origin, path)).status, path).toBe(401);
      expect((await login(server.origin, "incorrect")).status).toBe(401);
      const first = await client(server.origin);
      const second = await client(server.origin);
      expect(
        (
          await request(
            server.origin,
            `/api/view?client_id=${first.grant.client_id}`,
            { headers: { Cookie: first.cookie } },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            server.origin,
            `/api/view?client_id=${first.grant.client_id}`,
            { headers: { Cookie: second.cookie } },
          )
        ).status,
      ).toBe(401);
      const shared = await request(
        server.origin,
        `/api/v1/query/status?client_id=${first.grant.client_id}`,
        {
          method: "GET",
          headers: {
            Cookie: first.cookie,
            Origin: server.origin,
            "X-Workbench-Csrf": first.grant.csrf,
            "Content-Type": "application/json",
          },
        },
      );
      expect(shared.status).toBe(200);
      expect(JSON.parse(shared.text)).toHaveProperty("protocol_version", 1);
      expect(
        (
          await request(
            server.origin,
            `/api/clients/disconnect?client_id=${first.grant.client_id}`,
            {
              method: "POST",
              headers: {
                Cookie: first.cookie,
                Origin: server.origin,
                "Content-Type": "application/json",
              },
              body: "{}",
            },
          )
        ).status,
      ).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("keeps exact origin and CSRF protection for login and logout; ignores spoofed forwarding headers", async () => {
    const server = await fixture();
    try {
      for (const headers of [
        { Host: "evil.test" },
        { Origin: "http://evil.test" },
        { "Sec-Fetch-Site": "same-site" },
        { "Sec-Fetch-Site": "cross-site" },
      ])
        expect(
          (await request(server.origin, "/auth", { headers })).status,
        ).toBe(403);
      expect(
        (
          await request(server.origin, "/api/view", {
            headers: {
              "X-Forwarded-For": "127.0.0.1",
              "X-Forwarded-Host": new URL(server.origin).host,
              Forwarded: "for=127.0.0.1",
            },
          })
        ).status,
      ).toBe(401);
      const logged = await login(server.origin);
      expect(logged.headers["set-cookie"]![0]).toContain(
        "HttpOnly; SameSite=Strict; Max-Age=43200",
      );
      expect(logged.text).not.toContain(PASSWORD);
      for (const path of ["/auth/login", "/auth/logout"])
        expect(
          (
            await request(server.origin, path, {
              method: "POST",
              headers: {
                Cookie: cookies(logged),
                "Content-Type": "application/json",
                Origin: server.origin,
              },
              body: "{}",
            })
          ).status,
        ).toBe(403);
      expect(
        (
          await request(server.origin, "/auth/login", {
            method: "POST",
            headers: {
              Origin: server.origin,
              "X-Workbench-Init": "1",
              "Content-Type": "application/json",
            },
            body: '{"password":"a","password":"b"}',
          })
        ).status,
      ).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("revokes a login's tabs and open Browser stream on logout without revoking another login", async () => {
    const server = await fixture();
    try {
      const first = await client(server.origin),
        second = await client(server.origin);
      const stream = await fetch(
        `${server.origin}/api/events?client_id=${first.grant.client_id}`,
        { headers: { Cookie: first.cookie } },
      );
      const reader = stream.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      const logout = await request(server.origin, "/auth/logout", {
        method: "POST",
        headers: {
          Cookie: first.cookie,
          Origin: server.origin,
          "X-Workbench-Init": "1",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(logout.status).toBe(200);
      expect(logout.headers["set-cookie"]![0]).toContain("Max-Age=0");
      while (!(await reader.read()).done) {
        /* Drain only already-buffered events. */
      }
      expect(
        (
          await request(
            server.origin,
            `/api/view?client_id=${first.grant.client_id}`,
            { headers: { Cookie: first.cookie } },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await request(
            server.origin,
            `/api/view?client_id=${second.grant.client_id}`,
            { headers: { Cookie: second.cookie } },
          )
        ).status,
      ).toBe(200);
      // Possession of the global bootstrap cookie is not a login.
      expect(
        (
          await request(server.origin, "/api/view", {
            headers: {
              Cookie: first.cookie
                .split("; ")
                .filter((v) => !v.startsWith("sr_auth_"))
                .join("; "),
            },
          })
        ).status,
      ).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("expires sessions, bounds failed attempts, and authenticates machine clients using the same password", async () => {
    const server = await fixture();
    const machine = new MachineWorkbenchClient(server.origin);
    vi.stubEnv("SCIRETRIEVER_WEB_PASSWORD", PASSWORD);
    try {
      expect(await machine.execute("view", {})).toHaveProperty(
        "article_id",
        null,
      );
      await machine.close();
      const first = await client(server.origin);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + WEB_SESSION_TTL_MS + 1);
      expect(
        (
          await request(
            server.origin,
            `/api/view?client_id=${first.grant.client_id}`,
            { headers: { Cookie: first.cookie } },
          )
        ).status,
      ).toBe(401);
      vi.restoreAllMocks();
      let limited = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const failure = await login(server.origin, "incorrect");
        if (failure.status === 429) {
          expect(failure.headers["retry-after"]).toBe("60");
          limited = true;
          break;
        }
        expect(failure.status).toBe(401);
      }
      expect(limited).toBe(true);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await machine.close();
      await server.close();
    }
  });
});
