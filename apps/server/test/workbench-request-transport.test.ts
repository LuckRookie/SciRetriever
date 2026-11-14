import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import {
  Agent,
  request,
  type RequestListener,
  type ServerOptions,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  parseDeviceConnectionCode,
  type DevicePurpose,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

// Only shorten Node's connection scan, not its deadlines or the actual upload.
// The production startWorkbenchHttp still creates a real HTTP server and sockets.
vi.mock("node:http", async (original) => {
  const http = await original<typeof import("node:http")>();
  return {
    ...http,
    createServer: (options: ServerOptions, listener: RequestListener) =>
      http.createServer(
        { ...options, connectionsCheckingInterval: 100 },
        listener,
      ),
  };
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-request-transport-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: false },
    metadata: { lookup_ports: [] },
  });
  const session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    assets: new Map([["/", { contentType: "text/html", body: "fixture" }]]),
    access: workbenchTestAccess,
    ...(app.maintenance ? { maintenance: app.maintenance } : {}),
    devices: {
      service: app.deviceConnections,
      routes: deviceBusinessRoutes(app),
    },
  });
  const token = async (purposes: DevicePurpose[]) => {
    const pairing = await app.deviceConnections.create({
      address: server.origin,
      name: "Synthetic transport test",
      purposes,
    });
    return (
      await app.deviceConnections.exchange(
        {
          pairing_code: parseDeviceConnectionCode(pairing.connection_code)
            .pairing_code,
        },
        randomUUID(),
      )
    ).token;
  };
  const post = async (path: string, token: string, value: unknown) => {
    const response = await fetch(server.origin + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
      },
      body: JSON.stringify({ protocol_version: 1, request: value }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.result;
  };
  const pendingPdf = async (token: string) => {
    const { batch: s } = await post("/api/v1/intake/batches", token, {
      format: "records",
      source: null,
      scope: "transport",
    });
    const base = `/api/v1/intake/batches/${s.batch_id}`;
    await post(base + "/data", token, {
      sequence: 0,
      data: {
        records: [
          {
            external_id: "paper",
            metadata: FIXTURE_LITERATURE.metadata,
            files: [
              {
                external_id: "pdf",
                file_name: "paper.pdf",
                media_type: "application/pdf",
                preferred: true,
              },
            ],
          },
        ],
      },
    });
    await post(base + "/confirm", token, {});
    await vi.waitFor(
      async () =>
        expect((await post(base + "/files", token, {})).items).toHaveLength(1),
      { timeout: 20_000 },
    );
    const file = (await post(base + "/files", token, {})).items[0];
    return { base, file, path: `${base}/files/${file.file_id}/bytes` };
  };
  return {
    home,
    app,
    server,
    token,
    post,
    pendingPdf,
    async close() {
      await server.close();
      await session.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function receive(
  origin: string,
  path: string,
  credential: string | Record<string, string>,
  contentType: string,
  length: number,
) {
  const started = performance.now();
  const req = request(origin + path, {
    method: "POST",
    headers: {
      ...(typeof credential === "string"
        ? { Authorization: `Bearer ${credential}` }
        : credential),
      "Content-Type": contentType,
      "Content-Length": length,
      "X-Sciretriever-Protocol-Version": "1",
      Accept: "application/json, text/event-stream",
      Connection: "close",
    },
  });
  let responded = false;
  const response = new Promise<{
    status: number;
    text: string;
    elapsed_ms: number;
  }>((resolve, reject) => {
    req.once("error", reject);
    req.once("response", (res) => {
      responded = true;
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.once("error", reject);
      res.once("end", () =>
        resolve({
          status: res.statusCode!,
          text: Buffer.concat(parts).toString(),
          elapsed_ms: performance.now() - started,
        }),
      );
    });
  });
  void response.catch(() => undefined);
  return { req, response, responded: () => responded };
}
async function slow(
  origin: string,
  path: string,
  credential: string | Record<string, string>,
  contentType: string,
  body: Buffer,
) {
  const connection = receive(
    origin,
    path,
    credential,
    contentType,
    body.length,
  );
  const sendStarted = performance.now();
  let sent = 0;
  try {
    // 28 real 250 ms intervals: >5 s plus the 100 ms connection scan.
    for (let part = 0; part < 28 && !connection.responded(); part++) {
      await delay(250);
      if (connection.responded()) break;
      const next = Math.ceil((body.length * (part + 1)) / 28);
      if (!connection.req.write(body.subarray(sent, next)))
        await once(connection.req, "drain");
      sent = next;
    }
    connection.req.end();
    const sendingMs = performance.now() - sendStarted;
    const result = await connection.response;
    console.log(
      "transport-measurement",
      JSON.stringify({
        path: path.split("?")[0]!.replace(/[0-9a-f-]{36}/gu, ":id"),
        sent_bytes: sent,
        send_elapsed_ms: sendingMs,
        send_bytes_per_second: Math.round((sent * 1000) / sendingMs),
        elapsed_ms: result.elapsed_ms,
        bytes_per_second: Math.round((sent * 1000) / result.elapsed_ms),
        status: result.status,
      }),
    );
    return result;
  } finally {
    connection.req.destroy();
  }
}

it("delivers an early 403 before the request body finishes, drains it and reuses the connection", async () => {
  const f = await fixture();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let pending: ReturnType<typeof request> | undefined;
  let firstSocket: object | undefined;
  try {
    const bytes = Buffer.from(JSON.stringify({ ignored: "x".repeat(4096) }));
    pending = request(f.server.origin + "/api/clients", {
      method: "POST",
      agent,
      headers: {
        Host: "attacker.test",
        "Content-Type": "application/json",
        "Content-Length": bytes.length,
        Connection: "keep-alive",
      },
    });
    pending.once("socket", (socket) => {
      firstSocket = socket;
    });
    const denied = new Promise<number>((resolve, reject) => {
      pending!.once("error", reject);
      pending!.once("response", (response) => {
        response.resume();
        response.once("error", reject);
        response.once("end", () => resolve(response.statusCode!));
      });
    });
    // Headers plus an incomplete body force rejection before message completion.
    pending.write(bytes.subarray(0, 1));
    expect(await denied).toBe(403);
    pending.end(bytes.subarray(1));
    if (!pending.writableFinished) await once(pending, "finish");
    const next = await new Promise<{ status: number; sameSocket: boolean }>(
      (resolve, reject) => {
        const req = request(
          f.server.origin + "/api/view",
          { agent },
          (response) => {
            response.resume();
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode!,
                sameSocket: req.socket === firstSocket,
              }),
            );
          },
        );
        req.once("error", reject);
        req.end();
      },
    );
    expect(firstSocket).toBeDefined();
    expect(next).toEqual({ status: 401, sameSocket: true });
  } finally {
    pending?.destroy();
    agent.destroy();
    await f.close();
  }
}, 30000);

