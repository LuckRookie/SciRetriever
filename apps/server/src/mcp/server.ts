import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createInputManifest,
  parseLiteratureId,
  ContractValidationError,
  type InputManifestItem,
  type DocumentReadOperation,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
  type Application,
  type QueryApplication,
} from "../bootstrap/application.js";
import { fixedConfigurationHome } from "../configuration/owner.js";
import { QUERY_TOOLS, MAINTENANCE_TOOLS } from "./tools.js";

export interface McpOptions {
  readonly maintenance?: boolean;
  /** Internal isolation seam; the ordinary command always uses the configuration owner's fixed home. */
  readonly home?: string;
  readonly applicationFactory?: () => Promise<Application>;
  readonly queryFactory?: () => Promise<QueryApplication>;
}
function unavailable(): never {
  throw Object.assign(new Error("capability unavailable"), {
    code: "capability-unavailable",
  });
}
function result(value: unknown): CallToolResult {
  const structuredContent = { protocol_version: 1, result: value };
  const text = JSON.stringify(structuredContent);
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw Object.assign(new Error("response too large"), {
      code: "response-budget",
    });
  return { content: [{ type: "text", text }], structuredContent };
}
/** Only protocol adaptation lives here. All operations go through the production Application. */
export function createMcpServer(options: McpOptions = {}) {
  const server = new Server(
    { name: "sciretriever", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const tools = [
    ...QUERY_TOOLS,
    ...(options.maintenance ? MAINTENANCE_TOOLS : []),
  ];
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  const validators = new Map(
    tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
  );
  let app: Promise<Application> | undefined;
  let query: Promise<QueryApplication> | undefined;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const stop = new AbortController();
  const application = () => {
    if (!options.maintenance || stop.signal.aborted) unavailable();
    app ??= (
      options.applicationFactory ??
      (() =>
        createApplication(options.home ?? fixedConfigurationHome(), {
          executionSchema: "require-v2",
        }))
    )();
    return app;
  };
  const reading = () => {
    if (stop.signal.aborted) unavailable();
    query ??= (
      options.queryFactory ??
      (() => createQueryApplication(options.home ?? fixedConfigurationHome()))
    )();
    return query;
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (name === "submit_processing") {
      const a = await application();
      if (!a.processingTasks) unavailable();
      const job = await a.processingTasks.submit(args);
      a.processingTasks.start(job.job_id);
      return { job_id: job.job_id, status: job.status };
    }
    if (name === "acquire_pdf") {
      const a = await application();
      if (!a.jobService || !a.processingTasks) unavailable();
      const job = await a.jobService.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: (args.literature_ids as string[]).map(
            parseLiteratureId,
          ),
        },
        goal: "pdf",
        policy_version: "mcp-pdf-v1",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: args.idempotency_key as string,
      });
      a.processingTasks.start(job.job_id);
      return { job_id: job.job_id, status: job.status };
    }
    if (name === "discover_metadata") {
      const a = await application();
      return a.discovery.run({
        query: args.query as string,
        year_from: args.year_from as number | null,
        year_to: args.year_to as number | null,
        providers: args.providers as {
          provider_name: string;
          scan_limit: number;
        }[],
        signal,
      });
    }
    if (name === "control_task") {
      const a = await application();
      if (!a.processingTasks) unavailable();
      const id = args.job_id as string;
      if (args.action !== "run")
        await a.processingTasks.control(
          id,
          args.action as "pause" | "cancel" | "resume" | "retry",
        );
      if (["run", "resume", "retry"].includes(String(args.action)))
        a.processingTasks.start(id);
      return a.processingTasks.read(id);
    }
    const q = await reading();
    if (name === "status") return q.readiness;
    if (q.readiness.status !== "ready" || !q.query) unavailable();
    switch (name) {
      case "search_library":
        return q.query.search({
          query: { text: args.text },
          limit: args.limit,
          cursor: args.cursor,
          sort: args.text ? "relevance" : "publication-year-desc",
        });
      case "read_literature":
        return q.query.detail(args.literature_id);
      case "read_task":
        if (!q.taskRead) unavailable();
        return q.taskRead(args.job_id as string);
      case "read_article_identity":
        if (!q.articleIdentityRead) unavailable();
        return q.articleIdentityRead(args.assessment_id as string);
      case "document_read": {
        if (!q.documentRead) unavailable();
        const operation = args.operation as DocumentReadOperation;
        switch (operation) {
          case "default":
            return q.documentRead.default(args.request, signal);
          case "describe":
            return q.documentRead.describe(args.request, signal);
          case "outline":
            return q.documentRead.outline(args.request, signal);
          case "segments":
            return q.documentRead.segments(args.request, signal);
          case "slice":
            return q.documentRead.slice(args.request, signal);
          case "resources":
            return q.documentRead.resources(args.request, signal);
          case "resource":
            return q.documentRead.resource(args.request, signal);
          case "evidence":
            return q.documentRead.resolveEvidence(args.request, signal);
          case "material":
            return q.documentRead.materialEvidence(args.request, signal);
        }
        return unavailable();
      }
      case "prepare_analysis_inputs": {
        if (!q.documentRead) unavailable();
        const items: InputManifestItem[] = [];
        const identities = [];
        for (const [i, id] of (args.literature_ids as string[]).entries()) {
          if (signal.aborted)
            throw Object.assign(new Error("cancelled"), {
              code: "operation-cancelled",
            });
          const detail = await q.query.detail(id);
          const asset = detail.primary_pdf?.asset;
          identities.push({
            literature_id: id,
            metadata_revision: detail.metadata_revision,
            metadata_sha256: detail.metadata_sha256,
          });
          if (!asset) {
            items.push({
              input_id: `paper-${i + 1}`,
              literature_id: id,
              material: null,
              document: null,
              capabilities: [],
              gaps: ["material-missing"],
            });
            continue;
          }
          const current = await q.documentRead.default(
            {
              literature_id: id,
              asset_id: asset.asset_id,
              asset_sha256: asset.sha256,
            },
            signal,
          );
          const described = current.default
            ? await q.documentRead.describe(
                { document_version_id: current.default.document_version_id },
                signal,
              )
            : null;
          items.push({
            input_id: `paper-${i + 1}`,
            literature_id: id,
            material: current.material,
            document: described?.document ?? null,
            capabilities: described
              ? [
                  "material-file-v1",
                  "document-segment-v1",
                  "document-text-v1",
                  "document-outline-v1",
                  "document-resources-v1",
                ]
              : ["material-file-v1"],
            gaps: described ? [] : ["document-missing"],
          });
        }
        return { input: await createInputManifest(items), identities };
      }
      case "prepare_synthesis":
        if (!q.synthesisPreparation) unavailable();
        return q.synthesisPreparation.prepare(args.request, signal);
      case "read_knowledge": {
        if (args.kind === "synthesis") {
          if (!q.synthesisRead) unavailable();
          return q.synthesisRead.byId(args.artifact_id as string, signal);
        }
        if (!q.knowledgeRead) unavailable();
        return q.knowledgeRead.byId(args.artifact_id as string, signal);
      }
      case "search_context":
        if (args.kind === "knowledge") {
          if (!q.knowledgeContext) unavailable();
          return q.knowledgeContext.search(args.request, signal);
        }
        if (!q.context) unavailable();
        return q.context.search(args.request, signal);
      default:
        return unavailable();
    }
  };
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const execute = async (): Promise<CallToolResult> => {
      try {
        if (stop.signal.aborted) unavailable();
        const args = request.params.arguments ?? {};
        if (
          Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024 ||
          !validators.get(request.params.name)?.(args)
        )
          throw Object.assign(new Error("invalid request"), {
            code: "invalid-request",
          });
        return result(
          await call(
            request.params.name,
            args,
            AbortSignal.any([extra.signal, stop.signal]),
          ),
        );
      } catch (error) {
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[a-z][a-z0-9-]{1,95}$/u.test(error.code)
            ? error.code
            : error instanceof TypeError ||
                error instanceof ContractValidationError
              ? "invalid-request"
              : "operation-failed";
        return {
          isError: true,
          ...result({
            failure: {
              code,
              message:
                "The requested operation could not complete. Inspect readiness, fixed inputs or the durable task result.",
            },
          }),
        };
      }
    };
    const pending = execute();
    active.add(pending);
    try {
      return await pending;
    } finally {
      active.delete(pending);
    }
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      stop.abort();
      await Promise.allSettled([...active]);
      const opened = await Promise.allSettled([app, query]);
      const failures: unknown[] = [];
      for (const value of opened)
        if (value.status === "fulfilled" && value.value) {
          try {
            await value.value.close();
          } catch (error) {
            failures.push(error);
          }
        }
      await server.close();
      if (failures.length)
        throw new AggregateError(failures, "MCP cleanup failed");
    })();
    return closing;
  };
  return {
    server,
    connect: (transport: Transport) => server.connect(transport),
    close,
  };
}

export async function runMcpStdio(
  options: McpOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const host = createMcpServer(options);
  const transport = new StdioServerTransport();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => finish();
  host.server.onclose = stop;
  process.stdin.once("end", stop);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await host.connect(transport);
    if (signal?.aborted) finish();
    await done;
  } finally {
    process.stdin.removeListener("end", stop);
    signal?.removeEventListener("abort", stop);
    await host.close();
  }
}
