import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { MetadataService } from "../src/metadata/service.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { createAgentTransport } from "../src/network/http.js";
import { DataCiteRestAdapter } from "../src/providers/datacite/metadata.js";
import { OpenAlexRestAdapter } from "../src/providers/openalex/metadata.js";
import { createMetadataTransport } from "../src/providers/shared/metadata-transport.js";
import { WileyAuthorizedPdfClient } from "../src/providers/wiley/acquisition.js";

it("carries real provider DOI lookups and PDF redirects through Network without changing their encoded paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-doi-network-"));
  const coordinator = new NetworkBudgetCoordinator();
  const calls: string[] = [];
  const doi = "10.5555/fixture/nested";
  const pdf = Buffer.from("%PDF-1.7\nsynthetic transport payload");
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=api.wiley.com",
      "-addext",
      "subjectAltName=DNS:api.wiley.com,DNS:api.datacite.org,DNS:api.openalex.org",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    const certificate = await readFile(cert);
    server = createServer(
      { key: await readFile(key), cert: certificate },
      (request, response) => {
        calls.push(`${request.headers.host}${request.url}`);
        expect(request.method).toBe("GET");
        if (request.headers.host === "api.datacite.org") {
          response.end(
            JSON.stringify({
              data: {
                id: doi,
                attributes: {
                  doi,
                  titles: [{ title: "DOI transport fixture" }],
                  creators: [],
                },
              },
            }),
          );
        } else if (request.headers.host === "api.openalex.org") {
          response.end(
            JSON.stringify({
              id: "https://openalex.org/W12345",
              doi: `https://doi.org/${doi}`,
              title: "DOI transport fixture",
            }),
          );
        } else if (request.url?.startsWith("/onlinelibrary/")) {
          expect(request.headers["wiley-tdm-client-token"]).toBe(
            "synthetic-token",
          );
          response.writeHead(302, {
            location: `/files/${encodeURIComponent(doi)}`,
          });
          response.end();
        } else {
          response.writeHead(200, { "content-type": "application/pdf" });
          response.end(pdf);
        }
      },
    );
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const send = createAgentTransport({
      policy: {},
      resolver: () => ["93.184.216.34"],
      coordinator,
      scope: "doi-fixture",
      limits: {
        maxConcurrency: 1,
        maxHostConcurrency: 1,
        maxResponseBytes: 8192,
        maxRedirects: 2,
        maxRetries: 0,
      },
      connection: {
        connect: () => createConnection({ host: "127.0.0.1", port }),
        tlsConnect: (options) => tlsConnect({ ...options, ca: certificate }),
      },
    });
    const transport = createMetadataTransport(send);
    for (const adapter of [
      new DataCiteRestAdapter({ transport }),
      new OpenAlexRestAdapter({ transport }),
    ]) {
      const result = await new MetadataService({
        lookup_ports: [adapter],
      }).lookup({
        provider_name: adapter.provider_name,
        key: {
          record_id: null,
          identifiers: [{ namespace: "doi", value: doi }],
        },
        scan_limit: 1,
      });
      expect(result.observations[0]?.metadata.identifiers).toContainEqual({
        namespace: "doi",
        value: doi,
      });
    }
    const wiley = new WileyAuthorizedPdfClient(
      {
        request: (url, options) =>
          send({
            endpoint: url,
            method: "GET",
            headers: Object.entries(options?.headers ?? {}),
            body: new Uint8Array(),
            ...(options?.signal ? { signal: options.signal } : {}),
          }),
      },
      "synthetic-token",
    );
    const found = wiley.lookup({ namespace: "doi", value: doi });
    expect(found.kind).toBe("downloads");
    if (found.kind !== "downloads") throw new Error("fixture lookup failed");
    const result = await wiley.download(found.downloads[0]!);
    expect(result).toMatchObject({
      kind: "download",
      bytes: new Uint8Array(pdf),
    });
    expect(calls).toEqual([
      "api.datacite.org/dois/10.5555%2Ffixture%2Fnested",
      "api.openalex.org/works/doi%3A10.5555%2Ffixture%2Fnested",
      "api.wiley.com/onlinelibrary/tdm/v1/articles/10.5555%2Ffixture%2Fnested",
      "api.wiley.com/files/10.5555%2Ffixture%2Fnested",
    ]);
  } finally {
    coordinator.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
