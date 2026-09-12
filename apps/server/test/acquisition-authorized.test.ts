import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AuthorizedProviderError,
  CoreAuthorizedPdfClient,
  ElsevierAuthorizedPdfClient,
  WileyAuthorizedPdfClient,
} from "../src/acquisition/providers/authorized.js";

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

describe("authorized acquisition providers", () => {
  it("keeps provider credentials and endpoint paths behind the provider client", async () => {
    const calls: { url: string; headers: Readonly<Record<string, string>> }[] =
      [];
    const transport = {
      async request(
        url: string,
        options?: { headers?: Readonly<Record<string, string>> },
      ) {
        calls.push({ url, headers: options?.headers ?? {} });
        return {
          status: 200,
          headers: [["content-type", "application/pdf"]] as const,
          body: pdf,
        };
      },
    };
    const client = new CoreAuthorizedPdfClient(transport, "core-secret");
    const lookup = client.lookup({ namespace: "core-work", value: "work-1" });
    expect(lookup).toMatchObject({ kind: "downloads", entitlement: "unknown" });
    if (lookup.kind !== "downloads") throw new Error("lookup failed");
    const result = await client.download(lookup.downloads[0]!);
    expect(result).toMatchObject({
      kind: "download",
      entitlement: "granted",
      bytes: pdf,
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.core.ac.uk/v3/works/work-1/download",
      headers: { authorization: "Bearer core-secret" },
    });
  });

  it("maps authorized normal misses and redacted status failures for Elsevier/Wiley", async () => {
    const missTransport = {
      async request() {
        return { status: 404, headers: [], body: new Uint8Array() };
      },
    };
    const elsevier = new ElsevierAuthorizedPdfClient(missTransport, "key");
    const locator = elsevier.lookup({
      namespace: "doi",
      value: "10.1000/test",
    });
    if (locator.kind !== "downloads") throw new Error("lookup failed");
    await expect(
      elsevier.download(locator.downloads[0]!),
    ).resolves.toMatchObject({
      kind: "miss",
      reason: "http-404",
    });
    const wiley = new WileyAuthorizedPdfClient(
      {
        async request() {
          return { status: 403, headers: [], body: new Uint8Array() };
        },
      },
      "token",
    );
    const wileyLocator = wiley.lookup({
      namespace: "doi",
      value: "10.1000/test",
    });
    if (wileyLocator.kind !== "downloads") throw new Error("lookup failed");
    await expect(
      wiley.download(wileyLocator.downloads[0]!),
    ).rejects.toMatchObject({
      failure: { code: "entitlement" },
    } satisfies Partial<AuthorizedProviderError>);
  });

  it("resolves Elsevier MAIN PDF objects in order and excludes supplementary objects", async () => {
    const xml = new Uint8Array(
      await readFile(
        resolve("tests/fixtures/acquisition/elsevier/article-full-main.xml"),
      ),
    );
    const calls: {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }[] = [];
    const client = new ElsevierAuthorizedPdfClient(
      {
        async request(url, options) {
          calls.push({ url, headers: options?.headers ?? {} });
          return calls.length === 1
            ? {
                status: 200,
                headers: [["content-type", "application/xml"]],
                body: xml,
              }
            : {
                status: 200,
                headers: [["content-type", "application/pdf"]],
                body: pdf,
              };
        },
      },
      "elsevier-key",
      "institution-token",
    );
    const lookup = client.lookup({
      namespace: "pii",
      value: "S0014579301033130",
    });
    if (lookup.kind !== "downloads") throw new Error("lookup failed");
    await expect(client.download(lookup.downloads[0]!)).resolves.toMatchObject({
      kind: "download",
      locator: {
        namespace: "elsevier-main-pdf-object",
        value: "1-s2.0-S0014579301033130-main.pdf",
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.elsevier.com/content/article/pii?view=FULL&pii=S0014579301033130",
      "https://api.elsevier.com/content/object/eid/1-s2.0-S0014579301033130-main.pdf",
    ]);
    expect(calls[0]?.headers).toEqual({
      accept: "application/xml",
      "x-els-apikey": "elsevier-key",
      "x-els-insttoken": "institution-token",
    });
  });

  it("fails closed for unsafe Elsevier XML and honours pre-cancelled downloads", async () => {
    const client = new ElsevierAuthorizedPdfClient(
      {
        async request() {
          return {
            status: 200,
            headers: [["content-type", "application/xml"]],
            body: new TextEncoder().encode(
              '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><full-text-retrieval-response/>',
            ),
          };
        },
      },
      "key",
    );
    const lookup = client.lookup({ namespace: "pii", value: "S001" });
    if (lookup.kind !== "downloads") throw new Error("lookup failed");
    await expect(client.download(lookup.downloads[0]!)).rejects.toMatchObject({
      failure: { code: "response-schema" },
    });
    await expect(
      new WileyAuthorizedPdfClient(
        {
          async request() {
            throw new Error("transport must not run");
          },
        },
        "token",
      ).download(
        {
          namespace: "wiley-tdm-pdf",
          value: "10.1000/test",
          declared_media_type: "application/pdf",
          source_record_id: "10.1000/test",
        },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ failure: { code: "cancelled" } });
  });
});
