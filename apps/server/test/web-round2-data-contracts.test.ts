import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseFolderNode,
  parseLibrarySearchRequest,
  parseReadingStatus,
} from "@sciretriever/contracts";
import { processorFixture } from "./processor-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { AgentTraceService } from "../src/application/agent-traces.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { ApiClient } from "../../web/src/app/data/api.js";
import {
  readLibraryCounts,
  searchLibrary,
  readLiterature,
} from "../../web/src/app/data/library.js";
import {
  listFolders,
  manageFolder,
  previewFolderDeletion,
  recordReadingOpen,
} from "../../web/src/app/data/folders.js";
import {
  createSnapshot,
  listSnapshots,
  readSnapshot,
  renameSnapshot,
} from "../../web/src/app/data/snapshots.js";
import { readReadingStatus } from "../../web/src/app/data/reading-status.js";
import { readAgentConversation } from "../../web/src/app/data/agent-conversation.js";
import { readProcessorResult } from "../../web/src/app/data/processor-results.js";

it(
  "round-trips round-two Web data through HTTP with CLI/MCP reading-status parity and no query side effects",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    const traces = new AgentTraceService(e.app.database);
    const mcp = createMcpServer({ home: e.home });
    const client = new Client({ name: "round-two-data", version: "1" });
    let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    let web: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
    const nativeFetch = globalThis.fetch;
    try {
      await e.build(e.parseRequest);
      const generated = await e.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "round2-existing-result",
        name: "Existing synthetic result",
        processor: { id: "summary", version: "2" },
        spec: {},
        inputs: [
          { kind: "literature", literature_id: e.parseRequest.literature_id },
        ],
      });
      expect(generated.failures).toEqual([]);
      const result = (await e.app.processorRead!.list()).items[0]!;
      const calls = e.modelCalls,
        parses = e.parseCalls;
      q = await createQueryApplication(e.home);
      web = await startQueryOnlyHttp({
        application: q,
        maintenance: e.app.maintenance!,
        archiveOperation: (op, input, signal) =>
          executeMaintenance(e.app, op, input, signal),
      });
      const origin = web.origin;
      let cookie = "";
      vi.stubGlobal("location", { origin });
      vi.stubGlobal(
        "fetch",
        async (input: string | URL | Request, init: RequestInit = {}) => {
          const url = new URL(
            input instanceof Request ? input.url : input,
            origin,
          );
          if (url.origin !== origin)
            throw new Error("Fixture request escaped loopback");
          const headers = new Headers(init.headers);
          headers.set("Origin", origin);
          if (cookie) headers.set("Cookie", cookie);
          const response = await nativeFetch(url, { ...init, headers });
          const grant = response.headers.get("set-cookie");
          if (grant) cookie = grant.split(";")[0]!;
          return response;
        },
      );
      // Only an ephemeral synthetic maintenance grant is held in memory.
      await (await fetch(origin)).arrayBuffer();
      const api = new ApiClient("maintenance");
      await api.connect(new AbortController().signal);
      const ref = {
        result_id: String(result.result_id),
        content_sha256: String(result.content_sha256),
      };
      expect(
        (await readProcessorResult(api, ref, new AbortController().signal))
          .outcomes,
      ).toEqual({ with_result: 1, empty: 0, incomplete: 0 });
      const raw = new DatabaseSync(join(e.home, "catalog.sqlite"));
      try {
        const marker = raw
          .prepare(
            "SELECT method_revision FROM processor_result_summaries WHERE result_id=?",
          )
          .get(ref.result_id)!;
        raw
          .prepare(
            "UPDATE processor_result_summaries SET method_revision=NULL WHERE result_id=?",
          )
          .run(ref.result_id);
        const old = await readProcessorResult(
          api,
          ref,
          new AbortController().signal,
        );
        expect(old.freshness.state).toBe("stale");
        expect(old.outcomes).toBeNull();
        raw
          .prepare(
            "UPDATE processor_result_summaries SET method_revision=? WHERE result_id=?",
          )
          .run(marker.method_revision!, ref.result_id);
      } finally {
        raw.close();
      }
      const id = e.parseRequest.literature_id;
      const root = parseFolderNode(
        await manageFolder(api, {
          operation: "create",
          request: { name: "Research" },
        }),
      );
      const child = parseFolderNode(
        await manageFolder(api, {
          operation: "create",
          request: { name: "Selected", parent_id: root.folder_id },
        }),
      );
      const first = parseFolderNode(
        await manageFolder(api, {
          operation: "create",
          request: { name: "First", parent_id: root.folder_id, position: 0 },
        }),
      );
      const children = async () =>
        (await listFolders(api)).items
          .filter((f) => f.parent_id === root.folder_id)
          .map((f) => [f.name, f.position]);
      expect(await children()).toEqual([
        ["First", 0],
        ["Selected", 1],
      ]);
      await manageFolder(api, {
        operation: "move",
        request: {
          folder_id: child.folder_id,
          parent_id: root.folder_id,
          position: 0,
        },
      });
      expect(await children()).toEqual([
        ["Selected", 0],
        ["First", 1],
      ]);
      await manageFolder(api, {
        operation: "move",
        request: { folder_id: first.folder_id, parent_id: null, position: 0 },
      });
      expect(await children()).toEqual([["Selected", 0]]);
      expect(
        await manageFolder(api, {
          operation: "add",
          request: { folder_id: child.folder_id, literature_ids: [id] },
        }),
      ).toEqual({ folder_id: child.folder_id, changed: 1, changed_ids: [id] });
      expect(
        await manageFolder(api, {
          operation: "add",
          request: { folder_id: child.folder_id, literature_ids: [id] },
        }),
      ).toEqual({ folder_id: child.folder_id, changed: 0, changed_ids: [] });
      const query = parseLibrarySearchRequest({
        query: { folder: { id: root.folder_id, include_descendants: true } },
      }).query;
      expect(await readLibraryCounts(api, query)).toMatchObject({
        total: 1,
        recently_opened: 0,
        statuses: { READY: 1 },
      });
      const page = await searchLibrary(api, query, "intake-desc", null);
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        folder_ids: [child.folder_id],
        last_opened_at: null,
      });
      expect((await readLiterature(api, id)).last_opened_at).toBeNull();
      const opened = await recordReadingOpen(api, id);
      expect(opened.open_count).toBe(1);
      await readLiterature(api, id);
      expect((await readLibraryCounts(api, query)).recently_opened).toBe(1);
      expect((await recordReadingOpen(api, id)).open_count).toBe(2);
      const recent = await searchLibrary(
        api,
        { ...query, recently_opened: true },
        "opened-desc",
        null,
      );
      expect(recent.items.map((i) => i.literature.literature_id)).toEqual([id]);
      const snapshot = await createSnapshot(api, {
        kind: "query",
        query,
        name: "Selected research",
      });
      expect(snapshot.name_source).toBe("manual");
      expect(snapshot.member_count).toBe(1);
      expect(
        (
          await renameSnapshot(api, {
            snapshot_id: snapshot.snapshot_id,
            name: "",
          })
        ).name_source,
      ).toBe("generated");
      expect((await listSnapshots(api)).items[0]!.content_sha256).toBe(
        snapshot.content_sha256,
      );
      expect(
        (await readSnapshot(api, snapshot.snapshot_id)).members,
      ).toHaveLength(1);
      const status = await readReadingStatus(api, e.parseRequest.asset_id);
      expect(status.blocks.parser).toBeGreaterThan(0);
      expect(status.total_pages).toBeGreaterThan(0);
      expect(status.last_manual_edit).toBeNull();
      const request = { asset_id: e.parseRequest.asset_id };
      const path = join(e.home, "reading-status-request.json");
      await writeFile(path, JSON.stringify(request));
      const cli = await runCli(
        ["literature", "reading-status", "--request", path, "--json"],
        { home: e.home, stdout: () => {}, stderr: () => {} },
      );
      expect(cli.code).toBe(0);
      expect(cli.value).toEqual({ protocol_version: 1, result: status });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.connect(a);
      await client.connect(b);
      const tool = await client.callTool({
        name: "reading_status",
        arguments: request,
      });
      expect(tool.isError).not.toBe(true);
      expect(
        parseReadingStatus(
          (tool.structuredContent as { result: unknown }).result,
        ),
      ).toEqual(status);
      const trace = await traces.start({
        session_id: "round-two-visible",
        role: "analysis",
        provider: "fixture",
        model: "fake",
        context: { actor: "cli:synthetic" },
        subject: {},
      });
      trace.event("user/message", {
        event_type: "user/message",
        sequence: 8,
        timestamp: "2026-10-22T00:00:00.000Z",
        role: "user",
        text: "Read\n  this.",
        tool_calls: [],
        tool_results: [],
        images_omitted: 0,
        truncated: false,
      });
      await trace.flush();
      const log = await readAgentConversation(api, "round-two-visible");
      expect(log?.session.actor_label).toBe("命令行 · synthetic");
      expect(log?.events[0]!.message).toMatchObject({
        text: "Read\n  this.",
        sequence: 8,
      });
      expect(log?.last_sequence).not.toBe(8);
      expect(
        (
          await readAgentConversation(
            api,
            "round-two-visible",
            log!.last_sequence,
          )
        )?.events,
      ).toEqual([]);
      await trace.finish("completed");
      const impact = await previewFolderDeletion(api, root.folder_id);
      expect(impact).toMatchObject({ folder_count: 2, literature_count: 1 });
      expect(
        await manageFolder(api, {
          operation: "delete",
          request: { folder_id: root.folder_id },
        }),
      ).toEqual(impact);
      expect((await readLiterature(api, id)).folder_ids).toEqual([]);
      expect(e.modelCalls).toBe(calls);
      expect(e.parseCalls).toBe(parses);
    } finally {
      vi.unstubAllGlobals();
      await client.close();
      await mcp.close();
      await web?.close();
      await q?.close();
      await traces.close();
      await e.close();
    }
  },
);
