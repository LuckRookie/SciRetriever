import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { assemblePublicAcquisitionRegistry } from "../src/acquisition/assembly.js";
import { type AcquisitionSourcePort } from "../src/acquisition/ports.js";
import {
  AuthorizedPdfSource,
  PublicAcquisitionRegistry,
} from "../src/acquisition/sources/public.js";
import {
  AcquisitionRouteError,
  classifyAcquisitionFailure,
  TieredAcquisitionService,
} from "../src/acquisition/tiered.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { CoreAuthorizedPdfClient } from "../src/providers/core/acquisition.js";
import { ElsevierAuthorizedPdfClient } from "../src/providers/elsevier/acquisition.js";
import {
  AuthorizedProviderError,
  type AuthorizedProvider,
} from "../src/providers/shared/authorized-pdf.js";
import { WileyAuthorizedPdfClient } from "../src/providers/wiley/acquisition.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";

const fixtureRequest = (provider: AuthorizedProvider) => ({
  identifiers: [
    provider === "core"
      ? { namespace: "core-work", value: "fixture-work" }
      : provider === "elsevier"
        ? { namespace: "pii", value: "S0014579301033130" }
        : { namespace: "doi", value: "10.5555/fixture" },
  ],
  asset_hints: [
    {
      kind: "landing-page" as const,
      url: "https://onlinelibrary.wiley.com/doi/10.5555/fixture",
      media_type: "text/html",
      asset_role: "html" as const,
      version_role: "published" as const,
      access_status: null,
      license: null,
    },
  ],
});

