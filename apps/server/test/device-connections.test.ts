import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { expect, it } from "vitest";
import { createLogger } from "../src/logging/index.js";
import { traceSummary } from "../src/application/agent-traces.js";
import {
  parseDeviceConnectionCode,
  parseDeviceConnection,
  type DevicePurpose,
  type DeviceKind,
  type DevicePairingReceipt,
  type DeviceExchangeReceipt,
  SCREENCAST_PROTOCOL,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { DeviceConnectionService } from "../src/workbench/device-connections.js";
import { runDeviceStorage } from "../src/storage/sqlite/device-connection-engine.js";
import { SCHEMA_MANIFEST } from "../src/storage/sqlite/schema.js";
import {
  DeviceRouteRegistry,
  type DeviceRoute,
  intakeArtifactRoutes,
  deviceMaterialInUrl,
} from "../src/workbench/device-http.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

function deviceDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA_MANIFEST)
    if (/^CREATE (?:TABLE|INDEX) device_/u.test(sql)) db.exec(sql);
  return db;
}

it("allows thirty exchanges per peer without a global bucket and evicts the oldest of 256 buckets", () => {
  const db = deviceDatabase();
  try {
    const base = Date.parse("2026-11-15T00:00:00Z");
    const exchange = (peer: string, ms: number) =>
      runDeviceStorage(db, {
        kind: "exchange",
        code_sha256: "a".repeat(64),
        token_sha256: "b".repeat(64),
        peer_sha256: peer,
        now: new Date(ms).toISOString(),
      });
    for (let n = 0; n < 30; n++)
      expect(exchange("first", base)).toEqual({
        code: "device-pairing-invalid",
      });
    expect(exchange("first", base + 1)).toEqual({
      code: "device-exchange-rate-limited",
    });
    for (let n = 1; n < 256; n++)
      expect(exchange(`peer-${n}`, base + n)).toEqual({
        code: "device-pairing-invalid",
      });
    expect(
      db.prepare("SELECT count(*) n FROM device_exchange_limits").get()!.n,
    ).toBe(256);
    expect(exchange("next", base + 256)).toEqual({
      code: "device-pairing-invalid",
    });
    expect(
      db
        .prepare("SELECT 1 FROM device_exchange_limits WHERE bucket='first'")
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT count(*) n FROM device_exchange_limits").get()!.n,
    ).toBe(256);
    expect(exchange("peer-1", base + 60001)).toEqual({
      code: "device-pairing-invalid",
    });
    expect(
      db
        .prepare(
          "SELECT attempts FROM device_exchange_limits WHERE bucket='peer-1'",
        )
        .get()!.attempts,
    ).toBe(1);
  } finally {
    db.close();
  }
});

