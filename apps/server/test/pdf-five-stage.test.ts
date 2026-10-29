import { networkRequestDispatched } from "../src/network/request-activity.js";
import type { AcquisitionAttempt } from "@sciretriever/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  parseLiterature,
  parseMetadataObservation,
  sha256,
  type AssetHint,
  type Identifier,
  type VersionRole,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import * as assembly from "../src/acquisition/assembly.js";
import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
  AcquisitionStage,
} from "../src/acquisition/ports.js";
import {
  downloadPdfCandidate,
  DoiLandingSource,
  PublicAcquisitionRegistry,
  type PdfDownloadTransport,
} from "../src/acquisition/sources/public.js";
import { safeLocator } from "../src/acquisition/sources/locators.js";
import type { BrowserDeliveryRequest } from "../src/browser/boundary.js";
import {
  EntryPdfAcquisitionService,
  type EntryPdfAcquisitionPorts,
  type PdfAcquisitionRequest,
} from "../src/entry/pdf-acquisition.js";
import { authorizedTargets } from "../src/providers/acquisition.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const stages = [
  "direct",
  "publisher-api",
  "general-api",
  "public-web",
] as const;
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const doi = (n: number) => `10.5555/five-stage-${n}`;
const marker: AcquisitionSourcePort = {
  source_name: assembly.BROWSER_ROUTE_NAME,
  ready: true,
  discover: async () => {
    throw new Error("Browser marker must not run as a source");
  },
};
const hint = (
  url: string,
  version: VersionRole | null = null,
  role: AssetHint["asset_role"] = null,
): AssetHint => ({
  url,
  kind: "landing-page",
  media_type: "text/html",
  asset_role: role,
  version_role: version,
  access_status: null,
  license: null,
});

