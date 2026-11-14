import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createApplication } from "../../server/src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../../server/src/bootstrap/device-routes.js";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import { workbenchTestAccess } from "../../server/test/workbench-auth-fixture.js";
import {
  buildBrowserExtension,
  packageBrowserExtension,
} from "../../../scripts/build-browser-extension.mjs";
import {
  CaptureError,
  folderTree,
  LibraryClient,
  manualIdentifier,
  metadataOf,
  parseConnectionCode,
  pdfName,
  sha256,
} from "../src/capture.js";
import type { PageReading } from "../src/page.js";

const reading: PageReading = {
  url: "https://journal.test/article/abc",
  is_pdf: false,
  doi: "10.5555/extension.1",
  arxiv: null,
  title: "Argyrodite electrolyte one",
  authors: ["Smith, Alice", "Lee, Bo"],
  date: "2021/3/5",
  journal: "Journal of Synthetic Results",
  publisher: null,
  volume: "12",
  issue: null,
  first_page: "101",
  last_page: "110",
  abstract: null,
  language: "EN",
  keywords: ["Argyrodite"],
  pdf_url: "https://journal.test/article/abc/pdf",
};

it("parses connection codes, typed identifiers and page fields", () => {
  expect(
    parseConnectionCode(
      `sr-connect1:${encodeURIComponent("http://localhost:4174")}:srp1_${"a".repeat(43)}`,
    ),
  ).toEqual({
    address: "http://localhost:4174",
    pairing_code: `srp1_${"a".repeat(43)}`,
  });
  expect(() => parseConnectionCode("http://localhost:4174")).toThrow(
    CaptureError,
  );
  expect(manualIdentifier("https://doi.org/10.5555/ABC")).toEqual({
    namespace: "doi",
    value: "10.5555/abc",
  });
  expect(manualIdentifier("arXiv:2401.01234")).toEqual({
    namespace: "arxiv",
    value: "2401.01234",
  });
  expect(manualIdentifier("not an id")).toBeNull();
  expect(
    metadataOf(reading, [{ namespace: "doi", value: "10.5555/extension.1" }]),
  ).toMatchObject({
    publication_date: "2021-03-05",
    publication_year: 2021,
    pages: "101-110",
    language: "en",
    authors: [
      { kind: "unknown", display_name: "Smith, Alice" },
      { display_name: "Lee, Bo" },
    ],
  });
  expect(pdfName("https://journal.test/article/abc/pdf", [])).toBe("pdf.pdf");
  expect(
    folderTree([
      { folder_id: "b", parent_id: "a", name: "Child" },
      { folder_id: "a", parent_id: null, name: "Root" },
    ]).map(({ folder, depth }) => [folder.name, depth]),
  ).toEqual([
    ["Root", 0],
    ["Child", 1],
  ]);
});

it("pairs, previews, saves with the PDF through its batch, and is found with its PDF afterwards", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-extension-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: false },
    // No real metadata source is contacted.
    metadata: { lookup_ports: [] },
  });
  const session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    assets: new Map([["/", { contentType: "text/html", body: "fixture" }]]),
    access: workbenchTestAccess,
    devices: {
      service: app.deviceConnections,
      routes: deviceBusinessRoutes(app, undefined, pathToFileURL(home + "/")),
    },
  });
  try {
    const { connection_code } = await app.deviceConnections.create({
      address: server.origin,
      name: "Chrome 扩展",
      purposes: ["intake"],
    });
    const { address, pairing_code } = parseConnectionCode(connection_code);
    expect(address).toBe(server.origin);
    // Every request to the library leaves the page's cookies behind.
    const sent: RequestInit[] = [];
    const fetcher: typeof fetch = (input, init) => {
      sent.push(init ?? {});
      return fetch(input, init);
    };
    const token = await new LibraryClient(address, null, fetcher).exchange(
      pairing_code,
    );
    const client = new LibraryClient(address, token, fetcher);
    const ids = [{ namespace: "doi" as const, value: reading.doi! }];
    const metadata = metadataOf(reading, ids);
    expect(await client.lookup(metadata)).toMatchObject({
      found: false,
      has_pdf: false,
    });

    const pdf = workbenchPdf(reading.doi!);
    const bytes = pdf.buffer.slice(
      pdf.byteOffset,
      pdf.byteOffset + pdf.byteLength,
    ) as ArrayBuffer;
    const saved = await client.save({
      request_id: crypto.randomUUID(),
      metadata,
      folder_ids: [],
      file: {
        file_name: "abc.pdf",
        size_bytes: bytes.byteLength,
        sha256: await sha256(bytes),
      },
    });
    expect(saved).toMatchObject({
      metadata: { status: "unavailable" },
      disposition: "created",
      file: { action: "upload", status: "pending" },
    });
    const file = await client.bytes(saved, new Blob([bytes]));
    expect(file.status).toBe("uploaded");
    expect(await client.lookup(metadata)).toMatchObject({
      found: true,
      has_pdf: true,
      library_title: "Argyrodite electrolyte one",
    });

    // A page with a title and no identifier is collected too.
    const titled = metadataOf(
      { ...reading, doi: null, title: "A page with only a title" },
      [],
    );
    expect(await client.lookup(titled)).toMatchObject({ found: false });
    expect(
      await client.save({
        request_id: crypto.randomUUID(),
        metadata: titled,
        folder_ids: [],
        file: null,
      }),
    ).toMatchObject({ disposition: "created", file: null });
    expect(sent.length).toBeGreaterThanOrEqual(6);
    expect(sent.every((init) => init.credentials === "omit")).toBe(true);

    // A token without the intake purpose is refused with a plain explanation.
    const other = await app.deviceConnections.create({
      address: server.origin,
      name: "Agent",
      purposes: ["read"],
    });
    const agent = new LibraryClient(
      address,
      await new LibraryClient(address, null).exchange(
        parseConnectionCode(other.connection_code).pairing_code,
      ),
    );
    await expect(agent.lookup(metadata)).rejects.toMatchObject({
      code: "device-purpose-forbidden",
    });
    // An address nobody listens on reads as unreachable, naming the address.
    await expect(
      new LibraryClient("http://127.0.0.1:9", token).lookup(metadata),
    ).rejects.toMatchObject({
      code: "unreachable",
      message: "连不上 http://127.0.0.1:9",
    });

    // The library serves the package this build produces.
    const built = join(home, "extension");
    await packageBrowserExtension(
      await buildBrowserExtension(built),
      join(home, "browser-extension.zip"),
    );
    const download = await fetch(`${address}/api/v1/intake/extension`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(
      await readFile(join(home, "browser-extension.zip")),
    );
    expect(
      JSON.parse(await readFile(join(built, "manifest.json"), "utf8")),
    ).toMatchObject({
      manifest_version: 3,
      permissions: ["activeTab", "scripting", "storage"],
    });
  } finally {
    await server.close();
    await session.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
