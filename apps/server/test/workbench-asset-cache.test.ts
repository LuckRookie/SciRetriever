import { describe, expect, it } from "vitest";
import type { QueryApplication } from "../src/bootstrap/application.js";
import {
  startQueryOnlyHttp,
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

const immutable = "private, max-age=31536000, immutable";
const hashedPaths = [
  "/assets/Agents-B4DuEN5-.css",
  "/assets/app-CZD38N4z.js",
  "/assets/font-CE15ll_G.woff2",
  "/assets/font-C8P-WZBD.woff",
];
const uncachedPaths = [
  "/",
  "/auth",
  "/auth.js",
  "/auth.css",
  "/assets/app.js",
  "/assets/app-123.js",
  "/assets/app-123456789.js",
  "/assets/page-CZD38N4z.html",
  "/assets/notices-CZD38N4z.txt",
  "/reader/app-CZD38N4z.js",
  "/reader/document-CZD38N4z.pdf",
  "/api/fixture-CZD38N4z.js",
  "/third-party-notices.txt",
];
const types: Record<string, string> = {
  js: "text/javascript",
  css: "text/css",
  woff: "font/woff",
  woff2: "font/woff2",
  html: "text/html",
  pdf: "application/pdf",
};
const assets = new Map<string, WorkbenchStaticAsset>(
  [...hashedPaths, ...uncachedPaths].map((path) => [
    path,
    {
      contentType:
        path === "/" || path === "/auth"
          ? "text/html"
          : (types[path.split(".").at(-1)!] ?? "text/plain"),
      body: `Synthetic asset: ${path}`,
    },
  ]),
);
const application: QueryApplication = {
  readiness: {
    status: "not-initialized",
    schema_version: null,
    schema_fingerprint: null,
  },
  query: null,
  literatureArtifacts: null,
  documentRead: null,
  extractionPreparation: null,
  context: null,
  knowledgeContext: null,
  close: async () => {},
};

describe.each(["workbench", "query"] as const)(
  "%s static resource cache boundary",
  (entry) => {
    it("privately caches only served hashed build assets and preserves other response policies", async () => {
      const session = new ProductionWorkbenchSession(null, undefined);
      const server =
        entry === "workbench"
          ? await startWorkbenchHttp({
              session,
              assets,
              access: workbenchTestAccess,
            })
          : await startQueryOnlyHttp({ application, assets });
      try {
        let cookie = "";
        if (entry === "workbench") {
          const auth = await workbenchLogin(server.origin);
          const home = await fetch(server.origin, {
            headers: { Cookie: auth },
          });
          expect(home.status).toBe(200);
          expect(home.headers.get("cache-control")).toBe("no-store");
          await home.text();
          cookie = [
            auth,
            ...home.headers.getSetCookie().map((value) => value.split(";")[0]),
          ].join("; ");
          const client = await fetch(`${server.origin}/api/clients`, {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: server.origin,
              "X-Workbench-Init": "1",
              "Content-Type": "application/json",
            },
            body: "{}",
          });
          expect(client.status).toBe(201);
          expect(client.headers.get("cache-control")).toBe("no-store");
          await client.text();
        }
        const headers: Record<string, string> = cookie
          ? { Cookie: cookie }
          : {};
        const home = await fetch(server.origin, { headers });
        const csp = home.headers.get("content-security-policy");
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).not.toContain("script-src 'unsafe-inline'");
        await home.text();
        for (const path of [...hashedPaths, ...uncachedPaths]) {
          const response = await fetch(server.origin + path, { headers });
          expect(response.status, path).toBe(200);
          expect(response.headers.get("cache-control"), path).toBe(
            hashedPaths.includes(path) ? immutable : "no-store",
          );
          expect(response.headers.get("content-security-policy"), path).toBe(
            csp,
          );
          expect(response.headers.get("x-content-type-options"), path).toBe(
            "nosniff",
          );
          expect(await response.text(), path).toBe(assets.get(path)!.body);
        }
        const api = await fetch(
          server.origin +
            (entry === "workbench" ? "/auth/status" : "/api/v1/query/status"),
          { headers },
        );
        expect(api.status).toBe(200);
        expect(api.headers.get("cache-control")).toBe("no-store");
        expect(await api.json()).toMatchObject(
          entry === "workbench"
            ? { authenticated: true }
            : { readiness: { status: "not-initialized" } },
        );
        const missing = await fetch(
          `${server.origin}/assets/missing-CZD38N4z.js`,
          { headers },
        );
        expect(missing.status).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("no-store");
        await missing.text();
      } finally {
        await server.close();
        await session.close();
      }
    });
  },
);

it("keeps login, unauthenticated and incomplete-session responses uncached", async () => {
  const session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    assets,
    access: workbenchTestAccess,
  });
  try {
    for (const [path, status] of [
      ["/", 303],
      ["/auth", 200],
      ["/auth.js", 200],
      ["/auth.css", 200],
      [hashedPaths[0]!, 401],
      ["/api/view", 401],
    ] as const) {
      const response = await fetch(server.origin + path, {
        redirect: "manual",
      });
      expect(response.status, path).toBe(status);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      if (status === 401)
        expect(await response.json()).toEqual({ code: "login-required" });
      else await response.text();
    }
    const auth = await workbenchLogin(server.origin);
    const response = await fetch(server.origin + hashedPaths[0]!, {
      headers: { Cookie: auth },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "authentication-required" });
  } finally {
    await server.close();
    await session.close();
  }
});

it("keeps rejected cross-origin query requests uncached", async () => {
  const server = await startQueryOnlyHttp({ application, assets });
  try {
    const response = await fetch(server.origin + hashedPaths[0]!, {
      headers: { Origin: "https://cross-origin.invalid" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      protocol_version: 1,
      code: "local-origin-required",
    });
  } finally {
    await server.close();
  }
});
