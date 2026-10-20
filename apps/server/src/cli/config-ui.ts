import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import type {
  ConfigurationReadiness,
  ConfigurationReadinessItem,
} from "@sciretriever/contracts";
import { Chalk } from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import {
  effectiveBrowserConcurrency,
  type OrdinaryConfiguration,
} from "../configuration/index.js";
import type {
  ConfigurationProbeRequest,
  ConfigurationProbeResult,
  ConfigurationProbeSession,
  ConfigurationSection,
  TypeScriptConfigurationSnapshot,
} from "../configuration/owner.js";
import {
  ConfigurationOwnerError,
  renderConfigurationText,
  type TypeScriptConfigurationOwner,
} from "../configuration/owner.js";
import {
  AUTO_ACQUISITION_SOURCES as ACQUISITION_AUTO,
  ACQUISITION_PROVIDER_NAMES as ACQUISITION_PROVIDERS,
  LITERATURE_PROVIDERS,
  METADATA_AUTO_PROVIDERS as METADATA_AUTO,
  METADATA_PROVIDER_NAMES as METADATA_PROVIDERS,
} from "../providers/registry.js";

export type ConfigTheme = "auto" | "dark" | "light" | "mono";

export interface ConfigUiOptions {
  readonly owner: TypeScriptConfigurationOwner;
  /** Shared read-only probe session; tests may inject a fake seam-backed session. */
  readonly probe?: Pick<ConfigurationProbeSession, "run">;
  /** Create a one-operation session so later probes read newly published settings. */
  readonly probeFactory?: () => Promise<ConfigurationProbeSession>;
  readonly theme?: ConfigTheme;
  readonly write: (text: string) => void;
}

interface Palette {
  readonly heading: (text: string) => string;
  readonly accent: (text: string) => string;
  readonly selected: (text: string) => string;
  readonly ready: (text: string) => string;
  readonly warning: (text: string) => string;
  readonly danger: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly border: (text: string) => string;
  readonly dim: (text: string) => string;
}

const REASONING = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const API_PROTOCOLS = [
  { name: "OpenAI Responses", value: "openai-responses" },
  { name: "OpenAI Chat Completions", value: "openai-chat-completions" },
  { name: "Anthropic Messages", value: "anthropic-messages" },
] as const;

function palette(theme: ConfigTheme): Palette {
  const resolved =
    theme === "mono" || process.env.NO_COLOR !== undefined
      ? "mono"
      : theme === "auto"
        ? process.env.COLORFGBG?.endsWith(";7")
          ? "light"
          : "dark"
        : theme;
  const c = new Chalk({ level: resolved === "mono" ? 0 : 1 });
  return {
    heading: c.bold.white,
    accent: resolved === "light" ? c.blue : c.cyanBright,
    selected: c.inverse.cyanBright,
    ready: resolved === "light" ? c.green : c.greenBright,
    warning: resolved === "light" ? c.hex("#b45309") : c.yellowBright,
    danger: resolved === "light" ? c.red : c.redBright,
    muted: resolved === "light" ? c.gray : c.gray,
    border: resolved === "light" ? c.blue : c.cyan,
    dim: c.dim,
  };
}

function terminalWidth(): number {
  return Math.max(60, Math.min(process.stderr.columns ?? 100, 140));
}

