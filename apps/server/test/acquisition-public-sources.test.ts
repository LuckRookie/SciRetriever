import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
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
import { AcquisitionCandidateSkippedError } from "../src/acquisition/tiered.js";
import { NetworkHttpError } from "../src/network/http.js";

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
        locator: "https://europepmc.org/articles/PMC123456?pdf=render",
      },
    ]);
    await expect(
      new EuropePmcPdfSource().discover({
        identifiers: [{ namespace: "pmid", value: "123456" }],
      }),
    ).resolves.toEqual([]);
    await expect(
      new DoiLandingSource().discover(request),
    ).resolves.toMatchObject([
      { source: "doi-landing", locator: "https://doi.org/10.1000/example" },
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
    expect(new URL(calls[0]!).pathname).toBe("/v2/10.1000/example");
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
    const application = await createApplication(home, {});
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

  it("re-admits public PDF links without permitting private or credential-bearing destinations", async () => {
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
        {
          resolver: () => ["127.0.0.1"],
          connection: {
            connect: () => {
              throw new Error("unsafe destinations must not open a socket");
            },
          },
        },
      );
      await expect(
        transport.request("https://other.example/article.pdf"),
      ).rejects.toMatchObject({ code: "network-policy" });
      await expect(
        transport.request("https://user:password@other.example/article.pdf"),
      ).rejects.toMatchObject({ code: "network-policy" });
      await expect(
        transport.request("http://other.example/article.pdf"),
      ).rejects.toMatchObject({ code: "network-policy" });
    } finally {
      coordinator.close();
    }
  });

  it("resolves an admitted static landing locator before spooling PDF bytes", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-landing-download-"),
    );
    const application = await createApplication(home, {});
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
                  final_url: "https://publisher.example/article/known",
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
        `https://doi.org/${FIXTURE_DOI}`,
        "https://publisher.example/article.pdf",
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

  it("downloads a DOI landing PDF across a publisher redirect and CDN using only public HTTP", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-public-redirect-"));
    const keyPath = join(home, "key.pem");
    const certPath = join(home, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=doi.org",
      "-addext",
      "subjectAltName=DNS:doi.org,DNS:publisher.example,DNS:cdn.example",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    const certificate = await readFile(certPath);
    const requests: string[] = [];
    const pdf = workbenchPdf();
    const server = createServer(
      { key: await readFile(keyPath), cert: certificate },
      (request, response) => {
        requests.push(`https://${request.headers.host}${request.url}`);
        expect(request.method).toBe("GET");
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        if (request.headers.host === "doi.org") {
          response.writeHead(302, {
            location: "https://publisher.example/article/known",
          });
          response.end();
        } else if (request.url === "/article/known") {
          response.writeHead(303, { location: "/identity/authorize" });
          response.end();
        } else if (request.url === "/identity/authorize") {
          response.writeHead(302, { location: "/identity/transit" });
          response.end();
        } else if (request.url === "/identity/transit") {
          response.writeHead(302, { location: "/article/final" });
          response.end();
        } else if (request.url === "/article/final") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            '<meta name="citation_pdf_url" content="../files/article.pdf">',
          );
        } else if (request.url === "/files/article.pdf") {
          response.writeHead(302, {
            location: "https://cdn.example/article.pdf",
          });
          response.end();
        } else if (request.url === "/loop") {
          response.writeHead(302, { location: "/loop" });
          response.end();
        } else if (request.url === "/private.pdf") {
          response.writeHead(302, {
            location: "https://private.example/article.pdf",
          });
          response.end();
        } else {
          response.writeHead(200, { "content-type": "application/pdf" });
          response.end(pdf);
        }
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const coordinator = new NetworkBudgetCoordinator();
    const application = await createApplication(join(home, "application"), {});
    try {
      const candidate = doiLanding(FIXTURE_DOI);
      const transport = assemblePublicPdfDownloadTransport(
        candidate,
        coordinator,
        {
          resolver: (hostname) => [
            hostname === "private.example" ? "127.0.0.1" : "93.184.216.34",
          ],
          connection: {
            connect: (options) => {
              expect(options).toEqual({ host: "93.184.216.34", port: 443 });
              return createConnection({ host: "127.0.0.1", port });
            },
            tlsConnect: (options) =>
              tlsConnect({ ...options, ca: certificate }),
          },
        },
      );
      const durable = await downloadPdfCandidate(candidate, transport, {
        collector: application.execution!.transfers,
        transfer_id: "doi-public-download",
      });
      expect(
        await application.execution!.transfers.candidateBytes(durable),
      ).toEqual(pdf);
      expect(requests).toEqual([
        `https://doi.org/${FIXTURE_DOI}`,
        "https://publisher.example/article/known",
        "https://publisher.example/identity/authorize",
        "https://publisher.example/identity/transit",
        "https://publisher.example/article/final",
        "https://publisher.example/files/article.pdf",
        "https://cdn.example/article.pdf",
      ]);
      await expect(
        transport.request("https://publisher.example/private.pdf"),
      ).rejects.toMatchObject({ code: "network-policy" });
      expect(requests.at(-1)).toBe("https://publisher.example/private.pdf");
      const beforeLoop = requests.length;
      await expect(
        transport.request("https://publisher.example/loop"),
      ).rejects.toMatchObject({
        code: "network-http",
        reason: "redirect-limit",
      });
      expect(requests.slice(beforeLoop)).toEqual(
        Array.from({ length: 6 }, () => "https://publisher.example/loop"),
      );
    } finally {
      await application.close();
      coordinator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("treats an HTML landing without a PDF link as a miss while preserving HTTP failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-landing-miss-"));
    const application = await createApplication(home, {});
    try {
      for (const status of [200, 403, 429]) {
        const download = downloadPdfCandidate(
          doiLanding(FIXTURE_DOI),
          {
            async request() {
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
            transfer_id: `landing-${status}`,
          },
        );
        if (status === 200)
          await expect(download).rejects.toBeInstanceOf(
            AcquisitionCandidateSkippedError,
          );
        else if (status === 403)
          await expect(download).rejects.toMatchObject({
            unavailability: "http-route-unavailable",
          });
        else
          await expect(download).rejects.toMatchObject({
            code: "rate-limited",
          });
      }
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses actual bytes and follows an HTML response to a supposedly direct PDF", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-direct-html-"));
    const app = await createApplication(home, {});
    try {
      const calls: string[] = [];
      const pdf = workbenchPdf();
      const candidate = safeLocator(
        "direct",
        "https://publisher.example:8443/download",
      );
      const durable = await downloadPdfCandidate(
        candidate,
        {
          async request(url) {
            calls.push(url);
            return calls.length === 1
              ? {
                  status: 200,
                  headers: [["content-type", "text/html"]],
                  body: new TextEncoder().encode(
                    '<meta name="citation_pdf_url" content="/real.pdf">',
                  ),
                }
              : {
                  status: 200,
                  headers: [["content-type", "application/octet-stream"]],
                  body: pdf,
                  retry_after_ms: 0,
                };
          },
        },
        { collector: app.execution!.transfers, transfer_id: "actual-pdf" },
      );
      expect(calls).toEqual([
        candidate.locator,
        "https://publisher.example:8443/real.pdf",
      ]);
      expect(await app.execution!.transfers.candidateBytes(durable)).toEqual(
        pdf,
      );
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps static link rate limits and transport failures distinct from browser-capable misses", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-static-failure-"));
    const app = await createApplication(home, {});
    try {
      const cases = [
        {
          response: { status: 429, headers: [] },
          expected: { code: "rate-limited" },
          calls: 2,
        },
        {
          response: { status: 403, headers: [["retry-after", "60"]] },
          expected: { code: "rate-limited" },
          calls: 2,
        },
        {
          response: { status: 503, headers: [] },
          expected: { code: "http-response-failed" },
          calls: 3,
        },
        {
          error: new NetworkHttpError("timeout"),
          expected: { code: "network-http", reason: "timeout" },
          calls: 3,
        },
        {
          error: new NetworkHttpError("redirect-limit"),
          expected: { unavailability: "http-route-unavailable" },
          calls: 3,
        },
        {
          error: new NetworkHttpError("redirect-limit", {
            retryAfterMs: 60_000,
          }),
          expected: { code: "network-http", retry_after_ms: 60_000 },
          calls: 2,
        },
      ];
      for (const [index, item] of cases.entries()) {
        let calls = 0;
        const download = downloadPdfCandidate(
          doiLanding(FIXTURE_DOI),
          {
            async request() {
              calls++;
              if (calls === 1)
                return {
                  status: 200,
                  headers: [["content-type", "text/html"]],
                  body: new TextEncoder().encode(
                    '<a href="/first.pdf">PDF</a><a href="/second.pdf">PDF</a>',
                  ),
                };
              if (calls === 2) {
                if (item.error) throw item.error;
                return {
                  status: item.response!.status,
                  headers: item.response!.headers as [string, string][],
                  body: new Uint8Array(),
                };
              }
              return { status: 403, headers: [], body: new Uint8Array() };
            },
          },
          {
            collector: app.execution!.transfers,
            transfer_id: `static-${index}`,
          },
        );
        await expect(download).rejects.toMatchObject(item.expected);
        expect(calls).toBe(item.calls);
      }
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ignores inadmissible static paths without hiding a valid candidate's browser handoff", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-static-admission-"),
    );
    const app = await createApplication(home, {});
    try {
      const calls: string[] = [];
      const download = downloadPdfCandidate(
        doiLanding(FIXTURE_DOI),
        {
          async request(url) {
            calls.push(url);
            if (calls.length === 1)
              return {
                status: 200,
                headers: [["content-type", "text/html"]],
                body: new TextEncoder().encode(
                  '<meta name="citation_pdf_url" content="/main.pdf"><a href="https://cdn.example/assets%2F..%2Fappendix.pdf">Traversal</a><a href="https://cdn.example/assets%5Cprivate.pdf">Bad path</a>',
                ),
              };
            throw new NetworkHttpError("redirect-limit");
          },
        },
        {
          collector: app.execution!.transfers,
          transfer_id: "static-admission",
        },
      );
      await expect(download).rejects.toMatchObject({
        unavailability: "http-route-unavailable",
      });
      expect(calls).toEqual([
        `https://doi.org/${FIXTURE_DOI}`,
        "https://doi.org/main.pdf",
      ]);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps configured mirrors opt-in and routes authorized downloads without exposing credentials", async () => {
    const mirror = new ConfiguredSciHubSource(["https://mirror.example"]);
    await expect(mirror.discover(request)).resolves.toMatchObject([
      {
        source: "sci-hub",
        locator: "https://mirror.example/10.1000/example",
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
    const application = await createApplication(home, {});
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
    const application = await createApplication(home, {});
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
      ).rejects.toBeInstanceOf(AcquisitionCandidateSkippedError);
      await expect(
        downloadPdfCandidate(
          safeLocator("direct", "https://repository.example/html"),
          request({
            status: 200,
            headers: [["content-type", "application/pdf"]],
            body: new TextEncoder().encode("<html><body>No PDF</body></html>"),
          }),
          {
            collector: application.execution!.transfers,
            transfer_id: "public-download-html",
          },
        ),
      ).rejects.toBeInstanceOf(AcquisitionCandidateSkippedError);
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

  it("keeps an unconfigured route failure after trying remaining sources", async () => {
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
    ).resolves.toMatchObject([
      {
        disposition: "failed",
        failure: {
          code: "download-unavailable",
          retryable: false,
        },
      },
    ]);
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
    ).resolves.toMatchObject([
      { disposition: "failed", failure: { retryable: false } },
    ]);
  });
});

