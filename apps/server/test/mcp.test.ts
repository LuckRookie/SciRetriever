import { citationLimitsSource } from "./citation-limits-fixture.js";
import { ParsingFailure } from "../src/parsing/ports.js";
import { processorFixture } from "./processor-fixture.js";
import { FIXTURE_DOI } from "../src/workbench/synthetic-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import {
  libraryFullTextFixture,
  fullTextCatalogRows,
  FULL_TEXT_GLOBAL_EXPECTED,
} from "./library-fulltext-fixture.js";

async function connected(host: ReturnType<typeof createMcpServer>) {
  const [server, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-client", version: "1" });
  await host.connect(server);
  await client.connect(transport);
  return client;
}
it("keeps previously requested work queued when its session-scoped MCP Application opens and closes", async () => {
  const env = await coreProcessingFixture({
    offline: true,
    analysisModel: false,
  });
  let host: ReturnType<typeof createMcpServer> | undefined;
  let client: Client | undefined;
  try {
    const job = await env.app.jobService!.create({
      target_kind: "selector",
      selector: {
        kind: "literatures",
        literature_ids: [env.parseRequest.literature_id],
      },
      goal: "pdf",
      policy_version: "mcp-no-restore",
      policy: { mode: "never", max_retries: 0 },
      idempotency_key: "mcp-no-restore",
    });
    await env.app.jobs!.requestStart(job.job_id);
    const target = (await env.app.jobs!.listTargets(job.job_id))[0]!;
    await env.app.close();
    host = createMcpServer({
      home: env.home,
      maintenance: true,
    });
    client = await connected(host);
    // This saves a separate job and constructs the real MCP-owned Application.
    // Both PDF targets already have a primary PDF; no provider is called.
    const saved = await client.callTool({
      name: "create_task",
      arguments: {
        request: {
          kind: "acquire-pdf",
          idempotency_key: "mcp-unstarted-sibling",
          selector: {
            kind: "literatures",
            literature_ids: [env.parseRequest.literature_id],
          },
        },
      },
    });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    const state = await client.callTool({
      name: "read_task",
      arguments: { job_id: job.job_id },
    });
    expect(state.isError, JSON.stringify(state)).not.toBe(true);
    expect(state.structuredContent).toMatchObject({
      result: { job: { status: "queued" }, start_requested: true },
    });
    await client.close();
    await host.close();
    await env.reopen();
    expect((await env.app.jobs!.getJob(job.job_id))?.status).toBe("queued");
    expect(await env.app.jobs!.listAttempts(target.target_id)).toEqual([]);
    expect(env.parseCalls).toBe(0);
    expect(env.modelCalls).toBe(0);
  } finally {
    await client?.close();
    await host?.close();
    await env.close();
  }
});

it("reads durable start requests through task lists and both task detail tools", async () => {
  const env = await coreProcessingFixture({
    offline: true,
    analysisModel: false,
  });
  const host = createMcpServer({
    maintenance: true,
    applicationFactory: async () => env.app,
    queryFactory: () => createQueryApplication(env.home),
  });
  const client = await connected(host);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return (response.structuredContent as { result: Record<string, unknown> })
      .result;
  };
  try {
    const job = await env.app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: "mcp-start-marker",
      operations: [
        { operation: "parse-documents", request: env.rawParseRequest },
      ],
    });
    for (const tool of ["read_task", "inspect_task"])
      expect(await call(tool, { job_id: job.job_id })).toMatchObject({
        start_requested: false,
      });
    expect(await call("list_tasks", {})).toMatchObject({
      tasks: [{ job_id: job.job_id, start_requested: false }],
    });
    expect(
      await call("control_task", { job_id: job.job_id, action: "run" }),
    ).toMatchObject({ start_requested: true });
    await vi.waitFor(
      async () =>
        expect(
          (await env.app.processingTasks!.read(job.job_id)).job.status,
        ).toBe("completed"),
      { timeout: 20_000 },
    );
    for (const tool of ["read_task", "inspect_task"])
      expect(await call(tool, { job_id: job.job_id })).toMatchObject({
        start_requested: true,
      });
    expect(await call("list_tasks", {})).toMatchObject({
      tasks: [{ job_id: job.job_id, start_requested: true }],
    });
    expect(
      (await env.app.jobs!.listEvents(job.job_id)).filter(
        (e) => e.kind === "task-start-requested",
      ),
    ).toMatchObject([{ payload: { actor: expect.stringMatching(/^mcp:/u) } }]);
  } finally {
    await client.close();
    await host.close();
    await env.close();
  }
});

