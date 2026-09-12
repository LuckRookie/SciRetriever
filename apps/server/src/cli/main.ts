import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createApplication,
  type Application,
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
  TypeScriptConfigurationOwner,
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
import {
  selectLiteratures,
  type LiteratureSelector,
} from "../entry/selectors.js";
import { runConfigurationCenter } from "./config-center.js";
import { runDoctor } from "../entry/doctor.js";

export interface CliOptions {
  readonly home?: string;
  readonly stdout?: (text: string) => void;
  readonly stdoutBytes?: (bytes: Uint8Array) => void;
  readonly stderr?: (text: string) => void;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly json?: boolean;
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

const DEFAULT_HOME = () =>
  process.env.SCIRETRIEVER_HOME ?? join(tmpdir(), "sciretriever-cli");

function output(value: unknown, options: CliOptions): CliResult {
  const text = `${JSON.stringify(value, null, options.json ? 0 : 2)}\n`;
  options.stdout?.(text);
  return { code: 0, value };
}

function usage(options: CliOptions): CliResult {
  const text =
    "Usage: sciretriever <discover|complete|literature|import|export|config|storage|jobs> ...\n" +
    "  discover topic QUERY | discover citations --seed-literature-id ID\n" +
    "  complete pdf|content [--literature-id ID] [--transfers ID,...]\n" +
    "  literature search [query options] | show ID | references ID | cited-by ID\n" +
    "  import metadata FORMAT SOURCE | import pdf ID SOURCE\n" +
    "  export metadata FORMAT OUTPUT | export pdf|content ID --path PATH\n" +
    "  jobs create [--text QUERY] | jobs run JOB_ID\n";
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
  executionSchema?: "upgrade-synthetic" | "require-v2",
): Promise<T> {
  const application = await createApplication(options.home ?? DEFAULT_HOME(), {
    ...(executionSchema ? { executionSchema } : {}),
  });
  try {
    return await action(application);
  } finally {
    await application.close();
  }
}

async function execute(
  args: readonly string[],
  options: CliOptions,
): Promise<CliResult> {
  if (!args.length || args[0] === "--help" || args[0] === "-h")
    return usage(options);
  const [group, command] = args;
  if (group === "doctor" && command === undefined)
    return output(await runDoctor(), options);
  if (group === "storage" && command === "inspect") {
    const value = await withApplication(options, (app) =>
      app.database.inspectExecutionRuntime(),
    );
    return output(value, options);
  }
  if (group === "storage" && command === "migrate") {
    const dryRun = args.includes("--dry-run");
    if (dryRun) {
      const value = await withApplication(
        options,
        (app) =>
          app.jobs?.migrate(true) ?? app.database.migrateExecutionRuntime(true),
      );
      return output(value, options);
    }
    const value = await withApplication(
      options,
      async (app) => {
        await app.database.upgradeExecutionSchema();
        return app.database.migrateExecutionRuntime(false);
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
    await withApplication(
      options,
      async (app) => {
        await app.database.upgradeExecutionSchema();
        await app.database.backup(path);
      },
      "upgrade-synthetic",
    );
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
    const value = await new TypeScriptConfigurationOwner(
      options.home ?? DEFAULT_HOME(),
    ).status();
    return output(value, options);
  }
  if (group === "config" && command === undefined) {
    return {
      code: await runConfigurationCenter(
        new TypeScriptConfigurationOwner(options.home ?? DEFAULT_HOME()),
        options,
      ),
    };
  }
  if (group === "config" && command === "test") {
    const owner = args[2] ?? null;
    const browserTarget = owner === "browser" ? (args[3] ?? null) : null;
    const target =
      owner === "browser" && browserTarget === "site"
        ? args[4] && !args[4].startsWith("--")
          ? args[4]
          : argument(args, "--target")
        : args[3] && !args[3].startsWith("--")
          ? args[3]
          : argument(args, "--target");
    const validOwners = new Set([
      "provider",
      "model",
      "search",
      "download",
      "parse",
      "analyze",
      "browser-model",
      "browser-site",
      "all",
    ]);
    const normalizedOwner =
      owner === "browser" && browserTarget === "model"
        ? "browser-model"
        : owner === "browser" && browserTarget === "site"
          ? "browser-site"
          : owner;
    if (!normalizedOwner || !validOwners.has(normalizedOwner)) invalidInput();
    if (
      ["provider", "model", "browser-site"].includes(normalizedOwner) &&
      !target
    )
      invalidInput();
    if (
      ["search", "download"].includes(normalizedOwner) &&
      !target &&
      !args.includes("--all")
    )
      invalidInput();
    const value = await withApplication(options, async (app) => {
      const readiness = await new TypeScriptConfigurationOwner(
        app.home,
      ).status();
      const selected = readiness.items.filter((item) => {
        if (normalizedOwner === "provider")
          return item.owner === "model-provider" && item.target === target;
        if (normalizedOwner === "model")
          return item.owner === "analyze" && item.target === "content";
        if (normalizedOwner === "parse") return item.owner === "parsing";
        if (normalizedOwner === "analyze") return item.owner === "analyze";
        if (normalizedOwner === "browser-model")
          return item.owner === "browser";
        return false;
      });
      const sourceStatuses =
        normalizedOwner === "search"
          ? app.metadata.statuses
          : normalizedOwner === "download"
            ? app.acquisition.statuses
            : [];
      const sourceItems = target
        ? sourceStatuses.filter((item) =>
            "source_name" in item
              ? item.source_name === target
              : item.provider_name === target,
          )
        : sourceStatuses;
      const configured =
        normalizedOwner === "provider"
          ? Boolean(target && app.configuration.providers[target])
          : normalizedOwner === "model"
            ? Boolean(target && app.configuration.models[target])
            : normalizedOwner === "search" || normalizedOwner === "download"
              ? sourceItems.length > 0 &&
                sourceItems.every((item) => item.ready)
              : normalizedOwner === "browser-site"
                ? false
                : normalizedOwner === "all"
                  ? readiness.items.every((item) => item.state === "ready")
                  : selected.length > 0 &&
                    selected.every((item) => item.state === "ready");
      return {
        owner: normalizedOwner,
        target,
        outcome: configured ? "passed" : "blocked",
        network_performed: false,
        browser_launched: false,
        readiness,
      };
    });
    return output(value, options);
  }
  if (group === "discover" && command === "topic") {
    const text = argument(args, "--text") ?? args[2] ?? null;
    if (!text) invalidInput();
    const limit = integerOption(args, "--scan-limit", 500);
    const yearFrom = argument(args, "--year-from");
    const yearTo = argument(args, "--year-to");
    const value = await withApplication(options, (app) =>
      app.discovery.run({
        query: text,
        year_from:
          yearFrom === null ? null : integerOption(args, "--year-from", 0),
        year_to: yearTo === null ? null : integerOption(args, "--year-to", 0),
        providers: app.metadata.topic_selection.map((provider_name) => ({
          provider_name,
          scan_limit: limit,
        })),
      }),
    );
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
    const limit = integerOption(args, "--scan-limit", 500);
    const value = await withApplication(options, (app) =>
      app.citations.run({
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
      }),
    );
    return output(value, options);
  }
  if (group === "literature" && command === "search") {
    const positionalText =
      args[2] === undefined || args[2].startsWith("--") ? null : args[2];
    const text = argument(args, "--text") ?? positionalText;
    const value = await withApplication(options, (app) =>
      app.library.search({
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
      await withApplication(options, (app) => app.library.detail(id)),
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
        await withApplication(options, (app) =>
          app.library.referenceDetail(referenceId),
        ),
        options,
      );
    }
    const id = args[2] ?? argument(args, "--literature-id");
    if (!id) invalidInput();
    return output(
      await withApplication(options, (app) =>
        app.library.references({
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
    const value = await withApplication(
      options,
      async (app) => {
        if (!app.execution) throw new Error("execution runtime is unavailable");
        const detail = await app.library.detail(literatureId);
        const transferId = `cli-import-${Date.now()}`;
        await app.execution.transfers.begin(
          transferId,
          Math.max(bytes.byteLength, 1),
          {
            session_id: "cli-import",
            article_id: literatureId,
            page_id: "cli-import",
            document_generation: 0,
            source_url: "https://sciretriever.local/import",
            captured_at: new Date().toISOString(),
          },
        );
        try {
          await app.execution.transfers.append(transferId, bytes);
          await app.execution.transfers.complete(transferId);
          return await app.execution.acceptance.accept({
            literature_id: literatureId,
            transfer_id: transferId,
            receipt_id: `cli-import-receipt-${Date.now()}`,
            metadata_snapshot: {
              revision: detail.metadata_revision,
              sha256: detail.metadata_sha256,
            },
          });
        } catch (error) {
          await app.execution.transfers
            .discard(transferId)
            .catch(() => undefined);
          throw error;
        }
      },
      "upgrade-synthetic",
    );
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
      const prepared = await withApplication(options, (app) =>
        prepareBibliographyExport(app.library, selector, format),
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
    const detail = await withApplication(options, (app) =>
      app.library.detail(id),
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
      await withApplication(options, async (app) => {
        const detail = await app.library.detail(id);
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
    await withApplication(options, async (app) => {
      const detail = await app.library.detail(id);
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
    const value = await withApplication(
      options,
      async (app) => {
        const selected = await selectLiteratures(app.library, selector);
        const ids = selected.items.map((item) => item.literature.literature_id);
        if (!ids.length)
          return { goal: target, outcome: "selector_empty", items: [] };
        if (ids.length === 1 && target === "content") {
          const id = ids[0]!;
          if (!app.completion)
            throw new Error("completion runtime is unavailable");
          return app.completion.complete({
            literature_id: id,
            transfer_ids: transferIds,
          });
        }
        const items: unknown[] = [];
        for (const id of ids) {
          if (target === "content") {
            if (!app.completion)
              throw new Error("completion runtime is unavailable");
            items.push(
              await app.completion.complete({
                literature_id: id,
                transfer_ids: transferIds,
              }),
            );
            continue;
          }
          const detail = await app.library.detail(id);
          if (detail.primary_pdf) {
            items.push({
              outcome: "pdf_ready",
              literature_id: id,
              asset: detail.primary_pdf.asset,
              attempts: [],
            });
            continue;
          }
          const attempts: { transfer_id: string; outcome: string }[] = [];
          let completed: unknown = null;
          for (const transferId of transferIds) {
            const candidate = await app.database.getCandidate(transferId);
            if (!candidate) {
              attempts.push({
                transfer_id: transferId,
                outcome: "candidate_missing",
              });
              continue;
            }
            try {
              const accepted = await app.execution!.acceptance.accept({
                literature_id: id,
                transfer_id: transferId,
                receipt_id: `cli-complete:${Date.now()}:${transferId}`,
                metadata_snapshot: {
                  revision: detail.metadata_revision,
                  sha256: detail.metadata_sha256,
                },
              });
              completed = {
                outcome: "pdf_ready",
                literature_id: id,
                asset: {
                  asset_id: accepted.asset_id,
                  sha256: accepted.sha256,
                  path: accepted.reference,
                },
                attempts: [
                  ...attempts,
                  { transfer_id: transferId, outcome: "accepted" },
                ],
              };
              break;
            } catch {
              attempts.push({
                transfer_id: transferId,
                outcome: "candidate_failed",
              });
            }
          }
          items.push(
            completed ?? {
              outcome: "supplied_candidates_exhausted",
              literature_id: id,
              attempts,
            },
          );
        }
        return { goal: target, items };
      },
      "require-v2",
    );
    return output(value, options);
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
    const input =
      error instanceof CliInputError ||
      error instanceof ContractValidationError ||
      error instanceof TypeError;
    const configuration = error instanceof ConfigurationOwnerError;
    const business =
      error instanceof CliBusinessError ||
      error instanceof ArtifactExportError ||
      error instanceof BibliographyExportError ||
      error instanceof LiteratureNotFoundError;
    const code = interrupted
      ? 130
      : input
        ? 2
        : configuration
          ? 4
          : business
            ? 3
            : 70;
    const failure = interrupted
      ? "operation-interrupted"
      : input
        ? "invalid-command-input"
        : configuration
          ? "configuration-failed"
          : business
            ? "business-failed"
            : "internal-failed";
    effective.stderr?.(`${JSON.stringify({ code: failure })}\n`);
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
  const result = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stdoutBytes: (bytes) => process.stdout.write(bytes),
    stderr: (text) => process.stderr.write(text),
    stdin: process.stdin,
  });
  process.exitCode = result.code;
}
