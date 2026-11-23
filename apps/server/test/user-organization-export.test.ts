import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import {
  canonicalJsonBytes,
  encodeCursor,
  parseDeviceConnectionCode,
  parseFilterOperation,
  parseFiltersExportFile,
  parseFolderExportPage,
  parseFolderExportRequest,
  parseFolderNode,
  parseFolderOperation,
  parseFoldersExportFile,
  parseLiterature,
  parseSavedFilter,
  type FolderExportPage,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { runCli } from "../src/cli/main.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { LiteratureQueryService } from "../src/literature/query.js";
import { SdkTransportAdapter } from "../src/mcp/transport.js";
import { SCHEMA_MANIFEST } from "../src/storage/sqlite/schema.js";
import {
  startQueryOnlyHttp,
  startWorkbenchHttp,
} from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { catalogRows } from "./catalog-rows-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

const id = (n: number) =>
  "00000000-0000-0000-0000-" + String(n).padStart(12, "0");
const timestamp = "2026-11-17T00:00:00.000Z";
const command = (limit = 1000, cursor: string | null = null) => ({
  operation: "export",
  request: { cursor, limit },
});
const filterCommand = { operation: "export", request: {} };

async function fixture() {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-organization-export-"),
  );
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: false },
  });
  const query = await createQueryApplication(home);
  const db = new DatabaseSync(join(home, "catalog.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=20000");
  return {
    home,
    app,
    query,
    db,
    manage: (operation: string, request: unknown) =>
      executeMaintenance(app, "folders", { operation, request }),
    async close() {
      db.close();
      await query.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seed(f: Fixture) {
  for (let n = 1; n <= 4; n++) {
    await f.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(n),
        meta_literature_id: id(n + 100),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: n === 2 ? null : "Synthetic paper " + n,
          publication_year: n === 2 ? null : 2026,
          identifiers:
            n === 1
              ? [
                  { namespace: "doi", value: "10.5555/export" },
                  { namespace: "arxiv", value: "2601.00001" },
                  { namespace: "pmid", value: "12345678" },
                  { namespace: "pmcid", value: "PMC12345678" },
                  {
                    namespace: "synthetic-provider",
                    value: "not-a-stable-export-id",
                  },
                ]
              : [],
        },
      }),
    );
  }
  const root = parseFolderNode(await f.manage("create", { name: "Root" }));
  const child = parseFolderNode(
    await f.manage("create", {
      name: "Child",
      parent_id: root.folder_id,
    }),
  );
  const empty = parseFolderNode(await f.manage("create", { name: "Empty" }));
  for (const [folder, members] of [
    [root, [id(1), id(2)]],
    [child, [id(1), id(3)]],
  ] as const)
    await f.manage("add", {
      folder_id: folder.folder_id,
      literature_ids: members,
    });
  await executeMaintenance(f.app, "reading-open", { literature_id: id(1) });
  for (const [name, query, sort] of [
    ["All", {}, "title-asc"],
    [
      "Scoped",
      { folder: { id: root.folder_id, include_descendants: true } },
      "title-desc",
    ],
    [
      "Missing folder",
      { folder: { id: id(999), include_descendants: false } },
      "publication-year-desc",
    ],
  ] as const)
    await executeMaintenance(f.app, "filters", {
      operation: "create",
      request: { name, query, sort },
    });
  return { root, child, empty };
}

function post(
  origin: string,
  path: string,
  request: unknown,
  signal?: AbortSignal,
) {
  return fetch(origin + "/api/v1/query/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocol_version: 1, request }),
    signal: signal ?? null,
  });
}
function withoutTime(value: unknown) {
  const { exported_at, ...rest } = value as Record<string, unknown>;
  expect(typeof exported_at).toBe("string");
  expect(new Date(String(exported_at)).toISOString()).toBe(exported_at);
  return rest;
}