async function fixture(configurationText?: string) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-five-stage-"));
  if (configurationText)
    await new TypeScriptConfigurationOwner(home).publish(
      configurationText,
      "missing",
      ["sources"],
    );
  const app = await createApplication(home, {});
  const transport = vi
    .spyOn(assembly, "assemblePublicPdfDownloadTransport")
    .mockReturnValue({
      request: async () => {
        throw new Error("Unconfigured offline transport");
      },
    });
  const owned: EntryPdfAcquisitionService[] = [];
  return {
    app,
    transport,
    service(
      sources: readonly AcquisitionSourcePort[],
      overrides: Partial<EntryPdfAcquisitionPorts> = {},
    ) {
      const service = new EntryPdfAcquisitionService({
        registry: new PublicAcquisitionRegistry(
          [...sources],
          sources.map((source) => source.source_name),
        ),
        network_budget: app.networkBudget,
        transfers: app.execution!.transfers,
        acceptance: app.execution!.acceptance,
        ...(app.configuration.sources.publisher_aliases
          ? { publisher_aliases: app.configuration.sources.publisher_aliases }
          : {}),
        resolve_doi_landing: async () => {
          throw new Error("Unconfigured offline DOI resolution");
        },
        ...overrides,
      });
      owned.push(service);
      return service;
    },
    async seed(
      n: number,
      options: {
        publisher?: string;
        version?: VersionRole;
        identifiers?: readonly Identifier[];
        hints?: readonly AssetHint[];
      } = {},
    ): Promise<PdfAcquisitionRequest> {
      const literature = parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(n),
        meta_literature_id: id(1000 + n),
        version_role: options.version ?? "published",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          publisher: options.publisher ?? null,
          identifiers: options.identifiers ?? [
            { namespace: "doi", value: doi(n) },
          ],
        },
      });
      await app.database.putLiterature(literature);
      if (options.hints?.length) {
        const observation = parseMetadataObservation({
          source_type: null,
          source_type_mapping_version: null,
          observation_id: id(2000 + n),
          metadata: literature.metadata,
          provenance: {
            provenance_id: id(3000 + n),
            source_kind: "metadata-provider",
            source_name: "crossref",
            source_record_id: `fixture-${n}`,
            observed_at: "2026-10-11T00:00:00Z",
            input_sha256: "a".repeat(64),
            parameters_sha256: null,
          },
          version_role: literature.version_role,
          version_links: [],
          declared_keywords: [],
          reference_texts: [],
          reference_count: null,
          cited_by_count: null,
          asset_hints: options.hints,
        });
        await app.observations.publish(observation);
        const facts = (await app.database.currentFacts(
          literature.literature_id,
        ))!;
        await app.observations.accept(
          observation.observation_id,
          literature.literature_id,
          facts.metadata_snapshot.revision,
          facts.metadata_snapshot.sha256,
        );
      }
      return {
        literature_id: literature.literature_id,
        detail: await app.library.detail(literature.literature_id),
        metadata_snapshot: (await app.database.currentFacts(
          literature.literature_id,
        ))!.metadata_snapshot,
        signal: new AbortController().signal,
      };
    },
    async browserPdf(request: BrowserDeliveryRequest) {
      const bytes = workbenchPdf(request.identifier, request.version);
      const candidate = await downloadPdfCandidate(
        safeLocator("browser", "https://browser.example.test/file.pdf"),
        { request: async () => ({ status: 200, headers: [], body: bytes }) },
        {
          collector: app.execution!.transfers,
          transfer_id: `browser-${request.literature_id}`,
          capture: {
            session_id: "offline",
            article_id: request.literature_id,
            page_id: "offline-page",
            document_generation: 0,
            source_url: "https://browser.example.test/file.pdf",
            captured_at: new Date().toISOString(),
          },
        },
      );
      return { kind: "delivered" as const, candidate, accepted: true };
    },
    async close() {
      transport.mockRestore();
      for (const service of owned) await service.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function stageSource(
  stage: AcquisitionStage,
  events: string[],
  succeeds: (request: AcquisitionSourceRequest) => boolean,
  check: (request: AcquisitionSourceRequest) => void = () => undefined,
): AcquisitionSourcePort {
  const source = `fixture-${stage}`;
  return {
    source_name: source,
    ready: true,
    acquisition_stage: stage,
    async discover(request) {
      check(request);
      const value =
        request.identifiers.find((item) => item.namespace === "doi")?.value ??
        "missing";
      events.push(`${stage}:${value}`);
      await Promise.resolve();
      return succeeds(request)
        ? [
            safeLocator(
              source,
              `https://fixture.example.test/${stage}/${encodeURIComponent(value)}.pdf`,
            ),
          ]
        : [];
    },
    async download_candidate(candidate) {
      networkRequestDispatched();
      const value = decodeURIComponent(
        new URL(candidate.locator).pathname
          .split("/")
          .at(-1)!
          .replace(/\.pdf$/u, ""),
      );
      return {
        kind: "download",
        bytes: workbenchPdf(value),
        media_type: "application/pdf",
        safe_source_url: candidate.locator,
        entitlement: "granted",
        locator: {
          namespace: "doi",
          value,
          declared_media_type: "application/pdf",
          source_record_id: source,
        },
      };
    },
  };
}

it.each([0, 1, 2, 3, 4])(
  "stops at the first published PDF across all five stages (successful stage %s)",
  async (successfulStage) => {
    const test = await fixture();
    const events: string[] = [];
    const trace: AcquisitionAttempt[] = [];
    const deliver = vi.fn(async (request: BrowserDeliveryRequest) => {
      events.push("browser");
      return test.browserPdf(request);
    });
    const resolve = vi.fn(async () => null);
    try {
      // Reverse registry order to prove stage ownership overrides configured source order.
      const sources = stages
        .map((stage, index) =>
          stageSource(stage, events, () => index === successfulStage),
        )
        .reverse();
      const service = test.service([...sources, marker], {
        resolve_doi_landing: resolve,
        browser_host: () => ({
          deliverCandidate: deliver,
          close: async () => undefined,
        }),
      });
      const request = await test.seed(1);
      expect(
        (
          await service.acquire({
            ...request,
            on_attempt: async (a) => {
              trace.push(a);
            },
          })
        ).kind,
      ).toBe("acquired");
      // The browser stage records its escalation and then the delivery that
      // the browser host made, so the task shows which source got the PDF.
      expect(trace.map((a) => a.result)).toEqual([
        ...Array(Math.min(successfulStage, 4)).fill("not-applicable"),
        ...(successfulStage === 4 ? ["escalated", "hit"] : ["hit"]),
      ]);
      expect(trace.at(-1)?.requested).toBe(successfulStage !== 4);
      if (successfulStage === 4)
        expect(deliver.mock.calls[0]![0].prior_attempts).toEqual(
          trace.slice(0, -1),
        );
      expect(JSON.stringify(trace)).not.toMatch(
        /https|headers|fixture.example/,
      );
      expect(events).toEqual([
        ...stages
          .slice(0, Math.min(successfulStage + 1, 4))
          .map((stage) => `${stage}:${doi(1)}`),
        ...(successfulStage === 4 ? ["browser"] : []),
      ]);
      expect(deliver).toHaveBeenCalledTimes(successfulStage === 4 ? 1 : 0);
      expect(resolve).not.toHaveBeenCalled();
      expect(
        (await test.app.library.detail(request.literature_id)).primary_pdf,
      ).not.toBeNull();
    } finally {
      await test.close();
    }
  },
);

it("keeps all four cohort barriers and passes the frozen version to every source and Browser", async () => {
  const test = await fixture();
  const events: string[] = [];
  const waves: number[][] = [];
  const discoveries = [0, 0, 0, 0];
  const browser = vi.fn(async (request: BrowserDeliveryRequest) => {
    expect(discoveries).toEqual([5, 4, 3, 2]);
    expect(waves).toEqual([[0], [1], [2], [3]]);
    expect(request.version).toBe("accepted-manuscript");
    expect(request.article_goal?.version).toBe("accepted-manuscript");
    return test.browserPdf(request);
  });
  try {
    const sources = stages.map((stage, stageIndex) =>
      stageSource(
        stage,
        events,
        (request) =>
          request.identifiers.some(
            (item) => item.value === doi(stageIndex + 1),
          ),
        (request) => {
          expect(request.target_version).toBe("accepted-manuscript");
          if (stageIndex > 0) {
            expect(discoveries[stageIndex - 1]).toBe(6 - stageIndex);
            expect(waves).toHaveLength(stageIndex);
          }
          discoveries[stageIndex] = discoveries[stageIndex]! + 1;
        },
      ),
    );
    const service = test.service([...sources, marker], {
      browser_host: () => ({
        deliverCandidate: browser,
        close: async () => undefined,
      }),
    });
    const requests = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        test.seed(n, { version: "accepted-manuscript" }),
      ),
    );
    const outcomes = await service.acquireCohort(requests, {
      on_outcomes: (wave) => waves.push(wave.map((item) => item.index)),
    });
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(
      Array(5).fill("acquired"),
    );
    expect(waves).toEqual([[0], [1], [2], [3], [4]]);
    expect(browser).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 3; index += 1) {
      const current = events.map((event, position) =>
        event.startsWith(`${stages[index]}:`) ? position : -1,
      );
      expect(
        events.findIndex((event) => event.startsWith(`${stages[index + 1]}:`)),
      ).toBeGreaterThan(Math.max(...current));
    }
  } finally {
    await test.close();
  }
});

