import { NetworkConfigurationError } from "@sciretriever/contracts";
import {
  sourceConfiguration,
  SourceConfigurationError,
  sourceDetails,
} from "../configuration/sources.js";
import {
  RestartAdmissionError,
  withoutRestartAdmission,
} from "../application/restart-admission.js";
import { WebSupervisorError } from "./web-supervisor.js";
import { catalogCorruption } from "../storage/sqlite/errors.js";
import {
  sourceProbes,
  closeSourceProbes,
} from "../configuration/source-probes.js";
import { withActivity, machineActor } from "../logging/activity.js";
import {
  ContractValidationError,
  parseDiscoveryRunId,
  parseDocumentRequest,
  parseLibraryQuery,
  parseLiteratureId,
  parseMetaLiteratureId,
  parseStrictJsonValue,
  type LibraryQuery,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import { runMetadataTask } from "../entry/metadata-task.js";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { processorError, ProcessorError } from "../analysis/processor.js";
import { ProcessingTaskError } from "../application/jobs/processing.js";
import * as applicationBootstrap from "../bootstrap/application.js";
import {
  QueryApplicationError,
  type Application,
  type QueryApplication,
} from "../bootstrap/application.js";
import { ConfigurationBoundaryError } from "../configuration/index.js";
import {
  ConfigurationOwnerError,
  ConfigurationProbeError,
  ConfigurationProbeSession,
  fixedConfigurationHome,
  TypeScriptConfigurationOwner,
  type ConfigurationProbeRequest,
  type ConfigurationProbeResult,
  type ConfigurationProbeSeams,
} from "../configuration/owner.js";
import { DocumentProcessingError } from "../document/service.js";
import {
  ArtifactExportError,
  exportArtifact,
  exportBytes,
} from "../entry/artifact-export.js";
import {
  BibliographyExportError,
  prepareBibliographyExport,
  type BibliographyExportSelector,
} from "../entry/bibliography-export.js";
import {
  CONFIGURATION_OPERATIONS,
  executeConfiguration,
  type ConfigurationOperation,
} from "../entry/configuration-operations.js";
import { runDoctor } from "../entry/doctor.js";
import {
  executeMaintenance,
  isMaintenanceFailure,
  type MaintenanceOperation,
} from "../entry/maintenance-operations.js";
import {
  PROCESSOR_QUERIES,
  queryProcessors,
  submitProcessor,
} from "../entry/processor-operations.js";
import {
  acceptPublisherNameMappings,
  type PublisherGovernanceSelector,
} from "../entry/publisher-governance.js";
import {
  executeQuery,
  isQueryFailure,
  operationRecord,
  type QueryOperation,
} from "../entry/query-operations.js";
import { type LiteratureSelector } from "../entry/selectors.js";
import type { BibliographyInputFormat } from "../literature/bibliography-import.js";
import { LiteratureNotFoundError } from "../literature/query.js";
import { ArticleIdentityError } from "../parsing/article-identity.js";
import { ParsingFailure } from "../parsing/ports.js";
import { ProcessorQueryError } from "../storage/processor-results.js";
import { CatalogSchemaError } from "../storage/sqlite/schema-path.js";
import { WorkbenchAccessError } from "../workbench/access.js";
import {
  MachineWorkbenchClient,
  MachineWorkbenchError,
  type WorkbenchOperation,
} from "../workbench/machine-client.js";
import { runBrowserSession } from "./browser-session.js";
import { runConfigurationCenter } from "./config-center.js";
import {
  renderConfigurationTest,
  renderStatus,
  type ConfigTheme,
} from "./config-ui.js";
import { parseWebOptions, webAccessOptions } from "./web-access.js";

export interface CliOptions {
  readonly home?: string;
  readonly stdout?: (text: string) => void;
  readonly stdoutBytes?: (bytes: Uint8Array) => void;
  readonly stderr?: (text: string) => void;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly json?: boolean;
  /** User-controlled stop; a frozen database-completion scope reports it. */
  readonly signal?: AbortSignal;
  /**
   * Explicit offline seam for the read-only configuration probe. Production
   * and ordinary callers leave it undefined so real adapters and the shared
   * Network are used instead.
   */
  readonly probeSeams?: ConfigurationProbeSeams;
}

export interface CliResult {
  readonly code: number;
  readonly value?: unknown;
}

class CliInputError extends Error {
  constructor(readonly nextAction?: string) {
    super("invalid command input");
    this.name = "CliInputError";
  }
}

class CliBusinessError extends Error {
  constructor() {
    super("command could not complete");
    this.name = "CliBusinessError";
  }
}

function invalidInput(): never {
  throw new CliInputError();
}

/**
 * The only production configuration identity is the fixed user home. An
 * explicitly injected `home` remains an internal isolation seam, while
 * `SCIRETRIEVER_HOME`, the working directory and legacy paths never change
 * where ordinary configuration and credentials live (ADR 0018).
 */
export function configurationHome(
  options: Pick<CliOptions, "home"> = {},
): string {
  return options.home ?? fixedConfigurationHome();
}

function output(value: unknown, options: CliOptions): CliResult {
  const text = `${JSON.stringify(value, null, options.json ? 0 : 2)}\n`;
  options.stdout?.(text);
  return { code: 0, value };
}

function usage(options: CliOptions): CliResult {
  const text =
    "Usage: sciretriever <web|discover|complete|literature|document|form-drafts|analysis|context|extraction|import|export|config|storage|maintenance|jobs|browser|mcp> ...\n" +
    "  web [--port 4174] [--host IPv4]  # login required; generates an API key unless SCIRETRIEVER_WEB_PASSWORD is set\n" +
    "  discover topic QUERY | discover citations --seed-literature-id ID\n" +
    "  metadata lookup ID[,ID] | sources statistics --request FILE|-\n" +
    "  complete pdf|parser [--literature-id ID] [--transfers ID,...]\n" +
    "  literature search [query options] [--collection-scope collected|all] | show ID | references ID | cited-by ID\n" +
    "  literature counts --request FILE|-  # full_text counts papers (MetaLiterature); statuses and with_primary_pdf count versions; read-only\n" +
    "  literature exact-count --request FILE|-  # kind=counts|facets|search-total, query, limit for facets; one read snapshot\n" +
    "    --needs-metadata | --no-needs-metadata filters the independent bibliographic recognition mark\n" +
    "  import metadata FORMAT SOURCE | import pdf ID SOURCE\n" +
    "  document parse --literature-id ID --asset-id ID --asset-sha256 SHA256 [--profiles pipeline,vlm-engine] [--force] (default: deployment profile)\n" +
    "  export metadata FORMAT OUTPUT | export pdf ID --path PATH\n" +
    "  config [--theme auto|dark|light|mono] | config status [--json] [--theme ...] | config test ...\n" +
    "  jobs create [--text QUERY] | jobs submit --request FILE|- | jobs run|show|pause|cancel|resume|retry JOB_ID\n" +
    "  document default|describe|outline|segments|slice|resources|resource|evidence|material --request FILE|-\n" +
    "  document publish-proofread --request FILE|-  # expected_default_revision is the current document default revision, including a draft; null only when absent\n" +
    "    On publication-conflict, read document default again, check the proofreading input and retry with its revision; the accepted fixed version is retained\n" +
    "    text_level=draft|proofread belongs to the fixed version; describe adds draft_summary={differs_segments,differences,image_only_pages} for drafts\n" +
    "    Draft locations use basis=text-layer-match|text-layer-differs|no-text-layer; roles returns the whole draft with coverage_note; corrected basis is unchanged\n" +
    "  document draft-differences --request FILE|-  # saved draft differences as bounded json-utf8; collect continuations before parsing\n" +
    "    corrections is corrected-only; devices read via HTTP MCP /mcp with purpose read, not query HTTP routes\n" +
    "  context search|knowledge --request FILE|-; analysis prepare --request FILE|-; extraction prepare --request FILE|-\n" +
    "  literature status; literature search|read|references|reference|identity|artifact-chunk|bibliography --request FILE|-\n" +
    "  jobs list|inspect|create-request|resolve --request FILE|- (create-request only saves)\n" +
    "  library batches|facets|batch-rename --request FILE|-; acquire-pdf preview --request FILE|-\n" +
    "  form-drafts preview|start --request FILE|-  # existing raw parses only; no model, network or parser; start waits for its durable task\n" +
    "  extraction create|read|submit|receipt|close|cancel|cleanup --request FILE|-\n" +
    "  config read; config preview|publish|credential|probe --request FILE|-\n" +
    "  import bibliography --request FILE|-; discover request --request FILE|-\n" +
    "  mcp [--maintenance] [--workbench-url http://127.0.0.1:PORT]\n" +
    "  browser session --workbench-url URL --request FILE|- [--maintenance] # NDJSON connection\n" +
    "  jobs runtime --workbench-url URL --request FILE|- [--maintenance] # operate in the Web owner\n" +
    "  archive build IDS [--mode full|legacy-vlm-markdown] [--from-step STEP]; archive status|resume ID; archive issues|stats|events; archive resolve --request FILE\n" +
    "  tags list|search|show|changes|consolidate|backfill; tags edit|undo --request FILE; literature tags ID / set|lock --request FILE\n" +
    "  filters list|export|create|rename|update|delete|import --request FILE  # export, save and manage library query conditions\n" +
    "  folders list|delete-preview|export|create|rename|move|delete|add|remove --request FILE  # export, list and manage folders and paper membership\n" +
    "  literature open ID  # record a paper's latest opening time\n" +
    "  marks list|export|create|update|delete|restore|place --request FILE  # reading highlights, regions and notes of one paper\n" +
    "  storage schema-inspect|schema-init --catalog PATH\n" +
    "  storage schema-apply --catalog PATH --addition NAME\n" +
    "  maintenance rebuild-index\n" +
    "  maintenance refresh-index\n" +
    "  maintenance verify-index\n" +
    "  maintenance verify-catalog\n" +
    "  maintenance index-status\n" +
    "  maintenance publisher-names (--all | --literature-id ID... | --query TEXT) [--ai] [--scan-limit N] [--cursor CURSOR] [--max-ai-requests N] [--output PATH]\n" +
    "  maintenance publisher-names-accept --report FILE|- --name NAME [--name NAME...]\n";
  options.stdout?.(text);
  return { code: 0 };
}

async function inputBytes(
  path: string,
  options: CliOptions,
  maxBytes?: number,
): Promise<Uint8Array> {
  if (path !== "-" && maxBytes === undefined) return readFile(path);
  const input =
    path !== "-"
      ? createReadStream(path)
      : (options.stdin ?? (process.stdin as AsyncIterable<Uint8Array>));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    options.signal?.throwIfAborted();
    size += chunk.byteLength;
    if (maxBytes !== undefined && size > maxBytes) invalidInput();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function argument(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : (args[index + 1] ?? null);
}

function argumentsOf(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) invalidInput();
      values.push(value);
      index += 1;
    }
  return values;
}

