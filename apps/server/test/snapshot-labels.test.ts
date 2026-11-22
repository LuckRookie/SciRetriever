import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { processorFixture } from "./processor-fixture.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { withActivity } from "../src/logging/activity.js";
import { actorLabel, presentActors } from "../src/logging/actor-label.js";
import {
  parseSnapshotHeader,
  parseFolderNode,
  parseSnapshotDefinition,
  parseLibrarySearchRequest,
} from "@sciretriever/contracts";
import { generatedSnapshotName } from "../src/analysis/snapshot-names.js";

it(
  "keeps labels outside snapshot identity and exposes audited rename through CLI and MCP",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    const server = createMcpServer({ home: e.home, maintenance: true });
    const client = new Client({ name: "snapshot-names", version: "1" });
    let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await e.build(e.parseRequest);
      const catalog = new DatabaseSync(join(e.home, "catalog.sqlite"));
      try {
        catalog
          .prepare("DELETE FROM library_collected WHERE literature_id=?")
          .run(e.parseRequest.literature_id);
      } finally {
        catalog.close();
      }
      const created = await withActivity({ actor: "cli:fixture" }, () =>
        e.app.snapshots.create({
          kind: "literatures",
          literature_ids: [e.parseRequest.literature_id],
          name: "研究范围",
        }),
      );
      expect(
        (await e.app.library.detail(e.parseRequest.literature_id)).collected,
      ).toBe(true);
      const before = await e.app.snapshots.all(created.snapshot_id);
      expect(before.name).toBe("研究范围");
      expect(before.name_source).toBe("manual");
      expect(before.members).toHaveLength(1);
      const errors: string[] = [];
      const cli = await runCli(
        [
          "snapshot",
          "rename",
          created.snapshot_id,
          "--name",
          "新名称",
          "--json",
        ],
        { home: e.home, stdout: () => {}, stderr: (s) => errors.push(s) },
      );
      expect(cli.code, errors.join("\n")).toBe(0);
      expect(cli.value).toMatchObject({
        name: "新名称",
        name_source: "manual",
        content_sha256: before.content_sha256,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      const reset = await client.callTool({
        name: "snapshot_rename",
        arguments: { snapshot_id: created.snapshot_id, name: "" },
      });
      expect(reset.isError, JSON.stringify(reset)).not.toBe(true);
      const label = parseSnapshotHeader(
        (reset.structuredContent as { result: unknown }).result,
      );
      expect(label).toMatchObject({
        name: "手选 1 篇",
        name_source: "generated",
        content_sha256: before.content_sha256,
      });
      const after = await e.app.snapshots.all(created.snapshot_id);
      expect(after.members).toEqual(before.members);
      expect(
        await e.app.snapshots.diff({
          before: before.snapshot_id,
          after: after.snapshot_id,
        }),
      ).toEqual({
        added: [],
        removed: [],
        content_changed: [],
        description_changed: [],
      });
      expect(
        (await e.app.snapshots.list({ after: null, limit: 10 })).items[0],
      ).toEqual(label);
      q = await createQueryApplication(e.home);
      const history = (await executeQuery(q, "operation-history", {
        operation: "snapshot-rename",
      })) as { items: { actor: string; actor_label: string }[] };
      expect(
        history.items.some(
          (i) =>
            i.actor === "mcp:snapshot-names" &&
            i.actor_label === "MCP · snapshot-names",
        ),
      ).toBe(true);
      expect(
        history.items.some(
          (i) =>
            i.actor.startsWith("cli:") && i.actor_label.startsWith("命令行 · "),
        ),
      ).toBe(true);
      await expect(
        executeMaintenance(e.app, "snapshot-rename", {
          snapshot_id: created.snapshot_id,
          name: "x".repeat(257),
        }),
      ).rejects.toMatchObject({ code: "invalid-contract" });
      expect(
        (
          await e.app.snapshots.create({
            kind: "query",
            query: parseLibrarySearchRequest({ query: {} }).query,
          })
        ).name,
      ).toBe("全部文献 · 1 篇");
      const folder = parseFolderNode(
        await executeMaintenance(e.app, "folders", {
          operation: "create",
          request: { name: "Spectroscopy" },
        }),
      );
      await executeMaintenance(e.app, "folders", {
        operation: "add",
        request: {
          folder_id: folder.folder_id,
          literature_ids: [e.parseRequest.literature_id],
        },
      });
      const scoped = await e.app.snapshots.create({
        kind: "query",
        query: parseLibrarySearchRequest({
          query: {
            folder: { id: folder.folder_id, include_descendants: true },
          },
        }).query,
      });
      expect(scoped.name).toBe("文件夹 Spectroscopy · 1 篇");
      await executeMaintenance(e.app, "folders", {
        operation: "rename",
        request: { folder_id: folder.folder_id, name: "光谱" },
      });
      expect(await e.app.snapshots.all(scoped.snapshot_id)).toMatchObject({
        name: "文件夹 光谱 · 1 篇",
        content_sha256: scoped.content_sha256,
      });
      await executeMaintenance(e.app, "reading-open", {
        literature_id: e.parseRequest.literature_id,
      });
      expect(
        (
          await e.app.snapshots.create({
            kind: "query",
            query: parseLibrarySearchRequest({
              query: { recently_opened: true },
            }).query,
          })
        ).name,
      ).toBe("最近阅读 · 1 篇");
    } finally {
      await q?.close();
      await client.close();
      await server.close();
      await e.close();
    }
  },
);
it("labels entry identities without exposing machine ids or changing scientific payloads", () => {
  const actor =
    "web-session:2026-10-22T08:00:00.000Z:00000000-0000-0000-0000-000000000001";
  expect(actorLabel(actor)).toMatch(/^网页登录 · /u);
  expect(actorLabel(actor)).not.toContain("00000000");
  expect(actorLabel("system:111")).toBe("系统自动");
  const value = {
    items: [{ actor }],
    payload: { actor: "scientific field" },
    spec: { actor: "schema field" },
  };
  expect(presentActors(value)).toMatchObject({
    items: [{ actor, actor_label: actorLabel(actor) }],
    payload: value.payload,
    spec: value.spec,
  });
  expect(value.items[0]).not.toHaveProperty("actor_label");
});
it("names an unlabelled filter without mistaking it for the entire library", () => {
  expect(
    generatedSnapshotName(
      parseSnapshotDefinition({
        kind: "query",
        query: parseLibrarySearchRequest({ query: { statuses: ["READY"] } })
          .query,
      }),
      12,
    ),
  ).toBe("筛选文献 · 12 篇");
  expect(
    generatedSnapshotName(
      parseSnapshotDefinition({
        kind: "query",
        query: parseLibrarySearchRequest({ query: {} }).query,
      }),
      0,
    ),
  ).toBe("全部文献 · 0 篇");
});