it.each([
  "https://www.sciencedirect.com/science/article/pii/FIXTURE",
  "https://onlinelibrary.wiley.com/doi/fixture",
  null,
])(
  "resolves a weak publisher name once and uses actual article landing evidence: %s",
  async (landing) => {
    const test = await fixture();
    const resolver = vi.fn(async (url: string) => {
      expect(url).toBe(`https://doi.org/${doi(1)}`);
      return landing;
    });
    const targets: {
      provider: string;
      count: number;
      origins: readonly string[];
    }[] = [];
    const browser = vi.fn(async (request: BrowserDeliveryRequest) => {
      expect(request.version).toBe("accepted-manuscript");
      return { kind: "exhausted" as const, reason: "offline fixture" };
    });
    try {
      const sources: AcquisitionSourcePort[] = (
        ["elsevier", "wiley"] as const
      ).map((provider) => ({
        source_name: provider,
        ready: true,
        acquisition_stage: "publisher-api",
        async discover(request) {
          targets.push({
            provider,
            count: authorizedTargets(provider, request).length,
            origins: request.landing_origins ?? [],
          });
          return [];
        },
      }));
      const service = test.service([...sources, marker], {
        publisher_aliases: { elsevier: ["Local Press"] },
        resolve_doi_landing: resolver,
        browser_host: () => ({
          deliverCandidate: browser,
          close: async () => undefined,
        }),
      });
      const request = await test.seed(1, {
        publisher: "Local Press",
        version: "accepted-manuscript",
      });
      expect((await service.acquire(request)).kind).toBe("exhausted");
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver.mock.calls[0]?.[0]).toBe(`https://doi.org/${doi(1)}`);
      expect(targets.map(({ count }) => count)).toEqual(
        landing?.includes("sciencedirect")
          ? [1, 0]
          : landing?.includes("wiley")
            ? [0, 1]
            : [0, 0],
      );
      expect(browser).toHaveBeenCalledTimes(1);
      const delivered = browser.mock.calls[0]?.[0];
      if (landing !== null) expect(delivered?.start_urls?.[0]).toBe(landing);
      expect(request.detail.literature.metadata.publisher).toBe("Local Press");
    } finally {
      await test.close();
    }
  },
);

