import { executeMaintenance } from "../entry/maintenance-operations.js";
import { createMetadataOperations } from "../entry/metadata-operations.js";
import { createTaskOperations } from "../entry/task-operations.js";
import { submitProcessor } from "../entry/processor-operations.js";
import { randomUUID } from "node:crypto";
import { authorizeSyntheticCatalog } from "../storage/synthetic-scope.js";
import {
  initializeCatalogSchema,
  inspectCatalogSchema,
} from "../storage/sqlite/catalog-schema.js";
import {
  validateWorkbenchAccess,
  type WorkbenchAccessOptions,
} from "../workbench/access.js";
import {
  canonicalJsonBytes,
  parseLiteratureId,
  sha256,
  type MetadataSnapshot,
} from "@sciretriever/contracts";
import { join, resolve } from "node:path";
import {
  createApplication,
  createQueryApplication,
  type Application,
  type ApplicationOptions,
} from "./application.js";
import { BrowserHost } from "../browser/host.js";
import { BrowserNetworkProxy } from "../network/browser-proxy.js";
import { resolveDestination } from "../network/policy.js";
import type { VerifiedCloakRuntime } from "../configuration/cloak-runtime.js";
import { bundlePreview } from "../configuration/credentials.js";
import { BrowserCandidateIntake } from "../acquisition/browser-intake.js";
import { CandidateAbandonmentError } from "../acquisition/candidate-abandonment.js";
import {
  ConfigurationProbeSession,
  TypeScriptConfigurationOwner,
  type ConfigurationProbeRequest,
  type ConfigurationProbeSeams,
} from "../configuration/owner.js";
import { WorkbenchSession } from "../workbench/session.js";
import { ProductionWorkbenchSession } from "../workbench/production-session.js";
import {
  startQueryOnlyHttp,
  type QueryOnlyHttpOptions,
  startWorkbenchHttp,
  type WorkbenchHttpServer,
  type WorkbenchStaticAsset,
  type WorkbenchRuntimeCapabilities,
  type WorkbenchHttpOptions,
} from "../workbench/http.js";
import {
  loadMaintenanceWorkbenchAssets,
  loadQueryWorkbenchAssets,
  loadWorkbenchAssets,
} from "../workbench/assets.js";
import {
  FIXTURE_DOI,
  FIXTURE_LITERATURE,
  startWorkbenchFixture,
} from "../workbench/synthetic-fixture.js";

export function describeWorkbenchRuntime(
  application: Application,
): WorkbenchRuntimeCapabilities {
  const parsingConfiguration = application.configuration.parsing;
  const remoteParserConfigured =
    parsingConfiguration.connection_mode === "remote" &&
    parsingConfiguration.remote_upload_authorized &&
    parsingConfiguration.base_url !== null &&
    parsingConfiguration.model_identity !== null;
  const loopbackParserConfigured =
    parsingConfiguration.connection_mode === "loopback" &&
    parsingConfiguration.base_url !== null &&
    parsingConfiguration.model_identity !== null;
  const parserConfigured = remoteParserConfigured || loopbackParserConfigured;
  const parserCredentialPresent = (() => {
    if (!remoteParserConfigured || !parsingConfiguration.base_url) return false;
    const origin = new URL(parsingConfiguration.base_url).origin;
    return bundlePreview(application.credentials).sections.some(
      (section) =>
        section.section === "mineru" &&
        section.origin === origin &&
        section.fields.some(
          (field) => field.field === "bearer_token" && field.present,
        ),
    );
  })();
  const parsingAssembled = application.rawParsing !== null;
  const parsingReason: WorkbenchRuntimeCapabilities["parsing"]["unavailable_reason"] =
    parsingAssembled
      ? null
      : !parserConfigured
        ? "configuration-incomplete"
        : remoteParserConfigured && !parserCredentialPresent
          ? "startup-credential-missing"
          : "assembly-unavailable";
  const selectedMetadata = new Set([
    ...application.metadata.topic_selection,
    ...application.metadata.reference_selection,
  ]);
  const acquisitionSelection = application.configuration.sources.acquisition;
  const selectedAcquisition = new Set(
    acquisitionSelection.mode === "custom"
      ? acquisitionSelection.providers
      : application.acquisition.statuses
          .map((status) => status.source_name)
          .filter(
            (source) =>
              source !== "direct" &&
              source !== "doi-landing" &&
              source !== "browser",
          ),
  );
  if (application.configuration.browser.enabled)
    selectedAcquisition.add("browser");

  return {
    parsing: {
      assembled: parsingAssembled,
      unavailable_reason: parsingReason,
    },
    metadata: application.metadata.statuses.map((status) => ({
      provider_name: status.provider_name,
      selected: selectedMetadata.has(status.provider_name),
      assembled: status.ready,
      production_available: status.production_available,
      ready_at_startup: status.ready,
      failure_code: status.failure_code,
    })),
    acquisition: application.acquisition.statuses.map((status) => ({
      source_name: status.source_name,
      selected: selectedAcquisition.has(status.source_name),
      assembled: status.ready,
      ready_at_startup: status.ready,
      failure_code: status.failure_code,
    })),
  };
}

