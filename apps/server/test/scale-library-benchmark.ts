import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { backup, DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import {
  canonicalJsonBytes,
  parseLibrarySearchRequest,
  type LibrarySearchPage,
} from "@sciretriever/contracts";
import { queryFingerprint } from "../src/literature/query.js";
import { acquireExecutionRuntime } from "../src/storage/execution/runtime-owner.js";
import { directoryBytes } from "./scale-fixture.js";
import {
  scaleLibraryStorage,
  type ScaleLibrary,
} from "./scale-library-fixture.js";

const script = fileURLToPath(
  new URL("./scale-library-process.ts", import.meta.url),
);
const env = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  COREPACK_ENABLE_NETWORK: "0",
  npm_config_offline: "true",
};
const exec = promisify(execFile);
const deadline = 240_000;
const minute = 60_000;
const now = () => Math.round(performance.now());

async function cli(
  library: ScaleLibrary,
  args: string[],
  timeout = deadline,
  onStart?: (pid: number) => Promise<void>,
) {
  const start = now();
  const running = exec(
    process.execPath,
    ["--experimental-strip-types", script, "cli", library.home, ...args],
    { env, timeout, maxBuffer: 4 * 1024 * 1024 },
  );
  const result = running.catch((error: unknown) => {
    if (error instanceof Error && "stdout" in error)
      throw new Error(
        `${args.join(" ")} failed: ${String(error.stdout).slice(0, 2000)}`,
        { cause: error },
      );
    throw error;
  });
  const [command] = await Promise.all([
    result,
    running.child.pid === undefined ? undefined : onStart?.(running.child.pid),
  ]);
  return {
    elapsed_ms: now() - start,
    response: JSON.parse(command.stdout) as {
      code: number;
      status?: string;
      value?: unknown;
    },
  };
}

function launch<T extends object>(
  library: ScaleLibrary,
  kind: "serve" | "writer",
) {
  const child = fork(script, [kind, library.home, library.catalog], {
    execArgv: ["--experimental-strip-types"],
    env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-6000);
  });
  const exit = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const ready = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Scale ${kind} timed out: ${stderr}`)),
      60_000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message as T);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Scale ${kind} exited (${code}): ${stderr}`));
    });
  });
  return {
    ready,
    async rss() {
      const status = await readFile(`/proc/${child.pid}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      if (rss === undefined)
        throw new Error("Scale process RSS is unavailable");
      return Number(rss) * 1024;
    },
    async close() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        const code = await Promise.race([
          exit,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error(`Scale ${kind} shutdown timed out`));
            }, 30_000);
          }),
        ]);
        if (code !== 0)
          throw new Error(`Scale ${kind} shutdown failed (${code}): ${stderr}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function workbench(origin: string) {
  const endpoint = new URL(origin);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    Number(endpoint.port) === 4174
  )
    throw new Error("Invalid scale workbench endpoint");
  const common = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-Workbench-Init": "1",
  };
  const login = await fetch(`${origin}/auth/login`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: common,
    body: JSON.stringify({ password: "synthetic-scale-library-local" }),
  });
  if (!login.ok) throw new Error(`Scale login failed with ${login.status}`);
  const auth = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .join("; ");
  await login.arrayBuffer();
  const root = await fetch(origin, {
    headers: { Cookie: auth },
    signal: AbortSignal.timeout(20_000),
  });
  if (!root.ok) throw new Error(`Scale workbench root returned ${root.status}`);
  const cookie = [
    auth,
    ...root.headers.getSetCookie().map((item) => item.split(";")[0]!),
  ].join("; ");
  await root.arrayBuffer();
  const attach = await fetch(`${origin}/api/clients`, {
    method: "POST",
    body: "{}",
    headers: { ...common, Cookie: cookie },
    signal: AbortSignal.timeout(20_000),
  });
  if (!attach.ok)
    throw new Error(`Scale workbench client returned ${attach.status}`);
  const grant = (await attach.json()) as { client_id: string; csrf: string };
  return async (path: string, input?: object) => {
    const url = new URL(path, origin);
    url.searchParams.set("client_id", grant.client_id);
    const begin = now();
    const response = await fetch(url, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        ...common,
        Cookie: cookie,
        "X-Workbench-Csrf": grant.csrf,
        "X-Sciretriever-Protocol-Version": "1",
      },
      ...(input === undefined
        ? {}
        : { body: JSON.stringify({ protocol_version: 1, request: input }) }),
      signal: AbortSignal.timeout(deadline),
    });
    const headers_ms = now() - begin;
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed_ms = now() - begin;
    if (!response.ok)
      throw new Error(
        `${path} returned ${response.status}: ${body.toString().slice(0, 500)}`,
      );
    return { headers_ms, elapsed_ms, bytes: body.length, body };
  };
}