it(
  "exports the exact tree, repeated membership and existing stable identifiers in ordered pages without writes",
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const { root, child, empty } = await seed(f);
      const before = catalogRows(f.db, SCHEMA_MANIFEST);
      expect(before.reading_history).toHaveLength(1);
      expect(before.operation_records!.length).toBeGreaterThan(0);
      const bytes = await readFile(join(f.home, "catalog.sqlite"));
      const wal = await readFile(join(f.home, "catalog.sqlite-wal"));
      const whole = parseFolderExportPage(
        await f.query.folders!.query(command()),
      );
      expect(whole.folders).toEqual(
        [root, child, empty]
          .map(({ folder_id, name, parent_id, position }) => ({
            folder_id,
            name,
            parent_id,
            position,
          }))
          .sort((a, b) => a.folder_id.localeCompare(b.folder_id)),
      );
      expect(whole.members.map((m) => [m.folder_id, m.literature_id])).toEqual(
        [
          [root.folder_id, id(1)],
          [root.folder_id, id(2)],
          [child.folder_id, id(1)],
          [child.folder_id, id(3)],
        ].sort((a, b) => a.join().localeCompare(b.join())),
      );
      const book = {
        literature_id: id(1),
        identifiers: [
          { namespace: "doi", value: "10.5555/export" },
          { namespace: "arxiv", value: "2601.00001" },
          { namespace: "pmid", value: "12345678" },
          { namespace: "pmcid", value: "PMC12345678" },
        ],
        title: "Synthetic paper 1",
        year: 2026,
      };
      expect(whole.members.filter((m) => m.literature_id === id(1))).toEqual(
        [root.folder_id, child.folder_id]
          .sort()
          .map((folder_id) => ({ folder_id, ...book })),
      );
      expect(whole.members.find((m) => m.literature_id === id(2))).toEqual({
        folder_id: root.folder_id,
        literature_id: id(2),
        identifiers: [],
        title: null,
        year: null,
      });
      let cursor: string | null = null;
      const pages: FolderExportPage[] = [];
      do {
        const page = parseFolderExportPage(
          await f.query.folders!.query(command(1, cursor)),
        );
        expect(page.folders).toEqual(cursor === null ? whole.folders : null);
        expect(page.members).toHaveLength(1);
        pages.push(page);
        cursor = page.next_cursor;
      } while (cursor);
      expect(pages.flatMap((p) => p.members)).toEqual(whole.members);
      expect(new Set(pages.map((p) => p.exported_at)).size).toBe(1);
      expect(whole.next_cursor).toBeNull();
      for (const limit of [0, 1001, 1.5]) {
        expect(() => parseFolderOperation(command(limit))).toThrow();
        await expect(async () =>
          f.query.folders!.query(command(limit)),
        ).rejects.toThrow();
      }
      for (const cursor of [
        "invalid",
        await encodeCursor("library-search", {
          after: [root.folder_id, id(1)],
          exported_at: timestamp,
        }),
        await encodeCursor("folder-export", {
          after: ["bad", id(1)],
          exported_at: timestamp,
        }),
      ])
        await expect(
          f.query.folders!.query(command(1, cursor)),
        ).rejects.toThrow();
      const filterFile = parseFiltersExportFile(
        await f.query.filters!.query(filterCommand),
      );
      const listed = (await f.query.filters!.query({
        operation: "list",
        request: {},
      })) as { items: unknown[] };
      expect(filterFile.filters).toEqual(
        listed.items
          .map(parseSavedFilter)
          .map(({ name, query, sort }) => ({ name, query, sort })),
      );
      expect(catalogRows(f.db, SCHEMA_MANIFEST)).toEqual(before);
      expect(await readFile(join(f.home, "catalog.sqlite"))).toEqual(bytes);
      expect(await readFile(join(f.home, "catalog.sqlite-wal"))).toEqual(wal);
    } finally {
      await f.close();
    }
  },
);