it("does not resolve DOI again when existing article evidence already selects the publisher API", async () => {
  const test = await fixture();
  const resolver = vi.fn(async () => null);
  const observed: AcquisitionSourceRequest[] = [];
  try {
    const service = test.service(
      [
        {
          source_name: "elsevier",
          ready: true,
          acquisition_stage: "publisher-api",
          discover: async (request) => {
            observed.push(request);
            return [];
          },
        },
      ],
      { resolve_doi_landing: resolver },
    );
    await service.acquire(
      await test.seed(1, {
        hints: [
          hint("https://www.sciencedirect.com/science/article/pii/FIXTURE"),
        ],
      }),
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(authorizedTargets("elsevier", observed[0]!)).toHaveLength(1);
  } finally {
    await test.close();
  }
});

it("does not promote other-version or supplemental site hints into target API evidence", async () => {
  const test = await fixture();
  const resolver = vi.fn(
    async () => "https://www.sciencedirect.com/science/article/pii/FIXTURE",
  );
  const observed: AcquisitionSourceRequest[] = [];
  try {
    const service = test.service(
      (["elsevier", "wiley"] as const).map((provider) => ({
        source_name: provider,
        ready: true,
        acquisition_stage: "publisher-api",
        discover: async (request) => {
          observed.push(request);
          return [];
        },
      })),
      { resolve_doi_landing: resolver },
    );
    await service.acquire(
      await test.seed(1, {
        version: "accepted-manuscript",
        hints: [
          hint("https://onlinelibrary.wiley.com/doi/published", "published"),
          hint(
            "https://onlinelibrary.wiley.com/doi/supplement",
            null,
            "supplementary-pdf",
          ),
        ],
      }),
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(observed[0]?.target_version).toBe("accepted-manuscript");
    expect(authorizedTargets("elsevier", observed[0]!)).toHaveLength(1);
    expect(authorizedTargets("wiley", observed[1]!)).toHaveLength(0);
  } finally {
    await test.close();
  }
});

it.each([
  ["pmid", "1234567", "https://pubmed.ncbi.nlm.nih.gov/1234567/"],
  ["pmcid", "PMC1234567", "https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/"],
  ["arxiv", "2401.01234", "https://arxiv.org/abs/2401.01234"],
] as const)(
  "uses a %s article start when DOI and landing-page hints are absent",
  async (namespace, value, start) => {
    const test = await fixture();
    const browser = vi.fn(async (request: BrowserDeliveryRequest) => {
      expect(request.start_url).toBe(start);
      return { kind: "exhausted" as const, reason: "offline fixture" };
    });
    try {
      const service = test.service([marker], {
        browser_host: () => ({
          deliverCandidate: browser,
          close: async () => undefined,
        }),
      });
      await service.acquire(
        await test.seed(1, { identifiers: [{ namespace, value }] }),
      );
      expect(browser).toHaveBeenCalledTimes(1);
      expect(browser.mock.calls[0]![0]).toMatchObject({
        start_url: start,
        start_urls: [start],
        article_goal: { identifiers: [{ namespace, value }] },
      });
    } finally {
      await test.close();
    }
  },
);

it.each([404, 502])(
  "passes HTTP %s failure evidence into one Browser delivery and retains the usable alternatives",
  async (status) => {
    const test = await fixture();
    const failed = "https://www.sciencedirect.com/science/article/pii/FAILED";
    const alternate = "https://mirror.example.test/article";
    const browser = vi.fn(async (request: BrowserDeliveryRequest) => {
      if (status === 404) return test.browserPdf(request);
      return { kind: "exhausted" as const, reason: "offline fixture" };
    });
    const transport: PdfDownloadTransport = {
      request: vi.fn(async () => ({
        status,
        headers: [],
        body: new Uint8Array(),
      })),
    };
    test.transport.mockReturnValue(transport);
    try {
      const source: AcquisitionSourcePort = {
        source_name: "fixture-public-web",
        ready: true,
        acquisition_stage: "public-web",
        discover: async () => [safeLocator("fixture-public-web", failed)],
      };
      const service = test.service([source, marker], {
        browser_host: () => ({
          deliverCandidate: browser,
          close: async () => undefined,
        }),
      });
      const request = await test.seed(1, {
        hints: [hint(failed), hint(alternate)],
      });
      const result = await service.acquire(request);
      expect(browser).toHaveBeenCalledTimes(1);
      expect(browser.mock.calls[0]![0].start_urls).toEqual([
        alternate,
        `https://doi.org/${doi(1)}`,
        failed,
      ]);
      expect(transport.request).toHaveBeenCalledTimes(1);
      if (status === 404) {
        expect(result.kind).toBe("acquired");
        expect(
          (await test.app.library.detail(request.literature_id)).primary_pdf
            ?.asset.sha256,
        ).toBe(await sha256(workbenchPdf(`doi:${doi(1)}`, "published")));
      } else
        expect(result).toMatchObject({
          kind: "route-failure",
          failure: {
            source: "fixture-public-web",
            code: "http-response-failed",
            retryable: true,
          },
        });
    } finally {
      await test.close();
    }
  },
);

it("reuses resolved DOI and previously attempted locators across stages without duplicate HTTP downloads", async () => {
  const test = await fixture();
  const landing = "https://www.sciencedirect.com/science/article/pii/FIXTURE";
  const resolve = vi.fn(async () => landing);
  const browser = vi.fn(async (request: BrowserDeliveryRequest) => {
    expect(request.start_urls).toEqual([landing, `https://doi.org/${doi(1)}`]);
    return { kind: "exhausted" as const, reason: "offline fixture" };
  });
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe(landing);
    return {
      status: 200,
      headers: [["content-type", "text/html"] as const],
      body: new TextEncoder().encode(
        "<html><body>Interaction required</body></html>",
      ),
      final_url: landing,
    };
  });
  test.transport.mockReturnValue({ request: fetch });
  try {
    const sources: AcquisitionSourcePort[] = [
      {
        source_name: "elsevier",
        acquisition_stage: "publisher-api",
        ready: true,
        discover: async (request) => {
          expect(authorizedTargets("elsevier", request)).toHaveLength(1);
          return [];
        },
      },
      {
        source_name: "fixture-general",
        acquisition_stage: "general-api",
        ready: true,
        discover: async () => [safeLocator("fixture-general", landing)],
      },
      new DoiLandingSource(),
      marker,
    ];
    const service = test.service(sources, {
      resolve_doi_landing: resolve,
      browser_host: () => ({
        deliverCandidate: browser,
        close: async () => undefined,
      }),
    });
    expect(
      (await service.acquire(await test.seed(1, { publisher: "Elsevier" })))
        .kind,
    ).toBe("exhausted");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browser).toHaveBeenCalledTimes(1);
  } finally {
    await test.close();
  }
});

