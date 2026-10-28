import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseMetadataObservation,
  parseSourceStatistics,
  parseTaskSourceResults,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import * as applicationBootstrap from "../src/bootstrap/application.js";
import { createTaskReader } from "../src/entry/task-read.js";
import { runMetadataTask } from "../src/entry/metadata-task.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { networkRequestDispatched } from "../src/network/request-activity.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
it("reads identical metadata task summaries and source statistics over HTTP, CLI and MCP without reopening a provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-parity-"));
  const open = vi.fn(() => {
    let delivered = false;
    return {
      pull_raw_item() {
        networkRequestDispatched();
        if (delivered) return null;
        delivered = true;
        return { raw_item: null, source_exhausted_after: true };
      },
      convert_raw_item() {
        return {
          observations: [
            parseMetadataObservation({
              source_type: null,
              source_type_mapping_version: null,
              observation_id: randomUUID(),
              provenance: {
                provenance_id: randomUUID(),
                source_kind: "metadata-provider",
                source_name: "crossref",
                source_record_id: "synthetic",
                observed_at: new Date().toISOString(),
                input_sha256: "a".repeat(64),
                parameters_sha256: null,
              },
              metadata: FIXTURE_LITERATURE.metadata,
              version_role: "published",
              version_links: [],
              declared_keywords: [],
              reference_texts: [],
              reference_count: null,
              cited_by_count: null,
              asset_hints: [],
            }),
          ],
          relations: [],
        };
      },
    };
  });
  const app = await createApplication(home, {
    metadata: {
      topic_search_ports: [
        { provider_name: "crossref", open_topic_search: open },
      ],
      lookup_ports: [{ provider_name: "crossref", open_lookup: open }],
    },
  });
  const query = await createQueryApplication(home);
  const web = await startQueryOnlyHttp({ application: query });
  const applicationFactory = vi.fn(async () => app);
  const host = createMcpServer({
    maintenance: true,
    queryFactory: () => createQueryApplication(home),
    applicationFactory,
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "source-parity", version: "1" });
  const input = async function* (value: unknown) {
    yield Buffer.from(JSON.stringify(value));
  };
  const http = async (operation: string, request: unknown) => {
    const res = await fetch(web.origin + "/api/v1/query/" + operation, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol_version: 1, request }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: unknown }).result;
  };
  const cli = async (args: string[], request: unknown) => {
    const res = await runCli([...args, "--request", "-", "--json"], {
      home,
      stdin: input(request),
    });
    expect(res.code).toBe(0);
    return (res.value as { result: unknown }).result;
  };
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError, JSON.stringify(res)).not.toBe(true);
    return (res.structuredContent as { result: unknown }).result;
  };
  try {
    await host.connect(serverTransport);
    await client.connect(clientTransport);
    const job = await runMetadataTask(app, {
      kind: "topic",
      query: "synthetic",
      year_from: null,
      year_to: null,
    });
    const expected = parseTaskSourceResults(
      (await createTaskReader(app.jobs!).read(job.job_id)).source_results,
    );
    const args = { job_id: job.job_id };
    for (const raw of [
      await http("task-run", args),
      await cli(["jobs", "progress"], args),
      await mcp("task_run", args),
      await mcp("read_task", args),
      await mcp("inspect_task", args),
    ])
      expect(
        parseTaskSourceResults(
          (raw as { source_results: unknown }).source_results,
        ),
      ).toEqual(expected);
    const records = [];
    for (const raw of [
      await http("source-statistics", { range: "all" }),
      await cli(["sources", "statistics"], { range: "all" }),
      await mcp("source_statistics", { range: "all" }),
    ]) {
      const { as_of, ...rest } = parseSourceStatistics(raw);
      expect(Date.parse(as_of)).not.toBeNaN();
      records.push(rest);
    }
    expect(records[1]).toEqual(records[0]);
    expect(records[2]).toEqual(records[0]);
    expect(applicationFactory).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(expected)).not.toMatch(
      /https|authorization|cookie|headers|token/,
    );
    expect(
      (await http("source-statistics", { range: "last-30-days" })) as unknown,
    ).toMatchObject({ history: "recorded-only" });
    const discovered = await mcp("discover_metadata", {
      query: "synthetic",
      year_from: null,
      year_to: null,
      providers: [{ provider_name: "crossref", scan_limit: 2 }],
    });
    expect(discovered).toMatchObject({
      job_id: expect.any(String),
      source_summary: { metadata: { returned: 1, merged: 1 } },
    });
    const literatureId = (
      await app.database.findLiteratureByIdentifiers(
        FIXTURE_LITERATURE.metadata.identifiers,
      )
    )[0]!.literature_id;
    const lookedUp = await mcp("lookup_metadata", {
      literature_ids: [literatureId],
      scan_limit: 2,
    });
    expect(lookedUp).toMatchObject({
      source_summary: {
        metadata: {
          records: [{ purpose: "lookup", requested: true, result: "hit" }],
        },
      },
    });
    const boot = vi
      .spyOn(applicationBootstrap, "createApplication")
      .mockResolvedValueOnce(app);
    try {
      const reply = await runCli(
        ["metadata", "lookup", literatureId, "--scan-limit", "2", "--json"],
        { home },
      );
      expect(reply.code).toBe(0);
      expect(reply.value).toMatchObject({
        job_id: expect.any(String),
        source_summary: {
          metadata: {
            records: [{ purpose: "lookup", requested: true, result: "hit" }],
          },
        },
      });
    } finally {
      boot.mockRestore();
    }
  } finally {
    await client.close();
    await host.close();
    await web.close();
    await query.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
