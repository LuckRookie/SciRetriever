import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as applicationBootstrap from "../bootstrap/application.js";
import { DocumentProcessingError } from "../document/service.js";
import { ParsingFailure } from "../parsing/ports.js";
import {
  QueryApplicationError,
  type Application,
  type QueryApplication,
} from "../bootstrap/application.js";
import {
  decodeBibliography,
  importBibliography,
  type BibliographyInputFormat,
} from "../entry/bibliography.js";
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
  ConfigurationOwnerError,
  ConfigurationProbeError,
  ConfigurationProbeSession,
  fixedConfigurationHome,
  TypeScriptConfigurationOwner,
  type ConfigurationProbeRequest,
  type ConfigurationProbeResult,
  type ConfigurationProbeSeams,
} from "../configuration/owner.js";
import { LiteratureNotFoundError } from "../literature/query.js";
import {
  ContractValidationError,
  parseDiscoveryRunId,
  parseLibraryQuery,
  parseLiteratureId,
  parseMetaLiteratureId,
  type LibraryQuery,
} from "@sciretriever/contracts";
import { type LiteratureSelector } from "../entry/selectors.js";
import { runConfigurationCenter } from "./config-center.js";
import {
  renderConfigurationTest,
  renderStatus,
  type ConfigTheme,
} from "./config-ui.js";
import { runDoctor } from "../entry/doctor.js";
import { ConfigurationBoundaryError } from "../configuration/index.js";
import {
  MigrationSafetyError,
  SYNTHETIC_COPY_DECLARATION_FLAG,
} from "../storage/execution/migration-gate.js";
import { CatalogSchemaError } from "../storage/sqlite/migration-scope.js";
import { WriteAdmissionError } from "../storage/write-admission.js";
import { ProcessingTaskError } from "../application/jobs/processing.js";
import { ArticleIdentityError } from "../parsing/article-identity.js";
import {
  acceptPublisherNameMappings,
  type PublisherGovernanceSelector,
} from "../entry/publisher-governance.js";

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
  constructor() {
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

function writeWebPathFailure(options: CliOptions): void {
  options.stderr?.(
    `${JSON.stringify({
      code: "paths-not-ready",
      next_action:
        "Configure both paths.catalog_path and paths.artifact_root through sciretriever config, then explicitly initialize or upgrade the catalog before starting Web.",
    })}\n`,
  );
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
    "Usage: sciretriever <web|discover|complete|literature|import|export|config|storage|maintenance|jobs> ...\n" +
    "  web [--port 4174]  # local task workbench; uses the configured catalog and artifact root\n" +
    "  discover topic QUERY | discover citations --seed-literature-id ID\n" +
    "  complete pdf|content [--literature-id ID] [--transfers ID,...]\n" +
    "  literature search [query options] | show ID | references ID | cited-by ID\n" +
    "  import metadata FORMAT SOURCE | import pdf ID SOURCE\n" +
    "  document parse --literature-id ID --asset-id ID --asset-sha256 SHA256 --mode reuse-current|reparse [--expected-default-revision N]\n" +
    "  export metadata FORMAT OUTPUT | export pdf|content ID --path PATH\n" +
    "  config [--theme auto|dark|light|mono] | config status [--json] [--theme ...] | config test ...\n" +
    "  jobs create [--text QUERY] | jobs submit --request FILE|- | jobs run|show|pause|cancel|resume|retry JOB_ID\n" +
    "  mcp [--maintenance]  # stdio; maintenance tools require this explicit mode\n" +
    "  storage schema-inspect|schema-init --catalog PATH | schema-upgrade --catalog PATH [--dry-run | --backup PATH]\n" +
    "  storage document-inspect|retrieval-inspect|extraction-inspect --catalog PATH | document-migrate|retrieval-migrate|extraction-migrate --catalog PATH [--dry-run | --backup PATH --synthetic-copy]\n" +
    "  maintenance rebuild-index (requires an existing v4 catalog) | rebuild-knowledge-index (requires v8)\n" +
    "  maintenance publisher-names (--all | --literature-id ID... | --query TEXT) [--ai] [--scan-limit N] [--cursor CURSOR] [--max-ai-requests N] [--output PATH]\n" +
    "  maintenance publisher-names-accept --report FILE|- --name NAME [--name NAME...]\n";
  options.stdout?.(text);
  return { code: 0 };
}

async function inputBytes(
  path: string,
  options: CliOptions,
): Promise<Uint8Array> {
  if (path !== "-") return readFile(path);
  const input = options.stdin ?? (process.stdin as AsyncIterable<Uint8Array>);
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
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
    document_types: argumentsOf(args, "--document-type"),
    languages: argumentsOf(args, "--language"),
    keywords: argumentsOf(args, "--keyword"),
    version_roles: argumentsOf(args, "--version-role"),
    statuses: argumentsOf(args, "--status"),
    missing_steps: argumentsOf(args, "--missing-step"),
    needs_manual_pdf: bool ? true : noBool ? false : null,
    discovery_run_ids: argumentsOf(args, "--discovery-run-id"),
  });
}

