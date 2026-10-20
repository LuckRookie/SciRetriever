import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseLiterature, parseLiteratureId } from "@sciretriever/contracts";
import {
  BrowserDeliveryScheduler,
  BrowserDeliveryStaleGenerationError,
  EntryPdfAcquisitionService,
  type PdfAcquisitionRequest,
} from "../src/entry/pdf-acquisition.js";
import { createApplication } from "../src/bootstrap/application.js";
import {
  downloadPdfCandidate,
  PublicAcquisitionRegistry,
} from "../src/acquisition/sources/public.js";
import { type AcquisitionSourcePort } from "../src/acquisition/ports.js";
import { BROWSER_ROUTE_NAME } from "../src/acquisition/assembly.js";
import { AcquisitionRouteError } from "../src/acquisition/tiered.js";
import { authorizedTargets } from "../src/providers/acquisition.js";
import {
  doiLanding,
  safeLocator,
} from "../src/acquisition/sources/locators.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

describe("shared Browser delivery scheduler", () => {
  it("never enters the Browser host concurrently", async () => {
    const scheduler = new BrowserDeliveryScheduler();
    const release = deferred();
    const signal = new AbortController().signal;
    let active = 0;
    let peak = 0;
    const entered: string[] = [];
    const first = scheduler.run("operation", 1, signal, async () => {
      entered.push("first");
      peak = Math.max(peak, ++active);
      await release.promise;
      active -= 1;
      return "first";
    });
    const second = scheduler.run("operation", 1, signal, async () => {
      entered.push("second");
      peak = Math.max(peak, ++active);
      active -= 1;
      return "second";
    });
    await Promise.resolve();
    expect(entered).toEqual(["first"]);
    expect(active).toBe(1);
    release.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(peak).toBe(1);
    expect(entered).toEqual(["first", "second"]);
    await scheduler.drain();
  });

  it("rejects an obsolete queued generation while allowing the latest one through", async () => {
    const scheduler = new BrowserDeliveryScheduler();
    const release = deferred();
    const signal = new AbortController().signal;
    const calls: number[] = [];
    const first = scheduler.run("operation", 1, signal, async () => {
      calls.push(1);
      await release.promise;
      return 1;
    });
    // Let generation 1 enter the lane before newer work is queued. Otherwise all
    // three promises can be appended in one turn and the active generation would
    // quite correctly be rejected as stale too.
    await Promise.resolve();
    const stale = scheduler.run("operation", 1, signal, async () => {
      calls.push(2);
      return 2;
    });
    const latest = scheduler.run("operation", 2, signal, async () => {
      calls.push(3);
      return 3;
    });
    release.resolve();
    await expect(first).resolves.toBe(1);
    await expect(stale).rejects.toBeInstanceOf(
      BrowserDeliveryStaleGenerationError,
    );
    await expect(latest).resolves.toBe(3);
    expect(calls).toEqual([1, 3]);
    await scheduler.drain();
  });

  it("does not start a cancelled queued delivery", async () => {
    const scheduler = new BrowserDeliveryScheduler();
    const release = deferred();
    const firstSignal = new AbortController().signal;
    const queuedController = new AbortController();
    let queuedStarted = false;
    const first = scheduler.run("operation", 1, firstSignal, async () => {
      await release.promise;
      return "first";
    });
    const queued = scheduler.run(
      "operation",
      1,
      queuedController.signal,
      async () => {
        queuedStarted = true;
        return "queued";
      },
    );
    queuedController.abort();
    release.resolve();
    await expect(first).resolves.toBe("first");
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(queuedStarted).toBe(false);
    await scheduler.drain();
  });

  it("continues with the next delivery after a host failure", async () => {
    const scheduler = new BrowserDeliveryScheduler();
    const signal = new AbortController().signal;
    const first = scheduler.run("operation", 1, signal, async () => {
      throw new Error("fixture host failure");
    });
    const second = scheduler.run("operation", 1, signal, async () => "second");
    await expect(first).rejects.toThrow("fixture host failure");
    await expect(second).resolves.toBe("second");
    await scheduler.drain();
  });

  it("closes by rejecting queued work and draining the active delivery", async () => {
    const scheduler = new BrowserDeliveryScheduler();
    const release = deferred();
    const signal = new AbortController().signal;
    let queuedStarted = false;
    const active = scheduler.run("operation", 1, signal, async () => {
      await release.promise;
      return "active";
    });
    await Promise.resolve();
    const queued = scheduler.run("operation", 1, signal, async () => {
      queuedStarted = true;
      return "queued";
    });
    const closing = scheduler.close();
    release.resolve();
    await expect(active).resolves.toBe("active");
    await expect(queued).rejects.toMatchObject({ name: "InvalidStateError" });
    await closing;
    expect(queuedStarted).toBe(false);
    await expect(
      scheduler.run("operation", 2, signal, async () => "late"),
    ).rejects.toMatchObject({ name: "InvalidStateError" });
  });
});

