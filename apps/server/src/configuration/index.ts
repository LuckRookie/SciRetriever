import { createHash, randomUUID } from "node:crypto";
import {
  open,
  lstat,
  mkdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireFileLock, type FileLock } from "../storage/locking.js";

export class ConfigurationBoundaryError extends Error {
  readonly code = "configuration-boundary" as const;
  constructor() {
    super("configuration operation failed");
    this.name = "ConfigurationBoundaryError";
  }
}

export type SourceMode = "auto" | "custom";
export interface PathsConfig {
  readonly catalog_path: string | null;
  readonly artifact_root: string | null;
}
export interface SourceSelection {
  readonly mode: SourceMode;
  readonly providers: readonly string[];
  readonly limit?: number;
}
export interface SourcesConfig {
  readonly metadata: SourceSelection & {
    readonly web_of_science: Record<string, unknown> | null;
    readonly crossref: Record<string, unknown> | null;
  };
  readonly acquisition: SourceSelection & {
    readonly unpaywall: Record<string, unknown> | null;
    readonly sci_hub: Record<string, unknown> | null;
  };
}
export interface ParsingConfig {
  readonly base_url: string | null;
  readonly connection_mode: "loopback" | "remote" | null;
  readonly model_identity: string | null;
  readonly remote_upload_authorized: boolean;
}
export interface ProviderConfig {
  readonly api: string;
  readonly base_url: string;
}
export interface ModelConfig {
  readonly reasoning:
    | "default"
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  readonly image: boolean;
  readonly stream: boolean;
}
export interface AnalyzeConfig {
  readonly model: string | null;
  readonly metadata_max_output_tokens: number | null;
  readonly content_max_output_tokens: number | null;
  readonly reference_max_output_tokens: number | null;
  readonly max_input_bytes: number | null;
  readonly max_chunk_bytes: number | null;
  readonly max_chunk_count: number | null;
  readonly max_total_llm_requests: number | null;
  readonly max_total_output_tokens: number | null;
}
export interface BrowserPolicyOverride {
  readonly rate_limit_group: "browser-generic";
  readonly max_concurrency: 1 | null;
  readonly minimum_start_interval: number | null;
  readonly maximum_starts_per_window: number | null;
  readonly window_seconds: number | null;
  readonly cooldown_after_completion: number | null;
  readonly rate_limit_cooldown: number | null;
  readonly failure_cooldown: number | null;
  readonly runtime_failure_threshold: number | null;
}
export interface BrowserConfig {
  readonly model: string | null;
  readonly enabled: boolean;
  readonly profile: string | null;
  readonly max_concurrency: number;
  readonly policy_overrides: readonly BrowserPolicyOverride[];
}
export interface OrdinaryConfiguration {
  readonly paths: PathsConfig;
  readonly sources: SourcesConfig;
  readonly assets: Record<string, never>;
  readonly parsing: ParsingConfig;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: Readonly<Record<string, ModelConfig>>;
  readonly analyze: AnalyzeConfig;
  readonly browser: BrowserConfig;
  readonly execution: { readonly max_concurrency: number };
  readonly library: { readonly max_input_bytes: number };
}

