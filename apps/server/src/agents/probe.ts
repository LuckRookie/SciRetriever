import { createHash } from "node:crypto";
import type { NetworkBudgetCoordinator } from "../network/budget.js";
import type { ConnectionDependencies } from "../network/connection.js";
import { createAgentTransport } from "../network/http.js";
import { systemResolver } from "../network/probe.js";
import type { Resolver } from "../network/policy.js";
import {
  bundlePreview,
  CredentialBoundaryError,
  issueCredentialGrant,
  readCredential,
  type CredentialBundle,
} from "../configuration/credentials.js";
import type { OrdinaryConfiguration } from "../configuration/index.js";
import {
  AgentFailure,
  type AgentCapability,
  type AgentCall,
  type AgentResult,
  type AgentRole,
  type AgentStructuredResult,
  type AgentToolCall,
  type AgentToolDeclaration,
  type AgentTransport,
  type ReasoningEffort,
} from "./protocol.js";
import { DshAgentRuntime, type AgentBinding } from "./dsh/runtime.js";
import { AnthropicMessagesAdapter } from "./anthropic.js";
import { OpenAIChatAdapter, OpenAIResponsesAdapter } from "./openai.js";

/**
 * The configuration probe's Agent payloads are fixed, minimal and closed: they
 * never carry user Literature, PDFs, pages or screenshots. Both the wire body
 * and the accepted answer are part of the probe contract.
 */
export const PROBE_TEXT_PAYLOAD = '{"probe":"sciretriever-configuration"}';
export const PROBE_RESULT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: "object",
    properties: Object.freeze({ ok: Object.freeze({ type: "boolean" }) }),
    required: Object.freeze(["ok"]),
    additionalProperties: false,
  });
export const PROBE_STOP_TOOL: AgentToolDeclaration = Object.freeze({
  name: "sciretriever_probe_stop",
  description:
    "Report that the synthetic configuration probe image was received.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      received: Object.freeze({ type: "boolean" }),
    }),
    required: Object.freeze(["received"]),
    additionalProperties: false,
  }),
});
/** One program-generated 1x1 JPEG: no text, no user pixels, no metadata. */
export const PROBE_IMAGE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCn/9k=";
export const PROBE_MAX_OUTPUT_TOKENS = 64;

export class ProbeModelError extends Error {
  constructor(
    readonly code:
      | "model-provider-not-configured"
      | "model-not-configured"
      | "model-api-unsupported"
      | "model-credential-unavailable"
      | "model-credential-not-allowed",
  ) {
    super("configuration probe model is unavailable");
    this.name = "ProbeModelError";
  }
}

export interface ProbeModelTarget {
  readonly provider_name: string;
  readonly model_name: string;
  readonly model_reference: string;
  readonly endpoint: string;
  readonly origin: string;
  readonly api: string;
  readonly credential: string | null;
  readonly reasoning: ReasoningEffort;
  readonly stream: boolean;
  readonly image: boolean;
}

export function probeImage(): {
  readonly data: Uint8Array;
  readonly width: 1;
  readonly height: 1;
} {
  return {
    data: new Uint8Array(Buffer.from(PROBE_IMAGE_JPEG_BASE64, "base64")),
    width: 1,
    height: 1,
  };
}