it("expands citations to source exhaustion with nullable run budgets and optional tool limits", async () => {
  const source = citationLimitsSource();
  const env = await coreProcessingFixture({
    offline: true,
    analysisModel: false,
    metadata: { reference_query_ports: [source.port] },
  });
  const host = createMcpServer({
    home: env.home,
    maintenance: true,
    applicationFactory: async () => env.app,
  });
  const client = await connected(host);
  try {
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "discover_citations",
    )!;
    const schema = tool.inputSchema as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toEqual(["seed_literature_id", "direction"]);
    expect(schema.properties.max_depth).toMatchObject({ default: 1 });
    for (const name of ["scan_limit", "result_limit"])
      expect(schema.properties[name]).not.toHaveProperty("default");
    const response = await client.callTool({
      name: "discover_citations",
      arguments: {
        seed_literature_id: env.parseRequest.literature_id,
        direction: "references",
      },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const report = (
      response.structuredContent as {
        result: {
          discovery_run_id: string;
          job_id: string;
          result_count: number;
        };
      }
    ).result;
    expect(report.result_count).toBe(source.count);
    expect(source.stats).toEqual({
      opens: 1,
      pulls: source.count + 1,
      exhausted: 1,
    });
    expect(
      await env.app.database.getDiscovery(report.discovery_run_id),
    ).toMatchObject({
      run: { max_depth: 1, result_limit: null },
      providers: [{ provider_name: "crossref", scan_limit: null }],
      source_results: [{ outcome: "EXHAUSTED" }],
    });
    const read = await client.callTool({
      name: "read_task",
      arguments: { job_id: report.job_id },
    });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      result: {
        job: {
          selector: {
            request: {
              operations: [
                {
                  request: {
                    max_depth: 1,
                    result_limit: null,
                    providers: [{ scan_limit: null }],
                  },
                },
              ],
            },
          },
        },
      },
    });
  } finally {
    await client.close();
    await host.close();
    await env.close();
  }
});

