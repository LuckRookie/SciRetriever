import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { Agent, request } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  EMPTY_METADATA,
  parseLiterature,
  parseDeviceConnectionCode,
  type IntakeBatch,
  type IntakeFileStatus,
  type IntakeReport,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { SqliteWorkerError } from "../src/storage/sqlite/worker.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";
import { CandidateAcceptanceService } from "../src/acquisition/candidate-acceptance.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
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

async function until(work: () => Promise<boolean>, ms = 20_000) {
  const end = performance.now() + ms;
  do {
    if (await work()) return;
    await delay(30);
  } while (performance.now() < end);
  throw new Error("Synthetic intake condition did not settle");
}
async function fixture(initialNow = new Date(2026, 10, 15, 12).getTime()) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-runtime-"));
  let now = initialNow;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let server: Awaited<ReturnType<typeof startWorkbenchHttp>>;
  let session: ProductionWorkbenchSession;
  let cookie = "",
    client = "",
    csrf = "";
  const boot = async (maintain = true) => {
    app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      metadata: { lookup_ports: [] },
      importSessions: { maintain, now: () => now },
    });
    session = new ProductionWorkbenchSession(null, undefined);
    server = await startWorkbenchHttp({
      session,
      ...(app.maintenance ? { maintenance: app.maintenance } : {}),
      access: workbenchTestAccess,
      assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
      devices: {
        service: app.deviceConnections,
        routes: deviceBusinessRoutes(app),
      },
    });
    const login = await workbenchLogin(server.origin);
    const root = await fetch(server.origin, { headers: { Cookie: login } });
    cookie =
      login +
      "; " +
      root.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    const attached = await fetch(server.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const grant = (await attached.json()) as {
      client_id: string;
      csrf: string;
    };
    client = grant.client_id;
    csrf = grant.csrf;
  };
  await boot();
  const headers = (token?: string) =>
    token
      ? { Authorization: `Bearer ${token}` }
      : { Cookie: cookie, Origin: server.origin, "X-Workbench-Csrf": csrf };
  const url = (path: string, token?: string) =>
    server.origin + path + (token ? "" : "?client_id=" + client);
  const api = async <T>(
    path: string,
    value: unknown = {},
    token?: string,
  ): Promise<T> => {
    const r = await fetch(url(path, token), {
      method: "POST",
      headers: {
        ...headers(token),
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
      },
      body: JSON.stringify({ protocol_version: 1, request: value }),
    });
    const body = await r.json();
    expect(r.status, JSON.stringify(body)).toBe(200);
    return body.result as T;
  };
  const batchPath = (id: string) => `/api/v1/intake/batches/${id}`;
  const status = async (id: string) =>
    (await api<{ batch: IntakeBatch }>(batchPath(id) + "/status")).batch;
  const create = async (
    records: unknown[],
    token?: string,
    groups: unknown[] = [],
  ) => {
    const { batch } = await api<{ batch: IntakeBatch }>(
      "/api/v1/intake/batches",
      {
        format: "records",
        source: {
          system: "synthetic",
          library_id: randomUUID(),
          identity: "global",
          name: "Synthetic source",
        },
        scope: "HTTP intake runtime",
      },
      token,
    );
    await api(
      batchPath(batch.batch_id) + "/data",
      { sequence: 0, data: { records, groups } },
      token,
    );
    return batch.batch_id;
  };
  const pair = async () => {
    const p = await app.deviceConnections.create({
      address: server.origin,
      name: "Synthetic importer",
      purposes: ["intake"],
    });
    return app.deviceConnections.exchange(
      {
        pairing_code: parseDeviceConnectionCode(p.connection_code).pairing_code,
      },
      randomUUID(),
    );
  };
  const sql = (statement: string) => {
    const db = new DatabaseSync(join(home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      return db.prepare(statement).all();
    } finally {
      db.close();
    }
  };
  const closeGraph = async () => {
    await server.close();
    await session.close();
    await app.close();
  };
  return {
    home,
    api,
    status,
    create,
    pair,
    sql,
    batchPath,
    headers,
    url,
    get app() {
      return app;
    },
    get origin() {
      return server.origin;
    },
    setNow: (value: number) => {
      now = value;
    },
    get now() {
      return now;
    },
    async restart(maintain = true) {
      await closeGraph();
      await boot(maintain);
    },
    async close() {
      await closeGraph();
      await rm(home, { recursive: true, force: true });
    },
  };
}
function record(index: number, pdf = false) {
  return {
    external_id: `record-${index}`,
    metadata: {
      ...EMPTY_METADATA,
      title: `Synthetic runtime paper ${index}`,
      identifiers: [
        { namespace: "doi", value: `10.5555/intake-runtime-${index}` },
      ],
    },
    ...(pdf
      ? {
          files: [
            {
              external_id: `file-${index}`,
              file_name: "paper.pdf",
              media_type: "application/pdf",
              preferred: true,
            },
          ],
        }
      : {}),
  };
}
function largePdf() {
  const pdf = Buffer.from(workbenchPdf());
  const xref = /startxref\s+(\d+)/u.exec(pdf.toString())![1]!;
  return Buffer.concat([
    pdf,
    Buffer.alloc(17 * 1024 * 1024, 32),
    Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`),
  ]);
}

async function slowPdf(
  url: string,
  headers: Record<string, string>,
  pdf: Buffer,
) {
  const started = performance.now();
  let req: ReturnType<typeof request>;
  const received = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      req = request(
        url,
        {
          method: "POST",
          headers: { ...headers, "Content-Length": pdf.length },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(Buffer.from(c)));
          r.once("error", reject);
          r.once("end", () =>
            resolve({
              status: r.statusCode!,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.once("error", reject);
    },
  );
  void received.catch(() => undefined);
  try {
    const part = Math.ceil(pdf.length / 14);
    for (let offset = 0; offset < pdf.length; offset += part) {
      if (req!.destroyed) break;
      if (!req!.write(pdf.subarray(offset, offset + part)))
        await once(req!, "drain");
      await delay(500);
    }
    req!.end();
    const response = await received;
    console.log(
      "intake-supplement-slow",
      JSON.stringify({
        bytes: pdf.length,
        elapsed_ms: performance.now() - started,
        status: response.status,
      }),
    );
    return response;
  } finally {
    req!.destroy();
  }
}

it("admits 5000 real HTTP records immediately, publishes increasing progress and deduplicates concurrent confirmation", async () => {
  const f = await fixture();
  try {
    const id = await f.create(
      Array.from({ length: 5000 }, (_, i) => record(i)),
    );
    const started = performance.now();
    const confirmations = await Promise.all([
      f.api<{ batch: IntakeBatch }>(f.batchPath(id) + "/confirm"),
      f.api<{ batch: IntakeBatch }>(f.batchPath(id) + "/confirm"),
    ]);
    const confirmMs = performance.now() - started;
    for (const r of confirmations)
      expect(r.batch).toMatchObject({
        batch_id: id,
        state: "running",
        progress: { total_items: 5000 },
      });
    expect(confirmations[0]!.batch.progress!.processed_items).toBe(0);
    expect(confirmMs).toBeLessThan(2000);
    let advanced = false,
      highest = 0;
    await until(async () => {
      const b = await f.status(id);
      if (b.progress) {
        highest = Math.max(highest, b.progress.processed_items);
        if (highest > 0 && highest < 5000) advanced = true;
      }
      return b.state === "finished";
    }, 480_000);
    expect(advanced).toBe(true);
    expect(await f.status(id)).toMatchObject({
      state: "finished",
      result: "completed",
      counts: { hits: 5000, created: 5000 },
    });
    expect(f.sql("SELECT count(*) n FROM import_record_results")[0]!.n).toBe(
      5000,
    );
    expect(f.sql("SELECT count(*) n FROM metadata_observations")[0]!.n).toBe(
      5000,
    );
    console.log(
      "intake-http-5000",
      JSON.stringify({
        confirm_ms: confirmMs,
        completion_ms: performance.now() - started,
        processed: 5000,
        intermediate_progress: highest,
      }),
    );
  } finally {
    await f.close();
  }
}, 540_000);

it("resumes an HTTP batch after a committed identity and restart, while a local application leaves that batch alone", async () => {
  const f = await fixture(Date.now() - 120_000);
  try {
    const groups = [
      {
        external_id: "group",
        parent_external_id: null,
        name: "Synthetic imported folder",
      },
    ];
    const id = await f.create(
      Array.from({ length: 20 }, (_, i) => ({
        ...record(i),
        groups: ["group"],
      })),
      undefined,
      groups,
    );
    const observe = f.app.identity.observe.bind(f.app.identity);
    let calls = 0;
    const injected = vi
      .spyOn(f.app.identity, "observe")
      .mockImplementation(async (...args) => {
        const result = await observe(...args);
        if (++calls === 5) throw new SqliteWorkerError();
        return result;
      });
    expect(
      (await f.api<{ batch: IntakeBatch }>(f.batchPath(id) + "/confirm")).batch
        .state,
    ).toBe("running");
    await until(
      async () =>
        Number(
          f.sql("SELECT storage_failures n FROM import_sessions")[0]!.n,
        ) === 1,
    );
    injected.mockRestore();
    const checkpoint = Number(
      f.sql("SELECT count(*) n FROM import_record_results")[0]!.n,
    );
    expect(checkpoint).toBe(4);
    f.setNow(f.now + 60_000);
    await f.restart(false);
    await delay(200);
    expect(
      Number(f.sql("SELECT count(*) n FROM import_record_results")[0]!.n),
    ).toBe(checkpoint);
    // Local bibliography remains synchronous and cannot recover the unrelated HTTP batch.
    const localFile = join(f.home, "local.bib");
    await writeFile(
      localFile,
      "@article{local,title={Local synchronous import},doi={10.5555/local-runtime}}",
    );
    const cli = await runCli(
      ["import", "metadata", localFile, "--format", "bibtex"],
      { home: f.home, json: true, stdout: () => undefined },
    );
    expect(cli.code).toBe(0);
    const local = cli.value as { intake_batch_id: string };
    expect((await f.status(local.intake_batch_id!)).state).toBe("finished");
    expect((await f.status(id)).state).toBe("running");
    const localHost = createMcpServer({ maintenance: true, home: f.home });
    const [localServer, localTransport] = InMemoryTransport.createLinkedPair();
    const localClient = new Client({
      name: "synthetic-local-bibliography",
      version: "1",
    });
    try {
      await localHost.connect(localServer);
      await localClient.connect(localTransport);
      const r = await localClient.callTool({
        name: "import_bibliography",
        arguments: {
          format: "bibtex",
          content:
            "@article{mcp,title={MCP synchronous import},doi={10.5555/local-mcp-runtime}}",
        },
      });
      expect(r.isError).not.toBe(true);
      const result = (
        r.structuredContent as { result: { intake_batch_id: string } }
      ).result;
      expect((await f.status(result.intake_batch_id)).state).toBe("finished");
      expect((await f.status(id)).progress!.processed_items).toBe(checkpoint);
    } finally {
      await localClient.close();
      await localHost.close();
    }
    await f.restart(true);
    await until(async () => (await f.status(id)).state === "finished");
    expect(await f.status(id)).toMatchObject({
      result: "completed",
      counts: { hits: 20, created: 20 },
    });
    expect(f.sql("SELECT count(*) n FROM folders")[0]!.n).toBe(2);
    expect(f.sql("SELECT count(*) n FROM folder_members")[0]!.n).toBe(20);
    expect(f.sql("SELECT count(*) n FROM metadata_observations")[0]!.n).toBe(
      22,
    );
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 40_000);

it("persists storage retry counts, waits a minute between attempts and reports unprocessed records after three failures", async () => {
  const f = await fixture();
  try {
    const id = await f.create([record(0), record(1)]);
    let attempts = 0;
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const fault = () =>
      vi.spyOn(f.app.identity, "observe").mockImplementation(async () => {
        attempts++;
        throw new SqliteWorkerError();
      });
    fault();
    await f.api(f.batchPath(id) + "/confirm");
    const failures = () =>
      Number(f.sql("SELECT storage_failures n FROM import_sessions")[0]!.n);
    await until(async () => failures() === 1);
    await until(async () =>
      scheduled.mock.calls.some(([, ms]) => ms === 60_000),
    );
    f.setNow(f.now + 59_999);
    await f.app.importSessions.sweep();
    await delay(100);
    expect(attempts).toBe(1);
    f.setNow(f.now + 1);
    await f.app.importSessions.sweep();
    await until(async () => failures() === 2);
    vi.restoreAllMocks();
    await f.restart();
    fault();
    await delay(100);
    expect(attempts).toBe(2);
    f.setNow(f.now + 60_000);
    await f.app.importSessions.sweep();
    await until(async () => (await f.status(id)).state === "finished");
    expect(attempts).toBe(3);
    expect(failures()).toBe(3);
    const report = await f.api<IntakeReport>(f.batchPath(id) + "/report");
    expect(report.batch).toMatchObject({
      state: "finished",
      result: "failed",
      counts: { hits: 0 },
    });
    expect(report.summary.excluded).toEqual(
      expect.arrayContaining([
        { kind: "storage-failure", count: 1 },
        { kind: "unprocessed-records", count: 2 },
      ]),
    );
    await until(
      async () =>
        Number(f.sql("SELECT count(*) n FROM import_parts")[0]!.n) === 0,
    );
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 40_000);

it("stops processing after three storage failures even when failure checkpoints cannot be written", async () => {
  const f = await fixture();
  try {
    const id = await f.create([record(0), record(1)]);
    let attempts = 0,
      checkpoints = 0,
      blocked = true;
    vi.spyOn(f.app.identity, "observe").mockImplementation(async () => {
      attempts++;
      throw new SqliteWorkerError();
    });
    const original = f.app.database.run.bind(f.app.database);
    vi.spyOn(f.app.database, "run").mockImplementation(
      async (command, signal) => {
        if (
          command.kind === "import_write" &&
          command.action.op === "processing-failure"
        ) {
          checkpoints++;
          if (blocked)
            throw new WriteAdmissionError("write-admission-conflict");
        }
        return original(command, signal);
      },
    );
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    await f.api(f.batchPath(id) + "/confirm");
    for (let count = 1; count <= 3; count++) {
      if (count > 1) {
        if (count === 2) {
          f.setNow(f.now + 59_999);
          await f.app.importSessions.sweep();
          await delay(100);
          expect(attempts).toBe(1);
          expect(checkpoints).toBe(1);
          f.setNow(f.now + 1);
        } else f.setNow(f.now + 60_000);
        await f.app.importSessions.sweep();
      }
      await until(
        async () =>
          checkpoints === count &&
          scheduled.mock.calls.filter(([, ms]) => ms === 60_000).length >=
            count,
      );
    }
    expect(attempts).toBe(3);
    expect(f.sql("SELECT storage_failures n FROM import_sessions")[0]!.n).toBe(
      0,
    );
    f.setNow(f.now + 60_000);
    await f.app.importSessions.sweep();
    await until(
      async () =>
        checkpoints === 4 &&
        scheduled.mock.calls.filter(([, ms]) => ms === 60_000).length >= 4,
    );
    expect(attempts).toBe(3);
    f.setNow(f.now + 59_999);
    await f.app.importSessions.sweep();
    await delay(100);
    expect(checkpoints).toBe(4);
    blocked = false;
    f.setNow(f.now + 1);
    await f.app.importSessions.sweep();
    await until(async () => checkpoints === 5);
    // Restoring the failure checkpoint must not admit a fourth processing attempt.
    expect(attempts).toBe(3);
    await until(async () => (await f.status(id)).state === "finished");
    const report = await f.api<IntakeReport>(f.batchPath(id) + "/report");
    expect(report.batch).toMatchObject({
      state: "finished",
      result: "failed",
      counts: { hits: 0 },
    });
    expect(report.summary.excluded).toEqual(
      expect.arrayContaining([
        { kind: "storage-failure", count: 1 },
        { kind: "unprocessed-records", count: 2 },
      ]),
    );
    expect(f.sql("SELECT storage_failures n FROM import_sessions")[0]!.n).toBe(
      3,
    );
    expect(f.sql("SELECT count(*) n FROM metadata_observations")[0]!.n).toBe(0);
    await until(
      async () =>
        Number(f.sql("SELECT count(*) n FROM import_parts")[0]!.n) === 0,
    );
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 40_000);

it("resets consecutive storage failures after a successfully checkpointed record", async () => {
  const f = await fixture();
  try {
    const id = await f.create([record(0), record(1)]);
    const observe = f.app.identity.observe.bind(f.app.identity);
    let attempts = 0;
    vi.spyOn(f.app.identity, "observe").mockImplementation(async (...args) => {
      if ([1, 2, 4, 5].includes(++attempts)) throw new SqliteWorkerError();
      return observe(...args);
    });
    const failures = () =>
      Number(f.sql("SELECT storage_failures n FROM import_sessions")[0]!.n);
    await f.api(f.batchPath(id) + "/confirm");
    await until(async () => failures() === 1);
    for (const [calls, count] of [
      [2, 2],
      [4, 1],
      [5, 2],
    ] as const) {
      f.setNow(f.now + 60_000);
      await f.app.importSessions.sweep();
      await until(async () => attempts === calls && failures() === count);
    }
    expect((await f.status(id)).progress!.processed_items).toBe(1);
    f.setNow(f.now + 60_000);
    await f.app.importSessions.sweep();
    await until(async () => (await f.status(id)).state === "finished");
    expect(attempts).toBe(6);
    expect(failures()).toBe(0);
    expect(await f.status(id)).toMatchObject({
      state: "finished",
      result: "completed",
      counts: { hits: 2, created: 2 },
    });
    expect(f.sql("SELECT count(*) n FROM metadata_observations")[0]!.n).toBe(2);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 40_000);

it.each(["receiving", "before-acceptance"] as const)(
  "revokes a device %s, returns 401, cleans candidates and leaves its file pending",
  async (stage) => {
    const f = await fixture();
    let req: ReturnType<typeof request> | undefined;
    let sending: ReturnType<typeof setInterval> | undefined;
    let socketClosed = false;
    let release: () => void = () => undefined;
    try {
      const device = await f.pair();
      const id = await f.create([record(1, true)], device.token);
      await f.api(f.batchPath(id) + "/confirm", {}, device.token);
      let file: IntakeFileStatus | undefined;
      await until(async () => {
        file = (
          await f.api<{ items: IntakeFileStatus[] }>(
            f.batchPath(id) + "/files",
            {},
            device.token,
          )
        ).items[0];
        return !!file;
      });
      const path = f.batchPath(id) + `/files/${file!.file_id}/bytes`;
      let entered = false;
      if (stage === "before-acceptance") {
        const original = CandidateAcceptanceService.prototype.accept;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        vi.spyOn(
          CandidateAcceptanceService.prototype,
          "accept",
        ).mockImplementation(async function (
          this: CandidateAcceptanceService,
          ...args
        ) {
          entered = true;
          await gate;
          return original.apply(this, args);
        });
      }
      const pdf = Buffer.from(workbenchPdf());
      const response = new Promise<{ status: number; text: string }>(
        (resolve, reject) => {
          req = request(
            f.origin + path,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${device.token}`,
                "Content-Type": "application/pdf",
                "Content-Length": pdf.length,
                "X-Sciretriever-Protocol-Version": "1",
              },
            },
            (r) => {
              const bytes: Buffer[] = [];
              r.on("data", (c) => bytes.push(Buffer.from(c)));
              r.once("end", () =>
                resolve({
                  status: r.statusCode!,
                  text: Buffer.concat(bytes).toString(),
                }),
              );
              r.once("error", reject);
            },
          );
          req.once("error", reject);
          req.once("socket", (socket) =>
            socket.once("close", () => {
              socketClosed = true;
            }),
          );
          if (stage === "receiving") req.write(pdf.subarray(0, 100));
          else req.end(pdf);
        },
      );
      if (stage === "before-acceptance") {
        await until(async () => entered);
        expect(
          Number(f.sql("SELECT count(*) n FROM execution_candidates")[0]!.n),
        ).toBe(1);
      } else {
        sending = setInterval(() => {
          if (!req!.destroyed) req!.write(" ");
        }, 30);
        await until(async () =>
          (await readdir(f.app.files.root, { recursive: true })).some((p) =>
            p.startsWith(".staging/stage-"),
          ),
        );
      }
      const revokedAt = performance.now();
      await f.api("/api/v1/device-connections/revoke", {
        connection_id: device.connection.connection_id,
      });
      release();
      const denied = await response;
      expect(denied.status).toBe(401);
      expect(JSON.parse(denied.text).code).toBe("device-revoked");
      await until(async () => socketClosed);
      expect(performance.now() - revokedAt).toBeLessThan(2000);
      await until(
        async () =>
          Number(f.sql("SELECT count(*) n FROM execution_candidates")[0]!.n) ===
          0,
      );
      expect(
        (await f.api<{ items: IntakeFileStatus[] }>(f.batchPath(id) + "/files"))
          .items[0]!.status,
      ).toBe("pending");
      expect(
        (await f.app.database.currentFacts(file!.literature_id))!.primary_asset,
      ).toBeNull();
      await until(
        async () =>
          (await readdir(f.app.files.root, { recursive: true })).filter(
            (p) => p.startsWith(".staging/") || p.startsWith(".candidates/"),
          ).length === 0,
      );
    } finally {
      if (sending) clearInterval(sending);
      release();
      req?.destroy();
      vi.restoreAllMocks();
      await f.close();
    }
  },
  40_000,
);