function visibleWidth(value: string): number {
  // ANSI escape sequences are intentionally stripped before measuring terminal cells.
  // eslint-disable-next-line no-control-regex
  return stringWidth(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ""));
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function panel(
  title: string,
  content: readonly string[],
  colors: Palette,
): string {
  const width = terminalWidth();
  const inner = width - 4;
  const wrapped = content.flatMap((line) =>
    wrapAnsi(line, inner, { hard: true, trim: false }).split("\n"),
  );
  const titleText = ` ${title} `;
  const top = `╭${colors.border(titleText)}${colors.border("─".repeat(Math.max(0, width - 2 - visibleWidth(titleText))))}╮`;
  const body = wrapped.map((line) => `│ ${pad(line, inner)} │`);
  return [top, ...body, `╰${colors.border("─".repeat(width - 2))}╯`].join("\n");
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  colors: Palette,
): string {
  const width = terminalWidth();
  const columns = headers.length;
  const available = Math.max(columns * 8, width - columns * 3 - 1);
  const natural = headers.map((header, index) =>
    Math.max(
      visibleWidth(header),
      ...rows.map((row) => visibleWidth(row[index] ?? "")),
    ),
  );
  const totalNatural = natural.reduce((sum, value) => sum + value, 0);
  const colWidths = natural.map((value) =>
    Math.max(8, Math.floor((value / Math.max(totalNatural, 1)) * available)),
  );
  let difference = available - colWidths.reduce((sum, value) => sum + value, 0);
  for (let index = 0; difference > 0; index = (index + 1) % columns) {
    colWidths[index]! += 1;
    difference -= 1;
  }
  for (
    let index = colWidths.length - 1;
    difference < 0 && index >= 0;
    index -= 1
  ) {
    const reduction = Math.min(-difference, Math.max(0, colWidths[index]! - 8));
    colWidths[index]! -= reduction;
    difference += reduction;
  }
  const horizontal = (left: string, middle: string, right: string): string =>
    `${left}${colWidths.map((value) => "─".repeat(value + 2)).join(middle)}${right}`;
  const renderRow = (row: readonly string[]): string[] => {
    const cells = row.map((value, index) =>
      wrapAnsi(value ?? "", colWidths[index]!, {
        hard: true,
        trim: false,
      }).split("\n"),
    );
    const height = Math.max(1, ...cells.map((cell) => cell.length));
    return Array.from(
      { length: height },
      (_, line) =>
        `│${cells
          .map((cell, index) => ` ${pad(cell[line] ?? "", colWidths[index]!)} `)
          .join("│")}│`,
    );
  };
  const rendered = [horizontal("┌", "┬", "┐")];
  rendered.push(...renderRow(headers.map((header) => colors.heading(header))));
  if (rows.length) {
    rendered.push(horizontal("├", "┼", "┤"));
    rows.forEach((row, index) => {
      rendered.push(...renderRow(row));
      if (index < rows.length - 1) rendered.push(horizontal("├", "┼", "┤"));
    });
  }
  rendered.push(horizontal("└", "┴", "┘"));
  return rendered.join("\n");
}

function stateText(
  state: ConfigurationReadinessItem["state"],
  colors: Palette,
): string {
  if (state === "ready") return colors.ready("READY");
  if (state === "blocked") return colors.warning("BLOCKED");
  if (state === "unavailable") return colors.danger("UNAVAILABLE");
  return colors.accent("CONFIGURED");
}

function nextText(action: ConfigurationReadinessItem["next_action"]): string {
  return {
    none: "Ready for an explicit operation",
    configure: "Review configuration",
    "set-credential": "Set matching credential",
    "select-model": "Select a capable model",
    "install-runtime": "Install or verify runtime",
    "select-profile": "Select and initialize Profile",
    "explicit-test": "Run an explicit test",
  }[action];
}

function credentialState(
  target: string,
  status: ConfigurationReadiness,
): string {
  const item = status.credentials.models.find(
    (entry) => entry.target === target,
  );
  return item?.present ? "configured" : "missing";
}

function summaryRows(
  config: OrdinaryConfiguration,
  status: ConfigurationReadiness,
  colors: Palette,
): readonly (readonly string[])[] {
  const by = (owner: ConfigurationReadinessItem["owner"], target: string) =>
    status.items.find((item) => item.owner === owner && item.target === target);
  const parse = by("parsing", "mineru");
  const analyze = by("analyze", "content");
  const browser = by("browser", "model");
  const aggregate = (
    owner: ConfigurationReadinessItem["owner"],
  ): ConfigurationReadinessItem["state"] => {
    const items = status.items.filter((item) => item.owner === owner);
    if (items.some((item) => item.state === "unavailable"))
      return "unavailable";
    if (items.some((item) => item.state === "blocked")) return "blocked";
    if (items.some((item) => item.state === "ready")) return "ready";
    return "configured";
  };
  const browserCapacity = effectiveBrowserConcurrency(config.browser);
  const browserSummary = config.browser.enabled
    ? (config.browser.model ?? "model not selected")
    : "off";
  return [
    [
      colors.accent("◆ Models"),
      `${Object.keys(config.models).length} Models · ${Object.keys(config.providers).length} Providers`,
      Object.keys(config.models).length
        ? colors.ready("configured")
        : colors.warning("incomplete"),
    ],
    [
      colors.accent("◆ Search"),
      config.sources.metadata.mode === "auto"
        ? `Auto · ${METADATA_AUTO.length} built-in Sources · Limit ${config.sources.metadata.limit ?? 500}`
        : `Custom · ${config.sources.metadata.providers.length} Sources · Limit ${config.sources.metadata.limit ?? 500}`,
      stateText(aggregate("metadata"), colors),
    ],
    [
      colors.accent("◆ Download"),
      config.sources.acquisition.mode === "auto"
        ? `Auto · ${ACQUISITION_AUTO.length} built-in Sources`
        : `Custom · ${config.sources.acquisition.providers.length} Sources`,
      stateText(aggregate("acquisition"), colors),
    ],
    [
      colors.accent("◆ Parse"),
      config.parsing.base_url ?? "MinerU not configured",
      stateText(parse?.state ?? "blocked", colors),
    ],
    [
      colors.accent("◆ Analyze"),
      config.analyze.model ?? "Model not selected",
      stateText(analyze?.state ?? "blocked", colors),
    ],
    [
      colors.accent("◆ Browser"),
      `${browserSummary} · Profile ${config.browser.profile ?? "not selected"} · Sessions ${browserCapacity.effective_sessions}/${browserCapacity.configured_sessions} · Workers ${browserCapacity.decision_workers}${browserCapacity.limiting_reason ? ` · ${browserCapacity.limiting_reason}` : ""}`,
      stateText(
        browser?.state ?? (config.browser.enabled ? "blocked" : "configured"),
        colors,
      ),
    ],
  ];
}

