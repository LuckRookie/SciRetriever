import {
  parseConfigurationReadiness,
  type ConfigurationReadiness,
} from "@sciretriever/contracts";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assemblePublicAcquisitionRegistry,
  type PublicAcquisitionAssemblyOptions,
} from "../acquisition/assembly.js";
import type { PublicAcquisitionRegistry } from "../acquisition/sources/public.js";
import {
  ANTHROPIC_API_VERSION_HEADER,
  credentialHeader,
  type AgentWireProtocol,
} from "../agents/common.js";
import {
  createProbeAgentRuntime,
  executeProbeImage,
  executeProbeText,
  ProbeModelError,
  resolveProbeModelTarget,
  type ProbeModelTarget,
} from "../agents/probe.js";
import {
  AgentFailure,
  type AgentCapability,
  type AgentRole,
  type AgentTransport,
} from "../agents/protocol.js";
import { resolveVerifiedCloakRuntime } from "../browser/production-host.js";
import {
  BrowserSiteProbeError,
  createProductionBrowserSiteProbe,
  PRODUCTION_BROWSER_SITE_ACCESS_KEYS,
} from "../browser/site-probe.js";
import {
  assembleMetadataRegistry,
  type MetadataAssemblyOptions,
} from "../metadata/assembly.js";
import type { MetadataRegistry } from "../metadata/registry.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import type { ConnectionDependencies } from "../network/connection.js";
import { NetworkHttpError } from "../network/http.js";
import { NetworkPolicyError, type Resolver } from "../network/policy.js";
import { ProbeRequestError, readOnlyProbeRequest } from "../network/probe.js";
import {
  createMinerUHealthProbe,
  MinerUHealthError,
  type MinerUHealthProbe,
} from "../parsing/backends/mineru/health.js";
import { ParsingFailure } from "../parsing/ports.js";
import { LITERATURE_PROVIDERS } from "../providers/registry.js";
import { acquireFileLock } from "../storage/locking.js";
import {
  bundlePreview,
  CredentialBoundaryError,
  editCredentialBundle,
  issueCredentialGrant,
  issueProviderCredentialGrant,
  loadCredentialBundle,
  publishCredentialText,
  readCredential,
  readProviderCredential,
  type CredentialBundle,
  type CredentialEdit,
  type CredentialReadRequest,
} from "./credentials.js";
import {
  ConfigurationBoundaryError,
  configurationPath,
  loadConfiguration,
  parseConfiguration,
  publishConfiguration,
  type OrdinaryConfiguration,
} from "./index.js";

export class ConfigurationOwnerError extends Error {
  constructor(
    readonly code:
      | "configuration-invalid"
      | "configuration-conflict"
      | "configuration-cancelled",
  ) {
    super("configuration owner operation failed");
    this.name = "ConfigurationOwnerError";
  }
}

export type ConfigurationSection =
  | "sources"
  | "providers"
  | "models"
  | "analyze"
  | "browser"
  | "parsing";

export interface TypeScriptConfigurationSnapshot {
  readonly revision: string;
  readonly configuration: OrdinaryConfiguration;
}

export interface TypeScriptConfigurationDiff
  extends TypeScriptConfigurationSnapshot {
  readonly changed_fields: readonly string[];
}

export type TypeScriptCredentialEdit = CredentialEdit;

const MAX_BYTES = 1_048_576;
const SECTIONS = new Set<ConfigurationSection>([
  "sources",
  "providers",
  "models",
  "analyze",
  "browser",
  "parsing",
]);

export function isConfigurationSection(
  value: unknown,
): value is ConfigurationSection {
  return (
    typeof value === "string" && SECTIONS.has(value as ConfigurationSection)
  );
}

function invalid(): never {
  throw new ConfigurationOwnerError("configuration-invalid");
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ConfigurationOwnerError("configuration-cancelled");
}

function revision(value: unknown): string {
  if (
    typeof value !== "string" ||
    (value !== "missing" && !/^[0-9a-f]{64}$/u.test(value))
  )
    invalid();
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function scalar(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  invalid();
}

function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== null && item !== undefined,
    );
    return `{ ${entries
      .map(([key, item]) => `${quote(key)} = ${inline(item)}`)
      .join(", ")} }`;
  }
  return scalar(value);
}

function sourceTomlKey(parent: readonly string[], key: string): string {
  if (
    parent[0] === "sources" &&
    parent[1] === "metadata" &&
    parent.length === 2 &&
    key === "web_of_science"
  )
    return "web-of-science";
  if (
    parent[0] === "sources" &&
    parent[1] === "acquisition" &&
    parent.length === 2 &&
    key === "sci_hub"
  )
    return "sci-hub";
  return key;
}

function writeTable(
  lines: string[],
  path: readonly string[],
  value: Record<string, unknown>,
): void {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== null && item !== undefined,
  );
  if (!entries.length) return;
  lines.push(
    `[${path
      .map((key, index) => quote(sourceTomlKey(path.slice(0, index), key)))
      .join(".")}]`,
  );
  for (const [key, item] of entries) {
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      continue;
    lines.push(`${quote(sourceTomlKey(path, key))} = ${inline(item)}`);
  }
  lines.push("");
  for (const [key, item] of entries) {
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      writeTable(lines, [...path, key], item as Record<string, unknown>);
  }
}

