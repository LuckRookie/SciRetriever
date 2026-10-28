import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { safeLocator } from "../src/acquisition/sources/locators.js";
import { networkRequestDispatched } from "../src/network/request-activity.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import { parseTaskDetail } from "../../web/src/app/data/tasks.js";
import {
  parseConfigurationReadiness,
  parseTaskSourceResults,
} from "@sciretriever/contracts";

it("persists per-article attempts and reads the same safe projection through HTTP, CLI and MCP", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-acquire-trace-"));
  await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
  await writeFile(
    join(home, ".sciretriever", "config.toml"),
    '[sources.acquisition]\nmode="custom"\nproviders=["wiley"]\n',
    { mode: 0o600 },
  );
  await initializeCatalogSchema(join(home, ".sciretriever", "catalog.sqlite"));
  const server = await startProductionWorkbench({
    home,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "Synthetic" }]]),
    applicationOptions: {
      browserHost: () => null,
      acquisitionAssembly: {
        doiLandingSource: {
          source_name: "doi-landing",
          ready: true,
          acquisition_stage: "public-web",
          discover: async () => [
            safeLocator(
              "doi-landing",
              "https://fixture.example/pdf?download=synthetic-private",
            ),
          ],
          download_candidate: async () => {
            networkRequestDispatched();
            return {
              kind: "download",
              bytes: workbenchPdf(),
              media_type: "application/pdf",
              safe_source_url: "https://fixture.example/pdf",
              entitlement: "granted",
              locator: {
                namespace: "doi",
                value: "10.5555/fixture",
                declared_media_type: "application/pdf",
                source_record_id: "fixture",
              },
            };
          },
        },
      },
    },
  });
  const host = createMcpServer({
    home,
    queryFactory: () => createQueryApplication(home),
  });
  const [transport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-trace", version: "1" });
  try {
    await host.connect(transport);
    await client.connect(clientTransport);
    const auth = await workbenchLogin(server.origin);
    const index = await fetch(server.origin, { headers: { Cookie: auth } });
    const cookie =
      auth +
      "; " +
      index.headers
        .getSetCookie()
        .map((x) => x.split(";")[0])
        .join("; ");
    const init = await fetch(server.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        "X-Workbench-Init": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const grant = (await init.json()) as { client_id: string; csrf: string };
    const read = async (path: string) => {
      const response = await fetch(
        server.origin + path + "?client_id=" + grant.client_id,
        {
          headers: {
            Cookie: cookie,
            Origin: server.origin,
            "X-Workbench-Csrf": grant.csrf,
          },
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    await server.application.database.putLiterature(FIXTURE_LITERATURE);
    const job = await server.application.jobService!.create({
      target_kind: "selector",
      selector: {
        kind: "literatures",
        literature_ids: [FIXTURE_LITERATURE.literature_id],
      },
      goal: "pdf",
      policy_version: "fixture",
      policy: { mode: "never", max_retries: 0 },
      idempotency_key: "trace-fixture",
    });
    await server.application.taskService!.runJob(job.job_id);
    const initial = await read("/api/tasks/" + job.job_id);
    const sourceResults = parseTaskSourceResults(
      (initial as { task: { source_results: unknown } }).task.source_results,
    );
    expect(sourceResults.pdf).toMatchObject({
      documents: 1,
      obtained: 1,
      not_obtained: 0,
      unknown: 0,
    });
    expect(
      sourceResults.pdf!.sources.find((s) => s.source === "doi-landing"),
    ).toMatchObject({ attempted: 1, obtained: 1, requests: 1 });
    expect(
      sourceResults.pdf!.sources.find((s) => s.source === "wiley"),
    ).toMatchObject({
      attempted: 0,
      obtained: 0,
      problems: [{ display: "not-configured" }],
    });
    expect(sourceResults.pdf!.sources.reduce((n, s) => n + s.obtained, 0)).toBe(
      1,
    );
    const first = parseTaskDetail(initial);
    const trace = first.acquisition_traces![0]!;
    expect(trace.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "wiley",
          result: "unavailable",
          requested: false,
          problem: {
            display: "not-configured",
            technical_details: {
              diagnostics: [{ code: "missing-credential", scope: "pdf" }],
            },
          },
          technical_details: {
            diagnostics: [{ code: "missing-credential", scope: "pdf" }],
          },
        }),
        expect.objectContaining({
          source: "elsevier",
          result: "not-enabled",
          requested: false,
        }),
        expect.objectContaining({
          source: "doi-landing",
          result: "hit",
          requested: true,
        }),
      ]),
    );
    expect(trace.attempts.some((a) => a.result === "escalated")).toBe(false);
    expect(trace.literature_id).toBe(FIXTURE_LITERATURE.literature_id);
    expect(first.job.status).toBe("completed");
    // An unrelated technical-event tail must not hide already persisted source evidence.
    await Promise.all(
      Array.from({ length: 1001 }, (_, n) =>
        server.application.jobs!.appendEvent({
          event_id: `fixture-${n}`,
          job_id: job.job_id,
          sequence: -1,
          kind: "fixture-progress",
          payload: { n },
          created_at: new Date().toISOString(),
        }),
      ),
    );
    const http = parseTaskDetail(await read("/api/tasks/" + job.job_id));
    expect(http.events_truncated).toBe(true);
    expect(http.acquisition_traces).toEqual(first.acquisition_traces);
    expect(http.acquisition_traces_truncated).toBe(false);
    const cli = await runCli(["jobs", "inspect", "--request", "-", "--json"], {
      home,
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify({ job_id: job.job_id }));
      })(),
    });
    expect(cli.code).toBe(0);
    expect(
      parseTaskSourceResults(
        (cli.value as { result: { source_results: unknown } }).result
          .source_results,
      ),
    ).toEqual(sourceResults);
    expect(
      (cli.value as { result: { acquisition_traces: unknown } }).result
        .acquisition_traces,
    ).toEqual(first.acquisition_traces);
    for (const name of ["read_task", "inspect_task"]) {
      const response = await client.callTool({
        name,
        arguments: { job_id: job.job_id },
      });
      expect(response.isError).not.toBe(true);
      const result = (
        response.structuredContent as {
          result: { acquisition_traces: unknown };
        }
      ).result;
      expect(
        parseTaskSourceResults(
          (result as { acquisition_traces: unknown; source_results?: unknown })
            .source_results,
        ),
      ).toEqual(sourceResults);
      expect(result.acquisition_traces).toEqual(first.acquisition_traces);
    }
    expect(JSON.stringify(first.acquisition_traces)).not.toMatch(
      /https|synthetic-private|token|headers/,
    );
    const state = (await read("/api/configuration/status")) as {
      status: unknown;
    };
    expect(
      parseConfigurationReadiness(
        state.status,
      ).acquisition_routes?.effective?.map((r) => r.source),
    ).toEqual(["direct", "wiley", "doi-landing"]);
    const configCli = await runCli(["config", "status", "--json"], { home });
    expect(
      parseConfigurationReadiness(configCli.value).acquisition_routes
        ?.effective,
    ).toBeNull();
    const configMcp = await client.callTool({
      name: "configuration_status",
      arguments: {},
    });
    const config = (configMcp.structuredContent as { result: unknown }).result;
    expect(parseConfigurationReadiness(config).acquisition_routes).toEqual(
      parseConfigurationReadiness(configCli.value).acquisition_routes,
    );
  } finally {
    await client.close();
    await host.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