export function renderStatus(
  config: OrdinaryConfiguration,
  status: ConfigurationReadiness,
  theme: ConfigTheme = "auto",
): string {
  const colors = palette(theme);
  const readinessRows = status.items.map((item) => [
    item.owner,
    item.target,
    stateText(item.state, colors),
    nextText(item.next_action),
  ]);
  return [
    panel(
      "SciRetriever · Configuration Status",
      [
        colors.muted(
          "Local configuration only · no network requests · Browser not launched",
        ),
        "Config    ~/.sciretriever/config.toml",
        "Secrets   ~/.sciretriever/credentials.toml · values never displayed",
      ],
      colors,
    ),
    colors.heading("Current areas"),
    table(
      ["Area", "Current facts", "State"],
      summaryRows(config, status, colors),
      colors,
    ),
    colors.heading("Readiness"),
    table(["Owner", "Target", "State", "Next step"], readinessRows, colors),
    colors.muted("network_performed=false · browser_launched=false"),
  ].join("\n\n");
}

export function renderConfigurationTest(
  value: unknown,
  theme: ConfigTheme = "auto",
): string {
  const colors = palette(theme);
  if (value === null || typeof value !== "object") return String(value);
  const payload = value as {
    owner?: string;
    target?: string | null;
    outcome?: string;
    readiness?: ConfigurationReadiness;
  };
  const lines = [
    `Owner     ${payload.owner ?? "unknown"}`,
    `Target    ${payload.target ?? "all configured targets"}`,
    `Outcome   ${payload.outcome === "passed" ? colors.ready("PASSED") : colors.warning(payload.outcome ?? "blocked")}`,
    colors.muted(
      "This probe is bounded and does not launch Browser automatically.",
    ),
  ];
  const readiness = payload.readiness;
  return readiness
    ? [
        panel("Configuration test", lines, colors),
        table(
          ["Owner", "Target", "State", "Next step"],
          readiness.items.map((item) => [
            item.owner,
            item.target,
            stateText(item.state, colors),
            nextText(item.next_action),
          ]),
          colors,
        ),
      ].join("\n\n")
    : panel("Configuration test", lines, colors);
}