describe("source-owned acquisition failure conversion", () => {
  it.each(["core", "elsevier", "wiley"] as const)(
    "consumes a delivered %s API PDF with Retry-After feedback without another request",
    async (provider) => {
      const body = new TextEncoder().encode("%PDF-1.4\nfixture");
      const transport = {
        request: vi.fn(async () => ({
          status: 200,
          headers: [["content-type", "application/pdf"]] as const,
          retry_after_ms: 60_000,
          body,
        })),
      };
      const client =
        provider === "core"
          ? new CoreAuthorizedPdfClient(transport, "fixture-key")
          : provider === "elsevier"
            ? new ElsevierAuthorizedPdfClient(transport, "fixture-key")
            : new WileyAuthorizedPdfClient(transport, "fixture-key");
      const source = new AuthorizedPdfSource(client);
      const [candidate] = await source.discover(fixtureRequest(provider));
      await expect(
        source.download_candidate(candidate!),
      ).resolves.toMatchObject({
        kind: "download",
        bytes: body,
      });
      expect(transport.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["core", "elsevier", "wiley"] as const)(
    "keeps known %s API access, rate and service outcomes out of automatic Browser rescue",
    async (provider) => {
      for (const [status, retryAfterMs] of [
        [401, undefined],
        [403, undefined],
        [429, undefined],
        [503, undefined],
        [403, 0],
        [503, 2000],
      ] as const) {
        const transport = {
          request: vi.fn(async () => ({
            status,
            headers: [],
            body: new TextEncoder().encode("private remote response"),
            ...(retryAfterMs === undefined
              ? {}
              : { retry_after_ms: retryAfterMs }),
          })),
        };
        const client =
          provider === "core"
            ? new CoreAuthorizedPdfClient(transport, "fixture-key")
            : provider === "elsevier"
              ? new ElsevierAuthorizedPdfClient(transport, "fixture-key")
              : new WileyAuthorizedPdfClient(transport, "fixture-key");
        const source = new AuthorizedPdfSource(client);
        const discover = vi.fn(async () => []);
        const alternate: AcquisitionSourcePort = {
          source_name: "alternate",
          ready: true,
          discover,
        };
        const run = new TieredAcquisitionService(
          new PublicAcquisitionRegistry(
            [source, alternate],
            [provider, "alternate"],
          ),
        ).run(
          [{ key: "fixture", request: fixtureRequest(provider) }],
          async (_item, route, candidate, signal) => {
            await route.download_candidate!(candidate, signal);
          },
        );
        if ((status === 401 || status === 403) && retryAfterMs === undefined) {
          let thrown: unknown;
          try {
            await run;
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(AcquisitionRouteError);
          expect(thrown).toMatchObject({
            code: "http-response-failed",
            retryable: false,
            cause: { failure: { http_status: status } },
          });
          expect(Object.keys(thrown!)).not.toContain("cause");
          expect(discover).not.toHaveBeenCalled();
        } else {
          const [result] = await run;
          const limited = status === 429 || retryAfterMs !== undefined;
          expect(result).toMatchObject({
            disposition: "failed",
            failure: {
              code: limited ? "rate-limited" : "http-response-failed",
              source: provider,
              unavailability: null,
              retryable: true,
            },
          });
          expect(result!.failure!.reason).toContain(`HTTP ${status}`);
          expect(result!.failure!.reason).not.toContain(
            "private remote response",
          );
          if (retryAfterMs !== undefined)
            expect(result!.failure!.reason).toContain(
              `Retry-After: ${retryAfterMs} ms`,
            );
          expect(discover).toHaveBeenCalledTimes(limited ? 0 : 1);
        }
        expect(transport.request).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    new AuthorizedProviderError({ code: "response-schema" }),
    new AuthorizedProviderError({ code: "non-pdf-product" }),
    new AuthorizedProviderError({ code: "ambiguous-primary-pdf" }),
    new AuthorizedProviderError({ code: "cancelled" }),
    new WriteAdmissionError("write-admission-closed"),
    new TypeError("fixture schema failure"),
    new Error("fixture unknown failure"),
  ])(
    "preserves an unclassified API exception without route fallback: %s",
    async (error) => {
      const source = new AuthorizedPdfSource(
        new CoreAuthorizedPdfClient(
          {
            request: async () => {
              throw error;
            },
          },
          "fixture-key",
        ),
      );
      const [candidate] = await source.discover(fixtureRequest("core"));
      await expect(source.download_candidate(candidate!)).rejects.toBe(error);
    },
  );

  it("classifies production Unpaywall HTTP responses through an offline TLS transport without disclosing remote text or contact", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-unpaywall-failures-"),
    );
    const key = join(home, "fixture.key");
    const cert = join(home, "fixture.crt");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=api.unpaywall.org",
      "-addext",
      "subjectAltName=DNS:api.unpaywall.org",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    const certificate = await readFile(cert);
    let responseStatus = 200;
    let retryAfter = false;
    let responseBody = "{}";
    const paths: string[] = [];
    const server = createServer(
      { key: await readFile(key), cert: certificate },
      (request, response) => {
        paths.push(new URL(request.url!, "https://api.unpaywall.org").pathname);
        response.writeHead(responseStatus, {
          "content-type": "application/json",
          ...(retryAfter ? { "retry-after": "0" } : {}),
        });
        response.end(responseBody);
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      for (const [status, throttled] of [
        [200, false],
        [204, false],
        [404, false],
        [410, false],
        [401, false],
        [403, false],
        [429, false],
        [503, false],
        [403, true],
        [200, true],
      ] as const) {
        responseStatus = status;
        retryAfter = throttled;
        responseBody = status === 200 ? "{}" : "private remote response";
        const coordinator = new NetworkBudgetCoordinator();
        try {
          const registry = assemblePublicAcquisitionRegistry(
            parseConfiguration(
              '[sources.acquisition]\nmode = "custom"\nproviders = ["unpaywall"]\n[sources.acquisition.unpaywall]\ncontact_email = "fixture@example.test"\n',
            ),
            coordinator,
            {
              resolver: () => ["93.184.216.34"],
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
          const source = registry.sources.find(
            (item) => item.source_name === "unpaywall",
          )!;
          const lookup = () =>
            source.discover({
              identifiers: [{ namespace: "doi", value: "10.5555/fixture" }],
            });
          if (status === 200 && !throttled) {
            await expect(lookup()).resolves.toEqual([]);
          } else if ([204, 404, 410].includes(status)) {
            await expect(lookup()).rejects.toMatchObject({
              unavailability: "not-applicable",
            });
          } else if ((status === 401 || status === 403) && !throttled) {
            await expect(lookup()).rejects.toMatchObject({
              code: "http-response-failed",
              retryable: false,
            });
          } else {
            const alternate = {
              source_name: "alternate",
              ready: true,
              discover: vi.fn(async () => []),
            };
            const [result] = await new TieredAcquisitionService(
              new PublicAcquisitionRegistry(
                [source, alternate],
                ["unpaywall", "alternate"],
              ),
            ).run(
              [
                {
                  key: "fixture",
                  request: {
                    identifiers: [
                      { namespace: "doi", value: "10.5555/fixture" },
                    ],
                  },
                },
              ],
              async () => undefined,
            );
            const limited = status === 429 || throttled;
            expect(result).toMatchObject({
              disposition: "failed",
              failure: {
                code: limited ? "rate-limited" : "http-response-failed",
                source: "unpaywall",
                unavailability: null,
              },
            });
            expect(result!.failure!.reason).not.toMatch(
              /private remote response|fixture@example/u,
            );
            expect(alternate.discover).toHaveBeenCalledTimes(limited ? 0 : 1);
          }
          if (status === 200 && !throttled) {
            responseBody = "private malformed response";
            let thrown: unknown;
            try {
              await lookup();
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBeInstanceOf(Error);
            expect(
              classifyAcquisitionFailure(
                thrown,
                new AbortController().signal,
                "discovery",
              ),
            ).toBe("system");
          }
        } finally {
          coordinator.close();
        }
      }
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths)).toEqual(new Set(["/v2/10.5555/fixture"]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);
});
