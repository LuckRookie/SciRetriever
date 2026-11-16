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
  parseConnectionCode,
  pdfName,
  sha256,
  withIdentifier,
} from "../src/capture.js";
import type { WebPageData } from "../src/page.js";

/** A publisher's page as the extension hands it over: original tags only. */
const tag = (key: string, content: string) => ({
  attribute: "name" as const,
  key,
  content,
});
const page: WebPageData = {
  url: "https://journal.test/article/abc",
  title: "Argyrodite electrolyte one | Journal",
  meta: [
    tag("citation_title", "Argyrodite electrolyte one"),
    tag("citation_author", "Smith, Alice"),
    tag("citation_author", "Lee, Bo"),
    tag("citation_doi", "10.5555/extension.1"),
    tag("citation_publication_date", "2021/3/5"),
    tag("citation_journal_title", "Journal of Synthetic Results"),
    tag("citation_pdf_url", "https://journal.test/article/abc/pdf"),
  ],
  json_ld: [],
  is_pdf: false,
};
/** A page with a title and no identifier. */
const titled = (url: string, title: string): WebPageData => ({
  url,
  title,
  meta: [tag("citation_title", title), tag("citation_author", "Smith, Alice")],
  json_ld: [],
  is_pdf: false,
});

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
  // A typed identifier goes in as the tag a publisher would have set.
  expect(
    withIdentifier(titled("https://blog.test/a", "A"), {
      namespace: "arxiv",
      value: "2401.01234",
    }).meta[0],
  ).toEqual(tag("citation_arxiv_id", "2401.01234"));
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
    // The library reads the page's tags itself (literature and materials 6.4.5).
    expect(await client.lookup(page)).toMatchObject({
      found: false,
      has_pdf: false,
      pdf_url: "https://journal.test/article/abc/pdf",
      metadata: {
        title: "Argyrodite electrolyte one",
        publication_year: 2021,
        identifiers: [{ namespace: "doi", value: "10.5555/extension.1" }],
      },
      possible_duplicates: [],
    });
    // The folder tree to file it into.
    const filed = (await app.folders.manage({
      operation: "create",
      request: { name: "Electrolytes" },
    })) as { folder_id: string };
    expect(
      (await client.folders()).map((folder) => folder.folder_id),
    ).toContain(filed.folder_id);

    const pdf = workbenchPdf("10.5555/extension.1");
    const bytes = pdf.buffer.slice(
      pdf.byteOffset,
      pdf.byteOffset + pdf.byteLength,
    ) as ArrayBuffer;
    const saved = await client.save({
      request_id: crypto.randomUUID(),
      page,
      folder_ids: [filed.folder_id],
      file: {
        file_name: "abc.pdf",
        size_bytes: bytes.byteLength,
        sha256: await sha256(bytes),
        source_url: "https://cdn.journal.test/abc.pdf",
      },
    });
    expect(saved).toMatchObject({
      metadata: { status: "unavailable" },
      disposition: "created",
      missing_folder_ids: [],
      file: { action: "upload", status: "pending" },
    });
    const file = await client.bytes(saved, new Blob([bytes]));
    expect(file.status).toBe("uploaded");
    expect(await client.lookup(page)).toMatchObject({
      found: true,
      has_pdf: true,
      library_title: "Argyrodite electrolyte one",
    });

    // A page with a title and no identifier is collected too.
    const first = titled(
      "https://blog.test/notes/one",
      "A page with only a title about argyrodite interfaces",
    );
    expect(await client.lookup(first)).toMatchObject({
      found: false,
      possible_duplicates: [],
    });
    const kept = await client.save({
      request_id: crypto.randomUUID(),
      page: first,
      folder_ids: [],
      file: null,
    });
    expect(kept).toMatchObject({ disposition: "created", file: null });
    // Another page that may be the same paper: the library lists it, and
    // nothing is collected until the user chooses (6.4.8).
    const second = titled(
      "https://mirror.test/notes/one-copy",
      "A page with only a title about argyrodite interface",
    );
    const preview = await client.lookup(second);
    expect(preview.possible_duplicates.map((d) => d.literature_id)).toEqual([
      kept.literature_id,
    ]);
    await expect(
      client.save({
        request_id: crypto.randomUUID(),
        page: second,
        folder_ids: [],
        file: null,
      }),
    ).rejects.toMatchObject({ code: "intake-decision-required" });
    expect(
      await client.save({
        request_id: crypto.randomUUID(),
        page: second,
        folder_ids: [],
        file: null,
        duplicate_decision: {
          kind: "merge",
          literature_id: kept.literature_id!,
        },
      }),
    ).toMatchObject({ literature_id: kept.literature_id });
    expect(sent.length).toBeGreaterThanOrEqual(10);
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
    await expect(agent.lookup(page)).rejects.toMatchObject({
      code: "device-purpose-forbidden",
    });
    // An address nobody listens on reads as unreachable, naming the address.
    await expect(
      new LibraryClient("http://127.0.0.1:9", token).lookup(page),
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
