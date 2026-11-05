import { selectedEgress } from "./egress.js";
import { isProxyUnavailable } from "../network/egress.js";
import { RestartAdmission } from "../application/restart-admission.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSourceTestRequest,
  parseSourceTestAllRequest,
  parseSourceTestResult,
  type SourceTestTarget,
  type SourceTestTicket,
  type SourceTestResult,
  type SourceTestCheck,
} from "@sciretriever/contracts";
import {
  assembleMetadataRegistry,
  type MetadataAssemblyOptions,
} from "../metadata/assembly.js";
import {
  assemblePublicAcquisitionRegistry,
  assemblePublicPdfDownloadTransport,
  type PublicAcquisitionAssemblyOptions,
} from "../acquisition/assembly.js";
import { acceptPdf } from "../acquisition/pdf-acceptance.js";
import { fetchPdfResponse } from "../acquisition/sources/public.js";
import {
  AcquisitionCandidateSkippedError,
  AcquisitionRouteError,
  AcquisitionUnavailableError,
} from "../acquisition/tiered.js";
import { BrowserHost } from "../browser/host.js";
import { resolveVerifiedCloakRuntime } from "../browser/production-host.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import {
  observeNetworkRequests,
  observeNetworkBytes,
} from "../network/request-activity.js";
import { NetworkHttpError } from "../network/http.js";
import { AuthorizedProviderError } from "../providers/shared/authorized-pdf.js";
import { BUILTIN_SCI_HUB_MIRROR_URLS } from "../providers/sci-hub/definition.js";
import { LITERATURE_PROVIDERS } from "../providers/registry.js";
import {
  SourceConfigurationOwner,
  SourceConfigurationError,
  sourceDetails,
  hasSourceField,
} from "./sources.js";
import { SOURCE_METHOD_VERSION } from "./source-state.js";

