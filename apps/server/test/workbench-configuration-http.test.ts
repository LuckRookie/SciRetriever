import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import {
  describeWorkbenchRuntime,
  startProductionWorkbench,
} from "../src/bootstrap/workbench.js";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { parseAcquisitionRouteState } from "@sciretriever/contracts";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { ConfigurationProbeSession } from "../src/configuration/owner.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { WorkbenchSession } from "../src/workbench/session.js";

function exchange(
  origin: string,
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string> = {},
  body?: string,
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      origin + path,
      { method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function fixtureSession(): WorkbenchSession {
  return new WorkbenchSession(
    "configuration-fixture",
    {
      id: "configuration-page",
      title: async () => "Configuration fixture",
      url: () => "http://127.0.0.1/configuration-fixture",
      navigate: async () => undefined,
      close: async () => undefined,
      snapshot: async () => ({
        url: "http://127.0.0.1/configuration-fixture",
        title: "Configuration fixture",
        document_generation: 1,
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot: null,
      }),
      apply: async () => undefined,
    },
    {
      max_actions: 2,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 1024,
      deadline_ms: 10_000,
    },
  );
}

describe("workbench configuration HTTP boundary", () => {
  it("keeps reads and committed publications independent of status refresh failures while preserving routes", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-status-isolation-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    await initializeCatalogSchema(
      join(home, ".sciretriever", "catalog.sqlite"),
    );
    const initial = await owner.read();
    await owner.publishConfiguration(initial.configuration, initial.revision, [
      "sources",
    ]);
    const server = await startProductionWorkbench({
      home,
      access: workbenchTestAccess,
      assets: new Map([["/", { contentType: "text/html", body: "Synthetic" }]]),
      applicationOptions: {
        configurationOwner: owner,
        browserHost: () => null,
      },
    });
    const originalStatus = server.application.configurationStatus.bind(
      server.application,
    );
    const status = vi.spyOn(server.application, "configurationStatus");
    try {
      const auth = await workbenchLogin(server.origin);
      const root = await exchange(server.origin, "/", "GET", { Cookie: auth });
      const cookie = `${auth}; ${(root.headers["set-cookie"] as string[])[0]!.split(";")[0]!}`;
      const init = await exchange(
        server.origin,
        "/api/clients",
        "POST",
        {
          Cookie: cookie,
          Origin: server.origin,
          "Content-Type": "application/json",
          "X-Workbench-Init": "1",
        },
        "{}",
      );
      const grant = JSON.parse(init.text) as {
        client_id: string;
        csrf: string;
      };
      const headers = {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Csrf": grant.csrf,
      };
      const request = (path: string, method: "GET" | "POST", body?: unknown) =>
        exchange(
          server.origin,
          `/api/configuration/${path}?client_id=${grant.client_id}`,
          method,
          headers,
          body === undefined ? undefined : JSON.stringify(body),
        );
      const checkRefresh = async () => {
        expect(status).not.toHaveBeenCalled();
        // The fault belongs to the explicit refresh, not the completed publication.
        const failed = await request("status", "GET");
        expect(failed.status).toBe(409);
        expect(JSON.parse(failed.text)).toEqual({ code: "command-rejected" });
        const refreshed = await request("status", "POST", {});
        expect(refreshed.status).toBe(200);
        expect(status).toHaveBeenCalledTimes(2);
        return parseAcquisitionRouteState(
          JSON.parse(refreshed.text).status.acquisition_routes,
        );
      };
      const armRefreshFailure = () => {
        status.mockClear();
        status.mockRejectedValueOnce(new Error("synthetic readiness failure"));
      };
      for (const method of ["GET", "POST"] as const) {
        armRefreshFailure();
        const read = await request(
          "read",
          method,
          method === "POST" ? {} : undefined,
        );
        expect(read.status).toBe(200);
        const routes = parseAcquisitionRouteState(
          JSON.parse(read.text).acquisition_routes,
        );
        expect(routes.effective).not.toBeNull();
        expect(routes).toEqual(await checkRefresh());
      }
      // Credential publication already returns status: the HTTP layer must reuse it.
      status.mockClear();
      status.mockImplementationOnce(originalStatus);
      status.mockRejectedValueOnce(new Error("synthetic readiness failure"));
      const current = await owner.read();
      const credential = await request("credential", "POST", {
        edit: {
          namespace: "source",
          target: "wiley",
          kind: "set",
          fields: { tdm_api_token: "synthetic-status-isolation" },
        },
        baseline: current.revision,
      });
      expect(credential.status).toBe(200);
      expect(status).toHaveBeenCalledTimes(1);
      const result = JSON.parse(credential.text);
      const routes = parseAcquisitionRouteState(result.acquisition_routes);
      expect(routes).toEqual(result.status.acquisition_routes);
      expect(routes.pending.find((r) => r.source === "wiley")).toMatchObject({
        mode_reason: "auto-configured",
        ready: true,
      });
      expect(routes.effective?.some((r) => r.source === "wiley")).toBe(false);
      expect(result).toMatchObject({
        ordinary_configuration_restart_required: false,
        application_restart_required: true,
        application_restart_reason: "capability-reassembly",
      });
      expect(credential.text).not.toContain("synthetic-status-isolation");
      expect((await request("status", "GET")).status).toBe(409);
      expect((await request("status", "GET")).status).toBe(200);
      for (const path of ["publish", "publish-json"] as const) {
        const current = await owner.read();
        const mode = path === "publish" ? "custom" : "auto";
        const configuration = {
          ...current.configuration,
          sources: {
            ...current.configuration.sources,
            acquisition: {
              ...current.configuration.sources.acquisition,
              mode,
              providers: [],
            },
          },
        };
        armRefreshFailure();
        const published = await request(path, "POST", {
          ...(path === "publish"
            ? {
                payload: '[sources.acquisition]\nmode="custom"\nproviders=[]\n',
              }
            : { configuration }),
          baseline: current.revision,
          sections: ["sources"],
        });
        expect(published.status).toBe(200);
        const result = JSON.parse(published.text);
        const saved = await owner.read();
        expect(result.snapshot).toEqual(saved);
        expect(saved.configuration.sources.acquisition.mode).toBe(mode);
        const routes = parseAcquisitionRouteState(result.acquisition_routes);
        expect(routes.pending.some((r) => r.source === "arxiv")).toBe(
          mode === "auto",
        );
        expect(routes).toEqual(await checkRefresh());
      }
    } finally {
      status.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);

  it("supports local reads and rejects malformed JSON, owners, sections and projections", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-config-http-"));
    const owner = new TypeScriptConfigurationOwner(home);
    const session = fixtureSession();
    await session.refresh();
    const probe = vi.fn(async () => ({
      owner: "parse" as const,
      target: null,
      outcome: "passed" as const,
      method: "GET",
      endpoint: "http://127.0.0.1:1/health",
      provider: null,
      model: null,
      checks: ["synthetic-health"],
      reason: "probe-passed",
      action: "none",
      network_performed: true,
      browser_launched: false,
      authentication: "not-attempted" as const,
      article_entitlement: "not-proven" as const,
      persisted: false as const,
      limitations: [],
      results: [],
      execution: {
        owner: "parse" as const,
        target: null,
        code: "probe-passed",
        elapsed_ms: 1,
        next_action: "none",
        network: "may-have-run" as const,
        may_consume_quota: false,
      },
    }));
    const server = await startWorkbenchHttp({
      access: workbenchTestAccess,
      session,
      configuration: {
        runtime_revision: "missing",
        status: (signal) => owner.status(signal),
        read: (signal) => owner.read(signal),
        credential: (edit, baseline, signal) =>
          owner.credential(edit, baseline, signal),
        publishConfiguration: (configuration, baseline, sections, signal) =>
          owner.publishConfiguration(configuration, baseline, sections, signal),
        probe,
      },
      assets: new Map([
        ["/", { contentType: "text/html", body: "<html></html>" }],
      ]),
    });
    try {
      const authCookie = await workbenchLogin(server.origin);
      const root = await exchange(server.origin, "/", "GET", {
        Cookie: authCookie,
      });
      const cookie = `${authCookie}; ${(root.headers["set-cookie"] as string[])[0]!.split(";")[0]!}`;
      const init = await exchange(
        server.origin,
        "/api/clients",
        "POST",
        {
          Cookie: cookie,
          Origin: server.origin,
          "Content-Type": "application/json",
          "X-Workbench-Init": "1",
        },
        "{}",
      );
      const grant = JSON.parse(init.text) as {
        client_id: string;
        csrf: string;
      };
      const query = `?client_id=${grant.client_id}`;
      const commandHeaders = {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Csrf": grant.csrf,
      };
      const read = await exchange(
        server.origin,
        `/api/configuration/read${query}`,
        "GET",
        { Cookie: cookie },
      );
      expect(read.status).toBe(200);
      expect(JSON.parse(read.text)).toMatchObject({
        runtime_configuration_current: true,
        ordinary_configuration_restart_required: false,
        application_restart_required: null,
        runtime_capabilities: null,
      });
      const snapshot = (
        JSON.parse(read.text) as { snapshot: Record<string, unknown> }
      ).snapshot;
      expect(snapshot.revision).toBe("missing");
      expect(
        (
          await exchange(
            server.origin,
            `/api/configuration/status${query}`,
            "GET",
            { Cookie: cookie },
          )
        ).status,
      ).toBe(200);

      const malformed = await exchange(
        server.origin,
        `/api/configuration/probe${query}`,
        "POST",
        commandHeaders,
        "{",
      );
      expect(malformed.status).toBe(400);
      expect(JSON.parse(malformed.text)).toEqual({ code: "invalid-command" });
      const unknownOwner = await exchange(
        server.origin,
        `/api/configuration/probe${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({ owner: "everything", target: null, image: false }),
      );
      expect(unknownOwner.status).toBe(400);
      expect(probe).not.toHaveBeenCalled();

      const unknownSection = await exchange(
        server.origin,
        `/api/configuration/publish-json${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({
          configuration: snapshot.configuration,
          baseline: "missing",
          sections: ["unknown"],
        }),
      );
      expect(unknownSection.status).toBe(400);
      const malformedProjection = await exchange(
        server.origin,
        `/api/configuration/publish-json${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({
          configuration: {},
          baseline: "missing",
          sections: ["browser"],
        }),
      );
      expect(malformedProjection.status).toBe(400);
      expect(JSON.parse(malformedProjection.text)).toEqual({
        code: "invalid-command",
      });

      const configuration = structuredClone(snapshot.configuration) as Record<
        string,
        unknown
      >;
      (configuration.browser as Record<string, unknown>).profile =
        "http-fixture";
      const published = await exchange(
        server.origin,
        `/api/configuration/publish-json${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({
          configuration,
          baseline: "missing",
          sections: ["browser"],
        }),
      );
      expect(published.status).toBe(200);
      expect(JSON.parse(published.text)).toMatchObject({
        runtime_configuration_current: false,
        application_restart_required: true,
        application_restart_reason: "ordinary-configuration",
      });
      const conflict = await exchange(
        server.origin,
        `/api/configuration/publish-json${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({
          configuration,
          baseline: "missing",
          sections: ["browser"],
        }),
      );
      expect(conflict.status).toBe(409);
      expect(JSON.parse(conflict.text)).toEqual({
        code: "configuration-conflict",
      });

      const credentialBaseline = await owner.read();
      const credential = await exchange(
        server.origin,
        `/api/configuration/credential${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({
          edit: {
            namespace: "source",
            target: "core",
            kind: "set",
            fields: { api_key: "synthetic-core-token" },
          },
          baseline: credentialBaseline.revision,
        }),
      );
      expect(credential.status).toBe(200);
      expect(JSON.parse(credential.text)).toMatchObject({
        credential_effective_at: "next-external-request",
        runtime_configuration_current: false,
        application_restart_required: true,
        application_restart_reason: "ordinary-configuration",
        runtime_capabilities: null,
      });
      expect(credential.text).not.toContain("synthetic-core-token");

      const beforeProbe = await readFile(
        join(home, ".sciretriever/config.toml"),
        "utf8",
      );
      const probed = await exchange(
        server.origin,
        `/api/configuration/probe${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({ owner: "parse", target: null, image: false }),
      );
      expect(probed.status).toBe(200);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(
        await readFile(join(home, ".sciretriever/config.toml"), "utf8"),
      ).toBe(beforeProbe);
      await expect(
        readFile(join(home, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await session.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a startup-missing MinerU parser after credentials and Probe are ready until Application restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-parser-restart-"));
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    let restarted: Awaited<ReturnType<typeof createApplication>> | undefined;
    let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
    const session = fixtureSession();
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const published = await owner.publish(
        '[parsing]\nbase_url = "https://parser.example.test"\nconnection_mode = "remote"\nmodel_identity = "synthetic-parser"\nremote_upload_authorized = true\n',
        "missing",
        ["parsing"],
      );
      await session.refresh();
      application = await createApplication(home, {
        configurationOwner: owner,

        mineruTransportFactory: () => ({
          request: async () => {
            throw new Error("parser request must stay offline");
          },
        }),
      });
      expect(application.rawParsing).toBeNull();
      const runtimeCapabilities = describeWorkbenchRuntime(application);
      expect(runtimeCapabilities.parsing).toEqual({
        assembled: false,
        unavailable_reason: "startup-credential-missing",
      });
      server = await startWorkbenchHttp({
        access: workbenchTestAccess,
        session,
        configuration: {
          runtime_revision: application.configuration_revision,
          runtime_capabilities: runtimeCapabilities,
          status: (signal) => owner.status(signal),
          read: (signal) => owner.read(signal),
          credential: (edit, baseline, signal) =>
            owner.credential(edit, baseline, signal),
          probe: async (request, signal) => {
            const probe = await ConfigurationProbeSession.create(owner, {
              browser_site_factory: async () => null,
              parser_health: {
                endpoint: "https://parser.example.test/health",
                origin: "https://parser.example.test",
                health: async () => ({
                  status: "healthy",
                  version: "3.4.4",
                  protocol_version: 2,
                  profile: null,
                }),
              },
            });
            try {
              return await probe.run(request, {
                authorized: true,
                ...(signal ? { signal } : {}),
              });
            } finally {
              probe.close();
            }
          },
        },
        assets: new Map([
          ["/", { contentType: "text/html", body: "<html></html>" }],
        ]),
      });

      const authCookie = await workbenchLogin(server.origin);
      const root = await exchange(server.origin, "/", "GET", {
        Cookie: authCookie,
      });
      const cookie = `${authCookie}; ${(root.headers["set-cookie"] as string[])[0]!.split(";")[0]!}`;
      const init = await exchange(
        server.origin,
        "/api/clients",
        "POST",
        {
          Cookie: cookie,
          Origin: server.origin,
          "Content-Type": "application/json",
          "X-Workbench-Init": "1",
        },
        "{}",
      );
      const grant = JSON.parse(init.text) as {
        client_id: string;
        csrf: string;
      };
      const query = `?client_id=${grant.client_id}`;
      const commandHeaders = {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Csrf": grant.csrf,
      };
      const credential = await exchange(
        server.origin,
        `/api/configuration/credential${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({
          edit: {
            namespace: "mineru",
            target: "mineru",
            kind: "set",
            value: "synthetic-mineru-token",
          },
          baseline: published.revision,
        }),
      );
      expect(credential.status).toBe(200);
      expect(JSON.parse(credential.text)).toMatchObject({
        runtime_configuration_current: true,
        ordinary_configuration_restart_required: false,
        application_restart_required: true,
        application_restart_reason: "capability-reassembly",
        runtime_capabilities: {
          parsing: {
            assembled: false,
            unavailable_reason: "startup-credential-missing",
          },
        },
      });
      const probeResponse = await exchange(
        server.origin,
        `/api/configuration/probe${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({ owner: "parse", target: null, image: false }),
      );
      expect(JSON.parse(probeResponse.text)).toMatchObject({
        result: { outcome: "passed", reason: null },
      });
      expect(application.rawParsing).toBeNull();
      await server.close();
      server = undefined;
      await application.close();
      application = undefined;

      restarted = await createApplication(home, {
        configurationOwner: owner,

        mineruTransportFactory: () => ({
          request: async () => {
            throw new Error("parser request must stay offline");
          },
        }),
      });
      expect(restarted.rawParsing).not.toBeNull();
      expect(describeWorkbenchRuntime(restarted).parsing).toEqual({
        assembled: true,
        unavailable_reason: null,
      });
    } finally {
      try {
        await server?.close();
        await session.close();
        await application?.close();
        await restarted?.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  it("reports a selected source that lacked its startup credential until reassembly", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-source-restart-"));
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    const session = fixtureSession();
    let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
    try {
      const owner = new TypeScriptConfigurationOwner(home);
      const published = await owner.publish(
        '[sources.acquisition]\nmode = "custom"\nproviders = ["core"]\n',
        "missing",
        ["sources"],
      );
      await session.refresh();
      application = await createApplication(home, {
        configurationOwner: owner,
      });
      const runtimeCapabilities = describeWorkbenchRuntime(application);
      expect(runtimeCapabilities.acquisition).toContainEqual({
        source_name: "core",
        selected: true,
        assembled: false,
        ready_at_startup: false,
        failure_code: "missing-credential",
      });
      expect(runtimeCapabilities.acquisition).toContainEqual({
        source_name: "direct",
        selected: false,
        assembled: true,
        ready_at_startup: true,
        failure_code: null,
      });
      server = await startWorkbenchHttp({
        access: workbenchTestAccess,
        session,
        configuration: {
          runtime_revision: application.configuration_revision,
          runtime_capabilities: runtimeCapabilities,
          status: (signal) => owner.status(signal),
          read: (signal) => owner.read(signal),
          credential: (edit, baseline, signal) =>
            owner.credential(edit, baseline, signal),
        },
        assets: new Map([
          ["/", { contentType: "text/html", body: "<html></html>" }],
        ]),
      });
      const authCookie = await workbenchLogin(server.origin);
      const root = await exchange(server.origin, "/", "GET", {
        Cookie: authCookie,
      });
      const cookie = `${authCookie}; ${(root.headers["set-cookie"] as string[])[0]!.split(";")[0]!}`;
      const init = await exchange(
        server.origin,
        "/api/clients",
        "POST",
        {
          Cookie: cookie,
          Origin: server.origin,
          "Content-Type": "application/json",
          "X-Workbench-Init": "1",
        },
        "{}",
      );
      const grant = JSON.parse(init.text) as {
        client_id: string;
        csrf: string;
      };
      const query = `?client_id=${grant.client_id}`;
      const commandHeaders = {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Csrf": grant.csrf,
      };
      const initial = await exchange(
        server.origin,
        `/api/configuration/read${query}`,
        "GET",
        { Cookie: cookie },
      );
      expect(JSON.parse(initial.text)).toMatchObject({
        runtime_configuration_current: true,
        ordinary_configuration_restart_required: false,
        application_restart_required: true,
        application_restart_reason: "capability-reassembly",
      });
      const credential = await exchange(
        server.origin,
        `/api/configuration/credential${query}`,
        "POST",
        commandHeaders,
        JSON.stringify({
          edit: {
            namespace: "source",
            target: "core",
            kind: "set",
            fields: { api_key: "synthetic-core-token" },
          },
          baseline: published.revision,
        }),
      );
      expect(credential.status).toBe(200);
      expect(JSON.parse(credential.text)).toMatchObject({
        credential_effective_at: "next-external-request",
        runtime_configuration_current: true,
        ordinary_configuration_restart_required: false,
        application_restart_required: true,
        application_restart_reason: "capability-reassembly",
        runtime_capabilities: {
          acquisition: expect.arrayContaining([
            {
              source_name: "core",
              selected: true,
              assembled: false,
              ready_at_startup: false,
              failure_code: "missing-credential",
            },
          ]),
        },
      });
      expect(credential.text).not.toContain("synthetic-core-token");
    } finally {
      try {
        await server?.close();
        await session.close();
        await application?.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });
});