it("removes PDF viewer fragments before admitting static links without relaxing URL guards", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-viewer-fragment-"));
  const app = await createApplication(home, {});
  const pdf = workbenchPdf();
  const cases = [
    '<iframe src = "/storage/main.pdf#view=FitH&navpanes=0"></iframe>',
    '<a href="/storage/main.pdf#page=2">PDF</a>',
    '<embed src="/storage/main.pdf#toolbar=0">',
    '<meta content="/storage/main.pdf#view=Fit" name="citation_pdf_url">',
  ];
  try {
    for (const [index, markup] of cases.entries()) {
      const calls: string[] = [];
      const candidate = await downloadPdfCandidate(
        safeLocator("sci-hub", "https://mirror.example/article", "landing"),
        {
          async request(url) {
            calls.push(url);
            return calls.length === 1
              ? {
                  status: 200,
                  headers: [["content-type", "text/html"]],
                  final_url: "https://shared.example/article",
                  body: new TextEncoder().encode(
                    '<iframe src="https://user:password@blocked.example/file.pdf#view=Fit"></iframe><iframe src="https://blocked.example/file.pdf?token=fixture#view=Fit"></iframe><iframe src="http://blocked.example/file.pdf#page=1"></iframe>' +
                      markup,
                  ),
                }
              : { status: 200, headers: [], body: pdf };
          },
        },
        {
          collector: app.execution!.transfers,
          transfer_id: `fragment-${index}`,
        },
      );
      expect(calls).toEqual([
        "https://mirror.example/article",
        "https://shared.example/storage/main.pdf",
      ]);
      expect(await app.execution!.transfers.candidateBytes(candidate)).toEqual(
        pdf,
      );
    }
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("uses the maintained Sci-Hub entry while preserving an explicit custom mirror list", async () => {
  const { assemblePublicAcquisitionRegistry } = await import(
    "../src/acquisition/assembly.js"
  );
  const budget = new NetworkBudgetCoordinator();
  try {
    const base =
      '[sources.acquisition]\nmode = "custom"\nproviders = ["sci-hub"]\n';
    const builtin = assemblePublicAcquisitionRegistry(
      parseConfiguration(base),
      budget,
    );
    expect(
      await builtin.sources
        .find((source) => source.source_name === "sci-hub")!
        .discover(request),
    ).toMatchObject([{ locator: "https://sci-hub.ru/10.1000/example" }]);
    expect(
      await builtin.sources
        .find((source) => source.source_name === "sci-hub")!
        .discover(request),
    ).toHaveLength(1);
    const custom = assemblePublicAcquisitionRegistry(
      parseConfiguration(
        base +
          '[sources.acquisition.sci-hub]\nurls = ["https://mirror.example"]\n',
      ),
      budget,
    );
    expect(
      await custom.sources
        .find((source) => source.source_name === "sci-hub")!
        .discover(request),
    ).toMatchObject([{ locator: "https://mirror.example/10.1000/example" }]);
  } finally {
    budget.close();
  }
});