function deepPage(library: ScaleLibrary) {
  const limit = 10,
    page = 1000;
  const db = new DatabaseSync(library.catalog, { readOnly: true });
  const start = now();
  try {
    const anchor = db
      .prepare(
        "SELECT literature_id,intake_at FROM literature_intake ORDER BY intake_at DESC,literature_id ASC LIMIT 1 OFFSET ?",
      )
      .get((page - 1) * limit - 1)!;
    const after = db
      .prepare(
        "SELECT literature_id FROM literature_intake ORDER BY intake_at DESC,literature_id ASC LIMIT 1 OFFSET ?",
      )
      .get((page - 1) * limit)!;
    const sort = "intake-desc";
    const core = {
      kind: "library-search",
      version: 1,
      payload: {
        query_fingerprint: queryFingerprint(
          parseLibrarySearchRequest({ query: {} }).query,
        ),
        sort,
        position: { ...anchor, intake_is_null: anchor.intake_at === null },
      },
    };
    const checksum = createHash("sha256")
      .update(canonicalJsonBytes(core))
      .digest("hex");
    return {
      request: {
        query: {},
        sort,
        limit,
        cursor: Buffer.from(canonicalJsonBytes({ ...core, checksum })).toString(
          "base64url",
        ),
      },
      first: String(after.literature_id),
      preparation_ms: now() - start,
    };
  } finally {
    db.close();
  }
}

function sourceRevisions(library: ScaleLibrary) {
  const db = new DatabaseSync(library.catalog, { readOnly: true });
  try {
    return db
      .prepare(
        `
      SELECT r.revision AS source_revision, g.source_revision AS indexed_revision, g.source_count, g.generation_id
      FROM retrieval_source_revision r
      LEFT JOIN retrieval_active_generation a USING(singleton)
      LEFT JOIN retrieval_generations g USING(generation_id)
    `,
      )
      .get()!;
  } finally {
    db.close();
  }
}

function writerCount(library: ScaleLibrary) {
  const db = new DatabaseSync(library.catalog, { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM literatures WHERE literature_id GLOB 'e05ca1e0-0001-*'",
        )
        .get()!.n,
    );
  } finally {
    db.close();
  }
}