describe("completion acquisition cohorts", () => {
  it.each([false, true])(
    "notifies a fast Browser result and drains siblings when observer fails=%s",
    async (failObserver) => {
      const home = await mkdtemp(
        join(tmpdir(), "sciretriever-browser-notify-"),
      );
      const app = await createApplication(home, {});
      const slow = deferred(),
        fast = deferred();
      const observerFailure = new Error("fixture observer failed");
      const ids = [1, 2].map((n) =>
        parseLiteratureId(`00000000-0000-0000-0000-00000000890${n}`),
      );
      const source = {
        source_name: BROWSER_ROUTE_NAME,
        ready: false,
        discover: async () => [],
      };
      const service = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry([source], [BROWSER_ROUTE_NAME]),
        network_budget: app.networkBudget,
        transfers: app.execution!.transfers,
        acceptance: app.execution!.acceptance,
        browser_host: () => ({
          deliverCandidate: async (request) => {
            if (request.literature_id === ids[1]) {
              await new Promise<void>((resolve) => {
                const done = () => {
                  request.signal.removeEventListener("abort", done);
                  resolve();
                };
                if (request.signal.aborted) done();
                else {
                  request.signal.addEventListener("abort", done, {
                    once: true,
                  });
                  void slow.promise.then(done);
                }
              });
            }
            return {
              kind: "refused",
              code: "browser-agent-no-viable-path",
              reason: "No route in fixture",
              retryable: false,
            };
          },
          close: async () => {},
        }),
      });
      let pending: ReturnType<typeof service.acquireCohort> | undefined;
      try {
        for (const id of ids)
          await app.database.putLiterature(
            parseLiterature({
              ...FIXTURE_LITERATURE,
              literature_id: id,
              meta_literature_id: randomUUID(),
            }),
          );
        const requests = await Promise.all(
          ids.map(async (id) => ({
            literature_id: id,
            detail: await app.library.detail(id),
            metadata_snapshot: (await app.database.currentFacts(id))!
              .metadata_snapshot,
            signal: new AbortController().signal,
          })),
        );
        const notified: number[] = [];
        pending = service.acquireCohort(requests, {
          on_outcomes: (outcomes) => {
            notified.push(...outcomes.map((x) => x.index));
            if (notified.includes(0)) fast.resolve();
            if (failObserver && outcomes.some((x) => x.index === 0))
              throw observerFailure;
          },
        });
        void pending.catch(() => undefined);
        await fast.promise;
        if (failObserver) {
          await expect(pending).rejects.toBe(observerFailure);
        } else {
          expect(notified).toEqual([0]);
          slow.resolve();
          expect((await pending).map((x) => x.kind)).toEqual([
            "browser-failure",
            "browser-failure",
          ]);
          expect(notified).toEqual([0, 1]);
        }
      } finally {
        slow.resolve();
        await pending?.catch(() => undefined);
        await service.close();
        await app.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each(["single", "cohort"] as const)(
    "continues HTTP PDF hints and reports the actual Browser terminal (%s)",
    async (mode) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-http-pdf-hint-"));
      const application = await createApplication(home, {});
      const phases: string[] = [];
      const service = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry([
          {
            source_name: "direct",
            acquisition_stage: "direct",
            ready: true,
            async discover() {
              return [
                safeLocator("direct", "http://repository.example/paper.pdf"),
              ];
            },
          },
          {
            source_name: "fixture-api",
            acquisition_stage: "publisher-api",
            ready: true,
            async discover() {
              phases.push("api");
              return [];
            },
          },
          {
            source_name: BROWSER_ROUTE_NAME,
            ready: true,
            async discover() {
              throw new Error("Browser must not run as a locator");
            },
          },
        ]),
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => ({
          async deliverCandidate() {
            phases.push("browser");
            return {
              kind: "refused",
              code: "browser-flow-budget-exhausted",
              reason: "The offline browser completed its attempt.",
              retryable: false,
            };
          },
          close: async () => undefined,
        }),
      });
      try {
        const requests: PdfAcquisitionRequest[] = [];
        for (const id of [randomUUID(), randomUUID()]) {
          const literature = parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id,
            meta_literature_id: randomUUID(),
          });
          await application.database.putLiterature(literature);
          requests.push({
            literature_id: literature.literature_id,
            detail: await application.library.detail(literature.literature_id),
            metadata_snapshot: (await application.database.currentFacts(
              literature.literature_id,
            ))!.metadata_snapshot,
            signal: new AbortController().signal,
          });
        }
        const outcomes =
          mode === "cohort"
            ? await service.acquireCohort(requests)
            : await Promise.all(
                requests.map((request) => service.acquire(request)),
              );
        expect(outcomes).toEqual([
          expect.objectContaining({
            kind: "browser-failure",
            code: "browser-flow-budget-exhausted",
          }),
          expect.objectContaining({
            kind: "browser-failure",
            code: "browser-flow-budget-exhausted",
          }),
        ]);
        expect(phases).toEqual(["api", "api", "browser", "browser"]);
      } finally {
        await service.close();
        await application.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each([200, 400, 403, 401, 429, 503])(
    "continues API and public HTTP %i failures through independent Browser delivery",
    async (status) => {
      const home = await mkdtemp(
        join(tmpdir(), "sciretriever-landing-escalation-"),
      );
      const application = await createApplication(home, {});
      const phase: string[] = [];
      const publicSource: AcquisitionSourcePort = {
        source_name: "doi-landing",
        ready: true,
        acquisition_tier: "public",
        acquisition_stage: "public-web",
        async discover(request) {
          const doi = request.identifiers.find(
            (item) => item.namespace === "doi",
          )?.value;
          return doi ? [doiLanding(doi)] : [];
        },
        async download_candidate(candidate, signal): Promise<never> {
          // Keep Entry, the route runner and the public downloader real; only HTTP
          // is replaced at this existing source-owned delivery seam.
          await downloadPdfCandidate(
            candidate,
            {
              async request() {
                phase.push(`public:${status}`);
                return {
                  status,
                  headers: [["content-type", "text/html"]],
                  body: new TextEncoder().encode(
                    "<html><body>Article landing</body></html>",
                  ),
                };
              },
            },
            {
              collector: application.execution!.transfers,
              transfer_id: `static-landing-${status}`,
              ...(signal ? { signal } : {}),
            },
          );
          throw new Error("fixture landing must not produce a PDF");
        },
      };
      const service = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [
            publicSource,
            {
              source_name: "fixture-api",
              acquisition_tier: "authorized-api",
              acquisition_stage: "publisher-api",
              ready: true,
              async discover() {
                phase.push("api");
                if (status !== 200)
                  throw new AcquisitionRouteError(
                    status === 429 ? "rate-limited" : "http-response-failed",
                    `API HTTP ${status}.`,
                    status >= 500 || status === 429,
                  );
                return [];
              },
            },
            {
              source_name: BROWSER_ROUTE_NAME,
              ready: true,
              async discover() {
                throw new Error(
                  "Browser must remain outside locator execution",
                );
              },
            },
          ],
          ["doi-landing", "fixture-api", BROWSER_ROUTE_NAME],
        ),
        assistance:
          status === 401 ? "pause" : status === 429 ? "notify" : "never",
        network_budget: application.networkBudget,
        transfers: application.execution!.transfers,
        acceptance: application.execution!.acceptance,
        browser_host: () => ({
          async deliverCandidate(request) {
            expect(request.literature_id).toBe(
              FIXTURE_LITERATURE.literature_id,
            );
            phase.push("browser");
            const candidate = await downloadPdfCandidate(
              safeLocator("browser", "https://fixture.test/article.pdf"),
              {
                request: async () => ({
                  status: 200,
                  headers: [],
                  body: workbenchPdf(),
                }),
              },
              {
                collector: application.execution!.transfers,
                transfer_id: `browser-${status}`,
                capture: {
                  session_id: `session-${status}`,
                  article_id: request.literature_id,
                  page_id: "fixture-page",
                  document_generation: 0,
                  source_url: "https://fixture.test/article.pdf",
                  captured_at: new Date().toISOString(),
                },
              },
            );
            return { kind: "delivered" as const, accepted: true, candidate };
          },
          close: async () => undefined,
        }),
      });
      try {
        await application.database.putLiterature(FIXTURE_LITERATURE);
        const literatureId = FIXTURE_LITERATURE.literature_id;
        const [outcome] = await service.acquireCohort([
          {
            literature_id: literatureId,
            detail: await application.library.detail(literatureId),
            metadata_snapshot: (await application.database.currentFacts(
              literatureId,
            ))!.metadata_snapshot,
            signal: new AbortController().signal,
          },
        ]);
        expect(outcome).toMatchObject({ kind: "acquired" });
        expect(
          (await application.library.detail(literatureId)).primary_pdf
            ?.article_identity_status,
        ).toBe("unverified");
        expect(phase).toEqual(["api", `public:${status}`, "browser"]);
      } finally {
        await service.close();
        await application.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("runs Direct, publisher API and Browser barriers in order and reuses rejected-byte evidence", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-pdf-cohort-"));
    const application = await createApplication(home, {});
    const ids = [1, 2, 3, 4].map((value) =>
      parseLiteratureId(
        `00000000-0000-0000-0000-${String(8_000 + value).padStart(12, "0")}`,
      ),
    );
    const dois = ids.map((_id, index) => `10.1000/cohort-${index + 1}`);
    const phase: string[] = [];
    const downloaded = new Map<string, number>();
    let publicCompleted = 0;
    let apiCompleted = 0;
    let browserDeliveries = 0;
    const candidate = (source: string, doi: string) =>
      Object.freeze({
        ...safeLocator(source, `https://fixture.example.test/${doi}.pdf`),
        source,
      });
    const result = (source: string, doi: string) => ({
      kind: "download" as const,
      locator: {
        namespace: "doi",
        value: doi,
        declared_media_type: "application/pdf" as const,
        source_record_id: `${source}:${doi}`,
      },
      bytes: workbenchPdf(doi, "published"),
      media_type: "application/pdf",
      safe_source_url: `https://fixture.example.test/${doi}.pdf`,
      entitlement: "granted" as const,
    });
    const publicSource = {
      source_name: "fixture-public",
      ready: true,
      acquisition_stage: "direct" as const,
      acquisition_tier: "public" as const,
      async discover(request: {
        readonly identifiers: readonly {
          readonly namespace: string;
          readonly value: string;
        }[];
      }) {
        const doi = request.identifiers.find(
          (item) => item.namespace === "doi",
        )?.value;
        if (!doi) throw new Error("fixture DOI is missing");
        phase.push(`public:${doi}`);
        publicCompleted += 1;
        return doi === dois[0] || doi === dois[2]
          ? [candidate("fixture-public", doi)]
          : [];
      },
      async download_candidate(item: { readonly locator: string }) {
        const doi = decodeURIComponent(
          new URL(item.locator).pathname.slice(1).replace(/\.pdf$/u, ""),
        );
        downloaded.set(doi, (downloaded.get(doi) ?? 0) + 1);
        return result("fixture-public", doi);
      },
    };
    const apiSource = {
      source_name: "fixture-api",
      ready: true,
      acquisition_stage: "publisher-api" as const,
      acquisition_tier: "authorized-api" as const,
      async discover(request: {
        readonly identifiers: readonly {
          readonly namespace: string;
          readonly value: string;
        }[];
      }) {
        expect(publicCompleted).toBeGreaterThanOrEqual(ids.length);
        const doi = request.identifiers.find(
          (item) => item.namespace === "doi",
        )?.value;
        if (!doi) throw new Error("fixture DOI is missing");
        phase.push(`api:${doi}`);
        apiCompleted += 1;
        return doi === dois[1] ? [candidate("fixture-api", doi)] : [];
      },
      async download_candidate(item: { readonly locator: string }) {
        const doi = decodeURIComponent(
          new URL(item.locator).pathname.slice(1).replace(/\.pdf$/u, ""),
        );
        downloaded.set(doi, (downloaded.get(doi) ?? 0) + 1);
        return result("fixture-api", doi);
      },
    };
    const browserSource = {
      source_name: BROWSER_ROUTE_NAME,
      ready: false,
      async discover() {
        throw new Error("Browser marker must stay outside locator execution");
      },
    };
    const service = new EntryPdfAcquisitionService({
      registry: new PublicAcquisitionRegistry(
        [publicSource, apiSource, browserSource],
        ["fixture-public", "fixture-api", BROWSER_ROUTE_NAME],
      ),
      network_budget: application.networkBudget,
      transfers: application.execution!.transfers,
      acceptance: application.execution!.acceptance,
      browser_host: () => ({
        async deliverCandidate(request) {
          expect(publicCompleted).toBeGreaterThanOrEqual(ids.length);
          expect(apiCompleted).toBeGreaterThanOrEqual(2);
          browserDeliveries += 1;
          phase.push(`browser:${request.literature_id}`);
          return {
            kind: "refused" as const,
            code: "browser-flow-unavailable",
            reason: "synthetic cohort refusal",
            retryable: false as const,
          };
        },
        close: async () => undefined,
      }),
    });
    try {
      for (const [index, literatureId] of ids.entries())
        await application.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: literatureId,
            meta_literature_id: `10000000-0000-0000-0000-${String(8_000 + index + 1).padStart(12, "0")}`,
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              identifiers: [{ namespace: "doi", value: dois[index]! }],
            },
          }),
        );
      const requests: PdfAcquisitionRequest[] = await Promise.all(
        ids.map(async (literatureId) => ({
          literature_id: literatureId,
          detail: await application.library.detail(literatureId),
          metadata_snapshot: (await application.database.currentFacts(
            literatureId,
          ))!.metadata_snapshot,
          signal: new AbortController().signal,
          operation_id: "cohort-operation",
          generation: 1,
        })),
      );
      const waves: number[][] = [];
      const outcomes = await service.acquireCohort(requests, {
        on_outcomes: (wave) => waves.push(wave.map((item) => item.index)),
      });
      expect(waves).toEqual([[0, 2], [1], [3]]);
      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        "acquired",
        "acquired",
        "acquired",
        "browser-failure",
      ]);
      expect(browserDeliveries).toBe(1);
      const lastPhase = (prefix: string) =>
        phase.length -
        1 -
        [...phase].reverse().findIndex((item) => item.startsWith(prefix));
      expect(
        phase.findIndex((item) => item.startsWith("api:")),
      ).toBeGreaterThan(lastPhase("public:"));
      expect(
        phase.findIndex((item) => item.startsWith("browser:")),
      ).toBeGreaterThan(lastPhase("api:"));

      const first = outcomes[0];
      if (first?.kind !== "acquired")
        throw new Error("fixture was not acquired");
      const priorDownloads = downloaded.get(dois[0]!) ?? 0;
      await service.acquireCohort([
        {
          ...requests[0]!,
          generation: 2,
          excluded_sha256: [first.receipt.sha256],
        },
      ]);
      expect(downloaded.get(dois[0]!)).toBe(priorDownloads);
    } finally {
      await service.close();
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

it.each([302, 429])(
  "supplies first-hop DOI evidence before the publisher API and preserves resolver HTTP %s boundaries",
  async (status) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-landing-handoff-"));
    const app = await createApplication(home, {});
    const assembly = await import("../src/acquisition/assembly.js");
    const phases: string[] = [];
    const landing =
      "https://advanced.onlinelibrary.wiley.com/article?ephemeral=opaque";
    const transport = vi
      .spyOn(assembly, "assemblePublicPdfDownloadTransport")
      .mockReturnValue({
        request: async () => {
          phases.push("public:403");
          return {
            status: 403,
            headers: [],
            body: new Uint8Array(),
            final_url: landing,
          };
        },
      });
    const seen: string[][] = [];
    const service = new EntryPdfAcquisitionService({
      registry: new PublicAcquisitionRegistry(
        [
          {
            source_name: "doi-landing",
            acquisition_stage: "public-web",
            ready: true,
            discover: async (request) =>
              request.identifiers
                .filter((item) => item.namespace === "doi")
                .map((item) => doiLanding(item.value)),
          },
          {
            source_name: "wiley",
            acquisition_stage: "publisher-api",
            acquisition_tier: "authorized-api",
            ready: true,
            discover: async (request) => {
              phases.push("api");
              expect(authorizedTargets("wiley", request)).toHaveLength(
                status === 302 ? 1 : 0,
              );
              seen.push([...(request.landing_origins ?? [])]);
              return [];
            },
          },
        ],
        ["doi-landing", "wiley"],
      ),
      network_budget: app.networkBudget,
      transfers: app.execution!.transfers,
      acceptance: app.execution!.acceptance,
      resolve_doi_landing: async (url) => {
        expect(url).toBe(
          `https://doi.org/${FIXTURE_LITERATURE.metadata.identifiers[0]!.value}`,
        );
        phases.push(`doi:${status}`);
        if (status === 429)
          throw new AcquisitionRouteError(
            "rate-limited",
            "Synthetic DOI resolver rate limit.",
          );
        return landing;
      },
    });
    try {
      await app.database.putLiterature(FIXTURE_LITERATURE);
      const id = FIXTURE_LITERATURE.literature_id;
      const outcome = await service.acquire({
        literature_id: id,
        detail: await app.library.detail(id),
        metadata_snapshot: (await app.database.currentFacts(id))!
          .metadata_snapshot,
        signal: new AbortController().signal,
      });
      expect(outcome.kind).toBe(status === 302 ? "exhausted" : "route-failure");
      expect(seen).toEqual(
        status === 302 ? [["https://advanced.onlinelibrary.wiley.com"]] : [[]],
      );
      expect(transport).toHaveBeenCalledTimes(1);
      expect(phases).toEqual([`doi:${status}`, "api", "public:403"]);
      if (status === 429)
        expect(outcome).toMatchObject({
          kind: "route-failure",
          failure: { source: "doi-resolution", code: "rate-limited" },
        });
    } finally {
      transport.mockRestore();
      await service.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
