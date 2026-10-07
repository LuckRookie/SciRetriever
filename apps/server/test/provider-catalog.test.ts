import { describe, expect, it } from "vitest";
import { assemblePublicAcquisitionRegistry } from "../src/acquisition/assembly.js";
import { AuthorizedPdfSource } from "../src/acquisition/sources/public.js";
import { parseCredentialText } from "../src/configuration/credentials.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { assembleMetadataRegistry } from "../src/metadata/assembly.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import {
  ACQUISITION_PROVIDER_NAMES,
  AUTO_ACQUISITION_SOURCES,
  LITERATURE_PROVIDERS,
  METADATA_AUTO_PROVIDERS,
  METADATA_PROVIDER_NAMES,
  PROVIDER_SERVICES,
  acquisitionService,
  metadataService,
  publicWebService,
} from "../src/providers/registry.js";
import { WileyAuthorizedPdfClient } from "../src/providers/wiley/acquisition.js";

describe("provider catalog production consumers", () => {
  it("preserves supported selection keys while production and UI share the same Auto declarations", () => {
    const budget = new NetworkBudgetCoordinator();
    try {
      for (const [kind, names] of [
        ["metadata", METADATA_PROVIDER_NAMES],
        ["acquisition", ACQUISITION_PROVIDER_NAMES],
      ] as const)
        for (const name of names)
          expect(
            parseConfiguration(
              `[sources.${kind}]\nmode="custom"\nproviders=["${name}"]\n${name === "web-of-science" ? '[sources.metadata.web-of-science]\nproduct="starter"\ndatabase="WOS"' : ""}`,
            ).sources[kind].providers,
          ).toEqual([name]);
      const configuration = parseConfiguration("");
      const metadata = assembleMetadataRegistry(
        configuration,
        parseCredentialText(""),
        budget,
      );
      expect(metadata.topic_selection).toEqual(METADATA_AUTO_PROVIDERS);
      const acquisition = assemblePublicAcquisitionRegistry(
        configuration,
        budget,
      );
      expect(acquisition.sources.map((s) => s.source_name)).toEqual([
        "direct",
        ...AUTO_ACQUISITION_SOURCES,
        "doi-landing",
      ]);
      expect(LITERATURE_PROVIDERS.crossref!.acquisition).toBe("hints");
      expect(LITERATURE_PROVIDERS.wiley!.metadata).toEqual([]);
      expect(LITERATURE_PROVIDERS.wiley!.acquisition).toBe("authorized-api");
      expect(LITERATURE_PROVIDERS.opencitations!.metadata).not.toContain(
        "topic-search",
      );
    } finally {
      budget.close();
    }
  });

  it("groups actual products rather than splitting quota by business capability", () => {
    expect(metadataService("core").quotaGroup).toBe(
      acquisitionService("core").quotaGroup,
    );
    const search = metadataService(
      "elsevier",
      "https://api.elsevier.com/content/search/scopus",
    );
    const lookup = metadataService(
      "elsevier",
      "https://api.elsevier.com/content/abstract/doi/10.5555/x",
    );
    expect(
      new Set([
        search.quotaGroup,
        lookup.quotaGroup,
        acquisitionService("elsevier").quotaGroup,
      ]).size,
    ).toBe(3);
    expect(
      publicWebService("https://arxiv.org/pdf/2401.12345").quotaGroup,
    ).toBe(metadataService("arxiv").quotaGroup);
    expect(
      publicWebService("https://onlinelibrary.wiley.com/doi/pdf/10.5555/x")
        .quotaGroup,
    ).not.toBe(acquisitionService("wiley").quotaGroup);
    expect(
      publicWebService("https://unknown.example/file.pdf").policyBasis,
    ).toContain("project-default");
    expect(
      publicWebService("https://journals.plos.org/article/file").policy
        .minimumIntervalMs,
    ).toBe(30_000);
    for (const service of Object.values(PROVIDER_SERVICES)) {
      expect(service.coverage).not.toBe("");
      expect(service.policyBasis).not.toBe("");
      expect(new URL(service.endpoint).protocol).toBe("https:");
    }
  });

  it("does not send an arbitrary DOI to Wiley and admits Wiley origin evidence without a DOI-prefix guess", async () => {
    const source = new AuthorizedPdfSource(
      new WileyAuthorizedPdfClient(
        {
          request: async () => {
            throw new Error("No request should occur while planning");
          },
        },
        "fixture-token",
      ),
    );
    const identifiers = [{ namespace: "doi", value: "10.5555/unknown-prefix" }];
    expect(await source.discover({ identifiers })).toEqual([]);
    const hint = (url: string) => ({
      kind: "landing-page" as const,
      url,
      media_type: "text/html",
      asset_role: "html" as const,
      version_role: "published" as const,
      access_status: null,
      license: null,
    });
    expect(
      await source.discover({
        identifiers,
        asset_hints: [hint("https://www.sciencedirect.com/article/x")],
      }),
    ).toEqual([]);
    expect(
      await source.discover({
        identifiers,
        asset_hints: [
          hint("https://onlinelibrary.wiley.com.attacker.example/x"),
        ],
      }),
    ).toEqual([]);
    expect(
      await source.discover({
        identifiers,
        asset_hints: [hint("https://onlinelibrary.wiley.com/doi/x")],
      }),
    ).toHaveLength(1);
  });
});