const ROOT_KEYS = [
  "paths",
  "sources",
  "assets",
  "parsing",
  "providers",
  "models",
  "analyze",
  "browser",
  "execution",
  "library",
] as const;
const METADATA_PROVIDERS = new Set([
  "web-of-science",
  "crossref",
  "semantic-scholar",
  "arxiv",
  "openalex",
  "europe-pmc",
  "elsevier",
  "springer",
  "datacite",
  "core",
  "opencitations",
]);
const ACQUISITION_PROVIDERS = new Set([
  "arxiv",
  "crossref",
  "semantic-scholar",
  "openalex",
  "europe-pmc",
  "unpaywall",
  "elsevier",
  "springer",
  "wiley",
  "datacite",
  "core",
  "sci-hub",
]);
const MODEL_APIS = new Set([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
]);
const REASONING = new Set([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const POLICY_KEYS = [
  "rate_limit_group",
  "max_concurrency",
  "minimum_start_interval",
  "maximum_starts_per_window",
  "window_seconds",
  "cooldown_after_completion",
  "rate_limit_cooldown",
  "failure_cooldown",
  "runtime_failure_threshold",
] as const;
const MAX_CONFIGURATION_BYTES = 1_048_576;
function invalid(): never {
  throw new ConfigurationBoundaryError();
}
function ownerOnly(mode: number, uid: number): boolean {
  return (
    typeof process.getuid === "function" &&
    uid === process.getuid() &&
    (mode & 0o777) === 0o600
  );
}
function ownerOnlyDirectory(mode: number, uid: number): boolean {
  return (
    typeof process.getuid === "function" &&
    uid === process.getuid() &&
    (mode & 0o777) === 0o700
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(
  value: unknown,
  allowed: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) invalid();
  const accepted = new Set([...allowed, ...optional]);
  if (
    Object.keys(value).some((key) => !accepted.has(key)) ||
    allowed.some((key) => !(key in value))
  )
    invalid();
  return value;
}
function optionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid();
  return value;
}
function hasControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code >= 0 && code <= 31) || (code >= 127 && code <= 159);
  });
}
function stringValue(value: unknown, optional = false): string | null {
  if (value === null && optional) return null;
  if (typeof value !== "string" || !value.trim() || hasControl(value))
    invalid();
  return value.trim().normalize("NFC");
}
function textOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : stringValue(value);
}
function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function positiveInteger(
  value: unknown,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid();
  return value;
}
function finiteNumber(value: unknown, positive = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (positive && value === 0)
  )
    invalid();
  return value;
}
function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) invalid();
  return value as T;
}
function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => freeze(item));
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => freeze(item));
    return Object.freeze(value) as T;
  }
  return value;
}