it.each([
  [undefined, "elsevier"],
  ['[sources.publisher_aliases]\nwiley = ["Local Press"]\n', "wiley"],
  [
    '[sources.publisher_aliases]\nwiley = ["Local Press"]\nelsevier = ["Local Press"]\n',
    "elsevier",
  ],
] as const)(
  "uses a saved unique publisher alias to prioritize applicable APIs while conflicts preserve configured order: %s",
  async (configurationText, expected) => {
    const test = await fixture(configurationText);
    const attempted: string[] = [];
    const downloads: string[] = [];
    try {
      const sources: AcquisitionSourcePort[] = (
        ["elsevier", "wiley"] as const
      ).map((provider) => ({
        source_name: provider,
        ready: true,
        acquisition_stage: "publisher-api",
        async discover(request) {
          attempted.push(provider);
          expect(authorizedTargets(provider, request)).toHaveLength(1);
          return [
            safeLocator(provider, `https://${provider}.example.test/file.pdf`),
          ];
        },
        async download_candidate(candidate) {
          downloads.push(provider);
          return {
            kind: "download",
            bytes: workbenchPdf(doi(1)),
            media_type: "application/pdf",
            safe_source_url: candidate.locator,
            entitlement: "granted",
            locator: {
              namespace: "doi",
              value: doi(1),
              declared_media_type: "application/pdf",
              source_record_id: provider,
            },
          };
        },
      }));
      const service = test.service(sources);
      const request = await test.seed(1, {
        publisher: "Local Press",
        hints: [
          hint("https://www.sciencedirect.com/article/example"),
          hint("https://onlinelibrary.wiley.com/doi/example"),
        ],
      });
      expect((await service.acquire(request)).kind).toBe("acquired");
      expect(attempted).toEqual([expected]);
      expect(downloads).toEqual([expected]);
    } finally {
      await test.close();
    }
  },
);

