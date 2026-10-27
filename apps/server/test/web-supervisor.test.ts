import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireExecutionRuntime } from "../src/storage/execution/runtime-owner.js";
import { createServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { RestartAdmission } from "../src/application/restart-admission.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import { ManagedConfigurationLifecycle } from "../src/configuration/apply.js";
import { sourceConfiguration } from "../src/configuration/sources.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import {
  startWebSupervisor,
  type WebSupervisor,
} from "../src/cli/web-supervisor.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
beforeAll(async () => {
  await promisify(execFile)("pnpm", ["exec", "tsc", "-b"], {
    cwd: resolve("."),
    timeout: 90000,
  });
  await promisify(execFile)(
    process.execPath,
    ["scripts/build-workbench-assets.mjs"],
    { cwd: resolve("."), timeout: 90000 },
  );
}, 120000);
const servers: { server: WebSupervisor; home: string }[] = [];
afterEach(async () => {
  for (const r of servers.splice(0)) {
    await writeFile(join(r.home, "allow-close"), "");
    await writeFile(join(r.home, "finish-parsing"), "");
    await writeFile(join(r.home, "finish-probe"), "");
    await writeFile(join(r.home, "cancel-transfer"), "");
    await writeFile(join(r.home, "finish-transfer-cleanup"), "");
    await r.server.close();
    await rm(r.home, { recursive: true, force: true });
  }
});
async function start(
  fixture = false,
  options: Partial<Parameters<typeof startWebSupervisor>[0]> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-web-supervisor-"));
  await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
  await writeFile(
    join(home, ".sciretriever", "config.toml"),
    '[execution]\nmax_concurrency=1\n[sources.acquisition]\nmode="custom"\nproviders=[]\n',
    { mode: 0o600 },
  );
  const server = await startWebSupervisor({
    home,
    port: 0,
    access: workbenchTestAccess,
    workerEntry: fixture
      ? fileURLToPath(
          new URL("./fixtures/web-lifecycle-worker.mjs", import.meta.url),
        )
      : resolve("apps/server/dist/cli/web-worker.js"),
    ...options,
  });
  servers.push({ home, server });
  return { home, server };
}
async function client(server: WebSupervisor) {
  const origin = new URL(
    server.ready.urls.find((u) => u.startsWith("http://127.0.0.1:"))!,
  ).origin;
  const auth = await workbenchLogin(origin),
    root = await fetch(origin, { headers: { Cookie: auth } }),
    cookie = `${auth}; ${root.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ")}`;
  const init = await fetch(`${origin}/api/clients`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "X-Workbench-Init": "1",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const grant = (await init.json()) as { client_id: string; csrf: string };
  const call = async (path: string, value?: unknown) =>
    fetch(`${origin}${path}?client_id=${grant.client_id}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Workbench-Csrf": grant.csrf,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const config = async (name: string, value?: unknown) => {
    const response = await call(`/api/configuration/${name}`, value);
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { origin, cookie, call, config };
}
async function apply(c: Awaited<ReturnType<typeof client>>) {
  const d = (await c.config("sources")).body.result as {
    binding_revision: string;
    runtime: { runtime_id: string };
  };
  const request = {
    request_id: randomUUID(),
    runtime_id: d.runtime.runtime_id,
    target_binding_revision: d.binding_revision,
  };
  return { request, response: await c.config("apply", request) };
}
it("flushes 202, hands one generation to its successor on the same ephemeral port, and invalidates old authentication", async () => {
  const { server } = await start();
  const c = await client(server),
    first = server.ready;
  const started = await apply(c);
  expect(started.response.status, JSON.stringify(started.response.body)).toBe(
    202,
  );
  await expect.poll(() => server.ready.generation, { timeout: 20000 }).toBe(2);
  expect(server.ready.port).toBe(first.port);
  expect(server.state.state).toBe("applied");
  const old = await fetch(`${c.origin}/api/configuration/sources`, {
    headers: { Cookie: c.cookie },
  });
  expect(old.status).toBe(401);
  const next = await client(server),
    status = (await next.config("apply")).body.result as { state: string };
  expect(status.state).toBe("applied");
}, 30000);
it("drains real queued/running tasks, rejects new submissions and keeps published facts through the handoff", async () => {
  const { home, server } = await start(true);
  const c = await client(server),
    seed = JSON.parse(await readFile(join(home, "seed.json"), "utf8"));
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await c.call("/api/tasks", {
      kind: "processing",
      request: {
        schema_version: 1,
        idempotency_key: randomUUID(),
        operations: [
          {
            operation: "parse-documents",
            request: { ...seed, profiles: ["pipeline"] },
          },
        ],
      },
    });
    const result = (await response.json()) as { task: { job_id: string } };
    expect({ status: response.status, ...result }).toMatchObject({
      status: 201,
    });
    ids.push(result.task.job_id);
    expect(
      (await c.call(`/api/tasks/${result.task.job_id}/start`, {})).status,
    ).toBe(202);
  }
  await expect
    .poll(async () =>
      readFile(join(home, "parser-started"), "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  const generation = server.ready.generation,
    started = await apply(c);
  expect(started.response.status).toBe(202);
  await expect
    .poll(() => server.state.blockers.queued + server.state.blockers.running)
    .toBeGreaterThan(0);
  expect(server.ready.generation).toBe(generation);
  const denied = await c.call("/api/tasks", {
    kind: "processing",
    request: {
      schema_version: 1,
      idempotency_key: randomUUID(),
      operations: [
        {
          operation: "parse-documents",
          request: { ...seed, profiles: ["pipeline"] },
        },
      ],
    },
  });
  expect(denied.status).toBe(409);
  await writeFile(join(home, "finish-parsing"), "");
  await expect
    .poll(() => server.ready.generation, { timeout: 20000 })
    .toBe(generation + 1);
  const next = await client(server);
  for (const id of ids) {
    const response = await next.call(`/api/tasks/${id}`);
    const result = (await response.json()) as {
      task: { job: { status: string } };
    };
    expect(result.task.job.status).toBe("completed");
  }
  expect(JSON.parse(await readFile(join(home, "seed.json"), "utf8"))).toEqual(
    seed,
  );
}, 30000);
it("cancels a waiting apply without restarting and does not kill a stalled graceful close", async () => {
  const diagnostics: string[] = [];
  const { home, server } = await start(true, {
    closeWarningMs: 100,
    onDiagnostic: (v) => diagnostics.push(v.code),
  });
  const c = await client(server);
  const seed = JSON.parse(await readFile(join(home, "seed.json"), "utf8"));
  const response = await c.call("/api/tasks", {
    kind: "processing",
    request: {
      schema_version: 1,
      idempotency_key: randomUUID(),
      operations: [
        {
          operation: "parse-documents",
          request: { ...seed, profiles: ["pipeline"] },
        },
      ],
    },
  });
  const job = (await response.json()) as { task: { job_id: string } };
  await c.call(`/api/tasks/${job.task.job_id}/start`, {});
  await expect
    .poll(async () =>
      readFile(join(home, "parser-started"), "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  const first = await apply(c);
  await expect.poll(() => server.state.state).toBe("waiting");
  expect(
    (
      await c.config("apply-cancel", {
        request_id: first.request.request_id,
        runtime_id: first.request.runtime_id,
      })
    ).status,
  ).toBe(200);
  await expect.poll(() => server.state.state).toBe("cancelled");
  expect(server.ready.generation).toBe(1);
  // Owner cancellation remains available while apply is waiting.
  const second = await apply(c);
  await expect.poll(() => server.state.state).toBe("waiting");
  const cancelled = await c.call(`/api/tasks/${job.task.job_id}/cancel`, {});
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({
    task: { job: { status: "cancelled" } },
  });
  await writeFile(join(home, "stall-close"), "");
  await expect
    .poll(
      () =>
        JSON.stringify({
          state: server.state.state,
          blockers: server.state.blockers,
          diagnostics,
        }),
      { timeout: 10000 },
    )
    .toContain('"state":"failed"');
  expect(server.ready.generation).toBe(1);
  expect(
    (
      await c.config("apply-cancel", {
        request_id: second.request.request_id,
        runtime_id: second.request.runtime_id,
      })
    ).status,
  ).toBe(409);
  await writeFile(join(home, "allow-close"), "");
  await expect.poll(() => server.ready.generation, { timeout: 20000 }).toBe(2);
}, 30000);

it("waits for admitted probes and an external execution lease, and keeps safe recent results across restart", async () => {
  const { home, server } = await start(true);
  const c = await client(server);
  const directory = (await c.config("sources")).body.result as {
    rows: { source: string; source_revision: string }[];
  };
  const source = directory.rows.find((r) => r.source === "crossref")!;
  const tested = await c.config("source-test", {
    source: source.source,
    source_revision: source.source_revision,
    request_id: randomUUID(),
  });
  expect(tested.status).toBe(202);
  await expect
    .poll(async () =>
      readFile(join(home, "probe-started"), "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  const external = await acquireExecutionRuntime(server.ready.catalog);
  try {
    const result = await apply(c);
    expect(result.response.status).toBe(202);
    await expect.poll(() => server.state.blockers.probes).toBeGreaterThan(0);
    await writeFile(join(home, "finish-probe"), "");
    await expect.poll(() => server.state.blockers.probes).toBe(0);
    expect(server.ready.generation).toBe(1);
    expect(server.state.state).toBe("waiting");
  } finally {
    await external.release();
  }
  await expect.poll(() => server.ready.generation, { timeout: 20000 }).toBe(2);
  const next = await client(server),
    saved = (await next.config("sources")).body.result as {
      rows: { source: string; test: { latest: { status: string } } }[];
    };
  expect(
    saved.rows.find((r) => r.source === "crossref")!.test.latest.status,
  ).toBe("available");
}, 30000);
it("rejects a stale saved target instead of silently applying another configuration", async () => {
  const { home, server } = await start(true);
  const c = await client(server);
  const directory = (await c.config("sources")).body.result as {
    rows: { source: string; source_revision: string }[];
  };
  await c.config("source-test", {
    source: "crossref",
    source_revision: directory.rows.find((r) => r.source === "crossref")!
      .source_revision,
    request_id: randomUUID(),
  });
  await expect
    .poll(async () =>
      readFile(join(home, "probe-started"), "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  await apply(c);
  await expect.poll(() => server.state.state).toBe("waiting");
  const path = join(home, ".sciretriever", "config.toml"),
    text = await readFile(path, "utf8");
  await writeFile(
    `${path}.external-publication`,
    text +
      '\n[sources.acquisition.unpaywall]\ncontact_email="changed@example.test"\n',
    { mode: 0o600 },
  );
  await rename(`${path}.external-publication`, path);
  await expect.poll(() => server.state.state).toBe("failed");
  expect(server.ready.generation).toBe(1);
  expect(server.state.problem?.technical_details.diagnostics[0]?.code).toBe(
    "configuration-apply-target-stale",
  );
  await writeFile(join(home, "finish-probe"), "");
}, 30000);
it("uses bounded crash backoff, treats naked 75 as a crash, and never replays a running task", async () => {
  const codes: string[] = [];
  const { home, server } = await start(true, {
    retryDelays: [10, 20, 40],
    onDiagnostic: (v) => codes.push(v.code),
  });
  const c = await client(server),
    seed = JSON.parse(await readFile(join(home, "seed.json"), "utf8"));
  const response = await c.call("/api/tasks", {
    kind: "processing",
    request: {
      schema_version: 1,
      idempotency_key: randomUUID(),
      operations: [
        {
          operation: "parse-documents",
          request: { ...seed, profiles: ["pipeline"] },
        },
      ],
    },
  });
  const job = (await response.json()) as { task: { job_id: string } };
  await c.call(`/api/tasks/${job.task.job_id}/start`, {});
  await expect
    .poll(async () =>
      readFile(join(home, "parser-started"), "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  process.kill(server.ready.pid, "SIGKILL");
  await expect.poll(() => server.ready.generation, { timeout: 20000 }).toBe(2);
  const next = await client(server);
  const read = await next.call(`/api/tasks/${job.task.job_id}`),
    saved = (await read.json()) as { task: { job: { status: string } } };
  expect(saved.task.job.status).toBe("interrupted");
  expect(
    (await readFile(join(home, "parser-started"), "utf8")).trim().split("\n"),
  ).toHaveLength(1);
  for (let generation = 2; generation <= 4; generation++) {
    const pid = server.ready.pid;
    if (generation === 2) {
      await writeFile(join(home, "exit75"), "");
      await expect
        .poll(() => codes.filter((c) => c === "web-worker-exit").length, {
          timeout: 10000,
        })
        .toBeGreaterThanOrEqual(2);
      await rm(join(home, "exit75"));
    } else process.kill(pid, "SIGKILL");
    if (generation < 4)
      await expect
        .poll(() => server.ready.generation, { timeout: 20000 })
        .toBe(generation + 1);
  }
  expect(await server.stopped).toBe(1);
  expect(codes.filter((c) => c === "web-crash-backoff")).toHaveLength(3);
  expect(codes).toContain("web-crash-limit");
  expect(codes).not.toContain("web-apply-exit");
}, 45000);
it("fails on a port stolen between generations without choosing another port or crash-looping", async () => {
  const thief = createServer();
  let port = 0;
  const codes: string[] = [];
  const { server } = await start(false, {
    onReady: (r) => {
      port = r.port;
    },
    onDiagnostic: (d) => {
      codes.push(d.code);
      if (d.code === "web-apply-exit") thief.listen(port, "127.0.0.1");
    },
  });
  try {
    const c = await client(server);
    expect((await apply(c)).response.status).toBe(202);
    expect(await server.stopped).toBe(1);
    expect(server.ready.generation).toBe(1);
    expect(codes).toContain("web-startup-failed");
    expect(codes).not.toContain("web-crash-backoff");
  } finally {
    await new Promise<void>((done) => thief.close(() => done()));
  }
}, 30000);

it.each(["parent-signal", "parent-death", "child-signal"] as const)(
  "closes the complete service on %s without resurrecting a worker",
  async (scenario) => {
    const { fork } = await import("node:child_process");
    const home = await mkdtemp(join(tmpdir(), "sciretriever-web-parent-"));
    const parent = fork(
      fileURLToPath(
        new URL("./fixtures/web-supervisor-parent.mjs", import.meta.url),
      ),
      [home],
      {
        execPath: process.execPath,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: process.env,
      },
    );
    let target: { port: number; pid: number } | undefined;
    const ready = new Promise<void>((done, fail) => {
      parent.on("message", (v: unknown) => {
        if (!v || typeof v !== "object") return;
        target = v as typeof target;
        done();
      });
      parent.once("error", fail);
    });
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((done) => parent.once("exit", (code, signal) => done({ code, signal })));
    try {
      await ready;
      if (scenario === "child-signal") process.kill(target!.pid, "SIGTERM");
      else parent.kill(scenario === "parent-death" ? "SIGKILL" : "SIGTERM");
      const result = await exit;
      if (scenario !== "parent-death") expect(result.code).toBe(0);
      await expect
        .poll(
          async () =>
            fetch(`http://127.0.0.1:${target!.port}/auth/status`).then(
              () => false,
              () => true,
            ),
          { timeout: 10000 },
        )
        .toBe(true);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null)
        parent.kill("SIGTERM");
      await exit;
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);