it("coalesces last_used_at writes for five minutes while checking revocation on every authentication", () => {
  const db = deviceDatabase();
  try {
    const base = Date.parse("2026-11-15T00:00:00Z"),
      token = "a".repeat(64);
    db.prepare(
      "INSERT INTO device_connections(connection_id,name,purposes_json,token_sha256,created_at,paired_at) VALUES(?,?,?,?,?,?)",
    ).run(
      "synthetic",
      "Synthetic",
      '["read"]',
      token,
      new Date(base).toISOString(),
      new Date(base).toISOString(),
    );
    const authenticate = (ms: number) =>
      runDeviceStorage(db, {
        kind: "authenticate",
        token_sha256: token,
        now: new Date(ms).toISOString(),
      });
    expect(authenticate(base)).toHaveProperty(
      "connection.last_used_at",
      new Date(base).toISOString(),
    );
    const writes = db.prepare("SELECT total_changes() n").get()!.n;
    expect(authenticate(base + 299999)).toHaveProperty(
      "connection.last_used_at",
      new Date(base).toISOString(),
    );
    expect(db.prepare("SELECT total_changes() n").get()!.n).toBe(writes);
    expect(authenticate(base + 300000)).toHaveProperty(
      "connection.last_used_at",
      new Date(base + 300000).toISOString(),
    );
    db.prepare("UPDATE device_connections SET revoked_at=?").run(
      new Date(base + 300001).toISOString(),
    );
    expect(authenticate(base + 300002)).toEqual({ code: "device-revoked" });
  } finally {
    db.close();
  }
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-devices-"));
  await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
  const catalog = join(home, "catalog.sqlite");
  await initializeCatalogSchema(catalog);
  let app = await createApplication(home, { indexRefreshIntervalMs: null });
  let now = Date.parse("2026-11-10T12:00:00Z");
  let service = new DeviceConnectionService(app.database, () => now);
  const session = new ProductionWorkbenchSession(null, undefined);
  const routeHits: string[] = [];
  const routes = new DeviceRouteRegistry([
    ...(["intake", "read", "operate"] as const).map<DeviceRoute>((p) => ({
      method: "POST" as const,
      path: `/api/v1/intake/test-${p}/:id`,
      purposes: [p],
      async handle(_req, res, connection, parameters) {
        routeHits.push(p);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: connection.connection_id,
            parameter: parameters.id,
          }),
        );
      },
    })),
    ...intakeArtifactRoutes(pathToFileURL(join(home, "download") + "/")),
  ]);
  const artifact = join(home, "download");
  await mkdir(artifact);
  const server = await startWorkbenchHttp({
    session,
    access: workbenchTestAccess,
    assets: new Map([
      ["/", { contentType: "text/html", body: "fixture" }],
      ["/auth", { contentType: "text/html", body: "login" }],
    ]),
    devices: {
      service,
      routes,
    },
  });
  const send = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(server.origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const authCookie = await workbenchLogin(server.origin);
  const root = await send("/", undefined, { Cookie: authCookie });
  const cookie =
    authCookie +
    "; " +
    root.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  const attached = await send(
    "/api/clients",
    {},
    { Cookie: cookie, Origin: server.origin, "X-Workbench-Init": "1" },
  );
  const grant = (await attached.json()) as { client_id: string; csrf: string };
  const web = (
    path: string,
    request: unknown,
    extra: Record<string, string> = {},
  ) =>
    send(
      path + "?client_id=" + grant.client_id,
      { protocol_version: 1, request },
      {
        Cookie: cookie,
        Origin: server.origin,
        "X-Workbench-Csrf": grant.csrf,
        "X-Sciretriever-Protocol-Version": "1",
        ...extra,
      },
    );
  const create = async (
    purposes: readonly DevicePurpose[] = ["intake"],
    kind?: DeviceKind,
  ) => {
    const response = await web("/api/v1/device-connections/pairings", {
      address: server.origin,
      name: "Fixture desktop",
      purposes,
      ...(kind === undefined ? {} : { kind }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).result as DevicePairingReceipt;
  };
  const pair = async (
    purposes: readonly DevicePurpose[] = ["intake"],
    kind?: DeviceKind,
  ) => {
    const pairing = await create(purposes, kind);
    const parsed = parseDeviceConnectionCode(pairing.connection_code);
    const response = await send(
      "/api/v1/device-connections/exchange",
      { pairing_code: parsed.pairing_code },
      { Origin: "chrome-extension://fixture" },
    );
    expect(response.status).toBe(200);
    return {
      pairing,
      code: parsed.pairing_code,
      ...((await response.json()).result as DeviceExchangeReceipt),
    };
  };
  return {
    home,
    catalog,
    app,
    server,
    service,
    session,
    send,
    web,
    create,
    pair,
    routeHits,
    cookie,
    clientId: grant.client_id,
    artifact,
    setNow: (value: number) => {
      now = value;
    },
    async reopen() {
      await app.close();
      app = await createApplication(home, { indexRefreshIntervalMs: null });
      service = new DeviceConnectionService(app.database, () => now);
      return service;
    },
    async close() {
      await server.close();
      await session.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

it("accepts only UTF-8 JSON Content-Type parameters without spending exchange attempts on unsupported types", async () => {
  const f = await fixture();
  try {
    const pairing = await f.create();
    const value = {
      pairing_code: parseDeviceConnectionCode(pairing.connection_code)
        .pairing_code,
    };
    const wrong = [
      "text/plain",
      "application/json; charset=gbk",
      "application/json; foo=bar",
      "application/json; charset=utf-8; charset=utf-8",
    ];
    for (let n = 0; n < 61; n++) {
      const response = await f.send(
        "/api/v1/device-connections/exchange",
        value,
        { "Content-Type": wrong[n % wrong.length]! },
      );
      expect(response.status).toBe(415);
      expect((await response.json()).code).toBe("content-type-unsupported");
    }
    const db = new DatabaseSync(f.catalog, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT count(*) n FROM device_exchange_limits").get()!.n,
      ).toBe(0);
    } finally {
      db.close();
    }
    const accepted = await f.send(
      "/api/v1/device-connections/exchange",
      value,
      { "Content-Type": "Application/JSON; CHARSET=UTF-8" },
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).result.connection.connection_id).toBe(
      pairing.connection.connection_id,
    );
    for (const contentType of [
      "application/json; charset=utf-8",
      "Application/JSON; CHARSET=UTF-8",
    ]) {
      expect(
        (
          await f.web(
            "/api/v1/device-connections",
            { cursor: null },
            { "Content-Type": contentType },
          )
        ).status,
      ).toBe(200);
    }
    const rejected = await f.web(
      "/api/v1/device-connections",
      { cursor: null },
      { "Content-Type": "application/json; foo=bar" },
    );
    expect(rejected.status).toBe(415);
    expect((await rejected.json()).code).toBe("content-type-unsupported");
  } finally {
    await f.close();
  }
}, 30000);

it("pairs once, counts malformed/used/expired attempts, and stores only derived material", async () => {
  const f = await fixture();
  try {
    const pairing = await f.create();
    const code = parseDeviceConnectionCode(
      pairing.connection_code,
    ).pairing_code;
    const responses = await Promise.all(
      [1, 2].map(() =>
        f.send("/api/v1/device-connections/exchange", { pairing_code: code }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const good = responses.find((r) => r.status === 200)!;
    const token = (await good.json()).result.token as string;
    const lines: string[] = [];
    createLogger("device-fixture", (line) => lines.push(line)).info(
      `${token} ${code} ${pairing.connection_code}`,
      { endpoint: token },
    );
    const trace = JSON.stringify(
      traceSummary({ text: `${token} ${code} ${pairing.connection_code}` }),
    );
    for (const secret of [token, code, pairing.connection_code]) {
      expect(lines.join("").includes(secret)).toBe(false);
      expect(trace.includes(secret)).toBe(false);
    }
    const bad = responses.find((r) => r.status === 409)!;
    expect((await bad.json()).code).toBe("device-pairing-used");
    const expired = await f.create();
    f.setNow(Date.parse(expired.expires_at));
    const expiry = await f.send("/api/v1/device-connections/exchange", {
      pairing_code: parseDeviceConnectionCode(expired.connection_code)
        .pairing_code,
    });
    expect(expiry.status).toBe(409);
    expect((await expiry.json()).code).toBe("device-pairing-expired");
    for (let n = 0; n < 29; n++)
      expect(
        (
          await f.send("/api/v1/device-connections/exchange", {
            wrong: "shape",
          })
        ).status,
      ).toBe(400);
    const limited = await f.send("/api/v1/device-connections/exchange", {
      wrong: "shape",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await limited.json()).code).toBe("device-exchange-rate-limited");
    const db = new DatabaseSync(f.catalog, { readOnly: true });
    try {
      const rows = JSON.stringify([
        db.prepare("SELECT * FROM device_connections").all(),
        db.prepare("SELECT * FROM device_pairings").all(),
        db.prepare("SELECT * FROM operation_records").all(),
        db.prepare("SELECT * FROM execution_events").all(),
        db.prepare("SELECT * FROM agent_session_events").all(),
      ]);
      expect(rows.includes(code)).toBe(false);
      expect(rows.includes(token)).toBe(false);
      expect(rows.includes(pairing.connection_code)).toBe(false);
      expect(
        db
          .prepare(
            "SELECT length(token_sha256) n FROM device_connections WHERE token_sha256 IS NOT NULL",
          )
          .get()?.n,
      ).toBe(64);
    } finally {
      db.close();
    }
    const list = await f.web("/api/v1/device-connections", { cursor: null });
    const publicRows = JSON.stringify(await list.json());
    expect(publicRows.includes(token)).toBe(false);
    expect(publicRows.includes(code)).toBe(false);
    expect(publicRows.includes("sha256")).toBe(false);
    // The same raw token remains valid after an Application restart; limits remain persistent.
    const service = await f.reopen();
    expect(
      (await service.authenticate(token)).connection.paired_at,
    ).not.toBeNull();
    await expect(
      service.exchange({ pairing_code: code }, "127.0.0.1"),
    ).rejects.toMatchObject({ code: "device-exchange-rate-limited" });
  } finally {
    await f.close();
  }
}, 30000);

it("isolates every purpose, accepts non-Web Origin only for registered device routes, and revokes across owners immediately", async () => {
  const f = await fixture();
  try {
    for (const purpose of ["intake", "read", "operate"] as const) {
      const paired = await f.pair([purpose]);
      for (const target of ["intake", "read", "operate"] as const) {
        const response = await f.send(
          `/api/v1/intake/test-${target}/fixed`,
          {},
          {
            Authorization: `Bearer ${paired.token}`,
            Origin: "https://outside.invalid",
            "Sec-Fetch-Site": "cross-site",
          },
        );
        expect(response.status).toBe(target === purpose ? 200 : 403);
      }
    }
    const paired = await f.pair(["read", "operate"]);
    f.setNow(Date.parse("2026-11-10T12:02:00Z"));
    const used = await f.send(
      "/api/v1/intake/test-read/a",
      {},
      { Authorization: `Bearer ${paired.token}` },
    );
    expect(used.status).toBe(200);
    const listed = await f.service.list({ cursor: null });
    expect(
      listed.items.find(
        (d) => d.connection_id === paired.connection.connection_id,
      )?.last_used_at,
    ).toBe("2026-11-10T12:02:00.000Z");
    const renamed = await f.web("/api/v1/device-connections/rename", {
      connection_id: paired.connection.connection_id,
      name: "Renamed desktop",
    });
    expect((await renamed.json()).result.connection.name).toBe(
      "Renamed desktop",
    );
    await new DeviceConnectionService(f.app.database).revoke({
      connection_id: paired.connection.connection_id,
    });
    const revoked = await f.send(
      "/api/v1/intake/test-read/a",
      {},
      { Authorization: `Bearer ${paired.token}` },
    );
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).code).toBe("device-revoked");
  } finally {
    await f.close();
  }
}, 30000);

it("persists connection kinds without changing purpose admission or allowing later kind changes", async () => {
  const f = await fixture();
  try {
    const expected = new Map<string, DeviceKind>();
    for (const kind of [undefined, null, "extension", "agent"] as const) {
      for (const purpose of ["intake", "read", "operate"] as const) {
        const paired = await f.pair([purpose], kind),
          wanted = kind ?? null;
        const connection = parseDeviceConnection(paired.connection);
        expect(connection.kind).toBe(wanted);
        expect(paired.pairing.connection.kind).toBe(wanted);
        expected.set(connection.connection_id, wanted);
        expect(
          (await f.service.requireActive(connection.connection_id)).connection
            .kind,
        ).toBe(wanted);
        for (const target of ["intake", "read", "operate"] as const) {
          const result = await f.send(
            "/api/v1/intake/test-" + target + "/kind",
            {},
            { Authorization: "Bearer " + paired.token },
          );
          expect(result.status).toBe(target === purpose ? 200 : 403);
        }
        const renamed = await f.web("/api/v1/device-connections/rename", {
          connection_id: connection.connection_id,
          name: "Renamed",
        });
        expect(renamed.status).toBe(200);
        expect(
          parseDeviceConnection((await renamed.json()).result.connection),
        ).toMatchObject({ kind: wanted, name: "Renamed" });
        const invalid = await f.web("/api/v1/device-connections/rename", {
          connection_id: connection.connection_id,
          name: "Changed kind",
          kind: wanted === "agent" ? "extension" : "agent",
        });
        expect(invalid.status).toBe(400);
        const revoked = await f.service.revoke({
          connection_id: connection.connection_id,
        });
        expect(revoked.connection.kind).toBe(wanted);
        await expect(
          f.service.authenticate(paired.token),
        ).rejects.toMatchObject({ code: "device-revoked" });
      }
    }
    const list = await f.web("/api/v1/device-connections", { cursor: null });
    expect(list.status).toBe(200);
    const publicRows = (await list.json()).result.items.map(
      parseDeviceConnection,
    ) as ReturnType<typeof parseDeviceConnection>[];
    expect(
      new Map(publicRows.map((row) => [row.connection_id, row.kind])),
    ).toEqual(expected);
    const reopened = await f.reopen();
    expect(
      new Map(
        (await reopened.list({ cursor: null })).items.map((row) => [
          row.connection_id,
          row.kind,
        ]),
      ),
    ).toEqual(expected);
  } finally {
    await f.close();
  }
}, 60000);

it("never grants Web, configuration, credentials or management powers even with a valid Web cookie; refuses URL tokens", async () => {
  const f = await fixture();
  try {
    const paired = await f.pair(["intake", "read", "operate"]);
    const headers = {
      Authorization: `Bearer ${paired.token}`,
      Cookie: f.cookie,
    };
    for (const path of [
      "/",
      "/auth/status",
      "/api/configuration/read",
      "/api/configuration/status",
      "/api/configuration/credential",
      "/api/workspace",
      "/api/clients",
      "/api/v1/maintenance/index-refresh",
      "/api/v1/query/library-search",
      "/api/v1/device-connections",
      "/api/v1/device-connections/pairings",
      "/api/v1/device-connections/rename",
      "/api/v1/device-connections/revoke",
    ]) {
      const response = await f.send(path, {}, headers);
      expect(response.status, path).toBe(403);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    const login = await f.send(
      "/auth/login",
      { password: paired.token },
      { ...headers, Origin: f.server.origin, "X-Workbench-Init": "1" },
    );
    expect(login.status).toBe(403);
    expect(login.headers.has("set-cookie")).toBe(false);
    for (const path of [
      `/api/v1/intake/test-read/id?token=${paired.token}`,
      `/api/v1/intake/${encodeURIComponent(paired.token)}`,
      `/?x=${encodeURIComponent(encodeURIComponent(paired.token))}`,
      `/?connection_code=${encodeURIComponent(paired.pairing.connection_code)}`,
    ]) {
      const response = await f.send(path, undefined, headers);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("device-token-in-url");
    }
    const noHeader = await f.send("/api/v1/intake/skill");
    expect(noHeader.status).toBe(401);
    for (const alternative of [
      { body: { token: paired.token }, headers: {} },
      { body: {}, headers: { Cookie: `device_token=${paired.token}` } },
    ]) {
      const before = f.routeHits.length;
      const response = await f.send(
        "/api/v1/intake/test-read/id",
        alternative.body,
        alternative.headers,
      );
      expect(response.status).toBe(401);
      expect(f.routeHits.length).toBe(before);
    }
    const cross = await f.web(
      "/api/v1/device-connections",
      { cursor: null },
      { Origin: "https://outside.invalid" },
    );
    expect(cross.status).toBe(403);
    const noCsrf = await f.web(
      "/api/v1/device-connections",
      { cursor: null },
      { "X-Workbench-Csrf": "wrong" },
    );
    expect(noCsrf.status).toBe(403);
    const mismatch = await f.web("/api/v1/device-connections/pairings", {
      address: "http://127.0.0.1:1111",
      name: "fake",
      purposes: ["read"],
    });
    expect(mismatch.status).toBe(403);
    const unsafeName = await f.web("/api/v1/device-connections/rename", {
      connection_id: paired.connection.connection_id,
      name: paired.token,
    });
    expect(unsafeName.status).toBe(400);
    const unknown = await f.send(
      "/api/v1/intake/test-read/a",
      {},
      { Authorization: "Bearer srd1_" + "A".repeat(43) },
    );
    expect(unknown.status).toBe(401);
  } finally {
    await f.close();
  }
}, 30000);

it("keeps Browser WebSocket admission separate even when a device also has a valid Web session", async () => {
  const f = await fixture();
  const upgrade = (authorization?: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(f.server.origin + "/api/screencast", {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"),
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": SCREENCAST_PROTOCOL,
          Cookie: f.cookie,
          Origin: f.server.origin,
          ...(authorization ? { Authorization: authorization } : {}),
        },
      });
      request.once("response", (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.once("error", reject);
      request.end();
    });
  try {
    const paired = await f.pair(["read", "operate"]);
    expect(await upgrade()).toBe(101);
    expect(await upgrade(`Bearer ${paired.token}`)).toBe(403);
  } finally {
    await f.close();
  }
}, 30000);

it("builds the downloadable agent guide and skill for the registered intake routes", async () => {
  const f = await fixture();
  try {
    const source = join(f.home, "synthetic-skill");
    await mkdir(source);
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: synthetic\n---\n\n# Synthetic guide\n",
    );
    await writeFile(join(source, "import.md"), "Synthetic intake instructions");
    const { buildAgentAccess } = (await import(
      new URL("../../../scripts/build-agent-access.mjs", import.meta.url).href
    )) as {
      buildAgentAccess(source: string, target: string): Promise<string>;
    };
    await buildAgentAccess(source, f.artifact);
    const paired = await f.pair(["intake"]);
    const headers = { Authorization: `Bearer ${paired.token}` };
    const guide = await f.send(
      "/api/v1/intake/agent-guide",
      undefined,
      headers,
    );
    expect(guide.status).toBe(200);
    const text = await guide.text();
    expect(text).toContain("# Synthetic guide");
    expect(text).toContain("Synthetic intake instructions");
    expect(text).toContain("/api/v1/intake/skill");
    expect(text).not.toContain("/api/v1/device-connections/");
    expect(text).not.toContain("name: synthetic");
    const skill = await f.send("/api/v1/intake/skill", undefined, headers);
    expect(skill.status).toBe(200);
    expect(Buffer.from(await skill.arrayBuffer()).subarray(0, 4)).toEqual(
      Buffer.from([80, 75, 3, 4]),
    );
    await expect(
      readFile(join(f.artifact, "instructions.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
}, 30000);

it("serves only authenticated bounded build artifacts, reports their absence, and protects registry boundaries", async () => {
  const f = await fixture();
  try {
    const paired = await f.pair(["intake"]),
      headers = {
        Authorization: `Bearer ${paired.token}`,
        Origin: "chrome-extension://fixture",
      };
    const missing = await f.send(
      "/api/v1/intake/agent-guide",
      undefined,
      headers,
    );
    expect(missing.status).toBe(503);
    expect((await missing.json()).code).toBe("device-artifact-unavailable");
    await writeFile(
      join(f.artifact, "agent-guide.md"),
      "Synthetic instructions only",
    );
    await writeFile(
      join(f.artifact, "skill.zip"),
      Buffer.from("PK synthetic package fixture"),
    );
    const instructions = await f.send(
      "/api/v1/intake/agent-guide",
      undefined,
      headers,
    );
    expect(instructions.status).toBe(200);
    expect(await instructions.text()).toBe("Synthetic instructions only");
    const archive = await f.send("/api/v1/intake/skill", undefined, headers);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    await rm(join(f.artifact, "skill.zip"));
    await symlink(
      join(f.artifact, "agent-guide.md"),
      join(f.artifact, "skill.zip"),
    );
    const unsafe = await f.send("/api/v1/intake/skill", undefined, headers);
    expect(unsafe.status).toBe(503);
    await rm(join(f.artifact, "skill.zip"));
    await writeFile(
      join(f.artifact, "skill.zip"),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    );
    expect(
      (await f.send("/api/v1/intake/skill", undefined, headers)).status,
    ).toBe(503);
    const revoked = await f.web("/api/v1/device-connections/revoke", {
      connection_id: paired.connection.connection_id,
    });
    expect(revoked.status).toBe(200);
    expect(
      (await f.send("/api/v1/intake/skill", undefined, headers)).status,
    ).toBe(401);
    for (const path of [
      "/auth/login",
      "/api/v1/maintenance/archive",
      "/api/configuration/read",
      "/api/v1/device-connections/revoke",
      "/api/v1/query/library-search",
      "/api/v1/query/document-draft-differences",
    ]) {
      expect(
        () =>
          new DeviceRouteRegistry([
            {
              method: "POST",
              path,
              purposes: ["operate"],
              handle: async () => {},
            },
          ]),
      ).toThrow();
    }
    expect(
      () =>
        new DeviceRouteRegistry([
          {
            method: "POST",
            path: "/mcp",
            purposes: [],
            handle: async () => {},
          },
        ]),
    ).toThrow();
    expect(deviceMaterialInUrl("/?token=unrecognized-format")).toBe(true);
    // Actual SQLite bytes contain neither the issued token nor the pairing code.
    const bytes = await readFile(f.catalog);
    expect(bytes.includes(Buffer.from(paired.token))).toBe(false);
    expect(bytes.includes(Buffer.from(paired.code))).toBe(false);
  } finally {
    await f.close();
  }
}, 30000);

it("keeps peer exchange budgets independent, resets windows, and revokes unconsumed pairings", async () => {
  const f = await fixture();
  try {
    const pending = await f.create(["read"]);
    await f.service.revoke({ connection_id: pending.connection.connection_id });
    await expect(
      f.service.exchange(
        {
          pairing_code: parseDeviceConnectionCode(pending.connection_code)
            .pairing_code,
        },
        "peer-0",
      ),
    ).rejects.toMatchObject({ code: "device-revoked" });
    // An unrelated peer cannot exhaust the allowance of a new connection.
    for (let n = 1; n < 60; n++)
      await expect(f.service.exchange({}, `peer-${n}`)).rejects.toMatchObject({
        code: "device-pairing-invalid",
      });
    await expect(
      new DeviceConnectionService(f.app.database, () =>
        Date.parse("2026-11-10T12:00:00Z"),
      ).exchange({}, "new-peer"),
    ).rejects.toMatchObject({ code: "device-pairing-invalid" });
    f.setNow(Date.parse("2026-11-10T12:01:00Z"));
    await expect(f.service.exchange({}, "new-peer")).rejects.toMatchObject({
      code: "device-pairing-invalid",
    });
    const db = new DatabaseSync(f.catalog, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT count(*) n FROM device_exchange_limits").get()?.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
}, 30000);

it("lets authenticated Web clients download instructions and skill with the same artifact checks", async () => {
  const f = await fixture();
  try {
    const url = (kind: string) =>
      `/api/v1/intake/${kind}?client_id=${f.clientId}`;
    const headers = { Cookie: f.cookie, Origin: f.server.origin };
    expect((await f.send(url("agent-guide"), undefined, headers)).status).toBe(
      503,
    );
    await writeFile(
      join(f.artifact, "agent-guide.md"),
      "Synthetic Web instructions",
    );
    await writeFile(join(f.artifact, "skill.zip"), Buffer.from([80, 75, 3, 4]));
    const instructions = await f.send(url("agent-guide"), undefined, headers);
    expect(instructions.status).toBe(200);
    expect(await instructions.text()).toBe("Synthetic Web instructions");
    const skill = await f.send(url("skill"), undefined, headers);
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-type")).toBe("application/zip");
    expect((await f.send(url("skill"), undefined)).status).toBe(401);
    expect(
      (await f.send("/api/v1/intake/skill", undefined, headers)).status,
    ).toBe(401);
    expect(
      (
        await f.send(url("skill"), undefined, {
          ...headers,
          Origin: "https://outside.invalid",
        })
      ).status,
    ).toBe(403);
    const invalid = await f.send("/api/v1/intake/skill", undefined, {
      ...headers,
      Authorization: "Bearer invalid",
    });
    expect(invalid.status).toBe(401);
    expect((await invalid.json()).code).toBe("device-token-invalid");
    await rm(join(f.artifact, "skill.zip"));
    await symlink(
      join(f.artifact, "agent-guide.md"),
      join(f.artifact, "skill.zip"),
    );
    expect((await f.send(url("skill"), undefined, headers)).status).toBe(503);
    await rm(join(f.artifact, "skill.zip"));
    await writeFile(
      join(f.artifact, "skill.zip"),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    );
    expect((await f.send(url("skill"), undefined, headers)).status).toBe(503);
  } finally {
    await f.close();
  }
}, 30000);

it("serves the devices settings entry for navigation and rejects unknown settings for JSON clients", async () => {
  const f = await fixture();
  try {
    const navigationHeaders = { Cookie: f.cookie, Accept: "text/html" };
    const good = await f.send(
      "/?view=set&setting=devices",
      undefined,
      navigationHeaders,
    );
    expect(good.status).toBe(200);
    const entryBytes = Buffer.from(await good.arrayBuffer());
    expect(entryBytes.toString()).toBe("fixture");

    const probe = "unknown-devices-reflection-probe-91bc";
    const path = `/?view=set&setting=${probe}`;
    const unknown = await f.send(path, undefined, {
      Cookie: f.cookie,
      Accept: "application/json, text/html;q=0",
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe("invalid-ui-location");

    const navigation = await f.send(path, undefined, navigationHeaders);
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get("content-type")).toBe("text/html");
    expect(navigation.headers.getSetCookie()).toEqual(
      good.headers.getSetCookie(),
    );
    const navigationBytes = Buffer.from(await navigation.arrayBuffer());
    expect(navigationBytes).toEqual(entryBytes);
    expect(navigationBytes.toString()).not.toContain(probe);
    expect(JSON.stringify([...navigation.headers])).not.toContain(probe);
  } finally {
    await f.close();
  }
}, 30000);