it("does not let a saved but incorrect publisher alias enable an inapplicable API", async () => {
  const test = await fixture(
    '[sources.publisher_aliases]\nelsevier = ["Local Press"]\n',
  );
  const attempted: string[] = [];
  const downloads: string[] = [];
  try {
    const sources: AcquisitionSourcePort[] = (
      ["wiley", "elsevier"] as const
    ).map((provider) => ({
      source_name: provider,
      ready: true,
      acquisition_stage: "publisher-api",
      async discover(request) {
        const eligible = authorizedTargets(provider, request).length;
        attempted.push(`${provider}:${eligible}`);
        return eligible
          ? [safeLocator(provider, `https://${provider}.example.test/file.pdf`)]
          : [];
      },
      async download_candidate(candidate) {
        downloads.push(provider);
        return {
          kind: "download",
          bytes: workbenchPdf(doi(1)),
          media_type: "application/pdf",
          safe_source_url: candidate.locator,
          entitlement: "granted",
          locator: {
            namespace: "doi",
            value: doi(1),
            declared_media_type: "application/pdf",
            source_record_id: provider,
          },
        };
      },
    }));
    const service = test.service(sources);
    const request = await test.seed(1, {
      publisher: "Local Press",
      hints: [hint("https://onlinelibrary.wiley.com/doi/example")],
    });
    expect((await service.acquire(request)).kind).toBe("acquired");
    expect(attempted).toEqual(["elsevier:0", "wiley:1"]);
    expect(downloads).toEqual(["wiley"]);
  } finally {
    await test.close();
  }
});

