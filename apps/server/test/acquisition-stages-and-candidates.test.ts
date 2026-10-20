import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetHint } from "@sciretriever/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assemblePublicAcquisitionRegistry,
  splitAcquisitionRoutes,
} from "../src/acquisition/assembly.js";
import type { AcquisitionSourcePort } from "../src/acquisition/ports.js";
import {
  AuthorizedPdfSource,
  DirectPdfSource,
  PublicAcquisitionRegistry,
  downloadPdfCandidate,
  downloadSourceCandidate,
  type PdfDownloadOptions,
} from "../src/acquisition/sources/public.js";
import { safeLocator } from "../src/acquisition/sources/locators.js";
import { createApplication } from "../src/bootstrap/application.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { CoreAuthorizedPdfClient } from "../src/providers/core/acquisition.js";
import { ElsevierAuthorizedPdfClient } from "../src/providers/elsevier/acquisition.js";
import { WileyAuthorizedPdfClient } from "../src/providers/wiley/acquisition.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";

function hint(url: string, rest: Partial<AssetHint> = {}): AssetHint {
  return {
    url,
    kind: "direct-file",
    media_type: null,
    asset_role: null,
    version_role: null,
    access_status: null,
    license: null,
    ...rest,
  };
}

const names = (registry: PublicAcquisitionRegistry) =>
  registry.sources.map((source) => source.source_name);

function source(
  sourceName: string,
  rest: Partial<AcquisitionSourcePort> = {},
): AcquisitionSourcePort {
  return {
    source_name: sourceName,
    ready: true,
    async discover() {
      return [];
    },
    ...rest,
  };
}

describe("acquisition stages independent of authentication", () => {
  it("keeps configured order within four stages and preserves unavailable selected APIs", async () => {
    const coordinator = new NetworkBudgetCoordinator();
    try {
      const registry = assemblePublicAcquisitionRegistry(
        parseConfiguration(
          '[sources.acquisition]\nmode = "custom"\nproviders = ["sci-hub", "core", "wiley", "europe-pmc", "unpaywall", "elsevier", "arxiv"]\n',
        ),
        coordinator,
      );
      const split = splitAcquisitionRoutes(registry);
      expect(names(split.stages.direct)).toEqual([
        "direct",
        "europe-pmc",
        "arxiv",
      ]);
      expect(names(split.stages["publisher-api"])).toEqual([
        "wiley",
        "elsevier",
      ]);
      expect(names(split.stages["general-api"])).toEqual(["core", "unpaywall"]);
      expect(names(split.stages["public-web"])).toEqual([
        "sci-hub",
        "doi-landing",
      ]);
      expect(names(split.authorized_api_routes)).toEqual([
        "core",
        "wiley",
        "elsevier",
      ]);
      expect(names(split.public_routes)).toEqual([
        "direct",
        "sci-hub",
        "europe-pmc",
        "unpaywall",
        "arxiv",
        "doi-landing",
      ]);
      expect(split.stages["general-api"].statuses).toEqual([
        {
          source_name: "core",
          ready: false,
          failure_code: "missing-credential",
        },
        {
          source_name: "unpaywall",
          ready: false,
          failure_code: "missing-ordinary-parameter",
        },
      ]);
      for (const stage of ["publisher-api", "general-api"] as const)
        for (const item of split.stages[stage].sources)
          await expect(
            item.discover({ identifiers: [] }),
          ).rejects.toMatchObject({
            code: "download-unavailable",
            retryable: false,
          });
    } finally {
      coordinator.close();
    }
  });

  it("reads authorized stages from each provider while keeping credential routing", () => {
    for (const provider of ["core", "elsevier", "wiley"] as const) {
      const authorized = new AuthorizedPdfSource({
        provider,
        lookup: () => ({ kind: "miss" }),
        download: async () => {
          throw new Error("unexpected download");
        },
      });
      expect(authorized.acquisition_tier).toBe("authorized-api");
      expect(authorized.acquisition_stage).toBe(
        provider === "core" ? "general-api" : "publisher-api",
      );
    }
  });

  it("retains legacy custom source defaults and honors explicit stage overrides", () => {
    const registry = new PublicAcquisitionRegistry([
      source("custom-public"),
      source("custom-api", { acquisition_tier: "authorized-api" }),
      source("custom-general", { acquisition_stage: "general-api" }),
      source("custom-web", { acquisition_stage: "public-web" }),
    ]);
    const split = splitAcquisitionRoutes(registry);
    expect(names(split.stages.direct)).toEqual(["custom-public"]);
    expect(names(split.stages["publisher-api"])).toEqual(["custom-api"]);
    expect(names(split.stages["general-api"])).toEqual(["custom-general"]);
    expect(names(split.stages["public-web"])).toEqual(["custom-web"]);
    expect(names(split.authorized_api_routes)).toEqual(["custom-api"]);
  });

  it("keeps an explicitly selected missing adapter and an unready custom source as failures", async () => {
    const discover = vi.fn(async () => []);
    const split = splitAcquisitionRoutes(
      new PublicAcquisitionRegistry(
        [
          source("unready", {
            acquisition_stage: "general-api",
            ready: false,
            discover,
          }),
        ],
        ["wiley", "unready"],
      ),
    );
    expect(split.stages["publisher-api"].statuses).toEqual([
      {
        source_name: "wiley",
        ready: false,
        failure_code: "missing-source-adapter",
      },
    ]);
    for (const stage of ["publisher-api", "general-api"] as const)
      await expect(
        split.stages[stage].sources[0]!.discover({ identifiers: [] }),
      ).rejects.toMatchObject({
        code: "download-unavailable",
        retryable: false,
      });
    expect(discover).not.toHaveBeenCalled();
  });
});

