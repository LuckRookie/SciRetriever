import { NetworkBudgetCoordinator } from "../network/budget.js";
import { withoutRestartAdmission } from "../application/restart-admission.js";
import {
  sourceConfiguration,
  SourceConfigurationError,
  sourceDetails,
} from "../configuration/sources.js";
import { closeSourceProbes } from "../configuration/source-probes.js";
import { withActivity, machineActor } from "../logging/activity.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ContractValidationError,
  parseLiteratureId,
} from "@sciretriever/contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createApplication,
  createQueryApplication,
  type Application,
  type QueryApplication,
} from "../bootstrap/application.js";
import {
  fixedConfigurationHome,
  TypeScriptConfigurationOwner,
  type ConfigurationProbeSeams,
} from "../configuration/owner.js";
import {
  executeConfiguration,
  type ConfigurationOperation,
} from "../entry/configuration-operations.js";
import {
  executeMaintenance,
  type MaintenanceOperation,
} from "../entry/maintenance-operations.js";
import {
  queryProcessors,
  submitProcessor,
} from "../entry/processor-operations.js";
import {
  executeQuery,
  ProductOperationError,
  type QueryOperation,
} from "../entry/query-operations.js";
import { ProcessorQueryError } from "../storage/processor-results.js";
import {
  MachineWorkbenchClient,
  workbenchOrigin,
  type WorkbenchOperation,
} from "../workbench/machine-client.js";
import { PdfUploads } from "./pdf-upload.js";
import { runMetadataTask } from "../entry/metadata-task.js";
import {
  BROWSER_MAINTENANCE_TOOLS,
  BROWSER_QUERY_TOOLS,
  MAINTENANCE_TOOLS,
  QUERY_TOOLS,
} from "./tools.js";