function configurationHttpAdapter(
  application: Application,
  owner: TypeScriptConfigurationOwner,
  probeSeams: ConfigurationProbeSeams = {},
): NonNullable<WorkbenchHttpOptions["configuration"]> {
  return {
    runtime_revision: application.configuration_revision,
    runtime_capabilities: describeWorkbenchRuntime(application),
    status: (signal) => owner.status(signal),
    read: (signal) => owner.read(signal),
    diff: (payload, baseline, signal) => owner.diff(payload, baseline, signal),
    publish: (payload, baseline, sections, signal) =>
      owner.publish(payload, baseline, sections, signal),
    publishConfiguration: (configuration, baseline, sections, signal) =>
      owner.publishConfiguration(configuration, baseline, sections, signal),
    probe: async (request, signal) => {
      const probe = await ConfigurationProbeSession.create(owner, probeSeams);
      try {
        return await probe.run(request as ConfigurationProbeRequest, {
          authorized: true,
          ...(signal ? { signal } : {}),
        });
      } finally {
        probe.close();
      }
    },
    credential: (edit, baseline, signal) =>
      owner.credential(edit, baseline, signal),
  };
}

/** HTTP adapters use the one Application-owned durable runtime for both task generations. */
export function taskHttpAdapters(
  app: Application,
): Pick<WorkbenchHttpOptions, "tasks" | "jobs"> {
  const repository = app.jobs;
  const runtime = app.processingTasks;
  if (!repository || !runtime || !app.jobService || !app.interventions)
    return {};
  const tasks = createTaskOperations(app);
  if (!tasks) return {};
  return {
    tasks,
    jobs: {
      list: (limit) => repository.listJobs(limit),
      get: (id) => repository.getJob(id),
      targets: (id, limit) => repository.listTargets(id, limit),
      attempts: (id, limit) => repository.listAttempts(id, limit),
      events: (id, after, limit) => repository.listEvents(id, after, limit),
      policy: (id) => repository.getPolicy(id),
      budget: (id) => repository.getBudget(id),
      interventions: (id, limit) => repository.listInterventions(id, limit),
      run: (id, signal) => runtime.runResults(id, signal),
      resolveIntervention: (id, resolution) =>
        app.interventions!.resolve(id, resolution),
      create: (input) =>
        app.jobService!.create(
          input as Parameters<
            NonNullable<Application["jobService"]>["create"]
          >[0],
        ),
      pause: async (id) => (await runtime.control(id, "pause")).job,
      resume: async (id) => (await runtime.control(id, "resume")).job,
      cancel: async (id) => (await runtime.control(id, "cancel")).job,
    },
  };
}