it("uses a fresh snapshot on the next machine page and strictly parses both export formats", async () => {
  const f = await fixture();
  try {
    const { root, child } = await seed(f);
    const first = parseFolderExportPage(
      await f.query.folders!.query(command(1)),
    );
    const last = first.members[0]!;
    // Place a newly committed member beyond the cursor, irrespective of random folder IDs.
    const target = [root, child]
      .sort((a, b) => a.folder_id.localeCompare(b.folder_id))
      .at(-1)!;
    await f.manage("add", {
      folder_id: target.folder_id,
      literature_ids: [id(4)],
    });
    const next = parseFolderExportPage(
      await f.query.folders!.query(command(1000, first.next_cursor)),
    );
    expect(next.members).toContainEqual({
      folder_id: target.folder_id,
      literature_id: id(4),
      identifiers: [],
      title: "Synthetic paper 4",
      year: 2026,
    });
    expect(
      next.members.every(
        (m) =>
          m.folder_id > last.folder_id ||
          (m.folder_id === last.folder_id &&
            m.literature_id > last.literature_id),
      ),
    ).toBe(true);
    const file = {
      format: "sciretriever-folders",
      version: 1,
      exported_at: timestamp,
      folders: [],
    };
    const filters = {
      format: "sciretriever-filters",
      version: 1,
      exported_at: timestamp,
      filters: [],
    };
    expect(parseFoldersExportFile(file)).toEqual(file);
    expect(parseFiltersExportFile(filters)).toEqual(filters);
    expect(parseFilterOperation(filterCommand)).toEqual(filterCommand);
    expect(parseFolderExportRequest(command().request)).toEqual(
      command().request,
    );
    for (const invalid of [
      { ...file, format: "unknown" },
      { ...file, version: 2 },
      { ...file, extra: true },
      {
        ...file,
        folders: [
          {
            folder_id: root.folder_id,
            name: "Root",
            parent_id: child.folder_id,
            position: 0,
            members: [],
          },
        ],
      },
      {
        ...file,
        folders: [
          {
            folder_id: root.folder_id,
            name: "Root",
            parent_id: null,
            position: 0,
            members: [
              {
                literature_id: id(1),
                identifiers: [{ namespace: "other", value: "x" }],
                title: null,
                year: null,
              },
            ],
          },
        ],
      },
    ])
      expect(() => parseFoldersExportFile(invalid)).toThrow();
    for (const invalid of [
      { ...filters, format: "unknown" },
      { ...filters, version: 2 },
      { ...filters, extra: true },
      {
        ...filters,
        filters: [
          { name: "x", query: {}, sort: "title-asc", filter_id: id(8) },
        ],
      },
      {
        ...filters,
        filters: Array(201).fill({ name: "x", query: {}, sort: "title-asc" }),
      },
    ])
      expect(() => parseFiltersExportFile(invalid)).toThrow();
    expect(() =>
      parseFilterOperation({
        operation: "export",
        request: { unexpected: true },
      }),
    ).toThrow();
    expect(() => parseFolderExportPage({ ...first, extra: true })).toThrow();
    expect(() =>
      parseFolderExportRequest({ cursor: null, limit: 1000, extra: true }),
    ).toThrow();
  } finally {
    await f.close();
  }
});

// Large, relationally valid synthetic input without thousands of audited writes.
// Every row is local to this disposable catalog; no assets or external services.
function seedBulk(f: Fixture, count: number, title: string) {
  const folder = id(900000);
  const metadata = {
    ...FIXTURE_LITERATURE.metadata,
    title,
    identifiers: [],
    publication_form: null,
    article_kind: null,
    language: null,
  };
  const hash = createHash("sha256")
    .update(canonicalJsonBytes(metadata))
    .digest("hex");
  f.db.exec("BEGIN");
  try {
    f.db
      .prepare("INSERT INTO folders VALUES(?,NULL,'Bulk',0,?,?)")
      .run(folder, timestamp, timestamp);
    const meta = f.db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const literature = f.db.prepare(
      "INSERT INTO literatures VALUES(?,?,'published')",
    );
    const book = f.db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,publication_year) VALUES(?,1,?,?,2026)",
    );
    const member = f.db.prepare(
      "INSERT INTO folder_members VALUES(?,?,?,'synthetic')",
    );
    for (let n = 1; n <= count; n++) {
      meta.run(id(n + 1000000), id(n + 1000));
      literature.run(id(n + 1000), id(n + 1000000));
      book.run(id(n + 1000), hash, title);
      member.run(folder, id(n + 1000), timestamp);
    }
    f.db.exec("COMMIT");
  } catch (error) {
    if (f.db.isTransaction) f.db.exec("ROLLBACK");
    throw error;
  }
  expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return folder;
}