function integerOption(
  args: readonly string[],
  name: string,
  fallback: number,
): number {
  const value = argument(args, name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidInput();
  return parsed;
}

function metadataScanLimit(
  args: readonly string[],
  configuredLimit: number,
): number {
  if (args.includes("--scan-limit") && argument(args, "--scan-limit") === null)
    invalidInput();
  const limit = args.includes("--scan-limit")
    ? integerOption(args, "--scan-limit", configuredLimit)
    : configuredLimit;
  if (limit < 1) invalidInput();
  return limit;
}

function themeOption(args: readonly string[]): ConfigTheme {
  const value = argument(args, "--theme");
  if (args.includes("--theme") && value === null) invalidInput();
  if (
    value === null ||
    value === "auto" ||
    value === "dark" ||
    value === "light" ||
    value === "mono"
  )
    return value ?? "auto";
  invalidInput();
}

const PROBE_FLAGS = new Set(["--all", "--image", "--target", "--theme"]);

function probePositionals(args: readonly string[]): readonly string[] {
  const values: string[] = [];
  const rest = args.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item === "--target") {
      index += 1;
      continue;
    }
    if (item.startsWith("--")) {
      if (!PROBE_FLAGS.has(item)) invalidInput();
      continue;
    }
    values.push(item);
  }
  return values;
}

/**
 * One explicit request shape shared by the interactive center and the
 * structured CLI: both must select the same owner and target before dispatch.
 */
function parseProbeRequest(args: readonly string[]): ConfigurationProbeRequest {
  const positionals = probePositionals(args);
  const all = args.includes("--all");
  const image = args.includes("--image");
  const targetFlag = argument(args, "--target");
  const head = positionals[0] ?? null;
  if (image && head !== "model") invalidInput();
  if (head === null || head === "all") {
    // A bare `config test` selects nothing; only an explicit `--all` does.
    const extra = positionals.length - (head === "all" ? 1 : 0);
    if (image || targetFlag || extra !== 0) invalidInput();
    if (head === null && !all) invalidInput();
    return { owner: "all", target: null, image: false };
  }
  if (all && head !== "search" && head !== "download") invalidInput();
  if (head === "proxy") {
    if (positionals.length !== 1 || targetFlag || image || all) invalidInput();
    return { owner: "proxy", target: null, image: false };
  }
  if (head === "provider" || head === "model") {
    const target = positionals[1] ?? targetFlag;
    if (!target || positionals.length > 2) invalidInput();
    return { owner: head, target, image };
  }
  if (head === "search" || head === "download") {
    if (positionals.length > 2) invalidInput();
    const target = positionals[1] ?? targetFlag;
    if (all) {
      if (target) invalidInput();
      return { owner: head, target: null, image: false };
    }
    if (!target) invalidInput();
    return { owner: head, target, image: false };
  }
  if (head === "parse" || head === "analyze") {
    if (positionals.length > 1 || targetFlag || all) invalidInput();
    return { owner: head, target: null, image: false };
  }
  if (head === "browser") {
    const sub = positionals[1];
    if (sub === "model") {
      if (positionals.length > 2 || targetFlag || all) invalidInput();
      return { owner: "browser-model", target: null, image: false };
    }
    if (sub === "site") {
      const target = positionals[2] ?? targetFlag;
      if (!target || all || positionals.length > 3) invalidInput();
      return { owner: "browser-site", target, image: false };
    }
  }
  invalidInput();
}

function probeLabel(selection: {
  readonly owner: string;
  readonly target: string | null;
}): string {
  const target = selection.target === null ? "" : ` ${selection.target}`;
  return `config test ${selection.owner}${target}`;
}

