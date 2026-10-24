import { SCHEMA_VERSION } from "../src/storage/sqlite/schema.js";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseLibraryQuery, parseLiterature } from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { runCli } from "../src/cli/main.js";
import { id, lit, setup } from "./content-fixture.js";

const apiOnlyAssets = new Map<string, { contentType: string; body: string }>();

const emptyQuery = {
  text: null,
  title: null,
  author: null,
  author_orcids: [],
  identifiers: [],
  publication_year_from: null,
  publication_year_to: null,
  venue: null,
  publisher: null,
  publication_forms: [],
  article_kinds: [],
  languages: [],
  keywords: [],
  version_roles: [],
  statuses: [],
  missing_steps: [],
  needs_manual_pdf: null,
  discovery_run_ids: [],
};

const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const SQLITE_COORDINATION_FILE = /^catalog\.sqlite-(?:wal|shm|journal)$/u;
async function businessFileManifest(
  root: string,
  relative = "",
): Promise<Readonly<Record<string, string>>> {
  const manifest: Record<string, string> = {};
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(manifest, await businessFileManifest(root, child));
    } else if (
      entry.isFile() &&
      !(relative === "" && SQLITE_COORDINATION_FILE.test(entry.name))
    ) {
      manifest[child] = await hash(join(root, child));
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
async function sqliteCoordinationManifest(root: string) {
  const values = [];
  for (const name of (await readdir(root)).filter((item) =>
    SQLITE_COORDINATION_FILE.test(item),
  )) {
    const metadata = await lstat(join(root, name));
    values.push({ name, size: metadata.size });
  }
  return values.sort((a, b) => a.name.localeCompare(b.name));
}
function sqliteBusinessFacts(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const names = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const facts = Object.fromEntries(
      names.map((name) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const rows = database.prepare(`SELECT * FROM ${quoted}`).all();
        rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return [name, rows];
      }),
    );
    return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  } finally {
    database.close();
  }
}

async function createSyntheticCatalog(
  home: string,
  literatures: readonly ReturnType<typeof parseLiterature>[] = [
    FIXTURE_LITERATURE,
  ],
): Promise<Awaited<ReturnType<typeof createApplication>>> {
  const writer = await createApplication(home);
  try {
    for (const literature of literatures)
      await writer.database.putLiterature(literature);
    expect(await writer.database.inspectExecutionRuntime()).toMatchObject({
      catalog_version: SCHEMA_VERSION,
      migrated: true,
    });

    expect(await writer.database.inspectExecutionRuntime()).toMatchObject({
      catalog_version: SCHEMA_VERSION,
      migrated: true,
    });
    return writer;
  } catch (error) {
    await writer.close();
    throw error;
  }
}

async function pendingRuntimeState(
  catalogPath: string,
  jobId: string,
  targetId: string,
  receiptId: string,
) {
  const database = new SqliteWorker(catalogPath, undefined, {
    readOnly: true,
  });
  try {
    return {
      job: await database.getExecutionJob(jobId),
      target: await database.getExecutionTarget(targetId),
      attempts: await database.listExecutionAttempts(targetId),
      receiptIntent: await database.getReceiptIntent(receiptId),
      receiptResult: await database.getReceiptResult(receiptId),
    };
  } finally {
    await database.close();
  }
}