describe("Direct PDF hint selection", () => {
  it("uses pathname suffixes or explicit PDF evidence and preserves queries while removing viewer fragments", async () => {
    const candidates = await new DirectPdfSource().discover({
      identifiers: [],
      target_version: "published",
      asset_hints: [
        hint("https://repository.example/paper.PDF?download=1#page=2"),
        hint("https://repository.example/download/123", {
          media_type: "Application/PDF; charset=binary",
        }),
        hint("https://repository.example/content/456", {
          asset_role: "primary-pdf",
        }),
        hint("https://repository.example/landing.Pdf", {
          kind: "landing-page",
        }),
        hint("https://repository.example/paper.PDF?download=1#view=FitH"),
        hint("https://repository.example/article?download=paper.pdf"),
        hint("https://repository.example/not.pdf/landing"),
        hint("https://repository.example/unknown"),
      ],
    });
    expect(candidates.map((candidate) => candidate.locator)).toEqual([
      "https://repository.example/paper.PDF?download=1",
      "https://repository.example/download/123",
      "https://repository.example/content/456",
      "https://repository.example/landing.Pdf",
    ]);
  });

  it("excludes supplementary assets, other explicit versions, credential URLs and authorized API endpoints", async () => {
    const candidates = await new DirectPdfSource().discover({
      identifiers: [],
      target_version: "published",
      asset_hints: [
        hint("https://repository.example/supplement.pdf", {
          asset_role: "supplementary-pdf",
        }),
        hint("https://repository.example/appendix.pdf", {
          asset_role: "supplementary",
        }),
        hint("https://repository.example/document.pdf", { asset_role: "xml" }),
        hint("https://repository.example/preprint.pdf", {
          version_role: "preprint",
        }),
        hint("https://repository.example/accepted.pdf", {
          version_role: "accepted-manuscript",
        }),
        hint("https://repository.example/private.pdf?token=fixture"),
        hint("https://user:password@repository.example/private.pdf"),
        hint("https://api.wiley.com/onlinelibrary/tdm/v1/articles/main.pdf"),
        hint("https://api.elsevier.com/content/article/main.PDF"),
        hint("https://api.core.ac.uk/v3/outputs/main.pdf"),
        hint("https://repository.example/published.pdf", {
          version_role: "published",
        }),
        hint("https://repository.example/unspecified.pdf"),
      ],
    });
    expect(candidates.map((candidate) => candidate.locator)).toEqual([
      "https://repository.example/published.pdf",
      "https://repository.example/unspecified.pdf",
    ]);
    await expect(
      new DirectPdfSource().discover({
        identifiers: [],
        asset_hints: [
          hint("https://repository.example/preprint.pdf", {
            version_role: "preprint",
          }),
        ],
      }),
    ).resolves.toHaveLength(1);
  });
});