async function reads(
  library: ScaleLibrary,
  limited: boolean,
  concurrent: boolean,
  save: (name: string, value: unknown) => Promise<void>,
  memoryOnly = false,
) {
  type Read = Awaited<ReturnType<typeof workbench>>;
  const depth = limited ? null : deepPage(library);
  const statusQuery = { statuses: ["ASSET_READY"] };
  const operations: {
    name: string;
    read(client: Read): ReturnType<Read>;
    check(body: Buffer): unknown;
  }[] = [];
  const addQuery = (
    name: string,
    route: string,
    request: object,
    check: (value: unknown) => unknown,
  ) => {
    operations.push({
      name,
      read: (client) => client(`/api/v1/query/${route}`, request),
      check: (body) => {
        const reply = JSON.parse(body.toString()) as {
          result?: unknown;
          page?: unknown;
        };
        return check(route === "search" ? reply.page : reply.result);
      },
    });
  };
  const counts = (value: unknown) => {
    const r = value as { total: number; statuses: object };
    if (!Number.isSafeInteger(r.total) || r.total < 1)
      throw new Error("Unexpected scale library count");
    return r;
  };
  const page = (value: unknown) => {
    const r = value as LibrarySearchPage;
    if (!r.items.length) throw new Error("Unexpected empty scale library page");
    return {
      total_count: r.total_count,
      items: r.items.length,
      first: r.items[0]!.literature.literature_id,
    };
  };
  addQuery("library_counts", "library-counts", { query: {} }, counts);
  addQuery("first_page", "search", { query: {}, limit: 10 }, page);
  addQuery(
    "keyword",
    "search",
    { query: { text: "spectroscopy" }, sort: "relevance", limit: 10 },
    page,
  );
  if (depth) {
    addQuery("status_counts", "library-counts", { query: statusQuery }, counts);
    addQuery("status_page", "search", { query: statusQuery, limit: 10 }, page);
    addQuery("page_1000", "search", depth.request, (r) => {
      const row = page(r);
      if (!concurrent && row.first !== depth.first)
        throw new Error("Page 1000 anchor did not match the fixture");
      return { ...row, preparation_ms: depth.preparation_ms };
    });
    operations.push(
      {
        name: "running_task_http",
        read: (client) => client(`/api/tasks/${library.jobs.running}`),
        check: (body) => {
          const { task } = JSON.parse(body.toString()) as {
            task: { job: { status: string }; source_results: unknown };
          };
          if (task.job.status !== "running")
            throw new Error("The synthetic citation job changed state");
          return {
            status: task.job.status,
            source_results: task.source_results,
          };
        },
      },
      {
        name: "pdf_20mib",
        read: (client) =>
          client("/api/v1/query/material-bytes", {
            literature_id: library.pdf.literature_id,
            asset_id: library.pdf.asset,
            asset_sha256: library.pdf.artifact.sha256,
          }),
        check: (body) => {
          if (
            body.length !== library.pdf.artifact.byte_size ||
            createHash("sha256").update(body).digest("hex") !==
              library.pdf.artifact.sha256
          )
            throw new Error("PDF bytes changed");
          return {
            pages: library.pdf.pages,
            sha256: library.pdf.artifact.sha256,
          };
        },
      },
    );
  }
  const readPair = async (
    client: Read,
    operation: (typeof operations)[number],
  ) => {
    const pair = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { body, ...measurement } = await operation.read(client);
      pair.push({ ...measurement, result: operation.check(body) });
    }
    return pair;
  };
  if (memoryOnly) {
    const child = launch<{ origin: string }>(library, "serve");
    try {
      const { origin } = await child.ready;
      const startup_rss_bytes = await child.rss();
      const client = await workbench(origin);
      const measurements = [];
      for (const operation of operations)
        measurements.push({
          name: operation.name,
          attempt: await readPair(client, operation),
        });
      await save("memory", {
        startup_rss_bytes,
        after_reads_rss_bytes: await child.rss(),
        measurements,
        load: loadavg(),
      });
    } finally {
      await child.close();
    }
    return;
  }
  const prefix = concurrent ? "concurrent" : "idle";
  for (const operation of operations) {
    const start = now();
    const child = launch<{ origin: string }>(library, "serve");
    try {
      const { origin } = await child.ready;
      const startup_ms = now() - start;
      const client = await workbench(origin);
      const writesBefore = concurrent ? writerCount(library) : null;
      const pair = await readPair(client, operation);
      await save(`${prefix}-${operation.name}`, {
        startup_ms,
        origin,
        attempt: pair,
        ...(writesBefore === null
          ? {}
          : {
              writes_before: writesBefore,
              writes_after: writerCount(library),
            }),
        load: loadavg(),
      });
    } finally {
      await child.close();
    }
  }
  if (depth) {
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cli(library, ["jobs", "show", library.jobs.running]);
      if (result.response.status !== "running")
        throw new Error("CLI returned a different task status");
      attempts.push(result);
    }
    await save(`${prefix}-running_task_cli`, {
      attempt: attempts,
      load: loadavg(),
    });
  }
}