function renderConfiguration(configuration: OrdinaryConfiguration): string {
  const lines: string[] = [];
  const root = configuration as unknown as Record<string, unknown>;
  for (const section of [
    "paths",
    "sources",
    "parsing",
    "analyze",
    "browser",
    "execution",
    "library",
  ] as const)
    writeTable(lines, [section], root[section] as Record<string, unknown>);
  for (const [provider, value] of Object.entries(configuration.providers))
    writeTable(
      lines,
      ["providers", provider],
      value as unknown as Record<string, unknown>,
    );
  for (const [model, value] of Object.entries(configuration.models))
    writeTable(
      lines,
      ["models", model],
      value as unknown as Record<string, unknown>,
    );
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Serialize a validated ordinary configuration for the configuration owner. */
export function renderConfigurationText(
  configuration: OrdinaryConfiguration,
): string {
  return renderConfiguration(configuration);
}

function renderSections(
  configuration: OrdinaryConfiguration,
  sections: readonly ConfigurationSection[],
): string {
  const lines: string[] = [];
  const root = configuration as unknown as Record<string, unknown>;
  for (const section of sections) {
    if (section === "providers" || section === "models") continue;
    writeTable(lines, [section], root[section] as Record<string, unknown>);
  }
  if (sections.includes("providers"))
    for (const [provider, value] of Object.entries(configuration.providers))
      writeTable(
        lines,
        ["providers", provider],
        value as unknown as Record<string, unknown>,
      );
  if (sections.includes("models"))
    for (const [model, value] of Object.entries(configuration.models))
      writeTable(
        lines,
        ["models", model],
        value as unknown as Record<string, unknown>,
      );
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Replace only owned TOML table blocks and retain comments/unknown sections. */
function mergeConfigurationText(
  current: string,
  candidate: OrdinaryConfiguration,
  sections: readonly ConfigurationSection[],
): string {
  const owned = new Set(sections);
  const lines = current.split(/(?<=\n)/u);
  const kept: string[] = [];
  let removing = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\n)?$/u.exec(line);
    if (header) {
      const path = header[1]!.split(".")[0]!.replace(/^['"]|['"]$/gu, "");
      removing = owned.has(path as ConfigurationSection);
    }
    if (!removing) kept.push(line);
  }
  const prefix = kept.join("").replace(/\s*$/u, "");
  const update = renderSections(candidate, sections);
  return `${prefix}${prefix ? "\n\n" : ""}${update}`;
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length && a.every((item, index) => same(item, b[index]))
    );
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = Object.entries(a as Record<string, unknown>);
    const right = Object.entries(b as Record<string, unknown>);
    return (
      left.length === right.length &&
      left.every(
        ([key, value]) =>
          Object.prototype.hasOwnProperty.call(b, key) &&
          same(value, (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

function changed(
  before: unknown,
  after: unknown,
  prefix: string,
  output: string[],
): void {
  if (same(before, after)) return;
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    for (const key of [...keys].sort())
      changed(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        `${prefix}.${key}`,
        output,
      );
    return;
  }
  output.push(prefix);
}

async function ensureHome(home: string): Promise<void> {
  if (!home.startsWith("/")) invalid();
  await mkdir(join(resolve(home), ".sciretriever"), {
    recursive: true,
    mode: 0o700,
  });
}

async function readBytes(home: string): Promise<Uint8Array | null> {
  const path = configurationPath(home);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
      invalid();
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_BYTES) invalid();
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ConfigurationOwnerError) throw error;
    invalid();
  }
}

async function snapshot(
  home: string,
): Promise<TypeScriptConfigurationSnapshot> {
  await ensureHome(home);
  const bytes = await readBytes(home);
  if (bytes === null)
    return { revision: "missing", configuration: parseConfiguration("") };
  const configuration = await loadConfiguration(home);
  return { revision: digest(bytes), configuration };
}

function checkSections(sections: readonly ConfigurationSection[]): void {
  if (
    sections.length === 0 ||
    new Set(sections).size !== sections.length ||
    sections.some((section) => !SECTIONS.has(section))
  )
    invalid();
}

function sectionValue(
  configuration: OrdinaryConfiguration,
  section: ConfigurationSection,
): unknown {
  return configuration[section];
}

function readiness(
  configuration: OrdinaryConfiguration,
  preview: ReturnType<typeof bundlePreview>,
): ConfigurationReadiness {
  const items: ConfigurationReadiness["items"][number][] = [];
  const add = (
    owner: ConfigurationReadiness["items"][number]["owner"],
    target: string,
    ready: boolean,
    code: string,
    next_action: ConfigurationReadiness["items"][number]["next_action"],
    state: ConfigurationReadiness["items"][number]["state"] = ready
      ? "ready"
      : "blocked",
  ) => {
    items.push({
      owner,
      target,
      state,
      code: ready ? "local-ready" : code,
      next_action: ready ? "none" : next_action,
    });
  };
  add(
    "storage",
    "catalog",
    true,
    "storage-configuration-incomplete",
    "configure",
  );
  let parserCredential = false;
  try {
    parserCredential = preview.sections.some(
      (section) =>
        section.section === "mineru" &&
        section.origin === serviceOrigin(configuration.parsing.base_url),
    );
  } catch {
    parserCredential = false;
  }
  const parserConfigured =
    configuration.parsing.base_url !== null &&
    configuration.parsing.model_identity !== null;
  add(
    "parsing",
    "mineru",
    parserConfigured &&
      (configuration.parsing.connection_mode !== "remote" || parserCredential),
    "parser-configuration-incomplete",
    parserConfigured ? "set-credential" : "configure",
  );
  add(
    "analyze",
    "content",
    configuration.analyze.model !== null,
    "analysis-configuration-incomplete",
    "configure",
  );
  add(
    "analyze",
    "reference",
    configuration.analyze.model !== null,
    "analysis-configuration-incomplete",
    "configure",
  );
  if (configuration.browser.enabled)
    add(
      "browser",
      "model",
      configuration.browser.model !== null,
      "browser-model-unavailable",
      "select-model",
    );
  for (const provider of Object.keys(configuration.providers).sort()) {
    let present = false;
    try {
      const expectedOrigin = serviceOrigin(
        configuration.providers[provider]?.base_url ?? null,
      );
      present = preview.sections.some(
        (section) =>
          section.section === `providers.${provider}` &&
          section.origin === expectedOrigin,
      );
    } catch {
      present = false;
    }
    add(
      "model-provider",
      provider,
      present,
      "model-credential-unavailable",
      "set-credential",
    );
  }
  return parseConfigurationReadiness({
    version: 1,
    network_performed: false,
    browser_launched: false,
    items,
    credentials: {
      sources: Object.keys(LITERATURE_PROVIDERS)
        .filter((name) => LITERATURE_PROVIDERS[name]!.credentialFields.length)
        .map((provider) => ({
          target: provider,
          present: preview.sections.some(
            (section) => section.section === provider,
          ),
        })),
      models: Object.keys(configuration.providers)
        .sort()
        .map((provider) => ({
          target: provider,
          present: preview.sections.some(
            (section) =>
              section.section === `providers.${provider}` &&
              section.origin ===
                (() => {
                  try {
                    return serviceOrigin(
                      configuration.providers[provider]?.base_url ?? null,
                    );
                  } catch {
                    return "";
                  }
                })(),
          ),
        })),
      mineru: preview.sections.some(
        (section) =>
          section.section === "mineru" &&
          (() => {
            try {
              return (
                section.origin === serviceOrigin(configuration.parsing.base_url)
              );
            } catch {
              return false;
            }
          })(),
      ),
    },
  });
}

function serviceOrigin(baseUrl: string | null): string {
  if (baseUrl === null) invalid();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    invalid();
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    invalid();
  return `${parsed.origin}`;
}

function validateCredentialEdit(
  edit: unknown,
): asserts edit is TypeScriptCredentialEdit {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) invalid();
  const value = edit as Record<string, unknown>;
  if (
    !["model", "source", "mineru"].includes(value.namespace as string) ||
    typeof value.target !== "string" ||
    !value.target.trim() ||
    !["keep", "remove", "set"].includes(value.kind as string)
  )
    invalid();
  const namespace = value.namespace as string;
  const kind = value.kind as string;
  const expected =
    kind === "set"
      ? namespace === "source"
        ? ["fields", "kind", "namespace", "target"]
        : ["kind", "namespace", "target", "value"]
      : ["kind", "namespace", "target"];
  if (Object.keys(value).sort().join() !== [...expected].sort().join())
    invalid();
  if (kind === "set") {
    if (namespace === "source") {
      if (
        !value.fields ||
        typeof value.fields !== "object" ||
        Array.isArray(value.fields) ||
        Object.entries(value.fields as Record<string, unknown>).some(
          ([field, item]) =>
            typeof field !== "string" || typeof item !== "string",
        )
      )
        invalid();
    } else if (typeof value.value !== "string") invalid();
  }
}

/**
 * TypeScript configuration owner. It owns ordinary configuration reads,
 * validation, section diffs, atomic publication and local readiness. Credential
 * mutation stays in this owner so configuration and credential publication
 * share one revision check and one filesystem lock.
 */
export class TypeScriptConfigurationOwner {
  constructor(readonly home = homedir()) {
    if (!home.startsWith("/")) invalid();
  }

  async read(signal?: AbortSignal): Promise<TypeScriptConfigurationSnapshot> {
    cancelled(signal);
    return snapshot(this.home);
  }

  validate(payload: string, signal?: AbortSignal): OrdinaryConfiguration {
    cancelled(signal);
    if (
      typeof payload !== "string" ||
      Buffer.byteLength(payload, "utf8") > MAX_BYTES
    )
      invalid();
    try {
      return parseConfiguration(payload);
    } catch (error) {
      if (error instanceof ConfigurationBoundaryError) invalid();
      throw error;
    }
  }

  async diff(
    payload: string,
    baseline: string,
    signal?: AbortSignal,
  ): Promise<TypeScriptConfigurationDiff> {
    const candidate = this.validate(payload, signal);
    const current = await snapshot(this.home);
    if (revision(baseline) !== current.revision)
      throw new ConfigurationOwnerError("configuration-conflict");
    const changedFields: string[] = [];
    for (const section of SECTIONS)
      changed(
        sectionValue(current.configuration, section),
        sectionValue(candidate, section),
        section,
        changedFields,
      );
    return {
      revision: current.revision,
      configuration: candidate,
      changed_fields: Object.freeze(changedFields.sort()),
    };
  }

  async publish(
    payload: string,
    baseline: string,
    sections: readonly ConfigurationSection[],
    signal?: AbortSignal,
  ): Promise<TypeScriptConfigurationSnapshot> {
    const candidate = this.validate(payload, signal);
    checkSections(sections);
    const currentBytes = await readBytes(this.home);
    const current = await snapshot(this.home);
    if (revision(baseline) !== current.revision)
      throw new ConfigurationOwnerError("configuration-conflict");
    const merged = { ...current.configuration } as OrdinaryConfiguration;
    for (const section of sections)
      (merged as unknown as Record<string, unknown>)[section] = sectionValue(
        candidate,
        section,
      );
    const rendered =
      currentBytes === null
        ? renderConfiguration(merged)
        : mergeConfigurationText(
            new TextDecoder().decode(currentBytes),
            merged,
            sections,
          );
    const bytes = new TextEncoder().encode(rendered);
    await publishConfiguration(
      this.home,
      bytes,
      current.revision === "missing" ? null : current.revision,
    );
    return snapshot(this.home);
  }

  /** Publish a typed candidate supplied by a trusted UI adapter. */
  async publishConfiguration(
    configuration: unknown,
    baseline: string,
    sections: readonly ConfigurationSection[],
    signal?: AbortSignal,
  ): Promise<TypeScriptConfigurationSnapshot> {
    let payload: string;
    try {
      payload = renderConfigurationText(configuration as OrdinaryConfiguration);
    } catch {
      invalid();
    }
    return this.publish(payload, baseline, sections, signal);
  }

  async status(signal?: AbortSignal): Promise<ConfigurationReadiness> {
    cancelled(signal);
    const current = await snapshot(this.home);
    const credentials = await loadCredentialBundle(this.home);
    return readiness(current.configuration, bundlePreview(credentials));
  }

  /**
   * Authorize one external credential use from the current credentials file.
   * Long-lived Application snapshots must call this for each new request instead
   * of retaining a token read during bootstrap. Once a request has received its
   * value, later revocation does not rewrite or cancel that in-flight request.
   */
  async authorizeCurrentCredential(
    request: CredentialReadRequest,
    signal?: AbortSignal,
  ): Promise<string | null> {
    cancelled(signal);
    const bundle = await loadCredentialBundle(this.home);
    const preview = bundlePreview(bundle);
    const section =
      request.namespace === "provider"
        ? request.provider
        : request.namespace === "model"
          ? `providers.${request.provider}`
          : "mineru";
    const match = preview.sections.find((item) => item.section === section);
    if (
      !match?.fields.some(
        (item) => item.field === request.field && item.present,
      ) ||
      (request.namespace === "provider"
        ? request.origin !== null
        : request.origin === null || match.origin !== request.origin)
    )
      return null;
    try {
      if (request.namespace === "provider") {
        const grant = issueProviderCredentialGrant(
          bundle,
          request.provider,
          request.field,
        );
        return readProviderCredential(
          bundle,
          grant,
          request.provider,
          request.field,
        );
      }
      const grant = issueCredentialGrant(
        bundle,
        request.namespace,
        request.provider,
        request.field,
        request.origin!,
        request.operation,
      );
      return readCredential(
        bundle,
        grant,
        request.provider,
        request.field,
        request.origin!,
        request.operation,
      );
    } catch (error) {
      if (error instanceof CredentialBoundaryError) return null;
      throw error;
    }
  }

  /** Check presence without exposing a credential value, including for loopback refusal. */
  async hasCurrentCredential(
    namespace: "provider" | "model" | "core",
    provider: string,
    field: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    cancelled(signal);
    const bundle = await loadCredentialBundle(this.home);
    const section =
      namespace === "provider"
        ? provider
        : namespace === "model"
          ? `providers.${provider}`
          : "mineru";
    return (
      bundlePreview(bundle)
        .sections.find((item) => item.section === section)
        ?.fields.some((item) => item.field === field && item.present) ?? false
    );
  }

  async credential(
    edit: TypeScriptCredentialEdit,
    baseline: string,
    signal?: AbortSignal,
  ): Promise<ConfigurationReadiness> {
    cancelled(signal);
    validateCredentialEdit(edit);
    const expected = revision(baseline);
    const lock = await acquireFileLock(this.home, "configuration");
    try {
      const current = await snapshot(this.home);
      if (current.revision !== expected)
        throw new ConfigurationOwnerError("configuration-conflict");
      let origin: string | undefined;
      if (edit.namespace === "model") {
        if (edit.kind === "set") {
          const provider = current.configuration.providers[edit.target];
          if (!provider) invalid();
          origin = serviceOrigin(provider.base_url);
        }
      } else if (edit.namespace === "mineru") {
        if (edit.kind === "set")
          origin = serviceOrigin(current.configuration.parsing.base_url);
      } else if (edit.namespace !== "source") {
        invalid();
      }
      const bundle = await loadCredentialBundle(this.home);
      const bytes = editCredentialBundle(bundle, edit, origin);
      if (bytes !== null) await publishCredentialText(this.home, bytes);
    } finally {
      await lock.release();
    }
    return this.status(signal);
  }
}

/**
 * The production configuration identity. Ordinary CLI invocations resolve the
 * fixed user home here; `SCIRETRIEVER_HOME`, the working directory and any
 * legacy path never change it. An explicitly injected `home` stays an internal
 * boundary and isolated-test seam only (ADR 0018).
 */
export function fixedConfigurationHome(): string {
  return homedir();
}

/* ------------------------------------------------------------------------- *
 * Explicit read-only configuration probe
 *
 * `config status` stays pure local readiness. A user-requested `config test`
 * builds this session instead: it reuses the production adapters, the shared
 * Network policy/budget and the existing credential grants, but it never
 * constructs Storage, creates Literature/jobs/facts, or launches a Browser
 * except for the one explicitly selected Browser Site probe.
 * ------------------------------------------------------------------------- */

export type ConfigurationProbeOwner =
  | "provider"
  | "model"
  | "search"
  | "download"
  | "parse"
  | "analyze"
  | "browser-model"
  | "browser-site"
  | "all";

const PROBE_OWNERS = new Set<ConfigurationProbeOwner>([
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

export function isConfigurationProbeOwner(
  value: unknown,
): value is ConfigurationProbeOwner {
  return (
    typeof value === "string" &&
    PROBE_OWNERS.has(value as ConfigurationProbeOwner)
  );
}

export type ConfigurationProbeOutcome =
  | "passed"
  | "failed"
  | "blocked"
  | "unavailable"
  | "skipped";

export type ConfigurationProbeAuthentication =
  | "not-attempted"
  | "accepted"
  | "rejected";

export interface ConfigurationProbeRequest {
  readonly owner: ConfigurationProbeOwner;
  readonly target: string | null;
  readonly image: boolean;
}

/** Stable, redacted execution summary of exactly one probe dispatch. */
export interface ConfigurationProbeExecution {
  readonly owner: ConfigurationProbeOwner;
  readonly target: string | null;
  readonly code: string;
  readonly elapsed_ms: number;
  readonly next_action: string;
  readonly network: "not-requested" | "may-have-run";
  readonly may_consume_quota: boolean;
}

export interface ConfigurationProbeResult {
  readonly owner: ConfigurationProbeOwner;
  readonly target: string | null;
  readonly outcome: ConfigurationProbeOutcome;
  readonly method: string | null;
  readonly endpoint: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly checks: readonly string[];
  readonly reason: string | null;
  readonly action: string | null;
  readonly network_performed: boolean;
  readonly browser_launched: boolean;
  readonly authentication: ConfigurationProbeAuthentication;
  /** A probe never proves full-text or institutional entitlement. */
  readonly article_entitlement: "not-proven";
  readonly persisted: false;
  readonly limitations: readonly string[];
  readonly results: readonly ConfigurationProbeResult[];
  readonly execution: ConfigurationProbeExecution;
}

export class ConfigurationProbeError extends Error {
  constructor(
    readonly code:
      | "configuration-test-cancelled"
      | "configuration-probe-invalid",
  ) {
    super("configuration probe did not complete");
    this.name = "ConfigurationProbeError";
  }
}

/**
 * The only Browser entry point a configuration probe may use. The production
 * object graph supplies this seam only when an independently verified Browser
 * runtime/site adapter is available; otherwise the probe reports a stable
 * `unavailable` instead of pretending a site was reached.
 */
export interface ConfigurationProbeBrowserSite {
  readonly access_keys: readonly string[];
  probe(access_key: string, signal?: AbortSignal): Promise<void>;
}

/** Explicit offline seams: production leaves every one of them undefined. */
export interface ConfigurationProbeSeams {
  readonly credentials?: CredentialBundle;
  readonly network?: NetworkBudgetCoordinator;
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
  readonly metadata?: MetadataRegistry;
  readonly metadata_assembly?: MetadataAssemblyOptions;
  readonly acquisition?: PublicAcquisitionRegistry;
  readonly acquisition_assembly?: PublicAcquisitionAssemblyOptions;
  readonly parser_health?: MinerUHealthProbe;
  readonly agent_transport?: (target: ProbeModelTarget) => AgentTransport;
  readonly browser_site?: ConfigurationProbeBrowserSite | null;
  /** Deferred runtime resolution; only an authorized Site request may invoke it. */
  readonly browser_site_factory?: () => Promise<ConfigurationProbeBrowserSite | null>;
  readonly now?: () => number;
}

interface ProbeDraft {
  readonly outcome: ConfigurationProbeOutcome;
  readonly reason: string | null;
  readonly action: string | null;
  readonly method?: string | null;
  readonly endpoint?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly checks?: readonly string[];
  readonly network_performed?: boolean;
  readonly may_consume_quota?: boolean;
  readonly authentication?: ConfigurationProbeAuthentication;
  readonly browser_launched?: boolean;
  readonly limitations?: readonly string[];
  readonly results?: readonly ConfigurationProbeResult[];
}

function draft(
  outcome: ConfigurationProbeOutcome,
  reason: string | null,
  action: string | null,
  extra: Omit<ProbeDraft, "outcome" | "reason" | "action"> = {},
): ProbeDraft {
  return { outcome, reason, action, ...extra };
}

function passedDraft(
  extra: Omit<ProbeDraft, "outcome" | "reason" | "action">,
): ProbeDraft {
  return draft("passed", null, null, extra);
}

function aggregateOutcome(
  items: readonly ConfigurationProbeResult[],
): ConfigurationProbeOutcome {
  if (items.some((item) => item.outcome === "failed")) return "failed";
  if (items.some((item) => item.outcome === "blocked")) return "blocked";
  if (items.some((item) => item.outcome === "skipped")) return "skipped";
  if (items.some((item) => item.outcome === "passed")) return "passed";
  return "unavailable";
}

function authenticationOf(
  results: readonly ConfigurationProbeResult[],
): ConfigurationProbeAuthentication {
  if (results.some((item) => item.authentication === "rejected"))
    return "rejected";
  if (results.some((item) => item.authentication === "accepted"))
    return "accepted";
  return "not-attempted";
}

function modelDirectoryCount(body: Uint8Array): number | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") {
    const data = (value as { readonly data?: unknown }).data;
    if (Array.isArray(data)) return data.length;
  }
  return null;
}

/** Provider `api` value -> the wire protocol its adapter speaks. */
function probeProtocol(api: string): AgentWireProtocol | null {
  if (api === "openai-responses") return "openai-responses";
  if (api === "openai-chat-completions") return "openai-chat";
  if (api === "anthropic-messages") return "anthropic";
  return null;
}

/**
 * The provider-directory request headers for one configured Provider. The
 * credential header is derived from the configured protocol through the same
 * mapping the production adapter uses, so an Anthropic Provider is never probed
 * with the OpenAI bearer header (and vice versa). `null` means the configured
 * `api` has no directory probe and must report a stable refusal instead.
 */
export function providerProbeRequestHeaders(
  api: string,
  credential: string | null,
): {
  readonly headers: readonly (readonly [string, string])[];
  readonly credential_headers: readonly (readonly [string, string])[];
} | null {
  const protocol = probeProtocol(api);
  if (protocol === null) return null;
  return {
    headers: [
      ["accept", "application/json"],
      ...(protocol === "anthropic" ? [ANTHROPIC_API_VERSION_HEADER] : []),
    ],
    credential_headers:
      credential === null ? [] : [credentialHeader(protocol, credential)],
  };
}

function modelsEndpoint(baseUrl: string): string {
  const base = new URL(baseUrl);
  const path = base.pathname.replace(/\/+$/u, "");
  return `${base.origin}${path}/models`;
}

function modelErrorAction(code: ProbeModelError["code"]): string {
  if (code === "model-credential-unavailable") return "set-credential";
  if (code === "model-credential-not-allowed")
    return "remove-provider-credential";
  if (code === "model-api-unsupported") return "fix-provider-api";
  return "configure-model";
}

const ANALYSIS_BUDGET_KEYS = [
  "metadata_max_output_tokens",
  "content_max_output_tokens",
  "max_input_bytes",
  "max_chunk_bytes",
  "max_chunk_count",
  "max_total_llm_requests",
  "max_total_output_tokens",
] as const;

/**
 * One operation-scoped probe session for the TUI and structured CLI. It answers
 * one question only: can the configuration and credentials read at creation
 * complete one bounded, minimal, read-only handshake? Callers that stay open
 * across configuration edits create a fresh session for each later probe. A
 * probe already running keeps its admitted snapshot until that operation ends.
 */
export class ConfigurationProbeSession {
  private browserSitePromise:
    | Promise<ConfigurationProbeBrowserSite | null>
    | undefined;
  private constructor(
    private readonly configuration: OrdinaryConfiguration,
    private readonly credentials: CredentialBundle,
    private readonly network: NetworkBudgetCoordinator,
    private readonly ownsNetwork: boolean,
    private readonly metadata: MetadataRegistry,
    private readonly acquisition: PublicAcquisitionRegistry,
    private readonly seams: ConfigurationProbeSeams,
  ) {}

  static async create(
    owner: TypeScriptConfigurationOwner,
    seams: ConfigurationProbeSeams = {},
  ): Promise<ConfigurationProbeSession> {
    const snapshot = await owner.read();
    const credentials =
      seams.credentials ?? (await loadCredentialBundle(owner.home));
    const network = seams.network ?? new NetworkBudgetCoordinator();
    const shared = {
      ...(seams.resolver ? { resolver: seams.resolver } : {}),
      ...(seams.connection ? { connection: seams.connection } : {}),
    };
    const metadata =
      seams.metadata ??
      assembleMetadataRegistry(snapshot.configuration, credentials, network, {
        ...shared,
        ...(seams.metadata_assembly ?? {}),
      });
    const acquisition =
      seams.acquisition ??
      assemblePublicAcquisitionRegistry(snapshot.configuration, network, {
        ...shared,
        ...(seams.acquisition_assembly ?? {}),
        credentials,
      });
    const effectiveSeams: ConfigurationProbeSeams = {
      ...seams,
      ...(seams.browser_site === undefined
        ? {
            browser_site_factory:
              seams.browser_site_factory ??
              (async () => {
                if (
                  !snapshot.configuration.browser.enabled ||
                  snapshot.configuration.browser.profile === null
                )
                  return null;
                const runtime = await resolveVerifiedCloakRuntime(
                  process.env.SCIRETRIEVER_CLOAK_BUNDLE,
                );
                return runtime
                  ? createProductionBrowserSiteProbe(
                      runtime,
                      join(owner.home, "profile"),
                    )
                  : null;
              }),
          }
        : {}),
    };
    return new ConfigurationProbeSession(
      snapshot.configuration,
      credentials,
      network,
      seams.network === undefined,
      metadata,
      acquisition,
      effectiveSeams,
    );
  }

  close(): void {
    if (this.ownsNetwork) this.network.close();
  }

  async run(
    request: ConfigurationProbeRequest,
    options: { readonly authorized: boolean; readonly signal?: AbortSignal },
  ): Promise<ConfigurationProbeResult> {
    const started = this.now();
    const { owner, target, image } = request;
    if (
      !isConfigurationProbeOwner(owner) ||
      (target !== null && typeof target !== "string") ||
      typeof image !== "boolean"
    )
      throw new ConfigurationProbeError("configuration-probe-invalid");
    let value: ProbeDraft;
    if (owner === "provider") {
      if (target === null)
        throw new ConfigurationProbeError("configuration-probe-invalid");
      value = await this.probeProvider(target, options);
    } else if (owner === "model") {
      if (target === null)
        throw new ConfigurationProbeError("configuration-probe-invalid");
      value = await this.probeAgentModel("model", target, image, options);
    } else if (owner === "analyze") {
      value = await this.probeAgentModel("analyze", null, false, options);
    } else if (owner === "browser-model") {
      value = await this.probeAgentModel("browser-model", null, true, options);
    } else if (owner === "search") {
      value =
        target === null
          ? await this.probeSearchAll(options)
          : await this.probeSearch(target, options);
    } else if (owner === "download") {
      value =
        target === null ? this.probeDownloadAll() : this.probeDownload(target);
    } else if (owner === "parse") {
      value = await this.probeParse(options);
    } else if (owner === "browser-site") {
      if (target === null)
        throw new ConfigurationProbeError("configuration-probe-invalid");
      value = await this.probeBrowserSite(target, options);
    } else if (owner === "all") {
      value = await this.probeAll(options);
    } else {
      throw new ConfigurationProbeError("configuration-probe-invalid");
    }
    this.checkCancelled(options.signal);
    return this.finalize(owner, target, value, started);
  }

  private now(): number {
    return this.seams.now ? this.seams.now() : Date.now();
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted)
      throw new ConfigurationProbeError("configuration-test-cancelled");
  }

  private finalize(
    owner: ConfigurationProbeOwner,
    target: string | null,
    value: ProbeDraft,
    started: number,
  ): ConfigurationProbeResult {
    const results = value.results ?? [];
    const networkPerformed = results.length
      ? results.some((item) => item.network_performed)
      : value.network_performed === true;
    const browserLaunched = results.length
      ? results.some((item) => item.browser_launched)
      : value.browser_launched === true;
    const mayConsumeQuota = results.length
      ? results.some((item) => item.execution.may_consume_quota)
      : value.may_consume_quota === true;
    const elapsed = this.now() - started;
    return Object.freeze({
      owner,
      target,
      outcome: value.outcome,
      method: value.method ?? null,
      endpoint: value.endpoint ?? null,
      provider: value.provider ?? null,
      model: value.model ?? null,
      checks: Object.freeze([...(value.checks ?? [])]),
      reason: value.reason,
      action: value.action,
      network_performed: networkPerformed,
      browser_launched: browserLaunched,
      authentication:
        value.authentication ??
        (results.length ? authenticationOf(results) : "not-attempted"),
      article_entitlement: "not-proven" as const,
      persisted: false as const,
      limitations: Object.freeze([...(value.limitations ?? [])]),
      results: Object.freeze([...results]),
      execution: Object.freeze({
        owner,
        target,
        code: value.reason ?? "probe-passed",
        elapsed_ms: elapsed > 0 ? elapsed : 0,
        next_action: value.action ?? "none",
        network: networkPerformed ? "may-have-run" : "not-requested",
        may_consume_quota: mayConsumeQuota,
      }),
    });
  }

  private item(
    owner: ConfigurationProbeOwner,
    target: string | null,
    value: ProbeDraft,
    started: number,
  ): ConfigurationProbeResult {
    return this.finalize(owner, target, value, started);
  }

  /* ---------------------------- provider ---------------------------- */

  private async probeProvider(
    target: string,
    options: { readonly authorized: boolean; readonly signal?: AbortSignal },
  ): Promise<ProbeDraft> {
    this.checkCancelled(options.signal);
    const provider = this.configuration.providers[target];
    if (!provider)
      return draft(
        "blocked",
        "model-provider-not-configured",
        "configure-provider",
        {
          provider: target,
        },
      );
    let endpoint: string;
    let origin: string;
    let local: boolean;
    try {
      endpoint = modelsEndpoint(provider.base_url);
      const base = new URL(provider.base_url);
      origin = base.origin;
      local = base.protocol === "http:";
    } catch {
      return draft(
        "blocked",
        "model-provider-endpoint-invalid",
        "fix-provider-base-url",
        {
          provider: target,
        },
      );
    }
    const protocol = probeProtocol(provider.api);
    if (protocol === null)
      return draft("blocked", "model-api-unsupported", "fix-provider-api", {
        provider: target,
      });
    const described = {
      method: "GET",
      endpoint,
      provider: target,
      checks: [`api-${provider.api}`],
    } as const;
    let credential: string | null = null;
    if (local) {
      const presented = bundlePreview(this.credentials).sections.some(
        (section) =>
          section.section === `providers.${target}` &&
          section.fields.some((field) => field.present),
      );
      if (presented)
        return draft(
          "blocked",
          "model-credential-not-allowed",
          "remove-provider-credential",
          described,
        );
    } else {
      const sections = bundlePreview(this.credentials).sections.filter(
        (section) => section.section === `providers.${target}`,
      );
      if (!sections.length)
        return draft(
          "blocked",
          "model-credential-unavailable",
          "set-credential",
          described,
        );
      const match = sections.find(
        (section) =>
          section.origin === origin &&
          section.fields.some(
            (field) => field.field === "api_key" && field.present,
          ),
      );
      if (!match)
        return draft(
          "blocked",
          sections.some((section) => section.origin === origin)
            ? "model-credential-unavailable"
            : "model-credential-origin-mismatch",
          "set-credential",
          described,
        );
    }
    if (!options.authorized)
      return draft(
        "blocked",
        "probe-not-authorized",
        "confirm-or-use-json",
        described,
      );
    try {
      credential = issueCredentialGrantFor(
        this.credentials,
        target,
        origin,
        local,
      );
    } catch {
      return draft(
        "blocked",
        "model-credential-unavailable",
        "set-credential",
        described,
      );
    }
    const requestHeaders = providerProbeRequestHeaders(
      provider.api,
      credential,
    )!;
    let response;
    try {
      response = await readOnlyProbeRequest({
        url: endpoint,
        headers: requestHeaders.headers,
        ...(requestHeaders.credential_headers.length
          ? { credential_headers: requestHeaders.credential_headers }
          : {}),
        coordinator: this.network,
        ...(this.seams.resolver ? { resolver: this.seams.resolver } : {}),
        ...(this.seams.connection ? { connection: this.seams.connection } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        maxResponseBytes: 524_288,
      });
    } catch (error) {
      this.checkCancelled(options.signal);
      if (error instanceof ProbeRequestError)
        return draft(
          "failed",
          "provider-request-invalid",
          "fix-provider-base-url",
          described,
        );
      if (error instanceof NetworkPolicyError)
        return draft(
          "failed",
          "provider-address-refused",
          "fix-provider-base-url",
          described,
        );
      if (error instanceof NetworkHttpError)
        return draft(
          "failed",
          "provider-unreachable",
          "check-network-or-endpoint",
          described,
        );
      throw error;
    }
    this.checkCancelled(options.signal);
    if ([301, 302, 303, 307, 308].includes(response.status))
      return draft(
        "failed",
        "provider-redirect-refused",
        "fix-provider-base-url",
        {
          ...described,
          network_performed: true,
        },
      );
    if (response.status === 401 || response.status === 403)
      return draft("failed", "provider-credential-rejected", "set-credential", {
        ...described,
        network_performed: true,
        authentication: "rejected",
      });
    if (response.status === 404)
      return draft(
        "failed",
        "provider-endpoint-unknown",
        "fix-provider-base-url",
        {
          ...described,
          network_performed: true,
        },
      );
    if (response.status === 429)
      return draft("failed", "provider-rate-limited", "retry-later", {
        ...described,
        network_performed: true,
      });
    if (response.status >= 500)
      return draft("failed", "provider-unavailable", "retry-later", {
        ...described,
        network_performed: true,
      });
    if (response.status !== 200)
      return draft(
        "failed",
        "provider-request-rejected",
        "check-provider-declaration",
        {
          ...described,
          network_performed: true,
        },
      );
    const count = modelDirectoryCount(response.body);
    return passedDraft({
      ...described,
      checks: [
        `api-${provider.api}`,
        "model-directory-read",
        ...(count === null
          ? ["directory-shape-unexpected"]
          : [`model-count-${count}`]),
      ],
      network_performed: true,
      may_consume_quota: false,
      authentication: "accepted",
    });
  }

  /* ------------------------------ models ---------------------------- */

  private async probeAgentModel(
    owner: "model" | "analyze" | "browser-model",
    reference: string | null,
    image: boolean,
    options: { readonly authorized: boolean; readonly signal?: AbortSignal },
  ): Promise<ProbeDraft> {
    this.checkCancelled(options.signal);
    if (owner === "analyze") {
      const analyze = this.configuration.analyze;
      if (
        analyze.model === null ||
        ANALYSIS_BUDGET_KEYS.some((key) => analyze[key] === null)
      )
        return draft(
          "blocked",
          "analysis-configuration-incomplete",
          "configure-analysis",
        );
    }
    if (owner === "browser-model") {
      if (!this.configuration.browser.enabled)
        return draft("skipped", "browser-disabled", "enable-browser");
      if (this.configuration.browser.model === null)
        return draft(
          "blocked",
          "browser-model-unavailable",
          "select-browser-model",
        );
    }
    const resolved =
      reference ??
      (owner === "analyze"
        ? this.configuration.analyze.model
        : this.configuration.browser.model);
    if (resolved === null)
      return draft(
        "blocked",
        owner === "analyze"
          ? "analysis-configuration-incomplete"
          : "browser-model-unavailable",
        owner === "analyze" ? "configure-analysis" : "select-browser-model",
      );
    let target: ProbeModelTarget;
    try {
      target = resolveProbeModelTarget(
        this.configuration,
        this.credentials,
        resolved,
      );
    } catch (error) {
      if (error instanceof ProbeModelError)
        return draft("blocked", error.code, modelErrorAction(error.code));
      throw error;
    }
    if (image && !target.image)
      return draft(
        "blocked",
        owner === "browser-model"
          ? "browser-model-image-unsupported"
          : "model-image-unsupported",
        "choose-image-model",
      );
    const role: AgentRole = image ? "browser" : "analysis";
    const capabilities: readonly AgentCapability[] = image
      ? ["image_input", "tool_decision"]
      : ["structured_text"];
    const described = {
      method: "POST",
      endpoint: target.endpoint,
      provider: target.provider_name,
      model: target.model_name,
    } as const;
    if (!options.authorized)
      return draft(
        "blocked",
        "probe-not-authorized",
        "confirm-or-use-json",
        described,
      );
    const runtime = createProbeAgentRuntime(target, {
      coordinator: this.network,
      role,
      capabilities,
      ...(this.seams.resolver ? { resolver: this.seams.resolver } : {}),
      ...(this.seams.connection ? { connection: this.seams.connection } : {}),
      ...(this.seams.agent_transport
        ? { transport: this.seams.agent_transport(target) }
        : {}),
    });
    try {
      if (image) await executeProbeImage(runtime, role, options.signal);
      else await executeProbeText(runtime, role, options.signal);
      this.checkCancelled(options.signal);
      return passedDraft({
        ...described,
        checks: image
          ? ["synthetic-image", "closed-stop-tool", "tool-decision"]
          : ["strict-schema-text", "closed-response"],
        network_performed: true,
        may_consume_quota: true,
        authentication: "accepted",
      });
    } catch (error) {
      this.checkCancelled(options.signal);
      return this.agentFailure(error, described);
    } finally {
      runtime.close();
    }
  }

  private agentFailure(
    error: unknown,
    described: {
      readonly method: string;
      readonly endpoint: string;
      readonly provider: string;
      readonly model: string;
    },
  ): ProbeDraft {
    const code = error instanceof AgentFailure ? error.code : "agent-internal";
    if (code === "agent-auth")
      return draft(
        "failed",
        "model-authentication-rejected",
        "set-credential",
        {
          ...described,
          network_performed: true,
          authentication: "rejected",
        },
      );
    if (code === "agent-quota")
      return draft("failed", "model-quota-limited", "retry-later", {
        ...described,
        network_performed: true,
        may_consume_quota: true,
      });
    if (code === "agent-remote")
      return draft("failed", "model-provider-unavailable", "retry-later", {
        ...described,
        network_performed: true,
      });
    if (code === "agent-model-mismatch")
      return draft(
        "failed",
        "model-identity-mismatch",
        "check-model-declaration",
        {
          ...described,
          network_performed: true,
        },
      );
    if (
      [
        "agent-truncated",
        "agent-protocol",
        "agent-response",
        "agent-probe-response",
        "agent-refusal",
        "agent-tool",
      ].includes(code)
    )
      return draft(
        "failed",
        "model-response-invalid",
        "check-model-declaration",
        {
          ...described,
          network_performed: true,
        },
      );
    if (
      [
        "agent-input",
        "agent-request-limit",
        "agent-credentials",
        "agent-configuration",
      ].includes(code)
    )
      return draft(
        "failed",
        "model-request-invalid",
        "check-provider-declaration",
        described,
      );
    if (code === "agent-capability")
      return draft(
        "failed",
        "model-capability-unsupported",
        "choose-capable-model",
        described,
      );
    if (code === "agent-cancelled" || code === "agent-closed")
      return draft("failed", "model-probe-cancelled", "retry-later", described);
    return draft("failed", "model-probe-failed", "retry-later", described);
  }

  /* ------------------------------ search ---------------------------- */

  private async probeSearch(
    source: string,
    options: { readonly authorized: boolean; readonly signal?: AbortSignal },
  ): Promise<ProbeDraft> {
    this.checkCancelled(options.signal);
    const status = this.metadata.statuses.find(
      (item) => item.provider_name === source,
    );
    if (!status)
      return draft(
        "blocked",
        "metadata-source-not-configured",
        "configure-source",
        {
          provider: source,
        },
      );
    const described = {
      method: "GET",
      endpoint: status.endpoint,
      provider: source,
    } as const;
    if (!status.capabilities.includes("topic-search"))
      return draft(
        "unavailable",
        "metadata-capability-unavailable",
        "choose-search-source",
        described,
      );
    if (!status.production_available)
      return draft(
        "unavailable",
        "metadata-source-unavailable",
        "configure-source",
        described,
      );
    if (!status.ready)
      return draft(
        "skipped",
        status.failure_code ?? "metadata-source-unavailable",
        status.failure_code === "credential-missing"
          ? "set-credential"
          : "configure-source",
        described,
      );
    if (!options.authorized)
      return draft(
        "blocked",
        "probe-not-authorized",
        "confirm-or-use-json",
        described,
      );
    try {
      const invocation = await this.metadata.service.searchTopicProvider(
        source,
        {
          query: "sciretriever configuration probe",
          year_from: null,
          year_to: null,
        },
        1,
        options.signal,
      );
      this.checkCancelled(options.signal);
      if (invocation.outcome === "FAILED")
        return draft(
          "failed",
          invocation.failure?.code ?? "metadata-probe-failed",
          invocation.failure?.action ?? "retry-request",
          { ...described, network_performed: true },
        );
      return passedDraft({
        ...described,
        checks: ["official-read-only-request"],
        network_performed: true,
        may_consume_quota: bundlePreview(this.credentials).sections.some(
          (section) => section.section === source,
        ),
        authentication: "accepted",
      });
    } catch (error) {
      this.checkCancelled(options.signal);
      if (error instanceof ConfigurationProbeError) throw error;
      return draft("failed", "metadata-probe-failed", "retry-request", {
        ...described,
        network_performed: true,
      });
    }
  }

  private async probeSearchAll(options: {
    readonly authorized: boolean;
    readonly signal?: AbortSignal;
  }): Promise<ProbeDraft> {
    const sources = this.metadata.topic_selection;
    if (!sources.length)
      return draft(
        "unavailable",
        "metadata-source-not-enabled",
        "configure-search-source",
      );
    const results: ConfigurationProbeResult[] = [];
    for (const source of sources) {
      this.checkCancelled(options.signal);
      const started = this.now();
      results.push(
        this.item(
          "search",
          source,
          await this.probeSearch(source, options),
          started,
        ),
      );
    }
    const outcome = aggregateOutcome(results);
    const first = results.find((item) => item.outcome !== "passed");
    return draft(
      outcome,
      outcome === "passed"
        ? null
        : (first?.reason ?? "metadata-probe-incomplete"),
      outcome === "passed" ? null : (first?.action ?? "review-configuration"),
      {
        checks: results.map(
          (item) => `${item.target ?? "all"}:${item.outcome}`,
        ),
        results,
      },
    );
  }

  /* ----------------------------- download --------------------------- */

  private probeDownload(target: string): ProbeDraft {
    const status = this.acquisition.statuses.find(
      (item) => item.source_name === target,
    );
    if (!status)
      return draft(
        "blocked",
        "acquisition-source-not-configured",
        "configure-source",
        {
          provider: target,
        },
      );
    if (!status.ready)
      return draft(
        "blocked",
        status.failure_code ?? "acquisition-source-unavailable",
        "configure-source",
        { provider: target },
      );
    // There is no safe Literature-independent Acquisition probe: report the
    // capability gap instead of borrowing a metadata request or a PDF download.
    return draft(
      "unavailable",
      "acquisition-probe-unavailable",
      "use-complete-pdf",
      { provider: target, limitations: ["article-entitlement-not-proven"] },
    );
  }

  private probeDownloadAll(): ProbeDraft {
    const started = this.now();
    const results = this.acquisition.statuses.map((status) =>
      this.item(
        "download",
        status.source_name,
        this.probeDownload(status.source_name),
        started,
      ),
    );
    if (!results.length)
      return draft(
        "unavailable",
        "acquisition-source-not-enabled",
        "configure-source",
      );
    const outcome = aggregateOutcome(results);
    const first = results.find((item) => item.outcome !== "passed");
    return draft(
      outcome,
      outcome === "passed"
        ? null
        : (first?.reason ?? "acquisition-probe-incomplete"),
      outcome === "passed" ? null : (first?.action ?? "review-configuration"),
      {
        checks: results.map(
          (item) => `${item.target ?? "all"}:${item.outcome}`,
        ),
        results,
        limitations: ["article-entitlement-not-proven"],
      },
    );
  }

  /* ------------------------------ parse ----------------------------- */

  private async probeParse(options: {
    readonly authorized: boolean;
    readonly signal?: AbortSignal;
  }): Promise<ProbeDraft> {
    this.checkCancelled(options.signal);
    const parsing = this.configuration.parsing;
    if (
      parsing.base_url === null ||
      parsing.model_identity === null ||
      parsing.connection_mode === null
    )
      return draft(
        "blocked",
        "parser-configuration-incomplete",
        "configure-parser",
      );
    const described = {
      provider: "mineru",
      model: parsing.model_identity,
    } as const;
    let probe: MinerUHealthProbe;
    if (this.seams.parser_health) probe = this.seams.parser_health;
    else {
      try {
        probe = createMinerUHealthProbe({
          base_url: parsing.base_url,
          connection_mode: parsing.connection_mode,
          credentials: this.credentials,
          coordinator: this.network,
          ...(this.seams.resolver ? { resolver: this.seams.resolver } : {}),
          ...(this.seams.connection
            ? { connection: this.seams.connection }
            : {}),
        });
      } catch (error) {
        if (error instanceof MinerUHealthError)
          return draft("blocked", error.code, "set-credential", described);
        if (error instanceof ParsingFailure)
          return draft(
            "blocked",
            "parser-configuration-incomplete",
            "configure-parser",
            described,
          );
        throw error;
      }
    }
    const describedFull = {
      method: "GET",
      endpoint: probe.endpoint,
      ...described,
    } as const;
    if (!options.authorized)
      return draft(
        "blocked",
        "probe-not-authorized",
        "confirm-or-use-json",
        describedFull,
      );
    try {
      const report = await probe.health(options.signal);
      this.checkCancelled(options.signal);
      return passedDraft({
        ...describedFull,
        checks: [
          "parser-healthy",
          "parser-release-3.4.4",
          "parser-protocol-2",
          ...(report.profile === null ? [] : ["parser-profile-declared"]),
        ],
        network_performed: true,
        may_consume_quota: false,
        authentication:
          parsing.connection_mode === "remote" ? "accepted" : "not-attempted",
      });
    } catch (error) {
      this.checkCancelled(options.signal);
      if (!(error instanceof MinerUHealthError)) throw error;
      const actions: Readonly<Record<string, string>> = {
        "parser-unhealthy": "check-parser-service",
        "parser-release-mismatch": "install-supported-parser-release",
        "parser-protocol-mismatch": "install-supported-parser-release",
        "parser-response-invalid": "check-parser-service",
        "parser-unreachable": "check-network-or-endpoint",
        "parser-redirect-refused": "fix-parser-base-url",
        "parser-credential-rejected": "set-credential",
        "parser-credential-unavailable": "set-credential",
      };
      const blocked =
        error.code === "parser-credential-unavailable" ? "blocked" : "failed";
      return draft(
        blocked,
        error.code,
        actions[error.code] ?? "check-parser-service",
        {
          ...describedFull,
          network_performed: error.code !== "parser-credential-unavailable",
          authentication:
            error.code === "parser-credential-rejected"
              ? "rejected"
              : "not-attempted",
        },
      );
    }
  }

  /* --------------------------- browser site ------------------------- */

  private async probeBrowserSite(
    accessKey: string,
    options: { readonly authorized: boolean; readonly signal?: AbortSignal },
  ): Promise<ProbeDraft> {
    this.checkCancelled(options.signal);
    const described = {
      provider: "browser",
      model: this.configuration.browser.model,
    } as const;
    if (!this.configuration.browser.enabled)
      return draft("skipped", "browser-disabled", "enable-browser", described);
    const accessKeys =
      this.seams.browser_site?.access_keys ??
      PRODUCTION_BROWSER_SITE_ACCESS_KEYS;
    if (!accessKeys.includes(accessKey))
      return draft(
        "unavailable",
        "browser-site-unsupported-target",
        "choose-approved-access-key",
        described,
      );
    if (!options.authorized)
      return draft(
        "blocked",
        "probe-not-authorized",
        "confirm-or-use-json",
        described,
      );
    const site =
      this.seams.browser_site ??
      (this.browserSitePromise ??=
        this.seams.browser_site_factory?.() ?? Promise.resolve(null));
    const resolvedSite = await site;
    if (resolvedSite === null)
      return draft(
        "unavailable",
        "browser-site-probe-unavailable",
        "browser-production-route-unavailable",
        described,
      );
    try {
      await resolvedSite.probe(accessKey, options.signal);
      this.checkCancelled(options.signal);
      return passedDraft({
        ...described,
        checks: ["headed-browser", "minimal-target-navigation"],
        network_performed: true,
        may_consume_quota: false,
        browser_launched: true,
      });
    } catch (error) {
      this.checkCancelled(options.signal);
      if (error instanceof ConfigurationProbeError) throw error;
      return draft("failed", "browser-site-unreachable", "retry-later", {
        ...described,
        network_performed:
          error instanceof BrowserSiteProbeError
            ? error.network_performed
            : true,
        browser_launched:
          error instanceof BrowserSiteProbeError
            ? error.browser_launched
            : true,
      });
    }
  }

  /* ------------------------------- all ------------------------------ */

  private async probeAll(options: {
    readonly authorized: boolean;
    readonly signal?: AbortSignal;
  }): Promise<ProbeDraft> {
    const items: ConfigurationProbeResult[] = [];
    let started = this.now();
    items.push(
      this.item("search", null, await this.probeSearchAll(options), started),
    );
    started = this.now();
    items.push(this.item("download", null, this.probeDownloadAll(), started));
    started = this.now();
    items.push(
      this.item("parse", null, await this.probeParse(options), started),
    );
    started = this.now();
    items.push(
      this.item(
        "analyze",
        this.configuration.analyze.model,
        await this.probeAgentModel("analyze", null, false, options),
        started,
      ),
    );
    if (this.configuration.browser.enabled) {
      started = this.now();
      items.push(
        this.item(
          "browser-model",
          this.configuration.browser.model,
          await this.probeAgentModel("browser-model", null, true, options),
          started,
        ),
      );
    }
    // A Download probe cannot run, and the Browser Site probe is never implicit.
    const countable = items.filter((item) => item.owner !== "download");
    const outcome = aggregateOutcome(countable);
    const first = countable.find((item) => item.outcome !== "passed");
    const limitations = ["model-directory-not-probed"];
    if (this.configuration.browser.enabled)
      limitations.push("browser-site-requires-explicit-target");
    if (
      items.some(
        (item) => item.owner === "download" && item.outcome === "unavailable",
      )
    )
      limitations.push("download-probe-unavailable");
    return draft(
      outcome,
      outcome === "passed"
        ? null
        : (first?.reason ?? "configuration-test-incomplete"),
      outcome === "passed" ? null : (first?.action ?? "review-configuration"),
      {
        checks: items.map((item) => `${item.owner}:${item.outcome}`),
        results: items,
        limitations,
      },
    );
  }
}

/** The one admitted model-directory credential path. */
function issueCredentialGrantFor(
  credentials: CredentialBundle,
  provider: string,
  origin: string,
  local: boolean,
): string | null {
  if (local) return null;
  const grant = issueCredentialGrant(
    credentials,
    "model",
    provider,
    "api_key",
    origin,
    "model-directory",
  );
  return readCredential(
    credentials,
    grant,
    provider,
    "api_key",
    origin,
    "model-directory",
  );
}