it("streams a PDF larger than 16 MiB via authenticated Web, shares the local-day batch, and keeps existing PDF bytes", async () => {
  const f = await fixture();
  try {
    await f.app.database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
    const path = `/api/v1/intake/literatures/${FIXTURE_LITERATURE.literature_id}/pdf`,
      pdf = largePdf();
    const headers = {
      ...f.headers(),
      "Content-Type": "application/pdf",
      "X-Sciretriever-Protocol-Version": "1",
      "X-Sciretriever-File-Name": encodeURIComponent("Synthetic large.pdf"),
    };
    const upload = async (bytes: Buffer) => {
      const r = await fetch(f.url(path), {
        method: "POST",
        headers,
        body: new Uint8Array(bytes),
      });
      const body = await r.json();
      expect(r.status, JSON.stringify(body)).toBe(200);
      return body.result as { batch_id: string; file: IntakeFileStatus };
    };
    const response = await slowPdf(f.url(path), headers, pdf);
    expect(response.status, response.body).toBe(200);
    const one = JSON.parse(response.body).result as {
      batch_id: string;
      file: IntakeFileStatus;
    };
    expect(one.file.status).toBe("uploaded");
    expect(pdf.length).toBeGreaterThan(16 * 1024 * 1024);
    expect(await f.status(one.batch_id)).toMatchObject({
      state: "running",
      confirmation: "per-item",
      default_label: "补充文件 2026-11-15",
      initiated_by: "local:web",
    });
    const two = await upload(pdf);
    expect(two.file.status).toBe("existing");
    expect(two.batch_id).toBe(one.batch_id);
    const conflict = await upload(
      Buffer.from(workbenchPdf("10.5555/different")),
    );
    expect(conflict.file.status).toBe("conflict");
    const facts = await f.app.database.currentFacts(
      FIXTURE_LITERATURE.literature_id,
    );
    expect(facts!.primary_asset!.sha256).toBe(
      createHash("sha256").update(pdf).digest("hex"),
    );
    expect(
      (await f.app.library.detail(FIXTURE_LITERATURE.literature_id))
        .primary_pdf!.article_identity_status,
    ).toBe("unverified");
    const legacyId = randomUUID();
    await f.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: legacyId,
        meta_literature_id: randomUUID(),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          identifiers: [
            { namespace: "doi", value: "10.5555/legacy-supplement" },
          ],
        },
      }),
    );
    const legacy = await fetch(f.url("/api/v1/maintenance/ingest-pdf"), {
      method: "POST",
      headers: { ...headers, "X-Literature-Id": legacyId },
      body: new Uint8Array(pdf),
    });
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).receipt.sha256).toBe(
      facts!.primary_asset!.sha256,
    );
    expect(
      (
        await fetch(f.url(path), {
          method: "POST",
          headers: { ...headers, "Content-Type": "text/plain" },
          body: "x",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(f.url(path), {
          method: "POST",
          headers: {
            ...headers,
            "X-Sciretriever-File-Name": "..%2Fprivate.pdf",
          },
          body: new Uint8Array(workbenchPdf()),
        })
      ).status,
    ).toBe(400);
    const device = await f.pair();
    expect(
      (
        await fetch(f.url(path, device.token), {
          method: "POST",
          headers: { ...headers, Authorization: `Bearer ${device.token}` },
          body: new Uint8Array(workbenchPdf()),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(f.url(path), {
          method: "POST",
          headers: { ...headers, "X-Workbench-Csrf": "wrong" },
          body: new Uint8Array(workbenchPdf()),
        })
      ).status,
    ).toBe(403);
    f.setNow(f.now + 24 * 60 * 60 * 1000);
    await f.app.importSessions.sweep();
    expect((await f.status(one.batch_id)).state).toBe("finished");
    const next = await upload(pdf);
    expect(next.batch_id).not.toBe(one.batch_id);
  } finally {
    await f.close();
  }
}, 60_000);

it("closes a keep-alive upload revoked between authentication and subscription with a 401", async () => {
  const f = await fixture(),
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let req: ReturnType<typeof request> | undefined;
  try {
    const device = await f.pair(),
      id = await f.create([record(8, true)], device.token);
    await f.api(f.batchPath(id) + "/confirm", {}, device.token);
    let file: IntakeFileStatus | undefined;
    await until(async () => {
      file = (
        await f.api<{ items: IntakeFileStatus[] }>(
          f.batchPath(id) + "/files",
          {},
          device.token,
        )
      ).items[0];
      return !!file;
    });
    const actual = f.app.importSessions.requireOwner.bind(f.app.importSessions);
    const owner = vi
      .spyOn(f.app.importSessions, "requireOwner")
      .mockImplementationOnce(async (...args) => {
        await actual(...args);
        await f.api("/api/v1/device-connections/revoke", {
          connection_id: device.connection.connection_id,
        });
      });
    let closed = false;
    const started = performance.now();
    const status = await new Promise<number>((resolve, reject) => {
      req = request(
        f.url(f.batchPath(id) + `/files/${file!.file_id}/bytes`, device.token),
        {
          method: "POST",
          agent,
          headers: {
            Authorization: `Bearer ${device.token}`,
            Connection: "keep-alive",
            "Content-Type": "application/pdf",
            "X-Sciretriever-Protocol-Version": "1",
          },
        },
        (r) => {
          r.resume();
          r.once("end", () => resolve(r.statusCode!));
          r.once("error", reject);
        },
      );
      req.once("socket", (socket) =>
        socket.once("close", () => {
          closed = true;
        }),
      );
      req.once("error", reject);
      req.end(workbenchPdf());
    });
    owner.mockRestore();
    expect(status).toBe(401);
    await until(async () => closed);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(
      (await f.app.database.currentFacts(file!.literature_id))!.primary_asset,
    ).toBeNull();
  } finally {
    req?.destroy();
    agent.destroy();
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);

it("retains an accepted device PDF and its settled report after revocation", async () => {
  const f = await fixture();
  try {
    const device = await f.pair(),
      id = await f.create([record(9, true)], device.token);
    await f.api(f.batchPath(id) + "/confirm", {}, device.token);
    let file: IntakeFileStatus | undefined;
    await until(async () => {
      file = (
        await f.api<{ items: IntakeFileStatus[] }>(
          f.batchPath(id) + "/files",
          {},
          device.token,
        )
      ).items[0];
      return !!file;
    });
    const pdf = Buffer.from(workbenchPdf());
    const uploaded = await fetch(
      f.url(f.batchPath(id) + `/files/${file!.file_id}/bytes`, device.token),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${device.token}`,
          "Content-Type": "application/pdf",
          "X-Sciretriever-Protocol-Version": "1",
        },
        body: new Uint8Array(pdf),
      },
    );
    expect(uploaded.status).toBe(200);
    expect((await uploaded.json()).result.file.status).toBe("uploaded");
    await f.api("/api/v1/device-connections/revoke", {
      connection_id: device.connection.connection_id,
    });
    const settled = await f.api<{ items: IntakeFileStatus[] }>(
      f.batchPath(id) + "/files",
      { pending: false },
    );
    expect(settled.items[0]!.status).toBe("uploaded");
    expect(
      (await f.app.database.currentFacts(file!.literature_id))!.primary_asset!
        .sha256,
    ).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect((await f.status(id)).result).toBe("completed");
  } finally {
    await f.close();
  }
}, 30_000);

it("keeps CLI and official stdio MCP upload receipts while streaming PDFs above 16 MiB into separate daily batches", async () => {
  const f = await fixture();
  const host = createMcpServer({
    maintenance: true,
    home: f.home,
    applicationFactory: async () => f.app,
    sharedApplications: true,
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-intake-runtime", version: "1" });
  try {
    await host.connect(serverTransport);
    await client.connect(clientTransport);
    await f.app.database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
    const pdf = largePdf(),
      sha = createHash("sha256").update(pdf).digest("hex");
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, JSON.stringify(r)).not.toBe(true);
      return (r.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    const allocation = vi.spyOn(Buffer, "alloc");
    const begin = await call("begin_pdf_upload", {
      literature_id: FIXTURE_LITERATURE.literature_id,
      byte_size: pdf.length,
      sha256: sha,
    });
    expect(allocation.mock.calls.some(([size]) => size > 1024 * 1024)).toBe(
      false,
    );
    allocation.mockRestore();
    const chunkSize = Number(begin.max_chunk_bytes);
    for (let offset = 0; offset < pdf.length; offset += chunkSize)
      await call("append_pdf_upload", {
        upload_id: begin.upload_id,
        offset,
        bytes_base64: pdf
          .subarray(offset, offset + chunkSize)
          .toString("base64"),
      });
    const receipt = await call("commit_pdf_upload", {
      upload_id: begin.upload_id,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      "asset_id",
      "created",
      "literature_id",
      "receipt_id",
      "reference",
      "sha256",
    ]);
    expect(receipt.sha256).toBe(sha);
    const cliId = randomUUID();
    await f.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: cliId,
        meta_literature_id: randomUUID(),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          identifiers: [{ namespace: "doi", value: "10.5555/supplement-cli" }],
        },
      }),
    );
    const path = join(f.home, "synthetic-large.pdf");
    await writeFile(path, pdf);
    const result = await runCli(["import", "pdf", cliId, path], {
      home: f.home,
      json: true,
      stdout: () => undefined,
    });
    expect(result.code).toBe(0);
    expect(result.value).toMatchObject({ sha256: sha, literature_id: cliId });
    expect(
      f
        .sql("SELECT opener FROM intake_open_batches ORDER BY opener")
        .map((r) => r.opener),
    ).toEqual(["supplement:cli", "supplement:mcp"]);
    expect(
      f.sql("SELECT count(*) n FROM import_files WHERE status='uploaded'")[0]!
        .n,
    ).toBe(2);
  } finally {
    vi.restoreAllMocks();
    await client.close();
    await host.close();
    await f.close();
  }
}, 90_000);