async function withApplication<T>(
  options: CliOptions,
  action: (application: Application) => Promise<T>,
  executionSchema?: "upgrade-synthetic" | "require-v2" | "inspect",
): Promise<T> {
  const application = await applicationBootstrap.createApplication(
    configurationHome(options),
    { ...(executionSchema ? { executionSchema } : {}) },
  );
  return runAndClose(
    () => action(application),
    () => application.close(),
  );
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
  if (group === "web") {
    const port = args.length === 1 ? 4174 : Number(args[2]);
    if (
      (args.length !== 1 &&
        (args.length !== 3 ||
          command !== "--port" ||
          !/^\d+$/.test(args[2]!))) ||
      !Number.isSafeInteger(port) ||
      port < 0 ||
      port > 65535
    )
      invalidInput();
    if (options.signal?.aborted) return { code: 130 };
    const configurationOwner = new TypeScriptConfigurationOwner(
      configurationHome(options),
    );
    const { paths } = (await configurationOwner.read()).configuration;
    if (!paths.catalog_path || !paths.artifact_root) {
      writeWebPathFailure(options);
      return { code: 4 };
    }
    const { startProductionWorkbench } = await import(
      "../bootstrap/workbench.js"
    );
    const { loadWorkbenchAssets } = await import("../workbench/assets.js");
    const running = await startProductionWorkbench({
      home: configurationHome(options),
      port,
      assets: await loadWorkbenchAssets(),
      applicationOptions: { configurationOwner },
    });
    try {
      output({ mode: "web", url: `${running.origin}/` }, options);
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return { code: 0 };
    } finally {
      await running.close();
    }
  }
  if (group === "mcp") {
    if (args.slice(1).some((v) => v !== "--maintenance")) invalidInput();
    const { runMcpStdio } = await import("../mcp/server.js");
    await runMcpStdio(
      {
        maintenance: args.includes("--maintenance"),
        ...(options.home ? { home: options.home } : {}),
      },
      options.signal,
    );
    return { code: 0 };
  }
  if (
    group === "storage" &&
    (command === "schema-inspect" ||
      command === "schema-init" ||
      command === "schema-upgrade")
  ) {
    const seen = new Set<string>();
    for (let index = 2; index < args.length; index++) {
      const flag = args[index]!;
      if (seen.has(flag)) invalidInput();
      seen.add(flag);
      if (
        flag === "--catalog" ||
        (command === "schema-upgrade" && flag === "--backup")
      ) {
        if (!args[++index]?.startsWith("/")) invalidInput();
      } else if (command !== "schema-upgrade" || flag !== "--dry-run") {
        invalidInput();
      }
    }
    const catalog = argument(args, "--catalog");
    const backup = argument(args, "--backup");
    const dryRun = args.includes("--dry-run");
    if (
      !catalog?.startsWith("/") ||
      (dryRun && backup !== null) ||
      (command === "schema-upgrade" && !dryRun && !backup)
    )
      invalidInput();
    const {
      inspectCatalogSchema,
      initializeCatalogSchema,
      upgradeCatalogSchema,
    } = await import("../storage/sqlite/catalog-schema.js");
    try {
      return output(
        command === "schema-inspect"
          ? await inspectCatalogSchema(catalog)
          : command === "schema-init"
            ? await initializeCatalogSchema(catalog)
            : await upgradeCatalogSchema({
                catalog_path: catalog,
                ...(backup ? { backup_path: backup } : {}),
                dry_run: dryRun,
              }),
        options,
      );
    } catch (error) {
      if (error instanceof CatalogSchemaError) throw error;
      throw new CatalogSchemaError(
        error instanceof WriteAdmissionError
          ? error.code
          : "catalog-schema-operation-failed",
        null,
        { cause: error },
      );
    }
  }
  if (group === "document" && command === "parse") {
    const literatureId = argument(args, "--literature-id");
    const assetId = argument(args, "--asset-id");
    const assetSha = argument(args, "--asset-sha256");
    const mode = argument(args, "--mode");
    const revision = argument(args, "--expected-default-revision");
    if (
      !literatureId ||
      !assetId ||
      !assetSha ||
      (mode !== "reuse-current" && mode !== "reparse")
    )
      invalidInput();
    return output(
      await withApplication(options, (app) =>
        app.documentProcessing.parseDocuments(
          {
            literature_id: literatureId,
            asset_id: assetId,
            asset_sha256: assetSha,
            mode,
            expected_default_revision:
              revision === null
                ? null
                : integerOption(args, "--expected-default-revision", 0),
          },
          options.signal,
        ),
      ),
      options,
    );
  }
  if (group === "storage" && command === "document-inspect") {
    const catalog = argument(args, "--catalog");
    if (!catalog?.startsWith("/")) invalidInput();
    const { inspectDocumentCatalog } = await import(
      "../storage/sqlite/document-migration.js"
    );
    return output(await inspectDocumentCatalog(catalog), options);
  }
  if (group === "storage" && command === "document-migrate") {
    const catalog = argument(args, "--catalog");
    if (!catalog?.startsWith("/")) invalidInput();
    const dryRun = args.includes("--dry-run");
    if (!dryRun && !args.includes(SYNTHETIC_COPY_DECLARATION_FLAG))
      throw new MigrationSafetyError("synthetic-copy-declaration-required");
    const backup = argument(args, "--backup");
    if (!dryRun && !backup?.startsWith("/")) invalidInput();
    const { migrateDocumentCatalog } = await import(
      "../storage/sqlite/document-migration.js"
    );
    return output(
      await migrateDocumentCatalog({
        catalog_path: catalog,
        ...(backup ? { backup_path: backup } : {}),
        dry_run: dryRun,
      }),
      options,
    );
  }
  if (group === "storage" && command === "retrieval-inspect") {
    const catalog = argument(args, "--catalog");
    if (!catalog?.startsWith("/")) invalidInput();
    const { inspectRetrievalCatalog } = await import(
      "../storage/sqlite/retrieval-migration.js"
    );
    return output(await inspectRetrievalCatalog(catalog), options);
  }
  if (group === "storage" && command === "retrieval-migrate") {
    const catalog = argument(args, "--catalog");
    if (!catalog?.startsWith("/")) invalidInput();
    const dryRun = args.includes("--dry-run");
    if (!dryRun && !args.includes(SYNTHETIC_COPY_DECLARATION_FLAG))
      throw new MigrationSafetyError("synthetic-copy-declaration-required");
    const backup = argument(args, "--backup");
    if (!dryRun && !backup?.startsWith("/")) invalidInput();
    const { migrateRetrievalCatalog } = await import(
      "../storage/sqlite/retrieval-migration.js"
    );
    return output(
      await migrateRetrievalCatalog({
        catalog_path: catalog,
        ...(backup ? { backup_path: backup } : {}),
        dry_run: dryRun,
      }),
      options,
    );
  }
  if (group === "storage" && command === "extraction-inspect") {
    const catalog = argument(args, "--catalog");
    if (!catalog?.startsWith("/")) invalidInput();
    const { inspectExtractionCatalog } = await import(
      "../storage/sqlite/extraction-migration.js"
    );
    return output(await inspectExtractionCatalog(catalog), options);
  }
  if (group === "storage" && command === "extraction-migrate") {
    const catalog = argument(args, "--catalog");
    if (!catalog?.startsWith("/")) invalidInput();
    const dryRun = args.includes("--dry-run");
    if (!dryRun && !args.includes(SYNTHETIC_COPY_DECLARATION_FLAG))
      throw new MigrationSafetyError("synthetic-copy-declaration-required");
    const backup = argument(args, "--backup");
    if (!dryRun && !backup?.startsWith("/")) invalidInput();
    const { migrateExtractionCatalog } = await import(
      "../storage/sqlite/extraction-migration.js"
    );
    return output(
      await migrateExtractionCatalog({
        catalog_path: catalog,
        ...(backup ? { backup_path: backup } : {}),
        dry_run: dryRun,
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
  if (group === "maintenance" && command === "rebuild-index") {
    if (args.length !== 2) invalidInput();
    return output(
      await withApplication(
        options,
        async (app) => {
          if (!app.maintenance)
            throw new Error("maintenance runtime is unavailable");
          return app.maintenance.rebuildIndex(options.signal);
        },
        "require-v2",
      ),
      options,
    );
  }
  if (group === "maintenance" && command === "rebuild-knowledge-index") {
    if (args.length !== 2) invalidInput();
    return output(
      await withApplication(
        options,
        async (app) => {
          if (!app.maintenance?.rebuildKnowledgeIndex)
            throw new Error(
              "knowledge index maintenance is unavailable; catalog v8 is required",
            );
          return app.maintenance.rebuildKnowledgeIndex(options.signal);
        },
        "require-v2",
      ),
      options,
    );
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
  if (group === "storage" && command === "migrate") {
    if (args.includes("--dry-run")) {
      // `inspect` verifies an already identifiable catalog read-only, so a
      // dry-run neither creates nor migrates a target.
      const value = await withApplication(
        options,
        (app) => app.database.migrateExecutionRuntime(true),
        "inspect",
      );
      return output(value, options);
    }
    // The command and its declaration are not proof: the assembly gate still
    // verifies that the target is a synthetic copy before anything is written.
    if (!args.includes(SYNTHETIC_COPY_DECLARATION_FLAG))
      throw new MigrationSafetyError("synthetic-copy-declaration-required");
    const value = await withApplication(
      options,
      async (app) => {
        if (!app.jobs)
          throw new MigrationSafetyError("migration-target-unverified");
        return app.jobs.migrate(false);
      },
      "upgrade-synthetic",
    );
    return output(
      {
        ...value.inspection,
        action: "migrated",
        migration: value,
      },
      options,
    );
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
      return app.discovery.run({
        query: text,
        year_from:
          yearFrom === null ? null : integerOption(args, "--year-from", 0),
        year_to: yearTo === null ? null : integerOption(args, "--year-to", 0),
        providers: app.metadata.topic_selection.map((provider_name) => ({
          provider_name,
          scan_limit: limit,
        })),
      });
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
      const limit = metadataScanLimit(
        args,
        app.configuration.sources.metadata.limit ?? 500,
      );
      return app.citations.run({
        seed_literature_ids: seeds,
        direction: (argument(args, "--direction") ?? "both") as
          | "references"
          | "cited-by"
          | "both",
        max_depth: integerOption(args, "--max-depth", 1),
        result_limit: integerOption(
          args,
          "--result-limit",
          integerOption(args, "--limit", 1000),
        ),
        providers: app.metadata.reference_selection.map((provider_name) => ({
          provider_name,
          scan_limit: limit,
        })),
      });
    });
    return output(value, options);
  }
  if (group === "literature" && command === "search") {
    const positionalText =
      args[2] === undefined || args[2].startsWith("--") ? null : args[2];
    const text = argument(args, "--text") ?? positionalText;
    const value = await withQueryApplication(options, (app) =>
      app.query.search({
        query: query(text, args),
        sort: (argument(args, "--sort") ?? "publication-year-desc") as
          | "publication-year-desc"
          | "publication-year-asc"
          | "title-asc"
          | "title-desc"
          | "relevance",
        limit: integerOption(args, "--limit", 50),
        cursor: argument(args, "--cursor"),
      }),
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
      const decoded = decodeBibliography(bytes, format);
      return importBibliography(decoded, app.identity);
    });
    return output(value, options);
  }
  if (group === "import" && command === "pdf") {
    const literatureId = args[2];
    const path = args[3] ?? argument(args, "--path");
    if (!literatureId || !path) invalidInput();
    const bytes = await inputBytes(path, options);
    const ingest = async (schema: "require-v2" | "upgrade-synthetic") =>
      withApplication(
        options,
        async (app) => {
          if (!app.maintenance)
            throw new Error("maintenance runtime is unavailable");
          return app.maintenance.ingestPdf(
            { literature_id: literatureId, bytes },
            options.signal,
          );
        },
        schema,
      );
    let value;
    try {
      value = await ingest("require-v2");
    } catch (error) {
      if (
        !(error instanceof MigrationSafetyError) ||
        error.code !== "migration-target-v1"
      )
        throw error;
      value = await ingest("upgrade-synthetic");
    }
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
  if (group === "export" && (command === "pdf" || command === "content")) {
    const id = args[2];
    const path = argument(args, "--path") ?? args[3];
    if (!id || !path) invalidInput();
    if (path === "-" && options.json) invalidInput();
    if (path === "-") {
      await withQueryApplication(options, async (app) => {
        const detail = await app.query.detail(id);
        const artifact =
          command === "pdf"
            ? detail.primary_pdf?.asset
            : detail.content
              ? {
                  sha256: detail.content.markdown.sha256,
                  byte_size: detail.content.markdown.byte_size,
                  media_type: detail.content.markdown.media_type,
                }
              : null;
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
      const artifact =
        command === "pdf"
          ? detail.primary_pdf?.asset
          : detail.content
            ? {
                sha256: detail.content.markdown.sha256,
                byte_size: detail.content.markdown.byte_size,
                media_type: detail.content.markdown.media_type,
              }
            : null;
      if (!artifact) throw new CliBusinessError();
      await exportArtifact(app.literatureArtifacts, artifact, path, {
        overwrite: args.includes("--overwrite"),
      });
    });
    return output({ literature_id: id, exported: command, path }, options);
  }
  if (group === "complete") {
    const target = args[1];
    if (target !== "pdf" && target !== "content") invalidInput();
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
    // t17 migration gate untouched.
    const report = await withApplication(
      options,
      async (app) => {
        const service = app.databaseCompletion;
        if (!service)
          throw new Error("database completion runtime is unavailable");
        return service.run(
          {
            selector,
            goal: target === "pdf" ? "ASSET_READY" : "CONTENT_READY",
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
      },
      "require-v2",
    );
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
  if (group === "jobs" && command === "submit") {
    const source = argument(args, "--request");
    if (!source) invalidInput();
    const bytes = await inputBytes(source, options);
    if (bytes.byteLength > 1024 * 1024) invalidInput();
    let request: unknown;
    try {
      request = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return invalidInput();
    }
    return output(
      await withApplication(
        options,
        async (app) => {
          if (!app.processingTasks)
            throw new ProcessingTaskError("processing-unavailable");
          return app.processingTasks.submit(request);
        },
        "require-v2",
      ),
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
      await withApplication(
        options,
        async (app) => {
          if (!app.processingTasks)
            throw new ProcessingTaskError("processing-unavailable");
          return app.processingTasks.control(
            jobId,
            command as "pause" | "cancel" | "resume" | "retry",
          );
        },
        "require-v2",
      ),
      options,
    );
  }
  if (group === "jobs" && command === "create") {
    const idempotency = argument(args, "--idempotency") ?? `cli-${Date.now()}`;
    const value = await withApplication(
      options,
      async (app) => {
        if (!app.jobService)
          throw new Error("execution runtime is unavailable");
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
      },
      "require-v2",
    );
    return output(value, options);
  }
  if (group === "jobs" && command === "run") {
    const jobId = args[2];
    if (!jobId || !/^[A-Za-z0-9._:-]{1,128}$/u.test(jobId)) invalidInput();
    const value = await withApplication(
      options,
      async (app) => {
        const job = await app.jobs?.getJob(jobId);
        if (
          app.processingTasks &&
          (job?.selector as { schema_version?: unknown } | undefined)
            ?.schema_version === 3
        )
          return app.processingTasks.run(jobId, options.signal);
        if (app.processingTasks)
          return app.processingTasks.runResults(jobId, options.signal);
        if (!app.taskService)
          throw new Error("execution runtime is unavailable");
        return app.taskService.runJob(jobId);
      },
      "require-v2",
    );
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
    return await execute(
      args.filter((argument) => argument !== "--json"),
      effective,
    );
  } catch (error) {
    const interrupted =
      error instanceof Error &&
      (error.name === "AbortError" ||
        ("code" in error && error.code === "queue-interrupted"));
    const probeCancelled =
      error instanceof ConfigurationProbeError &&
      error.code === "configuration-test-cancelled";
    const probeInvalid =
      error instanceof ConfigurationProbeError &&
      error.code === "configuration-probe-invalid";
    const input =
      error instanceof CliInputError ||
      error instanceof ContractValidationError ||
      error instanceof TypeError ||
      probeInvalid;
    const configuration =
      error instanceof ConfigurationOwnerError ||
      error instanceof ConfigurationBoundaryError;
    const business =
      error instanceof CliBusinessError ||
      error instanceof QueryApplicationError ||
      error instanceof ArtifactExportError ||
      error instanceof BibliographyExportError ||
      error instanceof LiteratureNotFoundError;
    const document =
      error instanceof DocumentProcessingError ||
      error instanceof ParsingFailure ||
      error instanceof ArticleIdentityError ||
      error instanceof ProcessingTaskError;
    const migration =
      error instanceof CatalogSchemaError ||
      error instanceof MigrationSafetyError ||
      (error instanceof Error &&
        "code" in error &&
        error.code === "document-migration");
    const code =
      interrupted || probeCancelled
        ? 130
        : input
          ? 2
          : configuration
            ? 4
            : business || migration || document
              ? 3
              : 70;
    const failure =
      error instanceof DocumentProcessingError ||
      error instanceof ParsingFailure ||
      error instanceof ArticleIdentityError ||
      error instanceof ProcessingTaskError
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
                  : migration
                    ? "migration-refused"
                    : business
                      ? "business-failed"
                      : "internal-failed";
    effective.stderr?.(
      `${JSON.stringify({
        code: failure,
        ...(args[0] === "web"
          ? {
              next_action: configuration
                ? "Check sciretriever config status and the configured catalog/artifact paths."
                : migration
                  ? "Inspect the configured catalog with sciretriever storage schema-inspect; initialize or upgrade it explicitly before starting Web."
                  : "Check the local port, build assets and configuration before restarting Web.",
            }
          : {}),
        ...(error instanceof CatalogSchemaError
          ? { reason: error.reason, progress: error.progress }
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