it("streams one HTTP attachment from a single snapshot shared with public literature reads", async () => {
  const f = await fixture();
  const folder = seedBulk(f, 260, "Before");
  const web = await startQueryOnlyHttp({ application: f.query });
  const original = LiteratureQueryService.prototype.bibliographies;
  let release!: () => void, reached!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checkpoint = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let calls = 0;
  LiteratureQueryService.prototype.bibliographies = async function (
    ids,
    signal,
  ) {
    if (++calls === 2) {
      reached();
      await pause;
    }
    return original.call(this, ids, signal);
  };
  try {
    const response = await post(web.origin, "folders-export", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="sciretriever-folders.json"',
    );
    const reader = response.body!.getReader(),
      pieces: Uint8Array[] = [];
    await checkpoint;
    let prefix = "";
    while (!prefix.includes('"literature_id"')) {
      const part = await reader.read();
      expect(part.done).toBe(false);
      pieces.push(part.value!);
      prefix += new TextDecoder().decode(part.value);
    }
    // First bytes reached the client while the next real bibliography read is paused.
    expect(calls).toBe(2);
    await f.manage("rename", { folder_id: folder, name: "After" });
    await f.manage("remove", { folder_id: folder, literature_ids: [id(1259)] });
    await f.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id(1260),
        meta_literature_id: id(1000260),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "After",
          publication_form: null,
          article_kind: null,
          language: null,
          identifiers: [{ namespace: "doi", value: "10.5555/after" }],
        },
      }),
    );
    release();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      pieces.push(part.value);
    }
    const file = parseFoldersExportFile(
      JSON.parse(Buffer.concat(pieces).toString("utf8")),
    );
    expect(file.folders).toHaveLength(1);
    expect(file.folders[0]!.name).toBe("Bulk");
    expect(file.folders[0]!.members).toHaveLength(260);
    expect(file.folders[0]!.members.at(-1)).toEqual({
      literature_id: id(1260),
      identifiers: [],
      title: "Before",
      year: 2026,
    });
    LiteratureQueryService.prototype.bibliographies = original;
    const next = parseFoldersExportFile(
      await (await post(web.origin, "folders-export", {})).json(),
    );
    expect(next.folders[0]!.name).toBe("After");
    expect(next.folders[0]!.members).toHaveLength(259);
    expect(next.folders[0]!.members.at(-1)).toEqual({
      literature_id: id(1260),
      identifiers: [{ namespace: "doi", value: "10.5555/after" }],
      title: "After",
      year: 2026,
    });
  } finally {
    release();
    LiteratureQueryService.prototype.bibliographies = original;
    await web.close();
    await f.close();
  }
}, 60000);

