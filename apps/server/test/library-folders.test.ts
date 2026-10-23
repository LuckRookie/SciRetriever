import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseLiterature,
  parseLibrarySearchRequest,
  parseFolderNode,
  parseFolderImpact,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it(
  "owns nested folder membership, stable recent scopes and model-free transport parity",
  { timeout: 0 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-folders-")),
      app = await createApplication(home);
    const server = createMcpServer({ home, maintenance: true }),
      client = new Client({ name: "folder-tests", version: "1" });
    let raw: DatabaseSync | undefined,
      q: Awaited<ReturnType<typeof createQueryApplication>> | undefined,
      web: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
    const manage = (operation: string, request: unknown) =>
      executeMaintenance(app, "folders", { operation, request });
    try {
      for (let n = 1; n <= 105; n++)
        await app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id(n),
            meta_literature_id: id(n + 200),
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title: `Paper ${n}`,
              identifiers: [],
              publication_year: 2000 + (n % 20),
            },
          }),
        );
      const root = parseFolderNode(await manage("create", { name: "Physics" }));
      const child = parseFolderNode(
        await manage("create", { name: "Spectra", parent_id: root.folder_id }),
      );
      const leaf = parseFolderNode(
        await manage("create", { name: "Tables", parent_id: child.folder_id }),
      );
      await expect(
        manage("create", { name: " Physics " }),
      ).rejects.toMatchObject({ code: "folder-name-conflict" });
      await expect(
        manage("move", {
          folder_id: root.folder_id,
          parent_id: leaf.folder_id,
          position: 0,
        }),
      ).rejects.toMatchObject({ code: "folder-cycle" });
      const members = (operation: string, folder_id: string, ns: number[]) =>
        manage(operation, { folder_id, literature_ids: ns.map(id) });
      expect(await members("add", root.folder_id, [1, 2, 2])).toMatchObject({
        changed: 2,
      });
      expect(await members("add", root.folder_id, [1, 2])).toMatchObject({
        changed: 0,
      });
      await members("add", child.folder_id, [2, 3]);
      await members("add", leaf.folder_id, [3]);
      await expect(
        members(
          "add",
          leaf.folder_id,
          Array.from({ length: 1001 }, () => 1),
        ),
      ).rejects.toMatchObject({ code: "invalid-contract" });
      await expect(
        members("add", leaf.folder_id, [4, 999]),
      ).rejects.toMatchObject({ code: "literature-not-found" });
      const tree = (await app.folders.query({
        operation: "list",
        request: {},
      })) as { items: unknown[] };
      expect(
        tree.items
          .map(parseFolderNode)
          .find((f) => f.folder_id === root.folder_id),
      ).toMatchObject({ own_count: 2, total_count: 3 });
      const filter = {
        folder: { id: root.folder_id, include_descendants: true },
      };
      const page = await app.library.search({
        query: filter,
        sort: "title-desc",
      });
      expect(page.items.map((i) => i.literature.literature_id)).toEqual([
        id(3),
        id(2),
        id(1),
      ]);
      expect(page.items[0]!.folder_ids).toEqual(
        [child.folder_id, leaf.folder_id].sort(),
      );
      expect(
        (
          await app.library.search({
            query: {
              ...filter,
              folder: { id: root.folder_id, include_descendants: false },
            },
          })
        ).total_count,
      ).toBe(2);
      expect(
        (await app.library.counts({ ...filter, title: "Paper 2" })).total,
      ).toBe(1);
      const selected = await app.library.selectionSnapshot(
        parseLibrarySearchRequest({ query: filter }).query,
      );
      expect(
        selected.matches.map((i) => i.literature.literature_id).sort(),
      ).toEqual([id(1), id(2), id(3)]);
      const before = await app.archive.query({
        operation: "revision",
        request: {},
      });
      for (let n = 1; n <= 105; n++)
        await executeMaintenance(app, "reading-open", { literature_id: id(n) });
      expect(
        await executeMaintenance(app, "reading-open", { literature_id: id(1) }),
      ).toMatchObject({ open_count: 2 });
      // Reading history is not material; it must not make open pages reload.
      expect(
        await app.archive.query({ operation: "revision", request: {} }),
      ).toEqual(before);
      raw = new DatabaseSync(join(home, "catalog.sqlite"));
      raw
        .prepare(
          "UPDATE reading_history SET last_opened_at=? WHERE literature_id=?",
        )
        .run(new Date(Date.now() - 31 * 86400000).toISOString(), id(2));
      const readings = raw
        .prepare("SELECT sum(open_count) AS n FROM reading_history")
        .get()!.n;
      let cursor: string | null = null;
      const recent: string[] = [];
      do {
        const p = await app.library.search({
          query: { recently_opened: true },
          limit: 17,
          cursor,
        });
        expect(p.total_count).toBe(100);
        recent.push(...p.items.map((i) => i.literature.literature_id));
        cursor = p.next_cursor;
      } while (cursor);
      expect(new Set(recent).size).toBe(100);
      expect(recent).not.toContain(id(2));
      expect(recent[0]).toBe(id(1));
      expect((await app.library.counts({})).recently_opened).toBe(100);
      expect(
        (
          await app.library.search({
            query: { ...filter, recently_opened: true },
          })
        ).total_count,
      ).toBe(2);
      expect(
        (
          await app.library.selectionSnapshot(
            parseLibrarySearchRequest({
              query: { ...filter, recently_opened: true },
            }).query,
          )
        ).matches
          .map((i) => i.literature.literature_id)
          .sort(),
      ).toEqual([id(1), id(3)]);
      expect(
        (
          await app.library.search({
            query: { text: "Paper", recently_opened: true },
            sort: "relevance",
          })
        ).total_count,
      ).toBe(100);
      expect(
        raw.prepare("SELECT sum(open_count) AS n FROM reading_history").get()!
          .n,
      ).toBe(readings);
      q = await createQueryApplication(home);
      web = await startQueryOnlyHttp({ application: q });
      const response = await fetch(web.origin + "/api/v1/query/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: { operation: "list", request: {} },
        }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { result: unknown }).result).toEqual(
        tree,
      );
      const cli = await runCli(["folders", "list", "--json"], {
        home,
        stdout: () => {},
        stderr: () => {},
      });
      expect(cli.code).toBe(0);
      expect(cli.value).toEqual(tree);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      const renamed = await client.callTool({
        name: "folders_manage",
        arguments: {
          operation: "rename",
          request: { folder_id: root.folder_id, name: "Materials" },
        },
      });
      expect(renamed.isError, JSON.stringify(renamed)).not.toBe(true);
      const preview = parseFolderImpact(
        await app.folders.query({
          operation: "delete-preview",
          request: { folder_id: root.folder_id },
        }),
      );
      expect(preview).toEqual({
        folder_count: 3,
        descendant_count: 2,
        literature_count: 3,
        membership_count: 5,
      });
      expect(await manage("delete", { folder_id: root.folder_id })).toEqual(
        preview,
      );
      expect((await app.library.search({ query: {} })).total_count).toBe(105);
      expect(
        await app.folders.query({ operation: "list", request: {} }),
      ).toEqual({ items: [] });
      expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      raw?.close();
      await web?.close();
      await q?.close();
      await client.close();
      await server.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
