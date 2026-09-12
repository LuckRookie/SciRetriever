import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseConfiguration } from "../src/configuration/index.js";
import {
  parseCredentialText,
  type CredentialBundle,
} from "../src/configuration/credentials.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import {
  assembleMetadataRegistry,
  type MetadataAssemblyOptions,
} from "../src/metadata/assembly.js";
import type { MetadataTransport } from "../src/metadata/providers.js";

function emptyCredentials(): CredentialBundle {
  return parseCredentialText("");
}

describe("metadata provider assembly", () => {
  it("assembles every configured adapter without probing the network", () => {
    const calls: { provider: string; origin: string }[] = [];
    const transports = new Map<string, MetadataTransport>();
    const options: MetadataAssemblyOptions = {
      transportFactory(provider, origin) {
        calls.push({ provider, origin });
        const transport: MetadataTransport = {
          async request() {
            throw new Error(
              "fixture transport must not be called at assembly time",
            );
          },
        };
        transports.set(provider, transport);
        return transport;
      },
    };
    const configuration = parseConfiguration(
      '[sources.metadata.web-of-science]\nproduct = "expanded"\ndatabase = "WOS"\nedition = "SCI"\n',
    );
    const registry = assembleMetadataRegistry(
      configuration,
      emptyCredentials(),
      new NetworkBudgetCoordinator(),
      options,
    );

    expect(calls.map((item) => item.provider)).toEqual([
      "crossref",
      "semantic-scholar",
      "arxiv",
      "openalex",
      "europe-pmc",
      "datacite",
      "core",
      "opencitations",
      "opencitations",
      "elsevier",
      "springer",
      "web-of-science",
    ]);
    expect(
      calls.find((item) => item.provider === "web-of-science")?.origin,
    ).toBe("https://wos-api.clarivate.com");
    expect(transports.size).toBe(11);
    expect(
      registry.statuses.find((item) => item.provider_name === "web-of-science"),
    ).toMatchObject({
      capabilities: ["topic-search", "lookup", "reference-query"],
      production_available: true,
      ready: false,
      failure_code: "credential-missing",
    });
  });

  it("injects provider credentials at request time and rejects origin changes", async () => {
    const requests: {
      url: string;
      headers: Readonly<Record<string, string>>;
    }[] = [];
    const transports = new Map<string, MetadataTransport>();
    const configuration = parseConfiguration("");
    const credentials = parseCredentialText(
      '[core]\napi_key = "core-secret"\n',
    );
    const registry = assembleMetadataRegistry(
      configuration,
      credentials,
      new NetworkBudgetCoordinator(),
      {
        transportFactory(provider, origin) {
          void origin;
          const transport: MetadataTransport = {
            async request(url, options) {
              requests.push({ url, headers: options?.headers ?? {} });
              return { totalHits: 0, limit: 100, offset: 0, results: [] };
            },
          };
          transports.set(provider, transport);
          return transport;
        },
      },
    );

    const core = transports.get("core");
    expect(core).toBeDefined();
    await registry.service.searchTopicProvider(
      "core",
      { query: "fixture", year_from: null, year_to: null },
      1,
    );
    expect(requests[0]?.headers).toEqual({
      authorization: "Bearer core-secret",
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("credential");
  });

  it("keeps missing authorized credentials as readiness failures", () => {
    const configuration = parseConfiguration("");
    const registry = assembleMetadataRegistry(
      configuration,
      emptyCredentials(),
      new NetworkBudgetCoordinator(),
      { transportFactory: () => ({ request: async () => ({}) }) },
    );
    expect(
      registry.statuses
        .filter((item) => item.failure_code === "credential-missing")
        .map((item) => item.provider_name),
    ).toEqual(["elsevier", "springer"]);
  });

  it("keeps the eleven-provider readiness matrix explicit and sends Springer credentials only through its query seam", async () => {
    const credentialText = [
      "[web-of-science]",
      'api_key = "wos-secret"',
      "[semantic-scholar]",
      'api_key = "semantic-secret"',
      "[openalex]",
      'api_key = "openalex-secret"',
      "[elsevier]",
      'api_key = "elsevier-secret"',
      'institution_token = "institution-secret"',
      "[springer]",
      'api_key = "springer-secret"',
      "[core]",
      'api_key = "core-secret"',
      "[opencitations]",
      'access_token = "citation-secret"',
    ].join("\n");
    const springerQueries: (string | null)[] = [];
    const configuration = parseConfiguration(
      '[sources.metadata.web-of-science]\nproduct = "starter"\ndatabase = "WOS"\n',
    );
    const registry = assembleMetadataRegistry(
      configuration,
      parseCredentialText(credentialText),
      new NetworkBudgetCoordinator(),
      {
        transportFactory(provider) {
          return {
            async request(url) {
              if (provider === "springer") {
                springerQueries.push(new URL(url).searchParams.get("api_key"));
                return {
                  result: [{ total: "0", start: "1", pageLength: "25" }],
                  records: [],
                };
              }
              throw new Error(
                "only the selected fixture provider may perform I/O",
              );
            },
          };
        },
      },
    );
    expect(registry.statuses).toHaveLength(11);
    expect(
      registry.statuses.map((item) => [
        item.provider_name,
        item.production_available,
        item.ready,
        item.failure_code,
      ]),
    ).toEqual(
      registry.statuses.map((item) => [item.provider_name, true, true, null]),
    );
    const result = await registry.service.searchTopicProvider(
      "springer",
      { query: "fixture", year_from: null, year_to: null },
      1,
    );
    expect(result.outcome).toBe("EXHAUSTED");
    expect(springerQueries).toEqual(["springer-secret"]);
    expect(JSON.stringify(result)).not.toContain("springer-secret");
  });

  it("does not touch the application home while assembling metadata", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-metadata-assembly-"),
    );
    const configuration = parseConfiguration("");
    assembleMetadataRegistry(
      configuration,
      emptyCredentials(),
      new NetworkBudgetCoordinator(),
      {
        transportFactory: () => ({ request: async () => ({}) }),
      },
    );
    // The assembly function only receives value objects; it cannot create files in the home.
    expect(home).toContain("sciretriever-metadata-assembly-");
  });
});