function flatten(value: unknown, prefix = ""): readonly [string, string][] {
  if (value === null || value === undefined) return [[prefix, "none"]];
  if (typeof value !== "object") return [[prefix, String(value)]];
  if (Array.isArray(value))
    return [[prefix, value.map(String).join(", ") || "none"]];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function sectionDiff(
  before: unknown,
  after: unknown,
  section: ConfigurationSection,
): readonly (readonly [string, string, string])[] {
  const left = new Map(flatten(before));
  const right = new Map(flatten(after));
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort()
    .filter((key) => left.get(key) !== right.get(key))
    .map(
      (key) =>
        [
          `${section}.${key}`,
          left.get(key) ?? "none",
          right.get(key) ?? "none",
        ] as const,
    );
}

async function publishWithReview(
  owner: TypeScriptConfigurationOwner,
  snapshot: TypeScriptConfigurationSnapshot,
  section: ConfigurationSection,
  candidate: OrdinaryConfiguration,
  write: (text: string) => void,
  colors: Palette,
): Promise<boolean> {
  const changes = sectionDiff(
    snapshot.configuration[section],
    candidate[section],
    section,
  );
  if (!changes.length) {
    write(`${colors.muted("No changes to save.")}\n`);
    return false;
  }
  write(
    `${panel(
      "Proposed configuration changes",
      [
        colors.muted(
          "Review the ordinary configuration fields before publishing.",
        ),
      ],
      colors,
    )}\n${table(["Field", "Before", "After"], changes, colors)}\n`,
  );
  const accepted = await confirm(
    { message: "Save these ordinary configuration changes?", default: false },
    { input: process.stdin, output: process.stderr },
  );
  if (!accepted) {
    write(`${colors.warning("Changes discarded.")}\n`);
    return false;
  }
  try {
    await owner.publish(renderConfigurationText(candidate), snapshot.revision, [
      section,
    ]);
    write(
      `${colors.ready("Configuration saved and re-read. The next probe and command use this revision.")}\n`,
    );
    return true;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "configuration-publish-failed";
    write(
      `${colors.danger(`Configuration was not saved: ${reason}. The draft has not been persisted.`)}\n`,
    );
    if (
      error instanceof ConfigurationOwnerError &&
      error.code === "configuration-conflict"
    ) {
      const retry = await confirm(
        {
          message:
            "Configuration changed on disk. Reload it and review this section draft again?",
          default: true,
        },
        { input: process.stdin, output: process.stderr },
      );
      if (retry) {
        const latest = await owner.read();
        const rebased = copyConfig(latest.configuration);
        (rebased as unknown as Record<string, unknown>)[section] =
          candidate[section];
        return publishWithReview(
          owner,
          latest,
          section,
          rebased,
          write,
          colors,
        );
      }
    }
    return false;
  }
}

async function runInteractiveProbe(
  options: ConfigUiOptions,
  request: ConfigurationProbeRequest,
  colors: Palette,
): Promise<void> {
  if (!options.probe && !options.probeFactory) {
    options.write(
      `${colors.warning("Probe session is unavailable; configuration was not changed.")}\n`,
    );
    return;
  }
  let session: ConfigurationProbeSession | undefined;
  try {
    const probe = options.probeFactory
      ? (session = await options.probeFactory())
      : options.probe!;
    const result: ConfigurationProbeResult = await probe.run(request, {
      authorized: true,
    });
    options.write(`${renderConfigurationTest(result, "mono")}\n`);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "configuration-probe-failed";
    options.write(
      `${colors.warning(`Probe did not complete: ${reason}. Configuration was not changed.`)}\n`,
    );
  } finally {
    session?.close();
  }
}

async function saveCredential(
  options: ConfigUiOptions,
  edit: Parameters<TypeScriptConfigurationOwner["credential"]>[0],
  revision: string,
  colors: Palette,
): Promise<boolean> {
  try {
    await options.owner.credential(edit, revision);
    options.write(`${colors.ready("Credential saved.")}\n`);
    return true;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "credential-publication-failed";
    options.write(
      `${colors.danger(`Credential was not saved: ${reason}. The ordinary configuration remains available for correction.`)}\n`,
    );
    return false;
  }
}

function copyConfig(config: OrdinaryConfiguration): OrdinaryConfiguration {
  return structuredClone(config) as OrdinaryConfiguration;
}

async function selectProvider(
  config: OrdinaryConfiguration,
  message: string,
): Promise<string | null> {
  const providers = Object.keys(config.providers).sort();
  if (!providers.length) return null;
  return select(
    {
      message,
      choices: providers.map((value) => ({ name: value, value })),
    },
    { input: process.stdin, output: process.stderr },
  );
}

async function modelsPage(
  options: ConfigUiOptions,
  currentTheme: ConfigTheme,
): Promise<void> {
  const colors = palette(currentTheme);
  while (true) {
    const snapshot = await options.owner.read();
    const status = await options.owner.status();
    const providerRows = Object.entries(snapshot.configuration.providers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, provider]) => [
        name,
        provider.api,
        provider.base_url,
        credentialState(name, status),
      ]);
    const modelRows = Object.entries(snapshot.configuration.models)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, model]) => [
        name,
        model.reasoning,
        model.image ? "image" : "text",
        model.stream ? "stream" : "json",
      ]);
    options.write(
      `${panel(
        "Models · Providers and Models",
        [
          colors.muted(
            "Providers own endpoint and credentials. Models own capability flags; tasks only select a model reference.",
          ),
        ],
        colors,
      )}\n${table(["Provider", "API", "Endpoint", "Credential"], providerRows, colors)}\n${table(["Model", "Reasoning", "Input", "Output"], modelRows, colors)}\n`,
    );
    const action = await select(
      {
        message: "Models action",
        choices: [
          { name: "Add provider", value: "add-provider" },
          {
            name: "Edit provider",
            value: "edit-provider",
            disabled: providerRows.length === 0,
          },
          {
            name: "Set provider credential",
            value: "credential",
            disabled: providerRows.length === 0,
          },
          {
            name: "Add model",
            value: "add-model",
            disabled: providerRows.length === 0,
          },
          {
            name: "Select Analyze model",
            value: "analyze",
            disabled: modelRows.length === 0,
          },
          {
            name: "Select Browser model",
            value: "browser",
            disabled: modelRows.length === 0,
          },
          { name: "Back", value: "back" },
        ],
      },
      { input: process.stdin, output: process.stderr },
    );
    if (action === "back") return;
    if (action === "credential") {
      const provider = await selectProvider(
        snapshot.configuration,
        "Provider credential",
      );
      if (!provider) continue;
      const key = await password(
        { message: `API key for ${provider} (leave empty to keep current)` },
        { input: process.stdin, output: process.stderr },
      );
      if (key) {
        await saveCredential(
          options,
          { namespace: "model", target: provider, kind: "set", value: key },
          snapshot.revision,
          colors,
        );
      }
      continue;
    }
    if (action === "add-provider" || action === "edit-provider") {
      const selected =
        action === "edit-provider"
          ? await selectProvider(snapshot.configuration, "Provider to edit")
          : null;
      const name =
        selected ??
        (
          await input(
            { message: "Provider name" },
            { input: process.stdin, output: process.stderr },
          )
        ).trim();
      if (!name) continue;
      const previous = snapshot.configuration.providers[name];
      type ApiProtocol = (typeof API_PROTOCOLS)[number]["value"];
      const knownPrevious = API_PROTOCOLS.some(
        (item) => item.value === previous?.api,
      )
        ? (previous?.api as ApiProtocol)
        : undefined;
      const api = await select<ApiProtocol>(
        {
          message: "API protocol",
          choices: API_PROTOCOLS.map((item) => ({
            name: item.name,
            value: item.value,
          })),
          ...(knownPrevious === undefined ? {} : { default: knownPrevious }),
        },
        { input: process.stdin, output: process.stderr },
      );
      const baseUrl = await input(
        {
          message: "Base URL",
          default: previous?.base_url ?? "https://api.openai.com/v1",
        },
        { input: process.stdin, output: process.stderr },
      );
      const candidate: OrdinaryConfiguration = {
        ...copyConfig(snapshot.configuration),
        providers: {
          ...snapshot.configuration.providers,
          [name]: { api, base_url: baseUrl },
        },
      };
      if (
        await publishWithReview(
          options.owner,
          snapshot,
          "providers",
          candidate,
          options.write,
          colors,
        )
      ) {
        const next = await options.owner.read();
        const key = await password(
          { message: `API key for ${name} (leave empty to keep current)` },
          { input: process.stdin, output: process.stderr },
        );
        if (key)
          await saveCredential(
            options,
            { namespace: "model", target: name, kind: "set", value: key },
            next.revision,
            colors,
          );
      }
      continue;
    }
    if (action === "add-model") {
      const provider = await selectProvider(
        snapshot.configuration,
        "Provider for model",
      );
      if (!provider) continue;
      const modelName = await input(
        { message: "Remote model name" },
        { input: process.stdin, output: process.stderr },
      );
      if (!modelName.trim()) continue;
      const reference = `${provider}/${modelName.trim()}`;
      const reasoning = await select(
        {
          message: "Reasoning effort",
          choices: REASONING.map((value) => ({ name: value, value })),
          default: "default",
        },
        { input: process.stdin, output: process.stderr },
      );
      const image = await confirm(
        { message: "Does this model accept image input?", default: false },
        { input: process.stdin, output: process.stderr },
      );
      const stream = await confirm(
        { message: "Enable streaming responses?", default: true },
        { input: process.stdin, output: process.stderr },
      );
      const candidate: OrdinaryConfiguration = {
        ...copyConfig(snapshot.configuration),
        models: {
          ...snapshot.configuration.models,
          [reference]: { reasoning, image, stream },
        },
      };
      await publishWithReview(
        options.owner,
        snapshot,
        "models",
        candidate,
        options.write,
        colors,
      );
      continue;
    }
    if (action === "analyze" || action === "browser") {
      const modelChoices = modelRows
        .map((row) => row[0])
        .filter((value): value is string => value !== undefined);
      const model = await select(
        {
          message: `${action === "analyze" ? "Analyze" : "Browser"} model`,
          choices: modelChoices.map((value) => ({ name: value, value })),
        },
        { input: process.stdin, output: process.stderr },
      );
      const section: ConfigurationSection =
        action === "analyze" ? "analyze" : "browser";
      const candidate: OrdinaryConfiguration =
        section === "analyze"
          ? {
              ...copyConfig(snapshot.configuration),
              analyze: { ...snapshot.configuration.analyze, model },
            }
          : {
              ...copyConfig(snapshot.configuration),
              browser: {
                ...snapshot.configuration.browser,
                enabled: true,
                model,
              },
            };
      await publishWithReview(
        options.owner,
        snapshot,
        section,
        candidate,
        options.write,
        colors,
      );
    }
  }
}