function parseScalar(source: string): unknown {
  const value = source.trim();
  if (!value) invalid();
  if (value === "true" || value === "false") return value === "true";
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      invalid();
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    if (value.slice(1, -1).includes("'")) invalid();
    return value.slice(1, -1);
  }
  if (/^[+-]?(?:0|[1-9]\d*)(?:_\d+)*$/.test(value)) {
    const number = Number(value.replaceAll("_", ""));
    if (!Number.isSafeInteger(number)) invalid();
    return number;
  }
  if (
    /^[+-]?(?:\d(?:_?\d)*\.\d(?:_?\d)*|\d(?:_?\d)*e[+-]?\d(?:_?\d)*)$/i.test(
      value,
    )
  ) {
    const number = Number(value.replaceAll("_", ""));
    if (!Number.isFinite(number)) invalid();
    return number;
  }
  if (value.startsWith("[") && value.endsWith("]"))
    return parseArray(value.slice(1, -1));
  if (value.startsWith("{") && value.endsWith("}"))
    return parseInlineTable(value.slice(1, -1));
  invalid();
}
function splitTopLevel(source: string, allowTrailingComma = true): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\" && quote === '"') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth < 0) invalid();
    } else if (char === "," && depth === 0) {
      const item = source.slice(start, index).trim();
      if (!item) invalid();
      result.push(item);
      start = index + 1;
    }
  }
  if (quote !== null || depth !== 0) invalid();
  const tail = source.slice(start).trim();
  if (tail) result.push(tail);
  else if (!allowTrailingComma && result.length > 0) invalid();
  return result;
}
function parseArray(source: string): unknown[] {
  return splitTopLevel(source, true).map(parseScalar);
}
function parseInlineTable(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const item of splitTopLevel(source, false)) {
    const separator = item.indexOf("=");
    if (separator < 1) invalid();
    const key = item.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key) || key in result) invalid();
    result[key] = parseScalar(item.slice(separator + 1));
  }
  return result;
}
function stripComment(line: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\" && quote === '"') escaped = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  if (quote !== null || escaped) invalid();
  return line;
}
function pathParts(value: string): string[] {
  let quote = false;
  let start = 0;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quote = !quote;
    else if (value[index] === "." && !quote) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote) invalid();
  result.push(value.slice(start).trim());
  if (result.some((part) => !part)) invalid();
  return result.map((part) => {
    const quoted = part.startsWith('"') && part.endsWith('"');
    const candidate = quoted ? parseScalar(part) : part;
    if (
      typeof candidate !== "string" ||
      (!quoted && !/^[A-Za-z0-9_-]+$/.test(candidate)) ||
      !candidate
    )
      invalid();
    return candidate;
  });
}
function setPath(
  root: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key in root) invalid();
  root[key] = value;
}
export function parseToml(input: string | Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    invalid();
  }
  const root: Record<string, unknown> = {};
  const declaredTables = new Set<string>();
  let table: string[] = [];
  let pending = "";
  let depth = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    pending = pending ? `${pending} ${line}` : line;
    let quote: string | null = null;
    let escaped = false;
    for (const char of line) {
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (char === "\\" && quote === '"') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "[") depth += 1;
      else if (char === "]") depth -= 1;
    }
    if (depth > 0) continue;
    if (depth < 0) invalid();
    const header =
      pending.startsWith("[") && pending.endsWith("]")
        ? pending.slice(1, -1)
        : null;
    if (header !== null) {
      table = pathParts(header);
      if (table.length === 0) invalid();
      const tableKey = table.join(".");
      if (declaredTables.has(tableKey)) invalid();
      declaredTables.add(tableKey);
      let target: Record<string, unknown> = root;
      for (const part of table) {
        const child = target[part];
        if (child === undefined) target[part] = {};
        else if (!isRecord(child)) invalid();
        target = target[part] as Record<string, unknown>;
      }
      pending = "";
      continue;
    }
    const separator = pending.indexOf("=");
    if (separator < 1) invalid();
    const key = pending.slice(0, separator).trim();
    if (!key) invalid();
    const names = pathParts(key);
    let target: Record<string, unknown> = root;
    for (const part of table) {
      const child = target[part];
      if (!isRecord(child)) invalid();
      target = child;
    }
    let destination = target;
    for (const part of names.slice(0, -1)) {
      const child = destination[part];
      if (child === undefined) destination[part] = {};
      else if (!isRecord(child)) invalid();
      destination = destination[part] as Record<string, unknown>;
    }
    setPath(
      destination,
      names[names.length - 1]!,
      parseScalar(pending.slice(separator + 1)),
    );
    pending = "";
  }
  if (pending || depth !== 0) invalid();
  return root;
}