it("retains an HTTP DOI landing as a Browser entry without crashing the HTTPS download boundary", async () => {
  const test = await fixture();
  const landing = "http://publisher.example.test/article";
  const browser = vi.fn(async (request: BrowserDeliveryRequest) => {
    expect(request.start_url).toBe(landing);
    return test.browserPdf(request);
  });
  test.transport.mockReturnValue({
    request: async () => ({
      status: 200,
      headers: [["content-type", "text/html"]],
      body: new TextEncoder().encode("<html>Article</html>"),
    }),
  });
  try {
    const service = test.service(
      [
        {
          source_name: "elsevier",
          ready: true,
          acquisition_stage: "publisher-api",
          discover: async (request) => {
            expect(authorizedTargets("elsevier", request)).toHaveLength(0);
            return [];
          },
        },
        new DoiLandingSource(),
        marker,
      ],
      {
        resolve_doi_landing: async () => landing,
        browser_host: () => ({
          deliverCandidate: browser,
          close: async () => undefined,
        }),
      },
    );
    expect((await service.acquire(await test.seed(1))).kind).toBe("acquired");
    expect(browser).toHaveBeenCalledTimes(1);
  } finally {
    await test.close();
  }
});

it.each([
  doi(1),
  "10.1002/(SICI)1097-0258(19970615)16:11<1239::AID-SIM541>3.0.CO;2-8",
])(
  "publishes PDF bytes returned during DOI resolution before any API or page lookup: %s",
  async (identifier) => {
    const test = await fixture();
    const bytes = workbenchPdf(identifier);
    const publisher = vi.fn(async () => []);
    const general = vi.fn(async () => []);
    const publicWeb = vi.fn(async () => []);
    const browser = vi.fn(async () => ({
      kind: "exhausted" as const,
      reason: "should not run",
    }));
    const request = vi.fn(async () => {
      throw new Error("Cached PDF must not be fetched again");
    });
    test.transport.mockReturnValue({ request });
    const resolve = vi.fn<
      NonNullable<EntryPdfAcquisitionPorts["resolve_doi_landing"]>
    >(async (url, _signal, options) => {
      options.on_response({
        status: 200,
        headers: [["content-type", "application/pdf"]],
        body: bytes,
        final_url: url,
      });
      return null;
    });
    try {
      const service = test.service(
        [
          {
            source_name: "elsevier",
            ready: true,
            acquisition_stage: "publisher-api",
            discover: publisher,
          },
          {
            source_name: "fixture-general",
            ready: true,
            acquisition_stage: "general-api",
            discover: general,
          },
          {
            source_name: "fixture-public-web",
            ready: true,
            acquisition_stage: "public-web",
            discover: publicWeb,
          },
          marker,
        ],
        {
          resolve_doi_landing: resolve,
          browser_host: () => ({
            deliverCandidate: browser,
            close: async () => undefined,
          }),
        },
      );
      const target = await test.seed(1, {
        identifiers: [{ namespace: "doi", value: identifier }],
      });
      expect((await service.acquire(target)).kind).toBe("acquired");
      expect(resolve).toHaveBeenCalledTimes(1);
      const canonical = target.detail.literature.metadata.identifiers.find(
        (item) => item.namespace === "doi",
      )!.value;
      expect(resolve.mock.calls[0]![0]).toBe(
        `https://doi.org/${canonical.split("/").map(encodeURIComponent).join("/")}`,
      );
      expect(request).not.toHaveBeenCalled();
      expect(publisher).not.toHaveBeenCalled();
      expect(general).not.toHaveBeenCalled();
      expect(publicWeb).not.toHaveBeenCalled();
      expect(browser).not.toHaveBeenCalled();
      expect(
        (await test.app.library.detail(target.literature_id)).primary_pdf?.asset
          .sha256,
      ).toBe(await sha256(bytes));
    } finally {
      await test.close();
    }
  },
);

