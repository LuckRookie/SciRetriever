import type { JsonRecord } from "../../data/wire.js";
export function runtimeStatus(value: JsonRecord) {
  const messages: string[] = [];
  const runtimeCapabilities =
    value.runtime_capabilities &&
    typeof value.runtime_capabilities === "object" &&
    !Array.isArray(value.runtime_capabilities)
      ? (value.runtime_capabilities as JsonRecord)
      : null;
  const parserRuntime =
    runtimeCapabilities?.parsing &&
    typeof runtimeCapabilities.parsing === "object" &&
    !Array.isArray(runtimeCapabilities.parsing)
      ? (runtimeCapabilities.parsing as JsonRecord)
      : null;
  const parserNeedsRestart =
    parserRuntime?.assembled === false &&
    parserRuntime.unavailable_reason === "startup-credential-missing";
  const reassemblySourceNames = (
    items: unknown,
    nameField: "provider_name" | "source_name",
  ): string[] =>
    Array.isArray(items)
      ? items.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const item = value as JsonRecord;
          if (
            item.selected !== true ||
            item.assembled !== false ||
            (item.failure_code !== "credential-missing" &&
              item.failure_code !== "missing-credential")
          )
            return [];
          const name = item[nameField];
          return typeof name === "string" ? [name] : [];
        })
      : [];
  const unavailableSources = [
    ...reassemblySourceNames(runtimeCapabilities?.metadata, "provider_name"),
    ...reassemblySourceNames(runtimeCapabilities?.acquisition, "source_name"),
  ];
  const sourceNeedsRestart = unavailableSources.length > 0;
  const ordinaryConfigurationPending =
    value.ordinary_configuration_restart_required === true ||
    value.application_restart_reason === "ordinary-configuration" ||
    value.runtime_configuration_current === false;
  if (ordinaryConfigurationPending)
    messages.push(
      "普通配置已保存；当前 Application 的 Browser/Jobs 运行时仍使用启动时快照，需重启服务后生效。Probe 会读取已保存配置。",
    );
  else if (value.runtime_configuration_current === true)
    messages.push(
      "当前普通配置与 Application 启动快照一致。每次 Probe 都会读取最新配置和凭据。",
    );
  if (parserNeedsRestart)
    messages.push(
      "当前 Application 启动时缺少 MinerU 凭据，未组装 Parser。保存凭据后 Probe 可验证当前服务；实际解析需重启服务重新组装。",
    );
  else if (parserRuntime?.assembled === false)
    messages.push(
      parserRuntime.unavailable_reason === "catalog-upgrade-required"
        ? "当前文献库尚未支持双模式解析。请先备份并使用 CLI 的 storage schema-upgrade 升级，再重启服务。"
        : parserRuntime.unavailable_reason === "configuration-incomplete"
          ? "当前 Application 启动时未组装 Parser；请补齐解析配置后重新检查。"
          : "当前 Application 未组装 Parser；请检查当前解析配置与服务状态。",
    );
  if (sourceNeedsRestart)
    messages.push(
      `当前 Application 启动时未能组装已选来源（${unavailableSources.join("、")}）。保存凭据后 Probe 会读取当前凭据；来源功能需重启服务后重新组装。`,
    );
  else if (runtimeCapabilities === null)
    messages.push(
      "当前 Application 的运行能力状态不可确认。Probe 仍读取当前保存配置。",
    );
  if (value.credential_effective_at === "next-external-request")
    messages.push(
      "凭据已保存；已组装能力的下一次外部请求会按当前文件重新核验，已进入传输的请求可结算。",
    );
  if (!messages.length)
    messages.push(
      "Probe 每次重新读取配置和凭据；当前 Application 运行快照状态不可确认。",
    );
  const state =
    value.application_restart_required === true
      ? "restart-required"
      : value.application_restart_required === false
        ? "current"
        : "unknown";
  return { message: messages.join(" "), state };
}
export const SOURCE_PROVIDERS = {
  metadata: [
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
  ],
  acquisition: [
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
  ],
} as const;

export const MODEL_APIS = [
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
] as const;

export const MODEL_REASONING = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