function validateServiceUrl(value: string, remote: boolean | null): void {
  if (value.includes("\\") || /\s/.test(value) || hasControl(value)) invalid();
  const schemeEnd = value.indexOf("://");
  const authorityEnd =
    schemeEnd < 0 ? -1 : value.slice(schemeEnd + 3).search(/[/?#]/u);
  const rawPath =
    authorityEnd < 0
      ? ""
      : (value.slice(schemeEnd + 3 + authorityEnd).split(/[?#]/u, 1)[0] ?? "");
  if (/%(?![0-9a-f]{2})/iu.test(rawPath) || /%(?:2f|2e|5c)/iu.test(rawPath))
    invalid();
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath)) invalid();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    invalid();
  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
  const ipLiteral = /^\[?[0-9a-f:.]+\]?$/i.test(hostname);
  if (remote === null) invalid();
  if (
    remote
      ? parsed.protocol !== "https:" || loopback || ipLiteral
      : parsed.protocol !== "http:" || !loopback
  )
    invalid();
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    invalid();
  }
  const segments = decoded.split("/");
  if (
    decoded.includes("\\") ||
    segments.some(
      (part, index) =>
        (index > 0 && index < segments.length - 1 && part === "") ||
        part === "." ||
        part === "..",
    )
  )
    invalid();
}
function normalizeProviderName(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(value)) invalid();
  return value;
}
function normalizeModelReference(value: string): string {
  const normalized = value.normalize("NFC");
  const separator = normalized.indexOf("/");
  if (separator <= 0) invalid();
  const provider = normalizeProviderName(normalized.slice(0, separator));
  const model = normalized.slice(separator + 1);
  if (
    !model ||
    model.length > 512 ||
    hasControl(model) ||
    model.trim() !== model ||
    Buffer.byteLength(normalized, "utf8") > 641
  )
    invalid();
  return `${provider}/${model}`;
}
function normalizeBrowserIdentity(value: unknown): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim().toLowerCase();
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized) ||
    normalized.length > 96 ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized,
    ) ||
    [
      "authorization",
      "cookie",
      "credential",
      "password",
      "private",
      "secret",
      "signature",
      "token",
    ].some((marker) => normalized.split("-").includes(marker))
  )
    invalid();
  return normalized;
}
function validateContactEmail(value: unknown): string {
  const email = stringValue(value) as string;
  const [local, domain, extra] = email.split("@");
  if (
    !local ||
    !domain ||
    extra !== undefined ||
    !domain.includes(".") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    /\s/.test(email) ||
    [...email].some((character) => (character.codePointAt(0) ?? 0) > 127)
  )
    invalid();
  return email;
}
function parseSource(
  value: unknown,
  acquisition: boolean,
): SourceSelection & Record<string, unknown> {
  const raw = value === undefined ? {} : value;
  const record = exact(
    raw,
    [],
    acquisition
      ? ["mode", "providers", "unpaywall", "sci-hub"]
      : ["mode", "providers", "limit", "web-of-science", "crossref"],
  );
  const mode = enumValue(
    record.mode ?? "auto",
    new Set(["auto", "custom"] as const),
  );
  const providers = arrayValue(record.providers ?? []).map((item) => {
    if (typeof item !== "string" || item !== item.trim()) invalid();
    return stringValue(item) as string;
  });
  const allowed = acquisition ? ACQUISITION_PROVIDERS : METADATA_PROVIDERS;
  if (
    new Set(providers).size !== providers.length ||
    providers.some((item) => !allowed.has(item))
  )
    invalid();
  if (mode === "auto" && providers.length) invalid();
  const base = {
    mode,
    providers: Object.freeze(providers),
  };
  if (!acquisition) {
    return Object.freeze({
      ...base,
      limit: record.limit === undefined ? 500 : positiveInteger(record.limit),
      web_of_science:
        record["web-of-science"] === undefined
          ? null
          : parseWebOfScience(record["web-of-science"]),
      crossref:
        record.crossref === undefined ? null : parseCrossref(record.crossref),
    });
  }
  return Object.freeze({
    ...base,
    unpaywall:
      record.unpaywall === undefined ? null : parseUnpaywall(record.unpaywall),
    sci_hub:
      record["sci-hub"] === undefined ? null : parseSciHub(record["sci-hub"]),
  });
}
function parseWebOfScience(value: unknown): Record<string, unknown> {
  const record = exact(value, ["product", "database"], ["edition"]);
  enumValue(record.product, new Set(["starter", "expanded"] as const));
  stringValue(record.database);
  if (record.edition !== undefined && record.edition !== null)
    stringValue(record.edition);
  return Object.freeze({ ...record });
}
function parseCrossref(value: unknown): Record<string, unknown> {
  const record = exact(value, ["mode"], ["mailto"]);
  const mode = enumValue(
    record.mode,
    new Set(["anonymous", "polite"] as const),
  );
  const mailto =
    record.mailto === undefined || record.mailto === null
      ? null
      : validateContactEmail(record.mailto);
  if (
    (mode === "polite" && mailto === null) ||
    (mode === "anonymous" && mailto !== null)
  )
    invalid();
  return Object.freeze({ mode, mailto });
}
function parseUnpaywall(value: unknown): Record<string, unknown> {
  const record = exact(value, ["contact_email"]);
  validateContactEmail(record.contact_email);
  return Object.freeze({ ...record });
}
function parseSciHub(value: unknown): Record<string, unknown> {
  const record = exact(value, ["urls"]);
  const urls = arrayValue(record.urls).map((item) => {
    const url = stringValue(item) as string;
    validateServiceUrl(url, true);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      invalid();
    }
    if (parsed.port) invalid();
    return url;
  });
  if (urls.length < 1 || urls.length > 8 || new Set(urls).size !== urls.length)
    invalid();
  return Object.freeze({ urls: Object.freeze(urls) });
}
function parsePolicy(value: unknown): BrowserPolicyOverride {
  const record = exact(value, [], POLICY_KEYS);
  if (record.rate_limit_group !== "browser-generic") invalid();
  const maxConcurrency =
    record.max_concurrency === undefined
      ? null
      : (positiveInteger(record.max_concurrency, 1, 1) as 1);
  const minimum =
    record.minimum_start_interval === undefined
      ? null
      : finiteNumber(record.minimum_start_interval);
  const maximum =
    record.maximum_starts_per_window === undefined
      ? null
      : positiveInteger(record.maximum_starts_per_window);
  const window =
    record.window_seconds === undefined
      ? null
      : finiteNumber(record.window_seconds, true);
  if (
    (maximum === null) !== (window === null) ||
    (minimum !== null && minimum < 1) ||
    (maximum !== null && maximum > 120) ||
    (window !== null && window < 3600)
  )
    invalid();
  const cooldown =
    record.cooldown_after_completion === undefined
      ? null
      : finiteNumber(record.cooldown_after_completion);
  const rateCooldown =
    record.rate_limit_cooldown === undefined
      ? null
      : finiteNumber(record.rate_limit_cooldown, true);
  const failure =
    record.failure_cooldown === undefined
      ? null
      : finiteNumber(record.failure_cooldown);
  const threshold =
    record.runtime_failure_threshold === undefined
      ? null
      : positiveInteger(record.runtime_failure_threshold);
  if (
    (rateCooldown !== null && rateCooldown < 60) ||
    (failure !== null && failure < 5) ||
    (threshold !== null && threshold > 3) ||
    [
      maxConcurrency,
      minimum,
      maximum,
      cooldown,
      rateCooldown,
      failure,
      threshold,
    ].every((item) => item === null)
  )
    invalid();
  return Object.freeze({
    rate_limit_group: "browser-generic",
    max_concurrency: maxConcurrency,
    minimum_start_interval: minimum,
    maximum_starts_per_window: maximum,
    window_seconds: window,
    cooldown_after_completion: cooldown,
    rate_limit_cooldown: rateCooldown,
    failure_cooldown: failure,
    runtime_failure_threshold: threshold,
  });
}