it("releases the export snapshot on consumer failure and cancellation", async () => {
  const f = await fixture();
  try {
    await seed(f);
    const before = catalogRows(f.db, SCHEMA_MANIFEST),
      failure = new Error("synthetic consumer failure");
    await expect(
      f.query.folders!.withExportFile({}, async (chunks) => {
        for await (const chunk of chunks) {
          expect(chunk.byteLength).toBeGreaterThan(0);
          throw failure;
        }
      }),
    ).rejects.toBe(failure);
    const stop = new AbortController();
    await expect(
      f.query.folders!.withExportFile(
        {},
        async (chunks) => {
          for await (const chunk of chunks) {
            expect(chunk.byteLength).toBeGreaterThan(0);
            stop.abort();
          }
        },
        stop.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject(
      { busy: 0 },
    );
    expect(catalogRows(f.db, SCHEMA_MANIFEST)).toEqual(before);
    // A new export still works after both failure paths.
    const web = await startQueryOnlyHttp({ application: f.query });
    try {
      expect(
        parseFoldersExportFile(
          await (await post(web.origin, "folders-export", {})).json(),
        ).folders,
      ).toHaveLength(3);
    } finally {
      await web.close();
    }
  } finally {
    await f.close();
  }
});

it("returns identical Web, CLI and actual stdio/HTTP MCP exports and preserves Web/device read boundaries", async () => {
  const f = await fixture();
  const screen = new ProductionWorkbenchSession(null, undefined);
  const web = await startWorkbenchHttp({
    session: screen,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
    devices: {
      service: f.app.deviceConnections,
      routes: deviceBusinessRoutes(f.app, f.query),
    },
    query: { application: f.query },
  });
  const entry = new URL("../dist/cli/main.js", import.meta.url).href;
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      "import {runCli} from " +
        JSON.stringify(entry) +
        "; process.exitCode=(await runCli(['mcp'],{home:process.argv[1]})).code;",
      f.home,
    ],
    stderr: "pipe",
  });
  const local = new Client({ name: "export-stdio", version: "1" });
  const remotes: {
    client: Client;
    transport: StreamableHTTPClientTransport;
  }[] = [];
  try {
    await seed(f);
    const login = await workbenchLogin(web.origin);
    const landing = await fetch(web.origin, { headers: { Cookie: login } });
    const cookies =
      login + "; " + landing.headers.get("set-cookie")!.split(";")[0]!;
    const granted = await fetch(web.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookies,
        Origin: web.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const access = (await granted.json()) as {
      client_id: string;
      csrf: string;
    };
    const webPost = (path: string, request: unknown, csrf = access.csrf) =>
      fetch(
        web.origin + "/api/v1/query/" + path + "?client_id=" + access.client_id,
        {
          method: "POST",
          headers: {
            Cookie: cookies,
            Origin: web.origin,
            "Content-Type": "application/json",
            "X-Workbench-CSRF": csrf,
            "X-SciRetriever-Protocol-Version": "1",
          },
          body: JSON.stringify({ protocol_version: 1, request }),
        },
      );
    await local.connect(stdio);
    for (const purposes of [["read"], ["operate"]] as const) {
      const pairing = await f.app.deviceConnections.create({
        address: web.origin,
        name: "Synthetic export",
        purposes,
      });
      const paired = await f.app.deviceConnections.exchange(
        {
          pairing_code: parseDeviceConnectionCode(pairing.connection_code)
            .pairing_code,
        },
        "synthetic-peer",
      );
      const transport = new StreamableHTTPClientTransport(
        new URL("/mcp", web.origin),
        {
          requestInit: { headers: { Authorization: "Bearer " + paired.token } },
        },
      );
      const client = new Client({ name: "export-http", version: "1" });
      await client.connect(new SdkTransportAdapter(transport));
      remotes.push({ client, transport });
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of ["folders_query", "filters_query"])
        expect(names.includes(name)).toBe(purposes[0] === "read");
      for (const [name, args] of [
        ["folders_query", command()],
        ["filters_query", filterCommand],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError === true).toBe(purposes[0] !== "read");
        if (purposes[0] !== "read")
          expect(result.structuredContent).toMatchObject({
            result: { failure: { code: "device-purpose-forbidden" } },
          });
      }
      const direct = await fetch(web.origin + "/api/v1/query/folders-export", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + paired.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ protocol_version: 1, request: {} }),
      });
      expect(direct.status).toBe(403);
    }
    const before = catalogRows(f.db, SCHEMA_MANIFEST);
    const bytes = await readFile(join(f.home, "catalog.sqlite"));
    const wal = await readFile(join(f.home, "catalog.sqlite-wal"));
    const requestFile = join(f.home, "folder-export-request.json");
    await writeFile(requestFile, JSON.stringify(command().request));
    const cliFolders = await runCli(
      ["folders", "export", "--request", requestFile, "--json"],
      { home: f.home },
    );
    const cliFilters = await runCli(["filters", "export", "--json"], {
      home: f.home,
    });
    expect(cliFolders.code).toBe(0);
    expect(cliFilters.code).toBe(0);
    expect(
      (await runCli(["folders", "export", "--json"], { home: f.home })).code,
    ).toBe(2);
    for (const [name, path, args, cli, parse] of [
      [
        "folders_query",
        "folders",
        command(),
        cliFolders,
        parseFolderExportPage,
      ],
      [
        "filters_query",
        "filters",
        filterCommand,
        cliFilters,
        parseFiltersExportFile,
      ],
    ] as const) {
      const expected = withoutTime(parse(cli.value));
      const response = await webPost(path, args);
      expect(response.status).toBe(200);
      expect(
        withoutTime(
          parse(((await response.json()) as { result: unknown }).result),
        ),
      ).toEqual(expected);
      for (const client of [local, remotes[0]!.client]) {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError).not.toBe(true);
        expect(
          withoutTime(
            parse((response.structuredContent as { result: unknown }).result),
          ),
        ).toEqual(expected);
      }
    }
    const download = await webPost("folders-export", {});
    expect(download.status).toBe(200);
    const file = parseFoldersExportFile(await download.json());
    const page = parseFolderExportPage(cliFolders.value);
    expect(file.folders).toEqual(
      page.folders!.map((folder) => ({
        ...folder,
        members: page.members
          .filter((m) => m.folder_id === folder.folder_id)
          .map(({ folder_id, ...m }) => {
            void folder_id;
            return m;
          }),
      })),
    );
    expect((await webPost("folders-export", {}, "wrong")).status).toBe(403);
    expect((await webPost("folders-export", { extra: true })).status).toBe(400);
    expect((await post(web.origin, "folders-export", {})).status).toBe(401);
    expect(catalogRows(f.db, SCHEMA_MANIFEST)).toEqual(before);
    expect(await readFile(join(f.home, "catalog.sqlite"))).toEqual(bytes);
    expect(await readFile(join(f.home, "catalog.sqlite-wal"))).toEqual(wal);
  } finally {
    await local.close();
    await stdio.close();
    for (const remote of remotes) {
      await remote.client.close();
      await remote.transport.close();
    }
    await web.close();
    await screen.close();
    await f.close();
  }
}, 60000);