async function sourcesPage(
  options: ConfigUiOptions,
  currentTheme: ConfigTheme,
  kind: "metadata" | "acquisition",
): Promise<void> {
  const colors = palette(currentTheme);
  const providerChoices =
    kind === "metadata" ? METADATA_PROVIDERS : ACQUISITION_PROVIDERS;
  while (true) {
    const snapshot = await options.owner.read();
    const selection = snapshot.configuration.sources[kind];
    const builtIn = kind === "metadata" ? METADATA_AUTO : ACQUISITION_AUTO;
    options.write(
      `${panel(`${kind === "metadata" ? "Search · Metadata sources" : "Download · Acquisition sources"}`, [colors.muted(kind === "metadata" ? "Metadata discovery and PDF acquisition are separate capabilities." : "Sources are tried in order and do not imply an entitlement."), `Mode       ${selection.mode}`, `Sources    ${selection.mode === "auto" ? `built-in: ${builtIn.join(", ")}` : selection.providers.join(", ") || "none"}`, ...(kind === "metadata" ? [`Limit      ${selection.limit ?? 500} raw items / source`] : [])], colors)}\n`,
    );
    const action = await select(
      {
        message: `${kind === "metadata" ? "Search" : "Download"} action`,
        choices: [
          { name: "Use automatic sources", value: "auto" },
          { name: "Choose custom sources", value: "custom" },
          ...(kind === "metadata"
            ? [{ name: "Change per-source limit", value: "limit" } as const]
            : []),
          { name: "Back", value: "back" },
        ],
      },
      { input: process.stdin, output: process.stderr },
    );
    if (action === "back") return;
    let candidate: OrdinaryConfiguration = copyConfig(snapshot.configuration);
    const next = { ...selection };
    if (action === "auto") {
      next.mode = "auto";
      next.providers = [];
    } else if (action === "custom") {
      const selected = await checkbox(
        {
          message: "Select sources (Space toggles)",
          choices: providerChoices.map((value) => ({
            name:
              kind === "metadata"
                ? `${value} · ${LITERATURE_PROVIDERS[value]!.metadata.join(", ")}`
                : `${value} · ${LITERATURE_PROVIDERS[value]!.acquisition === "hints" ? "metadata links only; no standalone download adapter" : LITERATURE_PROVIDERS[value]!.acquisition}`,
            value,
            checked: selection.providers.includes(value),
          })),
        },
        { input: process.stdin, output: process.stderr },
      );
      next.mode = "custom";
      next.providers = selected;
    } else {
      const raw = await input(
        {
          message: "Raw item limit per source",
          default: String(selection.limit ?? 500),
        },
        { input: process.stdin, output: process.stderr },
      );
      const limit = Number(raw);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        options.write(
          `${colors.warning("Limit must be a positive integer.")}\n`,
        );
        continue;
      }
      next.limit = limit;
    }
    candidate =
      kind === "metadata"
        ? {
            ...candidate,
            sources: {
              ...candidate.sources,
              metadata:
                next as unknown as OrdinaryConfiguration["sources"]["metadata"],
            },
          }
        : {
            ...candidate,
            sources: {
              ...candidate.sources,
              acquisition:
                next as unknown as OrdinaryConfiguration["sources"]["acquisition"],
            },
          };
    await publishWithReview(
      options.owner,
      snapshot,
      "sources",
      candidate,
      options.write,
      colors,
    );
  }
}

