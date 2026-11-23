// Opt-in performance acceptance. Run the built server on the prepared 14.1
// copy. The runbook records the metrics, timing boundaries, and environment.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once, on } from "node:events";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { loadavg, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import {
  canonicalJsonBytes,
  EMPTY_METADATA,
  parseLibrarySearchRequest,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../dist/bootstrap/application.js";
import { startProductionWorkbench } from "../dist/bootstrap/workbench.js";
import { parseCredentialText } from "../dist/configuration/credentials.js";
import { activityContext, withActivity } from "../dist/logging/activity.js";
import { acquireExecutionRuntime } from "../dist/storage/execution/runtime-owner.js";
import { SHORT_READ_LIMIT_MS } from "../dist/storage/sqlite/read-lanes.js";
import {
  LibraryRelevanceCache,
  libraryPageIds,
} from "../dist/storage/sqlite/library-page.js";
import { StoredLibraryState } from "../dist/storage/sqlite/library-state.js";
import {
  LIBRARY_MEMBER_SCORE_BUDGET,
  rankLibraryMembers,
} from "../dist/storage/sqlite/library-search-rank.js";
import { queryTerms } from "../dist/literature/query.js";
import { normalizeQueryText } from "../dist/literature/unicode-casefold.js";
import { SqliteWorker } from "../dist/storage/sqlite/worker.js";
import { CatalogWriteAdmission } from "../dist/storage/write-admission.js";

const [mode, directory, destination, reference] = process.argv.slice(2);
const root = resolve(directory);
assert.equal(dirname(root), resolve("sandbox/runs"));
assert.match(basename(root), /^scale-acceptance-(10k|1m)-\w+$/u);
assert.equal(await realpath(root), root);
const prepared = JSON.parse(
  await readFile(join(root, "prepared.json"), "utf8"),
);
const { scale, fixture, folder, corpus } = prepared;
const catalog = join(root, "catalog.sqlite");
assert.equal(fixture.catalog, catalog);
assert.equal(fixture.home, join(root, "home"));
assert.equal(fixture.artifacts, join(root, "artifacts"));
assert.equal(await realpath(catalog), catalog);
assert.equal(corpus.papers, scale === "10k" ? 10_000 : 1_000_000);
assert.equal(corpus.obtained, corpus.papers / 10);
const password = "synthetic-scale-acceptance-only";
const stop = new AbortController();
process.once("SIGTERM", () =>
  stop.abort(new Error("Scale acceptance interrupted")),
);
const options = {
  metadata: {},
  browserHost: () => null,
  startupCredentials: parseCredentialText(""),
};

const objectives = {
  home: 1000,
  counts: 200,
  workset: 1000,
  search: 1500,
  task: 500,
};
// A fixed query and response size are used at both scales. Three times the
// small-catalog P95 leaves room for index depth and filesystem variation.
const ratioLimit = 3;
const trials = 20;
const batchSize = 25;
// Offer approximately 104 papers/s to leave room for pacing variation. Check
// the actual rate of committed new papers during the read window.
const batchPeriod = 240;