it("reports a missing catalog without creating query or home state", async () => {
  const parent = await mkdtemp(join(tmpdir(), "sciretriever-query-empty-"));
  const home = join(parent, "not-created");
  let workbench:
    | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
    | undefined;
  try {
    workbench = await startQueryOnlyWorkbench({ home, assets: apiOnlyAssets });
    expect(workbench.application.readiness.status).toBe("not-initialized");
    expect(workbench.application.query).toBeNull();
    const status = await fetch(`${workbench.origin}/api/v1/query/status`);
    expect(await status.json()).toMatchObject({
      protocol_version: 1,
      readiness: { status: "not-initialized" },
    });
    const unavailable = await fetch(`${workbench.origin}/api/v1/query/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "query-not-initialized",
    });
    await workbench.close();
    workbench = undefined;
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await workbench?.close();
    await rm(parent, { recursive: true, force: true });
  }
});

it("reads an existing catalog through the real read-only SQLite worker", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-query-ready-"));
  let writer: Awaited<ReturnType<typeof createApplication>> | undefined;
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    writer = await createApplication(home);
    await writer.database.putLiterature(FIXTURE_LITERATURE);
    await writer.close();
    writer = undefined;
    const catalogPath = join(home, "catalog.sqlite");
    const beforeManifest = await businessFileManifest(home);
    const beforeFacts = sqliteBusinessFacts(catalogPath);
    const beforeCoordination = await sqliteCoordinationManifest(home);

    query = await createQueryApplication(home);
    expect(query.readiness).toMatchObject({
      status: "ready",
      schema_version: SCHEMA_VERSION,
    });
    expect(query.query).not.toBeNull();
    const page = await query.query!.search({
      query: parseLibraryQuery(emptyQuery),
      sort: "title-asc",
      limit: 10,
      cursor: null,
    });
    expect(page.items.map((item) => item.literature.literature_id)).toContain(
      FIXTURE_LITERATURE.literature_id,
    );
    const detail = await query.query!.detail(FIXTURE_LITERATURE.literature_id);
    expect(detail).not.toHaveProperty("content");
    expect(detail.primary_pdf).toBeNull();
    await query.close();
    query = undefined;
    expect(await businessFileManifest(home)).toEqual(beforeManifest);
    expect(sqliteBusinessFacts(catalogPath)).toBe(beforeFacts);
    const afterCoordination = await sqliteCoordinationManifest(home);
    expect(
      afterCoordination.every(({ name }) =>
        SQLITE_COORDINATION_FILE.test(name),
      ),
    ).toBe(true);
    expect(
      beforeCoordination.every(({ name }) =>
        SQLITE_COORDINATION_FILE.test(name),
      ),
    ).toBe(true);
  } finally {
    await query?.close();
    await writer?.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("serves a real query-only Web request without changing the catalog", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-query-http-"));
  let writer: Awaited<ReturnType<typeof createApplication>> | undefined;
  let workbench:
    | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
    | undefined;
  try {
    writer = await createApplication(home);
    await writer.database.putLiterature(FIXTURE_LITERATURE);
    await writer.close();
    writer = undefined;
    const catalogPath = join(home, "catalog.sqlite");
    const beforeManifest = await businessFileManifest(home);
    const beforeFacts = sqliteBusinessFacts(catalogPath);
    workbench = await startQueryOnlyWorkbench({ home, assets: apiOnlyAssets });
    expect("jobs" in workbench.application).toBe(false);

    const search = await fetch(`${workbench.origin}/api/v1/query/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        request: {
          query: parseLibraryQuery(emptyQuery),
          sort: "title-asc",
          limit: 10,
          cursor: null,
        },
      }),
    });
    expect(search.status).toBe(200);
    const searchResult = (await search.json()) as {
      readonly page: {
        readonly items: readonly {
          readonly literature: { readonly literature_id: string };
        }[];
      };
    };
    expect(
      searchResult.page.items.map((item) => item.literature.literature_id),
    ).toContain(FIXTURE_LITERATURE.literature_id);

    const read = await fetch(`${workbench.origin}/api/v1/query/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        request: { literature_id: FIXTURE_LITERATURE.literature_id },
      }),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      protocol_version: 1,
      detail: {
        primary_pdf: null,
      },
    });

    const artifact = await fetch(`${workbench.origin}/api/v1/query/artifact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        request: {
          literature_id: FIXTURE_LITERATURE.literature_id,
          kind: "primary-pdf",
        },
      }),
    });
    expect(artifact.status).toBe(200);
    expect(await artifact.json()).toMatchObject({
      protocol_version: 1,
      gap: {
        code: "missing-primary-pdf",
      },
    });

    for (const body of [
      "{}",
      "{",
      JSON.stringify({ protocol_version: 2, request: {} }),
    ]) {
      const invalid = await fetch(`${workbench.origin}/api/v1/query/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "invalid-command" });
    }

    await workbench.close();
    workbench = undefined;
    expect(await businessFileManifest(home)).toEqual(beforeManifest);
    expect(sqliteBusinessFacts(catalogPath)).toBe(beforeFacts);
  } finally {
    await workbench?.close();
    await writer?.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("refuses an unknown catalog fingerprint without modifying it", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-query-unknown-"));
  let writer: Awaited<ReturnType<typeof createApplication>> | undefined;
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let raw: DatabaseSync | undefined;
  try {
    writer = await createApplication(home);
    await writer.close();
    writer = undefined;
    const catalogPath = join(home, "catalog.sqlite");
    raw = new DatabaseSync(catalogPath);
    raw
      .prepare(
        "UPDATE schema_identity SET schema_fingerprint=? WHERE singleton=1",
      )
      .run("f".repeat(64));
    raw.close();
    raw = undefined;
    const before = await hash(catalogPath);

    query = await createQueryApplication(home);
    expect(query.readiness.status).toBe("unavailable");
    expect(query.query).toBeNull();
    await query.close();
    query = undefined;
    expect(await hash(catalogPath)).toBe(before);
  } finally {
    raw?.close();
    await query?.close();
    await writer?.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps a CLI query from initializing a missing home", async () => {
  const parent = await mkdtemp(join(tmpdir(), "sciretriever-query-cli-empty-"));
  const home = join(parent, "not-created");
  const stderr: string[] = [];
  try {
    const result = await runCli(["literature", "search"], {
      home,
      stderr: (text) => stderr.push(text),
    });

    expect(result.code).toBe(3);
    expect(stderr.join("")).toBe('{"code":"query-not-initialized"}\n');
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("queries a current catalog without changing its facts", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-query-v2-"));
  let writer: Awaited<ReturnType<typeof createApplication>> | undefined;
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    writer = await createSyntheticCatalog(home);
    const catalogPath = join(home, "catalog.sqlite");
    const beforeManifest = await businessFileManifest(home);
    const beforeFacts = sqliteBusinessFacts(catalogPath);

    query = await createQueryApplication(home);
    expect(query.readiness).toMatchObject({
      status: "ready",
      schema_version: SCHEMA_VERSION,
    });
    const page = await query.query!.search({
      query: parseLibraryQuery(emptyQuery),
      sort: "title-asc",
      limit: 10,
      cursor: null,
    });
    expect(page.items.map((item) => item.literature.literature_id)).toContain(
      FIXTURE_LITERATURE.literature_id,
    );
    await query.close();
    query = undefined;

    expect(await businessFileManifest(home)).toEqual(beforeManifest);
    expect(sqliteBusinessFacts(catalogPath)).toBe(beforeFacts);
    expect(await writer.database.inspectExecutionRuntime()).toMatchObject({
      catalog_version: SCHEMA_VERSION,
      migrated: true,
      counts: { execution_jobs: 0 },
    });
  } finally {
    await query?.close();
    await writer?.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("observes a writer commit through an open query reader without writing facts or jobs", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-query-wal-"));
  const secondLiterature = parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: "00000000-0000-0000-0000-000000000003",
    meta_literature_id: "00000000-0000-0000-0000-000000000004",
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: "Committed while the query reader is open",
      identifiers: [],
    },
  });
  let writer: Awaited<ReturnType<typeof createApplication>> | undefined;
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    writer = await createSyntheticCatalog(home);
    const catalogPath = join(home, "catalog.sqlite");
    const beforeReaderFacts = sqliteBusinessFacts(catalogPath);
    expect(await writer.database.inspectExecutionRuntime()).toMatchObject({
      counts: { execution_jobs: 0 },
    });

    query = await createQueryApplication(home);
    expect(query.readiness).toMatchObject({
      status: "ready",
      schema_version: SCHEMA_VERSION,
    });
    expect("jobs" in query).toBe(false);
    expect(sqliteBusinessFacts(catalogPath)).toBe(beforeReaderFacts);

    await writer.database.putLiterature(secondLiterature);
    const committedFacts = sqliteBusinessFacts(catalogPath);
    const committedRuntime = await writer.database.inspectExecutionRuntime();
    expect(committedRuntime.counts.execution_jobs).toBe(0);

    const page = await query.query!.search({
      query: parseLibraryQuery(emptyQuery),
      sort: "title-asc",
      limit: 10,
      cursor: null,
    });
    expect(page.items.map((item) => item.literature.literature_id)).toEqual(
      expect.arrayContaining([
        FIXTURE_LITERATURE.literature_id,
        secondLiterature.literature_id,
      ]),
    );

    expect(sqliteBusinessFacts(catalogPath)).toBe(committedFacts);
    expect(await writer.database.inspectExecutionRuntime()).toMatchObject({
      catalog_version: SCHEMA_VERSION,
      migrated: true,
      counts: { execution_jobs: 0 },
    });
    await query.close();
    query = undefined;
  } finally {
    await query?.close();
    await writer?.close();
    await rm(home, { recursive: true, force: true });
  }
});

// Reached 2.0 s under Full (36/12) load, too close to the 5 s default.
it("leaves pending recovery, execution, and publication state untouched on query startup", async () => {
  const env = await setup();
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  const catalogPath = join(env.home, "catalog.sqlite");
  const jobId = "query-startup-pending-job";
  const targetId = "query-startup-pending-target";
  const receiptId = "query-startup-pending-receipt";
  let ticketPath: string | undefined;
  let ticketBytes: Buffer | undefined;
  try {
    expect(await env.app.database.inspectExecutionRuntime()).toMatchObject({
      catalog_version: SCHEMA_VERSION,
      migrated: true,
    });
    const detail = await env.app.library.detail(lit);
    expect(detail.primary_pdf).not.toBeNull();
    expect(
      (
        await env.app.database.rawParse<unknown[]>(
          "current",
          detail.primary_pdf!.asset.asset_id,
        )
      ).length,
    ).toBe(2);

    const asset = detail.primary_pdf!.asset;
    const ticket = await env.app.artifactRecovery.prepare([
      {
        reference: asset.path,
        artifact: {
          sha256: asset.sha256,
          byte_size: asset.size_bytes,
          media_type: asset.media_type,
        },
      },
    ]);
    expect(ticket.artifacts.length).toBeGreaterThan(0);
    ticketPath = join(env.app.files.root, ticket.reference);

    const policy = {
      mode: "notify" as const,
      max_retries: 2,
      max_attempts: 20,
      max_network_bytes: 1_000_000,
      max_model_calls: 20,
      intervention_timeout_ms: 60_000,
    };
    await env.app.database.createExecutionJob(
      {
        job_id: jobId,
        target_kind: "literature",
        selector: { literature_id: lit },
        policy_version: "query-startup-policy",
        status: "queued",
        idempotency_key: "query-startup-pending-idempotency",
        created_at: "2026-09-20T00:00:00.000Z",
        finished_at: null,
      },
      "a".repeat(64),
      policy,
    );
    await env.app.database.putExecutionTarget({
      target_id: targetId,
      job_id: jobId,
      ordinal: 0,
      literature_id: lit,
      version_role: "published",
      stage: "queued",
      disposition: "pending",
      next_eligible_at: null,
    });
    await expect(
      env.app.database.claimExecutionTarget(jobId, "2026-09-20T00:00:01.000Z"),
    ).resolves.toMatchObject({ stage: "acquisition" });
    await env.app.database.startExecutionAttempt({
      attempt_id: "query-startup-pending-attempt",
      target_id: targetId,
      stage: "acquisition",
      status: "running",
      started_at: "2026-09-20T00:00:02.000Z",
      finished_at: null,
      failure: null,
      usage: { bytes: 0 },
    });

    const primary = detail.primary_pdf!;
    const transferId = "query-startup-pending-candidate";
    const transfers = env.app.execution!.transfers;
    await transfers.begin(transferId, 1_000_000, null, "fixture");
    await transfers.append(
      transferId,
      await env.app.files.read(primary.asset.path, primary.asset.size_bytes),
    );
    const candidate = await transfers.complete(transferId);
    const intent = {
      receipt_id: receiptId,
      metadata_snapshot: {
        revision: detail.metadata_revision,
        sha256: detail.metadata_sha256,
      },
      candidate,
      literature_id: lit,
      asset_id: id(70),
      literature_asset_id: id(71),
      target: "objects/query-startup-pending.pdf",
      provenance: primary.literature_asset.provenance,
      source_url: null,
      identity: "accepted" as const,
    };
    await env.app.database.prepareReceipt(intent);
    await expect(
      env.app.database.getReceiptResult(receiptId),
    ).resolves.toBeNull();

    await env.app.close();
    ticketBytes = await readFile(ticketPath);
    const beforeManifest = await businessFileManifest(env.home);
    const beforeFacts = sqliteBusinessFacts(catalogPath);
    const beforeRuntime = await pendingRuntimeState(
      catalogPath,
      jobId,
      targetId,
      receiptId,
    );

    query = await createQueryApplication(env.home);
    expect(query.readiness).toMatchObject({
      status: "ready",
      schema_version: SCHEMA_VERSION,
    });
    expect(query.query).not.toBeNull();
    await expect(query.query!.detail(lit)).resolves.toMatchObject({
      literature: { literature_id: lit },
      primary_pdf: { asset: { sha256: primary.asset.sha256 } },
    });
    await query.close();
    query = undefined;

    expect(await businessFileManifest(env.home)).toEqual(beforeManifest);
    expect(sqliteBusinessFacts(catalogPath)).toBe(beforeFacts);
    expect(await readFile(ticketPath)).toEqual(ticketBytes);
    expect(
      await pendingRuntimeState(catalogPath, jobId, targetId, receiptId),
    ).toEqual(beforeRuntime);
  } finally {
    await query?.close();
    await env.close();
  }
}, 30_000);

it("serves verified query artifacts and rejects tampered synthetic bytes", async () => {
  const env = await setup();
  let workbench:
    | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
    | undefined;
  try {
    const detail = await env.app.library.detail(lit);
    const primary = detail.primary_pdf!;
    const original = await env.app.files.read(
      primary.asset.path,
      primary.asset.size_bytes,
    );
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      primary.asset.sha256,
    );
    await env.app.close();

    workbench = await startQueryOnlyWorkbench({
      home: env.home,
      assets: apiOnlyAssets,
    });
    const requestArtifact = () =>
      fetch(`${workbench!.origin}/api/v1/query/artifact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: { literature_id: lit, kind: "primary-pdf" },
        }),
      });

    const accepted = await requestArtifact();
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("content-type")).toBe("application/pdf");
    expect(accepted.headers.get("x-sciretriever-protocol-version")).toBe("1");
    const delivered = new Uint8Array(await accepted.arrayBuffer());
    expect(createHash("sha256").update(delivered).digest("hex")).toBe(
      primary.asset.sha256,
    );
    expect(delivered).toEqual(original);

    const tampered = Buffer.from(original);
    const finalByteOffset = tampered.length - 1;
    const finalByte = tampered[finalByteOffset];
    if (finalByte === undefined) throw new Error("synthetic PDF is empty");
    tampered[finalByteOffset] = finalByte ^ 1;
    await writeFile(join(env.app.files.root, primary.asset.path), tampered);

    const rejected = await requestArtifact();
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({
      protocol_version: 1,
      code: "artifact-unavailable",
    });
  } finally {
    await workbench?.close();
    await env.close();
  }
});