function parseConfigurationObject(
  raw: Record<string, unknown>,
): OrdinaryConfiguration {
  exact(raw, [], ROOT_KEYS);
  const paths = exact(
    optionalRecord(raw.paths),
    [],
    ["catalog_path", "artifact_root"],
  );
  const sources = exact(
    optionalRecord(raw.sources),
    [],
    ["metadata", "acquisition"],
  );
  const parsing = exact(
    optionalRecord(raw.parsing),
    [],
    [
      "base_url",
      "connection_mode",
      "model_identity",
      "remote_upload_authorized",
    ],
  );
  const assets = optionalRecord(raw.assets);
  exact(assets, []);
  const analyzeRaw = exact(
    optionalRecord(raw.analyze),
    [],
    [
      "model",
      "metadata_max_output_tokens",
      "content_max_output_tokens",
      "reference_max_output_tokens",
      "max_input_bytes",
      "max_chunk_bytes",
      "max_chunk_count",
      "max_total_llm_requests",
      "max_total_output_tokens",
    ],
  );
  const browserRaw = exact(
    optionalRecord(raw.browser),
    [],
    ["model", "enabled", "profile", "max_concurrency", "policy_overrides"],
  );
  const execution = exact(
    optionalRecord(raw.execution),
    [],
    ["max_concurrency"],
  );
  const library = exact(optionalRecord(raw.library), [], ["max_input_bytes"]);
  const providers: Record<string, ProviderConfig> = {};
  const providersRaw = raw.providers === undefined ? {} : raw.providers;
  if (!isRecord(providersRaw)) invalid();
  for (const [name, item] of Object.entries(providersRaw)) {
    if (normalizeProviderName(name) !== name || name in providers) invalid();
    const record = exact(item, ["api", "base_url"]);
    const api = stringValue(record.api) as string;
    if (!MODEL_APIS.has(api)) invalid();
    const baseUrl = stringValue(record.base_url) as string;
    validateServiceUrl(
      baseUrl,
      !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?(?:\/|$)/.test(
        baseUrl,
      ),
    );
    providers[name] = Object.freeze({ api, base_url: baseUrl });
  }
  const models: Record<string, ModelConfig> = {};
  const modelsRaw = raw.models === undefined ? {} : raw.models;
  if (!isRecord(modelsRaw)) invalid();
  for (const [reference, item] of Object.entries(modelsRaw)) {
    if (normalizeModelReference(reference) !== reference || reference in models)
      invalid();
    const record = exact(item, [], ["reasoning", "image", "stream"]);
    const provider = reference.slice(0, reference.indexOf("/"));
    if (!(provider in providers)) invalid();
    const reasoning = enumValue(
      record.reasoning ?? "default",
      REASONING,
    ) as ModelConfig["reasoning"];
    models[reference] = Object.freeze({
      reasoning,
      image: record.image === undefined ? false : booleanValue(record.image),
      stream: record.stream === undefined ? true : booleanValue(record.stream),
    });
  }
  const analyze: AnalyzeConfig = Object.freeze({
    model: textOrNull(analyzeRaw.model),
    metadata_max_output_tokens: nullablePositive(
      analyzeRaw.metadata_max_output_tokens,
    ),
    content_max_output_tokens: nullablePositive(
      analyzeRaw.content_max_output_tokens,
    ),
    reference_max_output_tokens: nullablePositive(
      analyzeRaw.reference_max_output_tokens,
    ),
    max_input_bytes: nullablePositive(analyzeRaw.max_input_bytes),
    max_chunk_bytes: nullablePositive(analyzeRaw.max_chunk_bytes),
    max_chunk_count: nullablePositive(analyzeRaw.max_chunk_count),
    max_total_llm_requests: nullablePositive(analyzeRaw.max_total_llm_requests),
    max_total_output_tokens: nullablePositive(
      analyzeRaw.max_total_output_tokens,
    ),
  });
  const analyzeModel =
    analyze.model === null ? null : normalizeModelReference(analyze.model);
  if (analyzeModel !== null && !(analyzeModel in models)) invalid();
  validateAnalysisBudgets(analyze);
  const browserModel = textOrNull(browserRaw.model);
  const browser: BrowserConfig = Object.freeze({
    model: browserModel === null ? null : normalizeModelReference(browserModel),
    enabled:
      browserRaw.enabled === undefined
        ? false
        : booleanValue(browserRaw.enabled),
    profile:
      browserRaw.profile === undefined || browserRaw.profile === null
        ? null
        : normalizeBrowserIdentity(browserRaw.profile),
    max_concurrency:
      browserRaw.max_concurrency === undefined
        ? 5
        : positiveInteger(browserRaw.max_concurrency, 2),
    policy_overrides: Object.freeze(
      arrayValue(browserRaw.policy_overrides ?? []).map(parsePolicy),
    ),
  });
  if (browser.model !== null) {
    const selected = models[browser.model];
    if (selected === undefined || !selected.image) invalid();
  }
  if (browser.enabled && browser.profile === null) invalid();
  if (
    new Set(browser.policy_overrides.map((item) => item.rate_limit_group))
      .size !== browser.policy_overrides.length
  )
    invalid();
  const connection =
    parsing.connection_mode === undefined || parsing.connection_mode === null
      ? null
      : enumValue(
          parsing.connection_mode,
          new Set(["loopback", "remote"] as const),
        );
  const baseUrl = textOrNull(parsing.base_url);
  if (baseUrl !== null)
    validateServiceUrl(
      baseUrl,
      connection === null ? null : connection === "remote",
    );
  const remoteUpload =
    parsing.remote_upload_authorized === undefined
      ? false
      : booleanValue(parsing.remote_upload_authorized);
  if (connection !== "remote" && remoteUpload) invalid();
  const result: OrdinaryConfiguration = {
    paths: Object.freeze({
      catalog_path: textOrNull(paths.catalog_path),
      artifact_root: textOrNull(paths.artifact_root),
    }),
    sources: Object.freeze({
      metadata: parseSource(
        sources.metadata,
        false,
      ) as unknown as SourcesConfig["metadata"],
      acquisition: parseSource(
        sources.acquisition,
        true,
      ) as unknown as SourcesConfig["acquisition"],
    }),
    assets: Object.freeze({}),
    parsing: Object.freeze({
      base_url: baseUrl,
      connection_mode: connection,
      model_identity: textOrNull(parsing.model_identity),
      remote_upload_authorized: remoteUpload,
    }),
    providers: Object.freeze(providers),
    models: Object.freeze(models),
    analyze: Object.freeze({ ...analyze, model: analyzeModel }),
    browser,
    execution: Object.freeze({
      max_concurrency:
        execution.max_concurrency === undefined
          ? 4
          : positiveInteger(execution.max_concurrency, 1, 64),
    }),
    library: Object.freeze({
      max_input_bytes:
        library.max_input_bytes === undefined
          ? 67_108_864
          : positiveInteger(library.max_input_bytes, 1_024, 1_073_741_824),
    }),
  };
  return freeze(result);
}
function nullablePositive(value: unknown): number | null {
  return value === undefined || value === null ? null : positiveInteger(value);
}
function validateAnalysisBudgets(value: AnalyzeConfig): void {
  if (
    value.max_input_bytes !== null &&
    value.max_chunk_bytes !== null &&
    value.max_chunk_bytes > value.max_input_bytes
  )
    invalid();
  if (value.max_total_llm_requests !== null && value.max_total_llm_requests < 2)
    invalid();
  const outputs = [
    value.metadata_max_output_tokens,
    value.content_max_output_tokens,
    value.reference_max_output_tokens,
  ].filter((item): item is number => item !== null);
  if (
    value.max_total_output_tokens !== null &&
    (outputs.some((item) => item > value.max_total_output_tokens!) ||
      (value.metadata_max_output_tokens !== null &&
        value.content_max_output_tokens !== null &&
        value.metadata_max_output_tokens + value.content_max_output_tokens >
          value.max_total_output_tokens))
  )
    invalid();
}
export function parseConfiguration(
  input: string | Uint8Array,
): OrdinaryConfiguration {
  return parseConfigurationObject(parseToml(input));
}
/** Validate the ordinary Python-owner projection through the same TS boundary. */
export function parseConfigurationProjection(
  value: unknown,
): OrdinaryConfiguration {
  if (!isRecord(value)) invalid();
  return parseConfigurationObject(value);
}
export function configurationPath(home = homedir()): string {
  return join(resolve(home), ".sciretriever", "config.toml");
}