it("accepts large metadata budgets in tool definitions and rejects unsafe integers before durable submission", async () => {
  const open = vi.fn(() => ({
    pull_raw_item: () => null,
    convert_raw_item: () => ({ observations: [], relations: [] }),
  }));
  const env = await coreProcessingFixture({
    offline: true,
    analysisModel: false,
    metadata: {
      topic_search_ports: [
        { provider_name: "crossref", open_topic_search: open },
      ],
      lookup_ports: [{ provider_name: "crossref", open_lookup: open }],
      reference_query_ports: [
        { provider_name: "crossref", open_reference_query: open },
      ],
    },
  });
  const host = createMcpServer({
    home: env.home,
    maintenance: true,
    applicationFactory: async () => env.app,
  });
  const client = await connected(host);
  try {
    const definitions = (await client.listTools()).tools;
    const ajv = new Ajv2020({ strict: false });
    const cases = [
      {
        name: "discover_metadata",
        input: {
          query: "synthetic",
          year_from: null,
          year_to: null,
          providers: [{ provider_name: "crossref", scan_limit: 50000 }],
        },
      },
      {
        name: "lookup_metadata",
        input: {
          literature_ids: [env.parseRequest.literature_id],
          scan_limit: 50000,
        },
      },
      {
        name: "discover_citations",
        input: {
          seed_literature_id: env.parseRequest.literature_id,
          direction: "references",
          result_limit: 50000,
          scan_limit: 50000,
        },
      },
    ];
    for (const { name, input } of cases) {
      const definition = definitions.find((tool) => tool.name === name)!;
      expect(ajv.compile(definition.inputSchema)(input)).toBe(true);
      const response = await client.callTool({ name, arguments: input });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const { job_id } = (
        response.structuredContent as { result: { job_id: string } }
      ).result;
      expect((await env.app.jobs!.getJob(job_id))!.selector).toMatchObject({
        request: {
          operations: [
            {
              operation: "acquire-metadata",
              request: {
                providers: [{ source: "crossref", scan_limit: 50000 }],
                ...(name === "discover_citations"
                  ? { result_limit: 50000 }
                  : {}),
              },
            },
          ],
        },
      });
    }
    const citation = {
      kind: "citation",
      seed_literature_ids: [env.parseRequest.literature_id],
      direction: "both",
      max_depth: 1,
      result_limit: 50000,
      providers: [{ source: "crossref", scan_limit: 50000 }],
    };
    const saved = await client.callTool({
      name: "create_task",
      arguments: {
        request: {
          kind: "metadata",
          idempotency_key: "large-citation-budget",
          request: citation,
        },
      },
    });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    const { job_id } = (
      saved.structuredContent as { result: { job_id: string } }
    ).result;
    expect((await env.app.jobs!.getJob(job_id))!.selector).toMatchObject({
      request: { operations: [{ request: citation }] },
    });
    const submit = vi.spyOn(env.app.processingTasks!, "submit");
    const opened = open.mock.calls.length;
    try {
      for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        for (const { name, input } of cases) {
          const response = await client.callTool({
            name,
            arguments:
              name === "discover_metadata"
                ? {
                    ...input,
                    providers: [
                      { provider_name: "crossref", scan_limit: limit },
                    ],
                  }
                : { ...input, scan_limit: limit },
          });
          expect(response.isError).toBe(true);
          expect(response.structuredContent).toMatchObject({
            result: {
              failure: {
                code:
                  limit > Number.MAX_SAFE_INTEGER
                    ? "invalid-contract"
                    : "invalid-request",
              },
            },
          });
        }
        const response = await client.callTool({
          name: "create_task",
          arguments: {
            request: {
              kind: "metadata",
              idempotency_key: "invalid-citation-budget",
              request: { ...citation, result_limit: limit },
            },
          },
        });
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toMatchObject({
          result: { failure: { code: "invalid-contract" } },
        });
      }
      expect(submit).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(opened);
    } finally {
      submit.mockRestore();
    }
    expect(env.parseCalls).toBe(0);
    expect(env.modelCalls).toBe(0);
  } finally {
    await client.close();
    await host.close();
    await env.close();
  }
});
it("exposes paper full_text and version with_primary_pdf in the read-only library_counts tool", async () => {
  const f = await libraryFullTextFixture(),
    host = createMcpServer({ home: f.home }),
    client = await connected(host);
  try {
    const before = fullTextCatalogRows(f.home);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "library_counts",
    )!;
    expect(tool.description).toContain("counts papers (MetaLiterature)");
    expect(tool.description).toContain("with_primary_pdf count versions");
    const result = await client.callTool({
      name: "library_counts",
      arguments: { query: {} },
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { result: unknown }).result).toEqual(
      FULL_TEXT_GLOBAL_EXPECTED,
    );
    expect(f.modelCalls).toBe(0);
    expect(fullTextCatalogRows(f.home)).toEqual(before);
  } finally {
    await client.close();
    await host.close();
    await f.close();
  }
});