it("reports a damaged full-text index instead of returning an empty search page", async () => {
  const env = await setup();
  let workbench:
    | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
    | undefined;
  const catalogPath = join(env.home, "catalog.sqlite");
  let raw: DatabaseSync | undefined;
  try {
    await env.app.close();
    raw = new DatabaseSync(catalogPath);
    raw.exec("DROP TABLE literature_search_fts");
    raw.close();
    raw = undefined;

    const beforeManifest = await businessFileManifest(env.home);
    const beforeFacts = sqliteBusinessFacts(catalogPath);
    workbench = await startQueryOnlyWorkbench({
      home: env.home,
      assets: apiOnlyAssets,
    });
    const search = await fetch(`${workbench.origin}/api/v1/query/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        request: {
          query: parseLibraryQuery({ ...emptyQuery, text: "Synthetic" }),
          sort: "relevance",
          limit: 10,
          cursor: null,
        },
      }),
    });
    expect(search.status).toBe(503);
    expect(await search.json()).toMatchObject({
      protocol_version: 1,
      code: "query-unavailable",
    });

    await workbench.close();
    workbench = undefined;
    expect(await businessFileManifest(env.home)).toEqual(beforeManifest);
    expect(sqliteBusinessFacts(catalogPath)).toBe(beforeFacts);
  } finally {
    raw?.close();
    await workbench?.close();
    await env.close();
  }
});