async function parsePage(
  options: ConfigUiOptions,
  currentTheme: ConfigTheme,
): Promise<void> {
  const colors = palette(currentTheme);
  const snapshot = await options.owner.read();
  const current = snapshot.configuration.parsing;
  options.write(
    `${panel("Parse · MinerU", [colors.muted("MinerU is an operator-managed parser backend. SciRetriever does not start or own the service."), `Connection       ${current.connection_mode ?? "not configured"}`, `Endpoint         ${current.base_url ?? "not configured"}`, `Model identity   ${current.model_identity ?? "not configured"}`, `Upload access    ${current.remote_upload_authorized ? "authorized" : "not required / missing"}`, `Readiness        ${current.base_url && current.model_identity ? colors.ready("configured") : colors.warning("blocked")}`], colors)}\n`,
  );
  const action = await select(
    {
      message: "Parse action",
      choices: [
        { name: "Setup parser", value: "setup" },
        { name: "Test readiness", value: "test" },
        { name: "Back", value: "back" },
      ],
    },
    { input: process.stdin, output: process.stderr },
  );
  if (action === "back") return;
  if (action === "test") {
    await runInteractiveProbe(
      options,
      { owner: "parse", target: null, image: false },
      colors,
    );
    return;
  }
  const mode = await select(
    {
      message: "Connection mode",
      choices: [
        { name: "Loopback (local service)", value: "loopback" },
        { name: "Remote (HTTPS service)", value: "remote" },
        { name: "Clear parser configuration", value: "clear" },
      ],
      default: current.connection_mode ?? "loopback",
    },
    { input: process.stdin, output: process.stderr },
  );
  let candidate: OrdinaryConfiguration = copyConfig(snapshot.configuration);
  if (mode === "clear")
    candidate = {
      ...candidate,
      parsing: {
        archive_profile: current.archive_profile,
        base_url: null,
        connection_mode: null,
        model_identity: null,
        remote_upload_authorized: false,
      },
    };
  else {
    const baseUrl = await input(
      {
        message: "MinerU base URL",
        default:
          current.base_url ??
          (mode === "loopback"
            ? "http://127.0.0.1:8000"
            : "https://mineru.example/v1"),
      },
      { input: process.stdin, output: process.stderr },
    );
    const modelIdentity = await input(
      {
        message: "Model identity",
        default: current.model_identity ?? "mineru-3.4.4-vlm",
      },
      { input: process.stdin, output: process.stderr },
    );
    const authorized =
      mode === "remote"
        ? await confirm(
            {
              message: "Authorize remote upload?",
              default: current.remote_upload_authorized,
            },
            { input: process.stdin, output: process.stderr },
          )
        : false;
    candidate = {
      ...candidate,
      parsing: {
        archive_profile: current.archive_profile,
        base_url: baseUrl,
        connection_mode: mode,
        model_identity: modelIdentity,
        remote_upload_authorized: authorized,
      },
    };
  }
  if (
    (await publishWithReview(
      options.owner,
      snapshot,
      "parsing",
      candidate,
      options.write,
      colors,
    )) &&
    mode === "remote"
  ) {
    const next = await options.owner.read();
    const token = await password(
      { message: "MinerU token (leave empty to keep current)" },
      { input: process.stdin, output: process.stderr },
    );
    if (token)
      await saveCredential(
        options,
        { namespace: "mineru", target: "mineru", kind: "set", value: token },
        next.revision,
        colors,
      );
  }
}

