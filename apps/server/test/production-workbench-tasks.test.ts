import { citationLimitsSource } from "./citation-limits-fixture.js";
import { parseIntakeBatchId } from "@sciretriever/contracts";
import { SCHEMA_VERSION } from "../src/storage/sqlite/schema.js";
import { withRawParserFixture } from "./raw-parser-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
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
import { ProcessingTaskService } from "../src/application/jobs/processing.js";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import type {
  ExecutionJobStatus,
  ExecutionTarget,
} from "../src/storage/sqlite/worker.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

async function fixture(
  citationSource?: ReturnType<typeof citationLimitsSource>,
) {
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
    access: workbenchTestAccess,
    home,
    assets: new Map([
      ["/", { contentType: "text/html", body: "<main>Workbench</main>" }],
    ]),
    applicationOptions: {
      browserHost: () => null,
      metadata: {
        lookup_ports: [
          {
            provider_name: "crossref",
            open_lookup: () => ({
              pull_raw_item: async () => null,
              convert_raw_item: () => ({ observations: [], relations: [] }),
            }),
          },
        ],
        reference_query_ports: [
          {
            provider_name: "crossref",
            open_reference_query:
              citationSource?.port.open_reference_query ??
              (() => ({
                pull_raw_item: async () => null,
                convert_raw_item: () => ({ observations: [], relations: [] }),
              })),
          },
        ],
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
      parsing: withRawParserFixture({
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
      }),
    },
  });
  // Observe the actual HTTP-owned run. Joining it synchronously at admission
  // never starts a replacement run and avoids a one-second polling deadline
  // for artifact publication and durable task settlement under suite load.
  const settlements = new Map<
    string,
    ReturnType<ProcessingTaskService["runResults"]>
  >();
  const start = ProcessingTaskService.prototype.start;
  const started = vi
    .spyOn(ProcessingTaskService.prototype, "start")
    .mockImplementation(function (this: ProcessingTaskService, id: string) {
      const admitted = start.call(this, id);
      if (admitted) {
        const pending = this.runResults(id);
        settlements.set(id, pending);
        void pending.catch(() => undefined);
      }
      return admitted;
    });
  const authCookie = await workbenchLogin(server.origin);
  const index = await fetch(server.origin, { headers: { Cookie: authCookie } });
  const cookie = `${authCookie}; ${index.headers.get("set-cookie")!.split(";")[0]!}`;
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
    async settledTask(id: string) {
      expect(settlements.has(id)).toBe(true);
      await settlements.get(id)!;
    },
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
        profiles: ["pipeline", "vlm-engine"],
        force: false,
      };
    },
    async close() {
      try {
        await server.close();
      } finally {
        started.mockRestore();
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}

describe("production task workbench composition", () => {
  it("saves an unlimited citation request unchanged, runs it to exhaustion and reads nulls over HTTP", async () => {
    const source = citationLimitsSource();
    const env = await fixture(source);
    try {
      await env.server.application.database.putLiterature(FIXTURE_LITERATURE);
      const saved = await env.call("/api/tasks", {
        kind: "metadata",
        idempotency_key: "unlimited-citation",
        request: {
          kind: "citation",
          seed_literature_ids: [FIXTURE_LITERATURE.literature_id],
          direction: "references",
        },
      });
      expect(saved.status, JSON.stringify(saved.value)).toBe(201);
      const id = (saved.value.task as { job_id: string }).job_id;
      expect(source.stats.opens).toBe(0);
      const expected = {
        request: {
          operations: [
            {
              request: {
                max_depth: 1,
                result_limit: null,
                providers: [{ source: "crossref", scan_limit: null }],
              },
            },
          ],
        },
      };
      expect(await env.server.application.jobs!.getJob(id)).toMatchObject({
        selector: expected,
      });
      expect((await env.call(`/api/tasks/${id}`)).value).toMatchObject({
        task: { job: { selector: expected } },
      });
      expect((await env.call(`/api/tasks/${id}/start`, {})).status).toBe(202);
      await env.settledTask(id);
      const detail = await env.server.application.processingTasks!.read(id);
      expect(detail.job.status).toBe("completed");
      const payload = detail.results[0] as {
        result: { discovery_run_id: string; result_count: number };
      };
      expect(payload.result.result_count).toBe(source.count);
      expect(
        await env.server.application.database.getDiscovery(
          payload.result.discovery_run_id,
        ),
      ).toMatchObject({
        run: { result_limit: null },
        providers: [{ scan_limit: null }],
        source_results: [{ outcome: "EXHAUSTED" }],
      });
      expect(source.stats).toEqual({
        opens: 1,
        pulls: source.count + 1,
        exhausted: 1,
      });
    } finally {
      await env.close();
    }
  });

  it("saves metadata tasks with large safe budgets without running them and rejects invalid bounds", async () => {
    const env = await fixture();
    try {
      const id = FIXTURE_LITERATURE.literature_id;
      await env.server.application.database.putLiterature(FIXTURE_LITERATURE);
      const requests = [
        { kind: "topic", query: "synthetic", year_from: null, year_to: null },
        { kind: "lookup", literature_ids: [id] },
        {
          kind: "citation",
          seed_literature_ids: [id],
          direction: "both",
          max_depth: 1,
          result_limit: 50000,
        },
      ];
      for (const request of requests) {
        const response = await env.call("/api/tasks", {
          kind: "metadata",
          idempotency_key: `large-${request.kind}`,
          request: { ...request, scan_limit: 50000 },
        });
        expect(response.status, JSON.stringify(response.value)).toBe(201);
        const jobId = (response.value.task as { job_id: string }).job_id;
        expect(await env.server.application.jobs!.getJob(jobId)).toMatchObject({
          status: "queued",
          selector: {
            request: {
              operations: [
                {
                  request: {
                    ...request,
                    providers: [{ source: "crossref", scan_limit: 50000 }],
                  },
                },
              ],
            },
          },
        });
        for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(
            (
              await env.call("/api/tasks", {
                kind: "metadata",
                idempotency_key: `invalid-${request.kind}`,
                request: { ...request, scan_limit: limit },
              })
            ).status,
          ).toBe(400);
          if (request.kind === "citation")
            expect(
              (
                await env.call("/api/tasks", {
                  kind: "metadata",
                  idempotency_key: "invalid-citation-result",
                  request: {
                    ...request,
                    scan_limit: 50000,
                    result_limit: limit,
                  },
                })
              ).status,
            ).toBe(400);
        }
      }
      expect((await env.call("/api/tasks")).value.tasks).toHaveLength(3);
      expect(env.discoveryCalls).toBe(0);
      expect(env.parseCalls).toBe(0);
    } finally {
      await env.close();
    }
  });
  it("projects current target progress for every task status group and cursor page", async () => {
    const env = await fixture();
    const repository = env.server.application.jobs!;
    const cases: readonly {
      status: ExecutionJobStatus;
      dispositions: readonly ExecutionTarget["disposition"][];
      done: number;
    }[] = [
      { status: "queued", dispositions: ["pending", null], done: 0 },
      {
        status: "running",
        dispositions: [
          "completed",
          "failed",
          "skipped",
          "pending",
          "interrupted",
        ],
        done: 3,
      },
      { status: "paused", dispositions: ["completed", "pending"], done: 1 },
      { status: "interrupted", dispositions: ["interrupted"], done: 0 },
      {
        status: "completed",
        dispositions: ["completed", "completed"],
        done: 2,
      },
      { status: "cancelled", dispositions: [], done: 0 },
      { status: "failed", dispositions: ["failed", "skipped"], done: 2 },
    ];
    try {
      const expected = new Map<string, unknown>();
      for (const [index, item] of cases.entries()) {
        const jobId = `progress-${item.status}`;
        const job = await repository.createJob({
          job_id: jobId,
          target_kind: "selector",
          selector: { kind: "synthetic-progress" },
          policy_version: "progress-policy",
          policy: {},
          idempotency_key: jobId,
          created_at: new Date(
            Date.UTC(2026, 9, 23) + index * 1000,
          ).toISOString(),
          targets: item.dispositions.map((disposition, ordinal) => ({
            job_id: jobId,
            target_id: `${jobId}-${ordinal}`,
            ordinal,
            literature_id: null,
            version_role: null,
            stage:
              disposition === "pending" || disposition === null
                ? "queued"
                : disposition,
            disposition,
            next_eligible_at: null,
          })),
        });
        await repository.updateJob(jobId, item.status);
        expected.set(jobId, {
          ...job,
          scope: null,
          status: item.status,
          progress: { total: item.dispositions.length, done: item.done },
        });
      }
      const groups = {
        all: cases.map((item) => item.status),
        active: ["queued", "running"],
        attention: ["paused", "interrupted", "failed"],
        ended: ["completed", "cancelled", "failed"],
      };
      const run = vi.spyOn(env.server.application.database, "run");
      for (const [group, statuses] of Object.entries(groups)) {
        run.mockClear();
        const response = await env.call(
          `/api/tasks?limit=1000${group === "all" ? "" : `&status_group=${group}`}`,
        );
        expect(response.status).toBe(200);
        const tasks = response.value.tasks as { job_id: string }[];
        expect(tasks).toHaveLength(statuses.length);
        expect(tasks.map((task) => task.job_id).sort()).toEqual(
          statuses.map((status) => `progress-${status}`).sort(),
        );
        for (const task of tasks)
          expect(task).toEqual(expected.get(task.job_id));
        expect(run.mock.calls.map(([command]) => command.kind)).toEqual([
          "execution_list_jobs",
        ]);
      }
      run.mockClear();
      const first = await env.call("/api/tasks?limit=1&status_group=active");
      expect(first.value).toMatchObject({
        tasks: [
          { job_id: "progress-running", progress: { total: 5, done: 3 } },
        ],
        next_cursor: expect.any(String),
      });
      expect(run.mock.calls.map(([command]) => command.kind)).toEqual([
        "execution_list_jobs",
        "execution_list_jobs",
      ]);
      const second = await env.call(
        `/api/tasks?limit=1&status_group=active&cursor=${String(first.value.next_cursor)}`,
      );
      expect(second.value).toMatchObject({
        tasks: [{ job_id: "progress-queued", progress: { total: 2, done: 0 } }],
        next_cursor: null,
      });
      expect(env.parseCalls).toBe(0);
      expect(env.discoveryCalls).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("validates workspace deep links and adapts explicit citation discovery to its existing owner", async () => {
    const env = await fixture();
    try {
      const valid = new URL(env.server.origin);
      valid.searchParams.set("view", "lib");
      valid.searchParams.set("reader", "doc");
      valid.searchParams.set("query", JSON.stringify({ text: "synthetic" }));
      valid.searchParams.set("task", "task-1");
      expect(
        (await fetch(valid, { headers: { Cookie: env.cookie } })).status,
      ).toBe(200);
      for (const suffix of [
        "?view=unknown",
        "?reader=invalid",
        "?query=%7Bbroken",
        "?view=lib&view=set",
        "?query=%7B%22unknown%22:1%7D",
      ])
        expect(
          (
            await fetch(`${env.server.origin}/${suffix}`, {
              headers: { Cookie: env.cookie },
            })
          ).status,
        ).toBe(400);
      const run = vi
        .spyOn(env.server.application.citations, "run")
        .mockResolvedValue({
          intake_batch_id: parseIntakeBatchId(randomUUID()),
          discovery_run_id: randomUUID(),
          status: "COMPLETED",
          result_count: 0,
          source_results: [],
        });
      const request = {
        kind: "citation",
        seed_literature_id: FIXTURE_LITERATURE.literature_id,
        direction: "references",
        scan_limit: 50000,
      };
      expect(
        (await env.call("/api/discovery", { ...request, direction: "invalid" }))
          .status,
      ).toBe(400);
      expect(run).not.toHaveBeenCalled();
      const response = await env.call("/api/discovery", request);
      expect(response.status).toBe(200);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          seed_literature_ids: [FIXTURE_LITERATURE.literature_id],
          direction: "references",
          max_depth: 1,
          result_limit: null,
          providers: expect.arrayContaining([
            expect.objectContaining({ scan_limit: 50000 }),
          ]),
        }),
      );
      const explicit = await env.call("/api/discovery", {
        ...request,
        max_depth: 2,
        result_limit: 7,
      });
      expect(explicit.status).toBe(200);
      expect(run).toHaveBeenLastCalledWith(
        expect.objectContaining({
          max_depth: 2,
          result_limit: 7,
          providers: expect.arrayContaining([
            expect.objectContaining({ scan_limit: 50000 }),
          ]),
        }),
      );
      expect(env.discoveryCalls).toBe(0);
      run.mockRestore();
    } finally {
      await env.close();
    }
  });

  it("starts without a literature, binds the configured database, shares authenticated reader routes and imports metadata", async () => {
    const env = await fixture();
    try {
      expect(parseWorkbenchView(env.grant.view).article_id).toBeNull();
      for (const key of ["document", "knowledge", "artifact"])
        expect(
          (
            await fetch(
              `${env.server.origin}/?view=lib&task=job-1&literature=${FIXTURE_LITERATURE.literature_id}&${key}=${randomUUID()}`,
              { headers: { Cookie: env.cookie } },
            )
          ).status,
        ).toBe(200);
      expect(
        (
          await fetch(`${env.server.origin}/?view=task`, {
            headers: { Cookie: env.cookie },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${env.server.origin}/?view=unknown`, {
            headers: { Cookie: env.cookie },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${env.server.origin}/?view=lib&knowledge=%3Cscript%3E`, {
            headers: { Cookie: env.cookie },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${env.server.origin}/?document=one&document=two`, {
            headers: { Cookie: env.cookie },
          })
        ).status,
      ).toBe(400);
      for (const key of [
        "workspace",
        "q",
        "job",
        "synthesis",
        "task_filter",
        "advanced",
      ])
        expect(
          (
            await fetch(`${env.server.origin}/?${key}=retired`, {
              headers: { Cookie: env.cookie },
            })
          ).status,
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
            schema_version: SCHEMA_VERSION,
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
        await env.call("/api/discovery", {
          query: "synthetic",
          scan_limit: 50000,
        }),
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

  it("executes PDF and processing tasks through the durable runtime and reads the committed raw parses without creating a document", async () => {
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
      await env.settledTask(id);
      expect((await env.server.application.jobs!.getJob(id))?.status).toBe(
        "completed",
      );
      expect(env.parseCalls).toBe(2);
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
          result: { default: null },
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
        access: workbenchTestAccess,
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
        expect(env.parseCalls).toBe(2);
      } finally {
        await reopened.close();
      }
    } finally {
      await env.close();
    }
  }, 0);

  // Reached 2.3 s under Full (36/12) load, too close to the 5 s default.
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
      await vi.waitFor(() => expect(env.parseCalls).toBe(2));
      expect(await env.call(`/api/tasks/${id}/pause`, {})).toMatchObject({
        status: 200,
        value: { task: { job: { status: "paused" } } },
      });
      env.setParseHook(async () => {});
      expect(await env.call(`/api/tasks/${id}/resume`, {})).toMatchObject({
        status: 200,
      });
      await env.settledTask(id);
      expect((await env.server.application.jobs!.getJob(id))?.status).toBe(
        "completed",
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
      ).toBeNull();
      expect(
        (
          await env.server.application.rawParseStorage!.current(
            request.asset_id,
          )
        ).filter((s) => s.result),
      ).toHaveLength(2);
    } finally {
      await env.close();
    }
  }, 30_000);

  // Reached 2.1 s under Full (36/12) load, too close to the 5 s default.
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
        access: workbenchTestAccess,
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
  }, 30_000);

  // Reached 2.9 s under Full (36/12) load, too close to the 5 s default.
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
        await vi.waitFor(() => expect(env.parseCalls).toBe(2));
        await env.server.close();
        const reopened = await startProductionWorkbench({
          access: workbenchTestAccess,
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
          expect(env.parseCalls).toBe(2);
        } finally {
          await reopened.close();
        }
      } finally {
        await env.close();
        await legacy;
      }
    },
    30_000,
  );

  it("starts an empty home with the default library without opening Browser", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-empty-workbench-"));
    const browserHost = vi.fn(() => null);
    let server:
      | Awaited<ReturnType<typeof startProductionWorkbench>>
      | undefined;
    try {
      server = await startProductionWorkbench({
        access: workbenchTestAccess,
        home,
        port: 0,
        assets: new Map([["/", { contentType: "text/html", body: "ok" }]]),
        applicationOptions: { browserHost, metadata: {} },
      });
      expect(server.application.configuration.paths).toEqual({
        catalog_path: join(home, ".sciretriever", "catalog.sqlite"),
        artifact_root: join(home, ".sciretriever", "artifacts"),
      });
      expect(server.application.processingTasks).not.toBeNull();
      expect(server.application.processors).not.toBeNull();
      expect(browserHost).not.toHaveBeenCalled();
      expect((await fetch(server.origin, { redirect: "manual" })).status).toBe(
        303,
      );
      const authCookie = await workbenchLogin(server.origin);
      expect(
        (await fetch(server.origin, { headers: { Cookie: authCookie } }))
          .status,
      ).toBe(200);
      await expect(
        readFile(join(home, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