describe("formal MCP product adapter", () => {
  // Reached 2.6 s under Full (36/12) load, too close to the 5 s default.
  it("exposes a failed raw parsing attempt and completes the same task after repair and explicit retry", async () => {
    const env = await coreProcessingFixture({ analysisModel: false });
    env.setParseHook(async () => {
      throw new ParsingFailure("parser-unavailable");
    });
    const host = createMcpServer({
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connected(host);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      const job = await env.app.jobService!.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: [env.parseRequest.literature_id],
        },
        goal: "parser",
        policy_version: "fixture",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "raw-parser-failure",
      });
      await env.app.taskService!.runJob(job.job_id);
      const failure = {
        failure: {
          code: "completion-parsing-failed",
          reason: expect.any(String),
          action: expect.any(String),
        },
      };
      expect(await call("read_task", { job_id: job.job_id })).toMatchObject({
        job: { status: "completed" },
        targets: [{ stage: "skipped" }],
        skipped: [failure],
        failures: [failure],
      });
      expect(env.parseCalls).toBe(1);
      const detail = await env.app.library.detail(
        env.parseRequest.literature_id,
      );
      env.setText(
        `# ${detail.literature.metadata.title}\n\nThe fixture studies spectroscopy.\n\n# References\n\n1. Fixture reference.\n`,
      );
      env.setParseHook(async () => {});
      await env.reopen();
      await call("control_task", { job_id: job.job_id, action: "retry" });
      // Retry is accepted before its durable task finishes. Use the same
      // asynchronous completion budget as the other MCP task tests.
      await vi.waitFor(
        async () => {
          const state = await env.app.processingTasks!.read(job.job_id);
          expect(state.targets[0]?.stage, JSON.stringify(state)).toBe(
            "completed",
          );
          expect(state.job.status).toBe("completed");
        },
        { timeout: 20_000 },
      );
      const target = (await env.app.jobs!.listTargets(job.job_id))[0]!;
      expect(await env.app.jobs!.listAttempts(target.target_id)).toHaveLength(
        2,
      );
      expect(
        await env.app.library.detail(env.parseRequest.literature_id),
      ).not.toHaveProperty("content");
      expect(await call("read_task", { job_id: job.job_id })).toMatchObject({
        job: { status: "completed" },
        targets: [{ stage: "completed" }],
        failures: [failure],
      });
      expect(env.parseCalls).toBe(2);
      expect(env.modelCalls).toBe(0);
      expect(
        (
          await client.callTool({
            name: "control_task",
            arguments: { job_id: job.job_id, action: "retry" },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  }, 30000);
  it("uses the real protocol client and production graph for parse, identity, summary and snapshot synthesis", async () => {
    const env = await processorFixture();
    env.setText(`# Article\nDOI: ${FIXTURE_DOI}\nA synthetic finding.`);
    const host = createMcpServer({
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connected(host);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    const wait = async (job: string) => {
      await vi.waitFor(
        async () =>
          expect((await env.app.processingTasks!.read(job)).job.status).toBe(
            "completed",
          ),
        { timeout: 20_000 },
      );
      return call("read_task", { job_id: job });
    };
    try {
      const parsed = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-parse",
        operations: [
          { operation: "parse-documents", request: env.rawParseRequest },
        ],
      });
      const parsedTask = await wait(String(parsed.job_id));
      expect(parsedTask.results).toHaveLength(1);
      expect(parsedTask.results).toMatchObject([
        {
          result: { draft: { status: "formed", default_text_level: "draft" } },
        },
      ]);
      expect(
        (
          await env.app.documentRead.default({
            literature_id: env.parseRequest.literature_id,
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
          })
        ).default,
      ).not.toBeNull();
      await env.build(env.parseRequest);
      const parseCalls = env.parseCalls;
      env.setModel((input) => {
        if (input.purpose)
          return {
            outcome: "completed",
            title: "Synthetic finding",
            statements: [
              {
                statement_id: "s1",
                category: "finding",
                epistemic: "reported",
                text: "A synthetic finding.",
                conditions: [],
                quantity: null,
                evidence_segment_ids: [input.segments![0]!.segment_id],
              },
            ],
          };
        if (Array.isArray(input.candidates))
          return {
            claims: [
              {
                text: "A synthetic synthesis.",
                source_ids: (input.candidates as { id: string }[]).map(
                  (c) => c.id,
                ),
              },
            ],
          };
        const segment = input.segments!.find((s) => s.text.includes("DOI:"))!;
        return {
          document_kind: "article",
          fields: [
            {
              field: "doi",
              value: FIXTURE_DOI,
              quote: `DOI: ${FIXTURE_DOI}`,
              segment_id: segment.segment_id,
            },
          ],
        };
      });
      const identity = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-identity",
        operations: [
          {
            operation: "assess-article-identity",
            request: await env.identityRequest(),
          },
        ],
      });
      await wait(String(identity.job_id));
      expect(
        await call("read_literature", {
          literature_id: env.parseRequest.literature_id,
        }),
      ).toMatchObject({
        primary_pdf: { article_identity_status: "match-supported" },
      });
      const run = async (
        key: string,
        processor: string,
        spec: object,
        inputs: object[],
      ) => {
        const submitted = await call("submit_processor", {
          request: {
            schema_version: 1,
            idempotency_key: key,
            name: key,
            processor: { id: processor, version: "2" },
            spec,
            inputs,
          },
        });
        const job = String(submitted.job_id);
        await wait(job);
        // Background work started here can outlast the 1 s poll default under Full load.
        await expect
          .poll(
            async () => (await env.app.processorRead!.collections(job)).length,
            { timeout: 20_000 },
          )
          .toBe(1);
        const collections = await env.app.processorRead!.collections(job);
        expect(collections).toHaveLength(1);
        const collection = (await env.app.processorRead!.collection(
          String(collections[0]!.collection_id),
        ))!;
        const ref = collection.members[0]!.result!;
        const saved = await call("processor_query", {
          action: "read",
          request: { result_id: ref.result_id },
        });
        expect(saved).toMatchObject({
          ref,
          result: {
            content: {
              kind: "report",
              claims: [{ sources: expect.any(Array) }],
            },
          },
        });
        return ref;
      };
      for (const purpose of ["overview", "detailed"])
        await run(`mcp-${purpose}`, "summary", { purpose, question: null }, [
          { kind: "literature", literature_id: env.parseRequest.literature_id },
        ]);
      const snapshot = await call("snapshot_create", {
        kind: "literatures",
        literature_ids: [env.parseRequest.literature_id],
      });
      const synthesis = await run(
        "mcp-synthesis",
        "knowledge-synthesis",
        { question: "What was found?", policy: "require-all" },
        [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      );
      const before = env.modelCalls;
      const evidence = await call("processor_query", {
        action: "evidence",
        request: {
          kind: "result",
          ...synthesis,
          record_id: "claim0",
          pointer: "/text",
        },
      });
      expect(evidence.evidence).not.toHaveLength(0);
      expect(env.modelCalls).toBe(before);
      expect(env.parseCalls).toBe(parseCalls);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  }, 60000);

  it("keeps query mode read-only and reports invalid calls without opening maintenance or leaking exception details", async () => {
    const env = await coreProcessingFixture();
    const maintenance = vi.fn(async () => env.app);
    const host = createMcpServer({
      applicationFactory: maintenance,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connected(host);
    try {
      const tools = (await client.listTools()).tools;
      const document = tools.find(
        (tool) => tool.name === "document_read",
      )!.description!;
      for (const word of [
        "text_level=draft|proofread",
        "draft_summary={differs_segments,differences,image_only_pages}",
        "text-layer-match|text-layer-differs|no-text-layer",
        "coverage_note",
        "draft-differences",
        "every continuation",
        "HTTP MCP /mcp with purpose read",
      ])
        expect(document).toContain(word);
      expect(tools.some((t) => t.name === "submit_processing")).toBe(false);
      const miss = await client.callTool({
        name: "search_library",
        arguments: { text: "No matching material", limit: 10, cursor: null },
      });
      expect(miss.isError).not.toBe(true);
      expect(maintenance).not.toHaveBeenCalled();
      expect(env.parseCalls).toBe(0);
      expect(env.modelCalls).toBe(0);
      expect(
        (await client.callTool({ name: "submit_processing", arguments: {} }))
          .isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: "read_literature",
            arguments: { literature_id: "invalid", secret: "never echo" },
          })
        ).isError,
      ).toBe(true);
      expect(maintenance).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  });
});