/** Explicit writes share the same processor application boundary as CLI and MCP. */
export function processorHttpAdapters(
  app: Application,
): Pick<QueryOnlyHttpOptions, "submitProcessor" | "archiveOperation"> {
  return {
    archiveOperation: (operation, request, signal) =>
      executeMaintenance(app, operation, request, signal),
    submitProcessor: (request, start, signal) =>
      submitProcessor(app, request, start, signal),
  };
}

/** Explicit query-only Web entry. It never constructs the Browser/Jobs Application. */
export async function startQueryOnlyWorkbench(options: {
  readonly home: string;
  readonly assets?: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
}): Promise<{
  readonly origin: string;
  readonly application: Awaited<ReturnType<typeof createQueryApplication>>;
  close(): Promise<void>;
}> {
  const application = await createQueryApplication(options.home);
  let http: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await http?.close();
      } finally {
        await application.close();
      }
    })());
  try {
    const assets = options.assets ?? (await loadQueryWorkbenchAssets());
    const httpOptions: QueryOnlyHttpOptions = {
      application,
      assets,
      ...(options.port === undefined ? {} : { port: options.port }),
    };
    http = await startQueryOnlyHttp(httpOptions);
    return { origin: http.origin, application, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Maintenance Web entry. It assembles the catalog owners without starting a Browser session. */
export async function startMaintenanceWorkbench(options: {
  readonly home: string;
  readonly assets?: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
}): Promise<{
  readonly origin: string;
  readonly application: Application;
  close(): Promise<void>;
}> {
  const application = await createApplication(options.home, {});
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let http: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    closing = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void (async () => {
      const failures: unknown[] = [];
      for (const resource of [http, query, application]) {
        try {
          await resource?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        reject(new AggregateError(failures, "maintenance shutdown failed"));
      else resolve();
    })();
    return closing;
  };
  try {
    if (!application.maintenance)
      throw new Error("maintenance intake unavailable");
    query = await createQueryApplication(options.home);
    if (query.readiness.status !== "ready")
      throw new Error("maintenance query unavailable");
    http = await startQueryOnlyHttp({
      application: query,
      maintenance: application.maintenance,
      ...processorHttpAdapters(application),
      assets: options.assets ?? (await loadMaintenanceWorkbenchAssets()),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    return { origin: http.origin, application, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "maintenance startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Explicit production Browser workbench. A view alone never starts acquisition. */
export async function startProductionWorkbench(options: {
  readonly home: string;
  readonly access?: WorkbenchAccessOptions;
  readonly literature_id?: string;
  readonly assets?: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
  readonly applicationOptions?: Omit<
    ApplicationOptions,
    "browserCollaboration"
  >;
  /** Test/operator probe seam; production defaults to the Configuration owner probe. */
  readonly configurationProbeSeams?: ConfigurationProbeSeams;
}): Promise<
  WorkbenchHttpServer & {
    readonly session: ProductionWorkbenchSession;
    readonly application: Application;
  }
> {
  validateWorkbenchAccess(options.access ?? {});
  const literatureId =
    options.literature_id === undefined
      ? null
      : parseLiteratureId(options.literature_id);
  const configurationOwner =
    options.applicationOptions?.configurationOwner ??
    new TypeScriptConfigurationOwner(options.home);
  if (configurationOwner.home !== resolve(options.home))
    throw new Error("workbench configuration identity mismatch");
  let application: Application | undefined;
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  const session = new ProductionWorkbenchSession(literatureId, undefined);
  let http: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    closing = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void (async () => {
      const failures: unknown[] = [];
      // Abort and drain foreground HTTP work while its owners and catalog remain open.
      // Detached durable tasks are cancelled by Application.close below.
      try {
        await http?.close();
      } catch (error) {
        failures.push(error);
      }
      const settled = await Promise.allSettled([
        Promise.resolve().then(() => session.close()),
        Promise.resolve().then(() => application?.close()),
        Promise.resolve().then(() => query?.close()),
      ]);
      for (const result of settled)
        if (result.status === "rejected") failures.push(result.reason);
      if (failures.length)
        reject(
          new AggregateError(failures, "production workbench shutdown failed"),
        );
      else resolve();
    })();
    return closing;
  };
  try {
    const configuration = await configurationOwner.ensureStoragePaths();
    const startupCatalog = resolve(
      configuration.configuration.paths.catalog_path!,
    );
    // Only an absent target can be initialized. Existing catalogs retain their
    // schema and facts; the ordinary Application gate still validates them.
    if (
      (await inspectCatalogSchema(startupCatalog)).status === "not-initialized"
    )
      await initializeCatalogSchema(startupCatalog);
    application = await createApplication(options.home, {
      ...options.applicationOptions,
      configurationOwner,

      browserCollaboration: session,
    });
    const app = application;
    if (!app.databaseCompletion)
      throw new Error("database completion unavailable");
    session.bindOperation(
      (articleId, signal, feedback) =>
        app.databaseCompletion!.run(
          {
            selector: {
              kind: "literatures",
              literature_ids: [parseLiteratureId(articleId)],
            },
            goal: "ASSET_READY",
          },
          { signal, on_scope: feedback.scope, on_progress: feedback.progress },
        ),
      async (articleId) => {
        const asset = (await app.library.detail(articleId)).primary_pdf?.asset;
        if (!asset) return null;
        await app.literatureArtifacts.withArtifact(asset, async (chunks) => {
          for await (const _chunk of chunks) void _chunk;
        });
        return { sha256: asset.sha256, size_bytes: asset.size_bytes };
      },
    );
    const catalogPath = resolve(
      app.configuration.paths.catalog_path ?? join(app.home, "catalog.sqlite"),
    );
    const artifactRoot = resolve(
      app.configuration.paths.artifact_root ?? join(app.home, "artifacts"),
    );
    query = await createQueryApplication(options.home, {
      catalog_path: catalogPath,
      artifact_root: artifactRoot,
    });
    if (query.readiness.status !== "ready")
      throw new Error("workbench query unavailable");
    http = await startWorkbenchHttp({
      ...(options.access ? { access: options.access } : {}),
      session,
      acquisition: session,
      ...taskHttpAdapters(app),
      ...createMetadataOperations(app),
      query: {
        application: query,
        ...(app.maintenance
          ? {
              maintenance: app.maintenance,
              ...processorHttpAdapters(app),
            }
          : {}),
      },
      workspace: {
        catalog_path: catalogPath,
        artifact_root: artifactRoot,
        schema_version: query.readiness.schema_version,
        configuration_revision: app.configuration_revision,
        capabilities: {
          tasks: !!app.processingTasks,
          query: true,
          maintenance: !!app.maintenance,
          discovery: true,
          import: true,
        },
        runtime_capabilities: describeWorkbenchRuntime(app),
      },
      assets: options.assets ?? (await loadWorkbenchAssets()),
      ...(options.port === undefined ? {} : { port: options.port }),
      library: { queries: app.library, artifacts: app.literatureArtifacts },
      ...(app.maintenance ? { maintenance: app.maintenance } : {}),
      configuration: configurationHttpAdapter(
        app,
        configurationOwner,
        options.configurationProbeSeams,
      ),
    });
    return { ...http, session, application: app, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "production workbench startup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Explicit synthetic composition: one Application and Network budget, no real Provider or user Profile. */
export async function startSyntheticWorkbench(options: {
  readonly home: string;
  readonly access?: WorkbenchAccessOptions;
  readonly runtime: VerifiedCloakRuntime;
  readonly assets: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
  readonly configurationOwner?: ApplicationOptions["configurationOwner"];
  readonly applicationOptions?: Omit<ApplicationOptions, "configurationOwner">;
}): Promise<
  WorkbenchHttpServer & {
    readonly session: WorkbenchSession;
    readonly application: Application;
  }
> {
  const configurationOwner =
    options.configurationOwner ??
    new TypeScriptConfigurationOwner(options.home);
  const configuration = await configurationOwner.ensureStoragePaths();
  const catalog = resolve(configuration.configuration.paths.catalog_path!);
  // Fixture startup retains the independent synthetic-location check, then uses
  // the same current catalog initialization and runtime path as the formal Web.
  await authorizeSyntheticCatalog(catalog);
  if ((await inspectCatalogSchema(catalog)).status === "not-initialized")
    await initializeCatalogSchema(catalog);
  const application = await createApplication(options.home, {
    ...options.applicationOptions,

    configurationOwner,
  });
  let fixture: Awaited<ReturnType<typeof startWorkbenchFixture>> | undefined;
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let proxy: BrowserNetworkProxy | undefined;
  let host: BrowserHost | undefined;
  let session: WorkbenchSession | undefined;
  let http: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const errors: unknown[] = [];
      // Dependencies close in reverse ownership order, even if one close fails.
      for (const resource of [
        http,
        session,
        host,
        proxy,
        fixture,
        query,
        application,
      ]) {
        try {
          await resource?.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new Error("workbench shutdown failed");
    })();
    return closePromise;
  };
  try {
    if (
      !(await application.database.getLiterature(
        FIXTURE_LITERATURE.literature_id,
      ))
    )
      await application.database.putLiterature(FIXTURE_LITERATURE);
    fixture = await startWorkbenchFixture();
    const port = Number(new URL(fixture.origin).port);
    const resolver = () => ["127.0.0.1"];
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: [{ scheme: "http" as const, port }],
    };
    proxy = new BrowserNetworkProxy({
      resolver,
      policy,
      coordinator: application.networkBudget,
      limits: {
        maxConcurrency: 4,
        maxHostConcurrency: 4,
        maxResponseBytes: 16 * 1024 * 1024,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const connection = await proxy.start();
    const sessionId = `session-${randomUUID()}`;
    const target: { articleId: string; identifier: string; version: string } = {
      articleId: FIXTURE_LITERATURE.literature_id,
      identifier: `doi:${FIXTURE_DOI}`,
      version: "published",
    };
    const snapshots = new Map<string, MetadataSnapshot>();
    const receiptId = async (
      transferId: string,
      articleId = target.articleId,
    ) =>
      `workbench-${await sha256(canonicalJsonBytes({ article_id: articleId, transfer_id: transferId }))}`;
    let intake = new BrowserCandidateIntake(application.execution!.transfers, {
      article_id: target.articleId,
      identifier: target.identifier,
      version: target.version,
    });
    host = new BrowserHost({
      runtime: options.runtime,
      profile: join(options.home, "profile"),
      proxy: connection,
      admitNavigation: async (url) => {
        if (new URL(url).origin !== fixture!.origin)
          throw new Error("fixture origin required");
        return (await resolveDestination(url, resolver, policy)).url.url;
      },
      transfers: {
        captureContext: (page_id, document_generation, source_url) => ({
          session_id: sessionId,
          article_id: target.articleId,
          page_id,
          document_generation,
          source_url,
          captured_at: new Date().toISOString(),
        }),
        receive: async (input) => {
          const result = await intake.receive(input);
          const facts = await application.database.currentFacts(
            target.articleId,
          );
          if (!facts) throw new Error("fixture literature unavailable");
          snapshots.set(result.candidate.transfer_id, facts.metadata_snapshot);
          session?.candidateReady({
            transfer_id: result.candidate.transfer_id,
            sha256: result.candidate.sha256,
            size_bytes: result.candidate.size_bytes,
            page_count: result.assessment.page_count,
            disposition: "accepted",
            publication: null,
          });
        },
        started: () => {
          session?.transferStarted();
        },
        failed: () => {
          session?.transferFailed();
          application.logger.warn("browser-transfer-failed");
        },
      },
    });
    await host.start();
    const page = await host.openPage(`${fixture.origin}/article`);
    const browserReadiness = application.agents.readiness("browser");
    session = new WorkbenchSession(
      target.articleId,
      page,
      {
        max_actions: 1000,
        max_model_calls: 100,
        max_retries: 10,
        max_bytes: 64 * 1024 * 1024,
        deadline_ms: 3600000,
      },
      undefined,
      sessionId,
      () => host!.close(),
      async (candidate, signal) => {
        const metadata_snapshot = snapshots.get(candidate.transfer_id);
        if (!metadata_snapshot)
          throw new Error("candidate snapshot unavailable");
        return application.execution!.acceptance.accept(
          {
            receipt_id: await receiptId(candidate.transfer_id),
            literature_id: target.articleId,
            transfer_id: candidate.transfer_id,
            metadata_snapshot,
          },
          signal,
        );
      },
      async (articleId) => {
        const facts = await application.database.currentFacts(articleId);
        if (!facts) throw new Error("target literature unavailable");
        const identifier =
          facts.literature.metadata.identifiers.find(
            (value) => value.namespace === "doi",
          ) ?? facts.literature.metadata.identifiers[0];
        if (!identifier) throw new Error("target literature has no identifier");
        if (!page.navigate) throw new Error("browser navigation unavailable");
        await page.navigate(`${fixture!.origin}/article`);
        target.articleId = articleId;
        target.identifier = `${identifier.namespace}:${identifier.value}`;
        target.version = facts.literature.version_role;
        intake = new BrowserCandidateIntake(application.execution!.transfers, {
          article_id: target.articleId,
          identifier: target.identifier,
          version: target.version,
        });
      },
      async (candidate, signal) => {
        try {
          await application.execution!.abandonment.abandon(
            {
              article_id: target.articleId,
              transfer_id: candidate.transfer_id,
              sha256: candidate.sha256,
            },
            signal,
          );
        } catch (error) {
          if (
            !(
              error instanceof CandidateAbandonmentError &&
              error.catalog_committed
            )
          )
            throw error;
          application.logger.warn("candidate-reclamation-pending");
        }
        snapshots.delete(candidate.transfer_id);
      },
      false,
      undefined,
      browserReadiness.configured && browserReadiness.missing.length === 0
        ? application.browserCapability
        : undefined,
    );
    for (const candidate of await application.database.listCandidates(
      target.articleId,
    )) {
      const { assessment } = await intake.assess(candidate);
      const receipt = await receiptId(candidate.transfer_id);
      const intent = await application.database.getReceiptIntent(receipt);
      const publication = await application.database.getReceiptResult(receipt);
      const facts = await application.database.currentFacts(target.articleId);
      if (!facts) throw new Error("fixture literature unavailable");
      if (publication)
        await application.execution!.transfers.verifyPublished(
          candidate,
          publication.reference,
        );
      snapshots.set(
        candidate.transfer_id,
        intent?.metadata_snapshot ?? facts.metadata_snapshot,
      );
      session.candidateReady({
        transfer_id: candidate.transfer_id,
        sha256: candidate.sha256,
        size_bytes: candidate.size_bytes,
        page_count: assessment.page_count,
        disposition: "accepted",
        publication,
      });
    }
    await session.refresh();
    query = await createQueryApplication(options.home);
    http = await startWorkbenchHttp({
      ...(options.access ? { access: options.access } : {}),
      session,
      query: { application: query },
      ...(application.maintenance
        ? { maintenance: application.maintenance }
        : {}),
      tabs: {
        list: () => host!.listPages(),
        activate: async (pageId) => {
          const next = await host!.activatePage(pageId);
          await session!.activatePage(next);
        },
      },
      ...taskHttpAdapters(application),
      configuration: configurationHttpAdapter(application, configurationOwner),
      library: {
        queries: application.library,
        artifacts: application.literatureArtifacts,
      },
      assets: options.assets,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    return { ...http, session, application, close };
  } catch (error) {
    await close();
    throw error;
  }
}