it("delivers an early 403 and closes a continuously draining idle-route upload after five seconds", async () => {
  const f = await fixture();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const req = request(f.server.origin + "/mcp", {
    method: "POST",
    agent,
    headers: {
      Host: "attacker.test",
      "Content-Type": "application/json",
      "Content-Length": 1024 * 1024,
      Connection: "keep-alive",
    },
  });
  let closedAt: number | undefined;
  let respondedAt: number | undefined;
  let sentBytes = 1;
  req.on("error", () => undefined);
  req.once("socket", (socket) => {
    socket.once("close", () => {
      closedAt = performance.now();
    });
  });
  const denied = new Promise<number>((resolve, reject) => {
    req.once("response", (res) => {
      res.resume();
      res.once("error", reject);
      res.once("end", () => {
        respondedAt = performance.now();
        resolve(res.statusCode!);
      });
    });
  });
  // Keep making progress within the 60 s idle window without finishing the body.
  const send = setInterval(() => {
    if (!req.destroyed) {
      req.write("x");
      sentBytes++;
    }
  }, 200);
  try {
    req.write("x");
    expect(await denied).toBe(403);
    expect(closedAt).toBeUndefined();
    await delay(6500);
    expect(closedAt).toBeDefined();
    const drainMs = closedAt! - respondedAt!;
    expect(drainMs).toBeGreaterThan(4500);
    expect(drainMs).toBeLessThan(6500);
    expect(sentBytes).toBeGreaterThanOrEqual(20);
    console.log(
      "rejected-upload-drain",
      JSON.stringify({
        status: 403,
        drain_ms: drainMs,
        sent_bytes: sentBytes,
        bytes_per_second: (sentBytes * 1000) / drainMs,
      }),
    );
  } finally {
    clearInterval(send);
    req.destroy();
    agent.destroy();
    await f.close();
  }
}, 30000);