export interface SourceProbeSeams {
  readonly metadata?: MetadataAssemblyOptions;
  readonly acquisition?: PublicAcquisitionAssemblyOptions;
  readonly browser?: (signal: AbortSignal) => Promise<void>;
  readonly timeout_ms?: number;
}
class SourceBrowserUnavailableError extends Error {}
interface ProbeRun {
  ticket: SourceTestTicket;
  controller: AbortController;
  done: Promise<SourceTestResult>;
  state: "queued" | "running" | "cancelled";
}
/** Process-owned dispatcher. All sources share the application's Network coordinator. */
export class SourceProbeService {
  private readonly runs = new Map<SourceTestTarget, ProbeRun>();
  private readonly requests = new Map<
    string,
    { signature: string; tickets: readonly SourceTestTicket[] }
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private accepting: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** A lifecycle owner supplies an activity permit for the full probe, not just the HTTP request. */
  background: <T>(work: () => Promise<T>) => Promise<{ promise: Promise<T> }>;
  readonly coordinator: NetworkBudgetCoordinator;
  private readonly ownsNetwork: boolean;
  constructor(
    readonly sources: SourceConfigurationOwner,
    coordinator: NetworkBudgetCoordinator | undefined = undefined,
    readonly seams: SourceProbeSeams = {},
  ) {
    this.coordinator = coordinator ?? new NetworkBudgetCoordinator();
    this.ownsNetwork = coordinator === undefined;
    sources.tests = this;
    const gate = new RestartAdmission(sources.owner.home);
    this.background = (work) => gate.background(work);
  }
  slot(source: SourceTestTarget) {
    const r = this.runs.get(source);
    return r
      ? {
          state: r.state,
          test_id: r.ticket.test_id,
          source_revision: r.ticket.source_revision,
        }
      : null;
  }
  get activeCount(): number {
    return this.pending.size;
  }
  async test(value: unknown): Promise<SourceTestTicket> {
    const r = parseSourceTestRequest(value);
    return this.sources.admission(() =>
      this.start(r.source, r.source_revision, r.request_id),
    );
  }
  async start(
    source: SourceTestTarget,
    revision: string,
    requestId: string,
  ): Promise<SourceTestTicket> {
    return this.accept(() => this.startAccepted(source, revision, requestId));
  }
  private accept<T>(work: () => Promise<T>): Promise<T> {
    const result = this.accepting.then(work);
    this.accepting = result.catch(() => undefined);
    return result;
  }
  private async startAccepted(
    source: SourceTestTarget,
    revision: string,
    requestId: string,
  ): Promise<SourceTestTicket> {
    if (this.closed || source === "plos")
      throw new SourceConfigurationError("source-test-unavailable");
    const signature = JSON.stringify([source, revision]);
    const old = this.requests.get(requestId);
    if (old) {
      if (old.signature !== signature)
        throw new SourceConfigurationError("source-test-conflict");
      return old.tickets[0]!;
    }
    if ((await this.sources.testRevision(source)) !== revision)
      throw new SourceConfigurationError("source-test-conflict");
    const active = this.runs.get(source);
    if (
      active &&
      active.state !== "cancelled" &&
      active.ticket.source_revision === revision
    ) {
      this.remember(requestId, signature, [active.ticket]);
      return active.ticket;
    }
    const ticket: SourceTestTicket = {
      test_id: randomUUID(),
      source,
      source_revision: revision,
      state: "queued",
    };
    const controller = new AbortController();
    const run: ProbeRun = {
      ticket,
      controller,
      state: "queued",
      done: Promise.resolve(null as never),
    };
    this.runs.set(source, run);
    // Queued probes already own their activity before returning their receipt.
    let admitted: { promise: Promise<SourceTestResult> };
    try {
      admitted = await this.background(async () => {
        const result = await this.execute(run);
        if (run.state !== "cancelled") await this.sources.acceptTest(result);
        return result;
      });
    } catch (error) {
      if (this.runs.get(source) === run) this.runs.delete(source);
      throw error;
    }
    this.remember(requestId, signature, [ticket]);
    run.done = admitted.promise.finally(() => {
      if (this.runs.get(source) === run && run.state !== "cancelled")
        this.runs.delete(source);
      this.pending.delete(run.done);
    });
    // An owner/cache failure is observed by wait()/close(); never becomes an unhandled rejection.
    void run.done.catch(() => undefined);
    this.pending.add(run.done);
    return ticket;
  }
  private remember(
    id: string,
    signature: string,
    tickets: readonly SourceTestTicket[],
  ) {
    if (this.requests.size >= 256)
      this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(id, { signature, tickets });
  }
  async all(value: unknown): Promise<{ tickets: readonly SourceTestTicket[] }> {
    if (this.closed)
      throw new SourceConfigurationError("source-test-unavailable");
    const r = parseSourceTestAllRequest(value);
    return this.sources.admission(() =>
      this.accept(async () => {
        if (this.closed)
          throw new SourceConfigurationError("source-test-unavailable");
        const old = this.requests.get(r.request_id),
          signature = JSON.stringify(["all", r.catalog_revision]);
        if (old) {
          if (old.signature !== signature)
            throw new SourceConfigurationError("source-test-conflict");
          return { tickets: old.tickets };
        }
        const directory = await this.sources.directory();
        if (directory.catalog_revision !== r.catalog_revision)
          throw new SourceConfigurationError(
            "source-configuration-conflict",
            directory.catalog_revision,
          );
        const targets: SourceTestTarget[] = [
          ...directory.rows
            .filter((row) => row.test.availability === "ready")
            .map((row) => row.source),
          "browser",
        ];
        const tickets: SourceTestTicket[] = [];
        // Register every ticket now, but serialize the actual work. Existing shared cooldowns remain effective.
        let previous: Promise<unknown> = Promise.allSettled([...this.pending]);
        for (const source of targets) {
          const revision = await this.sources.testRevision(source),
            existing = this.runs.get(source);
          if (
            existing?.ticket.source_revision === revision &&
            existing.state !== "cancelled"
          ) {
            tickets.push(existing.ticket);
            previous = Promise.allSettled([previous, existing.done]);
            continue;
          }
          const ticket: SourceTestTicket = {
            test_id: randomUUID(),
            source,
            source_revision: revision,
            state: "queued",
          };
          const run: ProbeRun = {
            ticket,
            controller: new AbortController(),
            state: "queued",
            done: Promise.resolve(null as never),
          };
          this.runs.set(source, run);
          tickets.push(ticket);
          const predecessor = previous;
          let admitted: { promise: Promise<SourceTestResult> };
          try {
            admitted = await this.background(async () => {
              await predecessor;
              const result = await this.execute(run);
              if (run.state !== "cancelled")
                await this.sources.acceptTest(result);
              return result;
            });
          } catch (error) {
            if (this.runs.get(source) === run) this.runs.delete(source);
            throw error;
          }
          run.done = admitted.promise.finally(() => {
            if (this.runs.get(source) === run && run.state !== "cancelled")
              this.runs.delete(source);
            this.pending.delete(run.done);
          });
          void run.done.catch(() => undefined);
          this.pending.add(run.done);
          previous = run.done.catch(() => undefined);
        }
        this.remember(r.request_id, signature, tickets);
        return { tickets };
      }),
    );
  }
  async wait(source: SourceTestTarget): Promise<SourceTestResult | null> {
    return this.runs.get(source)?.done ?? null;
  }
  async settle(): Promise<void> {
    await Promise.all([...this.pending]);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.accepting;
    for (const run of this.runs.values()) {
      run.state = "cancelled";
      run.controller.abort();
    }
    const results = await Promise.allSettled(this.pending);
    if (this.ownsNetwork) this.coordinator.close();
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected")
      throw new Error("source-probe-close-failed", { cause: failure.reason });
  }
  private async execute(run: ProbeRun): Promise<SourceTestResult> {
    let received = 0;
    const result = await observeNetworkBytes(
      (n) => {
        received += n;
      },
      () => this.executeMeasured(run),
    );
    return parseSourceTestResult({
      ...result,
      received_bytes: Math.max(result.received_bytes, received),
    });
  }
  private async executeMeasured(run: ProbeRun): Promise<SourceTestResult> {
    const started = Date.now(),
      { source, source_revision, test_id } = run.ticket;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      run.controller.abort();
    }, this.seams.timeout_ms ?? 90_000);
    const signal = run.controller.signal;
    if (run.state !== "cancelled") run.state = "running";
    let egress: import("@sciretriever/contracts").NetworkEgress = "direct";
    const checks: SourceTestCheck[] = [];
    let requests = 0,
      bytes = 0,
      browser = false;
    let status: SourceTestResult["status"] = "available";
    const base = (purpose: SourceTestCheck["purpose"]): SourceTestCheck => ({
      purpose,
      egress,
      result: "not-exercised",
      requested: false,
      pdf_validated: false,
      authentication: "not-attempted",
      fixture_entitlement: "not-proven",
      technical_details: sourceDetails(),
    });
    try {
      if (signal.aborted) throw new Error("cancelled");
      const snap = await this.sources.snapshot();
      egress = selectedEgress(
        snap.current.configuration.network,
        source === "browser"
          ? { kind: "browser" }
          : { kind: "source", id: source },
      );
      if ((await this.sources.testRevision(source, snap)) !== source_revision)
        throw new SourceConfigurationError("source-test-conflict");
      if (source === "browser") {
        await (this.seams.browser ?? launchSourceBrowser)(signal);
        browser = true;
        checks.push({
          ...base("runtime"),
          result: "ok",
          authentication: "not-required",
        });
      } else {
        const def = LITERATURE_PROVIDERS[source]!,
          fixture = def.sourceFixture;
        if (!fixture) {
          checks.push({
            ...base("lookup"),
            result: "not-applicable",
            technical_details: sourceDetails(
              "source-test-not-supported",
              "test",
            ),
          });
        } else {
          const registry = assembleMetadataRegistry(
            snap.current.configuration,
            snap.bundle,
            this.coordinator,
            {
              ...this.seams.metadata,
              signal,
              maxRetries: 0,
              currentCredential: (request) =>
                this.sources.owner.authorizeCurrentCredential(request),
            },
          );
          if (def.metadata.includes("lookup")) {
            const check = base("lookup"),
              readiness = registry.statuses.find(
                (s) => s.provider_name === source,
              );
            if (!readiness?.ready) {
              status = "not-configured";
              checks.push({
                ...check,
                technical_details: sourceDetails(
                  "source-test-missing-configuration",
                  "metadata",
                ),
              });
            } else {
              let localRequests = 0;
              const result = await observeNetworkRequests(
                () => {
                  requests++;
                  localRequests++;
                },
                () =>
                  registry.service.lookupProvider(
                    {
                      provider_name: source,
                      key: {
                        record_id: fixture.record_id,
                        identifiers: fixture.identifiers,
                      },
                      scan_limit: 1,
                    },
                    signal,
                  ),
              );
              const code = result.failure?.code;
              const failed =
                result.outcome === "FAILED" || result.outcome === "INTERRUPTED";
              const authenticated = def.credentialFields.some((f) =>
                hasSourceField(snap.preview, source, f),
              );
              const rejected =
                authenticated && code === "metadata-provider-authentication";
              if (failed) status = rejected ? "credential-invalid" : "error";
              checks.push({
                ...check,
                requested: localRequests > 0,
                result: failed
                  ? "error"
                  : result.observations.length
                    ? "ok"
                    : "empty",
                authentication: rejected
                  ? "rejected"
                  : authenticated
                    ? "not-proven"
                    : "not-required",
                technical_details: sourceDetails(
                  failed ? safeProbeCode(code) : undefined,
                  "metadata",
                ),
              });
            }
          }
          if (["public", "authorized-api"].includes(def.acquisition)) {
            const check = base("pdf");
            let localRequests = 0;
            try {
              const configuration = {
                ...snap.current.configuration,
                sources: {
                  ...snap.current.configuration.sources,
                  acquisition: {
                    ...snap.current.configuration.sources.acquisition,
                    mode: "custom" as const,
                    providers: [source],
                    ...(source === "sci-hub"
                      ? {
                          sci_hub: {
                            urls: [
                              (
                                snap.current.configuration.sources.acquisition
                                  .sci_hub?.urls as string[] | undefined
                              )?.[0] ?? BUILTIN_SCI_HUB_MIRROR_URLS[0],
                            ],
                          },
                        }
                      : {}),
                  },
                },
              };
              const options = {
                ...this.seams.acquisition,
                network: snap.current.configuration.network,
                credentials: snap.bundle,
                currentCredential: (
                  request: Parameters<
                    NonNullable<
                      PublicAcquisitionAssemblyOptions["currentCredential"]
                    >
                  >[0],
                ) => this.sources.owner.authorizeCurrentCredential(request),
              };
              const acquisition = assemblePublicAcquisitionRegistry(
                  configuration,
                  this.coordinator,
                  options,
                ),
                port = acquisition.sources.find(
                  (s) => s.source_name === source,
                );
              if (!port) {
                status = "not-configured";
                checks.push({
                  ...check,
                  technical_details: sourceDetails(
                    "source-test-missing-configuration",
                    "pdf",
                  ),
                });
              } else {
                const downloaded = await observeNetworkRequests(
                  () => {
                    requests++;
                    localRequests++;
                  },
                  async () => {
                    const candidates = await port.discover(
                      {
                        identifiers: fixture.identifiers,
                        landing_origins:
                          source === "wiley"
                            ? ["https://onlinelibrary.wiley.com"]
                            : source === "elsevier"
                              ? ["https://www.sciencedirect.com"]
                              : [],
                      },
                      signal,
                    );
                    const candidate = candidates[0];
                    if (!candidate) return null;
                    if (port.download_candidate) {
                      const result = await port.download_candidate(
                        candidate,
                        signal,
                      );
                      return result?.kind === "download" ? result.bytes : null;
                    }
                    return (
                      await fetchPdfResponse(
                        candidate,
                        assemblePublicPdfDownloadTransport(
                          candidate,
                          this.coordinator,
                          options,
                        ),
                        signal,
                      )
                    ).body;
                  },
                );
                if (downloaded) {
                  if (downloaded.byteLength > 64 * 1024 * 1024)
                    throw new Error("limit");
                  bytes += downloaded.byteLength;
                  await acceptPdf(downloaded, 10_000, signal);
                }
                checks.push({
                  ...check,
                  requested: localRequests > 0,
                  result: downloaded ? "ok" : "empty",
                  pdf_validated: !!downloaded,
                  authentication:
                    def.acquisition === "authorized-api"
                      ? downloaded
                        ? "accepted"
                        : "not-proven"
                      : "not-required",
                  fixture_entitlement: downloaded ? "granted" : "not-proven",
                  technical_details: sourceDetails(
                    source === "sci-hub" ? "first-mirror-only" : undefined,
                    "pdf",
                  ),
                });
              }
            } catch (error) {
              const problem = probeFailure(error, localRequests > 0);
              status = problem.status;
              checks.push({
                ...check,
                result: "error",
                requested: localRequests > 0,
                authentication: problem.authentication,
                fixture_entitlement:
                  problem.status === "no-fulltext-permission"
                    ? "denied"
                    : "not-proven",
                technical_details: sourceDetails(problem.code, "pdf"),
              });
            }
          }
        }
      }
    } catch (error) {
      status =
        error instanceof SourceBrowserUnavailableError
          ? "not-configured"
          : "error";
      checks.push({
        ...base(source === "browser" ? "runtime" : "lookup"),
        result: "error",
        technical_details: sourceDetails(
          signal.aborted
            ? timedOut
              ? "source-test-timeout"
              : "source-test-cancelled"
            : error instanceof SourceBrowserUnavailableError
              ? "browser-runtime-unavailable"
              : "source-test-failed",
          "test",
        ),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (signal.aborted) {
      status = "error";
    }
    // A successful second capability must not hide a failure in the first.
    if (checks.some((c) => c.result === "error") && status === "available")
      status = "error";
    return parseSourceTestResult({
      test_id,
      egress,
      source,
      source_revision,
      method_version: SOURCE_METHOD_VERSION,
      started_at: new Date(started).toISOString(),
      finished_at: new Date().toISOString(),
      elapsed_ms: Date.now() - started,
      status,
      checks,
      requests_started: requests,
      received_bytes: bytes,
      browser_launched: browser,
      library_written: false,
      assets_published: false,
      technical_details: sourceDetails(
        signal.aborted
          ? timedOut
            ? "source-test-timeout"
            : "source-test-cancelled"
          : undefined,
        "test",
      ),
    });
  }
}
const SAFE_PROBE_CODES = new Set([
  "proxy-unavailable",
  "metadata-provider-authentication",
  "metadata-provider-authorization",
  "metadata-provider-rate-limited",
  "metadata-provider-unavailable",
  "metadata-provider-http",
  "metadata-provider-response-invalid",
  "metadata-network-timeout",
  "metadata-network-cancelled",
  "metadata-network-budget",
  "metadata-network-policy",
  "metadata-provider-protocol",
  "metadata-provider-response-schema",
]);
function safeProbeCode(code: string | undefined): string {
  return code && SAFE_PROBE_CODES.has(code) ? code : "source-protocol-failed";
}
export function probeFailure(
  error: unknown,
  requested: boolean,
): {
  status: SourceTestResult["status"];
  code: string;
  authentication: SourceTestCheck["authentication"];
} {
  if (isProxyUnavailable(error))
    return {
      status: "error",
      code: "proxy-unavailable",
      authentication: "not-proven",
    };
  let current = error;
  for (
    let i = 0;
    i < 5 && current instanceof Error;
    i++, current = current.cause
  ) {
    if (current instanceof AuthorizedProviderError) {
      const f = current.failure;
      const rejected =
        requested &&
        f.code === "authentication" &&
        (f.http_status === 401 || f.authentication === "rejected");
      const entitled =
        requested &&
        f.authentication === "accepted" &&
        f.fulltext_permission === "denied";
      return {
        status: rejected
          ? "credential-invalid"
          : entitled
            ? "no-fulltext-permission"
            : "error",
        code: `source-pdf-${f.code}`,
        authentication: rejected
          ? "rejected"
          : entitled
            ? "accepted"
            : "not-proven",
      };
    }
  }
  const code =
    error instanceof NetworkHttpError
      ? "source-network-failed"
      : error instanceof AcquisitionRouteError
        ? "source-route-failed"
        : error instanceof AcquisitionUnavailableError
          ? "source-route-unavailable"
          : error instanceof AcquisitionCandidateSkippedError
            ? "source-pdf-empty"
            : "source-pdf-invalid";
  return { status: "error", code, authentication: "not-proven" };
}
async function launchSourceBrowser(signal: AbortSignal): Promise<void> {
  const runtime = await resolveVerifiedCloakRuntime(
    process.env.SCIRETRIEVER_CLOAK_BUNDLE,
  );
  if (!runtime) throw new SourceBrowserUnavailableError();
  const profile = await mkdtemp(join(tmpdir(), "sciretriever-source-probe-"));
  const host = new BrowserHost({
    runtime,
    profile,
    admitNavigation: async () => {
      throw new Error("source-browser-network-rejected");
    },
  });
  try {
    if (signal.aborted) throw new Error("cancelled");
    await host.start();
    if (signal.aborted) throw new Error("cancelled");
  } finally {
    await host.close();
    await rm(profile, { recursive: true, force: true });
  }
}
const services = new WeakMap<SourceConfigurationOwner, SourceProbeService>();
export function sourceProbes(
  sources: SourceConfigurationOwner,
  coordinator?: NetworkBudgetCoordinator,
  seams: SourceProbeSeams = {},
): SourceProbeService {
  let service = services.get(sources);
  if (!service) {
    service = new SourceProbeService(sources, coordinator, seams);
    services.set(sources, service);
  }
  return service;
}
export async function closeSourceProbes(
  sources: SourceConfigurationOwner,
): Promise<void> {
  await services.get(sources)?.close();
  services.delete(sources);
}