export async function publishConfiguration(
  homeValue: string,
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<string> {
  if (
    typeof homeValue !== "string" ||
    !homeValue.startsWith("/") ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > MAX_CONFIGURATION_BYTES ||
    (expectedSha256 !== null && !/^[0-9a-f]{64}$/u.test(expectedSha256))
  )
    invalid();
  parseConfiguration(bytes);
  const directoryPath = join(resolve(homeValue), ".sciretriever");
  const targetPath = join(directoryPath, "config.toml");
  const digest = createHash("sha256").update(bytes).digest("hex");
  let directory: FileHandle | undefined;
  let temporaryPath: string | undefined;
  let lock: FileLock | undefined;
  try {
    lock = await acquireFileLock(resolve(homeValue), "configuration");
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    directory = await open(
      directoryPath,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    const directoryStat = await directory.stat();
    if (
      !directoryStat.isDirectory() ||
      !ownerOnlyDirectory(directoryStat.mode, directoryStat.uid)
    )
      invalid();
    let current: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      current = await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (expectedSha256 === null) {
      if (current !== undefined) invalid();
    } else {
      if (
        !current ||
        !current.isFile() ||
        current.nlink !== 1 ||
        (Number(current.mode) & 0o777) !== 0o600
      )
        invalid();
      const existing = await open(
        process.platform === "linux"
          ? `/proc/self/fd/${directory.fd}/config.toml`
          : targetPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        const prior = await existing.readFile();
        if (createHash("sha256").update(prior).digest("hex") !== expectedSha256)
          invalid();
      } finally {
        await existing.close();
      }
    }
    const name = `.config-${randomUUID()}.tmp`;
    temporaryPath =
      process.platform === "linux"
        ? `/proc/self/fd/${directory.fd}/${name}`
        : join(directoryPath, name);
    const staged = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await staged.write(bytes);
      await staged.sync();
    } finally {
      await staged.close();
    }
    let latest: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      latest = await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      expectedSha256 === null
        ? latest !== undefined
        : !latest || latest.nlink !== 1
    )
      invalid();
    if (expectedSha256 !== null) {
      const latestHandle = await open(
        process.platform === "linux"
          ? `/proc/self/fd/${directory.fd}/config.toml`
          : targetPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        const latestBytes = await latestHandle.readFile();
        if (
          createHash("sha256").update(latestBytes).digest("hex") !==
          expectedSha256
        )
          invalid();
      } finally {
        await latestHandle.close();
      }
    }
    if (process.platform === "linux")
      await rename(temporaryPath, `/proc/self/fd/${directory.fd}/config.toml`);
    else await rename(temporaryPath, targetPath);
    temporaryPath = undefined;
    await directory.sync();
    return digest;
  } catch (error) {
    if (error instanceof ConfigurationBoundaryError) throw error;
    invalid();
  } finally {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    await directory?.close().catch(() => undefined);
    await lock?.release().catch(() => undefined);
  }
  return invalid();
}
export interface ConfigurationReadHooks {
  readonly beforeRead?: () => void | Promise<void>;
}
export async function loadConfiguration(
  home = homedir(),
  hooks: ConfigurationReadHooks = {},
): Promise<OrdinaryConfiguration> {
  const path = configurationPath(home);
  const directoryPath = join(resolve(home), ".sciretriever");
  let directoryFile: Awaited<ReturnType<typeof open>> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directoryFile = await open(
      directoryPath,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    const directory = await directoryFile.stat();
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !ownerOnlyDirectory(directory.mode, directory.uid)
    )
      invalid();
    let named;
    try {
      named = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return parseConfiguration("");
      throw error;
    }
    if (
      named.isSymbolicLink() ||
      !named.isFile() ||
      (named.mode & 0o777) !== 0o600 ||
      named.nlink !== 1 ||
      named.size > MAX_CONFIGURATION_BYTES ||
      !ownerOnly(named.mode, named.uid)
    )
      invalid();
    file = await open(
      `/proc/self/fd/${directoryFile.fd}/config.toml`,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !ownerOnly(before.mode, before.uid) ||
      before.nlink !== 1 ||
      before.ino !== named.ino ||
      before.size > MAX_CONFIGURATION_BYTES
    )
      invalid();
    await hooks.beforeRead?.();
    const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_BYTES + 1);
    const read = await file.read(buffer, 0, buffer.byteLength, 0);
    const bytes = buffer.subarray(0, read.bytesRead);
    const after = await file.stat();
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size ||
      bytes.length > MAX_CONFIGURATION_BYTES ||
      !ownerOnly(after.mode, after.uid)
    )
      invalid();
    const namedAfter = await lstat(path);
    if (
      namedAfter.ino !== after.ino ||
      !ownerOnly(after.mode, after.uid) ||
      after.nlink !== 1
    )
      invalid();
    return parseConfiguration(bytes);
  } catch (error) {
    if (error instanceof ConfigurationBoundaryError) throw error;
    invalid();
  } finally {
    await file?.close().catch(() => undefined);
    await directoryFile?.close().catch(() => undefined);
  }
  return invalid();
}