function endpointOf(baseUrl: string, api: string): string {
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

/**
 * Resolve one exact Model reference into the same wire identity the production
 * Application would use. The probe never invents a provider, endpoint or model:
 * a missing or mismatched declaration fails closed.
 */
export function resolveProbeModelTarget(
  configuration: OrdinaryConfiguration,
  credentials: CredentialBundle,
  reference: string,
): ProbeModelTarget {
  const separator = reference.indexOf("/");
  const providerName = separator < 0 ? "" : reference.slice(0, separator);
  const modelName = separator < 0 ? "" : reference.slice(separator + 1);
  const provider = configuration.providers[providerName];
  if (!provider) throw new ProbeModelError("model-provider-not-configured");
  const model = configuration.models[reference];
  if (!model) throw new ProbeModelError("model-not-configured");
  let endpoint: string;
  let origin: string;
  let local: boolean;
  try {
    endpoint = endpointOf(provider.base_url, provider.api);
    const base = new URL(provider.base_url);
    origin = base.origin;
    local = base.protocol === "http:";
  } catch {
    throw new ProbeModelError("model-api-unsupported");
  }
  let credential: string | null = null;
  try {
    if (local) {
      const presented = bundlePreview(credentials).sections.some(
        (section) =>
          section.section === `providers.${providerName}` &&
          section.fields.some((field) => field.present),
      );
      if (presented) throw new ProbeModelError("model-credential-not-allowed");
    } else {
      const granted = issueCredentialGrant(
        credentials,
        "model",
        providerName,
        "api_key",
        origin,
        "model-request",
      );
      credential = readCredential(
        credentials,
        granted,
        providerName,
        "api_key",
        origin,
        "model-request",
      );
    }
  } catch (error) {
    if (error instanceof ProbeModelError) throw error;
    if (error instanceof CredentialBoundaryError)
      throw new ProbeModelError("model-credential-unavailable");
    throw error;
  }
  return {
    provider_name: providerName,
    model_name: modelName,
    model_reference: reference,
    endpoint,
    origin,
    api: provider.api,
    credential,
    reasoning: model.reasoning,
    stream: model.stream,
    image: model.image,
  };
}

export interface ProbeAgentRuntimeOptions {
  readonly coordinator: NetworkBudgetCoordinator;
  readonly role: AgentRole;
  readonly capabilities: readonly AgentCapability[];
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
  /** Offline seam: replaces only the socket-level transport, not the adapter. */
  readonly transport?: AgentTransport;
}

/** Build the single-binding runtime an explicit Model probe uses. */
export function createProbeAgentRuntime(
  target: ProbeModelTarget,
  options: ProbeAgentRuntimeOptions,
): DshAgentRuntime {
  let transport: AgentTransport;
  if (options.transport) transport = options.transport;
  else {
    const url = new URL(target.endpoint);
    const local = url.protocol === "http:";
    const raw = createAgentTransport({
      resolver: options.resolver ?? systemResolver(),
      policy: {
        allowed_schemes: [local ? "http" : "https"],
        allowed_classes: [local ? "loopback" : "public"],
        allowed_origins: [
          {
            scheme: local ? "http" : "https",
            hostname: url.hostname,
            port: Number(url.port || (local ? 80 : 443)),
          },
        ],
        allowed_ports: [
          {
            scheme: local ? "http" : "https",
            port: Number(url.port || (local ? 80 : 443)),
          },
        ],
        ...(local
          ? {
              allowed_addresses:
                url.hostname === "localhost"
                  ? ["127.0.0.1", "::1"]
                  : [url.hostname.replace(/^\[|\]$/gu, "")],
            }
          : {}),
      },
      coordinator: options.coordinator,
      scope: "configuration-probe",
      limits: {
        maxConcurrency: 1,
        maxHostConcurrency: 1,
        maxResponseBytes: 4_194_304,
        maxRedirects: 0,
        maxRetries: 0,
      },
      ...(options.connection ? { connection: options.connection } : {}),
      maxRedirects: 0,
      maxRetries: 0,
    });
    const expected = target.endpoint;
    transport = (request) => {
      if (request.endpoint !== expected)
        throw new AgentFailure("agent-configuration");
      return raw(request);
    };
  }
  const binding: AgentBinding = {
    role: options.role,
    provider: target.provider_name,
    model: target.model_name,
    capabilities: options.capabilities,
    reasoning: target.reasoning,
    stream: target.stream,
    context_window_tokens: 1_000_000,
    max_output_tokens: 1_000_000,
    adapter: adapterFor(target, transport),
  };
  return new DshAgentRuntime([binding]);
}

function adapterFor(
  target: ProbeModelTarget,
  transport: AgentTransport,
): AgentBinding["adapter"] {
  const config = {
    provider: target.provider_name,
    model: target.model_name,
    endpoint: target.endpoint,
    credential: target.credential,
    transport,
  };
  if (target.api === "openai-responses")
    return new OpenAIResponsesAdapter(config);
  if (target.api === "openai-chat-completions")
    return new OpenAIChatAdapter(config);
  return new AnthropicMessagesAdapter(config);
}

function fixedInputSha256(): string {
  return createHash("sha256").update(PROBE_TEXT_PAYLOAD).digest("hex");
}

/** Send the fixed strict-schema Text probe and require exactly `{"ok":true}`. */
export async function executeProbeText(
  runtime: DshAgentRuntime,
  role: AgentRole,
  signal?: AbortSignal,
): Promise<AgentStructuredResult> {
  const call: AgentCall = {
    role,
    messages: [
      {
        role: "user",
        parts: [{ media_type: "application/json", text: PROBE_TEXT_PAYLOAD }],
      },
    ],
    required_capabilities: ["structured_text"],
    input_sha256: fixedInputSha256(),
    response_schema: { ...PROBE_RESULT_SCHEMA },
    max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
  };
  const result: AgentResult = await runtime.execute(call, signal);
  if (result.kind !== "structured")
    throw new AgentFailure("agent-probe-response");
  const value = result.value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "ok" || value.ok !== true)
    throw new AgentFailure("agent-probe-response");
  return result;
}

/** Send the synthetic 1x1 image plus one closed stop tool. */
export async function executeProbeImage(
  runtime: DshAgentRuntime,
  role: AgentRole,
  signal?: AbortSignal,
): Promise<AgentToolCall> {
  const image = probeImage();
  const call: AgentCall = {
    role,
    messages: [
      {
        role: "user",
        parts: [
          {
            media_type: "image/jpeg",
            data: image.data,
            width: image.width,
            height: image.height,
          },
        ],
      },
    ],
    required_capabilities: ["image_input", "tool_decision"],
    input_sha256: createHash("sha256").update(image.data).digest("hex"),
    tools: [PROBE_STOP_TOOL],
    max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
  };
  const result: AgentResult = await runtime.execute(call, signal);
  if (result.kind !== "tool" || result.name !== PROBE_STOP_TOOL.name)
    throw new AgentFailure("agent-probe-response");
  return result;
}