it("keeps large HTTP downloads bounded by batches rather than accumulating members", async () => {
  const f = await fixture();
  const title = "x".repeat(8192);
  const folder = seedBulk(f, 10000, title);
  // Smaller download uses the same catalog and code; only membership count differs.
  f.db
    .prepare("DELETE FROM folder_members WHERE literature_id>?")
    .run(id(1500));
  const web = await startQueryOnlyHttp({ application: f.query });
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  const original = LiteratureQueryService.prototype.bibliographies;
  let batches = 0,
    maxBatch = 0;
  let peak = 0,
    first = 0,
    peakRss = 0,
    firstRss = 0;
  let memberBytesReceived = Promise.resolve();
  LiteratureQueryService.prototype.bibliographies = async function (
    ids,
    signal,
  ) {
    if (++batches === 2) await memberBytesReceived;
    const result = await original.call(this, ids, signal);
    maxBatch = Math.max(maxBatch, ids.length);
    collect();
    const memory = process.memoryUsage(),
      active = memory.heapUsed + memory.arrayBuffers;
    if (!first) {
      first = active;
      firstRss = memory.rss;
    }
    peak = Math.max(peak, active);
    peakRss = Math.max(peakRss, memory.rss);
    return result;
  };
  async function download() {
    batches = 0;
    maxBatch = 0;
    peak = 0;
    first = 0;
    peakRss = 0;
    firstRss = 0;
    let received!: () => void;
    memberBytesReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    try {
      const started = performance.now(),
        response = await post(
          web.origin,
          "folders-export",
          {},
          AbortSignal.timeout(30_000),
        );
      expect(response.status).toBe(200);
      let bytes = 0;
      for await (const chunk of response.body!) {
        bytes += chunk.byteLength;
        // The headers and empty folder prefix are smaller than a member title.
        // The second page stays paused until the client reads member bytes.
        if (bytes > title.length) received();
      }
      return {
        bytes,
        batches,
        maxBatch,
        heapGrowth: peak - first,
        rssGrowth: peakRss - firstRss,
        ms: performance.now() - started,
      };
    } finally {
      received();
    }
  }
  try {
    const small = await download();
    f.db.exec("BEGIN");
    const member = f.db.prepare(
      "INSERT INTO folder_members VALUES(?,?,?,'synthetic')",
    );
    for (let n = 501; n <= 10000; n++)
      member.run(folder, id(n + 1000), timestamp);
    f.db.exec("COMMIT");
    const large = await download();
    expect(small.batches).toBe(4);
    expect(large.batches).toBe(79);
    expect(small.maxBatch).toBe(128);
    expect(large.maxBatch).toBe(128);
    expect(large.bytes).toBeGreaterThan(small.bytes * 19);
    // Measure live heap and buffers. RSS includes pages that the allocator
    // and SQLite keep resident after the objects retaining the bytes are gone.
    const additional = large.bytes - small.bytes;
    expect(large.heapGrowth - small.heapGrowth).toBeLessThan(additional / 5);
    console.info(
      "organization-export-stream",
      JSON.stringify({ small, large }),
    );
  } finally {
    LiteratureQueryService.prototype.bibliographies = original;
    await web.close();
    await f.close();
  }
}, 180000);
