import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArxivPdfSource,
  AuthorizedPdfSource,
  CoreAuthorizedPdfClient,
  ConfiguredSciHubSource,
  DirectPdfSource,
  DoiLandingSource,
  EuropePmcPdfSource,
  ElsevierAuthorizedPdfClient,
  createApplication,
  doiLanding,
  downloadPdfCandidate,
  downloadSourceCandidate,
  parseConfiguration,
  PublicAcquisitionRegistry,
  safeLocator,
  UnpaywallSource,
  WileyAuthorizedPdfClient,
} from "../src/index.js";
import {
  FIXTURE_DOI,
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { parseCredentialText } from "../src/configuration/credentials.js";
import { assemblePublicPdfDownloadTransport } from "../src/acquisition/assembly.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

const request = {
  identifiers: [
    { namespace: "arxiv", value: "2401.12345" },
    { namespace: "pmcid", value: "PMC123456" },
    { namespace: "doi", value: "10.1000/example" },
  ],
  asset_hints: [
    {
      url: "https://repository.example/article.pdf",
      kind: "direct-file" as const,
      media_type: "application/pdf",
      asset_role: "primary-pdf" as const,
      version_role: "published" as const,
      access_status: "open",
      license: null,
    },
    {
      url: "https://repository.example/article.html",
      kind: "landing-page" as const,
      media_type: "text/html",
      asset_role: "html" as const,
      version_role: "published" as const,
      access_status: "open",
      license: null,
    },
  ],
};

describe("TypeScript public acquisition sources", () => {
  it("discovers safe locators without claiming PDF acquisition", async () => {
    await expect(
      new DirectPdfSource().discover(request),
    ).resolves.toMatchObject([
      { source: "direct", locator: "https://repository.example/article.pdf" },
    ]);
    await expect(new ArxivPdfSource().discover(request)).resolves.toMatchObject(
      [{ source: "arxiv", locator: "https://arxiv.org/pdf/2401.12345.pdf" }],
    );
    await expect(
      new EuropePmcPdfSource().discover(request),
    ).resolves.toMatchObject([
      {
        source: "europe-pmc",
        locator: "https://europepmc.org/articles/PMC123456/bin/PMC123456.pdf",
      },
    ]);
    await expect(
      new DoiLandingSource().discover(request),
    ).resolves.toMatchObject([
      { source: "doi-landing", locator: "https://doi.org/10.1000%2Fexample" },
    ]);
  });

  it("maps public Unpaywall locations and keeps missing sources explicit", async () => {
    const calls: string[] = [];
    const unpaywall = new UnpaywallSource(
      {
        async request(url) {
          calls.push(url);
          return {
            best_oa_location: {
              url_for_pdf: "https://repository.example/open.pdf",
              version: "publishedVersion",
              host_type: "repository",
            },
            oa_locations: [
              {
                url: "https://publisher.example/article",
                host_type: "publisher",
              },
            ],
          };
        },
      },
      { email: "reader@example.test", origin: "https://api.unpaywall.test" },
    );
    const result = await unpaywall.discover(request);
    expect(result[0]).toMatchObject({
      source: "unpaywall",
      locator: "https://repository.example/open.pdf",
      version: "publishedVersion",
    });
    expect(new URL(calls[0]!).pathname).toBe("/v2/10.1000%2Fexample");
    expect(new URL(calls[0]!).searchParams.get("email")).toBe(
      "reader@example.test",
    );

    const registry = new PublicAcquisitionRegistry([
      new DirectPdfSource(),
      unpaywall,
    ]);
    expect(registry.statuses).toEqual([
      { source_name: "direct", ready: true, failure_code: null },
      {
        source_name: "arxiv",
        ready: false,
        failure_code: "missing-source-adapter",
      },
      {
        source_name: "europe-pmc",
        ready: false,
        failure_code: "missing-source-adapter",
      },
      {
        source_name: "doi-landing",
        ready: false,
        failure_code: "missing-source-adapter",
      },
      { source_name: "unpaywall", ready: true, failure_code: null },
    ]);
    const discovered = await registry.discover(request);
    expect(discovered.failures).toEqual([]);
    expect(discovered.candidates.map((candidate) => candidate.source)).toEqual([
      "direct",
      "unpaywall",
      "unpaywall",
    ]);
  });

  it("downloads an admitted locator into the durable Candidate spool", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-public-download-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const pdf = workbenchPdf();
      const candidate = await downloadPdfCandidate(
        safeLocator("direct", "https://repository.example/article.pdf"),
        {
          async request(url) {
            expect(url).toBe("https://repository.example/article.pdf");
            return {
              status: 200,
              headers: [["content-type", "application/pdf"]],
              body: pdf,
            };
          },
        },
        {
          collector: application.execution!.transfers,
          transfer_id: "public-download-1",
          max_bytes: pdf.byteLength,
        },
      );
      expect(candidate.state).toBe("durable-ready");
      expect(candidate.source_name).toBe("direct");
      expect(candidate.size_bytes).toBe(pdf.byteLength);
      expect(
        await application.execution!.transfers.candidateBytes(candidate),
      ).toEqual(pdf);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("binds a public PDF transport to one safe HTTPS origin", () => {
    const coordinator = new NetworkBudgetCoordinator();
    try {
      expect(() =>
        assemblePublicPdfDownloadTransport(
          safeLocator("direct", "http://repository.example/article.pdf"),
          coordinator,
        ),
      ).toThrow("safe HTTPS URL");
      const transport = assemblePublicPdfDownloadTransport(
        safeLocator("direct", "https://repository.example/article.pdf"),
        coordinator,
      );
      expect(() =>
        transport.request("https://other.example/article.pdf"),
      ).toThrow("changed origin");
    } finally {
      coordinator.close();
    }
  });

  it("resolves an admitted static landing locator before spooling PDF bytes", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-landing-download-"),
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      await application.database.putLiterature(FIXTURE_LITERATURE);
      const calls: string[] = [];
      const pdf = workbenchPdf();
      const candidate = doiLanding(FIXTURE_DOI);
      const durable = await downloadPdfCandidate(
        candidate,
        {
          async request(url) {
            calls.push(url);
            return calls.length === 1
              ? {
                  status: 200,
                  headers: [["Content-Type", "text/html; charset=utf-8"]],
                  body: new TextEncoder().encode(
                    '<meta name="citation_pdf_url" content="/article.pdf">',
                  ),
                }
              : {
                  status: 200,
                  headers: [["content-type", "application/pdf"]],
                  body: pdf,
                };
          },
        },
        {
          collector: application.execution!.transfers,
          transfer_id: "landing-download-1",
          capture: {
            session_id: "acquisition-1",
            article_id: FIXTURE_LITERATURE.literature_id,
            page_id: "source-1",
            document_generation: 0,
            source_url: "https://doi.org/article",
            captured_at: "2026-09-11T00:00:00Z",
          },
        },
      );
      expect(calls).toEqual([
        `https://doi.org/${encodeURIComponent(FIXTURE_DOI)}`,
        "https://doi.org/article.pdf",
      ]);
      expect(durable.source_name).toBe("doi-landing");
      expect(
        await application.execution!.transfers.candidateBytes(durable),
      ).toEqual(pdf);
      const facts = (await application.database.currentFacts(
        FIXTURE_LITERATURE.literature_id,
      ))!;
      await application.execution!.acceptance.accept({
        receipt_id: "landing-receipt-1",
        literature_id: FIXTURE_LITERATURE.literature_id,
        transfer_id: durable.transfer_id,
        metadata_snapshot: facts.metadata_snapshot,
      });
      expect(
        await application.database.getReceiptIntent("landing-receipt-1"),
      ).toMatchObject({ provenance: { source_name: "doi-landing" } });
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps configured mirrors opt-in and routes authorized downloads without exposing credentials", async () => {
    const mirror = new ConfiguredSciHubSource(["https://mirror.example"]);
    await expect(mirror.discover(request)).resolves.toMatchObject([
      {
        source: "sci-hub",
        locator: "https://mirror.example/10.1000%2Fexample",
      },
    ]);
    const calls: { url: string; headers?: Readonly<Record<string, string>> }[] =
      [];
    const source = new AuthorizedPdfSource(
      new CoreAuthorizedPdfClient(
        {
          async request(url, options) {
            calls.push({
              url,
              ...(options?.headers ? { headers: options.headers } : {}),
            });
            return {
              status: 200,
              headers: [["content-type", "application/pdf"]],
              body: workbenchPdf(),
            };
          },
        },
        "opaque-core-key",
      ),
    );
    const [candidate] = await source.discover({
      identifiers: [{ namespace: "core-work", value: "work-42" }],
    });
    expect(candidate).toMatchObject({
      source: "core",
      evidence: ["authorized-origin", "credential-grant"],
    });
    const downloaded = await source.download_candidate!(candidate!);
    expect(downloaded).toMatchObject({
      kind: "download",
      entitlement: "granted",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.core.ac.uk/v3/works/work-42/download",
      headers: { authorization: "Bearer opaque-core-key" },
    });
  });

  it("requires publisher evidence before DOI-only Elsevier or Wiley routing", async () => {
    const never = {
      async request(): Promise<never> {
        throw new Error("discovery must stay local");
      },
    };
    const elsevier = new AuthorizedPdfSource(
      new ElsevierAuthorizedPdfClient(never, "key"),
    );
    const wiley = new AuthorizedPdfSource(
      new WileyAuthorizedPdfClient(never, "token"),
    );
    const doiOnly = { identifiers: [{ namespace: "doi", value: "10.1000/x" }] };
    await expect(elsevier.discover(doiOnly)).resolves.toEqual([]);
    await expect(wiley.discover(doiOnly)).resolves.toEqual([]);
    await expect(
      elsevier.discover({
        ...doiOnly,
        asset_hints: [
          {
            url: "https://www.sciencedirect.com/science/article/pii/S001",
            kind: "landing-page",
            media_type: "text/html",
            asset_role: "html",
            version_role: "published",
            access_status: null,
            license: null,
          },
        ],
      }),
    ).resolves.toMatchObject([{ source: "elsevier" }]);
    await expect(
      wiley.discover({
        ...doiOnly,
        asset_hints: [
          {
            url: "https://onlinelibrary.wiley.com/doi/10.1000/x",
            kind: "landing-page",
            media_type: "text/html",
            asset_role: "html",
            version_role: "published",
            access_status: null,
            license: null,
          },
        ],
      }),
    ).resolves.toMatchObject([{ source: "wiley" }]);
  });

  it("spools an authorized provider result through the shared Candidate publication boundary", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-authorized-spool-"),
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      await application.database.putLiterature(FIXTURE_LITERATURE);
      const source = new AuthorizedPdfSource(
        new CoreAuthorizedPdfClient(
          {
            async request() {
              return {
                status: 200,
                headers: [["content-type", "application/pdf"]] as const,
                body: workbenchPdf(),
              };
            },
          },
          "opaque-core-key",
        ),
      );
      const registry = new PublicAcquisitionRegistry([source]);
      const [candidate] = await source.discover({
        identifiers: [
          { namespace: "doi", value: "10.1000/unrelated" },
          { namespace: "core-work", value: "work-42" },
        ],
      });
      const durable = await downloadSourceCandidate(candidate!, {
        registry,
        collector: application.execution!.transfers,
        transfer_id: "authorized-download-1",
        capture: {
          session_id: "session-1",
          article_id: FIXTURE_LITERATURE.literature_id,
          page_id: "page-1",
          document_generation: 0,
          source_url: "https://publisher.example/article",
          captured_at: "2026-09-11T00:00:00Z",
        },
      });
      expect(durable.capture?.source_url).toBe(
        "https://publisher.example/article",
      );
      expect(durable.source_name).toBe("core");
      expect(durable.source_record_id).toBe("work:work-42");
      expect(
        await application.execution!.transfers.candidateBytes(durable),
      ).toEqual(workbenchPdf());
      const facts = (await application.database.currentFacts(
        FIXTURE_LITERATURE.literature_id,
      ))!;
      await application.execution!.acceptance.accept({
        receipt_id: "authorized-receipt-1",
        literature_id: FIXTURE_LITERATURE.literature_id,
        transfer_id: durable.transfer_id,
        metadata_snapshot: facts.metadata_snapshot,
      });
      expect(
        await application.database.getReceiptIntent("authorized-receipt-1"),
      ).toMatchObject({
        provenance: {
          source_name: "core",
          source_record_id: "work:work-42",
        },
      });
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("assembles intrinsic direct/landing sources and only selected protocol sources", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-source-assembly-"));
    const application = await createApplication(home);
    try {
      expect(application.acquisition.statuses).toEqual([
        { source_name: "direct", ready: true, failure_code: null },
        { source_name: "arxiv", ready: true, failure_code: null },
        { source_name: "europe-pmc", ready: true, failure_code: null },
        { source_name: "doi-landing", ready: true, failure_code: null },
      ]);
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
    const custom = parseConfiguration(
      '[sources.acquisition]\nmode = "custom"\nproviders = ["arxiv"]\n',
    );
    const registry = (
      await import("../src/acquisition/assembly.js")
    ).assemblePublicAcquisitionRegistry(
      custom,
      new (await import("../src/network/budget.js")).NetworkBudgetCoordinator(),
    );
    expect(
      registry.statuses
        .map((item) => item.source_name)
        .filter(
          (name) =>
            registry.statuses.find((item) => item.source_name === name)?.ready,
        ),
    ).toEqual(["direct", "arxiv", "doi-landing"]);

    const ordered = parseConfiguration(
      '[sources.acquisition]\nmode = "custom"\nproviders = ["wiley", "arxiv", "sci-hub"]\n',
    );
    const selected = (
      await import("../src/acquisition/assembly.js")
    ).assemblePublicAcquisitionRegistry(
      ordered,
      new (await import("../src/network/budget.js")).NetworkBudgetCoordinator(),
    );
    expect(selected.statuses.map((item) => item.source_name)).toEqual([
      "direct",
      "wiley",
      "arxiv",
      "sci-hub",
      "doi-landing",
    ]);
    expect(selected.statuses[1]).toEqual({
      source_name: "wiley",
      ready: false,
      failure_code: "missing-credential",
    });
    expect(selected.sources.map((item) => item.source_name)).toEqual([
      "direct",
      "arxiv",
      "sci-hub",
      "doi-landing",
    ]);

    const autoWithCredential = (
      await import("../src/acquisition/assembly.js")
    ).assemblePublicAcquisitionRegistry(
      parseConfiguration(""),
      new (await import("../src/network/budget.js")).NetworkBudgetCoordinator(),
      { credentials: parseCredentialText('[core]\napi_key = "present"\n') },
    );
    expect(autoWithCredential.statuses.map((item) => item.source_name)).toEqual(
      ["direct", "arxiv", "europe-pmc", "doi-landing"],
    );
  });

  it("rejects non-PDF, failed and oversized public download responses", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-public-download-negative-"),
    );
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      const pdf = workbenchPdf();
      const request = (response: {
        status: number;
        headers: readonly (readonly [string, string])[];
        body: Uint8Array;
      }) => ({
        async request() {
          return response;
        },
      });
      await expect(
        downloadPdfCandidate(
          safeLocator("direct", "https://repository.example/fail.pdf"),
          request({ status: 404, headers: [], body: new Uint8Array() }),
          {
            collector: application.execution!.transfers,
            transfer_id: "public-download-fail",
          },
        ),
      ).rejects.toThrow("response failed");
      await expect(
        downloadPdfCandidate(
          safeLocator("direct", "https://repository.example/html"),
          request({
            status: 200,
            headers: [["content-type", "text/html"]],
            body: pdf,
          }),
          {
            collector: application.execution!.transfers,
            transfer_id: "public-download-html",
          },
        ),
      ).rejects.toThrow("media type is not PDF");
      await expect(
        downloadPdfCandidate(
          safeLocator("direct", "https://repository.example/large.pdf"),
          request({
            status: 200,
            headers: [["content-type", "application/pdf"]],
            body: pdf,
          }),
          {
            collector: application.execution!.transfers,
            transfer_id: "public-download-large",
            max_bytes: pdf.byteLength - 1,
          },
        ),
      ).rejects.toThrow("exceeds byte limit");
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("controlled browser acquisition route", () => {
  it("reports a disabled browser switch as skipped and never runs it", async () => {
    const { assemblePublicAcquisitionRegistry } = await import(
      "../src/acquisition/assembly.js"
    );
    const { NetworkBudgetCoordinator } = await import(
      "../src/network/budget.js"
    );
    // Bootstrap always supplies the admission decision, so the assembly never has to
    // guess whether the tier is off or merely unwired.
    const registry = assemblePublicAcquisitionRegistry(
      parseConfiguration(""),
      new NetworkBudgetCoordinator(),
      {
        browser_admission: {
          enabled: false,
          controlled_delivery: false,
          unavailable_reason: null,
        },
      },
    );
    // Public sources and the DOI landing route stay in order, and the Browser tier is
    // expressed as an explicit disabled route rather than being silently absent.
    expect(registry.statuses.map((item) => item.source_name)).toEqual([
      "direct",
      "arxiv",
      "europe-pmc",
      "doi-landing",
      "browser",
    ]);
    expect(
      registry.statuses.find((item) => item.source_name === "browser"),
    ).toEqual({
      source_name: "browser",
      ready: false,
      failure_code: "browser-disabled",
    });
    // A disabled tier is not an applicable route, so it is not runnable. This is the
    // only case where the target may still reach a normal exhaustion.
    expect(registry.sources.map((item) => item.source_name)).toEqual([
      "direct",
      "arxiv",
      "europe-pmc",
      "doi-landing",
    ]);
  });

  it("expresses browser admission honestly instead of claiming a runnable tier", async () => {
    const { assemblePublicAcquisitionRegistry, splitAcquisitionRoutes } =
      await import("../src/acquisition/assembly.js");
    const { NetworkBudgetCoordinator } = await import(
      "../src/network/budget.js"
    );
    // Admission is an operator switch plus a readiness claim. Only a claimed
    // controlled delivery with no unavailable reason may be ready; every other shape
    // stays unready with its own stable reason, and an enabled tier always remains in
    // the runnable list so a locator caller fails closed instead of exhausting.
    const cases = [
      {
        admission: {
          enabled: true,
          controlled_delivery: true,
          unavailable_reason: null,
        },
        ready: true,
        failure_code: null,
      },
      {
        admission: {
          enabled: true,
          controlled_delivery: false,
          unavailable_reason: "browser-runtime-unavailable" as const,
        },
        ready: false,
        failure_code: "browser-runtime-unavailable",
      },
      {
        admission: {
          enabled: true,
          controlled_delivery: false,
          unavailable_reason: null,
        },
        ready: false,
        failure_code: "browser-controlled-delivery-unavailable",
      },
    ];
    for (const expected of cases) {
      const registry = assemblePublicAcquisitionRegistry(
        parseConfiguration(""),
        new NetworkBudgetCoordinator(),
        { browser_admission: expected.admission },
      );
      // The tier is ordered last, behind every public and API route.
      expect(registry.statuses.map((item) => item.source_name)).toEqual([
        "direct",
        "arxiv",
        "europe-pmc",
        "doi-landing",
        "browser",
      ]);
      expect(
        registry.statuses.find((item) => item.source_name === "browser"),
      ).toEqual({
        source_name: "browser",
        ready: expected.ready,
        failure_code: expected.failure_code,
      });
      expect(registry.sources.map((item) => item.source_name)).toEqual([
        "direct",
        "arxiv",
        "europe-pmc",
        "doi-landing",
        "browser",
      ]);
      // Entry runs only the locator view and escalates explicitly, so the throwing
      // Browser source can never abort the batch before the session is asked.
      const split = splitAcquisitionRoutes(registry);
      expect(split.routes.sources.map((item) => item.source_name)).toEqual([
        "direct",
        "arxiv",
        "europe-pmc",
        "doi-landing",
      ]);
      expect(split.browser).toEqual({
        enabled: true,
        ready: expected.ready,
        unavailable_reason: expected.failure_code,
      });
    }
  });

  it("separates the locator view from a disabled browser admission", async () => {
    const { assemblePublicAcquisitionRegistry, splitAcquisitionRoutes } =
      await import("../src/acquisition/assembly.js");
    const { NetworkBudgetCoordinator } = await import(
      "../src/network/budget.js"
    );
    const registry = assemblePublicAcquisitionRegistry(
      parseConfiguration(""),
      new NetworkBudgetCoordinator(),
      {
        browser_admission: {
          enabled: false,
          controlled_delivery: false,
          unavailable_reason: null,
        },
      },
    );
    const split = splitAcquisitionRoutes(registry);
    // A disabled switch is not an applicable route: Entry may let the target reach its
    // normal end (and Entry's own durable exhaustion) instead of escalating.
    expect(split.browser).toEqual({
      enabled: false,
      ready: false,
      unavailable_reason: null,
    });
    expect(split.routes.sources.map((item) => item.source_name)).toEqual([
      "direct",
      "arxiv",
      "europe-pmc",
      "doi-landing",
    ]);
  });

  it("keeps a selected but unconfigured route as a fail-closed locator outcome", async () => {
    const { assemblePublicAcquisitionRegistry, splitAcquisitionRoutes } =
      await import("../src/acquisition/assembly.js");
    const { NetworkBudgetCoordinator } = await import(
      "../src/network/budget.js"
    );
    const registry = assemblePublicAcquisitionRegistry(
      parseConfiguration(
        '[sources.acquisition]\nmode = "custom"\nproviders = ["wiley", "arxiv", "sci-hub"]\n',
      ),
      new NetworkBudgetCoordinator(),
    );
    // The ordinary registry keeps Wiley out of runnable sources for readiness/status
    // reporting, but Entry's locator split must not lose the unresolved selected route.
    expect(registry.sources.map((item) => item.source_name)).toEqual([
      "direct",
      "arxiv",
      "sci-hub",
      "doi-landing",
    ]);
    const split = splitAcquisitionRoutes(registry);
    expect(split.routes.sources.map((item) => item.source_name)).toEqual([
      "direct",
      "wiley",
      "arxiv",
      "sci-hub",
      "doi-landing",
    ]);
    const wiley = split.routes.sources.find(
      (item) => item.source_name === "wiley",
    );
    expect(wiley).toBeDefined();
    await expect(wiley!.discover({ identifiers: [] })).rejects.toMatchObject({
      code: "download-unavailable",
      retryable: false,
    });
    const { TieredAcquisitionService } = await import(
      "../src/acquisition/tiered.js"
    );
    await expect(
      new TieredAcquisitionService(split.routes, { cooldown_ms: 0 }).run(
        [{ key: "unconfigured-route", request: { identifiers: [] } }],
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "download-unavailable",
      retryable: false,
    });
  });

  it("fails closed instead of exhausting a target whose browser tier is unavailable", async () => {
    const { assemblePublicAcquisitionRegistry } = await import(
      "../src/acquisition/assembly.js"
    );
    const { NetworkBudgetCoordinator } = await import(
      "../src/network/budget.js"
    );
    const { TieredAcquisitionService } = await import(
      "../src/acquisition/tiered.js"
    );
    const registry = assemblePublicAcquisitionRegistry(
      parseConfiguration(""),
      new NetworkBudgetCoordinator(),
      {
        browser_admission: {
          enabled: true,
          controlled_delivery: true,
          unavailable_reason: null,
        },
      },
    );
    // The unavailable tier must fail closed rather than let the target be reported as
    // a normal exhaustion, and the download callback must never be asked to fetch a
    // Browser URL with the credential-free public transport.
    await expect(
      new TieredAcquisitionService(registry, { cooldown_ms: 0 }).run(
        [{ key: "browser-target", request: { identifiers: [] } }],
        async () => {
          throw new Error(
            "browser route must not hand out a fetchable candidate",
          );
        },
      ),
    ).rejects.toMatchObject({ retryable: false });
  });
});
