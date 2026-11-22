import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import {
  parseSavedFilter,
  parseFiltersExportFile,
  parseDeviceConnectionCode,
  parseLibrarySearchRequest,
  parseLiterature,
  type FilterImportResult,
  type SavedFilter,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { runCli } from "../src/cli/main.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { SdkTransportAdapter } from "../src/mcp/transport.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { processorFixture } from "./processor-fixture.js";
import { organizationRows } from "./user-organization-schema-fixture.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-filters-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: false },
  });
  return {
    home,
    app,
    manage: (operation: string, request: unknown) =>
      executeMaintenance(app, "filters", { operation, request }),
    list: async () =>
      (
        (await app.filters.query({ operation: "list", request: {} })) as {
          items: SavedFilter[];
        }
      ).items,
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
const input = (name: string, query: unknown = {}) => ({
  name,
  query,
  sort: "title-asc",
});
const missing = "00000000-0000-0000-0000-000000000001";

it("round-trips collected order through save, update, import and export while preserving legacy bytes", async () => {
  const f = await fixture();
  try {
    const legacy = parseSavedFilter(await f.manage("create", input("legacy")));
    const exportFile = async () =>
      parseFiltersExportFile(
        await f.app.filters.query({ operation: "export", request: {} }),
      );
    const legacyExport = await exportFile();
    const legacyFile = JSON.stringify(legacyExport);
    using db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
      readOnly: true,
    });
    const legacyRow = db.prepare(
      "SELECT filter_id,name,query_json,sort,created_at,updated_at FROM saved_filters WHERE filter_id=?",
    );
    const savedBytes = JSON.stringify(legacyRow.get(legacy.filter_id));

    const sort = "collected-desc";
    const query = { collection_scope: "collected" };
    const created = parseSavedFilter(
      await f.manage("create", { name: "recent", query, sort }),
    );
    expect(created).toMatchObject({ sort, query });
    await f.manage("update", {
      filter_id: created.filter_id,
      query,
      sort: legacy.sort,
    });
    const updated = parseSavedFilter(
      await f.manage("update", {
        filter_id: created.filter_id,
        query: { ...query, title: "test" },
        sort,
      }),
    );
    expect(updated).toMatchObject({ sort, query: { ...query, title: "test" } });
    const imported = { name: "imported", query, sort };
    expect(await f.manage("import", { items: [imported] })).toMatchObject({
      items: [{ status: "imported", filter: imported }],
    });
    const { filters } = await exportFile();
    expect(filters).toEqual([
      { ...imported, query: created.query },
      { name: legacy.name, query: legacy.query, sort: legacy.sort },
      { name: updated.name, query: updated.query, sort },
    ]);
    expect(JSON.stringify(filters[1])).toBe(
      JSON.stringify(legacyExport.filters[0]),
    );
    expect(JSON.stringify(parseFiltersExportFile(JSON.parse(legacyFile)))).toBe(
      legacyFile,
    );
    expect(JSON.stringify(legacyRow.get(legacy.filter_id))).toBe(savedBytes);
  } finally {
    await f.close();
  }
});