async function analyzePage(
  options: ConfigUiOptions,
  currentTheme: ConfigTheme,
): Promise<void> {
  const colors = palette(currentTheme);
  const snapshot = await options.owner.read();
  const current = snapshot.configuration.analyze;
  const modelChoices = Object.keys(snapshot.configuration.models).sort();
  options.write(
    `${panel("Analyze · Content and references", [colors.muted("Analysis processes the selected inputs and records actual usage. Existing facts remain if a later stage fails."), `Model             ${current.model ?? "not selected"}`], colors)}\n`,
  );
  const action = await select(
    {
      message: "Analyze action",
      choices: [
        {
          name: "Select analysis model",
          value: "setup",
          disabled: modelChoices.length === 0,
        },
        { name: "Back", value: "back" },
      ],
    },
    { input: process.stdin, output: process.stderr },
  );
  if (action === "back") return;
  const model = await select(
    {
      message: "Analyze model",
      choices: modelChoices.map((value) => ({ name: value, value })),
      ...(current.model === null ? {} : { default: current.model }),
    },
    { input: process.stdin, output: process.stderr },
  );
  const candidate: OrdinaryConfiguration = {
    ...copyConfig(snapshot.configuration),
    analyze: {
      ...current,
      model,
    },
  };
  await publishWithReview(
    options.owner,
    snapshot,
    "analyze",
    candidate,
    options.write,
    colors,
  );
}

