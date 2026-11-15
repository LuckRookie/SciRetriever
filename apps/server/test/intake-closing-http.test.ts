import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  IMPORT_LIMITS,
  parseDeviceConnectionCode,
  parseLiterature,
  parseProvenance,
  sha256,
  type ImportAdapter,
  type IntakeBatch,
  type IntakeReport,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { createTaskOperations } from "../src/entry/task-operations.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";
import { rawParserFixture } from "./raw-parser-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

const limitsAdapter: ImportAdapter = {
  format: "synthetic-counts",
  decode(value) {
    const count = typeof value === "number" ? value : 0;
    return {
      groups: [],
      excluded: [],
      items: Array.from({ length: count }, (_, record_index) => ({
        record_index,
        record: null,
        reason: "synthetic-rejection",
      })),
    };
  },
};
async function fixture(adapters: readonly ImportAdapter[] = []) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-closing-"));
  let parseCalls = 0;
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [] },
    importSessions: { maintain: false, adapters },
    parsing: {
      rawParser: rawParserFixture({
        async parse(request) {
          parseCalls++;
          const bytes = Buffer.from(
            "# Synthetic current parse\n\nOffline text.\n",
          );
          return {
            source_asset_id: request.source_asset_id,
            source_sha256: request.source_sha256,
            page_count: 1,
            markdown: {
              bytes,
              artifact: {
                sha256: await sha256(bytes),
                byte_size: bytes.length,
                media_type: "text/markdown",
              },
            },
            resources: [],
            provenance: {
              parser_version: "synthetic",
              mode: null,
              model_identity: null,
              provenance: parseProvenance({
                provenance_id: randomUUID(),
                source_kind: "parser",
                source_name: "synthetic",
                source_record_id: null,
                observed_at: new Date().toISOString(),
                input_sha256: request.source_sha256,
                parameters_sha256: "a".repeat(64),
              }),
            },
          };
        },
      }),
    },
  });
  const tasks = createTaskOperations(app)!;
  const session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    tasks,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
    devices: {
      service: app.deviceConnections,
      routes: deviceBusinessRoutes(app),
    },
  });
  const pairing = await app.deviceConnections.create({
    address: server.origin,
    name: "Synthetic intake",
    purposes: ["intake"],
  });
  const { token } = await app.deviceConnections.exchange(
    {
      pairing_code: parseDeviceConnectionCode(pairing.connection_code)
        .pairing_code,
    },
    randomUUID(),
  );
  // Attach with both login and workbench cookies; never print either credential.
  const login = await workbenchLogin(server.origin);
  const root = await fetch(server.origin, { headers: { Cookie: login } });
  const cookie =
    login +
    "; " +
    root.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  await root.arrayBuffer();
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
  const grant = (await attached.json()) as { client_id: string; csrf: string };
  const api = async (path: string, request: unknown = {}) => {
    const response = await fetch(server.origin + "/api/v1/intake" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
      },
      body: JSON.stringify({ protocol_version: 1, request }),
    });
    return { status: response.status, body: await response.json() };
  };
  const ok = async <T>(path: string, request: unknown = {}): Promise<T> => {
    const r = await api(path, request);
    expect(r.status).toBe(200);
    return r.body.result as T;
  };
  const create = async (format = "records", library = randomUUID()) =>
    (
      await ok<{ batch: IntakeBatch }>("/batches", {
        format,
        source: {
          system: "synthetic",
          identity: "global",
          library_id: library,
          name: "Synthetic library",
        },
        scope: "HTTP closing acceptance",
      })
    ).batch.batch_id;
  const status = async (id: string) =>
    (await ok<{ batch: IntakeBatch }>(`/batches/${id}/status`)).batch;
  const complete = async (id: string) => {
    await ok(`/batches/${id}/confirm`);
    await vi.waitFor(
      async () => expect((await status(id)).state).toBe("finished"),
      { timeout: 20_000 },
    );
    return await ok<IntakeReport>(`/batches/${id}/report`);
  };
  const task = async (request: unknown) => {
    const response = await fetch(
      server.origin + "/api/tasks?client_id=" + grant.client_id,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: server.origin,
          "X-Workbench-Csrf": grant.csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
    expect(response.status).toBe(201);
    return (await response.json()).task as { job_id: string };
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
  return {
    app,
    api,
    ok,
    create,
    status,
    complete,
    task,
    tasks,
    sql,
    get parseCalls() {
      return parseCalls;
    },
    async close() {
      await server.close();
      await session.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
function record(external_id: string, doi = external_id) {
  return {
    external_id,
    metadata: {
      ...EMPTY_METADATA,
      title: `Synthetic ${external_id}`,
      identifiers: [{ namespace: "doi", value: `10.5555/closing-${doi}` }],
    },
  };
}

it("enforces the actual cumulative 50000-record boundary over HTTP without accepting the failed part", async () => {
  const f = await fixture([limitsAdapter]);
  try {
    const id = await f.create(limitsAdapter.format);
    await f.ok(`/batches/${id}/data`, { sequence: 0, data: 25_000 });
    await f.ok(`/batches/${id}/data`, { sequence: 1, data: 25_000 });
    expect(
      await f.api(`/batches/${id}/data`, { sequence: 2, data: 1 }),
    ).toMatchObject({ status: 413, body: { code: "intake-batch-limit" } });
    expect(f.sql("SELECT record_count n FROM import_sessions")[0]!.n).toBe(
      50_000,
    );
    expect(f.sql("SELECT count(*) n FROM import_parts")[0]!.n).toBe(2);
  } finally {
    await f.close();
  }
}, 40_000);

it("enforces the actual 256 MiB staged-data boundary over HTTP including repeated part bytes", async () => {
  const f = await fixture([limitsAdapter]);
  try {
    const id = await f.create(limitsAdapter.format);
    const data = "x".repeat(IMPORT_LIMITS.request_bytes - 4096);
    const started = performance.now();
    for (let sequence = 0; sequence < 32; sequence++)
      await f.ok(`/batches/${id}/data`, { sequence, data });
    const before = f.sql(
      "SELECT sum(a.byte_size) n FROM import_parts p JOIN artifact_objects a USING(artifact_id)",
    )[0]!.n;
    expect(Number(before)).toBeLessThanOrEqual(IMPORT_LIMITS.batch_bytes);
    expect(
      await f.api(`/batches/${id}/data`, { sequence: 32, data }),
    ).toMatchObject({ status: 413, body: { code: "intake-batch-limit" } });
    expect(f.sql("SELECT count(*) n FROM import_parts")[0]!.n).toBe(32);
    expect(
      f.sql(
        "SELECT sum(a.byte_size) n FROM import_parts p JOIN artifact_objects a USING(artifact_id)",
      )[0]!.n,
    ).toBe(before);
    console.log(
      "intake-batch-byte-limit",
      JSON.stringify({
        staged_bytes: before,
        limit: IMPORT_LIMITS.batch_bytes,
        elapsed_ms: performance.now() - started,
      }),
    );
  } finally {
    await f.close();
  }
}, 180_000);

it("enforces 10000 groups and cross-part external-key conflicts through HTTP", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    const group = (i: number) => ({
      external_id: `group-${i}`,
      parent_external_id: null,
      name: `Group ${i}`,
    });
    await f.ok(`/batches/${id}/data`, {
      sequence: 0,
      data: {
        records: [],
        groups: Array.from({ length: 10_000 }, (_, i) => group(i)),
      },
    });
    expect(
      await f.api(`/batches/${id}/data`, {
        sequence: 1,
        data: { records: [], groups: [group(10_000)] },
      }),
    ).toMatchObject({ status: 413, body: { code: "intake-batch-limit" } });
    for (const data of [
      { records: [], groups: [group(1)] },
      { records: [record("same")] },
    ]) {
      const other = await f.create();
      await f.ok(`/batches/${other}/data`, { sequence: 0, data });
      expect(
        await f.api(`/batches/${other}/data`, { sequence: 1, data }),
      ).toMatchObject({ status: 400, body: { code: "intake-data-conflict" } });
      expect((await f.status(other)).state).toBe("awaiting-confirmation");
      // Same-sequence replacement remains legal; a rejected next part did not reserve its keys.
      await f.ok(`/batches/${other}/data`, { sequence: 0, data });
    }
    expect(f.sql("SELECT count(*) n FROM literatures")[0]!.n).toBe(0);
  } finally {
    await f.close();
  }
}, 40_000);

it("rejects excessive depth, cycles and missing groups over HTTP while accepting depth 128", async () => {
  const f = await fixture();
  try {
    for (const [length, expected] of [
      [128, null],
      [129, "intake-group-depth"],
    ] as const) {
      const id = await f.create();
      const groups = Array.from({ length }, (_, i) => ({
        external_id: String(i),
        parent_external_id: i ? String(i - 1) : null,
        name: String(i),
      }));
      await f.ok(`/batches/${id}/data`, {
        sequence: 0,
        data: { records: [], groups },
      });
      const result = await f.api(`/batches/${id}/preview`);
      expect(result.status).toBe(expected ? 400 : 200);
      if (expected) {
        expect(result.body.code).toBe(expected);
        expect(await f.api(`/batches/${id}/confirm`)).toMatchObject({
          status: 400,
          body: { code: expected },
        });
      }
    }
    for (const [parent, code] of [
      ["self", "intake-group-cycle"],
      ["missing", "intake-group-missing"],
    ] as const) {
      const id = await f.create();
      await f.ok(`/batches/${id}/data`, {
        sequence: 0,
        data: {
          records: [],
          groups: [
            { external_id: "self", parent_external_id: parent, name: "Group" },
          ],
        },
      });
      expect(await f.api(`/batches/${id}/preview`)).toMatchObject({
        status: 400,
        body: { code },
      });
    }
    expect(f.sql("SELECT count(*) n FROM folders")[0]!.n).toBe(0);
  } finally {
    await f.close();
  }
}, 40_000);

it("decodes each part once per preview and HTTP confirmation, including background admission", async () => {
  const decode = vi.fn(limitsAdapter.decode);
  const f = await fixture([{ ...limitsAdapter, decode }]);
  try {
    const id = await f.create(limitsAdapter.format);
    for (let sequence = 0; sequence < 2; sequence++)
      await f.ok(`/batches/${id}/data`, { sequence, data: 1 });
    expect(decode).toHaveBeenCalledTimes(2);
    await f.ok(`/batches/${id}/preview`);
    expect(decode).toHaveBeenCalledTimes(4);
    await f.complete(id);
    expect(decode).toHaveBeenCalledTimes(6);
    expect(f.parseCalls).toBe(0);
  } finally {
    await f.close();
  }
}, 40_000);

it("persists metadata_only and excludes attachments without leaving pending files or a partial result", async () => {
  const f = await fixture();
  try {
    const source =
      "@article{attached,title={Metadata policy},doi={10.5555/metadata-only-policy},file={Full Text PDF:files/123/a.pdf:application/pdf;Other:files/123/b.pdf:PDF;Snapshot:files/123/page.html:text/html}}";
    for (const mode of [undefined, false, true]) {
      const created = await f.ok<{ batch: IntakeBatch }>("/batches", {
        format: "bibtex",
        source: null,
        scope: "Metadata-only policy",
        ...(mode === undefined ? {} : { metadata_only: mode }),
      });
      const id = created.batch.batch_id;
      expect(created.batch.request.metadata_only).toBe(mode ?? false);
      expect(
        f.sql(
          `SELECT json_extract(request_json,'$.metadata_only') mode FROM intake_batches WHERE batch_id='${id}'`,
        )[0]!.mode,
      ).toBe(mode === true ? 1 : 0);
      await f.ok(`/batches/${id}/data`, { sequence: 0, data: source });
      const preview = await f.ok<IntakeReport>(`/batches/${id}/preview`);
      expect(preview.summary.files.missing).toBe(mode === true ? 0 : 1);
      if (mode === true) {
        expect(preview.summary.excluded).toEqual([
          { kind: "metadata-only-attachment", count: 3 },
        ]);
        const report = await f.complete(id);
        expect(report.batch).toMatchObject({
          state: "finished",
          result: "completed",
        });
        expect(report.summary.excluded).toEqual(preview.summary.excluded);
        expect(
          (
            await f.ok<{ items: unknown[] }>(`/batches/${id}/files`, {
              pending: false,
            })
          ).items,
        ).toEqual([]);
      } else {
        expect(preview.summary.excluded).toEqual([
          { kind: "additional-file", count: 1 },
          { kind: "non-pdf-file", count: 1 },
        ]);
        await f.ok(`/batches/${id}/confirm`);
        await vi.waitFor(
          async () =>
            expect((await f.status(id)).progress?.phase).toBe("files"),
          { timeout: 20_000 },
        );
        expect(
          (await f.ok<{ items: unknown[] }>(`/batches/${id}/files`)).items,
        ).toHaveLength(1);
        await f.ok(`/batches/${id}/cancel`);
      }
    }
    expect(f.sql("SELECT count(*) n FROM literatures")[0]!.n).toBe(1);
    expect(f.parseCalls).toBe(0);
  } finally {
    await f.close();
  }
}, 40_000);

it("reports paper-level full-text counts and creates frozen acquisition/parse scopes only on explicit HTTP submission", async () => {
  const f = await fixture();
  try {
    const library = randomUUID(),
      seed = await f.create("records", library);
    await f.ok(`/batches/${seed}/data`, {
      sequence: 0,
      data: {
        records: [record("external", "first"), record("other", "second")],
      },
    });
    await f.complete(seed);
    const id = await f.create("records", library);
    await f.ok(`/batches/${id}/data`, {
      sequence: 0,
      data: {
        records: [
          record("external", "second"),
          record("pdf"),
          record("exhausted"),
          record("retryable"),
          record("sibling"),
        ],
      },
    });
    const report = await f.complete(id);
    expect(report.batch.counts).toMatchObject({ hits: 4, conflicts: 1 });
    const ids = new Map(
      report.items.map((i) => [i.external_id, i.literature_id!]),
    );
    const sibling = async (original: string) => {
      const facts = (await f.app.database.currentFacts(original))!;
      const literature = parseLiterature({
        ...facts.literature,
        literature_id: randomUUID(),
        version_role: "preprint",
        metadata: { ...facts.literature.metadata, identifiers: [] },
      });
      await f.app.database.putLiterature(literature);
      return literature.literature_id;
    };
    const outside = await sibling(ids.get("sibling")!);
    for (const target of [outside, ids.get("pdf")!])
      await f.app.maintenance!.ingestPdf({
        literature_id: target,
        bytes: workbenchPdf(),
      });
    await f.app.database.setAutomaticPdfExhaustion(ids.get("exhausted")!);
    const counts = { total: 4, obtained: 2, missing: 2, exhausted: 1 };
    expect(await f.status(id)).toMatchObject({
      full_text: counts,
      estimates: { acquire_pdf: 2, parse: 1 },
    });
    expect(
      (await f.ok<IntakeReport>(`/batches/${id}/report`)).summary.full_text,
    ).toEqual(counts);
    const unexhausted = await sibling(ids.get("exhausted")!);
    expect((await f.status(id)).full_text.exhausted).toBe(0);
    await f.app.database.setAutomaticPdfExhaustion(unexhausted);
    expect((await f.status(id)).full_text.exhausted).toBe(1);
    expect(await f.app.jobs!.listJobs()).toEqual([]);
    expect(f.parseCalls).toBe(0);
    const batches = f.sql("SELECT count(*) n FROM intake_batches")[0]!.n;
    const selector = {
      kind: "query",
      query: { intake_batch_ids: [id] },
      sort: "title-asc",
      limit: null,
    };
    const acquire = await f.task({
      kind: "acquire-pdf",
      selector,
      idempotency_key: "closing-acquire",
    });
    const acquisition = await f.tasks.read(acquire.job_id);
    expect(acquisition.scope).toMatchObject({
      selector: { query: { intake_batch_ids: [id] } },
      counts: { process: 2 },
    });
    expect(acquisition.targets.map((t) => t.literature_id).sort()).toEqual(
      [ids.get("retryable"), ids.get("sibling")].sort(),
    );
    const parse = await f.task({
      kind: "parse-documents",
      selector,
      idempotency_key: "closing-parse",
    });
    const parsing = await f.tasks.read(parse.job_id);
    expect(parsing.targets.map((t) => t.literature_id)).toEqual([
      ids.get("pdf"),
    ]);
    expect(parsing.scope).toMatchObject({
      selector: { query: { intake_batch_ids: [id] } },
      counts: {
        matched: 4,
        process: 1,
        skipped_no_pdf: 3,
        skipped_parsed: 0,
        over_limit: 0,
      },
    });
    expect(
      (
        await f.task({
          kind: "parse-documents",
          selector,
          idempotency_key: "closing-parse",
        })
      ).job_id,
    ).toBe(parse.job_id);
    expect(f.sql("SELECT count(*) n FROM intake_batches")[0]!.n).toBe(batches);
    expect(f.parseCalls).toBe(0);
    const facts = (await f.app.database.currentFacts(ids.get("pdf")!))!,
      asset = facts.primary_asset!;
    await f.app.documentProcessing!.parseDocuments({
      literature_id: ids.get("pdf"),
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      profiles: ["pipeline"],
      force: false,
    });
    expect((await f.status(id)).estimates.parse).toBe(1);
    await f.app.documentProcessing!.parseDocuments({
      literature_id: ids.get("pdf"),
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      profiles: ["vlm-engine"],
      force: false,
    });
    expect((await f.status(id)).estimates.parse).toBe(0);
    // Later parsing changes the estimate, never the already frozen task targets.
    expect((await f.tasks.read(parse.job_id)).targets).toEqual(parsing.targets);
  } finally {
    await f.close();
  }
}, 60_000);
