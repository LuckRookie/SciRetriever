import type { OrdinaryConfiguration } from "../configuration/index.js";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
export function configuredAgentModels(configuration: OrdinaryConfiguration) {
  const values = [];
  const roleModels: readonly [
    import("../agents/protocol.js").AgentRole,
    string | null,
  ][] = [
    ["analysis", configuration.analyze.model],
    [
      "proofreading",
      configuration.proofread.model ?? configuration.analyze.model,
    ],
    ["tagging", configuration.tags.model ?? configuration.analyze.model],
    [
      "tag-consolidation",
      configuration.tags.consolidation_model ??
        configuration.tags.model ??
        configuration.analyze.model,
    ],
    [
      "tag-backfill",
      configuration.tags.backfill_model ??
        configuration.tags.model ??
        configuration.analyze.model,
    ],
    [
      "browser",
      configuration.browser.enabled ? configuration.browser.model : null,
    ],
  ];
  for (const [role, reference] of roleModels) {
    if (reference === null) continue;
    const value = agentModel(configuration, role, reference);
    if (value) values.push(value);
  }
  return values;
}
/** One registered model bound to one role, or null when it is not registered. */
export function agentModel(
  configuration: OrdinaryConfiguration,
  role: import("../agents/protocol.js").AgentRole,
  reference: string,
) {
  const providerName = reference.slice(0, reference.indexOf("/"));
  const modelName = reference.slice(reference.indexOf("/") + 1);
  const provider = configuration.providers[providerName];
  const config = configuration.models[reference];
  if (!provider || !config) return null;
  return { role, reference, providerName, modelName, provider, config };
}
export function endpoint(baseUrl: string, api: string): string {
  const suffix =
    api === "openai-responses"
      ? "/responses"
      : api === "openai-chat-completions"
        ? "/chat/completions"
        : "/messages";
  const base = new URL(baseUrl);
  if (base.pathname.endsWith("/")) base.pathname = base.pathname.slice(0, -1);
  base.pathname = `${base.pathname}${suffix}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

/** Pure effective identity; no credentials, transport, parser or model construction. */
export function configuredAgentIdentity(
  configuration: OrdinaryConfiguration,
): Pick<DshAgentRuntime, "readiness" | "effectiveIdentity"> {
  const roles = configuredAgentModels(configuration);
  return {
    readiness: (role) => {
      const entry = roles.find((v) => v.role === role);
      return {
        configured: !!entry,
        missing:
          entry &&
          ["proofreading", "browser"].includes(role) &&
          !entry.config.image
            ? ["image_input"]
            : [],
      };
    },
    effectiveIdentity: (role) => {
      const entry = roles.find((v) => v.role === role);
      if (!entry) throw new Error("agent-configuration");
      return {
        provider: entry.providerName,
        model: entry.modelName,
        reasoning: entry.config.reasoning,
        stream: entry.config.stream,
        context_window_tokens: 1000000,
        max_output_tokens: 1000000,
        transport: {
          api: entry.provider.api,
          endpoint: endpoint(entry.provider.base_url, entry.provider.api),
        },
      };
    },
  };
}