it("reuses DOI HTML and requests only its discovered PDF link after API misses", async () => {
  const test = await fixture();
  const file = "https://publisher.example.test/paper.pdf";
  const bytes = workbenchPdf(doi(1));
  const phases: string[] = [];
  const request = vi.fn(async (url: string) => {
    phases.push("pdf");
    expect(url).toBe(file);
    return {
      status: 200,
      headers: [["content-type", "application/pdf"] as const],
      body: bytes,
    };
  });
  test.transport.mockReturnValue({ request });
  const resolve = vi.fn<
    NonNullable<EntryPdfAcquisitionPorts["resolve_doi_landing"]>
  >(async (url, _signal, options) => {
    phases.push("doi");
    options.on_response({
      status: 200,
      headers: [["content-type", "text/html"]],
      body: new TextEncoder().encode(
        `<html><head><meta name="citation_pdf_url" content="${file}"></head></html>`,
      ),
      final_url: url,
    });
    return null;
  });
  try {
    const service = test.service(
      [
        {
          source_name: "elsevier",
          ready: true,
          acquisition_stage: "publisher-api",
          discover: async () => {
            phases.push("publisher");
            return [];
          },
        },
        {
          source_name: "fixture-general",
          ready: true,
          acquisition_stage: "general-api",
          discover: async () => {
            phases.push("general");
            return [];
          },
        },
        new DoiLandingSource(),
      ],
      { resolve_doi_landing: resolve },
    );
    expect((await service.acquire(await test.seed(1))).kind).toBe("acquired");
    expect(phases).toEqual(["doi", "publisher", "general", "pdf"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await test.close();
  }
});

it.each([403, 404])(
  "reuses DOI HTTP %s without a duplicate GET and keeps one Browser rescue",
  async (status) => {
    const test = await fixture();
    const request = vi.fn(async () => {
      throw new Error("Cached HTTP response must not be requested again");
    });
    test.transport.mockReturnValue({ request });
    const resolve = vi.fn<
      NonNullable<EntryPdfAcquisitionPorts["resolve_doi_landing"]>
    >(async (url, _signal, options) => {
      options.on_response({
        status,
        headers: [],
        body: new Uint8Array(),
        final_url: url,
      });
      return null;
    });
    const browser = vi.fn(async (target: BrowserDeliveryRequest) => {
      expect(target.start_urls).toContain(`https://doi.org/${doi(1)}`);
      return test.browserPdf(target);
    });
    try {
      const service = test.service(
        [
          {
            source_name: "elsevier",
            ready: true,
            acquisition_stage: "publisher-api",
            discover: async () => [],
          },
          new DoiLandingSource(),
          marker,
        ],
        {
          resolve_doi_landing: resolve,
          browser_host: () => ({
            deliverCandidate: browser,
            close: async () => undefined,
          }),
        },
      );
      expect((await service.acquire(await test.seed(1))).kind).toBe("acquired");
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();
      expect(browser).toHaveBeenCalledTimes(1);
    } finally {
      await test.close();
    }
  },
);

it.each(["collector", "acceptance"] as const)(
  "does not mask a %s storage failure while publishing cached DOI PDF bytes",
  async (failureOwner) => {
    const test = await fixture();
    const failure = Object.assign(new Error("Synthetic persistence failure"), {
      code: "EIO",
    });
    const persistence =
      failureOwner === "collector"
        ? vi
            .spyOn(test.app.execution!.transfers, "begin")
            .mockRejectedValueOnce(failure)
        : vi
            .spyOn(test.app.execution!.acceptance, "accept")
            .mockRejectedValueOnce(failure);
    const publisher = vi.fn(async () => []);
    const browser = vi.fn(async () => ({
      kind: "exhausted" as const,
      reason: "should not run",
    }));
    try {
      const service = test.service(
        [
          {
            source_name: "elsevier",
            ready: true,
            acquisition_stage: "publisher-api",
            discover: publisher,
          },
          marker,
        ],
        {
          resolve_doi_landing: async (url, _signal, options) => {
            options.on_response({
              status: 200,
              headers: [],
              body: workbenchPdf(doi(1)),
              final_url: url,
            });
            return null;
          },
          browser_host: () => ({
            deliverCandidate: browser,
            close: async () => undefined,
          }),
        },
      );
      const target = await test.seed(1);
      await expect(service.acquire(target)).rejects.toBe(failure);
      expect(persistence).toHaveBeenCalledTimes(1);
      expect(publisher).not.toHaveBeenCalled();
      expect(browser).not.toHaveBeenCalled();
      expect(
        (await test.app.library.detail(target.literature_id)).primary_pdf,
      ).toBeNull();
    } finally {
      persistence.mockRestore();
      await test.close();
    }
  },
);
