import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseLiterature,
  type LibrarySearchPage,
} from "@sciretriever/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { finishIntake, startIntake } from "../src/literature/intake.js";
import { IntakeWithdrawalService } from "../src/literature/intake-withdrawal.js";
import { createMcpServer } from "../src/mcp/server.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const paper = (n: number) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(100 + n),
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `Scoped paper ${n}`,
      identifiers: [],
    },
  });
const selected = (...ids: string[]) => ({
  selector: { kind: "literatures", literature_ids: ids },
});
const candidates = { collection_scope: "candidates" } as const;
const ids = (page: LibrarySearchPage) =>
  page.items.map((item) => item.literature.literature_id).sort();

it("lists only visible papers outside the library, with counter totals, filters and the selector", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-candidates-scope-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: {
      lookup_ports: [],
      topic_search_ports: [],
      reference_query_ports: [],
    },
  });
  const db = new DatabaseSync(join(home, "catalog.sqlite"));
  try {
    for (const n of [1, 2, 3, 4, 5, 6])
      await app.database.putLiterature(paper(n));
    // 4 is withdrawn with its batch; 5 is found by a topic batch.
    const batch = async (
      literatures: number[],
      disposition: "created" | "matched",
    ) => {
      const b = await startIntake(app.database, "topic", "Topic", {}, "cli");
      for (const n of literatures)
        await app.database.writeIntake({
          operation: "member",
          member: { batch_id: b, literature_id: id(n), disposition },
        });
      await finishIntake(app.database, b, "completed");
      return b;
    };
    const withdrawn = await batch([4], "created");
    await new IntakeWithdrawalService(app.database).withdraw(withdrawn);
    const found = await batch([1, 5], "matched");
    while ((await app.database.refreshLibraryState()).more) {
      /* finish the fixture backfill */
    }
    await executeMaintenance(app, "library-collect", selected(id(1), id(2)));
    await executeMaintenance(app, "library-trash", {
      operation: "delete",
      selector: { kind: "literatures", literature_ids: [id(3)] },
    });

    const page = await app.library.search({ query: candidates });
    expect(ids(page)).toEqual([id(5), id(6)]);
    expect(page.total_count).toBe(2);
    for (const item of page.items) expect(item.collected).toBe(false);
    // No discovery run recorded these papers, so the origin is null.
    for (const item of page.items) expect(item.discovery_origin).toBeNull();
    // Paging by cursor gives the same papers one at a time.
    const first = await app.library.search({ query: candidates, limit: 1 });
    const second = await app.library.search({
      query: candidates,
      limit: 1,
      cursor: first.next_cursor,
    });
    expect([...ids(first), ...ids(second)].sort()).toEqual([id(5), id(6)]);
    expect(second.next_cursor).toBeNull();

    const counts = await app.library.counts(candidates);
    expect(counts).toMatchObject({ total: 2, statuses: { UNREVIEWED: 2 } });
    expect(counts).not.toHaveProperty("collection_counts");
    expect(counts).not.toHaveProperty("count_truncated");
    // Unfiltered totals are the counters' all minus collected rows.
    db.prepare(
      "UPDATE library_count_totals SET versions=versions+1000,unreviewed=unreviewed+1000 WHERE scope='all'",
    ).run();
    expect(await app.library.counts(candidates)).toMatchObject({
      total: 1002,
      statuses: { UNREVIEWED: 1002 },
    });
    expect((await app.library.search({ query: candidates })).total_count).toBe(
      1002,
    );
    db.prepare(
      "UPDATE library_count_totals SET versions=versions-1000,unreviewed=unreviewed-1000 WHERE scope='all'",
    ).run();

    // Combined with a batch, a bibliographic condition and text search.
    expect(
      ids(
        await app.library.search({
          query: { ...candidates, intake_batch_ids: [found] },
        }),
      ),
    ).toEqual([id(5)]);
    expect(
      ids(
        await app.library.search({
          query: { ...candidates, title: "paper 6" },
        }),
      ),
    ).toEqual([id(6)]);
    const text = await app.library.search({
      query: { ...candidates, text: "Scoped paper" },
      sort: "relevance",
    });
    expect(ids(text)).toEqual([id(5), id(6)]);
    expect(
      (await app.library.counts({ ...candidates, title: "paper" })).total,
    ).toBe(2);
    expect(
      (await app.library.facets({ query: { ...candidates }, limit: 5 })).total,
    ).toBe(2);
    await expect(
      app.library.search({ query: candidates, sort: "collected-desc" }),
    ).rejects.toThrow();

    // Joining the library removes a paper from the scope; leaving brings it back.
    await executeMaintenance(app, "library-collect", selected(id(5)));
    expect(ids(await app.library.search({ query: candidates }))).toEqual([
      id(6),
    ]);
    await executeMaintenance(app, "library-uncollect", selected(id(5)));
    expect(ids(await app.library.search({ query: candidates }))).toEqual([
      id(5),
      id(6),
    ]);

    // A QuerySelector with the scope collects only its candidates.
    expect(
      await executeMaintenance(app, "library-collect", {
        selector: { kind: "query", query: { ...candidates, title: "paper" } },
      }),
    ).toEqual({ target_count: 2, newly_collected: 2 });
    expect((await app.library.search({ query: candidates })).total_count).toBe(
      0,
    );
    await executeMaintenance(app, "library-uncollect", selected(id(5), id(6)));
  } finally {
    db.close();
    await app.close();
  }

  // The same scope over CLI, MCP and query HTTP.
  const mcp = createMcpServer({ home });
  const [host, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "candidates-scope", version: "1" });
  const query = await createQueryApplication(home);
  const web = await startQueryOnlyHttp({ application: query });
  try {
    const cli = await runCli(
      ["literature", "search", "--collection-scope", "candidates", "--json"],
      { home, stdout: () => {}, stderr: () => {} },
    );
    expect(cli.code).toBe(0);
    expect(ids(cli.value as LibrarySearchPage)).toEqual([id(5), id(6)]);
    await mcp.connect(host);
    await client.connect(transport);
    const viaMcp = await client.callTool({
      name: "search_library",
      arguments: { query: candidates },
    });
    expect(
      ids((viaMcp.structuredContent as { result: LibrarySearchPage }).result),
    ).toEqual([id(5), id(6)]);
    const response = await fetch(web.origin + "/api/v1/query/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        request: { query: candidates },
      }),
    });
    expect(response.status).toBe(200);
    expect(
      ids(((await response.json()) as { page: LibrarySearchPage }).page),
    ).toEqual([id(5), id(6)]);
  } finally {
    await client.close();
    await mcp.close();
    await web.close();
    await query.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
