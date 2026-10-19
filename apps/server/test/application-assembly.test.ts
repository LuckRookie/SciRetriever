import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  parseAsset,
  parseLibraryQuery,
  parseLiterature,
  parseLiteratureId,
  parseMetadataObservation,
  sha256,
  type DurableCandidate,
  type LiteratureId,
  type VersionRole,
} from "@sciretriever/contracts";

import { createApplication } from "../src/bootstrap/application.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import { BROWSER_ROUTE_NAME } from "../src/acquisition/assembly.js";
import {
  AcquisitionRouteError,
  AcquisitionUnavailableError,
} from "../src/acquisition/tiered.js";
import { PublicAcquisitionRegistry } from "../src/acquisition/sources/public.js";
import { BrowserCandidateIntake } from "../src/acquisition/browser-intake.js";
import {
  DatabaseCompletionService,
  DatabaseCompletionTargetRunner,
} from "../src/entry/database-completion.js";
import { EntryPdfAcquisitionService } from "../src/entry/pdf-acquisition.js";
import { CloakRuntimeError } from "../src/configuration/cloak-runtime.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import type { ParserBackend } from "../src/parsing/ports.js";
import {
  FIXTURE_DOI,
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const execFileAsync = promisify(execFile);

const browserFixtureId = (n: number): LiteratureId =>
  parseLiteratureId(`00000000-0000-0000-0000-${String(n).padStart(12, "0")}`);

/**
 * A synthetic Literature with no identifier and no asset hint: every locator route
 * finds nothing, so a completion run stays fully offline and reaches its own normal
 * end instead of attempting an external fetch.
 */
const offlineLiterature = (literatureId: string, metaId: string) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: literatureId,
    meta_literature_id: metaId,
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: "Offline browser fixture",
      identifiers: [],
    },
  });

describe("application composition", () => {
  it("constructs one shared offline object graph with stable ownership boundaries", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-assembly-"));
    const application = await createApplication(home);
    try {
      expect(application.database).toBeDefined();
      expect(application.files.root).toBe(join(home, "artifacts"));
      expect(application.observations).toBeDefined();
      expect(application.assets).toBeDefined();
      expect(application.references).toBeDefined();
      expect(application.metadata.statuses).toHaveLength(11);
      expect(
        application.metadata.statuses
          .filter((item) => item.ready)
          .map((item) => item.provider_name),
      ).toEqual([
        "crossref",
        "semantic-scholar",
        "arxiv",
        "openalex",
        "europe-pmc",
        "datacite",
        "core",
        "opencitations",
      ]);
      expect(
        application.metadata.statuses
          .filter((item) => !item.ready)
          .map((item) => [item.provider_name, item.failure_code]),
      ).toEqual([
        ["web-of-science", "missing-production-adapter"],
        ["elsevier", "credential-missing"],
        ["springer", "credential-missing"],
      ]);
      expect(application.agents.readiness("analysis").configured).toBe(false);
      expect(application.agents).toBeInstanceOf(DshAgentRuntime);
      // Bootstrap is the only Browser owner, and with Browser left off it registers
      // no Browser route and starts nothing.
      expect(application.configuration.browser.enabled).toBe(false);
      expect(
        application.acquisition.statuses.find(
          (item) => item.source_name === "browser",
        ),
      ).toBeUndefined();
    } finally {
      await application.close();
    }
  });

  it("builds the selected model adapter from ordinary config and opaque credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-configured-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      [
        "[providers.openai]",
        'api = "openai-responses"',
        'base_url = "https://api.example.test"',
        "",
        '[models."openai/analysis-model"]',
        'reasoning = "medium"',
        "stream = false",
        "",
        "[analyze]",
        'model = "openai/analysis-model"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "credentials.toml"),
      [
        "[providers.openai]",
        'api_key = "offline-secret"',
        'origin = "https://api.example.test"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await chmod(directory, 0o700);
    const application = await createApplication(home);
    try {
      expect(application.agents.readiness("analysis")).toEqual({
        configured: true,
        missing: [],
      });
      expect(application.agents.identity("analysis")).toEqual({
        role: "analysis",
        provider: "openai",
        model: "analysis-model",
        reasoning: "medium",
        stream: false,
      });
      expect(application.agents).toBeInstanceOf(DshAgentRuntime);
    } finally {
      await application.close();
    }
  });

  it("assembles the pure TypeScript remote parser only from an exact-origin MinerU grant", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-parser-configured-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      [
        "[parsing]",
        'base_url = "https://parser.example.test/v1"',
        'connection_mode = "remote"',
        'model_identity = "mineru-fixture"',
        "remote_upload_authorized = true",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "credentials.toml"),
      [
        "[mineru]",
        'bearer_token = "offline-secret"',
        'origin = "https://parser.example.test"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await chmod(directory, 0o700);
    const application = await createApplication(home);
    try {
      expect(application.parsing).not.toBeNull();
      expect(application.configuration.parsing).toEqual({
        base_url: "https://parser.example.test/v1",
        connection_mode: "remote",
        model_identity: "mineru-fixture",
        remote_upload_authorized: true,
      });
    } finally {
      await application.close();
    }
    await writeFile(
      join(directory, "config.toml"),
      [
        "[parsing]",
        'base_url = "https://parser.example.test/v1"',
        'connection_mode = "remote"',
        'model_identity = "mineru-fixture"',
        "remote_upload_authorized = false",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const unauthorized = await createApplication(home);
    try {
      expect(unauthorized.parsing).toBeNull();
    } finally {
      await unauthorized.close();
    }

    await rm(join(directory, "credentials.toml"));
    await writeFile(
      join(directory, "config.toml"),
      [
        "[parsing]",
        'base_url = "https://parser.example.test/v1"',
        'connection_mode = "remote"',
        'model_identity = "mineru-fixture"',
        "remote_upload_authorized = true",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const missingToken = await createApplication(home);
    try {
      expect(missingToken.parsing).toBeNull();
    } finally {
      await missingToken.close();
    }

    await writeFile(
      join(directory, "credentials.toml"),
      [
        "[mineru]",
        'bearer_token = "offline-secret"',
        'origin = "https://other.example.test"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const mismatchedOrigin = await createApplication(home);
    try {
      expect(mismatchedOrigin.parsing).toBeNull();
    } finally {
      await mismatchedOrigin.close();
    }
  });

  it.each(["health", "submit"] as const)(
    "sends the MinerU token only to its configured TLS origin and rejects a %s redirect",
    async (redirectAt) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-parser-origin-"));
      const certificateDirectory = await mkdtemp(
        join(tmpdir(), "sciretriever-parser-tls-"),
      );
      const keyPath = join(certificateDirectory, "key.pem");
      const certificatePath = join(certificateDirectory, "cert.pem");
      await execFileAsync("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=parser.example.test",
        "-addext",
        "subjectAltName=DNS:parser.example.test",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
      ]);
      const certificate = await readFile(certificatePath);
      let authorization: string | undefined;
      let method: string | undefined;
      let requests = 0;
      const requestPaths: string[] = [];
      const server = createHttpsServer(
        { key: await readFile(keyPath), cert: certificate },
        async (request, response) => {
          requests += 1;
          requestPaths.push(request.url!);
          authorization = request.headers.authorization;
          method = request.method;
          for await (const _chunk of request) void _chunk;
          if (redirectAt === "submit" && request.url === "/v1/health") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                status: "healthy",
                version: "3.4.4",
                protocol_version: 2,
                queued_tasks: 0,
              }),
            );
            return;
          }
          response.writeHead(302, {
            location: "https://redirect.example.test/parse",
          });
          response.end();
        },
      );
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("TLS fixture unavailable");
      const origin = `https://parser.example.test:${address.port}`;
      const owner = new TypeScriptConfigurationOwner(home);
      const published = await owner.publish(
        `[parsing]\nbase_url = "${origin}/v1"\nconnection_mode = "remote"\nmodel_identity = "mineru-fixture"\nremote_upload_authorized = true\n`,
        "missing",
        ["parsing"],
      );
      await owner.credential(
        {
          namespace: "mineru",
          target: "mineru",
          kind: "set",
          value: "synthetic-parser-token",
        },
        published.revision,
      );
      const application = await createApplication(home, {
        metadataAssembly: {
          resolver: () => ["93.184.216.34"],
          connection: {
            connect: (options) =>
              createConnection({
                ...(options as { port: number }),
                host: "127.0.0.1",
              }),
            tlsConnect: (options) =>
              tlsConnect({ ...options, ca: certificate }),
          },
        },
      });
      try {
        const pdf = workbenchPdf();
        await application.database.putLiterature(FIXTURE_LITERATURE);
        const stage = await application.files.stage();
        await stage.write(pdf);
        await application.files.publish(stage, "objects/remote-source.pdf");
        const asset = parseAsset({
          asset_id: "00000000-0000-0000-0000-000000000301",
          sha256: await sha256(pdf),
          size_bytes: pdf.byteLength,
          media_type: "application/pdf",
          path: "objects/remote-source.pdf",
        });
        await application.database.putLiteratureAsset({
          literature_asset_id: "00000000-0000-0000-0000-000000000302",
          literature_id: FIXTURE_LITERATURE.literature_id,
          asset,
          role: "primary-pdf",
          source_url: null,
          provenance: {
            provenance_id: "00000000-0000-0000-0000-000000000303",
            source_kind: "asset-provider",
            source_name: "fixture",
            source_record_id: null,
            observed_at: "2026-09-11T00:00:00Z",
            input_sha256: asset.sha256,
            parameters_sha256: null,
          },
        });
        await expect(
          application.parsing!.prepareCurrentPrimary(
            FIXTURE_LITERATURE.literature_id,
          ),
        ).rejects.toMatchObject({ code: "parser-unavailable" });
        expect(authorization).toBe("Bearer synthetic-parser-token");
        expect(method).toBe(redirectAt === "health" ? "GET" : "POST");
        expect(requests).toBe(redirectAt === "health" ? 1 : 2);
        expect(requestPaths).toEqual(
          redirectAt === "health"
            ? ["/v1/health"]
            : ["/v1/health", "/v1/tasks"],
        );
        expect(
          (await application.library.detail(FIXTURE_LITERATURE.literature_id))
            .parser_result,
        ).toBeNull();
      } finally {
        await application.close();
        server.closeAllConnections();
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose()),
        );
        await rm(home, { recursive: true, force: true });
        await rm(certificateDirectory, { recursive: true, force: true });
      }
    },
  );
});