it("keeps a started transfer's cleanup lease across cancellation before committing the handoff", async () => {
  const { home, server } = await start(true);
  const c = await client(server);
  await writeFile(join(home, "begin-transfer"), "");
  await expect
    .poll(async () =>
      readFile(join(home, "transfer-started")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  expect((await apply(c)).response.status).toBe(202);
  await expect
    .poll(() => server.state.blockers.browser_transfers)
    .toBeGreaterThan(0);
  await writeFile(join(home, "cancel-transfer"), "");
  await expect
    .poll(async () =>
      readFile(join(home, "transfer-cancel-observed")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  expect(server.ready.generation).toBe(1);
  expect(server.state.state).toBe("waiting");
  await writeFile(join(home, "finish-transfer-cleanup"), "");
  await expect.poll(() => server.ready.generation, { timeout: 20000 }).toBe(2);
}, 30000);

it.each(["wrong-version", "wrong-generation", "never-ready"] as const)(
  "rejects %s without publishing ready or starting a second child",
  async (scenario) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-web-protocol-"));
    const codes: string[] = [];
    let ready = 0;
    try {
      await writeFile(join(home, "scenario"), scenario);
      await expect(
        startWebSupervisor({
          home,
          port: 0,
          access: workbenchTestAccess,
          workerEntry: fileURLToPath(
            new URL("./fixtures/web-protocol-worker.mjs", import.meta.url),
          ),
          startupTimeoutMs: 200,
          onReady: () => {
            ready++;
          },
          onDiagnostic: (v) => codes.push(v.code),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(ready).toBe(0);
      expect(codes).toContain(
        scenario === "never-ready" ? "web-startup-timeout" : "web-ipc-invalid",
      );
      expect(codes).not.toContain("web-crash-backoff");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(["startup-failed", "unsupported-schema"] as const)(
  "refuses %s once without opening a replacement or migrating",
  async (scenario) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-web-startup-")),
      codes: string[] = [];
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    const catalog = join(home, ".sciretriever/catalog.sqlite");
    let before: string | undefined;
    try {
      if (scenario === "startup-failed")
        await writeFile(join(home, "scenario"), scenario);
      else {
        const db = new DatabaseSync(catalog);
        try {
          db.exec("CREATE TABLE prior_schema(id INTEGER PRIMARY KEY)");
        } finally {
          db.close();
        }
        before = createHash("sha256")
          .update(await readFile(catalog))
          .digest("hex");
      }
      await expect(
        startWebSupervisor({
          home,
          port: 0,
          access: workbenchTestAccess,
          ...(scenario === "startup-failed"
            ? {
                workerEntry: fileURLToPath(
                  new URL(
                    "./fixtures/web-lifecycle-worker.mjs",
                    import.meta.url,
                  ),
                ),
              }
            : { workerEntry: resolve("apps/server/dist/cli/web-worker.js") }),
          onDiagnostic: (v) => codes.push(v.code),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(codes).toContain("web-startup-failed");
      expect(codes).not.toContain("web-crash-backoff");
      expect(codes.filter((c) => c === "web-worker-exit")).toHaveLength(1);
      if (before)
        expect(
          createHash("sha256")
            .update(await readFile(catalog))
            .digest("hex"),
        ).toBe(before);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("cancels an accepted but unflushed apply locally and never sends its commit intent", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-web-unflushed-"));
  const owner = new TypeScriptConfigurationOwner(home);
  let sent = 0,
    cancelSent = 0;
  const lifecycle = new ManagedConfigurationLifecycle(
    randomUUID(),
    1,
    undefined,
    () => {
      sent++;
    },
    async () => {
      cancelSent++;
      return true;
    },
  );
  const web = await startProductionWorkbench({
    home,
    port: 0,
    access: workbenchTestAccess,
    lifecycle,
    applicationOptions: { configurationOwner: owner },
    assets: new Map([
      ["/", { contentType: "text/html", body: "Synthetic unflushed apply" }],
    ]),
  });
  try {
    await lifecycle.ready();
    const directory = await sourceConfiguration(owner).directory();
    const request = {
      runtime_id: directory.runtime!.runtime_id,
      request_id: randomUUID(),
      target_binding_revision: directory.binding_revision,
    };
    expect((await lifecycle.request(request)).state).toBe("waiting");
    await expect(
      web.application.restartAdmission!.newWork(async () => {}),
    ).rejects.toMatchObject({ code: "configuration-apply-busy" });
    expect(
      (
        await lifecycle.cancel({
          runtime_id: request.runtime_id,
          request_id: request.request_id,
        })
      ).state,
    ).toBe("cancelled");
    lifecycle.flushed();
    expect(sent).toBe(0);
    expect(cancelSent).toBe(0);
    await web.application.restartAdmission!.newWork(async () => {});
  } finally {
    await web.close();
    await rm(home, { recursive: true, force: true });
  }
});

it.each(["intent", "activity"] as const)(
  "does not resurrect a cancelled apply when its %s acquisition resolves late",
  async (phase) => {
    const { home, server } = await start(),
      c = await client(server);
    let entered!: () => void, resume!: () => void;
    const atLock = new Promise<void>((done) => {
        entered = done;
      }),
      finish = new Promise<void>((done) => {
        resume = done;
      });
    const original = RestartAdmission.prototype.acquire;
    let injected = false;
    const spy = vi
      .spyOn(RestartAdmission.prototype, "acquire")
      .mockImplementation(async function (
        this: RestartAdmission,
        actual,
        mode,
      ) {
        const lease = await original.call(this, actual, mode);
        if (
          !injected &&
          this.home === home &&
          actual === phase &&
          mode === "exclusive"
        ) {
          injected = true;
          entered();
          await finish;
        }
        return lease;
      });
    try {
      const request = (await apply(c)).request;
      await atLock;
      expect(
        (
          await c.config("apply-cancel", {
            runtime_id: request.runtime_id,
            request_id: request.request_id,
          })
        ).status,
      ).toBe(200);
      expect(server.state.state).toBe("cancelled");
      resume();
      await expect
        .poll(async () => {
          try {
            const lease = await new RestartAdmission(home).acquire(
              "intent",
              "exclusive",
            );
            await lease.release();
            return true;
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "configuration-apply-busy"
            )
              return false;
            throw error;
          }
        })
        .toBe(true);
      expect(server.state.state).toBe("cancelled");
      expect(server.ready.generation).toBe(1);
      expect((await apply(c)).response.status).toBe(202);
      await expect
        .poll(() => server.ready.generation, { timeout: 20000 })
        .toBe(2);
    } finally {
      resume();
      spy.mockRestore();
    }
  },
  30000,
);

it("coalesces concurrent apply receipts and does not let a late cancel acknowledgement overwrite its successor", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-web-apply-cas-")),
    owner = new TypeScriptConfigurationOwner(home);
  let sent = 0,
    acknowledge!: (value: boolean) => void;
  const acknowledgement = new Promise<boolean>((resolve) => {
    acknowledge = resolve;
  });
  const lifecycle = new ManagedConfigurationLifecycle(
    randomUUID(),
    1,
    undefined,
    () => {
      sent++;
    },
    () => acknowledgement,
  );
  const web = await startProductionWorkbench({
    home,
    port: 0,
    access: workbenchTestAccess,
    lifecycle,
    applicationOptions: { configurationOwner: owner },
    assets: new Map([
      ["/", { contentType: "text/html", body: "Synthetic concurrent apply" }],
    ]),
  });
  try {
    await lifecycle.ready();
    const directory = await sourceConfiguration(owner).directory();
    const request = () => ({
      runtime_id: directory.runtime!.runtime_id,
      request_id: randomUUID(),
      target_binding_revision: directory.binding_revision,
    });
    const [first, duplicate] = await Promise.all([
      lifecycle.request(request()),
      lifecycle.request(request()),
    ]);
    expect(first.request_id).toBe(duplicate.request_id);
    expect(sent).toBe(0);
    lifecycle.flushed();
    expect(sent).toBe(1);
    const cancelling = lifecycle.cancel({
      runtime_id: first.runtime_id,
      request_id: first.request_id,
    });
    lifecycle.update({
      ...lifecycle.state(),
      state: "cancelled",
      can_cancel: false,
    });
    const next = await lifecycle.request(request());
    lifecycle.flushed();
    expect(sent).toBe(2);
    acknowledge(true);
    expect(await cancelling).toMatchObject({
      request_id: next.request_id,
      state: "waiting",
    });
    expect(lifecycle.state()).toMatchObject({
      request_id: next.request_id,
      state: "waiting",
      can_cancel: true,
    });
  } finally {
    acknowledge(true);
    web.application.restartAdmission!.freeze(false);
    await web.close();
    await rm(home, { recursive: true, force: true });
  }
});