function preparedObservation(sequence, stamp, run) {
  const record = `${run}-${sequence}`;
  const metadata = {
    ...EMPTY_METADATA,
    title: `Scale acceptance instrumental calibration ${record}`,
    abstract:
      "Offline observations compare the reproducibility of instrument calibration. "
        .repeat(6)
        .trim(),
    publication_year: 2026,
    publication_form: "journal-article",
    language: "en",
    venue: "Synthetic Instrumentation Reports",
    identifiers: [{ namespace: "doi", value: `10.7788/${record}` }],
  };
  return parseMetadataObservation({
    observation_id: randomUUID(),
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: "synthetic-scale",
      source_record_id: record,
      observed_at: stamp,
      input_sha256: createHash("sha256")
        .update(canonicalJsonBytes(metadata))
        .digest("hex"),
      parameters_sha256: null,
    },
    metadata,
    version_role: "published",
    source_type: null,
    source_type_mapping_version: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}

function watchParent() {
  process.on("message", (value) => {
    if (value === "stop") stop.abort();
  });
  process.once("disconnect", () => stop.abort());
}

function traceBackfill() {
  const run = CatalogWriteAdmission.prototype.runBackfill;
  CatalogWriteAdmission.prototype.runBackfill = function (batch, signal) {
    return run.call(
      this,
      async () => {
        const started = Date.now();
        const admitted = performance.now();
        const more = await batch();
        if (process.connected)
          process.send({
            backfill: { started, held_ms: performance.now() - admitted, more },
          });
        return more;
      },
      signal,
    );
  };
}

async function serve() {
  watchParent();
  if (destination === "count-backfill") traceBackfill();
  const traceWrites = destination === "trace-writes";
  if (destination === "trace-wal") {
    const idle = SqliteWorker.prototype.idleWalCheckpoint;
    SqliteWorker.prototype.idleWalCheckpoint = async function () {
      const file = await stat(catalog + "-wal").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      const idle_ms = file ? Date.now() - file.mtimeMs : null;
      const truncated = await idle.call(this);
      if (process.connected)
        process.send({
          wal_check: { idle_ms, truncated, size: file?.size ?? 0 },
        });
      return truncated;
    };
  }
  if (traceWrites) {
    const run = CatalogWriteAdmission.prototype.run;
    CatalogWriteAdmission.prototype.run = async function (operation, signal) {
      if (
        this.catalogPath !== catalog ||
        this.ownsWriteAdmission ||
        !activityContext().actor.startsWith("web-session:")
      )
        return run.call(this, operation, signal);
      const queued = performance.now();
      let wait_ms;
      try {
        return await run.call(
          this,
          () => {
            wait_ms = performance.now() - queued;
            return operation();
          },
          signal,
        );
      } finally {
        if (process.connected)
          process.send({
            http_write: {
              admitted: wait_ms !== undefined,
              wait_ms: wait_ms ?? performance.now() - queued,
            },
          });
      }
    };
  }
  const server = await startProductionWorkbench({
    home: fixture.home,
    port: 0,
    access: { host: "127.0.0.1", password },
    applicationOptions: ["count-backfill", "index-disabled"].includes(
      destination,
    )
      ? { ...options, indexRefreshIntervalMs: null }
      : options,
  });
  try {
    process.send({ origin: server.origin });
    if (!stop.signal.aborted) await once(stop.signal, "abort");
  } finally {
    await server.close();
    if (process.connected) process.disconnect();
  }
}

async function write() {
  watchParent();
  if (destination === "saturate-count-backfill") traceBackfill();
  const app = await createApplication(fixture.home, {
    ...options,
    indexRefreshIntervalMs: null,
  });
  const reader = new DatabaseSync(catalog, { readOnly: true });
  reader.exec("PRAGMA busy_timeout=1000");
  const revision = reader.prepare(
    "SELECT revision FROM retrieval_source_revision WHERE singleton=1",
  );
  const start = performance.now();
  const run = randomUUID();
  const period = destination?.startsWith("saturate") ? 0 : batchPeriod;
  let papers = 0;
  let total = 0;
  try {
    await withActivity({ actor: "cli:synthetic-scale" }, async () => {
      for (let batch = 0; !stop.signal.aborted; batch++) {
        const stamp = new Date().toISOString();
        const records = Array.from({ length: batchSize }, () =>
          preparedObservation(++total, stamp, run),
        );
        let offset = 0;
        while (!stop.signal.aborted && offset < records.length) {
          const queued = performance.now();
          let admitted;
          try {
            await app.database.writeMetadataSegment(async (expired) => {
              admitted = performance.now();
              do {
                const result = await app.identity.observe(records[offset++]);
                assert.equal(result.disposition, "accepted");
                assert.equal(result.outcome, "created");
              } while (offset < records.length && !expired());
            });
          } catch (error) {
            if (process.connected)
              process.send({
                write_error: {
                  code: error.code ?? error.name,
                  waited_ms: (admitted ?? performance.now()) - queued,
                },
              });
            throw error;
          }
          const committed = Date.now();
          papers = total - (records.length - offset);
          if (process.connected)
            process.send({
              papers,
              committed,
              revision: revision.get().revision,
              wait_ms: admitted - queued,
              held_ms: performance.now() - admitted,
            });
        }
        await wait(
          Math.max(0, start + (batch + 1) * period - performance.now()),
        );
      }
    });
  } finally {
    reader.close();
    await app.close();
    if (process.connected) process.disconnect();
  }
}

function spawn(role, warnings, flag) {
  const child = fork(
    import.meta.filename,
    [role, root, ...(flag ? [flag] : [])],
    {
      execArgv: [],
      env: {
        PATH: "/usr/bin:/bin",
        COREPACK_ENABLE_NETWORK: "0",
        npm_config_offline: "true",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr.setEncoding("utf8");
  let line = "";
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    line += chunk;
    for (;;) {
      const newline = line.indexOf("\n");
      if (newline < 0) break;
      const event = line.slice(0, newline);
      line = line.slice(newline + 1);
      if (event.includes("sqlite-short-read-slow")) warnings.push(event);
    }
  });
  const exit = once(child, "exit");
  const first = async (accept = () => true) => {
    const ended = new AbortController();
    void exit.then(() => ended.abort());
    for await (const [message] of on(child, "message", {
      signal: AbortSignal.any([
        stop.signal,
        ended.signal,
        AbortSignal.timeout(45_000),
      ]),
    }))
      if (accept(message)) return message;
  };
  return {
    child,
    first,
    async close() {
      if (child.connected) child.send("stop");
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      try {
        const [code, signal] = await exit;
        assert.equal(code, 0, `${role} exit: ${code ?? signal}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function client(origin) {
  const endpoint = new URL(origin);
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.notEqual(endpoint.port, "4174");
  const common = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-Workbench-Init": "1",
  };
  const local = (path, init) => {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin);
    return fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(45_000)]),
    });
  };
  const cookies = (r) =>
    r.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  const login = await local("/auth/login", {
    method: "POST",
    headers: common,
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  await login.arrayBuffer();
  const landing = await local("/", { headers: { Cookie: cookies(login) } });
  assert.equal(landing.status, 200);
  const Cookie = [cookies(login), cookies(landing)].join("; ");
  await landing.arrayBuffer();
  const attach = await local("/api/clients", {
    method: "POST",
    headers: { ...common, Cookie },
    body: "{}",
  });
  assert.equal(attach.status, 201);
  const grant = await attach.json();
  return async (path, input, range) => {
    const url = new URL(path, origin);
    if (!range) url.searchParams.set("client_id", grant.client_id);
    const response = await local(url, {
      method: input ? "POST" : "GET",
      headers: {
        ...common,
        Cookie,
        "X-Workbench-Csrf": grant.csrf,
        "X-Sciretriever-Protocol-Version": "1",
        ...(range
          ? { Range: range, "X-Sciretriever-Client-Id": grant.client_id }
          : {}),
      },
      ...(input
        ? { body: JSON.stringify({ protocol_version: 1, request: input }) }
        : {}),
    });
    if (response.status !== (range ? 206 : 200)) {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code ?? body?.code;
      throw Object.assign(
        new Error(`${url.pathname}: HTTP ${response.status}`),
        {
          status: response.status,
          code:
            typeof code === "string" && /^[a-z][a-z0-9-]+$/u.test(code)
              ? code
              : null,
        },
      );
    }
    return range
      ? (await response.arrayBuffer()).byteLength
      : await response.json();
  };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    n: sorted.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: sorted.at(-1) ?? null,
  };
}

async function measure(work) {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

const absentAuthor = "acceptance nonexistent synthetic author 27ce8bb5";
const authorFilter = { author: absentAuthor };
// The concurrent writer's text contains "of", but lacks "in", "studies",
// and the fixed probe terms. Every cap therefore sees the same source corpus.
const nearAllText = "in";

function searchBands() {
  const admission = new CatalogWriteAdmission(catalog, { waitMs: 10_000 });
  return admission.run(() => {
    const db = new DatabaseSync(catalog);
    try {
      const count = (text) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM literature_search_fts WHERE literature_search_fts MATCH ?",
          )
          .get(text).n;
      const bands = [
        { name: "near-all", text: nearAllText, hits: count(nearAllText) },
      ];
      bands.push({
        name: "common",
        text: "spectroscopy",
        hits: count("spectroscopy"),
      });
      bands.push(
        {
          name: "three-frequent",
          text: "studies of in",
          hits: count('"studies" AND "of" AND "in"'),
        },
        {
          ...bands[0],
          name: "sparse-author",
          query: authorFilter,
          matching: 0,
        },
      );
      const folderQuery = {
        folder: { id: folder, include_descendants: false },
      };
      const memberCount = db
        .prepare(
          `SELECT count(*) AS n
        FROM library_ordered_members m
        CROSS JOIN literature_search_fts_content c ON c.c0=m.literature_id
        CROSS JOIN literature_search_fts ON literature_search_fts.rowid=c.id
        WHERE m.kind='folder' AND m.scope_id=? AND literature_search_fts MATCH ?`,
        )
        .get(folder, nearAllText).n;
      bands.push(
        {
          ...bands[0],
          name: "folder-frequent",
          query: folderQuery,
          matching: memberCount,
        },
        {
          ...bands[0],
          name: "folder-sparse-author",
          query: { ...folderQuery, ...authorFilter },
          matching: 0,
        },
      );
      const fixed = [
        [1000, "acceptancefixedone"],
        [10_000, "acceptancefixedten"],
        [100_000, "acceptancefixedhundred"],
      ].filter(([hits]) => hits <= corpus.versions);
      // Apply distinct probe terms to exactly the same number of indexed versions.
      // Using a metadata filter on a ubiquitous word would vary the postings scanned.
      db.exec("BEGIN IMMEDIATE");
      for (const [hits, text] of fixed) {
        if (count(text) === 0) {
          const { id } = db
            .prepare(
              "SELECT id FROM literature_search_fts_content ORDER BY id LIMIT 1 OFFSET ?",
            )
            .get(hits - 1);
          assert.equal(
            db
              .prepare(
                "UPDATE literature_search_fts SET keywords=coalesce(keywords,'') || ? WHERE rowid<=?",
              )
              .run(" " + text, id).changes,
            hits,
          );
        }
        assert.equal(count(text), hits);
        bands.push({ name: `fixed-${hits}`, text, hits });
      }
      db.exec("COMMIT");
      return bands;
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });
}

async function searchWindows() {
  const selected = reference?.split(",");
  const bands = (await searchBands()).filter(
    ({ name }) => !selected || selected.includes(name),
  );
  assert.ok(bands.length);
  const result = {
    scale,
    mode,
    environment: {
      node: process.version,
      kernel: release(),
      load_start: loadavg(),
    },
    points: [],
    warnings: [],
    failures: [],
    search: {},
  };
  const server = spawn("serve", result.warnings);
  let writer;
  try {
    const { origin } = await server.first();
    const request = await client(origin);
    writer = spawn("writer", result.warnings);
    writer.child.on("message", (point) => result.points.push(point));
    await writer.first();
    await wait(2500);
    const began = Date.now();
    for (const { name, text, hits, query = {}, matching = hits } of bands) {
      const entry = (result.search[name] = {
        text,
        hits,
        matching,
        samples: [],
      });
      for (let trial = 0; trial < trials; trial++) {
        stop.signal.throwIfAborted();
        let page;
        const duration = await measure(async () => {
          ({ page } = await request("/api/v1/query/search", {
            query: { text, collection_scope: "all", ...query },
            sort: "relevance",
            limit: 50,
          }));
        });
        assert.equal(page.items.length, Math.min(50, matching));
        assert.equal(page.total_count, Math.min(10_000, matching));
        assert.equal(
          page.count_truncated,
          matching > 10_000 ? true : undefined,
        );
        if (scale === "1m" && ["near-all", "sparse-author"].includes(name))
          assert.ok(page.scan_incomplete && page.scan_limit < hits);
        if (query.folder) assert.equal(page.scan_incomplete, undefined);
        assert.equal(!!page.next_window_cursor, !!page.scan_incomplete);
        entry.scan_limit = page.scan_limit ?? null;
        entry.samples.push(duration);
        if (duration > 10 * objectives.search) break;
        await wait(40);
      }
      Object.assign(entry, stats(entry.samples));
      console.log(
        scale,
        name,
        JSON.stringify(stats(entry.samples)),
        entry.scan_limit,
      );
      if (entry.n !== trials || entry.p95_ms > objectives.search)
        result.failures.push(
          `${name} P95 ${entry.p95_ms.toFixed(1)} ms (${entry.n} trials)`,
        );
    }
    const finished = Date.now();
    const points = result.points.filter(
      (point) => point.committed >= began && point.committed <= finished,
    );
    const first = points[0];
    const last = points.at(-1);
    result.papers_per_second =
      last?.committed > first?.committed
        ? (1000 * (last.papers - first.papers)) /
          (last.committed - first.committed)
        : 0;
    if (result.papers_per_second < 100)
      result.failures.push("Write load below 100 committed papers/s");
  } finally {
    try {
      await writer?.close();
    } finally {
      try {
        await server.close();
      } finally {
        result.environment.load_finish = loadavg();
        await writeFile(destination, JSON.stringify(result, null, 2) + "\n");
      }
    }
  }
  assert.deepEqual(result.failures, []);
}

async function searchWindowSweep() {
  const caps = (reference ?? "20000,50000,100000,150000,200000,250000")
    .split(",")
    .map(Number);
  assert.ok(caps.every((cap) => Number.isSafeInteger(cap) && cap > 0));
  const result = {
    mode,
    scale,
    caps,
    search: {},
    frequencies: {},
    points: [],
    warnings: [],
  };
  const writer = spawn("writer", result.warnings);
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    new StoredLibraryState(db, { max_tags: 6, archive_profile: "vlm-engine" });
    db.function("sr_query_continue", () => {
      stop.signal.throwIfAborted();
      return 1;
    });
    db.function("sr_normalize", { deterministic: true }, (x) =>
      x === null ? null : normalizeQueryText(x),
    );
    writer.child.on("message", (point) => result.points.push(point));
    await writer.first();
    await wait(2_500);
    const probes =
      mode === "side-window-sweep"
        ? [
            ["sparse-author", nearAllText, authorFilter],
            ["three-sparse-author", "studies of in", authorFilter],
          ]
        : [
            ["sparse-author", nearAllText, authorFilter],
            ["near-all", nearAllText, {}],
            ["three-frequent", "studies of in", {}],
          ];
    const plans = [];
    for (const [name, text, extra] of probes) {
      const query = parseLibrarySearchRequest({
        query: { text, ...extra },
      }).query;
      const ftsQuery = queryTerms(text)
        .map((term) => '"' + term + '"')
        .join(" AND ");
      const plan = {
        query,
        ftsQuery,
        after: null,
        sort: "relevance",
        limit: 50,
      };
      const search = (result.search[name] = {});
      for (const cap of caps) {
        plans.push({
          name,
          cap,
          search,
          plan,
          empty: !!extra.author,
          cache: new LibraryRelevanceCache(cap),
          samples: [],
          scan_limit: null,
        });
      }
    }
    async function sample(probe) {
      if (probe.samples.at(-1) > 10 * objectives.search) return;
      stop.signal.throwIfAborted();
      await wait(35);
      db.exec("BEGIN");
      try {
        probe.samples.push(
          await measure(() => {
            const page = libraryPageIds(db, probe.plan, probe.cache);
            probe.scan_limit = page.search_window?.limit ?? null;
            if (probe.empty) assert.equal(page.total_count, 0);
          }),
        );
      } finally {
        db.exec("COMMIT");
      }
    }
    // Rotate the two expensive author probes and their caps so a busy or
    // quiet stretch cannot affect only one candidate in the sizing run.
    if (mode === "side-window-sweep") {
      for (let trial = 0; trial < trials; trial++) {
        for (let index = 0; index < plans.length; index++)
          await sample(plans[(trial * 3 + index) % plans.length]);
        console.log(scale, "completed sizing trial", trial + 1);
      }
    } else {
      for (const probe of plans)
        for (let trial = 0; trial < trials; trial++) await sample(probe);
    }
    for (const { name, cap, search, samples, scan_limit } of plans) {
      search[cap] = { ...stats(samples), scan_limit, samples };
      console.log(scale, name, cap, JSON.stringify(stats(samples)));
    }
    for (const text of [nearAllText, "of", "spectroscopy", "studies of in"]) {
      const fts = queryTerms(text)
        .map((term) => '"' + term + '"')
        .join(" AND ");
      const match =
        "FROM literature_search_fts WHERE literature_search_fts MATCH ? ORDER BY rowid DESC LIMIT 1";
      const seek = db.prepare("SELECT rowid " + match);
      const score = db.prepare("SELECT bm25(literature_search_fts) " + match);
      const samples = [];
      for (let trial = 0; trial < trials; trial++) {
        const probe = await measure(() => seek.get(fts));
        samples.push((await measure(() => score.get(fts))) - probe);
      }
      result.frequencies[text] = { ...stats(samples), samples };
    }
  } finally {
    db.close();
    await writer.close();
    await writeFile(destination, JSON.stringify(result, null, 2) + "\n");
  }
}

const fulltextQueries = {
  in: { text: nearAllText },
  spectroscopy: { text: "spectroscopy" },
  three: { text: "studies of in" },
  author: { text: nearAllText, ...authorFilter },
};

function fulltextMatch(text) {
  return queryTerms(text)
    .map((term) => `"${term}"`)
    .join(" AND ");
}

function fulltextWorksets(db) {
  const { all, half, members } = prepared.fulltext_folders;
  const read = db.prepare(
    `SELECT m.literature_id, EXISTS (
       SELECT 1 FROM literature_assets a
       WHERE a.literature_id=m.literature_id AND a.role='primary-pdf'
     ) AS has_body
     FROM library_ordered_members m WHERE m.kind='folder' AND m.scope_id=?
     ORDER BY m.literature_id`,
  );
  const full = read.all(all);
  const mixed = read.all(half);
  assert.equal(full.length, members);
  assert.equal(mixed.length, members);
  assert.ok(full.every(({ has_body }) => has_body === 1));
  assert.equal(
    mixed.filter(({ has_body }) => has_body === 1).length,
    members / 2,
  );
  return { all: full, half: mixed };
}

// Attribute the same member ranker's work without instrumenting the HTTP
// service. The IDs have already passed the workset filter.
function profileFulltextMembers(db, members) {
  const result = {};
  for (const [group, has_body] of [
    ["body", 1],
    ["metadata", 0],
  ]) {
    const ids = members.filter((row) => row.has_body === has_body);
    const scope = JSON.stringify(ids.map(({ literature_id }) => literature_id));
    result[group] = {};
    for (const [name, { text, author }] of Object.entries(fulltextQueries)) {
      if (author) continue; // No version reaches the FTS cursor.
      const match = fulltextMatch(text);
      const matches = {
        sql: `SELECT document.c0 AS literature_id,document.id AS doc,NULL AS workset_at
          FROM json_each(?) member
          CROSS JOIN literature_search_fts_content document ON document.c0=member.value
          CROSS JOIN literature_search_fts ON literature_search_fts.rowid=document.id
          WHERE literature_search_fts MATCH ? AND sr_query_continue()`,
        args: [scope, match],
      };
      const { sql, args } = matches;
      const locate = db.prepare(sql);
      locate.setReadBigInts(true);
      const samples = [];
      for (let trial = 0; trial < 5; trial++) {
        let lookupMs, rankedMs, candidates, matched;
        let idfMs = 0;
        let projectionMs = 0;
        const timedDb = {
          prepare(statement) {
            const query = db.prepare(statement);
            if (statement.includes(" AS idf"))
              return {
                get(...args) {
                  const began = performance.now();
                  const row = query.get(...args);
                  idfMs += performance.now() - began;
                  return row;
                },
              };
            if (
              statement.includes("FROM json_each(?) member") ||
              statement.includes("SELECT CASE WHEN document.c") ||
              statement.includes("SELECT document.c1,")
            )
              return {
                setReadBigInts(value) {
                  query.setReadBigInts(value);
                },
                *iterate(...args) {
                  const rows = query.iterate(...args);
                  try {
                    for (;;) {
                      const began = performance.now();
                      const next = rows.next();
                      projectionMs += performance.now() - began;
                      if (next.done) break;
                      yield next.value;
                    }
                  } finally {
                    rows.return();
                  }
                },
                get(...args) {
                  const began = performance.now();
                  const row = query.get(...args);
                  projectionMs += performance.now() - began;
                  return row;
                },
              };
            return query;
          },
        };
        const lookup = () => {
          const began = performance.now();
          candidates = 0;
          for (const row of locate.iterate(...args))
            if (row.doc !== undefined) candidates++;
          lookupMs = performance.now() - began;
        };
        const rank = () => {
          const began = performance.now();
          matched = rankLibraryMembers(
            timedDb,
            matches,
            match,
            Number.MAX_SAFE_INTEGER,
          ).total;
          rankedMs = performance.now() - began;
        };
        if (trial % 2 === 0) {
          lookup();
          rank();
        } else {
          rank();
          lookup();
        }
        assert.ok(matched <= candidates && candidates <= ids.length);
        if (name !== "spectroscopy") assert.equal(matched, ids.length);
        samples.push({
          candidates,
          matched,
          lookup_ms: lookupMs,
          ranked_ms: rankedMs,
          projection_ms: projectionMs,
          idf_ms: idfMs,
          lookup_us: (1000 * lookupMs) / ids.length,
          score_us: (1000 * (rankedMs - idfMs - lookupMs)) / ids.length,
          rank_work_us: (1000 * (rankedMs - idfMs - projectionMs)) / ids.length,
        });
      }
      result[group][name] = {
        versions: ids.length,
        lookup_p50_us: stats(samples.map((row) => row.lookup_us)).p50_ms,
        score_p50_us: stats(samples.map((row) => row.score_us)).p50_ms,
        rank_work_p50_us: stats(samples.map((row) => row.rank_work_us)).p50_ms,
        idf_p50_ms: stats(samples.map((row) => row.idf_ms)).p50_ms,
        samples,
      };
    }
  }
  return result;
}

function profileFulltextSnippets(db, ids, column, repeats) {
  const rowid = db.prepare(
    "SELECT id FROM literature_search_fts_content WHERE c0=?",
  );
  // A JS number binds as REAL, which FTS5 does not use as a seek bound.
  rowid.setReadBigInts(true);
  const fetch = db.prepare(
    `SELECT snippet(literature_search_fts,?,'','',' … ',24) AS fragment
     FROM literature_search_fts WHERE rowid=? AND literature_search_fts MATCH ?`,
  );
  const rows = ids.map((id) => rowid.get(id).id);
  const match = fulltextMatch(nearAllText);
  const samples = [];
  let outputBytes = 0;
  for (let trial = 0; trial < repeats; trial++) {
    stop.signal.throwIfAborted();
    const began = performance.now();
    outputBytes = 0;
    for (const row of rows) {
      const { fragment } = fetch.get(column, row, match);
      assert.ok(fragment);
      outputBytes += Buffer.byteLength(fragment);
    }
    samples.push(performance.now() - began);
  }
  return {
    ...stats(samples),
    fragments: rows.length,
    output_bytes: outputBytes,
    samples,
  };
}

async function fulltextSearch() {
  const output = resolve(destination);
  assert.ok(output.startsWith(resolve("sandbox/reports") + "/"));
  assert.equal(prepared.fulltext.result.papers, corpus.papers / 10);
  const repeats = scale === "1m" ? trials : 3;
  const result = {
    scale,
    mode,
    corpus,
    fulltext: prepared.fulltext_folders,
    environment: {
      node: process.version,
      kernel: release(),
      load_start: loadavg(),
    },
    points: [],
    warnings: [],
    reads: {},
  };
  const save = () => writeFile(output, JSON.stringify(result, null, 2) + "\n");
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    db.function("sr_query_continue", () => {
      stop.signal.throwIfAborted();
      return 1;
    });
    result.environment.sqlite = db
      .prepare("SELECT sqlite_version() AS version")
      .get().version;
    const worksets = fulltextWorksets(db);
    const server = spawn("serve", result.warnings);
    const pages = {};
    let writer;
    try {
      const { origin } = await server.first();
      const request = await client(origin);
      writer = spawn("writer", result.warnings);
      writer.child.on("message", (point) => result.points.push(point));
      await writer.first();
      await wait(2500);
      const began = Date.now();
      const search = async (query, sort) =>
        (await request("/api/v1/query/search", { query, limit: 50, sort }))
          .page;
      const sample = async (name, work, validate, target) => {
        const entry = (result.reads[name] = { samples: [], target_ms: target });
        for (let trial = 0; trial < repeats; trial++) {
          stop.signal.throwIfAborted();
          let page;
          entry.samples.push(
            await measure(async () => {
              page = await work();
            }),
          );
          validate(page);
          if (trial === 0)
            pages[name] = page.items.map(
              ({ literature }) => literature.literature_id,
            );
          entry.total_count = page.total_count;
          entry.count_truncated = !!page.count_truncated;
          entry.scan_limit = page.scan_limit ?? null;
          if ((trial + 1) % 5 === 0 && trial + 1 < repeats) {
            console.log(scale, name, trial + 1, "of", repeats);
            await save();
          }
          await wait(40);
        }
        const distribution = stats(entry.samples);
        Object.assign(entry, distribution, {
          meets_target: distribution.p95_ms <= target,
        });
        console.log(scale, name, JSON.stringify(distribution));
        await save();
      };
      await sample(
        "home",
        async () => {
          const [page, { result: counts }] = await Promise.all([
            search({}),
            request("/api/v1/query/library-counts", {
              query: { collection_scope: "collected" },
            }),
          ]);
          assert.ok(counts.total > 0 && !counts.counts_backfill_pending);
          return page;
        },
        (page) => {
          assert.equal(page.items.length, 50);
          assert.ok(page.items.every(({ collected }) => collected));
        },
        objectives.home,
      );
      for (const [name, criteria] of Object.entries(fulltextQueries)) {
        if (name === "spectroscopy") continue;
        await sample(
          `window-${name}`,
          () => search({ collection_scope: "all", ...criteria }, "relevance"),
          (page) => {
            assert.equal(page.items.length, criteria.author ? 0 : 50);
            if (criteria.author) assert.equal(page.total_count, 0);
            assert.equal(!!page.scan_incomplete, scale === "1m");
          },
          objectives.search,
        );
      }
      for (const [group, rows] of Object.entries(worksets)) {
        const folder = {
          id: prepared.fulltext_folders[group],
          include_descendants: false,
        };
        const set = new Set(rows.map(({ literature_id }) => literature_id));
        for (const [name, criteria] of Object.entries(fulltextQueries)) {
          await sample(
            `members-${group}-${name}`,
            () =>
              search(
                { collection_scope: "all", folder, ...criteria },
                "relevance",
              ),
            (page) => {
              assert.equal(page.items.length, criteria.author ? 0 : 50);
              assert.equal(page.scan_incomplete, undefined);
              assert.equal(page.count_truncated, undefined);
              if (name !== "spectroscopy")
                assert.equal(
                  page.total_count,
                  criteria.author ? 0 : rows.length,
                );
              assert.ok(
                page.items.every(({ literature }) =>
                  set.has(literature.literature_id),
                ),
              );
            },
            objectives.search,
          );
        }
      }
      const finished = Date.now();
      const points = result.points.filter(
        ({ committed }) => committed >= began && committed <= finished,
      );
      const first = points[0],
        last = points.at(-1);
      assert.ok(first && last.committed > first.committed);
      result.papers_per_second =
        (1000 * (last.papers - first.papers)) /
        (last.committed - first.committed);
    } finally {
      try {
        await writer?.close();
      } finally {
        await server.close();
        await save();
      }
    }
    // The fragment probe isolates FTS5 extraction from the ranked search.
    // The actual library page returns bibliographies, not these excerpts.
    const hasBody = db.prepare(
      "SELECT 1 FROM literature_assets WHERE literature_id=? AND role='primary-pdf'",
    );
    result.first_page_bodies = Object.fromEntries(
      Object.entries(pages).map(([name, ids]) => [
        name,
        ids.filter((id) => hasBody.get(id)).length,
      ]),
    );
    const metadataPage = worksets.half
      .filter(({ has_body }) => !has_body)
      .slice(0, 50)
      .map(({ literature_id }) => literature_id);
    result.snippets = {
      window: profileFulltextSnippets(db, pages["window-in"], -1, repeats),
      body: profileFulltextSnippets(db, pages["members-all-in"], 12, repeats),
      metadata: profileFulltextSnippets(db, metadataPage, -1, repeats),
    };
    if (scale === "1m") {
      const raw = db.prepare(
        `SELECT count(*) AS versions,sum(EXISTS(
           SELECT 1 FROM literature_assets a
           WHERE a.literature_id=hits.literature_id AND a.role='primary-pdf'
         )) AS bodies
         FROM (
           SELECT literature_id FROM literature_search_fts
           WHERE literature_search_fts MATCH ?
           ORDER BY rowid DESC LIMIT ?
         ) hits`,
      );
      result.windows = Object.fromEntries(
        ["in", "three", "author"].map((name) => [
          name,
          raw.get(
            fulltextMatch(fulltextQueries[name].text),
            result.reads[`window-${name}`].scan_limit,
          ),
        ]),
      );
    }
    result.members = profileFulltextMembers(db, worksets.half);
    result.completed = true;
  } finally {
    db.close();
    result.environment.load_finish = loadavg();
    await save();
  }
}

async function setBudgetBenchmarkCollection(ids) {
  const db = new DatabaseSync(catalog);
  try {
    db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
      CREATE TEMP TABLE selected(literature_id TEXT PRIMARY KEY) WITHOUT ROWID;`);
    db.prepare("INSERT INTO selected SELECT value FROM json_each(?)").run(
      JSON.stringify(ids),
    );
    db.exec(`DELETE FROM library_collected WHERE literature_id NOT IN (SELECT literature_id FROM selected);
      DELETE FROM library_collection_times WHERE literature_id NOT IN (SELECT literature_id FROM selected);
      INSERT INTO library_collected(literature_id,intake_at)
      SELECT s.literature_id, i.intake_at FROM selected s LEFT JOIN literature_intake i USING(literature_id)
      WHERE true ON CONFLICT DO NOTHING;
      COMMIT;`);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM library_collected").get().n,
      ids.length,
    );
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
  const worker = new SqliteWorker(catalog);
  try {
    while (await worker.libraryStatePending()) {
      stop.signal.throwIfAborted();
      await worker.refreshLibraryState();
    }
  } finally {
    await worker.close();
  }
}

function budgetBenchmarkGroups() {
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    const { all, half } = fulltextWorksets(db);
    const noBody = db
      .prepare(
        `WITH original AS MATERIALIZED (
      SELECT representative_literature_id FROM meta_literatures ORDER BY rowid LIMIT ?
    ), ordered AS (
      SELECT m.representative_literature_id AS literature_id,
        row_number() OVER (ORDER BY m.representative_literature_id) AS ordinal
      FROM original m
      WHERE NOT EXISTS(
        SELECT 1 FROM literature_assets a WHERE a.literature_id=m.representative_literature_id
          AND a.role='primary-pdf'
      )
    )
    SELECT literature_id,0 AS has_body FROM ordered WHERE (ordinal-1) % ?=0
    ORDER BY ordinal LIMIT ?`,
      )
      .all(
        corpus.papers,
        (corpus.papers - corpus.obtained) / all.length,
        all.length,
      );
    assert.equal(noBody.length, all.length);
    const ordinary = db
      .prepare(
        `SELECT m.literature_id,EXISTS(
      SELECT 1 FROM literature_assets a WHERE a.literature_id=m.literature_id AND a.role='primary-pdf'
    ) AS has_body FROM library_ordered_members m WHERE m.kind='folder' AND scope_id=?`,
      )
      .all(folder);
    assert.equal(ordinary.length, 10_000);
    return { all, half, none: noBody, folder: ordinary };
  } finally {
    db.close();
  }
}

async function worksetBudgetSearch() {
  assert.ok(resolve(destination).startsWith(resolve("sandbox/reports") + "/"));
  const data = {
    scale,
    budget: LIBRARY_MEMBER_SCORE_BUDGET,
    environment: { node: process.version, kernel: release(), load: loadavg() },
    groups: {},
    warnings: [],
  };
  const save = () =>
    writeFile(destination, JSON.stringify(data, null, 2) + "\n");
  for (const [group, cohort] of Object.entries(budgetBenchmarkGroups())) {
    if (group !== "folder")
      await setBudgetBenchmarkCollection(
        cohort.map(({ literature_id }) => literature_id),
      );
    const scope =
      group === "folder"
        ? {
            collection_scope: "all",
            folder: { id: folder, include_descendants: false },
          }
        : { collection_scope: "collected" };
    const ids = new Set(cohort.map(({ literature_id }) => literature_id));
    const entry = (data.groups[group] = {
      versions: ids.size,
      with_body: cohort.filter(({ has_body }) => has_body).length,
      queries: {},
      points: [],
    });
    const server = spawn("serve", data.warnings);
    let writer;
    try {
      const { origin } = await server.first();
      const request = await client(origin);
      writer = spawn("writer", data.warnings);
      writer.child.on("message", (point) => entry.points.push(point));
      await writer.first();
      await wait(2500);
      const started = Date.now();
      for (const [name, criteria] of Object.entries(fulltextQueries)) {
        const samples = [];
        for (let trial = 0; trial < (scale === "1m" ? trials : 3); trial++) {
          let page;
          const ms = await measure(async () => {
            ({ page } = await request("/api/v1/query/search", {
              query: { ...scope, ...criteria },
              sort: "relevance",
              limit: 50,
            }));
          });
          const scored = page.relevance_scored_count ?? page.total_count;
          assert.equal(page.items.length, criteria.author ? 0 : 50);
          assert.equal(page.count_truncated, undefined);
          assert.equal(page.scan_incomplete, undefined);
          assert.ok(scored >= 0 && scored <= page.total_count);
          assert.ok(
            page.items.every(({ literature }) =>
              ids.has(literature.literature_id),
            ),
          );
          if (name !== "spectroscopy")
            assert.equal(page.total_count, criteria.author ? 0 : ids.size);
          samples.push({ ms, scored, total: page.total_count });
          await wait(40);
        }
        const distribution = stats(samples.map(({ ms }) => ms));
        assert.equal(new Set(samples.map(({ scored }) => scored)).size, 1);
        entry.queries[name] = {
          ...distribution,
          scored: samples[0].scored,
          samples,
        };
        console.log(group, name, distribution, "scored", samples[0].scored);
        await save();
      }
      const points = entry.points.filter(
        ({ committed }) => committed >= started,
      );
      const first = points[0],
        last = points.at(-1);
      assert.ok(first && last.committed > first.committed);
      entry.papers_per_second =
        (1000 * (last.papers - first.papers)) /
        (last.committed - first.committed);
    } finally {
      try {
        await writer?.close();
      } finally {
        await server.close();
        await save();
      }
    }
  }
  data.completed = true;
  await save();
}

function sideWindowCohorts() {
  const { all, none } = budgetBenchmarkGroups();
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    const extraBody = db
      .prepare(
        `SELECT literature_id FROM literature_assets WHERE role='primary-pdf'
       AND literature_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`,
      )
      .get(JSON.stringify(all.map(({ literature_id }) => literature_id)));
    assert.ok(extraBody);
    const large = db
      .prepare(
        `SELECT literature_id FROM literatures
       WHERE (rowid-1) % 10=0 ORDER BY rowid LIMIT 100000`,
      )
      .all();
    assert.equal(large.length, 100_000);
    return { all, none, over: [...all, extraBody], large };
  } finally {
    db.close();
  }
}

function seedSideWindowBatch(ids) {
  const db = new DatabaseSync(catalog);
  const batch = randomUUID();
  const at = new Date().toISOString();
  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,finished_at,state,result,initiated_by,request_json)
       VALUES(?,'import','Synthetic search acceptance','cli',?,?,'finished','completed','local:cli','{}')`,
    ).run(batch, at, at);
    db.prepare(
      `INSERT INTO intake_batch_members(batch_id,literature_id,disposition)
       SELECT ?,value,'matched' FROM json_each(?)`,
    ).run(batch, JSON.stringify(ids));
    db.exec("COMMIT");
    return batch;
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

async function searchSideWindows() {
  assert.equal(scale, "1m");
  assert.ok(resolve(destination).startsWith(resolve("sandbox/reports") + "/"));
  const { all, none, over, large } = sideWindowCohorts();
  const groups = [
    { name: "library" },
    { name: "collected-full", cohort: all },
    { name: "collected-no-body", cohort: none },
    { name: "collected-10001", cohort: over },
    { name: "batch-10001", cohort: over, batch: true },
    { name: "collected-100000", cohort: large },
    { name: "batch-100000", cohort: large, batch: true },
  ].filter(({ name }) => !reference || reference.split(",").includes(name));
  assert.ok(groups.length);
  const data = {
    scale,
    environment: { node: process.version, kernel: release(), load: loadavg() },
    groups: {},
    failures: [],
    warnings: [],
  };
  const save = () =>
    writeFile(destination, JSON.stringify(data, null, 2) + "\n");
  const queries = {
    ...fulltextQueries,
    threeAuthor: { text: "studies of in", ...authorFilter },
  };
  for (const { name, cohort, batch } of groups) {
    const ids = cohort?.map(({ literature_id }) => literature_id);
    const members = ids && new Set(ids);
    let scope = { collection_scope: "all" };
    if (batch)
      scope = { ...scope, intake_batch_ids: [seedSideWindowBatch(ids)] };
    else if (cohort) {
      await setBudgetBenchmarkCollection(ids);
      scope = { collection_scope: "collected" };
    }
    const entry = (data.groups[name] = {
      members: ids?.length ?? null,
      queries: {},
      points: [],
    });
    const server = spawn("serve", data.warnings);
    let writer;
    try {
      const { origin } = await server.first();
      const request = await client(origin);
      writer = spawn("writer", data.warnings);
      writer.child.on("message", (point) => entry.points.push(point));
      await writer.first();
      await wait(2500);
      const began = Date.now();
      const probes = Object.entries(queries).filter(
        ([key]) =>
          !cohort ||
          (ids.length <= 10_000
            ? key !== "threeAuthor"
            : ["in", "three", "author"].includes(key)),
      );
      async function takePage(query, cursor) {
        const samples = [];
        let page;
        for (let trial = 0; trial < trials; trial++) {
          stop.signal.throwIfAborted();
          const ms = await measure(async () => {
            ({ page } = await request("/api/v1/query/search", {
              query,
              sort: "relevance",
              limit: 50,
              ...(cursor ? { window_cursor: cursor } : {}),
            }));
          });
          assert.ok(
            page.items.every(
              ({ literature }) =>
                !members || members.has(literature.literature_id),
            ),
          );
          if (query.author) assert.equal(page.total_count, 0);
          if (ids?.length <= 10_000)
            assert.equal(page.scan_incomplete, undefined);
          assert.equal(!!page.next_window_cursor, !!page.scan_incomplete);
          assert.equal(
            page.scan_side === "members" || page.scan_side === "hits",
            !!page.scan_incomplete,
          );
          samples.push(ms);
          if (ms > 10 * objectives.search) break;
          await wait(40);
        }
        return {
          page,
          sample: {
            ...stats(samples),
            scan_side: page.scan_side ?? null,
            scan_limit: page.scan_limit ?? null,
            total_count: page.total_count,
            relevance_scored_count: page.relevance_scored_count ?? null,
            samples,
          },
        };
      }
      for (const [key, criteria] of probes) {
        const query = { ...scope, ...criteria };
        const { page, sample } = await takePage(query);
        entry.queries[key] = sample;
        console.log(
          name,
          key,
          JSON.stringify({ ...sample, samples: undefined }),
        );
        await save();
        if (sample.n !== trials || sample.p95_ms > objectives.search)
          data.failures.push(
            `${name} ${key} P95 ${sample.p95_ms.toFixed(1)} ms`,
          );
        if (key === "in" && page.next_window_cursor) {
          const next = await takePage(query, page.next_window_cursor);
          entry.queries.second = next.sample;
          assert.ok(
            next.page.scan_side === page.scan_side ||
              !next.page.scan_incomplete,
          );
          assert.ok(
            next.page.items.every(
              ({ literature }) =>
                !page.items.some(
                  ({ literature: first }) =>
                    first.literature_id === literature.literature_id,
                ),
            ),
          );
          console.log(
            name,
            "second",
            JSON.stringify({ ...next.sample, samples: undefined }),
          );
          if (next.sample.p95_ms > objectives.search)
            data.failures.push(
              `${name} second P95 ${next.sample.p95_ms.toFixed(1)} ms`,
            );
          await save();
        }
      }
      const points = entry.points.filter(({ committed }) => committed >= began);
      const first = points[0],
        last = points.at(-1);
      entry.papers_per_second =
        first && last.committed > first.committed
          ? (1000 * (last.papers - first.papers)) /
            (last.committed - first.committed)
          : 0;
      if (entry.papers_per_second < 100)
        data.failures.push(`${name} write load below 100 committed papers/s`);
    } finally {
      try {
        await writer?.close();
      } finally {
        await server.close();
        await save();
      }
    }
  }
  data.completed = true;
  await save();
  assert.deepEqual(data.failures, []);
}

async function worksetBudgetSweep() {
  assert.ok(resolve(destination).startsWith(resolve("sandbox/reports") + "/"));
  const sizing = mode === "side-member-sweep";
  const values = (
    reference ?? (sizing ? "8000,9000,10000" : "0,1000000,2000000,4000000")
  )
    .split(",")
    .map(Number);
  assert.ok(
    values.every((n) => Number.isSafeInteger(n) && n >= Number(sizing)),
  );
  const data = {
    scale,
    ...(sizing ? { mode, caps: values } : { budgets: values }),
    samples: {},
    points: [],
    warnings: [],
  };
  const scope = sizing
    ? {
        intake_batch_ids: [
          seedSideWindowBatch(
            sideWindowCohorts().over.map(({ literature_id }) => literature_id),
          ),
        ],
      }
    : {
        folder: {
          id: prepared.fulltext_folders.all,
          include_descendants: false,
        },
      };
  const db = new DatabaseSync(catalog, { readOnly: true });
  const writer = spawn("writer", data.warnings);
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    new StoredLibraryState(db, { max_tags: 6, archive_profile: "vlm-engine" });
    db.function("sr_query_continue", () => {
      stop.signal.throwIfAborted();
      return 1;
    });
    db.function("sr_normalize", { deterministic: true }, (x) =>
      x === null ? null : normalizeQueryText(x),
    );
    writer.child.on("message", (point) => data.points.push(point));
    await writer.first();
    await wait(2500);
    for (const [name, criteria] of Object.entries(fulltextQueries)) {
      if (sizing ? name === "spectroscopy" : criteria.author) continue;
      const query = parseLibrarySearchRequest({
        query: { ...criteria, ...scope },
      }).query;
      const plan = {
        query,
        ftsQuery: fulltextMatch(criteria.text),
        after: null,
        sort: "relevance",
        limit: 50,
      };
      const byValue = (data.samples[name] = {});
      for (const value of values) {
        const samples = [];
        // Force the member side to measure its actual cost at each cap.
        const cache = sizing
          ? new LibraryRelevanceCache(100_000, undefined, value)
          : new LibraryRelevanceCache(undefined, value);
        for (let i = 0; i < 7; i++) {
          await wait(40);
          db.exec("BEGIN");
          try {
            const start = performance.now();
            const page = libraryPageIds(db, plan, cache);
            if (sizing) assert.equal(page.search_window?.side, "members");
            samples.push({
              ms: performance.now() - start,
              scored: page.relevance_scored_count ?? page.total_count,
            });
          } finally {
            db.exec("COMMIT");
          }
        }
        byValue[value] = { ...stats(samples.map(({ ms }) => ms)), samples };
        console.log(name, value, byValue[value].p95_ms, samples[0].scored);
      }
    }
    data.completed = true;
  } finally {
    try {
      await writer.close();
    } finally {
      db.close();
      await writeFile(destination, JSON.stringify(data, null, 2) + "\n");
    }
  }
}

function taskBands() {
  assert.equal(scale, "1m");
  assert.equal(fixture.source_records, 1_000_000);
  const source = fixture.jobs.running;
  const db = new DatabaseSync(catalog);
  const tasks = [10_000, 100_000].map((records) => ({
    records,
    jobId: `${source}-${records}`,
  }));
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    for (const { records, jobId } of tasks) {
      // Use prefixes of the original fixture, including both events for each source record.
      db.prepare("DELETE FROM execution_jobs WHERE job_id=?").run(jobId);
      db.prepare(
        `
        INSERT INTO execution_jobs(job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at,finished_at)
        SELECT ?,target_kind,selector_json,policy_version,status,?,created_at,finished_at
        FROM execution_jobs WHERE job_id=?
      `,
      ).run(jobId, jobId, source);
      db.prepare(
        `
        INSERT INTO execution_targets(target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at)
        SELECT ?,?,ordinal,literature_id,version_role,stage,disposition,next_eligible_at
        FROM execution_targets WHERE job_id=? AND ordinal=0
      `,
      ).run(`${jobId}:0`, jobId, source);
      db.prepare(
        `
        INSERT INTO execution_budgets(job_id,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at)
        SELECT ?,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at
        FROM execution_budgets WHERE job_id=?
      `,
      ).run(jobId, source);
      const { changes } = db
        .prepare(
          `
        INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at)
        SELECT ? || ':' || sequence,?,sequence,kind,
          CASE WHEN kind='metadata-source' THEN json_set(payload_json,'$.target_id',?) ELSE payload_json END,created_at
        FROM execution_events WHERE job_id=? AND sequence<=? ORDER BY sequence
      `,
        )
        .run(jobId, jobId, `${jobId}:0`, source, 2 * records);
      assert.equal(changes, 2 * records + 1);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return [...tasks, { records: fixture.source_records, jobId: source }];
}

async function inspectTask() {
  watchParent();
  const { runCli } = await import("../dist/cli/main.js");
  const job = JSON.stringify({ job_id: destination });
  const { code, value } = await runCli(
    ["jobs", "inspect", "--request", "-", "--json"],
    {
      home: fixture.home,
      signal: stop.signal,
      stdin: (async function* () {
        yield Buffer.from(job);
      })(),
    },
  );
  assert.equal(code, 0, "CLI task inspection failed");
  process.send({ fingerprint: taskFingerprint(value.result) });
  if (!stop.signal.aborted) await once(stop.signal, "abort");
  if (process.connected) process.disconnect();
}

function taskFingerprint(task) {
  assert.equal(task.job.status, "running");
  return createHash("sha256")
    .update(canonicalJsonBytes(JSON.parse(JSON.stringify(task))))
    .digest("hex");
}

async function taskSidecar() {
  const output = resolve(destination);
  assert.ok(output.startsWith(resolve("sandbox/reports") + "/"));
  const tasks = taskBands();
  const directory = join(fixture.home, ".sciretriever", "cache", "task-detail");
  const result = {
    scale,
    corpus,
    node: process.version,
    load_start: loadavg(),
    objective_ms: objectives.task,
    points: [],
    warnings: [],
    tasks: {},
    failures: [],
  };
  const runtime = await acquireExecutionRuntime(catalog);
  const withServer = async (work) => {
    const server = spawn("serve", result.warnings);
    try {
      const { origin } = await server.first();
      const request = await client(origin);
      return await work(async (jobId) => {
        const { task } = await request(`/api/tasks/${jobId}`);
        assert.equal(task.job.status, "running");
        return task;
      });
    } finally {
      await server.close();
    }
  };
  const fileFor = (jobId) =>
    join(
      directory,
      createHash("sha256")
        .update(JSON.stringify([catalog, jobId]))
        .digest("hex") + ".checkpoint",
    );
  const writer = spawn("writer", result.warnings);
  writer.child.on("message", (point) => result.points.push(point));
  try {
    await writer.first();
    await wait(2500);
    const began = Date.now();
    for (const { records, jobId } of tasks) {
      const path = fileFor(jobId);
      const entry = (result.tasks[records] = { samples: [] });
      await rm(path, { force: true });
      let expected;
      entry.rebuild_ms = await withServer((read) =>
        measure(async () => {
          expected = await read(jobId);
        }),
      );
      const published = await stat(path, { bigint: true });
      entry.bytes = Number(published.size);
      for (let trial = 0; trial < trials; trial++) {
        entry.samples.push(
          await withServer(async (read) => {
            let task;
            const elapsed = await measure(async () => {
              task = await read(jobId);
            });
            assert.deepEqual(task, expected);
            return elapsed;
          }),
        );
      }
      assert.equal((await stat(path, { bigint: true })).ino, published.ino);
      Object.assign(entry, stats(entry.samples));
      if (entry.p95_ms > objectives.task)
        result.failures.push(
          `${records} records P95 ${entry.p95_ms.toFixed(1)} ms exceeds ${objectives.task} ms`,
        );
      console.log(scale, records, JSON.stringify(stats(entry.samples)));
    }
    const finished = Date.now();
    const points = result.points.filter(
      (point) => point.committed >= began && point.committed <= finished,
    );
    const first = points[0];
    const last = points.at(-1);
    result.papers_per_second =
      last?.committed > first?.committed
        ? (1000 * (last.papers - first.papers)) /
          (last.committed - first.committed)
        : 0;
    if (result.papers_per_second < 100)
      result.failures.push("Write load below 100 committed papers/s");

    const { jobId } = tasks[1];
    const cliFingerprint = async (concurrentRead) => {
      const cli = spawn("inspect-task", result.warnings, jobId);
      try {
        const [{ fingerprint }, task] = await Promise.all([
          cli.first(),
          concurrentRead?.(),
        ]);
        if (task) assert.equal(fingerprint, taskFingerprint(task));
        return fingerprint;
      } finally {
        await cli.close();
      }
    };
    await rm(fileFor(jobId), { force: true });
    const cliPublished = await cliFingerprint();
    await stat(fileFor(jobId));
    await rm(fileFor(jobId), { force: true });
    const concurrent = await withServer((read) =>
      cliFingerprint(() => read(jobId)),
    );
    assert.equal(concurrent, cliPublished);
    const shared = await stat(fileFor(jobId), { bigint: true });
    await withServer(async (read) =>
      assert.equal(taskFingerprint(await read(jobId)), concurrent),
    );
    assert.equal(await cliFingerprint(), concurrent);
    assert.equal(
      (await stat(fileFor(jobId), { bigint: true })).ino,
      shared.ino,
    );
    result.concurrent_cli_http_agree = true;
    await measureCheckpointWrites(directory, tasks, fileFor, result.tasks);
  } catch (error) {
    result.failures.push(error.stack ?? String(error));
  } finally {
    try {
      await writer.close();
    } finally {
      await runtime.release();
      result.load_finish = loadavg();
      if (result.warnings.length)
        result.failures.push("Short SQLite read budget log emitted");
      await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
        mode: 0o600,
      });
    }
  }
  assert.deepEqual(result.failures, []);
}

async function measureCheckpointWrites(directory, tasks, fileFor, entries) {
  const { TaskDetailSidecars, removeTaskScratch } = await import(
    "../dist/storage/sqlite/task-detail-sidecar.js"
  );
  const { taskDetailCatalogIdentity } = await import(
    "../dist/storage/sqlite/task-detail-engine.js"
  );
  const { EXECUTION_SCHEMA_VERSION, EXECUTION_RUNTIME_SCHEMA_VERSION } =
    await import("../dist/storage/sqlite/execution-schema.js");
  const { dev, ino } = await stat(catalog);
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    const identity = taskDetailCatalogIdentity(
      db,
      `${dev}:${ino}`,
      EXECUTION_SCHEMA_VERSION,
      EXECUTION_RUNTIME_SCHEMA_VERSION,
    );
    const { schema_version: schemaVersion } = db
      .prepare("PRAGMA schema_version")
      .get();
    const sidecars = new TaskDetailSidecars(directory, catalog);
    for (const { records, jobId } of tasks) {
      const loaded = sidecars.load(
        jobId,
        identity,
        schemaVersion,
        new Date().toISOString(),
      );
      assert.ok(loaded, "Could not reopen the published checkpoint");
      const samples = [];
      let inode = loaded.file.ino;
      try {
        for (let trial = 0; trial < 5; trial++) {
          samples.push(await measure(() => sidecars.save(loaded.transfer)));
          const current = await stat(fileFor(jobId), { bigint: true });
          assert.notEqual(current.ino, inode);
          inode = current.ino;
        }
      } finally {
        removeTaskScratch(loaded.transfer.path);
      }
      entries[records].checkpoint_write = { ...stats(samples), samples };
    }
  } finally {
    db.close();
  }
}

function indexProbe(points, lag) {
  const db = new DatabaseSync(catalog, { readOnly: true });
  db.exec("PRAGMA busy_timeout=1000");
  const latest =
    db.prepare(`SELECT (SELECT revision FROM retrieval_source_revision WHERE singleton=1) AS source,
       (SELECT g.source_revision FROM retrieval_generations g JOIN retrieval_active_generation a USING(generation_id)) AS indexed`);
  let covered = 0;
  let error;
  const scan = () => {
    if (error) throw error;
    const now = Date.now();
    const current = latest.get();
    while (points[covered]?.revision <= current.indexed) {
      lag.upper_bounds_ms.push(Math.max(0, now - points[covered++].committed));
    }
    const oldest = points[covered];
    if (oldest)
      assert.ok(
        now - oldest.committed <= 120_000,
        "Search index is more than two minutes behind",
      );
    return current.source === current.indexed && covered === points.length;
  };
  const timer = setInterval(() => {
    try {
      scan();
    } catch (failure) {
      error = failure;
    }
  }, 250);
  return {
    async drain() {
      const timeout = Date.now() + 120_000;
      while (!scan()) {
        assert.ok(Date.now() < timeout, "Search index failed to settle");
        await wait(250);
      }
    },
    close() {
      clearInterval(timer);
      db.close();
    },
  };
}

async function run() {
  assert.equal(mode, scale);
  const output = resolve(destination);
  const reports = resolve("sandbox/reports") + "/";
  assert.ok(output.startsWith(reports));
  let previous;
  if (scale === "1m") {
    const baseline = resolve(reference);
    assert.ok(baseline.startsWith(reports));
    previous = JSON.parse(await readFile(baseline, "utf8"));
    assert.equal(previous.scale, "10k");
  }
  const result = {
    scale,
    corpus,
    environment: {
      node: process.version,
      os: release(),
      load_start: loadavg(),
    },
    objectives,
    ratio_limit: ratioLimit,
    trials,
    operations: {},
    failures: [],
    warnings: [],
    points: [],
    index: { upper_bounds_ms: [] },
    short_reads: {},
  };
  const save = () =>
    writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  const runtime = await acquireExecutionRuntime(catalog);
  let server, writer, probe;
  try {
    server = spawn("serve", result.warnings);
    const { origin } = await server.first();
    const request = await client(origin);
    const search = async (input) => {
      const { page } = await request("/api/v1/query/search", input);
      assert.ok(page.items.length);
      return page;
    };
    const counts = async (query) => {
      const { result } = await request("/api/v1/query/library-counts", {
        query,
      });
      assert.ok(
        result.total > 0 &&
          !result.counts_backfill_pending &&
          !result.status_updating,
      );
      return result;
    };
    const all = { collection_scope: "all" };
    const collected = { collection_scope: "collected" };
    const scoped = {
      ...all,
      folder: { id: folder, include_descendants: false },
      statuses: ["UNREVIEWED"],
    };
    const list = { query: {}, limit: 50 };
    const collectedPage = async () => {
      const page = await search(list);
      assert.ok(page.items.every((item) => item.collected === true));
      return page;
    };
    const initial = await counts(all);
    assert.equal(initial.full_text.total, corpus.papers);
    assert.equal(initial.full_text.obtained, corpus.obtained);
    const operations = {
      home: () => Promise.all([collectedPage(), counts(collected)]),
      counts: () => counts(all),
      workset: async () => {
        const input = { query: scoped, limit: 50, sort: "intake-desc" };
        const [first] = await Promise.all([
          search(input),
          counts(scoped),
          request("/api/v1/query/library-facets", { query: scoped, limit: 20 }),
        ]);
        assert.ok(first.next_cursor);
        const second = await search({ ...input, cursor: first.next_cursor });
        assert.notEqual(
          first.items[0].literature.literature_id,
          second.items[0].literature.literature_id,
        );
      },
      search: () =>
        search({
          query: { ...all, text: "spectroscopy" },
          limit: 50,
          sort: "relevance",
        }),
      task: async () => {
        const { task } = await request(`/api/tasks/${fixture.jobs.running}`);
        assert.equal(task.job.status, "running");
      },
    };
    writer = spawn("writer", result.warnings);
    writer.child.on("message", (point) => result.points.push(point));
    await writer.first();
    probe = indexProbe(result.points, result.index);
    await wait(2500);
    const began = Date.now();
    for (const [name, work] of Object.entries(operations)) {
      const samples = [];
      result.operations[name] = { samples };
      if (name === "task") {
        let pending = true;
        const cold = measure(work).finally(() => {
          pending = false;
        });
        const short = {
          page: collectedPage,
          article: () =>
            request("/api/v1/query/read", {
              literature_id: fixture.pdf.literature_id,
            }),
          status: () => request("/api/view"),
          pdf: async () =>
            assert.equal(
              await request(
                `/api/v1/query/material-bytes/${fixture.pdf.literature_id}/${fixture.pdf.asset}/${fixture.pdf.artifact.sha256}`,
                undefined,
                "bytes=0-1023",
              ),
              1024,
            ),
        };
        const cutoff = performance.now() + 10 * objectives.task;
        while (pending && performance.now() < cutoff) {
          for (const [shortName, read] of Object.entries(short)) {
            (result.short_reads[shortName] ??= []).push(await measure(read));
          }
          await wait(100);
        }
        const ms = await cold;
        samples.push(ms);
        result.operations.task.cold_ms = ms;
        if (ms > objectives.task)
          result.failures.push(
            `task cold ${ms.toFixed(1)} ms > ${objectives.task} ms`,
          );
      }
      if (samples.some((duration) => duration > 10 * objectives[name])) {
        // This diagnostic read isolates warm-cache behavior after the stop. It
        // is not an acceptance sample and does not dilute the cold read.
        if (name === "task")
          result.operations.task.followup_ms = await measure(work);
      } else
        while (samples.length < trials) {
          const duration = await measure(work);
          samples.push(duration);
          if (duration > 10 * objectives[name]) break;
          await wait(40);
        }
      const distribution = stats(samples);
      if (distribution.n !== trials) {
        distribution.p50_ms = null;
        distribution.p95_ms = null;
      }
      Object.assign(result.operations[name], distribution);
      console.log(scale, name, JSON.stringify(distribution));
      if (
        scale === "1m" &&
        distribution.n === trials &&
        distribution.p95_ms > objectives[name]
      )
        result.failures.push(
          `${name} P95 ${distribution.p95_ms.toFixed(1)} ms > ${objectives[name]} ms`,
        );
      if (previous && distribution.n === trials) {
        const baseline = previous.operations[name];
        if (baseline?.n === trials && baseline.p95_ms > 0) {
          const ratio = distribution.p95_ms / baseline.p95_ms;
          result.operations[name].ratio = ratio;
          if (ratio > ratioLimit)
            result.failures.push(
              `${name} P95 ratio ${ratio.toFixed(2)} > ${ratioLimit}`,
            );
        } else result.failures.push(`No complete 10k P95 for ${name}`);
      }
      await save();
      if (samples.some((duration) => duration > 10 * objectives[name])) {
        result.stopped_at = name;
        result.failures.push(
          `Stopped at ${name}: latency over ten times target`,
        );
        break;
      }
    }
    const finished = Date.now();
    const inWindow = result.points.filter(
      (point) => point.committed >= began && point.committed <= finished,
    );
    const first = inWindow[0],
      last = inWindow.at(-1);
    result.papers_per_second =
      first && last && last.committed > first.committed
        ? ((last.papers - first.papers) * 1000) /
          (last.committed - first.committed)
        : 0;
    if (result.papers_per_second < 100)
      result.failures.push("Write load below 100 committed papers/s");
    for (const [name, values] of Object.entries(result.short_reads)) {
      const distribution = stats(values);
      result.short_reads[name] = { samples: values, ...distribution };
      if (distribution.max_ms > SHORT_READ_LIMIT_MS)
        result.failures.push(
          `Short read ${name} exceeded ${SHORT_READ_LIMIT_MS} ms`,
        );
      if (name === "page" && distribution.p95_ms > objectives.home)
        result.failures.push("Short page P95 exceeded 1 s during a long read");
    }
  } catch (error) {
    result.failures.push(error.stack ?? String(error));
  } finally {
    try {
      await writer?.close();
      await probe?.drain();
      result.index.max_upper_bound_ms = Math.max(
        0,
        ...result.index.upper_bounds_ms,
      );
      if (result.index.max_upper_bound_ms > 120_000)
        result.failures.push("Index lag exceeded 2 minutes");
    } catch (error) {
      result.failures.push(String(error));
    } finally {
      probe?.close();
    }
    try {
      await server?.close();
    } catch (error) {
      result.failures.push(String(error));
    } finally {
      await runtime.release();
    }
    if (result.warnings.length)
      result.failures.push("Short SQLite read budget log emitted");
    result.environment.load_finish = loadavg();
    await save();
  }
  assert.deepEqual(result.failures, []);
}

export { catalog, client, fixture, folder, measure, root, spawn, stats, stop };

if (resolve(process.argv[1]) === import.meta.filename) {
  if (mode === "serve") await serve();
  else if (mode === "writer") await write();
  else if (mode === "inspect-task") await inspectTask();
  else if (mode === "task-sidecar") await taskSidecar();
  else if (mode === "fulltext-search") await fulltextSearch();
  else if (mode === "workset-budget") await worksetBudgetSearch();
  else if (mode === "workset-budget-sweep" || mode === "side-member-sweep")
    await worksetBudgetSweep();
  else if (mode === "search-side-windows") await searchSideWindows();
  else if (mode === "search-windows" || mode === "search-candidates")
    await searchWindows();
  else if (
    mode === "side-window-sweep" ||
    mode === "search-windows-sweep" ||
    mode === "search-candidates-sweep"
  )
    await searchWindowSweep();
  else await run();
}