describe("assembly of the unified completion entry", () => {
  it("drives database completion from the assembled graph without a second acquisition graph", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-completion-"),
    );
    const resolver = vi.fn(() => {
      throw new Error("Fixture must remain offline");
    });
    const discover = vi.fn(async () => {
      throw new AcquisitionRouteError(
        "source-discovery-failed",
        "Synthetic offline route failure.",
      );
    });
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      metadataAssembly: { resolver },
      acquisitionAssembly: {
        resolver,
        doiLandingSource: {
          source_name: "doi-landing",
          ready: true,
          discover,
        },
      },
    });
    try {
      // Bootstrap owns the only construction of the shared acquisition port and
      // the completion orchestration; a caller must reuse these instances instead
      // of assembling a second, isolated acquisition graph.
      expect(application.pdfAcquisition).not.toBeNull();
      expect(application.databaseCompletion).not.toBeNull();
      const service = application.databaseCompletion!;
      const emptyScope = parseLibraryQuery({
        text: null,
        title: "no such assembly scope",
        author: null,
        author_orcids: [],
        identifiers: [],
        publication_year_from: null,
        publication_year_to: null,
        venue: null,
        publisher: null,
        document_types: [],
        languages: [],
        keywords: [],
        version_roles: [],
        statuses: [],
        missing_steps: [],
        needs_manual_pdf: null,
        discovery_run_ids: [],
      });
      await expect(
        service.run({
          selector: { kind: "query", query: emptyScope },
          goal: "ASSET_READY",
        }),
      ).resolves.toMatchObject({
        kind: "database-completion",
        goal: "ASSET_READY",
        end: { kind: "finished" },
        completed: [],
        failed: [],
        skipped: [],
        notStarted: [],
        interrupted: [],
      });

      await application.database.putLiterature(FIXTURE_LITERATURE);
      // Durable jobs use the same target unit and now receive the same shared
      // acquisition port as the CLI. The expected outcome changes accordingly: the
      // goal is no longer an unwired `pdf-acquisition-required`, it is a real
      // automatic route attempt that ends in a stable route failure.
      const runner = new DatabaseCompletionTargetRunner({
        library: {
          detail: (literatureId) => application.library.detail(literatureId),
        },
        database: application.database,
        completion: application.completion,
        acquisition: application.pdfAcquisition,
      });
      const jobOutcome = await runner.runTarget(
        FIXTURE_LITERATURE.literature_id,
        {
          goal: "ASSET_READY",
        },
      );
      expect(jobOutcome.partition).toBe("failed");
      expect(jobOutcome.failure?.code).toMatch(/^pdf-/u);
      expect(jobOutcome.failure?.code).not.toBe("pdf-acquisition-required");
      expect(jobOutcome.operation_failure).toBe(false);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to build a production Browser host without a verified runtime and never reaches the driver", async () => {
    const { createProductionBrowserHostFactory } = await import(
      "../src/browser/production-host.js"
    );
    let flowRequests = 0;
    const factory = createProductionBrowserHostFactory({
      runtime: undefined,
      article_flow_factory: () => {
        flowRequests += 1;
        return {
          deliver: async () => ({
            kind: "refused" as const,
            code: "browser-flow-unavailable",
            reason: "this driver must never be reached",
            retryable: false as const,
          }),
        };
      },
    });
    // Offline and honest: without a verified runtime the factory must neither build a
    // host nor ask for a driver. This proves the gate without launching Chromium and
    // without fabricating a verified Cloak runtime. The middle link that starts the
    // real host (factory -> host.start/openPage -> deliver) still needs a verified
    // runtime and stays an explicit residual (T20-F16).
    expect(
      factory({ profile: join(tmpdir(), "sciretriever-browser-refused") }),
    ).toBeNull();
    expect(flowRequests).toBe(0);
  });

  it("refuses to admit a production Browser without a verified runtime", async () => {
    const { productionBrowserCapability } = await import(
      "../src/browser/production-host.js"
    );
    // Readiness may never come from a bundle path string: only a verified runtime
    // admits the tier, so an unverified process reports one stable reason. T20-F16
    // (the factory → host.start/openPage middle link) still needs a verified Cloak
    // runtime and stays an explicit residual rather than a fabricated bundle.
    expect(productionBrowserCapability({ runtime: undefined })).toEqual({
      available: false,
      reason: "browser-runtime-unavailable",
    });
  });

  it("admits the browser tier only through the bootstrap-owned deferred runtime", async () => {
    vi.stubEnv("SCIRETRIEVER_CLOAK_BUNDLE", "");
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-browser-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      // Enabling Browser without a verified runtime must not fake a runnable route:
      // readiness comes from the real capability, so the registry reports the stable
      // runtime reason and the tier stays ordered last behind every public and API
      // route.
      expect(
        application.acquisition.statuses.map((i) => i.source_name),
      ).toEqual(["direct", "arxiv", "europe-pmc", "doi-landing", "browser"]);
      expect(
        application.acquisition.statuses.find(
          (item) => item.source_name === "browser",
        ),
      ).toEqual({
        source_name: "browser",
        ready: false,
        failure_code: "browser-runtime-unavailable",
      });
      // The graph needs no Browser runtime at all, so assembling it cannot construct,
      // start or probe a Browser process, profile or Cloak bundle: demanding the host
      // stays stably unavailable instead of surfacing a half-wired one.
      expect(application.browserHost()).toBeNull();
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("never writes an exhaustion fact for a target whose admitted browser tier cannot deliver", async () => {
    vi.stubEnv("SCIRETRIEVER_CLOAK_BUNDLE", "");
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-browser-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const id = browserFixtureId(1001);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2001)),
      );
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
      // The operator admitted an applicable tier this process cannot serve. It must
      // stay an unresolved target failure with its own stable Browser code: not a
      // policy skip and not a durable "no automatic route left" fact.
      const runner = new DatabaseCompletionTargetRunner({
        library: {
          detail: (literatureId) => application.library.detail(literatureId),
        },
        database: application.database,
        completion: application.completion,
        acquisition: application.pdfAcquisition,
      });
      const outcome = await runner.runTarget(id, { goal: "ASSET_READY" });
      expect(outcome).toMatchObject({
        partition: "failed",
        failure: { code: "pdf-browser-runtime-unavailable", retryable: false },
        operation_failure: false,
      });
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
      // Readiness is the real capability: no verified runtime, no delivered route.
      expect(
        application.acquisition.statuses.find(
          (item) => item.source_name === "browser",
        ),
      ).toEqual({
        source_name: "browser",
        ready: false,
        failure_code: "browser-runtime-unavailable",
      });
      expect(
        application.acquisition.sources.map((item) => item.source_name),
      ).toContain("browser");
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("runs the locator routes through an explicit non-Browser view and escalates exactly once", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-assembly-split-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const id = browserFixtureId(1101);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2101)),
      );
      const calls: string[] = [];
      const registry = new PublicAcquisitionRegistry(
        [
          {
            source_name: "route-a",
            ready: true,
            discover: async () => {
              calls.push("route-a");
              return [];
            },
          },
          {
            source_name: BROWSER_ROUTE_NAME,
            ready: false,
            discover: async () => {
              calls.push("browser-source");
              throw new Error(
                "the Browser source must never run inside the tiered batch",
              );
            },
          },
        ],
        ["route-a", BROWSER_ROUTE_NAME],
      );
      const port = new EntryPdfAcquisitionService({
        registry,
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => ({
          deliverCandidate: async () => {
            calls.push("browser-host");
            return {
              kind: "refused" as const,
              code: "browser-flow-unavailable",
              reason: "article flow not wired",
              retryable: false as const,
            };
          },
          close: async () => undefined,
        }),
      });
      const detail = await application.library.detail(id);
      const facts = await application.database.currentFacts(id);
      const outcome = await port.acquire({
        literature_id: parseLiteratureId(id),
        detail,
        metadata_snapshot: facts!.metadata_snapshot,
        signal: new AbortController().signal,
      });
      // Order proves the single path: the locator view ran to its normal end, the
      // throwing Browser source never ran, and the owned session was escalated to once.
      expect(calls).toEqual(["route-a", "browser-host"]);
      expect(outcome).toMatchObject({
        kind: "browser-failure",
        code: "browser-flow-unavailable",
      });
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("escalates to the owned Browser only after every locator route ended and maps its outcome honestly", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-escalate-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    const deliveries: string[] = [];
    let mode: "refused" | "mismatch" | "delivered" = "refused";
    let pending: DurableCandidate | null = null;
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      // The synthetic owner injects an identity navigation admission: an injected host
      // factory is a construction seam, never an exemption from the admission the registry
      // reports, so `browserHost()` stays closed without one.
      browserAdmitNavigation: async (url: string) => url,
      browserHost: () => ({
        deliverCandidate: async (request) => {
          deliveries.push(request.literature_id);
          if (mode === "refused")
            return {
              kind: "refused" as const,
              code: "browser-flow-unavailable",
              reason: "article flow not wired",
              retryable: false as const,
            };
          if (pending === null) throw new Error("missing spooled candidate");
          return {
            kind: "delivered" as const,
            candidate: pending,
            accepted: mode === "delivered",
          };
        },
        close: async () => undefined,
      }),
    });
    try {
      const id = browserFixtureId(1201);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2201)),
      );
      const runner = new DatabaseCompletionTargetRunner({
        library: {
          detail: (literatureId) => application.library.detail(literatureId),
        },
        database: application.database,
        completion: application.completion,
        acquisition: application.pdfAcquisition,
      });
      // The Browser session spools its own bytes; the ordinary receipt path still
      // validates and commits the accepted delivery below.
      const spooledBytes = workbenchPdf();
      await application.execution!.transfers.begin(
        "browser-transfer-1",
        undefined,
        {
          session_id: "browser-session",
          article_id: id,
          page_id: "browser-page",
          document_generation: 1,
          source_url: "https://fixture.invalid/paper",
          captured_at: "2026-09-10T00:00:00Z",
        },
      );
      await application.execution!.transfers.append(
        "browser-transfer-1",
        spooledBytes,
      );
      await application.execution!.transfers.complete("browser-transfer-1");
      pending = await application.database.getCandidate("browser-transfer-1");
      expect(pending).not.toBeNull();

      // A refused delivery is an unresolved target failure with its own Browser code,
      // and it must never become a durable exhaustion fact.
      const refused = await runner.runTarget(id, { goal: "ASSET_READY" });
      expect(refused).toMatchObject({
        partition: "failed",
        failure: { code: "pdf-browser-flow-unavailable", retryable: false },
        operation_failure: false,
      });
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
      expect(deliveries).toEqual([id]);

      // A delivery whose file admission rejected the bytes is also an unresolved
      // failure, never an accepted acquisition.
      mode = "mismatch";
      const mismatched = await runner.runTarget(id, { goal: "ASSET_READY" });
      expect(mismatched).toMatchObject({
        partition: "failed",
        failure: { code: "pdf-browser-candidate-rejected" },
      });
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
      expect(deliveries).toEqual([id, id]);

      // An accepted Browser delivery really reaches the ordinary receipt path and
      // commits a primary PDF. File admission uses the readable fixture bytes, so this
      // step drives the Entry port over a hand-built registry whose locator view is
      // empty: no route may fetch the DOI landing page, and the run stays offline.
      mode = "delivered";
      const doiId = browserFixtureId(1202);
      await application.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: doiId,
          meta_literature_id: browserFixtureId(2202),
        }),
      );
      const bytes = workbenchPdf();
      await application.execution!.transfers.begin(
        "browser-transfer-2",
        undefined,
        {
          session_id: "browser-session",
          article_id: doiId,
          page_id: "browser-page",
          document_generation: 1,
          source_url: "https://fixture.invalid/paper",
          captured_at: "2026-09-10T00:00:00Z",
        },
      );
      await application.execution!.transfers.append(
        "browser-transfer-2",
        bytes,
      );
      await application.execution!.transfers.complete("browser-transfer-2");
      pending = await application.database.getCandidate("browser-transfer-2");
      expect(pending).not.toBeNull();
      const deliveryPort = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [
            {
              source_name: "route-a",
              ready: true,
              discover: async () => [],
            },
            {
              source_name: BROWSER_ROUTE_NAME,
              ready: false,
              discover: async () => {
                throw new Error(
                  "the Browser source must never run inside the tiered batch",
                );
              },
            },
          ],
          ["route-a", BROWSER_ROUTE_NAME],
        ),
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => application.browserHost(),
      });
      const facts = await application.database.currentFacts(doiId);
      const deliveryOutcome = await deliveryPort.acquire({
        literature_id: parseLiteratureId(doiId),
        detail: await application.library.detail(doiId),
        metadata_snapshot: facts!.metadata_snapshot,
        signal: new AbortController().signal,
      });
      expect(deliveryOutcome).toMatchObject({
        kind: "acquired",
        literature_id: doiId,
      });
      expect(
        (await application.library.detail(doiId)).primary_pdf,
      ).not.toBeNull();
      expect(deliveries).toEqual([id, id, doiId]);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps a disabled Browser tier non-applicable so a target may still exhaust", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-browser-off-"),
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const id = browserFixtureId(1301);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2301)),
      );
      const runner = new DatabaseCompletionTargetRunner({
        library: {
          detail: (literatureId) => application.library.detail(literatureId),
        },
        database: application.database,
        completion: application.completion,
        acquisition: application.pdfAcquisition,
      });
      const outcome = await runner.runTarget(id, { goal: "ASSET_READY" });
      // The operator never asked for the tier, so it is not an applicable route: the
      // normal end may become the durable exhaustion fact for this target.
      expect(outcome).toMatchObject({
        partition: "skipped",
        skipped_reason: "manual-pdf-required",
        failure: null,
      });
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        true,
      );
      expect(
        application.acquisition.statuses.some(
          (item) => item.source_name === "browser",
        ),
      ).toBe(false);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("hands the shared completion orchestration a live completion service, not a null captured too early", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-live-completion-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      [
        "[providers.fixture]",
        'api = "openai-chat-completions"',
        'base_url = "http://127.0.0.1:9/v1"',
        "",
        '[models."fixture/model"]',
        "stream = false",
        "",
        "[analyze]",
        'model = "fixture/model"',
        "metadata_max_output_tokens = 2048",
        "content_max_output_tokens = 4096",
        "max_input_bytes = 1048576",
        "max_chunk_bytes = 1048576",
        "max_chunk_count = 1",
        "max_total_llm_requests = 2",
        "max_total_output_tokens = 6144",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const stubParser: ParserBackend = {
      async parse() {
        throw new Error("the stub parser must never be invoked in this test");
      },
    };
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      parsing: {
        rules: new TypeScriptParserArtifactRules(),
        parser: stubParser,
      },
    });
    try {
      // Construction order matters: the shared orchestration must be built after the
      // completion service exists, so it can never capture a null.
      expect(application.completion).not.toBeNull();
      expect(application.databaseCompletion).not.toBeNull();
      const id = browserFixtureId(1401);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2401)),
      );
      const report = await application.databaseCompletion!.run({
        selector: {
          kind: "literatures",
          literature_ids: [parseLiteratureId(id)],
        },
        goal: "CONTENT_READY",
      });
      // The live service is reached for real: the target reaches a legitimate
      // terminal partition, never the old null-captured completion failure. In the
      // production graph the target has no PDF, so the automatic acquisition policy
      // may report an explicit manual intervention skip before Parsing/Analysis.
      expect(report.failed.map((item) => item.failure.code)).not.toContain(
        "content-completion-unavailable",
      );
      expect(report.end.kind).toBe("finished");
      expect(
        report.completed.length +
          report.failed.length +
          report.skipped.length +
          report.interrupted.length +
          report.notStarted.length,
      ).toBe(1);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("admits only one validated landing page to the article driver", async () => {
    const { admitBrowserArticleRequest } = await import(
      "../src/browser/production-host.js"
    );
    const base = {
      literature_id: FIXTURE_LITERATURE.literature_id,
      identifier: "doi:10.5555/sciretriever.fixture",
      version: "published",
      metadata_snapshot: {
        metadata_sha256: "a".repeat(64),
        metadata_revision: 1,
      },
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof admitBrowserArticleRequest>[0];
    // No admitted page: the driver is never asked.
    expect(admitBrowserArticleRequest({ ...base, start_url: null })).toEqual({
      ok: false,
      refusal: {
        kind: "refused",
        code: "browser-flow-unavailable",
        reason: "No admitted landing page is available for this article.",
        retryable: false,
      },
    });
    for (const start_url of [
      "file:///fixture/article",
      "https://user:secret@fixture.invalid/article",
      "https://fixture.invalid/article#fragment",
      "not a url",
    ]) {
      const admitted = admitBrowserArticleRequest({ ...base, start_url });
      expect(admitted.ok).toBe(false);
      if (!admitted.ok)
        expect(admitted.refusal).toMatchObject({
          code: "browser-start-url-invalid",
          retryable: false,
        });
    }
    expect(
      admitBrowserArticleRequest({
        ...base,
        start_url: "http://fixture.invalid/article",
      }).ok,
    ).toBe(true);
    const admitted = admitBrowserArticleRequest({
      ...base,
      start_url: "https://fixture.invalid/article?q=1",
    });
    expect(admitted.ok).toBe(true);
    if (admitted.ok)
      expect(admitted.request.start_url).toBe(
        "https://fixture.invalid/article?q=1",
      );
  });

  it("selects the browser start page from the target's own landing hints only", async () => {
    const { browserStartUrl } = await import("../src/entry/pdf-acquisition.js");
    const hint = (overrides: Record<string, unknown>) => ({
      url: "https://fixture.invalid/article",
      kind: "landing-page",
      media_type: null,
      asset_role: null,
      version_role: null,
      access_status: "open",
      license: null,
      ...overrides,
    });
    const observation = (asset_hints: readonly unknown[]) =>
      ({ asset_hints }) as never;
    // HTTP(S) landing hints still pass through Network DNS/socket admission.
    // Direct files, other schemes, embedded credentials and fragments are not starts.
    expect(
      browserStartUrl(
        [
          observation([
            hint({ kind: "direct-file" }),
            hint({ url: "file:///fixture/article" }),
            hint({ url: "https://user:secret@fixture.invalid/article" }),
            hint({ url: "https://fixture.invalid/article#x" }),
            hint({
              url: "https://api.elsevier.com/content/article/doi/10.5555/example",
            }),
            hint({
              url: "https://api.wiley.com/onlinelibrary/tdm/v1/articles/10.5555%2Fexample",
            }),
            hint({ version_role: "preprint" }),
          ]),
        ],
        "published",
      ),
    ).toBeNull();
    expect(
      browserStartUrl(
        [observation([hint({ url: "http://fixture.invalid/article" })])],
        "published",
      ),
    ).toBe("http://fixture.invalid/article");
    // Version policy: a published target never navigates to a preprint landing page;
    // it uses the unversioned hint when no exact match exists.
    expect(
      browserStartUrl(
        [
          observation([
            hint({ kind: "direct-file" }),
            hint({
              url: "https://fixture.invalid/preprint",
              version_role: "preprint",
            }),
            hint({ url: "https://fixture.invalid/published" }),
          ]),
        ],
        "published",
      ),
    ).toBe("https://fixture.invalid/published");
    // A preprint target prefers its exact version hint over the unversioned fallback.
    expect(
      browserStartUrl(
        [
          observation([
            hint({ url: "https://fixture.invalid/unversioned" }),
            hint({
              url: "https://fixture.invalid/preprint",
              version_role: "preprint",
            }),
          ]),
        ],
        "preprint",
      ),
    ).toBe("https://fixture.invalid/preprint");
    expect(
      browserStartUrl(
        [
          observation([
            hint({ url: "https://onlinelibrary.wiley.com/doi/unversioned" }),
            hint({
              url: "https://repository.example/preprint",
              version_role: "preprint",
            }),
          ]),
        ],
        "preprint",
      ),
    ).toBe("https://repository.example/preprint");
    // Every other concrete role follows the same rule: its own exact hint wins, an
    // unversioned hint is the only fallback, and a hint naming another version is never
    // navigated to — so a non-published target is never sent to a published page and vice
    // versa.
    for (const role of ["accepted-manuscript", "preprint", "other"] as const) {
      const other = role === "preprint" ? "published" : "preprint";
      const otherHint = hint({
        url: `https://fixture.invalid/other-${role}`,
        version_role: other,
      });
      expect(
        browserStartUrl(
          [
            observation([
              otherHint,
              hint({ url: `https://fixture.invalid/unversioned-${role}` }),
              hint({
                url: `https://fixture.invalid/exact-${role}`,
                version_role: role,
              }),
            ]),
          ],
          role,
        ),
      ).toBe(`https://fixture.invalid/exact-${role}`);
      expect(
        browserStartUrl(
          [
            observation([
              otherHint,
              hint({ url: `https://fixture.invalid/unversioned-${role}` }),
            ]),
          ],
          role,
        ),
      ).toBe(`https://fixture.invalid/unversioned-${role}`);
      expect(browserStartUrl([observation([otherHint])], role)).toBeNull();
    }
    // A DOI-only metadata target still has a generic, policy-controlled Browser start
    // point. It is the resolver entry, never a Publisher-specific guessed URL.
    expect(
      browserStartUrl([observation([])], "published", [
        { namespace: "doi", value: "10.1000/example/article" },
      ]),
    ).toBe("https://doi.org/10.1000/example/article");
    expect(
      browserStartUrl(
        [
          observation([
            hint({
              url: "https://api.elsevier.com/content/article/doi/10.1000/example",
            }),
          ]),
        ],
        "published",
        [{ namespace: "doi", value: "10.1000/example" }],
      ),
    ).toBe("https://doi.org/10.1000/example");
  });

  it("hands the target's own concrete version role and landing page to the Browser delivery", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-version-role-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    const seen: Array<{
      version: string;
      start_url: string | null;
      article_goal: {
        title: string | null;
        publication_year: number | null;
        authors: readonly string[];
      };
    }> = [];
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      browserAdmitNavigation: async (url: string) => url,
      browserHost: () => ({
        deliverCandidate: async (request) => {
          seen.push({
            version: request.version,
            start_url: request.start_url,
            article_goal: {
              title: request.article_goal!.title,
              publication_year: request.article_goal!.publication_year,
              authors: request.article_goal!.authors,
            },
          });
          return {
            kind: "refused" as const,
            code: "browser-flow-unavailable",
            reason: "fixture never navigates",
            retryable: false as const,
          };
        },
        close: async () => undefined,
      }),
    });
    try {
      const port = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [
            {
              source_name: "route-a",
              ready: true,
              // Every locator route ends normally without a candidate, so the target reaches
              // the independently admitted Browser carrying its own concrete version role.
              discover: async () => [],
            },
            {
              source_name: BROWSER_ROUTE_NAME,
              ready: false,
              discover: async () => {
                throw new Error(
                  "the Browser source must never run inside the tiered batch",
                );
              },
            },
          ],
          ["route-a", BROWSER_ROUTE_NAME],
        ),
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => application.browserHost(),
      });
      const roles: readonly VersionRole[] = [
        "accepted-manuscript",
        "preprint",
        "other",
      ];
      for (const [index, role] of roles.entries()) {
        const id = browserFixtureId(1300 + index);
        const hint = (url: string, version: VersionRole | null) => ({
          url,
          kind: "landing-page" as const,
          media_type: null,
          asset_role: null,
          version_role: version,
          access_status: "open" as const,
          license: null,
        });
        const metadata = {
          ...FIXTURE_LITERATURE.metadata,
          identifiers: [],
        };
        await application.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id,
            meta_literature_id: browserFixtureId(2300 + index),
            version_role: role,
            metadata,
          }),
        );
        // The observation carries the landing hints; publishing it binds them to this
        // target so Entry sees the target's own version-specific landing page.
        await application.observations.publish({
          ...parseMetadataObservation({
            observation_id: browserFixtureId(3300 + index),
            provenance: {
              provenance_id: browserFixtureId(4300 + index),
              source_kind: "metadata-provider",
              source_name: "fixture",
              source_record_id: `record-${index}`,
              observed_at: "2026-09-10T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata,
            version_role: role,
            version_links: [],
            asset_hints: [
              hint("https://fixture.invalid/published", "published"),
              hint(`https://fixture.invalid/unversioned-${role}`, null),
              hint(`https://fixture.invalid/exact-${role}`, role),
            ],
            reference_texts: [],
            declared_keywords: [],
            reference_count: 0,
            cited_by_count: 0,
          }),
          literature_id: id,
        });
        const facts = await application.database.currentFacts(id);
        await expect(
          port.acquire({
            literature_id: parseLiteratureId(id),
            detail: await application.library.detail(id),
            metadata_snapshot: facts!.metadata_snapshot,
            signal: new AbortController().signal,
          }),
        ).resolves.toMatchObject({ kind: "browser-failure" });
        // No hard-coded `published`: the delivery request carries the target's own role and
        // its own exact landing page, never another version's page.
        expect(seen.at(-1)).toEqual({
          version: role,
          start_url: `https://fixture.invalid/exact-${role}`,
          article_goal: {
            title: metadata.title,
            publication_year: metadata.publication_year,
            authors: [],
          },
        });
      }
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("owns the controlled Browser host in Bootstrap and releases it on close", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-assembly-owner-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    let built = 0;
    let closed = 0;
    let deliveries = 0;
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      // Identity admission for the injected seam: without it the public demand surface
      // fails closed, exactly as it does for the production factory.
      browserAdmitNavigation: async (url: string) => url,
      // Fake seam: proves the object graph without launching Playwright.
      browserHost: () => {
        built += 1;
        return {
          deliverCandidate: async () => {
            deliveries += 1;
            return {
              kind: "refused" as const,
              code: "browser-flow-unavailable",
              reason: "not wired",
              retryable: false as const,
            };
          },
          close: async () => {
            closed += 1;
          },
        };
      },
    });
    try {
      // Bootstrap is the only owner and builds nothing until the host is demanded, so
      // an idle Application never starts a Browser or takes the profile lock.
      expect(built).toBe(0);
      const host = application.browserHost();
      expect(host).not.toBeNull();
      expect(built).toBe(1);
      // Demanding it again returns the same owned instance instead of a second owner.
      expect(application.browserHost()).toBe(host);
      expect(built).toBe(1);
      // A delivery must be an accepted candidate or a stable refusal — never an empty
      // list and never a bare transfer id.
      const delivery = await host!.deliverCandidate({
        literature_id: FIXTURE_LITERATURE.literature_id,
        identifier: `doi:${FIXTURE_LITERATURE.metadata.identifiers[0]?.value ?? "x"}`,
        version: "published",
        start_url: null,
        metadata_snapshot: {
          metadata_sha256: "a".repeat(64),
          metadata_revision: 1,
        } as never,
        signal: new AbortController().signal,
      });
      expect(delivery.kind).toBe("refused");
      expect(delivery).not.toHaveProperty("candidate");
      expect(deliveries).toBe(1);
      expect(closed).toBe(0);
      // Closing the Application must release the owned host exactly once.
      await application.close();
      expect(closed).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("browser intake end-to-end (offline)", () => {
  it("turns synthetic Browser bytes into a real DurableCandidate through the Intake boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-e2e-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const transfers = application.execution!.transfers;
      const pdf = workbenchPdf(FIXTURE_DOI, "published");
      // The Browser capture path: a transfer is opened, bytes are appended, then the
      // Intake owner completes it. Nothing here is a hand-built candidate.
      const transferId = "e2e-browser-transfer";
      const capture = {
        session_id: "e2e-session",
        article_id: FIXTURE_LITERATURE.literature_id,
        page_id: "e2e-page",
        document_generation: 0,
        source_url: `https://fixture.example.test/article`,
        captured_at: new Date().toISOString(),
      };
      const intake = new BrowserCandidateIntake(transfers, {
        article_id: FIXTURE_LITERATURE.literature_id,
        identifier: `doi:${FIXTURE_DOI}`,
        version: "published",
      });
      async function* chunks(): AsyncGenerator<Uint8Array> {
        yield pdf;
      }
      const received = await intake.receive({
        signal: new AbortController().signal,
        transfer_id: transferId,
        capture,
        chunks: chunks(),
      });
      // A real durable candidate: real sha256/byte size/reference from the file store.
      expect(received.candidate.transfer_id).toBe(transferId);
      expect(received.candidate.state).toBe("durable-ready");
      expect(received.candidate.sha256).toBe(await sha256(pdf));
      expect(received.candidate.size_bytes).toBe(pdf.byteLength);
      expect(received.candidate.reference.length).toBeGreaterThan(0);
      // Re-assessment reads the published bytes back through the same boundary.
      const assessed = await intake.assess(received.candidate);
      expect(assessed.candidate.sha256).toBe(received.candidate.sha256);
      expect(assessed.assessment.accepted).toBe(true);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("does not construct or deliver a production Browser when navigation admission is missing", async () => {
    vi.stubEnv("SCIRETRIEVER_CLOAK_BUNDLE", "");
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-no-admission-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      // Browser is enabled, yet no verified runtime and no explicit navigation
      // admission exist: the production owner must stay stably unavailable, so nothing
      // is constructed, started or delivered.
      expect(application.configuration.browser.enabled).toBe(true);
      expect(application.browserHost()).toBeNull();
      expect(application.browserHost()).toBeNull();
      expect(
        application.acquisition.statuses.find(
          (item) => item.source_name === "browser",
        ),
      ).toEqual({
        source_name: "browser",
        ready: false,
        failure_code: "browser-runtime-unavailable",
      });
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("rejects a forged runtime at the production host's verified-runtime trust anchor", async () => {
    const { createProductionBrowserHostFactory } = await import(
      "../src/browser/production-host.js"
    );
    // `verifyInstalledCloakRuntime` registers its own frozen result in a module-private
    // WeakSet that `BrowserHost`'s constructor re-checks through
    // `assertVerifiedCloakRuntime`, so a structurally identical object cannot be forged.
    // The only offline way to exercise this factory's wiring is the explicitly injected
    // `host_seam` below; the real chain
    // `verifyInstalledCloakRuntime -> new BrowserHost -> start -> openPage -> deliver`
    // stays an unrun residual (T20-F16 / T23-F03) and is never claimed as verified.
    const forged = Object.freeze({
      executablePath: "/synthetic/cloak/chrome",
      version: "0.0.0-forged",
    });
    const factory = createProductionBrowserHostFactory({
      runtime: forged as never,
    });
    // Admission present, so the forged runtime reaches the real construction site and the
    // WeakSet trust anchor — not the runtime gate — is what refuses it.
    expect(() =>
      factory({
        profile: join(tmpdir(), "sciretriever-browser-forged"),
        admitNavigation: async (url: string) => url,
      }),
    ).toThrow(CloakRuntimeError);
  });

  it("closes the public browserHost() without a navigation admission even for an injected factory", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-no-admission-seam-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    let built = 0;
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      // An injected factory is a host-construction seam only. Without the Network-owned
      // navigation admission this process can never deliver an article, so the public
      // demand surface must neither construct, start nor hand out a host — the same
      // fail-closed rule the production factory applies at its own construction site.
      browserHost: () => {
        built += 1;
        return {
          deliverCandidate: async () => ({
            kind: "refused" as const,
            code: "browser-flow-unavailable",
            reason: "this host must never be handed out",
            retryable: false as const,
          }),
          close: async () => undefined,
        };
      },
    });
    try {
      expect(application.browserHost()).toBeNull();
      expect(built).toBe(0);
      expect(
        application.acquisition.statuses.find(
          (item) => item.source_name === "browser",
        ),
      ).toEqual({
        source_name: "browser",
        ready: false,
        failure_code: "browser-runtime-unavailable",
      });
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps one construction site, a gate before it, and a seam Bootstrap never supplies", async () => {
    const { createProductionBrowserHostFactory } = await import(
      "../src/browser/production-host.js"
    );
    // Static call-graph evidence for the link that cannot run offline: the production
    // factory has exactly one real `new BrowserHost(hostOptions)` site, the verified
    // runtime gate runs before it, the trusted constructor still re-checks
    // `assertVerifiedCloakRuntime`, and Bootstrap never mentions the offline wiring seam —
    // so the production object graph has no path that skips the trust anchor.
    const productionHost = await readFile(
      new URL("../src/browser/production-host.ts", import.meta.url),
      "utf8",
    );
    const rawHost = await readFile(
      new URL("../src/browser/host.ts", import.meta.url),
      "utf8",
    );
    const bootstrap = await readFile(
      new URL("../src/bootstrap/application.ts", import.meta.url),
      "utf8",
    );
    expect(
      productionHost.match(/new BrowserHost\(hostOptions\)/g),
    ).toHaveLength(1);
    expect(
      productionHost.indexOf("new BrowserHost(hostOptions)"),
    ).toBeGreaterThan(
      productionHost.indexOf(
        "productionBrowserCapability({ runtime: options.runtime })",
      ),
    );
    expect(bootstrap).not.toContain("host_seam");
    expect(rawHost).toContain("assertVerifiedCloakRuntime(options.runtime)");
    // Behavioral half of the same gate: no verified runtime, no host, no driver.
    const factory = createProductionBrowserHostFactory({ runtime: undefined });
    expect(
      factory({ profile: join(tmpdir(), "sciretriever-browser-noseam") }),
    ).toBeNull();
  });

  it("refuses to construct a host without an admitted navigation, even through the offline seam", async () => {
    const { createProductionBrowserHostFactory } = await import(
      "../src/browser/production-host.js"
    );
    const built: string[] = [];
    const factory = createProductionBrowserHostFactory({
      runtime: undefined,
      host_seam: () => {
        built.push("host");
        return {
          start: async () => undefined,
          openPage: async () => ({ close: async () => undefined }) as never,
          close: async () => undefined,
        };
      },
    });
    // The wiring seam substitutes the runtime gate, so this is the admission gate alone: a
    // direct factory call may not build a Browser that could only be refused later.
    expect(
      factory({ profile: join(tmpdir(), "sciretriever-browser-no-admission") }),
    ).toBeNull();
    expect(built).toEqual([]);
  });

  it("covers the production host wiring through an explicitly injected offline host seam", async () => {
    const { createProductionBrowserHostFactory } = await import(
      "../src/browser/production-host.js"
    );
    // This test covers the production factory's own wiring only: construction site ->
    // start/openPage -> navigation admission -> article-flow factory -> Intake candidate
    // -> invalid-start refusal -> close. It is NOT evidence that the real production
    // chain runs: `verifyInstalledCloakRuntime -> new BrowserHost -> start -> openPage ->
    // deliver` cannot be produced offline because the runtime trust anchor is a
    // module-private WeakSet, so that chain stays an unrun residual (T20-F16 / T23-F03)
    // and must never be reported as verified here.
    const home = await mkdtemp(join(tmpdir(), "sciretriever-assembly-seam-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      await application.database.putLiterature(FIXTURE_LITERATURE);
      const transfers = application.execution!.transfers;
      const calls: string[] = [];
      let seenAdmission:
        | ((url: string) => string | Promise<string>)
        | undefined;
      const factory = createProductionBrowserHostFactory({
        runtime: undefined,
        article_flow_factory: (pages) => ({
          deliver: async (request) => {
            calls.push(`flow:${request.version}`);
            const page = await pages.openPage(request);
            calls.push("page-opened");
            await page.close();
            const intake = new BrowserCandidateIntake(transfers, {
              article_id: request.literature_id,
              identifier: request.identifier,
              version: request.version,
            });
            const bytes = workbenchPdf(FIXTURE_DOI, request.version);
            async function* chunks(): AsyncGenerator<Uint8Array> {
              yield bytes;
            }
            const received = await intake.receive({
              signal: request.signal,
              transfer_id: `seam-${request.literature_id}`,
              capture: {
                session_id: "seam-session",
                article_id: request.literature_id,
                page_id: "seam-page",
                document_generation: 0,
                source_url: "https://fixture.example.test/article",
                captured_at: "2026-09-10T00:00:00Z",
              },
              chunks: chunks(),
            });
            return {
              kind: "delivered" as const,
              candidate: received.candidate,
              accepted: received.assessment.accepted,
            };
          },
        }),
        host_seam: (options) => {
          seenAdmission = options.admitNavigation;
          return {
            start: async () => {
              calls.push("start");
            },
            openPage: async (url?: string) => {
              expect(
                await options.admitNavigation?.(
                  "https://cdn.fixture.invalid/article.pdf",
                ),
              ).toBe("https://cdn.fixture.invalid/article.pdf");
              await expect(
                options.admitNavigation?.("https://127.0.0.1/private"),
              ).rejects.toThrow("Network destination denied");
              expect(await options.admitNavigation?.(url!)).toBe(url);
              calls.push(`openPage:${url ?? "-"}`);
              return {
                close: async () => {
                  calls.push("page-close");
                },
              } as never;
            },
            close: async () => {
              calls.push("host-close");
            },
          };
        },
      });
      const host = factory({
        profile: join(tmpdir(), "sciretriever-browser-seam"),
        admitNavigation: async (url: string) => {
          if (new URL(url).hostname === "127.0.0.1")
            throw new Error("Network destination denied");
          return url;
        },
      });
      expect(host).not.toBeNull();
      // Network admission is independent of foreground state. CDP session/document
      // ownership rejects inactive pages before invoking this destination boundary.
      await expect(
        seenAdmission!("https://cdn.fixture.invalid/article.pdf"),
      ).resolves.toBe("https://cdn.fixture.invalid/article.pdf");
      await expect(seenAdmission!("https://127.0.0.1/private")).rejects.toThrow(
        "Network destination denied",
      );
      const facts = await application.database.currentFacts(
        FIXTURE_LITERATURE.literature_id,
      );
      const request = {
        literature_id: FIXTURE_LITERATURE.literature_id,
        identifier: `doi:${FIXTURE_DOI}`,
        version: "published" as const,
        start_url: "https://fixture.invalid/article",
        metadata_snapshot: facts!.metadata_snapshot,
        signal: new AbortController().signal,
      };
      const delivery = await host!.deliverCandidate(request);
      expect(delivery).toMatchObject({ kind: "delivered", accepted: true });
      // Network admission is independent of foreground state. CDP session/document
      // ownership rejects inactive pages before invoking this destination boundary.
      await expect(
        seenAdmission!("https://cdn.fixture.invalid/article.pdf"),
      ).resolves.toBe("https://cdn.fixture.invalid/article.pdf");
      await expect(seenAdmission!("https://127.0.0.1/private")).rejects.toThrow(
        "Network destination denied",
      );
      // The host factory owns the page source: start/openPage run on the raw host, the
      // driver receives the already-admitted URL and the concrete target version, and
      // the page is always released.
      expect(calls).toEqual([
        "flow:published",
        "start",
        "openPage:https://fixture.invalid/article",
        "page-opened",
        "page-close",
      ]);
      // admitNavigation reaches the raw host options unchanged.
      expect(typeof seenAdmission).toBe("function");
      // The Intake-produced candidate commits through the ordinary acceptance path:
      // direct acceptance turns the target into a durable primary PDF.
      expect(delivery.kind).toBe("delivered");
      if (delivery.kind === "delivered") {
        await application.execution!.acceptance.accept({
          receipt_id: "seam-receipt",
          literature_id: FIXTURE_LITERATURE.literature_id,
          transfer_id: delivery.candidate.transfer_id,
          metadata_snapshot: facts!.metadata_snapshot,
        });
        expect(
          (await application.library.detail(FIXTURE_LITERATURE.literature_id))
            .primary_pdf,
        ).not.toBeNull();
      }
      // A start URL that is not an admitted landing page is refused before any Browser
      // work happens.
      calls.length = 0;
      await expect(
        host!.deliverCandidate({
          ...request,
          start_url: "file:///fixture/article",
        }),
      ).resolves.toMatchObject({
        kind: "refused",
        code: "browser-start-url-invalid",
      });
      expect(calls).toEqual([]);
      await host!.close();
      expect(calls).toContain("host-close");
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("tries Browser after source failures and applies assistance only after automatic routes", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-fail-closed-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    let deliveries = 0;
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      // A real Entry/Broker path with an offline Browser delivery boundary.
      browserAdmitNavigation: async (url: string) => url,
      browserHost: () => ({
        deliverCandidate: async () => {
          deliveries += 1;
          return {
            kind: "refused" as const,
            code: "browser-flow-unavailable",
            reason: "the synthetic Browser also cannot deliver",
            retryable: false as const,
          };
        },
        close: async () => undefined,
      }),
    });
    try {
      const id = browserFixtureId(1601);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2601)),
      );
      const detail = await application.library.detail(id);
      const facts = await application.database.currentFacts(id);
      const acquireRequest = {
        literature_id: parseLiteratureId(id),
        detail,
        metadata_snapshot: facts!.metadata_snapshot,
        signal: new AbortController().signal,
      };
      const withRoute = (failure: {
        code: "source-discovery-failed" | "download-unavailable";
        retryable: boolean;
      }) =>
        new EntryPdfAcquisitionService({
          registry: new PublicAcquisitionRegistry(
            [
              {
                source_name: "route-a",
                ready: true,
                discover: async () => {
                  throw new AcquisitionRouteError(
                    failure.code,
                    "fixture route failure",
                    failure.retryable,
                  );
                },
              },
              {
                source_name: BROWSER_ROUTE_NAME,
                ready: false,
                discover: async () => {
                  throw new Error("never run");
                },
              },
            ],
            ["route-a", BROWSER_ROUTE_NAME],
          ),
          network_budget: application.networkBudget,
          transfers: application.execution!.transfers,
          acceptance: application.execution!.acceptance,
          browser_host: () => application.browserHost(),
        });

      // Both retryable and non-retryable failures try Browser; an unsuccessful
      // Browser retains the source error rather than recording exhaustion.
      await expect(
        withRoute({ code: "source-discovery-failed", retryable: true }).acquire(
          acquireRequest,
        ),
      ).resolves.toMatchObject({
        kind: "route-failure",
        failure: { code: "source-discovery-failed", retryable: true },
      });
      await expect(
        withRoute({ code: "download-unavailable", retryable: false }).acquire(
          acquireRequest,
        ),
      ).resolves.toMatchObject({
        kind: "route-failure",
        failure: { code: "download-unavailable", retryable: false },
      });
      expect(deliveries).toBe(2);
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
      // A policy pause applies only after Browser has also tried.
      const paused = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [
            {
              source_name: "route-a",
              ready: true,
              discover: async () => {
                throw new AcquisitionRouteError(
                  "source-discovery-failed",
                  "temporary provider failure",
                );
              },
            },
            {
              source_name: BROWSER_ROUTE_NAME,
              ready: false,
              discover: async () => {
                throw new Error("never run");
              },
            },
          ],
          ["route-a", BROWSER_ROUTE_NAME],
        ),
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        assistance: "pause",
        browser_host: () => application.browserHost(),
      });
      await expect(paused.acquire(acquireRequest)).resolves.toMatchObject({
        kind: "assistance-required",
      });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        withRoute({ code: "download-unavailable", retryable: false }).acquire({
          ...acquireRequest,
          signal: cancelled.signal,
        }),
      ).resolves.toMatchObject({ kind: "cancelled" });
      expect(deliveries).toBe(3);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rescues an explicitly declared low-risk unavailability through the admitted Browser", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-assembly-rescue-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    const deliveries: string[] = [];
    let pending: DurableCandidate | null = null;
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      browserAdmitNavigation: async (url: string) => url,
      browserHost: () => ({
        deliverCandidate: async (request) => {
          deliveries.push(request.literature_id);
          if (pending === null) throw new Error("missing spooled candidate");
          return {
            kind: "delivered" as const,
            candidate: pending,
            accepted: true,
          };
        },
        close: async () => undefined,
      }),
    });
    try {
      const id = browserFixtureId(1401);
      await application.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id,
          meta_literature_id: browserFixtureId(2401),
        }),
      );
      await application.execution!.transfers.begin(
        "rescue-transfer",
        undefined,
        {
          session_id: "browser-session",
          article_id: id,
          page_id: "browser-page",
          document_generation: 1,
          source_url: "https://fixture.invalid/paper",
          captured_at: "2026-09-10T00:00:00Z",
        },
      );
      await application.execution!.transfers.append(
        "rescue-transfer",
        workbenchPdf(),
      );
      await application.execution!.transfers.complete("rescue-transfer");
      pending = await application.database.getCandidate("rescue-transfer");
      expect(pending).not.toBeNull();

      const facts = await application.database.currentFacts(id);
      const port = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [
            {
              source_name: "route-a",
              ready: true,
              discover: async () => {
                // The route declares an explicit low-risk unavailability: it has no PDF
                // capability for this target. Only this declaration — never a failure code
                // — lets Entry hand the target to the independently admitted Browser.
                throw new AcquisitionUnavailableError(
                  "download-unavailable",
                  "the route has no PDF capability for this target",
                  "no-capability",
                );
              },
            },
            {
              source_name: BROWSER_ROUTE_NAME,
              ready: false,
              discover: async () => {
                throw new Error(
                  "the Browser source must never run inside the tiered batch",
                );
              },
            },
          ],
          ["route-a", BROWSER_ROUTE_NAME],
        ),
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => application.browserHost(),
      });
      await expect(
        port.acquire({
          literature_id: parseLiteratureId(id),
          detail: await application.library.detail(id),
          metadata_snapshot: facts!.metadata_snapshot,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: "acquired" });
      // The rescue really ran through the admitted Browser session exactly once and the
      // delivered candidate committed through the ordinary receipt path.
      expect(deliveries).toEqual([id]);
      expect((await application.library.detail(id)).primary_pdf).not.toBeNull();
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports Browser refusal instead of an earlier route's missing capability", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-rescue-failed-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    let deliveries = 0;
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      browserAdmitNavigation: async (url: string) => url,
      browserHost: () => ({
        deliverCandidate: async () => {
          deliveries += 1;
          return {
            kind: "refused" as const,
            code: "browser-flow-unavailable",
            reason: "no article flow in this fixture",
            retryable: false as const,
          };
        },
        close: async () => undefined,
      }),
    });
    try {
      const id = browserFixtureId(1402);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2402)),
      );
      const facts = await application.database.currentFacts(id);
      const port = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [
            {
              source_name: "route-a",
              ready: true,
              discover: async () => {
                throw new AcquisitionUnavailableError(
                  "download-unavailable",
                  "the route has no PDF capability for this target",
                  "no-capability",
                );
              },
            },
            {
              source_name: BROWSER_ROUTE_NAME,
              ready: false,
              discover: async () => {
                throw new Error(
                  "the Browser source must never run inside the tiered batch",
                );
              },
            },
          ],
          ["route-a", BROWSER_ROUTE_NAME],
        ),
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => application.browserHost(),
      });
      // Missing capability only led to the rescue. Its real refusal is the final
      // failure; neither outcome justifies writing an automatic exhaustion fact.
      await expect(
        port.acquire({
          literature_id: parseLiteratureId(id),
          detail: await application.library.detail(id),
          metadata_snapshot: facts!.metadata_snapshot,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: "browser-failure",
        code: "browser-flow-unavailable",
        reason: "no article flow in this fixture",
      });
      expect(deliveries).toBe(1);
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("tries Browser and retains the unresolved source failure when Browser also fails", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-assembly-rescue-last-wins-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      ["[browser]", "enabled = true", 'profile = "synthetic"', ""].join("\n"),
      { mode: 0o600 },
    );
    let deliveries = 0;
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      browserAdmitNavigation: async (url: string) => url,
      browserHost: () => ({
        deliverCandidate: async () => {
          deliveries += 1;
          return {
            kind: "refused" as const,
            code: "browser-flow-unavailable",
            reason: "the Browser must never be reached for a temporary failure",
            retryable: false as const,
          };
        },
        close: async () => undefined,
      }),
    });
    try {
      const id = browserFixtureId(1403);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2403)),
      );
      const facts = await application.database.currentFacts(id);
      const port = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [
            {
              source_name: "route-a",
              ready: true,
              discover: async () => {
                throw new AcquisitionUnavailableError(
                  "download-unavailable",
                  "the route has no PDF capability for this target",
                  "no-capability",
                );
              },
            },
            {
              source_name: "route-b",
              ready: true,
              discover: async () => {
                throw new AcquisitionRouteError(
                  "source-discovery-failed",
                  "temporary provider failure",
                );
              },
            },
            {
              source_name: BROWSER_ROUTE_NAME,
              ready: false,
              discover: async () => {
                throw new Error(
                  "the Browser source must never run inside the tiered batch",
                );
              },
            },
          ],
          ["route-a", "route-b", BROWSER_ROUTE_NAME],
        ),
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => application.browserHost(),
      });
      // A later miss cannot erase the unresolved failure; Browser still gets a turn.
      await expect(
        port.acquire({
          literature_id: parseLiteratureId(id),
          detail: await application.library.detail(id),
          metadata_snapshot: facts!.metadata_snapshot,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: "route-failure",
        failure: {
          code: "source-discovery-failed",
          retryable: true,
          unavailability: null,
        },
      });
      expect(deliveries).toBe(1);
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a notify policy stop as an explicit not-eligible skip with the stable code on progress", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-assembly-notify-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const id = browserFixtureId(1501);
      await application.database.putLiterature(
        offlineLiterature(id, browserFixtureId(2501)),
      );
      const service = new DatabaseCompletionService({
        library: application.library,
        database: application.database,
        writes: application.writes,
        completion: application.completion,
        acquisition: {
          acquire: async () => ({
            kind: "policy-skip",
            failure: {
              code: "assistance-skipped",
              source: "route-a",
              reason:
                "The target was skipped after a non-terminal failure; notification is advisory only.",
              retryable: false,
            },
          }),
        },
      });
      const progress: string[] = [];
      const report = await service.run(
        {
          selector: {
            kind: "literatures",
            literature_ids: [parseLiteratureId(id)],
          },
          goal: "ASSET_READY",
        },
        {
          on_progress: (item) =>
            progress.push(`${item.state}:${item.failure?.code ?? "-"}`),
        },
      );
      // The notify policy did not continue this eligible target: the report says
      // `skipped`/`not-eligible` (never a failure partition, never a silent success) and
      // the stable `pdf-assistance-skipped` code stays on the progress detail (stderr).
      expect(report.end).toEqual({ kind: "finished" });
      expect(report.failed).toEqual([]);
      expect(report.skipped).toMatchObject([
        { reason: "not-eligible", literature_ids: [id] },
      ]);
      expect(progress).toContain("skipped:pdf-assistance-skipped");
      expect(await application.database.hasAutomaticPdfExhaustion(id)).toBe(
        false,
      );
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