async function concurrentReads(
  library: ScaleLibrary,
  save: (name: string, value: unknown) => Promise<void>,
) {
  // Keep the reusable benchmark catalog at exactly the generated revision.
  const runs = resolve("sandbox/runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(
    join(runs, "2026-11-21-scale-library-writes-"),
  );
  const home = join(directory, "home");
  const catalog = join(directory, "catalog.sqlite");
  const clone = { ...library, home, catalog };
  const start = now();
  const source = new DatabaseSync(library.catalog, { readOnly: true });
  try {
    await backup(source, catalog, { rate: 8192 });
  } finally {
    source.close();
  }
  await chmod(catalog, 0o600);
  const config = join(home, ".sciretriever");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(
    join(config, "config.toml"),
    [
      "[paths]",
      `catalog_path=${JSON.stringify(catalog)}`,
      `artifact_root=${JSON.stringify(library.artifacts)}`,
      "[sources.acquisition]",
      'mode="custom"',
      "providers=[]",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  const initial = sourceRevisions(clone);
  await save("concurrent-copy", {
    catalog,
    elapsed_ms: now() - start,
    ...initial,
  });
  const runtime = await acquireExecutionRuntime(catalog);
  try {
    const writer = launch<{ ready: true }>(clone, "writer");
    const started = now();
    try {
      await writer.ready;
      await reads(clone, false, true, save);
    } finally {
      await writer.close();
      const elapsed_ms = now() - started;
      const written = writerCount(clone);
      await save("concurrent-writes", {
        elapsed_ms,
        written,
        papers_per_second: (written * 1000) / elapsed_ms,
        ...sourceRevisions(clone),
      });
    }
  } finally {
    await runtime.release();
  }
}

export async function measureScaleLibrary(
  library: ScaleLibrary,
  reports: string,
  stage: "all" | "index" | "reads" | "memory",
) {
  const write = (name: string, value: unknown) =>
    writeFile(
      join(reports, `${name}.json`),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  // The seeded running job represents an external executor. Retain the same
  // runtime lock a real executor owns, so CLI and Workbench skip recovery.
  const runtime = await acquireExecutionRuntime(library.catalog);
  try {
    if (stage === "reads" || stage === "memory") {
      const saved = JSON.parse(
        await readFile(join(reports, "rebuild-index.json"), "utf8"),
      ) as {
        response: { code: number; value: { generation_id: string } };
        source_revision: number;
      };
      const current = sourceRevisions(library);
      if (
        saved.response.code !== 0 ||
        current.source_revision !== saved.source_revision ||
        current.indexed_revision !== current.source_revision ||
        current.generation_id !== saved.response.value.generation_id
      )
        throw new Error("The catalog has changed since the recorded rebuild");
    } else {
      const before = await scaleLibraryStorage(library);
      await write("storage-before-index", {
        ...before,
        directory_bytes: await directoryBytes(library.artifacts),
      });
      const verification = await cli(
        library,
        ["maintenance", "verify-catalog"],
        30 * minute,
      );
      await write("verify-catalog", verification);
      const timeout = (library.papers === 1_000_000 ? 9 : 4) * 60 * minute;
      const rebuild = await cli(
        library,
        ["maintenance", "rebuild-index"],
        timeout,
        (pid) =>
          write("rebuild-start", {
            pid,
            at: new Date().toISOString(),
            timeout_ms: timeout,
            load: loadavg(),
          }),
      );
      const revisions = sourceRevisions(library);
      await write("rebuild-index", { ...rebuild, ...revisions });
      if (revisions.indexed_revision !== revisions.source_revision)
        throw new Error(
          "The rebuilt scale library index did not reach the source revision",
        );
      const storage = await scaleLibraryStorage(library);
      await write("storage", {
        ...storage,
        directory_bytes: await directoryBytes(library.artifacts),
      });
      const final = await cli(
        library,
        ["maintenance", "verify-catalog"],
        30 * minute,
      );
      await write("verify-catalog-final", final);
      if ((final.response.value as { hashes?: string }).hashes !== "verified")
        throw new Error(
          "The rebuilt scale library index hashes were not verified",
        );
    }

    if (stage === "index") return;
    if (stage === "memory") {
      await reads(library, library.papers === 10_000_000, false, write, true);
      return;
    }
    await reads(library, library.papers === 10_000_000, false, write);
    if (library.papers === 1_000_000) {
      await reads(library, false, false, write, true);
      await concurrentReads(library, write);
    }
  } finally {
    await runtime.release();
  }
}
