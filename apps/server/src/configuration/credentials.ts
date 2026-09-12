import { open, lstat, mkdir, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigurationBoundaryError, parseToml } from "./index.js";

export type CredentialOperation =
  | "model-request"
  | "model-directory"
  | "parser-upload"
  | "parser-health"
  | "provider-request";

export interface CredentialGrant {
  readonly id: string;
  readonly namespace: "provider" | "model" | "core";
  readonly provider: string;
  readonly field: string;
  readonly origin: string | null;
  readonly operation: CredentialOperation;
  readonly expires_at: number;
}

export interface CredentialFieldPreview {
  readonly field: string;
  readonly present: boolean;
}

export interface CredentialSectionPreview {
  readonly section: string;
  readonly fields: readonly CredentialFieldPreview[];
  readonly origin: string | null;
  readonly has_transition: boolean;
}

export interface CredentialPreview {
  readonly sections: readonly CredentialSectionPreview[];
}

export class CredentialBoundaryError extends Error {
  readonly code = "credential-boundary" as const;

  constructor() {
    super("credential operation failed");
    this.name = "CredentialBoundaryError";
  }
}

interface CredentialClaims {
  readonly provider: string;
  readonly field: string;
  readonly value: string;
  readonly origin: string;
}

interface CredentialBundleData {
  readonly providers: ReadonlyMap<string, CredentialClaims>;
  readonly models: ReadonlyMap<string, CredentialClaims>;
  readonly core: ReadonlyMap<string, CredentialClaims>;
  readonly preview: CredentialPreview;
}

interface GrantClaims {
  readonly bundle: object;
  readonly id: string;
  readonly namespace: CredentialGrant["namespace"];
  readonly provider: string;
  readonly field: string;
  readonly origin: string | null;
  readonly operation: CredentialOperation;
  readonly expires_at: number;
}

const grants = new WeakMap<object, GrantClaims>();
const bundles = new WeakMap<object, CredentialBundleData>();
const OPERATIONS = new Set<CredentialOperation>([
  "model-request",
  "model-directory",
  "parser-upload",
  "parser-health",
  "provider-request",
]);
const FIELD_NAMES = new Set([
  "api_key",
  "access_token",
  "api_metric",
  "institution_token",
  "tdm_api_token",
  "bearer_token",
  "license_key",
]);
const PROVIDER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "web-of-science": ["api_key"],
  "semantic-scholar": ["api_key"],
  openalex: ["api_key"],
  elsevier: ["api_key", "institution_token"],
  springer: ["api_key", "api_metric"],
  core: ["api_key"],
  opencitations: ["access_token"],
  wiley: ["tdm_api_token"],
};

function normalizeModelProviderName(value: unknown): string {
  if (typeof value !== "string") invalid();
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/u.test(name) || name.length > 256) invalid();
  return name;
}