export interface McpOptions {
  /** Explicit local owner of live Browser sessions; no discovery through shared storage. */
  readonly workbenchUrl?: string;
  readonly maintenance?: boolean;
  readonly configurationOwner?: TypeScriptConfigurationOwner;
  readonly probeSeams?: ConfigurationProbeSeams;
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
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw Object.assign(new Error("response too large"), {
      code: "response-budget",
    });
  return { content: [{ type: "text", text }], structuredContent };
}
/** Only protocol adaptation lives here. All operations go through the production Application. */
export function createMcpServer(options: McpOptions = {}) {
  const browserOrigin = options.workbenchUrl
    ? workbenchOrigin(options.workbenchUrl)
    : null;
  let browser: MachineWorkbenchClient | undefined;
  const server = new Server(
    { name: "sciretriever", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const tools = [
    ...QUERY_TOOLS,
    ...(options.maintenance ? MAINTENANCE_TOOLS : []),
    ...(browserOrigin
      ? [
          ...BROWSER_QUERY_TOOLS,
          ...(options.maintenance ? BROWSER_MAINTENANCE_TOOLS : []),
        ]
      : []),
  ];
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  const validators = new Map(
    tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
  );
  const configurationOwner =
    options.configurationOwner ??
    new TypeScriptConfigurationOwner(options.home ?? fixedConfigurationHome());
  const configurationNetwork =
    options.probeSeams?.network ?? new NetworkBudgetCoordinator();
  let app: Promise<Application> | undefined;
  let query: Promise<QueryApplication> | undefined;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const stop = new AbortController();
  const uploads = new PdfUploads();
  const application = () => {
    if (!options.maintenance || stop.signal.aborted) unavailable();
    app ??= (
      options.applicationFactory ??
      (() =>
        createApplication(configurationOwner.home, {
          configurationOwner,
          networkBudget: configurationNetwork,
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
    if (name.startsWith("browser_") || name.startsWith("runtime_")) {
      if (!browserOrigin) unavailable();
      if (name === "browser_disconnect") {
        await browser?.close();
        browser = undefined;
        return { disconnected: true };
      }
      browser ??= new MachineWorkbenchClient(
        browserOrigin,
        options.maintenance,
      );
      const routes: Record<string, WorkbenchOperation> = {
        runtime_list_tasks: "task-list",
        runtime_read_task: "task-read",
        runtime_create_task: "task-create",
        runtime_control_task: "task-control",
      };
      const operation = Object.hasOwn(routes, name)
        ? routes[name]!
        : (name
            .slice("browser_".length)
            .replaceAll("_", "-") as WorkbenchOperation);
      return browser.execute(
        operation,
        name === "runtime_create_task" ? args.request : args,
        signal,
      );
    }
    if (
      [
        "begin_pdf_upload",
        "append_pdf_upload",
        "commit_pdf_upload",
        "discard_pdf_upload",
      ].includes(name)
    ) {
      if (!options.maintenance) unavailable();
      switch (name) {
        case "begin_pdf_upload":
          return uploads.begin(args);
        case "append_pdf_upload":
          return uploads.append(args);
        case "commit_pdf_upload":
          return uploads.commit(args, application, signal);
        case "discard_pdf_upload":
          return uploads.discard(args);
      }
    }
    const configurationRoutes: Readonly<
      Record<string, ConfigurationOperation>
    > = {
      configuration_read: "read",
      configuration_status: "status",
      configuration_preview: "preview",
      configuration_publish: "publish",
      configuration_credential: "credential",
      configuration_probe: "probe",
      configuration_sources: "sources",
      configuration_apply_state: "apply",
      configuration_apply: "apply",
      configuration_apply_cancel: "apply-cancel",
      configuration_source_save: "source-save",
      configuration_source_selection: "source-selection",
      configuration_source_test: "source-test",
      configuration_source_test_all: "source-test-all",
    };
    if (Object.hasOwn(configurationRoutes, name)) {
      if (
        !options.maintenance &&
        ![
          "configuration_read",
          "configuration_status",
          "configuration_preview",
          "configuration_sources",
          "configuration_apply_state",
        ].includes(name)
      )
        unavailable();
      if (name === "configuration_status" && app)
        return (await app).configurationStatus(signal);
      return executeConfiguration(
        configurationOwner,
        configurationRoutes[name]!,
        args,
        signal,
        { ...options.probeSeams, network: configurationNetwork },
      );
    }
    const maintenanceRoutes: Readonly<Record<string, MaintenanceOperation>> = {
      snapshot_create: "snapshots",
      snapshot_rename: "snapshot-rename",
      folders_manage: "folders",
      reading_open: "reading-open",
      archive_manage: "archive",
      archive_arrangement_edit: "archive-arrangement-edit",
      tags_manage: "tags",
      archive_references: "archive-references",
      metadata_edit: "metadata-edit",
      document_annotate: "document-annotate",
      document_role: "document-role",
      document_publish_proofread: "document-publish-proofread",
      proofread_save: "proofread-save",
      proofread_build: "proofread-build",
      proofread_decide: "proofread-decide",
      proofread_revoke: "proofread-revoke",
      import_bibliography: "import-bibliography",
      discover_citations: "discover",
      create_task: "task-create",
      resolve_intervention: "resolve-intervention",
      rebuild_index: "rebuild-index",
      create_extraction: "extraction-operation",
      read_extraction: "extraction-operation-read",
      submit_extraction: "extraction-submit",
      read_extraction_receipt: "extraction-receipt",
      close_extraction: "extraction-close",
      cancel_extraction: "extraction-cancel",
      cleanup_extractions: "extraction-cleanup",
    };
    if (Object.hasOwn(maintenanceRoutes, name)) {
      const a = await application();
      const input =
        name === "discover_citations"
          ? { kind: "citation", ...args }
          : ["folders_manage", "tags_manage", "archive_manage"].includes(name)
            ? args
            : Object.hasOwn(args, "request")
              ? args.request
              : args;
      return executeMaintenance(a, maintenanceRoutes[name]!, input, signal);
    }
    if (name === "processor_query")
      return queryProcessors(
        await reading(),
        String(args.action),
        args.request,
        signal,
      );
    if (name === "retain_extraction") {
      const a = await application();
      if (!a.processorRetention) unavailable();
      return a.processorRetention.retain(args.request, signal);
    }
    if (name === "submit_processor")
      return submitProcessor(await application(), args.request, true, signal);
    if (name === "rebuild_processor_index") {
      const a = await application();
      if (!a.processors) unavailable();
      return a.processors.rebuild(
        args.result_ids === null ? undefined : (args.result_ids as string[]),
      );
    }
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
    if (name === "lookup_metadata") {
      return runMetadataTask(
        await application(),
        {
          kind: "lookup",
          literature_ids: args.literature_ids,
          scan_limit: args.scan_limit,
        },
        signal,
      );
    }
    if (name === "discover_metadata") {
      const a = await application();
      return runMetadataTask(
        a,
        {
          kind: "topic",
          query: args.query as string,
          year_from: args.year_from as number | null,
          year_to: args.year_to as number | null,
          providers: (
            args.providers as {
              provider_name: string;
              scan_limit: number;
            }[]
          ).map((p) => ({ source: p.provider_name, scan_limit: p.scan_limit })),
        },
        signal,
      );
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
    if (name === "reading_status")
      return executeQuery(q, "reading-status", args, signal);
    if (name === "folders_query")
      return executeQuery(q, "folders", args, signal);
    if (name === "library_counts")
      return executeQuery(q, "library-counts", args, signal);
    if (name === "search_library")
      return executeQuery(
        q,
        "library-search",
        Object.hasOwn(args, "query")
          ? args
          : {
              query: { text: args.text },
              limit: args.limit,
              cursor: args.cursor,
              sort: args.text ? "relevance" : "intake-desc",
            },
        signal,
      );
    if (name === "snapshots_query")
      return executeQuery(q, "snapshots", args, signal);
    if (name === "archive_arrangement")
      return executeQuery(q, "archive-arrangement", args, signal);
    if (name === "archive_query")
      return executeQuery(q, "archive", args, signal);
    if (name === "tags_query") return executeQuery(q, "tags", args, signal);
    if (name === "metadata_fields")
      return executeQuery(q, "metadata-fields", args, signal);
    if (name === "document_annotation")
      return executeQuery(q, "document-annotation", args, signal);
    if (name === "processor_runs")
      return executeQuery(q, "processor-runs", args, signal);
    if (name === "literature_results")
      return executeQuery(q, "literature-results", args, signal);
    if (name === "usage_estimate")
      return executeQuery(q, "usage-estimate", args, signal);
    if (name === "task_run") return executeQuery(q, "task-run", args, signal);
    if (name === "source_statistics")
      return executeQuery(q, "source-statistics", args, signal);
    if (name === "agent_sessions")
      return executeQuery(q, "agent-sessions", args, signal);
    if (name === "operation_history")
      return executeQuery(q, "operation-history", args, signal);
    if (name === "proofread_text")
      return executeQuery(q, "proofread-text", args, signal);
    if (name === "proofread_page")
      return executeQuery(q, "proofread-page", args, signal);
    if (name === "proofread_inspect")
      return executeQuery(q, "proofread-inspect", args, signal);
    if (name === "document_read")
      return executeQuery(
        q,
        `document-${args.operation}` as QueryOperation,
        args.request,
        signal,
      );
    if (name === "search_context")
      return executeQuery(
        q,
        args.kind === "knowledge" ? "knowledge-context" : "context",
        args.request,
        signal,
      );
    const routes: Readonly<Record<string, QueryOperation>> = {
      list_tasks: "task-list",
      read_artifact_chunk: "artifact-chunk",
      export_bibliography: "bibliography-export",
      inspect_task: "task-detail",
      status: "status",
      index_status: "index-status",
      read_literature: "literature-read",
      read_task: "task-read",
      read_article_identity: "article-identity",
      prepare_analysis_inputs: "analysis-inputs",
      read_references: "references",
      read_reference: "reference-read",
      prepare_extraction: "extraction-prepare",
    };
    if (!Object.hasOwn(routes, name)) unavailable();
    return executeQuery(
      q,
      routes[name]!,
      Object.hasOwn(args, "request") ? args.request : args,
      signal,
    );
  };
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const execute = async (): Promise<CallToolResult> => {
      try {
        if (stop.signal.aborted) unavailable();
        const args = request.params.arguments ?? {};
        const name = request.params.name;
        if (
          ["document_role", "proofread_decide", "proofread_revoke"].includes(
            name,
          ) ||
          ([
            "document_annotate",
            "proofread_build",
            "document_publish_proofread",
            "proofread_save",
          ].includes(name) &&
            args.schema_version !== 2) ||
          (name === "archive_manage" &&
            args.operation === "build" &&
            (!args.request ||
              typeof args.request !== "object" ||
              !("schema_version" in args.request) ||
              args.request.schema_version !== 2))
        )
          throw new ProductOperationError("archive-contract-obsolete");
        if (
          Buffer.byteLength(JSON.stringify(args)) >
            (request.params.name === "proofread_save"
              ? 9 * 1024 * 1024
              : 1024 * 1024 + 4096) ||
          !validators.get(request.params.name)?.(args)
        )
          throw Object.assign(new Error("invalid request"), {
            code: "invalid-request",
          });
        return result(
          await withActivity(
            {
              actor: server.getClientVersion()?.name
                ? `mcp:${server
                    .getClientVersion()!
                    .name.replace(/[\p{Cc}\p{Cf}]/gu, "")
                    .slice(0, 80)}`
                : machineActor("mcp"),
            },
            () =>
              call(
                request.params.name,
                args,
                AbortSignal.any([extra.signal, stop.signal]),
              ),
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
              ...(error instanceof SourceConfigurationError
                ? {
                    problem: {
                      display: "error",
                      technical_details: sourceDetails(error.code),
                    },
                    ...(error.current_revision
                      ? { current_revision: error.current_revision }
                      : {}),
                  }
                : {}),
              ...(error instanceof ProcessorQueryError
                ? { fields: error.fields }
                : {}),
              message:
                "The requested operation could not complete. Inspect readiness, fixed inputs or the durable task result.",
            },
          }),
        };
      }
    };
    const pending = withoutRestartAdmission(execute);
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
      uploads.close();
      await Promise.allSettled([...active]);
      const opened = await Promise.allSettled([app, query]);
      const failures: unknown[] = [];
      try {
        await closeSourceProbes(sourceConfiguration(configurationOwner));
      } catch (error) {
        failures.push(error);
      }
      try {
        await browser?.close();
      } catch (error) {
        failures.push(error);
      }
      for (const value of opened)
        if (value.status === "fulfilled" && value.value) {
          try {
            await value.value.close();
          } catch (error) {
            failures.push(error);
          }
        }
      await server.close();
      if (!options.probeSeams?.network) configurationNetwork.close();
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
