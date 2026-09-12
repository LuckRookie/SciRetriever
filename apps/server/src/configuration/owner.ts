import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseConfigurationReadiness,
  type ConfigurationReadiness,
} from "@sciretriever/contracts";
import {
  ConfigurationBoundaryError,
  configurationPath,
  loadConfiguration,
  parseConfiguration,
  publishConfiguration,
  type OrdinaryConfiguration,
} from "./index.js";
import {
  bundlePreview,
  editCredentialBundle,
  loadCredentialBundle,
  publishCredentialText,
  type CredentialEdit,
} from "./credentials.js";
import { acquireFileLock } from "../storage/locking.js";

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

function writeTable(
  lines: string[],
  path: readonly string[],
  value: Record<string, unknown>,
): void {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== null && item !== undefined,
  );
  if (!entries.length) return;
  lines.push(`[${path.map(quote).join(".")}]`);
  for (const [key, item] of entries) {
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      continue;
    lines.push(`${quote(key)} = ${inline(item)}`);
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
      sources: [
        "web-of-science",
        "semantic-scholar",
        "openalex",
        "elsevier",
        "springer",
        "core",
        "opencitations",
        "wiley",
      ].map((provider) => ({
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

  async status(signal?: AbortSignal): Promise<ConfigurationReadiness> {
    cancelled(signal);
    const current = await snapshot(this.home);
    const credentials = await loadCredentialBundle(this.home);
    return readiness(current.configuration, bundlePreview(credentials));
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