function invalid(): never {
  throw new CredentialBoundaryError();
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
async function readBounded(
  file: Awaited<ReturnType<typeof open>>,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(1_048_577);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const read = await file.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    offset += read.bytesRead;
    if (read.bytesRead === 0) break;
  }
  if (offset > 1_048_576) invalid();
  return buffer.subarray(0, offset);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 0 && code <= 31) || (code >= 127 && code <= 159);
  });
}
function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || hasControl(value))
    invalid();
  return value.trim();
}
function exact(
  value: unknown,
  allowed: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !allowed.includes(key) && !optional.includes(key),
    ) ||
    allowed.some((key) => !(key in value))
  )
    invalid();
  return value;
}
function normalizeOrigin(value: unknown): string {
  const text = stringValue(value);
  if (/\s|\\/u.test(text)) invalid();
  const schemeEnd = text.indexOf("://");
  const authorityEnd =
    schemeEnd < 0 ? -1 : text.slice(schemeEnd + 3).search(/[/?#]/u);
  const rawPath =
    authorityEnd < 0
      ? ""
      : (text.slice(schemeEnd + 3 + authorityEnd).split(/[?#]/u, 1)[0] ?? "");
  if (/%(?![0-9a-f]{2})/iu.test(rawPath) || /%(?:2e|2f|5c)/iu.test(rawPath))
    invalid();
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath)) invalid();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    invalid();
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    invalid();
  if (url.port === "443") url.port = "";
  return url.origin;
}
function secretValue(value: unknown): string {
  const secret = stringValue(value);
  if (secret.length > 4096) invalid();
  return secret;
}
function grantKey(provider: string, field: string): string {
  return `${provider}\u0000${field}`;
}
function validateGrant(
  grant: CredentialGrant,
  bundle: object,
  namespace: CredentialGrant["namespace"],
  provider: string,
  field: string,
  origin: string | null,
  operation: CredentialOperation,
  now: number,
): void {
  if (grant === null || typeof grant !== "object") invalid();
  const claims = grants.get(grant as object);
  if (!claims) invalid();
  if (
    typeof now !== "number" ||
    !Number.isSafeInteger(now) ||
    now >= grant.expires_at ||
    claims.bundle !== bundle ||
    claims.namespace !== namespace ||
    claims.provider !== provider ||
    claims.field !== field ||
    claims.origin !== origin ||
    claims.operation !== operation ||
    grant.id !== claims.id ||
    grant.expires_at !== claims.expires_at
  )
    invalid();
}

export function credentialPath(home = homedir()): string {
  return join(resolve(home), ".sciretriever", "credentials.toml");
}

export function issueCredentialGrant(
  bundle: CredentialBundle,
  namespace: "model" | "core",
  provider: string,
  field: string,
  origin: string,
  operation: CredentialOperation,
  ttlMs = 60_000,
  now = Date.now(),
): CredentialGrant {
  const data = bundles.get(bundle as object);
  if (!data || (namespace !== "model" && namespace !== "core")) invalid();
  const canonicalOrigin = normalizeOrigin(origin);
  const canonicalProvider =
    namespace === "model" ? normalizeModelProviderName(provider) : provider;
  if (
    !data[namespace === "model" ? "models" : "core"].has(
      grantKey(canonicalProvider, field),
    )
  )
    invalid();
  if (
    typeof provider !== "string" ||
    !provider ||
    typeof field !== "string" ||
    !field ||
    !OPERATIONS.has(operation) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 3_600_000
  )
    invalid();
  if (
    (namespace === "model" &&
      operation !== "model-request" &&
      operation !== "model-directory") ||
    (namespace === "core" &&
      operation !== "parser-upload" &&
      operation !== "parser-health")
  )
    invalid();
  const claims = data[namespace === "model" ? "models" : "core"].get(
    grantKey(canonicalProvider, field),
  );
  if (!claims || claims.origin !== canonicalOrigin) invalid();
  const grant = Object.freeze({
    id: randomUUID(),
    namespace,
    provider: canonicalProvider,
    field,
    origin: canonicalOrigin,
    operation,
    expires_at: now + ttlMs,
  });
  grants.set(grant, {
    bundle: bundle as object,
    id: grant.id,
    namespace,
    provider: canonicalProvider,
    field,
    origin: canonicalOrigin,
    operation,
    expires_at: grant.expires_at,
  });
  return grant;
}

export function issueProviderCredentialGrant(
  bundle: CredentialBundle,
  provider: string,
  field: string,
  ttlMs = 60_000,
  now = Date.now(),
): CredentialGrant {
  const data = bundles.get(bundle as object);
  const canonicalProvider = typeof provider === "string" ? provider : "";
  if (!data || !PROVIDER_FIELDS[canonicalProvider]?.includes(field)) invalid();
  if (
    typeof field !== "string" ||
    !field ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 3_600_000
  )
    invalid();
  const grant = Object.freeze({
    id: randomUUID(),
    namespace: "provider" as const,
    provider: canonicalProvider,
    field,
    origin: null,
    operation: "provider-request" as const,
    expires_at: now + ttlMs,
  });
  grants.set(grant, {
    bundle: bundle as object,
    id: grant.id,
    namespace: "provider",
    provider: canonicalProvider,
    field,
    origin: null,
    operation: "provider-request",
    expires_at: grant.expires_at,
  });
  return grant;
}

export function parseCredentialText(
  input: string | Uint8Array,
): CredentialBundle {
  const size =
    typeof input === "string"
      ? Buffer.byteLength(input, "utf8")
      : input.byteLength;
  if (size > 1_048_576) invalid();
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(input);
  } catch (error) {
    if (error instanceof ConfigurationBoundaryError) invalid();
    throw error;
  }
  const providers = new Map<string, CredentialClaims>();
  const models = new Map<string, CredentialClaims>();
  const core = new Map<string, CredentialClaims>();
  const previews: CredentialSectionPreview[] = [];
  for (const [section, value] of Object.entries(raw)) {
    if (
      section === "providers" ||
      section === "mineru" ||
      section === "cloakbrowser"
    ) {
      parseOriginBoundSection(section, value, models, core, previews);
    } else if (section in PROVIDER_FIELDS) {
      parseProviderSection(section, value, providers, previews);
    } else if (
      [
        "crossref",
        "arxiv",
        "europe-pmc",
        "datacite",
        "unpaywall",
        "sci-hub",
      ].includes(section)
    ) {
      invalid();
    } else {
      invalid();
    }
  }
  return makeBundle(providers, models, core, previews);
}

function parseProviderSection(
  section: string,
  value: unknown,
  values: Map<string, CredentialClaims>,
  previews: CredentialSectionPreview[],
): void {
  const fields = PROVIDER_FIELDS[section];
  if (!fields) invalid();
  const record = exact(value, [], fields);
  const present: CredentialFieldPreview[] = [];
  for (const [field, item] of Object.entries(record)) {
    if (!FIELD_NAMES.has(field) && field !== "api_metric") invalid();
    const secret = secretValue(item);
    values.set(section + "\u0000" + field, {
      provider: section,
      field,
      value: secret,
      origin: "",
    });
    present.push({ field, present: true });
  }
  if (!present.length) invalid();
  previews.push({
    section,
    fields: Object.freeze(present),
    origin: null,
    has_transition: false,
  });
}

function parseOriginBoundSection(
  section: string,
  value: unknown,
  models: Map<string, CredentialClaims>,
  core: Map<string, CredentialClaims>,
  previews: CredentialSectionPreview[],
): void {
  if (section === "providers") {
    if (!isRecord(value)) invalid();
    for (const [provider, nested] of Object.entries(value)) {
      const modelProvider = normalizeModelProviderName(provider);
      const record = exact(
        nested,
        ["api_key", "origin"],
        ["next_api_key", "next_origin"],
      );
      const keys = new Set(Object.keys(record));
      const primary = keys.has("api_key") && keys.has("origin");
      const transition = keys.has("next_api_key") && keys.has("next_origin");
      if (
        !primary ||
        keys.has("api_key") !== keys.has("origin") ||
        keys.has("next_api_key") !== keys.has("next_origin")
      )
        invalid();
      const origin = normalizeOrigin(record.origin);
      if (transition && normalizeOrigin(record.next_origin) === origin)
        invalid();
      const field = "api_key";
      models.set(grantKey(modelProvider, field), {
        provider: modelProvider,
        field,
        value: secretValue(record.api_key),
        origin,
      });
      if (transition)
        models.set(grantKey(modelProvider, "next_api_key"), {
          provider: modelProvider,
          field: "next_api_key",
          value: secretValue(record.next_api_key),
          origin: normalizeOrigin(record.next_origin),
        });
      previews.push({
        section: `providers.${provider}`,
        fields: Object.freeze([{ field: "api_key", present: true }]),
        origin,
        has_transition: transition,
      });
    }
    return;
  }
  const spec = section === "mineru" ? "bearer_token" : "license_key";
  const record = exact(
    value,
    [spec, "origin"],
    [`next_${spec}`, "next_origin"],
  );
  const keys = new Set(Object.keys(record));
  const primary = keys.has(spec) && keys.has("origin");
  const transition = keys.has(`next_${spec}`) && keys.has("next_origin");
  if (
    !primary ||
    keys.has(spec) !== keys.has("origin") ||
    keys.has(`next_${spec}`) !== keys.has("next_origin")
  )
    invalid();
  const origin = normalizeOrigin(record.origin);
  if (transition && normalizeOrigin(record.next_origin) === origin) invalid();
  core.set(grantKey(section, spec), {
    provider: section,
    field: spec,
    value: secretValue(record[spec]),
    origin,
  });
  if (transition)
    core.set(grantKey(section, `next_${spec}`), {
      provider: section,
      field: `next_${spec}`,
      value: secretValue(record[`next_${spec}`]),
      origin: normalizeOrigin(record.next_origin),
    });
  previews.push({
    section,
    fields: Object.freeze([{ field: spec, present: true }]),
    origin,
    has_transition: transition,
  });
}

function makeBundle(
  providers: Map<string, CredentialClaims>,
  models: Map<string, CredentialClaims>,
  core: Map<string, CredentialClaims>,
  previews: CredentialSectionPreview[],
): CredentialBundle {
  const bundle = Object.freeze({});
  bundles.set(bundle, {
    providers,
    models,
    core,
    preview: Object.freeze({ sections: Object.freeze(previews) }),
  });
  return bundle;
}

export interface CredentialBundle {
  readonly __opaque?: never;
}

/** The value-safe edit protocol shared by the configuration owner and TUI. */
export type CredentialEdit =
  | {
      readonly namespace: "model" | "mineru";
      readonly target: string;
      readonly kind: "keep" | "remove" | "set";
      readonly value?: string;
    }
  | {
      readonly namespace: "source";
      readonly target: string;
      readonly kind: "keep" | "remove" | "set";
      readonly fields?: Readonly<Record<string, string>>;
    };

export function bundlePreview(bundle: CredentialBundle): CredentialPreview {
  const data = bundles.get(bundle as object);
  if (!data) invalid();
  return data.preview;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderCredentialBundle(data: CredentialBundleData): Uint8Array {
  const lines: string[] = [];
  const write = (header: string, values: Readonly<Record<string, string>>) => {
    const entries = Object.entries(values).filter(([, value]) => value !== "");
    if (!entries.length) return;
    lines.push(`[${header}]`);
    for (const [field, value] of entries.sort(([a], [b]) => a.localeCompare(b)))
      lines.push(`${tomlString(field)} = ${tomlString(value)}`);
    lines.push("");
  };

  for (const service of ["mineru", "cloakbrowser"] as const) {
    const values: Record<string, string> = {};
    for (const claim of data.core.values()) {
      if (claim.provider === service) values[claim.field] = claim.value;
    }
    const primary = values.bearer_token ?? values.license_key;
    const origin = [...data.core.values()].find(
      (claim) =>
        claim.provider === service &&
        claim.field === (values.bearer_token ? "bearer_token" : "license_key"),
    )?.origin;
    if (primary !== undefined && origin !== undefined) {
      const field =
        values.bearer_token !== undefined ? "bearer_token" : "license_key";
      const rendered: Record<string, string> = { [field]: primary, origin };
      const next = [...data.core.values()].find(
        (claim) =>
          claim.provider === service && claim.field === `next_${field}`,
      );
      if (next) {
        rendered[`next_${field}`] = next.value;
        rendered.next_origin = next.origin;
      }
      write(service, rendered);
    }
  }

  const modelProviders = new Set(
    [...data.models.values()].map((claim) => claim.provider),
  );
  for (const provider of [...modelProviders].sort()) {
    const claims = [...data.models.values()].filter(
      (claim) => claim.provider === provider,
    );
    const primary = claims.find((claim) => claim.field === "api_key");
    if (!primary) continue;
    const rendered: Record<string, string> = {
      api_key: primary.value,
      origin: primary.origin,
    };
    const next = claims.find((claim) => claim.field === "next_api_key");
    if (next) {
      rendered.next_api_key = next.value;
      rendered.next_origin = next.origin;
    }
    write(`providers.${tomlString(provider)}`, rendered);
  }

  const providers = new Set(
    [...data.providers.values()].map((claim) => claim.provider),
  );
  for (const provider of [...providers].sort()) {
    const values: Record<string, string> = {};
    for (const claim of data.providers.values())
      if (claim.provider === provider) values[claim.field] = claim.value;
    write(provider, values);
  }
  return new TextEncoder().encode(lines.join("\n"));
}

function cloneClaims(
  values: ReadonlyMap<string, CredentialClaims>,
): Map<string, CredentialClaims> {
  return new Map([...values].map(([key, value]) => [key, { ...value }]));
}

function editValue(value: unknown): string {
  if (typeof value !== "string" || value.length > 65_536) invalid();
  return value.trim();
}

/**
 * Apply a validated owner edit to an opaque bundle and return a reparsable
 * payload. Blank set input deliberately returns null, preserving the file.
 */
export function editCredentialBundle(
  bundle: CredentialBundle,
  edit: CredentialEdit,
  origin?: string,
): Uint8Array | null {
  const data = bundles.get(bundle as object);
  if (!data || !isRecord(edit)) invalid();
  const providers = cloneClaims(data.providers);
  const models = cloneClaims(data.models);
  const core = cloneClaims(data.core);
  if (edit.namespace === "source") {
    const provider = normalizeModelProviderName(edit.target);
    const fields = PROVIDER_FIELDS[provider];
    if (!fields) invalid();
    if (edit.kind === "keep") return null;
    if (edit.kind === "remove") {
      for (const [key, claim] of providers)
        if (claim.provider === provider) providers.delete(key);
    } else {
      const updates = edit.fields;
      if (!isRecord(updates) || !Object.keys(updates).length) return null;
      const existing = new Map<string, string>();
      for (const claim of providers.values())
        if (claim.provider === provider) existing.set(claim.field, claim.value);
      for (const [field, raw] of Object.entries(updates)) {
        if (!fields.includes(field) || field === "api_metric") invalid();
        const value = editValue(raw);
        if (value) existing.set(field, value);
      }
      if (!existing.size) return null;
      for (const [key, claim] of providers)
        if (claim.provider === provider) providers.delete(key);
      for (const [field, value] of existing)
        providers.set(grantKey(provider, field), {
          provider,
          field,
          value,
          origin: "",
        });
    }
  } else {
    const target =
      edit.namespace === "model"
        ? normalizeModelProviderName(edit.target)
        : edit.target;
    if (edit.namespace === "mineru" && target !== "mineru") invalid();
    const field = edit.namespace === "mineru" ? "bearer_token" : "api_key";
    const namespace = edit.namespace === "mineru" ? core : models;
    if (edit.kind === "keep") return null;
    if (edit.kind === "remove") {
      for (const [key, claim] of namespace)
        if (claim.provider === target) namespace.delete(key);
    } else {
      const value = editValue(edit.value);
      if (!value) return null;
      const canonicalOrigin = normalizeOrigin(origin);
      for (const [key, claim] of namespace)
        if (claim.provider === target) namespace.delete(key);
      namespace.set(grantKey(target, field), {
        provider: target,
        field,
        value,
        origin: canonicalOrigin,
      });
    }
  }
  const next = makeBundle(providers, models, core, []);
  const nextData = bundles.get(next as object);
  if (!nextData) invalid();
  const bytes = renderCredentialBundle(nextData);
  parseCredentialText(bytes);
  return bytes;
}

/** Publish credentials after the caller has acquired the configuration lock. */
export async function publishCredentialText(
  home: string,
  bytes: Uint8Array,
): Promise<void> {
  if (typeof home !== "string" || !home.startsWith("/")) invalid();
  parseCredentialText(bytes);
  const directoryPath = join(resolve(home), ".sciretriever");
  const path = credentialPath(home);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryPath: string | undefined;
  try {
    directory = await open(
      directoryPath,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    const stat = await directory.stat();
    if (!stat.isDirectory() || !ownerOnlyDirectory(stat.mode, stat.uid))
      invalid();
    const existing = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (
      existing &&
      (!existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.nlink !== 1 ||
        !ownerOnly(existing.mode, existing.uid))
    )
      invalid();
    const name = `.credentials-${randomUUID()}.tmp`;
    temporaryPath = join(directoryPath, name);
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
    await rename(temporaryPath, path);
    temporaryPath = undefined;
    await directory.sync();
  } catch (error) {
    if (error instanceof CredentialBoundaryError) throw error;
    invalid();
  } finally {
    if (temporaryPath) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporaryPath).catch(() => undefined);
    }
    await directory?.close().catch(() => undefined);
  }
}

export function readCredential(
  bundle: CredentialBundle,
  grant: CredentialGrant,
  provider: string,
  field: string,
  origin: string,
  operation: CredentialOperation,
  now = Date.now(),
): string {
  const data = bundles.get(bundle as object);
  if (!data) invalid();
  const canonicalOrigin = normalizeOrigin(origin);
  const canonicalProvider =
    grant.namespace === "model"
      ? normalizeModelProviderName(provider)
      : provider;
  validateGrant(
    grant,
    bundle as object,
    grant.namespace,
    canonicalProvider,
    field,
    canonicalOrigin,
    operation,
    now,
  );
  const claim = data[grant.namespace === "model" ? "models" : "core"].get(
    grantKey(canonicalProvider, field),
  );
  if (!claim || claim.origin !== canonicalOrigin) invalid();
  return claim.value;
}

export function readProviderCredential(
  bundle: CredentialBundle,
  grant: CredentialGrant,
  provider: string,
  field: string,
  now = Date.now(),
): string {
  const data = bundles.get(bundle as object);
  if (!data || typeof provider !== "string" || typeof field !== "string")
    invalid();
  validateGrant(
    grant,
    bundle as object,
    "provider",
    provider,
    field,
    null,
    "provider-request",
    now,
  );
  const claim = data.providers.get(grantKey(provider, field));
  if (!claim || claim.origin !== "") invalid();
  return claim.value;
}

export async function loadCredentialBundle(
  home = homedir(),
): Promise<CredentialBundle> {
  const path = credentialPath(home);
  const directoryPath = join(resolve(home), ".sciretriever");
  let directoryFile: Awaited<ReturnType<typeof open>> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let directory;
    try {
      directoryFile = await open(
        directoryPath,
        fsConstants.O_RDONLY |
          (fsConstants.O_DIRECTORY ?? 0) |
          (fsConstants.O_NOFOLLOW ?? 0),
      );
      directory = await directoryFile.stat();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return makeBundle(new Map(), new Map(), new Map(), []);
      throw error;
    }
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
        return makeBundle(new Map(), new Map(), new Map(), []);
      throw error;
    }
    if (
      named.isSymbolicLink() ||
      !named.isFile() ||
      !ownerOnly(named.mode, named.uid) ||
      named.nlink !== 1 ||
      named.size > 1_048_576
    )
      invalid();
    file = await open(
      `/proc/self/fd/${directoryFile.fd}/credentials.toml`,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.ino !== named.ino ||
      !ownerOnly(before.mode, before.uid) ||
      before.nlink !== 1
    )
      invalid();
    const bytes = await readBounded(file);
    const after = await file.stat();
    const namedAfter = await lstat(path);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size ||
      namedAfter.ino !== after.ino ||
      !ownerOnly(after.mode, after.uid) ||
      after.nlink !== 1
    )
      invalid();
    return parseCredentialText(bytes);
  } catch (error) {
    if (error instanceof CredentialBoundaryError) throw error;
    invalid();
  } finally {
    await file?.close().catch(() => undefined);
    await directoryFile?.close().catch(() => undefined);
  }
  return invalid();
}
