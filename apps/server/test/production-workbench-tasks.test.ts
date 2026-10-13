import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseProvenance,
  parseWorkbenchView,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-production-tasks-"));
  const data = join(home, "selected-data");
  await mkdir(data);
  await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
  const catalog = join(data, "library.sqlite");
  const artifacts = join(data, "materials");
  await writeFile(
    join(home, ".sciretriever", "config.toml"),
    `[paths]\ncatalog_path=${JSON.stringify(catalog)}\nartifact_root=${JSON.stringify(artifacts)}\n[sources.acquisition]\nmode="custom"\nproviders=[]\n`,
    { mode: 0o600 },
  );
  await initializeCatalogSchema(catalog);
  let discoveryCalls = 0;
  let discoveryHook: () => Promise<void> = async () => {};
  let parseCalls = 0;
  let parseHook: (signal?: AbortSignal) => Promise<void> = async () => {};
  const server = await startProductionWorkbench({
    home,
    assets: new Map([
      ["/", { contentType: "text/html", body: "<main>Workbench</main>" }],
    ]),
    applicationOptions: {
      browserHost: () => null,
      metadata: {
        topic_search_ports: [
          {
            provider_name: "crossref",
            open_topic_search: () => {
              discoveryCalls++;
              return {
                pull_raw_item: async () => {
                  await discoveryHook();
                  return null;
                },
                convert_raw_item: () => ({ observations: [], relations: [] }),
              };
            },
          },
        ],
      },
      parsing: {
        rules: new TypeScriptParserArtifactRules(),
        parser: {
          parse: async (request, signal) => {
            parseCalls++;
            await parseHook(signal);
            const bytes = Buffer.from(
              "# Synthetic article\n\nA durable result.\n",
            );
            return {
              source_asset_id: request.source_asset_id,
              source_sha256: request.source_sha256,
              page_count: 1,
              markdown: {
                artifact: {
                  sha256: await sha256(bytes),
                  byte_size: bytes.length,
                  media_type: "text/markdown",
                } as ArtifactRef,
                bytes,
              },
              resources: [],
              provenance: {
                provenance: parseProvenance({
                  provenance_id: randomUUID(),
                  source_kind: "parser",
                  source_name: "synthetic",
                  source_record_id: null,
                  observed_at: new Date().toISOString(),
                  input_sha256: request.source_sha256,
                  parameters_sha256: "a".repeat(64),
                }),
                parser_version: "fixture-1",
                mode: null,
                model_identity: null,
              },
            };
          },
        },
      },
    },
  });
  const index = await fetch(server.origin);
  const cookie = index.headers.get("set-cookie")!.split(";")[0]!;
  const init = await fetch(`${server.origin}/api/clients`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: server.origin,
      "X-Workbench-Init": "1",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const grant = (await init.json()) as {
    client_id: string;
    csrf: string;
    view: unknown;
  };
  async function call(
    path: string,
    value?: unknown,
    overrides: Record<string, string> = {},
  ) {
    const response = await fetch(
      `${server.origin}${path}${path.includes("?") ? "&" : "?"}client_id=${grant.client_id}`,
      {
        method: value === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: server.origin,
          "Content-Type": "application/json",
          "X-Workbench-Csrf": grant.csrf,
          "X-Sciretriever-Protocol-Version": "1",
          ...overrides,
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      },
    );
    return {
      status: response.status,
      value: (await response.json()) as Record<string, unknown>,
    };
  }
  return {
    home,
    server,
    catalog,
    artifacts,
    grant,
    cookie,
    call,
    get discoveryCalls() {
      return discoveryCalls;
    },
    get parseCalls() {
      return parseCalls;
    },
    setDiscoveryHook(hook: typeof discoveryHook) {
      discoveryHook = hook;
    },
    setParseHook(hook: typeof parseHook) {
      parseHook = hook;
    },
    async seed() {
      await server.application.database.putLiterature(FIXTURE_LITERATURE);
      await server.application.maintenance!.ingestPdf({
        literature_id: FIXTURE_LITERATURE.literature_id,
        bytes: workbenchPdf(),
      });
      const asset = (
        await server.application.library.detail(
          FIXTURE_LITERATURE.literature_id,
        )
      ).primary_pdf!.asset;
      return {
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        mode: "reparse" as const,
        expected_default_revision: null,
      };
    },
    async close() {
      await server.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("production task workbench composition", () => {
  it("starts without a literature, binds the configured database, shares authenticated reader routes and imports metadata", async () => {
    const env = await fixture();
    try {
      expect(parseWorkbenchView(env.grant.view).article_id).toBeNull();
      for (const key of ["document", "knowledge", "synthesis"])
        expect(
          (
            await fetch(
              `${env.server.origin}/?workspace=library&job=job-1&literature=${FIXTURE_LITERATURE.literature_id}&${key}=${randomUUID()}`,
            )
          ).status,
        ).toBe(200);
      expect(
        (await fetch(`${env.server.origin}/?workspace=jobs&task_filter=active`))
          .status,
      ).toBe(200);
      expect(
        (
          await fetch(
            `${env.server.origin}/?workspace=jobs&task_filter=unknown`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(
            `${env.server.origin}/?workspace=library&knowledge=%3Cscript%3E`,
          )
        ).status,
      ).toBe(400);
      expect(
        (await fetch(`${env.server.origin}/?document=one&document=two`)).status,
      ).toBe(400);
      expect(
        await env.call("/api/control", {
          kind: "takeover",
          control_epoch: 0,
          session_id: parseWorkbenchView(env.grant.view).session_id,
          article_id: null,
        }),
      ).toMatchObject({ status: 409, value: { code: "stale-command" } });

      expect(env.server.application.browserHost()).toBeNull();
      expect(env.discoveryCalls).toBe(0);
      expect(await env.call("/api/workspace")).toMatchObject({
        status: 200,
        value: {
          workspace: {
            catalog_path: env.catalog,
            artifact_root: env.artifacts,
            schema_version: 9,
            capabilities: { tasks: true, query: true, maintenance: true },
          },
        },
      });
      expect(await env.call("/api/v1/query/status")).toMatchObject({
        status: 200,
        value: { readiness: { status: "ready" } },
      });
      expect(
        await env.call("/api/import", {
          format: "csl-json",
          content: JSON.stringify([
            {
              id: "synthetic",
              type: "article-journal",
              title: "Imported from the workbench",
              DOI: "10.5555/workbench-import",
              issued: { "date-parts": [[2026]] },
            },
          ]),
        }),
      ).toMatchObject({
        status: 200,
        value: { report: { items: [{ disposition: "created" }] } },
      });
      const library = await env.server.application.library.search({
        query: {},
        sort: "title-asc",
        limit: 10,
        cursor: null,
      });
      const id = library.items[0]!.literature.literature_id;
      expect(
        await env.call("/api/v1/query/read", {
          protocol_version: 1,
          request: { literature_id: id },
        }),
      ).toMatchObject({
        status: 200,
        value: {
          detail: {
            literature: { metadata: { title: "Imported from the workbench" } },
          },
        },
      });
      expect(
        await env.call(
          "/api/v1/query/read",
          { protocol_version: 1, request: { literature_id: id } },
          { "X-Workbench-Csrf": "invalid" },
        ),
      ).toMatchObject({ status: 403 });
      expect(
        (await fetch(`${env.server.origin}/api/v1/query/status`)).status,
      ).toBe(401);
      expect(
        await env.call("/api/discovery", { query: "synthetic", scan_limit: 0 }),
      ).toMatchObject({ status: 400 });
      expect(
        await env.call("/api/tasks", {
          kind: "acquire-pdf",
          idempotency_key: "invalid",
          selector: { kind: "all-pending", unexpected: true },
        }),
      ).toMatchObject({ status: 400 });
      expect(
        await env.call("/api/discovery", { query: "synthetic", scan_limit: 1 }),
      ).toMatchObject({
        status: 200,
        value: {
          report: {
            status: "COMPLETED",
            accepted_count: 0,
            source_results: [
              { provider_name: "crossref", outcome: "EXHAUSTED" },
            ],
          },
        },
      });
      expect(env.discoveryCalls).toBe(1);
      expect(env.server.application.browserHost()).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("executes PDF and processing tasks through the durable runtime and reads the same committed document", async () => {
    const env = await fixture();
    try {
      const parseRequest = await env.seed();
      const submitted = await env.call("/api/tasks", {
        kind: "processing",
        request: {
          schema_version: 1,
          idempotency_key: "web-parse",
          operations: [{ operation: "parse-documents", request: parseRequest }],
        },
      });
      expect(submitted.status).toBe(201);
      const id = (submitted.value.task as { job_id: string }).job_id;
      expect(env.parseCalls).toBe(0);
      expect(await env.call(`/api/tasks/${id}/start`, {})).toMatchObject({
        status: 202,
        value: { started: true },
      });
      await vi.waitFor(async () =>
        expect((await env.server.application.jobs!.getJob(id))?.status).toBe(
          "completed",
        ),
      );
      expect(env.parseCalls).toBe(1);
      expect(await env.call(`/api/tasks/${id}`)).toMatchObject({
        status: 200,
        value: {
          task: {
            job: { status: "completed" },
            results: [{ operation: "parse-documents" }],
            failures: [],
            policy: { mode: "never" },
          },
        },
      });
      expect(
        await env.call("/api/v1/query/document-default", {
          protocol_version: 1,
          request: {
            literature_id: parseRequest.literature_id,
            asset_id: parseRequest.asset_id,
            asset_sha256: parseRequest.asset_sha256,
          },
        }),
      ).toMatchObject({
        status: 200,
        value: {
          result: { default: { document_version_id: expect.any(String) } },
        },
      });
      expect(
        await env.call("/api/v1/maintenance/document-default", parseRequest),
      ).toMatchObject({ status: 200 });
      expect(
        await env.call("/api/v1/maintenance/document-default", parseRequest, {
          "X-Workbench-Csrf": "wrong",
        }),
      ).toMatchObject({ status: 403 });
      const pdf = await env.call("/api/tasks", {
        kind: "acquire-pdf",
        idempotency_key: "web-pdf",
        selector: {
          kind: "literatures",
          literature_ids: [parseRequest.literature_id],
        },
        policy: { mode: "pause", max_attempts: 3, max_model_calls: 8 },
      });
      expect(pdf.status).toBe(201);
      const pdfId = (pdf.value.task as { job_id: string }).job_id;
      expect(await env.call(`/api/tasks/${pdfId}`)).toMatchObject({
        value: {
          task: {
            policy: { mode: "pause", max_attempts: 3, max_model_calls: 8 },
          },
        },
      });
      expect(await env.call(`/api/jobs/${pdfId}/run`, {})).toMatchObject({
        status: 200,
      });
      expect((await env.server.application.jobs!.getJob(pdfId))?.status).toBe(
        "completed",
      );
      expect(await env.call("/api/tasks")).toMatchObject({
        status: 200,
        value: {
          tasks: expect.arrayContaining([
            expect.objectContaining({ job_id: id }),
            expect.objectContaining({ job_id: pdfId }),
          ]),
        },
      });
      const first = await env.call("/api/tasks?limit=1");
      expect(first.value).toMatchObject({
        tasks: [{ job_id: pdfId }],
        next_cursor: expect.any(String),
      });
      const second = await env.call(
        `/api/tasks?limit=1&cursor=${String(first.value.next_cursor)}`,
      );
      expect(second.value).toMatchObject({
        tasks: [{ job_id: id }],
        next_cursor: null,
      });
      expect(await env.call("/api/tasks?cursor=invalid")).toMatchObject({
        status: 400,
      });
      expect(
        (await env.call("/api/tasks?status_group=active")).value,
      ).toMatchObject({ tasks: [], next_cursor: null });
      expect(
        (await env.call("/api/tasks?status_group=ended&limit=1")).value,
      ).toMatchObject({ tasks: [{ job_id: pdfId }] });
      expect(await env.call("/api/tasks?status_group=unknown")).toMatchObject({
        status: 400,
      });
      expect(await env.call("/api/tasks/missing/cancel", {})).toMatchObject({
        status: 404,
      });

      expect(await env.call("/api/tasks/missing")).toMatchObject({
        status: 404,
        value: { code: "processing-not-found" },
      });
      await env.server.close();
      const reopened = await startProductionWorkbench({
        home: env.home,
        assets: new Map([
          ["/", { contentType: "text/html", body: "Workbench" }],
        ]),
        applicationOptions: { browserHost: () => null, metadata: {} },
      });
      try {
        expect(
          (await reopened.application.processingTasks!.read(id)).job.status,
        ).toBe("completed");
        expect(
          (await reopened.application.processingTasks!.read(id)).results,
        ).toHaveLength(1);
        expect(reopened.application.browserHost()).toBeNull();
        expect(env.parseCalls).toBe(1);
      } finally {
        await reopened.close();
      }
    } finally {
      await env.close();
    }
  });

  it("pauses and resumes active processing, cancels queued work, and preserves committed material", async () => {
    const env = await fixture();
    try {
      const request = await env.seed();
      env.setParseHook(async (signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const submitted = await env.call("/api/tasks", {
        kind: "processing",
        request: {
          schema_version: 1,
          idempotency_key: "pause-parse",
          operations: [{ operation: "parse-documents", request }],
        },
      });
      const id = (submitted.value.task as { job_id: string }).job_id;
      await env.call(`/api/tasks/${id}/start`, {});
      await vi.waitFor(() => expect(env.parseCalls).toBe(1));
      expect(await env.call(`/api/tasks/${id}/pause`, {})).toMatchObject({
        status: 200,
        value: { task: { job: { status: "paused" } } },
      });
      env.setParseHook(async () => {});
      expect(await env.call(`/api/tasks/${id}/resume`, {})).toMatchObject({
        status: 200,
      });
      await vi.waitFor(async () =>
        expect((await env.server.application.jobs!.getJob(id))?.status).toBe(
          "completed",
        ),
      );
      const other = await env.call("/api/tasks", {
        kind: "processing",
        request: {
          schema_version: 1,
          idempotency_key: "cancel-parse",
          operations: [{ operation: "parse-documents", request }],
        },
      });
      const otherId = (other.value.task as { job_id: string }).job_id;
      expect(await env.call(`/api/tasks/${otherId}/cancel`, {})).toMatchObject({
        status: 200,
        value: { task: { job: { status: "cancelled" } } },
      });
      expect(await env.call(`/api/tasks/${otherId}/start`, {})).toMatchObject({
        status: 409,
        value: { code: "processing-terminal" },
      });
      expect(
        (await env.server.application.library.detail(request.literature_id))
          .primary_pdf?.asset.sha256,
      ).toBe(request.asset_sha256);
      expect(
        (
          await env.server.application.documentRead.default({
            literature_id: request.literature_id,
            asset_id: request.asset_id,
            asset_sha256: request.asset_sha256,
          })
        ).default,
      ).not.toBeNull();
    } finally {
      await env.close();
    }
  });

  it("drains interrupted discovery before closing its database", async () => {
    const env = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publications = vi.spyOn(
      env.server.application.database,
      "putDiscovery",
    );
    env.setDiscoveryHook(() => waiting);
    const request = env
      .call("/api/discovery", { query: "shutdown", scan_limit: 1 })
      .catch(() => undefined);
    try {
      await vi.waitFor(() => expect(env.discoveryCalls).toBe(1));
      let closed = false;
      const closing = env.server.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release();
      await closing;
      await request;
      expect(publications).toHaveBeenCalledWith(
        expect.objectContaining({
          run: expect.objectContaining({ status: "INTERRUPTED" }),
        }),
      );
      const recorded = publications.mock.calls[0]![0];
      const reopened = await startProductionWorkbench({
        home: env.home,
        assets: new Map([
          ["/", { contentType: "text/html", body: "Workbench" }],
        ]),
        applicationOptions: { browserHost: () => null, metadata: {} },
      });
      try {
        expect(
          (
            await reopened.application.database.getDiscovery(
              recorded.run.discovery_run_id,
            )
          )?.run.status,
        ).toBe("INTERRUPTED");
      } finally {
        await reopened.close();
      }
    } finally {
      release();
      await request;
      await env.close();
    }
  });

  it.each(["background-task", "legacy-run"])(
    "cancels active %s parsing on shutdown and retains a readable interrupted task",
    async (entry) => {
      const env = await fixture();
      let legacy: Promise<unknown> | undefined;
      try {
        const request = await env.seed();
        env.setParseHook(async (signal) => {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else
              signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
        });
        const submitted = await env.call("/api/tasks", {
          kind: "processing",
          request: {
            schema_version: 1,
            idempotency_key: "shutdown-parse",
            operations: [{ operation: "parse-documents", request }],
          },
        });
        const id = (submitted.value.task as { job_id: string }).job_id;
        if (entry === "background-task")
          await env.call(`/api/tasks/${id}/start`, {});
        else
          legacy = env.call(`/api/jobs/${id}/run`, {}).catch(() => undefined);
        await vi.waitFor(() => expect(env.parseCalls).toBe(1));
        await env.server.close();
        const reopened = await startProductionWorkbench({
          home: env.home,
          assets: new Map([
            ["/", { contentType: "text/html", body: "Workbench" }],
          ]),
          applicationOptions: { browserHost: () => null, metadata: {} },
        });
        try {
          expect(
            (await reopened.application.processingTasks!.read(id)).job.status,
          ).toBe("interrupted");
          expect(
            (await reopened.application.library.detail(request.literature_id))
              .primary_pdf?.asset.sha256,
          ).toBe(request.asset_sha256);
          expect(env.parseCalls).toBe(1);
        } finally {
          await reopened.close();
        }
      } finally {
        await env.close();
        await legacy;
      }
    },
  );

  it("refuses an absent database without creating or migrating it", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-empty-workbench-"));
    try {
      await expect(startProductionWorkbench({ home })).rejects.toMatchObject({
        code: "migration-target-missing",
      });
      await expect(
        readFile(join(home, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
