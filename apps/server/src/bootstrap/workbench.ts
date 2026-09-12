import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  sha256,
  type MetadataSnapshot,
} from "@sciretriever/contracts";
import { join } from "node:path";
import {
  createApplication,
  type Application,
  type ApplicationOptions,
} from "./application.js";
import { BrowserHost } from "../browser/host.js";
import { BrowserNetworkProxy } from "../network/browser-proxy.js";
import { resolveDestination } from "../network/policy.js";
import type { VerifiedCloakRuntime } from "../configuration/cloak-runtime.js";
import { BrowserCandidateIntake } from "../acquisition/browser-intake.js";
import { CandidateAbandonmentError } from "../acquisition/candidate-abandonment.js";
import { TypeScriptConfigurationOwner } from "../configuration/owner.js";
import { createBrowserDecision } from "../browser/decision.js";
import { WorkbenchSession } from "../workbench/session.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../workbench/http.js";
import {
  FIXTURE_DOI,
  FIXTURE_LITERATURE,
  startWorkbenchFixture,
} from "../workbench/synthetic-fixture.js";

/** Explicit synthetic composition: one Application and Network budget, no real Provider or user Profile. */
export async function startSyntheticWorkbench(options: {
  readonly home: string;
  readonly runtime: VerifiedCloakRuntime;
  readonly assets: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
  readonly configurationOwner?: ApplicationOptions["configurationOwner"];
  readonly applicationOptions?: Omit<
    ApplicationOptions,
    "configurationOwner" | "executionSchema"
  >;
}): Promise<{
  readonly origin: string;
  readonly session: WorkbenchSession;
  readonly application: Application;
  close(): Promise<void>;
}> {
  const application = await createApplication(options.home, {
    ...options.applicationOptions,
    executionSchema: "upgrade-synthetic",
    ...(options.configurationOwner
      ? { configurationOwner: options.configurationOwner }
      : {}),
  });
  let fixture: Awaited<ReturnType<typeof startWorkbenchFixture>> | undefined;
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
            disposition: result.assessment.verdict.disposition,
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
      browserReadiness.configured && browserReadiness.missing.length === 0
        ? createBrowserDecision(application.agents)
        : undefined,
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
        disposition: assessment.verdict.disposition,
        publication,
      });
    }
    await session.refresh();
    http = await startWorkbenchHttp({
      session,
      tabs: {
        list: () => host!.listPages(),
        activate: async (pageId) => {
          const next = await host!.activatePage(pageId);
          await session!.activatePage(next);
        },
      },
      ...(application.jobs
        ? {
            jobs: {
              list: (limit) => application.jobs!.listJobs(limit),
              get: (jobId) => application.jobs!.getJob(jobId),
              targets: (jobId, limit) =>
                application.jobs!.listTargets(jobId, limit),
              attempts: (targetId, limit) =>
                application.jobs!.listAttempts(targetId, limit),
              events: (jobId, after, limit) =>
                application.jobs!.listEvents(jobId, after, limit),
              policy: (jobId) => application.jobs!.getPolicy(jobId),
              budget: (jobId) => application.jobs!.getBudget(jobId),
              interventions: (jobId, limit) =>
                application.jobs!.listInterventions(jobId, limit),
              run: (jobId) => application.taskService!.runJob(jobId),
              resolveIntervention: (interventionId, resolution) =>
                application.interventions!.resolve(interventionId, resolution),
              create: (input) => application.jobService!.create(input as never),
              pause: (jobId) => application.queue!.pause(jobId),
              resume: (jobId) => application.queue!.resume(jobId),
              cancel: (jobId) => application.queue!.cancel(jobId),
            },
          }
        : {}),
      configuration:
        options.configurationOwner ??
        new TypeScriptConfigurationOwner(options.home),
      library: {
        queries: application.library,
        artifacts: application.literatureArtifacts,
      },
      assets: options.assets,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    return { origin: http.origin, session, application, close };
  } catch (error) {
    await close();
    throw error;
  }
}
