import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DirectPdfSource } from "../src/acquisition/sources/public.js";
import { assemblePublicAcquisitionRegistry } from "../src/acquisition/assembly.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { parseCredentialText } from "../src/configuration/credentials.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { targets as elsevierTargets } from "../src/providers/elsevier/acquisition.js";
import { targets as wileyTargets } from "../src/providers/wiley/acquisition.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";

const doi = { namespace: "doi", value: "10.1002/test" };
const hint = (url: string) => ({
  url,
  kind: "direct-file" as const,
  media_type: "application/pdf",
  asset_role: "primary-pdf" as const,
  version_role: "published" as const,
  access_status: "open",
  license: null,
});

describe("live-discovered acquisition regressions", () => {
  it("keeps old API hints out of anonymous Public while retaining ordinary direct PDFs", async () => {
    const hints = [
      hint(
        "https://api.wiley.com/onlinelibrary/tdm/v1/articles/10.1002%2Ftest",
      ),
      hint("https://api.elsevier.com/content/article/PII:S123"),
      hint("https://repository.example/paper.pdf"),
    ];
    expect(
      await new DirectPdfSource().discover({
        identifiers: [doi],
        asset_hints: hints,
      }),
    ).toMatchObject([{ locator: "https://repository.example/paper.pdf" }]);
    expect(
      wileyTargets({ identifiers: [doi], asset_hints: [hints[0]!] }),
    ).toEqual([doi]);
    expect(
      elsevierTargets({ identifiers: [doi], asset_hints: [hints[1]!] }),
    ).toEqual([{ namespace: "pii", value: "S123" }]);
    expect(
      elsevierTargets({
        identifiers: [doi],
        asset_hints: [
          hint("https://api.elsevier.com/content/abstract/scopus_id/123"),
        ],
      }),
    ).toEqual([]);
    expect(
      wileyTargets({
        identifiers: [{ ...doi, value: "10.1002/other" }],
        asset_hints: [hints[0]!],
      }),
    ).toEqual([]);
  });

  it("uses owned publisher subdomains or this operation's landing evidence, with one DOI", () => {
    expect(
      wileyTargets({
        identifiers: [doi],
        asset_hints: [hint("https://advanced.onlinelibrary.wiley.com/article")],
      }),
    ).toEqual([doi]);
    expect(
      wileyTargets({
        identifiers: [doi],
        landing_origins: ["https://advanced.onlinelibrary.wiley.com"],
      }),
    ).toEqual([doi]);
    expect(
      elsevierTargets({
        identifiers: [doi],
        landing_origins: ["https://www.sciencedirect.com"],
      }),
    ).toEqual([doi]);
    for (const origin of [
      "https://onlinelibrary.wiley.com.evil.test",
      "http://onlinelibrary.wiley.com",
      "https://onlinelibrary.wiley.com:8443",
      "https://user@onlinelibrary.wiley.com",
    ]) {
      expect(
        wileyTargets({ identifiers: [doi], landing_origins: [origin] }),
      ).toEqual([]);
    }
    expect(
      wileyTargets({
        identifiers: [doi, { ...doi, value: "10.1002/other" }],
        landing_origins: ["https://onlinelibrary.wiley.com"],
      }),
    ).toEqual([]);
  });

  it("follows Wiley's single guarded ALM hop through production assembly, strips credentials, and rejects other redirects before DNS", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-wiley-redirect-"));
    const key = join(home, "key.pem");
    const cert = join(home, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=api.wiley.com",
      "-addext",
      "subjectAltName=DNS:api.wiley.com,DNS:alm.wiley.com",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    const certificate = await readFile(cert);
    let location =
      "https://alm.wiley.com/alm/api/v2/download/fixture%252Fopaque";
    let secondRedirect = false;
    let apiStatus = 302;
    const calls: {
      host: string | undefined;
      token: string | string[] | undefined;
    }[] = [];
    const server = createServer(
      { key: await readFile(key), cert: certificate },
      (request, response) => {
        calls.push({
          host: request.headers.host,
          token: request.headers["wiley-tdm-client-token"],
        });
        if (request.headers.host === "api.wiley.com") {
          response.writeHead(apiStatus, { location });
          response.end();
        } else if (secondRedirect) {
          response.writeHead(302, { location });
          response.end();
        } else {
          response.writeHead(200, { "content-type": "application/pdf" });
          response.end(workbenchPdf());
        }
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const coordinator = new NetworkBudgetCoordinator();
    const hosts: string[] = [];
    const registry = assemblePublicAcquisitionRegistry(
      parseConfiguration(
        '[sources.acquisition]\nmode = "custom"\nproviders = ["wiley"]\n',
      ),
      coordinator,
      {
        credentials: parseCredentialText(
          '[wiley]\ntdm_api_token = "synthetic-token"\n',
        ),
        currentCredential: async () => "current-fixture-token",
        resolver: (hostname) => {
          hosts.push(hostname);
          return ["93.184.216.34"];
        },
        connection: {
          connect: () => createConnection({ host: "127.0.0.1", port }),
          tlsConnect: (options) => tlsConnect({ ...options, ca: certificate }),
        },
      },
    );
    try {
      const source = registry.sources.find(
        (source) => source.source_name === "wiley",
      )!;
      const [candidate] = await source.discover({
        identifiers: [doi],
        landing_origins: ["https://onlinelibrary.wiley.com"],
      });
      const download = () => source.download_candidate!(candidate!);
      const result = await download();
      expect(result).toMatchObject({
        kind: "download",
        safe_source_url:
          "https://api.wiley.com/onlinelibrary/tdm/v1/articles/10.1002%2Ftest",
        bytes: workbenchPdf(),
      });
      expect(calls).toEqual([
        { host: "api.wiley.com", token: "current-fixture-token" },
        { host: "alm.wiley.com", token: undefined },
      ]);
      for (const invalid of [
        "https://evil.example/alm/api/v2/download/opaque",
        "https://alm.wiley.com/other/opaque",
        "https://alm.wiley.com/alm/api/v2/download/opaque?token=secret",
        "https://alm.wiley.com/alm/api/v2/download/a/b",
        "http://alm.wiley.com/alm/api/v2/download/opaque",
      ]) {
        location = invalid;
        hosts.length = 0;
        calls.length = 0;
        await expect(download()).rejects.toMatchObject({
          code: "network-http",
          reason: "response-protocol",
        });
        expect(hosts).toEqual(["api.wiley.com"]);
        expect(calls).toHaveLength(1);
      }
      location = "https://alm.wiley.com/alm/api/v2/download/opaque";
      secondRedirect = true;
      await expect(download()).rejects.toMatchObject({
        reason: "redirect-limit",
      });
      apiStatus = 400;
      await expect(download()).rejects.toMatchObject({
        code: "http-response-failed",
        retryable: false,
        reason: expect.stringContaining("HTTP 400"),
      });
    } finally {
      coordinator.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    }
  }, 0);
});