async function browserPage(
  options: ConfigUiOptions,
  currentTheme: ConfigTheme,
): Promise<void> {
  const colors = palette(currentTheme);
  const snapshot = await options.owner.read();
  const current = snapshot.configuration.browser;
  const imageModels = Object.entries(snapshot.configuration.models)
    .filter(([, model]) => model.image)
    .map(([reference]) => reference)
    .sort();
  options.write(
    `${panel("Browser · Setup and Runtime", [colors.muted("Browser is separately controlled and only starts for an explicit operation."), `Enabled       ${current.enabled ? "yes" : "no"}`, `Model         ${current.model ?? "not selected"}`, `Profile       ${current.profile ?? "not selected"}`, `Concurrency   ${current.max_concurrency}`, `Runtime       ${process.env.SCIRETRIEVER_CLOAK_BUNDLE ? "bundle selected" : "operator bundle not configured"}`], colors)}\n`,
  );
  const action = await select(
    {
      message: "Browser action",
      choices: [
        { name: "Setup Browser", value: "setup" },
        {
          name: "Test model",
          value: "test-model",
          disabled: imageModels.length === 0,
        },
        { name: "Back", value: "back" },
      ],
    },
    { input: process.stdin, output: process.stderr },
  );
  if (action === "back") return;
  if (action === "test-model") {
    await runInteractiveProbe(
      options,
      { owner: "browser-model", target: null, image: true },
      colors,
    );
    return;
  }
  const enabled = await confirm(
    { message: "Enable Browser operations?", default: current.enabled },
    { input: process.stdin, output: process.stderr },
  );
  let candidate: OrdinaryConfiguration = copyConfig(snapshot.configuration);
  if (!enabled)
    candidate = {
      ...candidate,
      browser: { ...current, enabled: false, model: null },
    };
  else {
    if (!imageModels.length) {
      options.write(
        `${colors.warning("An image-capable Model is required before Browser can be enabled.")}\n`,
      );
      return;
    }
    const model = await select(
      {
        message: "Browser model",
        choices: imageModels.map((value) => ({ name: value, value })),
        ...(current.model === null ? {} : { default: current.model }),
      },
      { input: process.stdin, output: process.stderr },
    );
    const profile = await input(
      { message: "Profile name", default: current.profile ?? "default" },
      { input: process.stdin, output: process.stderr },
    );
    candidate = {
      ...candidate,
      browser: { ...current, enabled: true, model, profile },
    };
  }
  await publishWithReview(
    options.owner,
    snapshot,
    "browser",
    candidate,
    options.write,
    colors,
  );
}

async function themePage(
  currentTheme: ConfigTheme,
  write: (text: string) => void,
): Promise<ConfigTheme> {
  const colors = palette(currentTheme);
  write(
    `${panel("Theme", [colors.muted("Theme changes terminal appearance only. NO_COLOR always forces Mono."), `Current     ${currentTheme}`], colors)}\n`,
  );
  return select(
    {
      message: "Theme",
      choices: [
        { name: "Auto", value: "auto" },
        { name: "Dark", value: "dark" },
        { name: "Light", value: "light" },
        { name: "Mono", value: "mono" },
      ],
      default: currentTheme,
    },
    { input: process.stdin, output: process.stderr },
  );
}

export async function runRichConfigurationCenter(
  options: ConfigUiOptions,
): Promise<number> {
  let theme = options.theme ?? "auto";
  try {
    while (true) {
      const snapshot = await options.owner.read();
      const status = await options.owner.status();
      const colors = palette(theme);
      options.write(
        `${panel("SciRetriever · Configuration", [colors.muted("LOCAL CONFIGURATION · NO NETWORK REQUESTS"), "Config    ~/.sciretriever/config.toml", "Secrets   ~/.sciretriever/credentials.toml · presence only"], colors)}\n\n`,
      );
      options.write(
        `${table(["Area", "Current facts", "State"], summaryRows(snapshot.configuration, status, colors), colors)}\n\n`,
      );
      const action = await select(
        {
          message: "Open a configuration area",
          choices: [
            { name: "Models", value: "models" },
            { name: "Search", value: "search" },
            { name: "Download", value: "download" },
            { name: "Parse", value: "parse" },
            { name: "Analyze", value: "analyze" },
            { name: "Browser", value: "browser" },
            { name: "Status", value: "status" },
            { name: "Theme", value: "theme" },
            { name: "Quit", value: "quit" },
          ],
        },
        { input: process.stdin, output: process.stderr },
      );
      if (action === "quit") return 0;
      if (action === "status") {
        options.write(
          `${renderStatus(snapshot.configuration, status, theme)}\n`,
        );
      } else if (action === "theme") {
        theme = await themePage(theme, options.write);
      } else if (action === "models") {
        await modelsPage(options, theme);
      } else if (action === "search") {
        await sourcesPage(options, theme, "metadata");
      } else if (action === "download") {
        await sourcesPage(options, theme, "acquisition");
      } else if (action === "parse") {
        await parsePage(options, theme);
      } else if (action === "analyze") {
        await analyzePage(options, theme);
      } else if (action === "browser") {
        await browserPage(options, theme);
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "ExitPromptError" || error.name === "AbortError")
    )
      return 130;
    throw error;
  }
}

export function renderPlainHome(
  config: OrdinaryConfiguration,
  status: ConfigurationReadiness,
): string {
  const colors = palette("mono");
  return [
    "SciRetriever configuration center",
    "Local status only · no network requests",
    "",
    table(
      ["Area", "Current facts", "State"],
      summaryRows(config, status, colors),
      colors,
    ),
    "",
    "Choose M/S/D/P/A/B/I/T/Q.",
  ].join("\n");
}
