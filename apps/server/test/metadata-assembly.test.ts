import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import {
  parseCredentialText,
  type CredentialBundle,
} from "../src/configuration/credentials.js";
import { parseConfiguration } from "../src/configuration/index.js";
import {
  assembleMetadataRegistry,
  type MetadataAssemblyOptions,
} from "../src/metadata/assembly.js";
import { withMetadataRateLimitHandling } from "../src/metadata/service.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import type { MetadataTransport } from "../src/providers/shared/metadata-transport.js";

function emptyCredentials(): CredentialBundle {
  return parseCredentialText("");
}

describe("metadata provider assembly", () => {
  it("prioritizes credentialed Auto citation APIs without enabling new sources or changing Custom order", () => {
    const budget = new NetworkBudgetCoordinator();
    const credentials = parseCredentialText(
      '[openalex]\napi_key="fixture-key"\n[web-of-science]\napi_key="fixture-wos-key"',
    );
    const options = {
      transportFactory: () => ({
        request: async () => {
          throw new Error("assembly must stay offline");
        },
      }),
    };
    try {
      const auto = assembleMetadataRegistry(
        parseConfiguration(""),
        credentials,
        budget,
        options,
      );
      expect(auto.reference_selection).toEqual([
        "openalex",
        "semantic-scholar",
        "europe-pmc",
        "datacite",
        "core",
      ]);
      expect(auto.topic_selection[0]).toBe("crossref");
      expect(auto.reference_selection).not.toContain("web-of-science");
      const custom = assembleMetadataRegistry(
        parseConfiguration(
          '[sources.metadata]\nmode="custom"\nproviders=["europe-pmc","openalex"]',
        ),
        credentials,
        budget,
        options,
      );
      expect(custom.reference_selection).toEqual(["europe-pmc", "openalex"]);
      expect(JSON.stringify(auto.statuses)).not.toContain("fixture-key");
    } finally {
      budget.close();
    }
  });

  it("uses a configured OpenAlex key through the private query seam and does not publish it", async () => {
    const values: (string | null)[] = [];
    const budget = new NetworkBudgetCoordinator();
    try {
      const registry = assembleMetadataRegistry(
        parseConfiguration(""),
        parseCredentialText('[openalex]\napi_key="fixture-openalex-key"'),
        budget,
        {
          transportFactory: () => ({
            request: async (url) => {
              values.push(new URL(url).searchParams.get("api_key"));
              return { meta: { count: 0 }, results: [] };
            },
          }),
        },
      );
      const result = await registry.service.searchTopicProvider(
        "openalex",
        { query: "fixture", year_from: null, year_to: null },
        1,
      );
      expect(values).toEqual(["fixture-openalex-key"]);
      expect(JSON.stringify(result)).not.toContain("fixture-openalex-key");
    } finally {
      budget.close();
    }
  });

  it("keeps Crossref search as a GET through the production transport", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-metadata-tls-"),
    );
    const keyPath = join(directory, "key.pem");
    const certificatePath = join(directory, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=api.crossref.org",
      "-addext",
      "subjectAltName=DNS:api.crossref.org",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ]);
    const certificate = await readFile(certificatePath);
    const requests: { method: string; path: string; body: string }[] = [];
    const server = createHttpsServer(
      { key: await readFile(keyPath), cert: certificate },
      async (request, response) => {
        const parts: Buffer[] = [];
        for await (const part of request)
          parts.push(Buffer.from(part as Uint8Array));
        requests.push({
          method: request.method!,
          path: request.url!,
          body: Buffer.concat(parts).toString(),
        });
        if (
          new URL(request.url!, "https://api.crossref.org").searchParams.get(
            "query.bibliographic",
          ) === "limited fixture"
        ) {
          response.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "0",
          });
          response.end('{"message":"vendor-private-message"}');
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            status: "ok",
            "message-type": request.url?.startsWith("/works/")
              ? "work"
              : "work-list",
            message: request.url?.startsWith("/works/")
              ? {
                  DOI: "10.5555/fixture/nested",
                  title: ["Lookup through Network"],
                  type: "journal-article",
                }
              : {
                  items:
                    requests.length === 3
                      ? [{ DOI: "10.5555/large-page", title: ["Large page"] }]
                      : [],
                },
            // Vendor fields that are not mapped still consume the real HTTP
            // response allowance before the adapter selects neutral metadata.
            ...(requests.length === 3
              ? { padding: "x".repeat(1_500_000) }
              : {}),
          }),
        );
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture unavailable");
      const budget = new NetworkBudgetCoordinator();
      const admission = vi.spyOn(budget, "acquire");
      const registry = assembleMetadataRegistry(
        parseConfiguration(""),
        emptyCredentials(),
        budget,
        {
          resolver: () => ["93.184.216.34"],
          connection: {
            connect: () =>
              createConnection({ host: "127.0.0.1", port: address.port }),
            tlsConnect: (options) =>
              tlsConnect({ ...options, ca: certificate }),
          },
        },
      );
      const result = await registry.service.searchTopicProvider(
        "crossref",
        { query: "fixture phrase", year_from: null, year_to: null },
        1,
      );
      expect(result.outcome).toBe("EXHAUSTED");
      expect(admission).toHaveBeenCalledWith(
        "crossref/api/rest",
        "api.crossref.org",
        expect.objectContaining({ minimumIntervalMs: 200, maxConcurrency: 1 }),
        expect.any(Object),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "GET", body: "" });
      const target = new URL(requests[0]!.path, "https://api.crossref.org");
      expect(target.pathname).toBe("/works");
      expect(target.searchParams.get("query.bibliographic")).toBe(
        "fixture phrase",
      );
      const lookup = await registry.service.lookupProvider({
        provider_name: "crossref",
        key: {
          record_id: null,
          identifiers: [{ namespace: "doi", value: "10.5555/fixture/nested" }],
        },
        scan_limit: 2,
      });
      expect(lookup.outcome).toBe("EXHAUSTED");
      expect(lookup.observations[0]?.metadata.title).toBe(
        "Lookup through Network",
      );
      expect(requests[1]).toMatchObject({
        method: "GET",
        path: "/works/10.5555/fixture/nested",
        body: "",
      });
      const large = await registry.service.searchTopicProvider(
        "crossref",
        { query: "large fixture", year_from: null, year_to: null },
        1,
      );
      expect(large).toMatchObject({
        outcome: "SCAN_LIMIT_REACHED",
        failure: null,
      });
      expect(large.observations[0]?.metadata.title).toBe("Large page");
      const limited = await registry.service.searchTopicProvider(
        "crossref",
        { query: "limited fixture", year_from: null, year_to: null },
        1,
      );
      expect(limited).toMatchObject({
        outcome: "FAILED",
        raw_item_count: 0,
        failure: { code: "metadata-provider-rate-limited", retryable: true },
      });
      expect(limited.failure?.reason).toContain("HTTP 429");
      expect(limited.failure?.reason).toContain("Retry-After is 0 ms");
      expect(requests).toHaveLength(5);
      expect(JSON.stringify(limited)).not.toContain("vendor-private-message");
      const owned = await withMetadataRateLimitHandling(() =>
        registry.service.searchTopicProvider(
          "crossref",
          { query: "limited fixture", year_from: null, year_to: null },
          1,
        ),
      );
      expect(owned).toMatchObject({
        outcome: "FAILED",
        retry_after_ms: 0,
        failure: { code: "metadata-provider-rate-limited" },
      });
      expect(requests).toHaveLength(6);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

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