async function readConfirmationLine(
  stdin: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<string | null> {
  const pending = (async (): Promise<string> => {
    let text = "";
    for await (const chunk of stdin) {
      text += Buffer.from(chunk).toString("utf8");
      if (text.includes("\n") || text.length > 8) break;
    }
    return text;
  })();
  if (!signal) return pending;
  return new Promise<string | null>((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Human-mode confirmation before any probe that could reach the network or
 * consume quota; `--json` is the explicit script invocation and never prompts.
 */
async function confirmConfigurationProbe(
  options: CliOptions,
  request: ConfigurationProbeRequest,
): Promise<boolean> {
  if (request.owner === "download") return true;
  const stdin = options.stdin;
  if (stdin === undefined) return false;
  const write =
    options.stderr ?? ((text: string) => process.stderr.write(text));
  write(`${probeLabel(request)}: perform one bounded read-only probe? [y/N] `);
  const answer = await readConfirmationLine(stdin, options.signal);
  if (answer === null) return false;
  return /^(?:y|yes)$/iu.test((answer.split("\n")[0] ?? "").trim());
}

function probeDiagnosis(result: ConfigurationProbeResult): string {
  const reason = result.reason === null ? "no failure" : result.reason;
  return `${probeLabel(result)}: ${result.outcome} (${reason}); next step: ${
    result.action ?? "none"
  }\n`;
}

function query(
  text: string | null,
  args: readonly string[] = [],
): LibraryQuery {
  if (
    args.some(
      (arg) => arg === "--document-type" || arg.startsWith("--document-type="),
    )
  )
    throw new CliInputError(
      "--document-type was removed; use --publication-form and --article-kind",
    );
  const identifiers = argumentsOf(args, "--identifier").map((item) => {
    const separator = item.indexOf(":");
    if (separator <= 0 || separator === item.length - 1) invalidInput();
    return {
      namespace: item.slice(0, separator),
      value: item.slice(separator + 1),
    };
  });
  const bool = args.includes("--needs-manual-pdf");
  const noBool = args.includes("--no-needs-manual-pdf");
  return parseLibraryQuery({
    text,
    ...(args.includes("--needs-metadata")
      ? { needs_metadata: true }
      : args.includes("--no-needs-metadata")
        ? { needs_metadata: false }
        : {}),
    title: argument(args, "--title"),
    author: argument(args, "--author"),
    author_orcids: argumentsOf(args, "--author-orcid"),
    identifiers,
    publication_year_from: argument(args, "--year-from")
      ? integerOption(args, "--year-from", 0)
      : null,
    publication_year_to: argument(args, "--year-to")
      ? integerOption(args, "--year-to", 0)
      : null,
    venue: argument(args, "--venue"),
    publisher: argument(args, "--publisher"),
    publication_forms: argumentsOf(args, "--publication-form"),
    article_kinds: argumentsOf(args, "--article-kind"),
    languages: argumentsOf(args, "--language"),
    keywords: argumentsOf(args, "--keyword"),
    subject_terms: argumentsOf(args, "--subject-term"),
    intake_batch_ids: argumentsOf(args, "--intake-batch-id"),
    ...(args.includes("--collection-scope") ||
    argument(args, "--collection-scope") !== null
      ? { collection_scope: argument(args, "--collection-scope") }
      : {}),
    version_roles: argumentsOf(args, "--version-role"),
    statuses: argumentsOf(args, "--status"),
    missing_steps: argumentsOf(args, "--missing-step"),
    needs_manual_pdf: bool ? true : noBool ? false : null,
    discovery_run_ids: argumentsOf(args, "--discovery-run-id"),
    ...(argumentsOf(args, "--tag").length
      ? {
          tags: {
            ids: argumentsOf(args, "--tag"),
            mode: argument(args, "--tag-mode") ?? "any",
          },
        }
      : {}),
  });
}

async function withApplication<T>(
  options: CliOptions,
  action: (application: Application) => Promise<T>,
): Promise<T> {
  const application = await applicationBootstrap.createApplication(
    configurationHome(options),
  );
  const work = () =>
    runAndClose(
      () => action(application),
      () => application.close(),
    );
  return application.restartAdmission
    ? application.restartAdmission.newWork(work)
    : work();
}

async function runAndClose<T>(
  action: () => Promise<T>,
  close: () => Promise<void>,
  cleanupMessage = "command and application cleanup failed",
): Promise<T> {
  let result: T;
  try {
    result = await action();
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], cleanupMessage, {
        cause: error,
      });
    }
    throw error;
  }
  await close();
  return result;
}

type ReadyQueryApplication = QueryApplication & {
  readonly query: NonNullable<QueryApplication["query"]>;
  readonly literatureArtifacts: NonNullable<
    QueryApplication["literatureArtifacts"]
  >;
};
async function withQueryApplication<T>(
  options: CliOptions,
  action: (application: ReadyQueryApplication) => Promise<T>,
): Promise<T> {
  const application = await applicationBootstrap.createQueryApplication(
    configurationHome(options),
  );
  return runAndClose(
    async () => {
      if (
        application.readiness.status !== "ready" ||
        !application.query ||
        !application.literatureArtifacts
      ) {
        throw new QueryApplicationError(
          application.readiness.status === "ready"
            ? "unavailable"
            : application.readiness.status,
        );
      }
      return action(application as ReadyQueryApplication);
    },
    () => application.close(),
    "command and query application cleanup failed",
  );
}

async function execute(
  args: readonly string[],
  options: CliOptions,
): Promise<CliResult> {
  if (!args.length || args[0] === "--help" || args[0] === "-h")
    return usage(options);
  const [group, command] = args;
  if (group === "jobs" && command === "runtime") {
    const origin = argument(args, "--workbench-url");
    const source = argument(args, "--request");
    const flags = args.slice(2).filter((v) => v !== "--maintenance");
    if (
      !origin ||
      !source ||
      flags.length !== 4 ||
      flags[0] !== "--workbench-url" ||
      flags[2] !== "--request"
    )
      invalidInput();
    const r = operationRecord(
      parseStrictJsonValue(
        await inputBytes(source, options, 1024 * 1024 + 4096),
      ),
      ["operation", "request"],
    );
    if (
      typeof r.operation !== "string" ||
      !["list", "read", "create", "control"].includes(r.operation)
    )
      invalidInput();
    const client = new MachineWorkbenchClient(
      origin,
      args.includes("--maintenance"),
    );
    const result = await runAndClose(
      () =>
        client.execute(
          `task-${r.operation}` as WorkbenchOperation,
          r.request,
          options.signal,
        ),
      () => client.close(),
      "runtime connection cleanup failed",
    );
    return output({ protocol_version: 1, result }, options);
  }
  if (group === "browser" && command === "session") {
    const origin = argument(args, "--workbench-url");
    const source = argument(args, "--request");
    const flags = args.slice(2).filter((v) => v !== "--maintenance");
    if (
      !origin ||
      !source ||
      flags.length !== 4 ||
      flags[0] !== "--workbench-url" ||
      flags[2] !== "--request"
    )
      invalidInput();
    const client = new MachineWorkbenchClient(
      origin,
      args.includes("--maintenance"),
    );
    const input =
      source === "-"
        ? (options.stdin ?? process.stdin)
        : createReadStream(
            source,
            options.signal ? { signal: options.signal } : {},
          );
    const result = await runAndClose(
      () =>
        runBrowserSession(
          client,
          input,
          options.stdout ??
            ((text) => {
              process.stdout.write(text);
            }),
          options.signal,
        ),
      () => client.close(),
      "browser connection cleanup failed",
    );
    return { code: result.failed ? 3 : 0, value: result };
  }
  if (
    group === "config" &&
    CONFIGURATION_OPERATIONS.includes(command as ConfigurationOperation) &&
    command !== "status"
  ) {
    const source = argument(args, "--request");
    const noInput =
      command === "read" ||
      command === "sources" ||
      (command === "apply" && !source);
    if (
      noInput
        ? args.length !== 2
        : !source || args.length !== 4 || args[2] !== "--request"
    )
      invalidInput();
    const bytes = source
      ? await inputBytes(source, options, 1024 * 1024 + 4096)
      : Buffer.from("{}");
    if (bytes.byteLength > 1024 * 1024 + 4096) invalidInput();
    const owner = new TypeScriptConfigurationOwner(configurationHome(options));
    const sources = sourceConfiguration(owner);
    const abort = () => {
      void closeSourceProbes(sources).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await executeConfiguration(
        owner,
        command as ConfigurationOperation,
        parseStrictJsonValue(bytes),
        options.signal,
        options.probeSeams,
      );
      if (command?.startsWith("source-")) await sourceProbes(sources).settle();
      return output({ protocol_version: 1, result }, options);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await closeSourceProbes(sources);
    }
  }
  if (group === "marks") {
    const request = parseStrictJsonValue(
      await inputBytes(
        argument(args, "--request") ?? invalidInput(),
        options,
        262144,
      ),
    );
    const envelope = { operation: command, request };
    if (command === "list" || command === "export") {
      const q = await applicationBootstrap.createQueryApplication(
        configurationHome(options),
      );
      try {
        const result = await executeQuery(q, "marks", envelope, options.signal);
        // `export` without --json prints the document itself, ready to save.
        if (command === "export" && !options.json) {
          options.stdout?.(String((result as { content: unknown }).content));
          return { code: 0, value: result };
        }
        return output(result, options);
      } finally {
        await q.close();
      }
    }
    return output(
      await withApplication(options, (app) =>
        executeMaintenance(app, "marks", envelope, options.signal),
      ),
      options,
    );
  }
  if (group === "folders") {
    const file = argument(args, "--request");
    const request = file
      ? parseStrictJsonValue(await inputBytes(file, options, 262144))
      : command === "list"
        ? {}
        : invalidInput();
    const envelope = { operation: command, request };
    if (
      command === "list" ||
      command === "delete-preview" ||
      command === "export"
    ) {
      const q = await applicationBootstrap.createQueryApplication(
        configurationHome(options),
      );
      try {
        return output(
          await executeQuery(q, "folders", envelope, options.signal),
          options,
        );
      } finally {
        await q.close();
      }
    }
    return output(
      await withApplication(options, (app) =>
        executeMaintenance(app, "folders", envelope, options.signal),
      ),
      options,
    );
  }
  if (group === "filters") {
    const file = argument(args, "--request");
    const request = file
      ? parseStrictJsonValue(await inputBytes(file, options, 262144))
      : command === "list" || command === "export"
        ? {}
        : invalidInput();
    const envelope = { operation: command, request };
    if (command === "list" || command === "export") {
      const q = await applicationBootstrap.createQueryApplication(
        configurationHome(options),
      );
      try {
        return output(
          await executeQuery(q, "filters", envelope, options.signal),
          options,
        );
      } finally {
        await q.close();
      }
    }
    return output(
      await withApplication(options, (app) =>
        executeMaintenance(app, "filters", envelope, options.signal),
      ),
      options,
    );
  }
  if (group === "literature" && command === "open") {
    return output(
      await withApplication(options, (app) =>
        executeMaintenance(
          app,
          "reading-open",
          { literature_id: args[2] },
          options.signal,
        ),
      ),
      options,
    );
  }
  if (group === "snapshot") {
    if (command === "rename") {
      const name = argument(args, "--name");
      if (name === null) invalidInput();
      return output(
        await withApplication(options, (app) =>
          executeMaintenance(
            app,
            "snapshot-rename",
            { snapshot_id: args[2], name },
            options.signal,
          ),
        ),
        options,
      );
    }
    if (command === "create") {
      const ids = argument(args, "--ids"),
        filter = argument(args, "--filter");
      if (Boolean(ids) === Boolean(filter)) invalidInput();
      const definition = ids
        ? { kind: "literatures", literature_ids: ids.split(",") }
        : {
            kind: "query",
            query: parseStrictJsonValue(
              await inputBytes(filter!, options, 262144),
            ),
          };
      return output(
        await withApplication(options, (app) =>
          executeMaintenance(
            app,
            "snapshots",
            { ...definition, name: argument(args, "--name") },
            options.signal,
          ),
        ),
        options,
      );
    }
    const operation = command === "show" ? "read" : command;
    const request =
      operation === "read"
        ? {
            snapshot_id: args[2],
            offset: integerOption(args, "--offset", 0),
            limit: integerOption(args, "--limit", 100),
            max_bytes: integerOption(args, "--max-bytes", 262144),
          }
        : operation === "list"
          ? {
              after: argument(args, "--after") ?? null,
              limit: integerOption(args, "--limit", 50),
            }
          : operation === "diff"
            ? { before: args[2], after: args[3] }
            : invalidInput();
    const q = await applicationBootstrap.createQueryApplication(
      configurationHome(options),
    );
    try {
      return output(
        await executeQuery(
          q,
          "snapshots",
          { operation, request },
          options.signal,
        ),
        options,
      );
    } finally {
      await q.close();
    }
  }
  if (
    group === "archive" &&
    !["arrangement", "arrangement-edit"].includes(command ?? "")
  ) {
    const file = argument(args, "--request");
    const request: unknown = file
      ? parseStrictJsonValue(await inputBytes(file, options, 262144))
      : command === "status" || command === "resume"
        ? { literature_id: args[2] }
        : command === "issues"
          ? {
              ...(argument(args, "--reason")
                ? { reason: argument(args, "--reason") }
                : {}),
              ...(argument(args, "--part")
                ? { part: argument(args, "--part") }
                : {}),
              offset: integerOption(args, "--offset", 0),
              limit: integerOption(args, "--limit", 50),
            }
          : command === "stats"
            ? {}
            : command === "events"
              ? {
                  after: integerOption(args, "--after", 0),
                  limit: integerOption(args, "--limit", 100),
                }
              : command === "build" && args[2] && !args[2].startsWith("--")
                ? {
                    schema_version: 2,
                    selector: {
                      kind: "literatures",
                      literature_ids: args[2].split(","),
                    },
                    mode: argument(args, "--mode") ?? "full",
                    from_step: argument(args, "--from-step") ?? null,
                    idempotency_key:
                      argument(args, "--idempotency-key") ??
                      `archive-${randomUUID()}`,
                  }
                : invalidInput();
    const envelope = { operation: command, request };
    if (["build", "resume", "resolve"].includes(command ?? ""))
      return output(
        await withApplication(options, async (app) => {
          const result = await executeMaintenance(
            app,
            "archive",
            envelope,
            options.signal,
          );
          const job = (result as { job?: { job_id: string } })?.job;
          if (job && app.processingTasks) {
            await app.processingTasks.run(job.job_id, options.signal);
            return app.processingTasks.read(job.job_id);
          }
          return result;
        }),
        options,
      );
    const query = await applicationBootstrap.createQueryApplication(
      configurationHome(options),
    );
    try {
      return output(
        await executeQuery(query, "archive", envelope, options.signal),
        options,
      );
    } finally {
      await query.close();
    }
  }
  if (group === "tags" || (group === "literature" && command === "tags")) {
    const source = argument(args, "--request");
    const cmd = group === "tags" ? command : args[2];
    let operation: string,
      request: unknown,
      write = false;
    if (source) {
      request = parseStrictJsonValue(await inputBytes(source, options, 262144));
      operation =
        (
          {
            edit: "change",
            create: "change",
            merge: "change",
            undo: "change",
            set: "assign",
            lock: "lock",
            build: "build",
            backfill: "backfill",
          } as Record<string, string>
        )[cmd ?? ""] ??
        cmd ??
        "";
      write = [
        "change",
        "assign",
        "lock",
        "build",
        "backfill",
        "consolidate",
      ].includes(operation);
    } else if (group === "literature") {
      operation = "assignment";
      request = { literature_id: args[2] };
    } else if (cmd === "list" || cmd === "search") {
      operation = cmd;
      request = {
        query: cmd === "search" ? (args[2] ?? "") : "",
        limit: integerOption(args, "--limit", 50),
        offset: integerOption(args, "--offset", 0),
        ...(argument(args, "--category")
          ? { category: argument(args, "--category") }
          : {}),
        ...(argument(args, "--parent")
          ? { parent_id: argument(args, "--parent") }
          : {}),
      };
    } else if (cmd === "undo-preview") {
      operation = "undo-preview";
      request = { change_version: Number(args[2]) };
    } else if (cmd === "show") {
      operation = "show";
      request = { tag_id: args[2] };
    } else if (cmd === "changes") {
      operation = "changes";
      request = {
        since: integerOption(args, "--since", 0),
        limit: integerOption(args, "--limit", 100),
      };
    } else if (cmd === "consolidate") {
      operation = "consolidate";
      request = {};
      write = true;
    } else if (cmd === "backfill") {
      operation = "backfill-preview";
      request = { tag_ids: args[2]?.split(",") ?? [] };
      if (args.includes("--execute")) {
        operation = "backfill";
        request = { ...(request as object), dry_run: false };
        write = true;
      }
    } else invalidInput();
    const envelope = { operation, request };
    if (write)
      return output(
        await withApplication(options, (app) =>
          executeMaintenance(app, "tags", envelope, options.signal),
        ),
        options,
      );
    const app = await applicationBootstrap.createQueryApplication(
      configurationHome(options),
    );
    try {
      return output(
        await executeQuery(app, "tags", envelope, options.signal),
        options,
      );
    } finally {
      await app.close();
    }
  }
  const queryRoutes: Readonly<Record<string, QueryOperation>> = {
    "library batches": "intake-batches",
    "library facets": "library-facets",
    "acquire-pdf preview": "acquire-pdf-preview",
    "form-drafts preview": "form-drafts-preview",
    "maintenance index-status": "index-status",
    "literature metadata-fields": "metadata-fields",
    "jobs list": "task-list",
    "jobs inspect": "task-detail",
    "literature status": "status",
    "literature search": "library-search",
    "literature counts": "library-counts",
    "literature exact-count": "library-exact-count",
    "literature read": "literature-read",
    "literature artifact-chunk": "artifact-chunk",
    "literature bibliography": "bibliography-export",
    "literature references": "references",
    "literature reference": "reference-read",
    "literature identity": "article-identity",
    "jobs progress": "task-run",
    "sources statistics": "source-statistics",
    "processor runs": "processor-runs",
    "literature results": "literature-results",
    "usage estimate": "usage-estimate",
    "archive arrangement": "archive-arrangement",
    "agents sessions": "agent-sessions",
    "operations history": "operation-history",
    "proofread text": "proofread-text",
    "literature reading-status": "reading-status",
    "proofread inspect": "proofread-inspect",
    "proofread page": "proofread-page",
    "document annotation": "document-annotation",
    "document figures": "document-figures",
    "document references": "document-reference-texts",
    "document parts": "document-parts",
    "document corrections": "document-corrections",
    "document draft-differences": "document-draft-differences",
    "document parsing-status": "document-parsing-status",
    "document default": "document-default",
    "document describe": "document-describe",
    "document outline": "document-outline",
    "document segments": "document-segments",
    "document slice": "document-slice",
    "document resources": "document-resources",
    "document resource": "document-resource",
    "document evidence": "document-evidence",
    "document material": "document-material",
    "analysis prepare": "analysis-inputs",
    "context search": "context",
    "context knowledge": "knowledge-context",
    "extraction prepare": "extraction-prepare",
  };
  const queryKey = `${group} ${command}`;
  if (
    Object.hasOwn(queryRoutes, queryKey) &&
    (!(group === "literature" && ["search", "references"].includes(command!)) ||
      args.includes("--request"))
  ) {
    const source = argument(args, "--request");
    if (
      !["status", "index-status"].includes(queryRoutes[queryKey]!) &&
      (!source || args.length !== 4 || args[2] !== "--request")
    )
      invalidInput();
    if (
      ["status", "index-status"].includes(queryRoutes[queryKey]!) &&
      args.length !== 2
    )
      invalidInput();
    const bytes = source
      ? await inputBytes(source, options, 1024 * 1024 + 4096)
      : new TextEncoder().encode("{}");
    if (bytes.byteLength > 1024 * 1024 + 4096) invalidInput();
    const request = parseStrictJsonValue(bytes);
    const application = await applicationBootstrap.createQueryApplication(
      configurationHome(options),
    );
    const value = await runAndClose(
      () =>
        executeQuery(
          application,
          queryRoutes[queryKey]!,
          request,
          options.signal,
        ),
      () => application.close(),
      "query cleanup failed",
    );
    if (
      !options.json &&
      ["context", "knowledge-context"].includes(queryRoutes[queryKey]!) &&
      value &&
      typeof value === "object" &&
      "coverage" in value &&
      value.coverage === "index-stale"
    )
      options.stdout?.(
        "索引正在追赶：以下为旧索引中仍可核实的命中，部分最新内容暂时搜不到。只读查询不会启动刷新。\n",
      );
    return output({ protocol_version: 1, result: value }, options);
  }
  const maintenanceRoutes: Readonly<Record<string, MaintenanceOperation>> = {
    "form-drafts start": "form-drafts",
    "library batch-rename": "intake-batch-rename",
    "literature resolve-references": "archive-references",
    "literature metadata-edit": "metadata-edit",
    "archive arrangement-edit": "archive-arrangement-edit",
    "document annotate": "document-annotate",
    "document role": "document-role",
    "import bibliography": "import-bibliography",
    "discover request": "discover",
    "jobs create-request": "task-create",
    "jobs resolve": "resolve-intervention",
    "extraction create": "extraction-operation",
    "extraction read": "extraction-operation-read",
    "extraction submit": "extraction-submit",
    "extraction receipt": "extraction-receipt",
    "extraction close": "extraction-close",
    "extraction cancel": "extraction-cancel",
    "extraction cleanup": "extraction-cleanup",
  };
  if (Object.hasOwn(maintenanceRoutes, queryKey)) {
    const source = argument(args, "--request");
    if (!source || args.length !== 4 || args[2] !== "--request") invalidInput();
    const bytes = await inputBytes(source, options, 1024 * 1024 + 4096);
    if (bytes.byteLength > 1024 * 1024 + 4096) invalidInput();
    const request = parseStrictJsonValue(bytes);
    const result = await withApplication(options, async (app) => {
      const accepted = await executeMaintenance(
        app,
        maintenanceRoutes[queryKey]!,
        request,
        options.signal,
      );
      if (maintenanceRoutes[queryKey] === "form-drafts") {
        const job = accepted as { job_id: string };
        await app.processingTasks!.run(job.job_id, options.signal);
      }
      return accepted;
    });
    return output({ protocol_version: 1, result }, options);
  }
  if (group === "web") {
    const parsed = parseWebOptions(args.slice(1));
    const port = parsed.port;
    if (options.signal?.aborted) return { code: 130 };
    const access = webAccessOptions(parsed.access);
    if (options.signal?.aborted) return { code: 130 };
    const { startWebSupervisor } = await import("./web-supervisor.js");
    let running: Awaited<ReturnType<typeof startWebSupervisor>>;
    try {
      running = await startWebSupervisor({
        home: configurationHome(options),
        port,
        access,
        ...(options.signal ? { signal: options.signal } : {}),
        onReady: (ready) =>
          output(
            {
              mode: "web",
              listen: ready.listen,
              url: ready.urls[0],
              urls: ready.urls,
              ...(ready.api_key === undefined
                ? {}
                : { api_key: ready.api_key }),
              login:
                ready.api_key === undefined
                  ? "Log in with the configured password."
                  : "Log in with api_key. This key changes when the service restarts.",
            },
            options,
          ),
      });
    } catch (error) {
      if (options.signal?.aborted) return { code: 0 };
      throw error;
    }
    try {
      return { code: await running.stopped };
    } finally {
      await running.close();
    }
  }

  if (group === "mcp") {
    const origin = argument(args, "--workbench-url");
    const flags = args.slice(1).filter((v) => v !== "--maintenance");
    if (
      flags.length &&
      (flags.length !== 2 || flags[0] !== "--workbench-url" || !origin)
    )
      invalidInput();
    const { runMcpStdio } = await import("../mcp/server.js");
    await runMcpStdio(
      {
        maintenance: args.includes("--maintenance"),
        ...(origin ? { workbenchUrl: origin } : {}),
        ...(options.home ? { home: options.home } : {}),
      },
      options.signal,
    );
    return { code: 0 };
  }
  if (group === "storage" && command === "retrieval-inspect") {
    const path = argument(args, "--catalog");
    if (!path || args.length !== 4) invalidInput();
    const { inspectCatalogRetrieval } = await import(
      "../storage/sqlite/catalog-schema.js"
    );
    return output(await inspectCatalogRetrieval(path), options);
  }
  if (group === "storage" && command === "schema-apply") {
    const path = argument(args, "--catalog");
    const name = argument(args, "--addition");
    if (!path?.startsWith("/") || !name || args.length !== 6) invalidInput();
    const { applyDeclaredCatalogAddition } = await import(
      "../storage/sqlite/catalog-schema.js"
    );
    return output(
      await applyDeclaredCatalogAddition(path, name, options.signal),
      options,
    );
  }
  if (
    group === "storage" &&
    (command === "schema-inspect" || command === "schema-init")
  ) {
    if (
      args.length !== 4 ||
      args[2] !== "--catalog" ||
      !args[3]?.startsWith("/")
    )
      invalidInput();
    const { inspectCatalogSchema, initializeCatalogSchema } = await import(
      "../storage/sqlite/catalog-schema.js"
    );
    return output(
      command === "schema-inspect"
        ? await inspectCatalogSchema(args[3])
        : await initializeCatalogSchema(args[3]),
      options,
    );
  }

  if (
    (group === "proofread" &&
      ["build", "save", "decide", "revoke"].includes(command ?? "")) ||
    (group === "document" && command === "publish-proofread")
  ) {
    const source = argument(args, "--request");
    if (!source || args.length !== 4 || args[2] !== "--request") invalidInput();
    const request = parseStrictJsonValue(
      await inputBytes(
        source,
        options,
        command === "save" ? 9 * 1024 * 1024 : 1024 * 1024,
      ),
    );
    return output(
      await withApplication(options, (app) =>
        executeMaintenance(
          app,
          `${group}-${command}` as MaintenanceOperation,
          request,
          options.signal,
        ),
      ),
      options,
    );
  }
  if (group === "document" && command === "parse") {
    const literatureId = argument(args, "--literature-id");
    const assetId = argument(args, "--asset-id");
    const assetSha = argument(args, "--asset-sha256");
    if (args.includes("--profiles") && argument(args, "--profiles") === null)
      invalidInput();
    const profiles = argument(args, "--profiles")?.split(",");
    if (
      !literatureId ||
      !assetId ||
      !assetSha ||
      args.includes("--mode") ||
      args.includes("--expected-default-revision")
    )
      invalidInput();
    return output(
      await withApplication(options, async (app) => {
        const request = parseDocumentRequest({
          literature_id: literatureId,
          asset_id: assetId,
          asset_sha256: assetSha,
          ...(profiles ? { profiles } : {}),
          force: args.includes("--force"),
        });
        await app.database.collectLiteratures(
          [request.literature_id],
          options.signal,
        );
        return app.documentProcessing.parseDocuments(request, options.signal);
      }),
      options,
    );
  }
  if (group === "maintenance" && command === "publisher-names") {
    const flags = new Set(["--all", "--ai"]);
    const valued = new Set([
      "--literature-id",
      "--query",
      "--scan-limit",
      "--cursor",
      "--max-ai-requests",
      "--output",
    ]);
    for (let index = 2; index < args.length; index += 1) {
      const option = args[index]!;
      if (flags.has(option)) continue;
      if (
        !valued.has(option) ||
        !args[index + 1] ||
        args[index + 1]!.startsWith("--")
      )
        invalidInput();
      index += 1;
    }
    const ids = argumentsOf(args, "--literature-id");
    const text = argument(args, "--query");
    if (
      Number(args.includes("--all")) +
        Number(ids.length > 0) +
        Number(text !== null) !==
      1
    )
      invalidInput();
    const selector: PublisherGovernanceSelector = ids.length
      ? { kind: "literatures", literature_ids: ids.map(parseLiteratureId) }
      : text !== null
        ? { kind: "query", query: query(text) }
        : { kind: "all" };
    const report = await withApplication(options, (app) =>
      app.publisherGovernance.report(
        {
          selector,
          ai: args.includes("--ai"),
          scan_limit: integerOption(args, "--scan-limit", 10_000),
          max_ai_requests: integerOption(args, "--max-ai-requests", 20),
          cursor: argument(args, "--cursor"),
        },
        options.signal,
      ),
    );
    const path = argument(args, "--output");
    if (path !== null)
      await exportBytes(
        new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
        path,
      );
    return output(report, options);
  }
  if (group === "maintenance" && command === "publisher-names-accept") {
    for (let index = 2; index < args.length; index += 2) {
      if (
        !["--report", "--name"].includes(args[index]!) ||
        !args[index + 1] ||
        args[index + 1]!.startsWith("--")
      )
        invalidInput();
    }
    const paths = argumentsOf(args, "--report");
    const names = argumentsOf(args, "--name");
    if (paths.length !== 1 || !names.length) invalidInput();
    const bytes = await inputBytes(paths[0]!, options);
    if (bytes.byteLength > 16_777_216) invalidInput();
    let report: unknown;
    try {
      report = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      invalidInput();
    }
    return output(
      await acceptPublisherNameMappings(
        new TypeScriptConfigurationOwner(configurationHome(options)),
        report,
        names,
        options.signal,
      ),
      options,
    );
  }
  if (
    group === "maintenance" &&
    [
      "rebuild-index",
      "refresh-index",
      "verify-index",
      "verify-catalog",
    ].includes(command ?? "")
  ) {
    if (args.length !== 2) invalidInput();
    const value = await withApplication(options, async (app) => {
      if (!app.maintenance)
        throw new Error("maintenance runtime is unavailable");
      if (command === "refresh-index") {
        if (!app.maintenance.refreshIndex)
          throw new Error("maintenance runtime is unavailable");
        return app.maintenance.refreshIndex(options.signal);
      }
      return command === "verify-index"
        ? app.maintenance.verifyIndex(options.signal)
        : command === "verify-catalog"
          ? app.maintenance.verifyCatalog(options.signal)
          : app.maintenance.rebuildIndex(options.signal);
    });
    const result = output(value, options);
    return command === "refresh-index" &&
      value &&
      typeof value === "object" &&
      "status" in value &&
      value.status === "failed"
      ? { ...result, code: 3 }
      : result;
  }
  if (group === "doctor" && command === undefined) {
    const owner = new TypeScriptConfigurationOwner(configurationHome(options));
    const snapshot = await owner.read(options.signal);
    return output(
      await runDoctor({ browser: snapshot.configuration.browser }),
      options,
    );
  }
  if (group === "storage" && command === "inspect") {
    const value = await withApplication(options, (app) =>
      app.database.inspectExecutionRuntime(),
    );
    return output(value, options);
  }
  if (group === "storage" && command === "backup") {
    const path = argument(args, "--path");
    if (!path || !path.startsWith("/")) invalidInput();
    // Backup never upgrades: the catalog is copied in the state it is in.
    await withApplication(options, (app) => app.database.backup(path));
    return output({ path, backed_up: true }, options);
  }
  if (group === "storage" && command === "restore-check") {
    const path = argument(args, "--path");
    if (!path || !path.startsWith("/")) invalidInput();
    const value = await withApplication(options, (app) =>
      app.database.restoreCheck(path),
    );
    return output(value, options);
  }
  if (group === "config" && command === "status") {
    const owner = new TypeScriptConfigurationOwner(configurationHome(options));
    const status = await owner.status();
    if (options.json) return output(status, options);
    const snapshot = await owner.read();
    options.stdout?.(
      `${renderStatus(snapshot.configuration, status, themeOption(args))}\n`,
    );
    return { code: 0, value: status };
  }
  if (group === "config" && (command === undefined || command === "--theme")) {
    return {
      code: await runConfigurationCenter(
        new TypeScriptConfigurationOwner(configurationHome(options)),
        {
          ...options,
          theme: themeOption(args),
          probeSeams: options.probeSeams,
        },
      ),
    };
  }
  if (group === "config" && command === "test") {
    const request = parseProbeRequest(args);
    const owner = new TypeScriptConfigurationOwner(configurationHome(options));
    // `--json` is an explicit script invocation; a human invocation confirms
    // before any probe that could reach the network or consume quota.
    const authorized =
      options.json === true
        ? true
        : await confirmConfigurationProbe(options, request);
    if (options.signal?.aborted)
      throw new ConfigurationProbeError("configuration-test-cancelled");
    const session = await ConfigurationProbeSession.create(
      owner,
      options.probeSeams ?? {},
    );
    try {
      const result = await session.run(request, {
        authorized,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (options.json) {
        // Machine mode: stdout carries only the stable probe result.
        options.stdout?.(`${JSON.stringify(result)}\n`);
      } else if (authorized) {
        // Plain result goes to stdout; the confirmation prompt and the
        // diagnosis line are interaction output and stay on stderr. The
        // readiness snapshot stays visible next to the probe result, but it
        // never decides the outcome.
        const readiness = await owner.status();
        options.stdout?.(
          `${renderConfigurationTest(
            { ...result, readiness },
            themeOption(args),
          )}\n`,
        );
        options.stderr?.(probeDiagnosis(result));
      } else {
        // No probe was authorized, so there is no result to pipe: only the
        // diagnostic on stderr. The stable blocked value stays available to
        // programmatic callers.
        options.stderr?.(probeDiagnosis(result));
      }
      return {
        code: result.outcome === "passed" ? 0 : 3,
        value: result,
      };
    } finally {
      session.close();
    }
  }
  if (group === "metadata" && command === "lookup") {
    const ids = argumentsOf(args, "--literature-id");
    const selected = ids.length
      ? ids
      : (args[2] ?? "").split(",").filter(Boolean);
    if (!selected.length) invalidInput();
    return output(
      await withApplication(options, (app) =>
        runMetadataTask(
          app,
          {
            kind: "lookup",
            literature_ids: selected,
            scan_limit: metadataScanLimit(
              args,
              app.configuration.sources.metadata.limit ?? 500,
            ),
          },
          options.signal,
        ),
      ),
      options,
    );
  }
  if (group === "discover" && command === "topic") {
    const text = argument(args, "--text") ?? args[2] ?? null;
    if (!text) invalidInput();
    const yearFrom = argument(args, "--year-from");
    const yearTo = argument(args, "--year-to");
    const value = await withApplication(options, (app) => {
      const limit = metadataScanLimit(
        args,
        app.configuration.sources.metadata.limit ?? 500,
      );
      return runMetadataTask(
        app,
        {
          kind: "topic",
          query: text,
          year_from:
            yearFrom === null ? null : integerOption(args, "--year-from", 0),
          year_to: yearTo === null ? null : integerOption(args, "--year-to", 0),
          scan_limit: limit,
        },
        options.signal,
      );
    });
    return output(value, options);
  }
  if (
    group === "discover" &&
    (command === "citations" || command === "citation")
  ) {
    const repeatedSeeds = argumentsOf(args, "--seed-literature-id");
    const seeds = (
      repeatedSeeds.length
        ? repeatedSeeds
        : (argument(args, "--seeds") ?? args[2] ?? "").split(",")
    )
      .map((item) => item.trim())
      .filter(Boolean);
    if (!seeds.length) invalidInput();
    const value = await withApplication(options, (app) => {
      const limit = args.includes("--scan-limit")
        ? metadataScanLimit(args, 1)
        : null;
      for (const option of ["--result-limit", "--limit"])
        if (args.includes(option) && argument(args, option) === null)
          invalidInput();
      return runMetadataTask(
        app,
        {
          kind: "citation",
          seed_literature_ids: seeds,
          direction: (argument(args, "--direction") ?? "both") as
            | "references"
            | "cited-by"
            | "both",
          max_depth: integerOption(args, "--max-depth", 1),
          result_limit:
            argument(args, "--result-limit") !== null
              ? integerOption(args, "--result-limit", 1)
              : argument(args, "--limit") !== null
                ? integerOption(args, "--limit", 1)
                : null,
          scan_limit: limit,
        },
        options.signal,
      );
    });
    return output(value, options);
  }
  if (group === "literature" && command === "search") {
    const positionalText =
      args[2] === undefined || args[2].startsWith("--") ? null : args[2];
    const text = argument(args, "--text") ?? positionalText;
    const sort = argument(args, "--sort");
    const value = await withQueryApplication(options, (app) =>
      app.query.search(
        {
          query: query(text, args),
          ...(sort === null ? {} : { sort }),
          limit: integerOption(args, "--limit", 50),
          cursor: argument(args, "--cursor"),
        },
        options.signal,
        "browse",
      ),
    );
    return output(value, options);
  }
  if (group === "literature" && command === "show") {
    const id = args[2];
    if (!id) invalidInput();
    return output(
      await withQueryApplication(options, (app) => app.query.detail(id)),
      options,
    );
  }
  if (
    group === "literature" &&
    (command === "references" || command === "cited-by")
  ) {
    const referenceId = argument(args, "--reference-id");
    if (command === "references" && referenceId) {
      return output(
        await withQueryApplication(options, (app) =>
          app.query.referenceDetail(referenceId),
        ),
        options,
      );
    }
    const id = args[2] ?? argument(args, "--literature-id");
    if (!id) invalidInput();
    return output(
      await withQueryApplication(options, (app) =>
        app.query.references({
          literature_id: id,
          direction: command === "references" ? "references" : "cited-by",
          limit: Number(argument(args, "--limit") ?? 50),
          cursor: argument(args, "--cursor"),
        }),
      ),
      options,
    );
  }
  if (group === "import" && command === "metadata") {
    const legacyFormat = args[2] as BibliographyInputFormat | undefined;
    const legacySource = args[3];
    const path = argument(args, "--format")
      ? args[2]
      : (legacySource ?? args[2]);
    const format = (argument(args, "--format") ??
      legacyFormat) as BibliographyInputFormat | null;
    if (
      !path ||
      !format ||
      !["bibtex", "biblatex", "ris", "csl-json"].includes(format)
    )
      invalidInput();
    const bytes = await inputBytes(path, options);
    const value = await withApplication(options, async (app) => {
      return app.importSessions.importBibliography(
        bytes,
        format,
        path === "-" ? null : (path.split("/").at(-1) ?? format),
        "cli",
      );
    });
    return output(value, options);
  }
  if (group === "import" && command === "pdf") {
    const literatureId = args[2];
    const path = args[3] ?? argument(args, "--path");
    if (!literatureId || !path) invalidInput();
    const value = await withApplication(options, async (app) => {
      if (!app.maintenance)
        throw new Error("maintenance runtime is unavailable");
      const source =
        path === "-"
          ? (options.stdin ?? process.stdin)
          : (async function* () {
              const file = createReadStream(path);
              try {
                for await (const chunk of file) yield chunk as Uint8Array;
              } finally {
                file.destroy();
              }
            })();
      return app.maintenance.ingestPdfStream(
        {
          literature_id: literatureId,
          chunks: source,
          file_name: path === "-" ? "document.pdf" : path.split("/").at(-1)!,
        },
        options.signal,
      );
    });
    return output(value, options);
  }
  if (group === "export" && command === "metadata") {
    if (
      ["bibtex", "biblatex", "ris", "csl-json"].includes(args[2] ?? "") &&
      args[3]
    ) {
      const format = args[2] as BibliographyInputFormat;
      const target = args[3];
      if (target !== "-" && !target.startsWith("/")) invalidInput();
      if (target === "-" && options.json) invalidInput();
      const selected = argumentsOf(args, "--literature-id");
      const discoveryRun = argument(args, "--discovery-run-id");
      const metaIds = argumentsOf(args, "--meta-literature-id");
      const selector: BibliographyExportSelector = selected.length
        ? {
            kind: "literatures",
            literature_ids: selected.map(parseLiteratureId),
          }
        : discoveryRun
          ? {
              kind: "discovery-run",
              discovery_run_id: parseDiscoveryRunId(discoveryRun),
            }
          : metaIds.length
            ? {
                kind: "meta-literatures",
                meta_literature_ids: metaIds.map(parseMetaLiteratureId),
              }
            : {
                kind: "query",
                query: query(argument(args, "--query"), args),
              };
      const prepared = await withQueryApplication(options, (app) =>
        prepareBibliographyExport(app.query, selector, format),
      );
      if (target === "-") {
        options.stdoutBytes?.(prepared.bytes);
        return { code: 0 };
      } else
        await exportBytes(prepared.bytes, target, {
          overwrite: args.includes("--overwrite"),
        });
      return output(
        {
          format,
          exported: prepared.selected_literature_ids.length,
          path: target,
        },
        options,
      );
    }
    const id = args[2];
    if (!id) invalidInput();
    const detail = await withQueryApplication(options, (app) =>
      app.query.detail(id),
    );
    return output(
      {
        literature: detail.literature,
        metadata_sha256: detail.metadata_sha256,
      },
      options,
    );
  }
  if (group === "export" && command === "pdf") {
    const id = args[2];
    const path = argument(args, "--path") ?? args[3];
    if (!id || !path) invalidInput();
    if (path === "-" && options.json) invalidInput();
    if (path === "-") {
      await withQueryApplication(options, async (app) => {
        const detail = await app.query.detail(id);
        const artifact = detail.primary_pdf?.asset;
        if (!artifact) throw new CliBusinessError();
        const chunks: Buffer[] = [];
        await app.literatureArtifacts.withArtifact(artifact, async (stream) => {
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        });
        options.stdoutBytes?.(Buffer.concat(chunks));
      });
      return { code: 0 };
    }
    await withQueryApplication(options, async (app) => {
      const detail = await app.query.detail(id);
      const artifact = detail.primary_pdf?.asset;
      if (!artifact) throw new CliBusinessError();
      await exportArtifact(app.literatureArtifacts, artifact, path, {
        overwrite: args.includes("--overwrite"),
      });
    });
    return output({ literature_id: id, exported: command, path }, options);
  }
  if (group === "complete") {
    const target = args[1];
    if (target !== "pdf" && target !== "parser") invalidInput();
    const explicitIds = argumentsOf(args, "--literature-id");
    const legacyId = argument(args, "--literature");
    const selectorFlags = [
      args.includes("--all-pending"),
      Boolean(argument(args, "--discovery-run-id")),
      argumentsOf(args, "--import-meta-literature-id").length > 0,
      Boolean(argument(args, "--query")),
      argumentsOf(args, "--meta-literature-id").length > 0,
      explicitIds.length > 0 || Boolean(legacyId),
    ].filter(Boolean).length;
    if (selectorFlags !== 1) invalidInput();
    const selector: LiteratureSelector = args.includes("--all-pending")
      ? { kind: "all-pending" }
      : argument(args, "--discovery-run-id")
        ? {
            kind: "discovery-run",
            discovery_run_id: parseDiscoveryRunId(
              argument(args, "--discovery-run-id"),
            ),
          }
        : argumentsOf(args, "--import-meta-literature-id").length
          ? {
              kind: "import-report",
              meta_literature_ids: argumentsOf(
                args,
                "--import-meta-literature-id",
              ).map(parseMetaLiteratureId),
            }
          : argument(args, "--query")
            ? {
                kind: "query",
                query: query(argument(args, "--query"), args),
              }
            : argumentsOf(args, "--meta-literature-id").length
              ? {
                  kind: "meta-literatures",
                  meta_literature_ids: argumentsOf(
                    args,
                    "--meta-literature-id",
                  ).map(parseMetaLiteratureId),
                }
              : {
                  kind: "literatures",
                  literature_ids: (explicitIds.length
                    ? explicitIds
                    : [legacyId!]
                  ).map(parseLiteratureId),
                };
    const transferIds = (argument(args, "--transfers") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    // One Entry-owned orchestration produces the report; the CLI neither owns a
    // target loop, an acquisition transport, nor an ad-hoc result shape. It reuses
    // the single Application-built completion service so the CLI, the durable job
    // runtime and any other frontend share one acquisition port, and it keeps the
    // catalog access boundary unchanged.
    const report = await withApplication(options, async (app) => {
      const service = app.databaseCompletion;
      if (!service)
        throw new Error("database completion runtime is unavailable");
      return service.run(
        {
          selector,
          goal: target === "pdf" ? "ASSET_READY" : "PARSER_RESULT_READY",
          transfer_ids: transferIds,
        },
        {
          signal: options.signal,
          on_progress: (progress) => {
            options.stderr?.(
              `${JSON.stringify({
                progress: "database-completion",
                state: progress.state,
                literature_id: progress.literature_id,
                failure_code: progress.failure?.code ?? null,
              })}\n`,
            );
          },
        },
      );
    });
    options.stdout?.(`${JSON.stringify(report, null, options.json ? 0 : 2)}\n`);
    return {
      code:
        report.end.kind === "interrupted"
          ? 130
          : report.end.kind === "failed"
            ? 3
            : 0,
      value: report,
    };
  }
  if (group === "processors" || group === "processor") {
    const source = argument(args, "--request");
    let request: unknown = source
      ? parseStrictJsonValue(await inputBytes(source, options, 4 * 1024 * 1024))
      : {};
    if (!source && (command === "run" || command === "submit")) {
      const identity = args[2]?.split("@"),
        literature = argument(args, "--literature"),
        snapshot = argument(args, "--snapshot"),
        specFile = argument(args, "--spec");
      if (
        !identity ||
        identity.length !== 2 ||
        !identity[0] ||
        !identity[1] ||
        Boolean(literature) === Boolean(snapshot)
      )
        return invalidInput();
      request = {
        schema_version: 1,
        idempotency_key: argument(args, "--idempotency-key") ?? randomUUID(),
        name: argument(args, "--name") ?? args[2],
        processor: { id: identity[0], version: identity[1] },
        spec: specFile
          ? parseStrictJsonValue(await inputBytes(specFile, options, 262144))
          : {},
        inputs: [
          snapshot
            ? { kind: "snapshot", snapshot_id: snapshot }
            : { kind: "literature", literature_id: literature },
        ],
      };
    }
    const action = command === "result" ? "read" : command;
    if (!source && action === "read") request = { result_id: args[2] };
    if (!source && action === "results")
      request = {
        limit: integerOption(args, "--limit", 50),
        after: argument(args, "--after") ?? "",
        ...(args.includes("--stale") ? { stale: true } : {}),
      };
    if (command === "list")
      return output(await queryProcessors({}, "list", request), options);
    if (command === "retain")
      return output(
        await withApplication(options, async (app) => {
          if (!app.processorRetention) processorError("catalog-v10-required");
          return app.processorRetention.retain(request, options.signal);
        }),
        options,
      );
    if (command === "submit" || command === "run")
      return output(
        await withApplication(options, async (app) => {
          const job = await submitProcessor(
            app,
            request,
            false,
            options.signal,
          );
          if (command === "run") {
            if (!app.processingTasks) processorError("processor-unavailable");
            return app.processingTasks.run(job.job_id, options.signal);
          }
          return job;
        }),
        options,
      );
    if (command === "rebuild")
      return output(
        await withApplication(options, async (app) => {
          if (!app.processors) processorError("catalog-v10-required");
          return app.processors.rebuild();
        }),
        options,
      );
    if (
      PROCESSOR_QUERIES.includes(action as (typeof PROCESSOR_QUERIES)[number])
    )
      return output(
        await withQueryApplication(options, (app) =>
          queryProcessors(app, action!, request),
        ),
        options,
      );
    return invalidInput();
  }
  if (group === "jobs" && command === "submit") {
    const source = argument(args, "--request");
    if (!source) invalidInput();
    const bytes = await inputBytes(source, options, 1024 * 1024 + 4096);
    if (bytes.byteLength > 1024 * 1024 + 4096) invalidInput();
    let request: unknown;
    try {
      request = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return invalidInput();
    }
    return output(
      await withApplication(options, async (app) => {
        if (!app.processingTasks)
          throw new ProcessingTaskError("processing-unavailable");
        return app.processingTasks.submit(request);
      }),
      options,
    );
  }
  if (group === "jobs" && command === "show") {
    const jobId = args[2];
    if (!jobId) invalidInput();
    return output(
      await withQueryApplication(options, async (app) => {
        if (!app.taskRead)
          throw new ProcessingTaskError("processing-unavailable");
        return app.taskRead(jobId);
      }),
      options,
    );
  }
  if (
    group === "jobs" &&
    ["pause", "cancel", "resume", "retry"].includes(command ?? "")
  ) {
    const jobId = args[2];
    if (!jobId) invalidInput();
    return output(
      await withApplication(options, async (app) => {
        if (!app.processingTasks)
          throw new ProcessingTaskError("processing-unavailable");
        return app.processingTasks.control(
          jobId,
          command as "pause" | "cancel" | "resume" | "retry",
        );
      }),
      options,
    );
  }
  if (group === "jobs" && command === "create") {
    const idempotency = argument(args, "--idempotency") ?? `cli-${Date.now()}`;
    const value = await withApplication(options, async (app) => {
      if (!app.jobService) throw new Error("execution runtime is unavailable");
      return app.jobService.create({
        target_kind: "selector",
        selector: {
          kind: "query",
          query: query(argument(args, "--text"), args),
        },
        policy_version: "cli-v1",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: idempotency,
      });
    });
    return output(value, options);
  }
  if (group === "jobs" && command === "run") {
    const jobId = args[2];
    if (!jobId || !/^[A-Za-z0-9._:-]{1,128}$/u.test(jobId)) invalidInput();
    const value = await withApplication(options, async (app) => {
      const job = await app.jobs?.getJob(jobId);
      if (
        app.processingTasks &&
        (job?.selector as { schema_version?: unknown } | undefined)
          ?.schema_version === 3
      )
        return app.processingTasks.run(jobId, options.signal);
      if (app.processingTasks)
        return app.processingTasks.runResults(jobId, options.signal);
      if (!app.taskService) throw new Error("execution runtime is unavailable");
      return app.taskService.runJob(jobId);
    });
    return output({ job_id: jobId, results: value }, options);
  }
  invalidInput();
}

export async function runCli(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const effective = {
    ...options,
    json: options.json ?? args.includes("--json"),
  };
  try {
    return await withoutRestartAdmission(() =>
      withActivity({ actor: machineActor("cli") }, () =>
        execute(
          args.filter((argument) => argument !== "--json"),
          effective,
        ),
      ),
    );
  } catch (error) {
    const corruption = catalogCorruption(error);
    if (corruption) {
      effective.stderr?.(
        `${JSON.stringify({ code: corruption.code, maintenance_hint: corruption.maintenance_hint, technical_details: { sqlite_code: corruption.sqlite_code } })}\n`,
      );
      return { code: 3 };
    }
    const interrupted =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error instanceof MachineWorkbenchError &&
          error.code === "operation-cancelled") ||
        ((isQueryFailure(error) || isMaintenanceFailure(error)) &&
          error.code.endsWith("-cancelled")) ||
        ("code" in error && error.code === "queue-interrupted"));
    const probeCancelled =
      error instanceof ConfigurationProbeError &&
      error.code === "configuration-test-cancelled";
    const probeInvalid =
      error instanceof ConfigurationProbeError &&
      error.code === "configuration-probe-invalid";
    const input =
      error instanceof CliInputError ||
      error instanceof WorkbenchAccessError ||
      error instanceof ContractValidationError ||
      error instanceof TypeError ||
      (error instanceof SourceConfigurationError &&
        error.code === "source-configuration-invalid") ||
      probeInvalid;
    const configuration =
      error instanceof NetworkConfigurationError ||
      error instanceof ConfigurationOwnerError ||
      error instanceof ConfigurationBoundaryError;
    const business =
      error instanceof SourceConfigurationError ||
      error instanceof RestartAdmissionError ||
      error instanceof WebSupervisorError ||
      error instanceof MachineWorkbenchError ||
      isQueryFailure(error) ||
      isMaintenanceFailure(error) ||
      error instanceof CliBusinessError ||
      error instanceof QueryApplicationError ||
      error instanceof ArtifactExportError ||
      error instanceof BibliographyExportError ||
      error instanceof LiteratureNotFoundError;
    const document =
      error instanceof DocumentProcessingError ||
      error instanceof ParsingFailure ||
      error instanceof ArticleIdentityError ||
      error instanceof ProcessingTaskError ||
      error instanceof ProcessorError ||
      error instanceof ProcessorQueryError;
    const catalog = error instanceof CatalogSchemaError;
    const code =
      interrupted || probeCancelled
        ? 130
        : input
          ? 2
          : configuration
            ? 4
            : business || catalog || document
              ? 3
              : 70;
    const failure =
      error instanceof NetworkConfigurationError
        ? error.code
        : error instanceof WorkbenchAccessError
          ? error.code
          : error instanceof SourceConfigurationError ||
              error instanceof RestartAdmissionError ||
              error instanceof WebSupervisorError
            ? error.code
            : error instanceof LiteratureNotFoundError &&
                !args.includes("--request")
              ? "business-failed"
              : isQueryFailure(error) ||
                  isMaintenanceFailure(error) ||
                  error instanceof MachineWorkbenchError
                ? error.code
                : error instanceof DocumentProcessingError ||
                    error instanceof ParsingFailure ||
                    error instanceof ArticleIdentityError ||
                    error instanceof ProcessingTaskError ||
                    error instanceof ProcessorError ||
                    error instanceof ProcessorQueryError
                  ? error.code
                  : error instanceof QueryApplicationError
                    ? error.code
                    : probeCancelled
                      ? "configuration-test-cancelled"
                      : interrupted
                        ? "operation-interrupted"
                        : input
                          ? "invalid-command-input"
                          : configuration
                            ? "configuration-failed"
                            : catalog
                              ? error.code
                              : business
                                ? "business-failed"
                                : "internal-failed";
    effective.stderr?.(
      `${JSON.stringify({
        code: failure,
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
        ...(error instanceof CliInputError && error.nextAction
          ? { next_action: error.nextAction }
          : {}),
        ...(args[0] === "web"
          ? {
              next_action:
                error instanceof WorkbenchAccessError
                  ? error.code === "web-password-required"
                    ? "Set SCIRETRIEVER_WEB_PASSWORD to at least 12 characters, or unset it to generate an API key."
                    : "Use web --port 4174. Optional --host accepts an IPv4 listening address. --origin is no longer needed or supported."
                  : configuration
                    ? "Check sciretriever config status and the configured catalog/artifact paths."
                    : catalog
                      ? "Check the configured catalog parent directory and inspect any existing catalog with sciretriever storage schema-inspect; only the current catalog layout is supported."
                      : "Check the local port, build assets and configuration before restarting Web.",
            }
          : {}),
        ...(error instanceof ProcessorQueryError
          ? { fields: error.fields }
          : {}),
        ...(error instanceof CatalogSchemaError
          ? {
              reason: error.reason,
              ...(error.addition ? { addition: error.addition } : {}),
            }
          : {}),
      })}\n`,
    );
    return { code };
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return (
      (await realpath(process.argv[1])) ===
      (await realpath(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  // SIGINT is the user-controlled stop: it aborts the frozen scope so the
  // running target becomes `interrupted` and the remaining ones keep their
  // single `notStarted` partition instead of vanishing from the run.
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const result = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stdoutBytes: (bytes) => process.stdout.write(bytes),
    stderr: (text) => process.stderr.write(text),
    stdin: process.stdin,
    signal: controller.signal,
  });
  process.exitCode = result.code;
}