describe("operation-local download response observations", () => {
  it("accepts mislabelled PDF bytes from every authorized API without a second GET", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-authorized-media-"),
    );
    const app = await createApplication(home, {});
    try {
      for (const provider of ["core", "elsevier", "wiley"] as const) {
        const pdf = workbenchPdf();
        const request = vi.fn(async () => ({
          status: 200,
          headers: [["content-type", "application/xml"]] as const,
          body: pdf,
        }));
        const client =
          provider === "core"
            ? new CoreAuthorizedPdfClient({ request }, "fixture")
            : provider === "elsevier"
              ? new ElsevierAuthorizedPdfClient({ request }, "fixture")
              : new WileyAuthorizedPdfClient({ request }, "fixture");
        const authorized = new AuthorizedPdfSource(client);
        const [candidate] = await authorized.discover({
          identifiers: [
            { namespace: "doi", value: "10.5555/fixture" },
            { namespace: "core-work", value: "fixture-work" },
            { namespace: "pii", value: "S0014579301033130" },
          ],
          landing_origins: ["https://onlinelibrary.wiley.com"],
        });
        expect(candidate).toBeDefined();
        const durable = await downloadSourceCandidate(candidate!, {
          collector: app.execution!.transfers,
          transfer_id: `mislabelled-${provider}`,
          registry: new PublicAcquisitionRegistry([authorized], [provider]),
        });
        expect(await app.execution!.transfers.candidateBytes(durable)).toEqual(
          pdf,
        );
        expect(request).toHaveBeenCalledTimes(1);
      }
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("observes failed responses before classification without probing again", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-response-observations-"),
    );
    const app = await createApplication(home, {});
    try {
      for (const status of [403, 404, 429, 503]) {
        const observed: Parameters<
          NonNullable<PdfDownloadOptions["on_response"]>
        >[0][] = [];
        const request = vi.fn(async () => ({
          status,
          final_url: "https://publisher.example/article",
          headers: [["Content-Type", "text/html; charset=utf-8"]] as const,
          body: new TextEncoder().encode("<html>unavailable</html>"),
        }));
        await expect(
          downloadPdfCandidate(
            safeLocator("direct", "https://repository.example/main.pdf"),
            { request },
            {
              collector: app.execution!.transfers,
              transfer_id: `status-${status}`,
              on_response: (response) => observed.push(response),
            },
          ),
        ).rejects.toBeInstanceOf(Error);
        expect(observed).toEqual([
          {
            requested_url: "https://repository.example/main.pdf",
            final_url: "https://publisher.example/article",
            status,
            media_type: "text/html",
          },
        ]);
        expect(request).toHaveBeenCalledTimes(1);
      }
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("observes landing and static candidate responses and keeps the first valid PDF bytes", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-response-download-"),
    );
    const app = await createApplication(home, {});
    try {
      const observed: Parameters<
        NonNullable<PdfDownloadOptions["on_response"]>
      >[0][] = [];
      const onLanding = vi.fn();
      const pdf = workbenchPdf();
      const request = vi.fn(async (url: string) => {
        if (url === "https://doi.org/10.5555/fixture")
          return {
            status: 200,
            final_url: "https://publisher.example/article",
            headers: [["content-type", "text/html"]] as const,
            body: new TextEncoder().encode(
              '<a href="/missing.pdf">PDF</a><a href="/main.pdf?download=1#view=FitH">PDF</a>',
            ),
          };
        if (url.endsWith("/missing.pdf"))
          return { status: 404, headers: [] as const, body: new Uint8Array() };
        return {
          status: 200,
          headers: [["content-type", "text/plain"]] as const,
          body: pdf,
        };
      });
      const durable = await downloadPdfCandidate(
        safeLocator(
          "doi-landing",
          "https://doi.org/10.5555/fixture",
          "landing",
        ),
        { request },
        {
          collector: app.execution!.transfers,
          transfer_id: "observed-static-pdf",
          on_response: (response) => observed.push(response),
          on_landing: onLanding,
        },
      );
      expect(await app.execution!.transfers.candidateBytes(durable)).toEqual(
        pdf,
      );
      expect(onLanding).toHaveBeenCalledExactlyOnceWith(
        "https://publisher.example",
      );
      expect(
        observed.map((response) => [
          response.requested_url,
          response.status,
          response.media_type,
        ]),
      ).toEqual([
        ["https://doi.org/10.5555/fixture", 200, "text/html"],
        ["https://publisher.example/missing.pdf", 404, null],
        ["https://publisher.example/main.pdf?download=1", 200, "text/plain"],
      ]);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