it("receives a real device HTTP PDF larger than 16 MiB at a controlled rate beyond the old request timeout", async () => {
  const f = await fixture();
  try {
    const token = await f.token(["intake"]),
      pending = await f.pendingPdf(token);
    const pdf = Buffer.from(workbenchPdf());
    const xref = /startxref\s+(\d+)/u.exec(pdf.toString())![1]!;
    const bytes = Buffer.concat([
      pdf,
      Buffer.alloc(17 * 1024 * 1024, 32),
      Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`),
    ]);
    const result = await slow(
      f.server.origin,
      pending.path,
      token,
      "application/pdf",
      bytes,
    );
    expect(result.status, result.text).toBe(200);
    expect(result.elapsed_ms).toBeGreaterThan(5100);
    expect(JSON.parse(result.text).result.file.status).toBe("uploaded");
    const asset = (await f.app.database.currentFacts(
      pending.file.literature_id,
    ))!.primary_asset!;
    expect(asset.size_bytes).toBe(bytes.length);
    expect(asset.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  } finally {
    await f.close();
  }
}, 40000);

it("receives slow import data, captured PDF bytes and MCP request bodies through the same production server", async () => {
  const f = await fixture();
  try {
    const token = await f.token(["intake", "read"]);
    const { batch: s } = await f.post("/api/v1/intake/batches", token, {
      format: "bibtex",
      source: null,
      scope: "slow data",
    });
    const data = await slow(
      f.server.origin,
      `/api/v1/intake/batches/${s.batch_id}/data`,
      token,
      "application/json",
      Buffer.from(
        JSON.stringify({
          protocol_version: 1,
          request: { sequence: 0, data: "@article{a,title={Slow HTTP data}}" },
        }),
      ),
    );
    expect(data.status, data.text).toBe(200);
    const capture = await f.post("/api/v1/intake/pages/save", token, {
      request_id: randomUUID(),
      metadata: {
        identifiers: [{ namespace: "doi", value: "10.5555/slow-capture" }],
      },
      file: { file_name: "paper.pdf" },
    });
    const pdf = await slow(
      f.server.origin,
      `/api/v1/intake/batches/${capture.batch_id}/files/${capture.file.file_id}/bytes`,
      token,
      "application/pdf",
      Buffer.from(workbenchPdf()),
    );
    expect(pdf.status, pdf.text).toBe(200);
    expect(JSON.parse(pdf.text).result.file.status).toBe("uploaded");
    const mcp = await slow(
      f.server.origin,
      "/mcp",
      token,
      "application/json",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "synthetic", version: "1" },
          },
        }),
      ),
    );
    expect(mcp.status, mcp.text).toBe(200);
    expect(mcp.text).toContain("serverInfo");
    for (const contentType of [
      "application/json; charset=gbk",
      "application/json; other=value",
    ]) {
      const response = await fetch(f.server.origin + "/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
        },
        body: "{}",
      });
      expect(response.status).toBe(415);
      expect((await response.json()).code).toBe("content-type-unsupported");
    }
    const login = await workbenchLogin(f.server.origin);
    const root = await fetch(f.server.origin, { headers: { Cookie: login } });
    const cookie =
      login +
      "; " +
      root.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
    const attached = await fetch(f.server.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: f.server.origin,
        "X-Workbench-Init": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(attached.status).toBe(201);
    const grant = (await attached.json()) as {
      client_id: string;
      csrf: string;
    };
    const manual = await f.post("/api/v1/intake/pages/save", token, {
      request_id: randomUUID(),
      metadata: {
        identifiers: [{ namespace: "doi", value: "10.5555/slow-manual" }],
      },
    });
    const result = await slow(
      f.server.origin,
      `/api/v1/maintenance/ingest-pdf?client_id=${grant.client_id}`,
      {
        Cookie: cookie,
        Origin: f.server.origin,
        "X-Workbench-Csrf": grant.csrf,
        "X-Literature-Id": manual.literature_id,
      },
      "application/octet-stream",
      Buffer.from(workbenchPdf()),
    );
    expect(result.status, result.text).toBe(200);
    expect(JSON.parse(result.text).receipt.sha256).toBe(
      createHash("sha256").update(workbenchPdf()).digest("hex"),
    );
  } finally {
    await f.close();
  }
}, 60000);

it("interrupts a PDF after 60 real seconds without data, removes staging and keeps the file pending for retry", async () => {
  const f = await fixture();
  let connection: ReturnType<typeof receive> | undefined;
  try {
    const token = await f.token(["intake"]),
      pending = await f.pendingPdf(token);
    connection = receive(
      f.server.origin,
      pending.path,
      token,
      "application/pdf",
      1024 * 1024,
    );
    connection.req.write(Buffer.from(workbenchPdf()));
    const stages = () =>
      readdir(join(f.home, "artifacts", ".staging")).catch(() => []);
    await expect
      .poll(async () => (await stages()).length, { timeout: 20000 })
      .toBeGreaterThan(0);
    const result = await connection.response;
    console.log(
      "idle-measurement",
      JSON.stringify({ elapsed_ms: result.elapsed_ms, status: result.status }),
    );
    expect(result.status).toBe(408);
    expect(JSON.parse(result.text).code).toBe("request-idle-timeout");
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(60000);
    expect(result.elapsed_ms).toBeLessThan(70000);
    await expect.poll(stages, { timeout: 20000 }).toEqual([]);
    expect(
      (await f.post(pending.base + "/files", token, {})).items[0].status,
    ).toBe("pending");
    expect(
      (await f.app.database.currentFacts(pending.file.literature_id))!
        .primary_asset,
    ).toBeNull();
  } finally {
    connection?.req.destroy();
    await f.close();
  }
}, 95000);

it("retains a 5 second total body deadline for ordinary routes", async () => {
  const f = await fixture();
  try {
    const token = await f.token(["intake"]);
    const result = await slow(
      f.server.origin,
      "/api/v1/intake/batches/list",
      token,
      "application/json",
      Buffer.from(
        JSON.stringify({ protocol_version: 1, request: {} }) + " ".repeat(4096),
      ),
    );
    expect(result.status).toBe(408);
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(4900);
    expect(result.elapsed_ms).toBeLessThan(6500);
  } finally {
    await f.close();
  }
}, 25000);