it("owns normalized, codepoint-ordered saved conditions and strict CRUD errors", async () => {
  const f = await fixture();
  try {
    const created = parseSavedFilter(
      await f.manage("create", input("  Cafe\u0301  ")),
    );
    expect(created.name).toBe("Café");
    expect(created.query).toEqual(
      parseLibrarySearchRequest({ query: {}, sort: "title-asc" }).query,
    );
    expect(created.created_at).toBe(created.updated_at);
    expect(created.filter_id).toMatch(/^[0-9a-f-]{36}$/u);
    for (const name of ["", " ", "a".repeat(129), "ab\u0000", "a\u200b"])
      await expect(f.manage("create", input(name))).rejects.toMatchObject({
        code: "invalid-contract",
      });
    await expect(f.manage("create", input("Café"))).rejects.toMatchObject({
      code: "filter-name-conflict",
    });
    for (const query of [
      { unknown: true },
      { folder: { id: "bad", include_descendants: true } },
      { publication_year_from: "invalid" },
    ])
      await expect(
        f.manage("create", input("bad", query)),
      ).rejects.toMatchObject({ code: "filter-condition-invalid" });
    await expect(
      f.manage("create", { ...input("bad sort"), sort: "unknown" }),
    ).rejects.toMatchObject({ code: "filter-condition-invalid" });
    for (const name of ["z", "A", "a", "\ue000", "😀", "x".repeat(128)])
      await f.manage("create", input(name));
    expect((await f.list()).map((row) => row.name)).toEqual([
      "A",
      "Café",
      "a",
      "x".repeat(128),
      "z",
      "\ue000",
      "😀",
    ]);
    const renamed = parseSavedFilter(
      await f.manage("rename", {
        filter_id: created.filter_id,
        name: " Renamed ",
      }),
    );
    expect(renamed).toMatchObject({
      ...created,
      name: "Renamed",
      updated_at: expect.any(String),
    });
    const updated = parseSavedFilter(
      await f.manage("update", {
        filter_id: created.filter_id,
        query: { title: "new" },
        sort: "title-desc",
      }),
    );
    expect(updated).toMatchObject({
      name: "Renamed",
      sort: "title-desc",
      query: { title: "new" },
      created_at: created.created_at,
    });
    for (const operation of ["rename", "update", "delete"]) {
      const request =
        operation === "rename"
          ? { filter_id: missing, name: "x" }
          : operation === "update"
            ? { filter_id: missing, query: {}, sort: "title-asc" }
            : { filter_id: missing };
      await expect(f.manage(operation, request)).rejects.toMatchObject({
        code: "filter-not-found",
      });
    }
    expect(() =>
      f.app.filters.query({ operation: "create", request: input("x") }),
    ).toThrow("filter-read-operation-invalid");
    for (const operation of ["list", "export"])
      await expect(f.manage(operation, {})).rejects.toMatchObject({
        code: "filter-write-operation-invalid",
      });
    await f.manage("delete", { filter_id: created.filter_id });
    expect(
      (await f.list()).some((row) => row.filter_id === created.filter_id),
    ).toBe(false);
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      const records = db
        .prepare(
          "SELECT scope_json,result_json FROM operation_records WHERE operation='filters' AND status='completed'",
        )
        .all();
      expect(
        records.some((row) =>
          String(row.result_json).includes(created.filter_id),
        ),
      ).toBe(true);
      const audit = JSON.stringify(records);
      expect(audit).not.toContain("Café");
      expect(audit).not.toContain("query");
      expect(audit).not.toContain("title-asc");
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it("imports mixed items independently, truncates without splitting surrogates and repeats idempotently", async () => {
  const f = await fixture();
  try {
    await f.manage("create", input("same"));
    const items = [
      input("same"),
      input("same", { title: "other" }),
      input("a".repeat(127) + "😀"),
      input("b".repeat(128), { title: "one" }),
      input("b".repeat(128), { title: "two" }),
      input(""),
      input("bad\u200c"),
      input("bad query", { unknown: true }),
      null,
    ];
    const first = (await f.manage("import", { items })) as FilterImportResult;
    expect(first.items.map((row) => row.status)).toEqual([
      "skipped",
      "renamed",
      "imported",
      "imported",
      "renamed",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(first.items[1]!.filter!.name).toBe("same (2)");
    expect(first.items[2]!.filter!.name).toBe("a".repeat(127));
    expect(first.items[4]!.filter!.name).toBe("b".repeat(124) + " (2)");
    expect(first.items[7]!.reason).toBe("filter-condition-invalid");
    const before = await f.list();
    const second = (await f.manage("import", { items })) as FilterImportResult;
    expect(second.items.map((row) => row.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(await f.list()).toEqual(before);
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      const rows = db
        .prepare(
          "SELECT result_json FROM operation_records WHERE operation='filters'",
        )
        .all();
      const json = JSON.stringify(rows);
      for (const item of first.items)
        if (item.filter) expect(json).toContain(item.filter.filter_id);
      expect(json).not.toContain("same");
      expect(json).not.toContain("title");
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it("enforces 200 filters and rolls back a whole overflowing import", async () => {
  const f = await fixture();
  try {
    await f.manage("import", {
      items: Array.from({ length: 199 }, (_, n) => input(`f${n}`)),
    });
    const before = await f.list();
    await expect(
      f.manage("import", { items: [input("last"), input("overflow")] }),
    ).rejects.toMatchObject({ code: "filter-limit" });
    expect(await f.list()).toEqual(before);
    await f.manage("create", input("last"));
    await expect(f.manage("create", input("overflow"))).rejects.toMatchObject({
      code: "filter-limit",
    });
    for (const items of [[], Array(201).fill(input("many"))])
      await expect(f.manage("import", { items })).rejects.toMatchObject({
        code: "invalid-contract",
      });
  } finally {
    await f.close();
  }
});

it("applies conditions to current membership and retains a deleted folder reference", async () => {
  const f = await fixture();
  try {
    const folder = (await f.app.folders.manage({
      operation: "create",
      request: { name: "group" },
    })) as { folder_id: string };
    const saved = parseSavedFilter(
      await f.manage(
        "create",
        input("dynamic", {
          folder: { id: folder.folder_id, include_descendants: true },
        }),
      ),
    );
    expect(
      (await f.app.library.search({ query: saved.query, sort: saved.sort }))
        .total_count,
    ).toBe(0);
    await f.app.database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
    await f.app.folders.manage({
      operation: "add",
      request: {
        folder_id: folder.folder_id,
        literature_ids: [FIXTURE_LITERATURE.literature_id],
      },
    });
    expect(
      (await f.app.library.search({ query: saved.query, sort: saved.sort }))
        .total_count,
    ).toBe(1);
    await f.app.folders.manage({
      operation: "delete",
      request: { folder_id: folder.folder_id },
    });
    expect(await f.list()).toEqual([
      { ...saved, missing_folder_id: folder.folder_id },
    ]);
    expect(
      (await f.app.library.search({ query: saved.query, sort: saved.sort }))
        .total_count,
    ).toBe(0);
  } finally {
    await f.close();
  }
});

it("leaves literature facts, state, source revision and result freshness unchanged; query is read-only", async () => {
  const f = await processorFixture({ offline: true });
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await f.build(f.parseRequest);
    const results = await f.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "filters-facts",
      name: "synthetic",
      processor: { id: "summary", version: "2" },
      spec: {},
      inputs: [
        { kind: "literature", literature_id: f.parseRequest.literature_id },
      ],
    });
    expect(results.failures).toEqual([]);
    const callsBefore = f.modelCalls;
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      const before = organizationRows(db);
      expect(before.processor_results!.length).toBeGreaterThan(0);
      const saved = parseSavedFilter(
        await executeMaintenance(f.app, "filters", {
          operation: "create",
          request: input("private-condition", { title: "sensitive-condition" }),
        }),
      );
      await executeMaintenance(f.app, "filters", {
        operation: "update",
        request: {
          filter_id: saved.filter_id,
          query: { title: "replacement" },
          sort: "title-desc",
        },
      });
      const after = organizationRows(db);
      delete before.operation_records;
      delete after.operation_records;
      expect(after).toEqual(before);
    } finally {
      db.close();
    }
    q = await createQueryApplication(f.home);
    const catalog = join(f.home, "catalog.sqlite");
    const bytes = await readFile(catalog),
      wal = await readFile(catalog + "-wal");
    await executeQuery(q, "filters", { operation: "list", request: {} });
    expect(await readFile(catalog)).toEqual(bytes);
    expect(await readFile(catalog + "-wal")).toEqual(wal);

    expect(f.modelCalls).toBe(callsBefore);
  } finally {
    await q?.close();
    await f.close();
  }
}, 60000);

it("returns identical saved filters over Web, CLI, actual stdio MCP and device HTTP MCP", async () => {
  const f = await fixture(),
    q = await createQueryApplication(f.home),
    screen = new ProductionWorkbenchSession(null, undefined);
  const web = await startWorkbenchHttp({
    session: screen,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
    devices: {
      service: f.app.deviceConnections,
      routes: deviceBusinessRoutes(f.app, q),
    },
    query: {
      application: q,
      maintenance: f.app.maintenance!,
      archiveOperation: (op, value, signal) =>
        executeMaintenance(f.app, op, value, signal),
    },
  });
  const entry = new URL("../dist/cli/main.js", import.meta.url).href;
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      `import {runCli} from ${JSON.stringify(entry)}; process.exitCode=(await runCli(['mcp','--maintenance'],{home:process.argv[1]})).code;`,
      f.home,
    ],
    stderr: "pipe",
  });
  const local = new Client({ name: "filters-stdio", version: "1" }),
    remote = new Client({ name: "filters-http", version: "1" });
  let http: StreamableHTTPClientTransport | undefined;
  try {
    const login = await workbenchLogin(web.origin),
      landing = await fetch(web.origin, { headers: { Cookie: login } }),
      cookies = `${login}; ${landing.headers.get("set-cookie")!.split(";")[0]!}`;
    const grant = await fetch(web.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookies,
        Origin: web.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const access = (await grant.json()) as { client_id: string; csrf: string };
    const post = (kind: string, request: unknown, csrf = access.csrf) =>
      fetch(
        `${web.origin}/api/v1/${kind}/filters?client_id=${access.client_id}`,
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
    const viaWeb = { ...input("via Web"), sort: "collected-desc" };
    const created = await post("maintenance", {
      operation: "create",
      request: viaWeb,
    });
    expect(created.status).toBe(200);
    await local.connect(stdio);
    const pairing = await f.app.deviceConnections.create({
      address: web.origin,
      name: "synthetic",
      purposes: ["read", "operate"],
    });
    const paired = await f.app.deviceConnections.exchange(
      {
        pairing_code: parseDeviceConnectionCode(pairing.connection_code)
          .pairing_code,
      },
      "synthetic-peer",
    );
    http = new StreamableHTTPClientTransport(new URL("/mcp", web.origin), {
      requestInit: { headers: { Authorization: `Bearer ${paired.token}` } },
    });
    await remote.connect(new SdkTransportAdapter(http));
    for (const client of [local, remote]) {
      const write = await client.callTool({
        name: "filters_manage",
        arguments: {
          operation: "import",
          request: { items: [viaWeb] },
        },
      });
      expect(write.isError).not.toBe(true);
      expect(write.structuredContent).toMatchObject({
        result: { items: [{ status: "skipped" }] },
      });
    }
    const cli = await runCli(["filters", "list", "--json"], { home: f.home });
    expect(cli.code).toBe(0);
    expect(cli.value).toMatchObject({
      items: [{ name: "via Web", sort: "collected-desc" }],
    });
    const request = { operation: "list", request: {} };
    expect(await (await post("query", request)).json()).toEqual({
      protocol_version: 1,
      result: cli.value,
    });
    for (const client of [local, remote])
      expect(
        (await client.callTool({ name: "filters_query", arguments: request }))
          .structuredContent,
      ).toEqual({ protocol_version: 1, result: cli.value });
    async function* stdin() {
      yield Buffer.from(JSON.stringify({ items: [viaWeb] }));
    }
    const cliWrite = await runCli(
      ["filters", "import", "--request", "-", "--json"],
      { home: f.home, stdin: stdin() },
    );
    expect(cliWrite.code).toBe(0);
    expect(cliWrite.value).toMatchObject({ items: [{ status: "skipped" }] });
    expect(
      (
        await post(
          "maintenance",
          { operation: "delete", request: { filter_id: missing } },
          "wrong",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(web.origin + "/api/v1/query/filters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  } finally {
    await local.close();
    await stdio.close();
    await remote.close();
    await http?.close();
    await web.close();
    await screen.close();
    await q.close();
    await f.close();
  }
}, 60000);
