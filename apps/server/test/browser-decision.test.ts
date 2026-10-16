import { expect, it } from "vitest";
import type { AgentCall, AgentResult } from "../src/agents/protocol.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { browserAgentStopped } from "../src/browser/boundary.js";
import { createBrowserDecision } from "../src/browser/decision.js";
import { parseWorkbenchObservation } from "@sciretriever/contracts";

const observation = parseWorkbenchObservation({
  session_id: "session-1",
  article_id: "article-1",
  page_id: "page-1",
  document_generation: 1,
  observation_revision: 2,
  viewport_revision: 3,
  control_epoch: 4,
  frame_seq: 2,
  frame_available: true,
  frame_dropped: false,
  observed_at: "2026-09-10T00:00:00Z",
  url: "http://127.0.0.1/article",
  title: "Fixture",
  text: "Download PDF",
  loading: false,
  partial: false,
  page_state: "NORMAL",
  capture_state: "NONE",
  viewport: { width: 800, height: 600, device_scale_factor: 1 },
  elements: [
    {
      element_id: "element-1",
      role: "link",
      name: "Download PDF",
      editable: false,
    },
  ],
  remaining: { actions: 5, model_calls: 2, bytes: 1000, deadline_ms: 5000 },
});

function runtime(result: (call: AgentCall) => AgentResult): AgentRuntime {
  return new AgentRuntime([
    {
      role: "browser",
      provider: "fixture-provider",
      model: "fixture-model",
      capabilities: ["image_input", "tool_decision"],
      reasoning: "default",
      stream: false,
      context_window_tokens: 4096,
      max_output_tokens: 512,
      adapter: {
        provider: "fixture-provider",
        model: "fixture-model",
        execute: async (call) => result(call),
      },
    },
  ]);
}

it("composes an image-bound Browser decision and admits only the six closed actions", async () => {
  let captured: AgentCall | undefined;
  const agents = runtime((call) => {
    captured = call;
    return {
      kind: "tool",
      name: "browser_action",
      arguments: {
        action: {
          kind: "click-element",
          element_id: "element-1",
          revision: 2,
        },
      },
      provenance: {
        provider: "fixture-provider",
        model: "fixture-model",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  });
  await expect(
    createBrowserDecision(agents)(
      observation,
      new Uint8Array([1, 2]),
      new AbortController().signal,
    ),
  ).resolves.toEqual({
    kind: "click-element",
    element_id: "element-1",
    revision: 2,
  });
  expect(captured?.required_capabilities).toEqual([
    "image_input",
    "tool_decision",
  ]);
  const schema = captured!.tools![0]!.parameters;
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual(["action"]);
  const variants = (
    schema.properties as {
      action: {
        anyOf: {
          properties: Record<string, unknown>;
          required: string[];
          additionalProperties: boolean;
        }[];
      };
    }
  ).action.anyOf;
  expect(variants).toHaveLength(6);
  const stop = variants.find(
    (variant) =>
      (variant.properties.kind as { enum: string[] }).enum[0] === "stop",
  )!;
  expect(stop.properties.reason).toEqual({
    type: "string",
    enum: ["access-unavailable", "no-viable-path"],
  });
  expect(stop.required).toEqual(["kind", "reason", "explanation"]);

  for (const variant of variants) {
    expect(variant.additionalProperties).toBe(false);
    expect([...variant.required].sort()).toEqual(
      Object.keys(variant.properties).sort(),
    );
  }
  const instructions = captured?.messages[0]?.parts[0];
  expect(instructions?.media_type).toBe("text/plain");
  if (instructions?.media_type === "text/plain") {
    expect(instructions.text).toContain(
      "Obtain the main PDF of the current article",
    );
    expect(instructions.text).toContain(
      "available browser session and network access",
    );
    expect(instructions.text).toContain(
      "cookie, privacy, consent, or other blocking overlay",
    );
    expect(instructions.text).toContain("If page_state is CHALLENGE");
    expect(instructions.text).toContain("Verify, I'm human, or Continue");
    expect(instructions.text).toContain("then use WaitForChange");
    expect(instructions.text).toContain("never use a token, solver, script");
    expect(instructions.text).toContain(
      "An unchanged page is not proof of denied access",
    );
  }
  expect(
    captured?.messages[1]?.parts.some(
      (part) => part.media_type === "image/jpeg",
    ),
  ).toBe(true);

  const unsafe = runtime(() => ({
    kind: "tool",
    name: "browser_action",
    arguments: {
      kind: "type-text",
      element_id: "element-1",
      text: "secret",
      revision: 2,
    },
    provenance: {
      provider: "fixture-provider",
      model: "fixture-model",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  await expect(
    createBrowserDecision(unsafe)(
      observation,
      null,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

function decisionResult(arguments_: Record<string, unknown>): AgentResult {
  return {
    kind: "tool",
    name: "browser_action",
    arguments: { action: arguments_ },
    provenance: {
      provider: "fixture-provider",
      model: "fixture-model",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

it("omits the legacy byte projection from the Agent budget and hashes only the actual model input", async () => {
  const calls: AgentCall[] = [];
  const decide = createBrowserDecision(
    runtime((call) => {
      calls.push(call);
      return decisionResult({ kind: "stop", reason: "user" });
    }),
  );
  for (const bytes of [0, 16 * 1024 * 1024]) {
    const publicObservation = parseWorkbenchObservation({
      ...observation,
      remaining: { ...observation.remaining, bytes },
    });
    await decide(publicObservation, null, new AbortController().signal);
    expect(publicObservation.remaining.bytes).toBe(bytes);
    const payload = calls.at(-1)!.messages[1]!.parts[0]!;
    expect(payload.media_type).toBe("application/json");
    if (payload.media_type !== "application/json")
      throw new Error("Missing Agent observation");
    expect(
      (JSON.parse(payload.text) as { remaining: unknown }).remaining,
    ).toEqual({
      actions: observation.remaining.actions,
      model_calls: observation.remaining.model_calls,
      deadline_ms: observation.remaining.deadline_ms,
    });
  }
  expect(calls[0]!.input_sha256).toBe(calls[1]!.input_sha256);
});

it.each([
  { kind: "click-element", element_id: "element-1", revision: 2 },
  { kind: "click-point", x: 20, y: 30, revision: 2, viewport_version: 3 },
  { kind: "scroll-surface", delta_x: 0, delta_y: 500, revision: 2 },
  { kind: "go-back", revision: 2 },
  { kind: "wait-for-change", timeout_ms: 500, revision: 2 },
  { kind: "stop", reason: "user" },
  {
    kind: "stop",
    reason: "access-unavailable",
    explanation:
      "The article PDF route requires payment, with no available institutional alternative.",
  },
  {
    kind: "stop",
    reason: "no-viable-path",
    explanation:
      "Checked the article's PDF and full-text links; each returned the same article without a download.",
  },
])("accepts the exact discriminated fields for $kind", async (action) => {
  const agents = runtime(() => decisionResult(action));
  await expect(
    createBrowserDecision(agents)(
      observation,
      null,
      new AbortController().signal,
    ),
  ).resolves.toEqual(action);
});

it("accepts a parsed action without wire-only null fields", async () => {
  const agents = runtime(() =>
    decisionResult({
      kind: "click-element",
      element_id: "element-1",
      revision: 2,
    }),
  );
  await expect(
    createBrowserDecision(agents)(
      observation,
      null,
      new AbortController().signal,
    ),
  ).resolves.toEqual({
    kind: "click-element",
    element_id: "element-1",
    revision: 2,
  });
});

it.each([
  { kind: "type-text", element_id: "element-1", revision: 2 },
  { kind: "stop", reason: "user", url: null },
  { kind: "stop", reason: "user", revision: 2 },
  { kind: "click-element", revision: 2 },
  { kind: "click-point", x: -1, y: 2, revision: 2, viewport_version: 3 },
  { kind: null, reason: "user" },
])(
  "rejects undeclared, incomplete or invalid strict actions (%j)",
  async (action) => {
    const agents = runtime(() => decisionResult(action));
    await expect(
      createBrowserDecision(agents)(
        observation,
        null,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);

it("binds the model goal and input hash to the article identifier and version", async () => {
  const calls: AgentCall[] = [];
  const agents = runtime((call) => {
    calls.push(call);
    return {
      kind: "tool",
      name: "browser_action",
      arguments: { action: { kind: "stop", reason: "user" } },
      provenance: {
        provider: "fixture-provider",
        model: "fixture-model",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  });
  const decide = createBrowserDecision(agents);
  const target = {
    literature_id: observation.article_id,
    identifier: "doi:10.5555/target",
    version: "published",
    start_url: "https://fixture.example.test/private-delivery-context",
  };
  const signal = new AbortController().signal;
  await decide(observation, null, signal, [], target);
  const context = calls[0]!.messages[1]!.parts.flatMap((part) =>
    part.media_type === "application/json"
      ? [JSON.parse(part.text) as unknown]
      : [],
  );
  expect(context).toHaveLength(2);
  expect(context[0]).toEqual({
    ...observation,
    remaining: {
      actions: observation.remaining.actions,
      model_calls: observation.remaining.model_calls,
      deadline_ms: observation.remaining.deadline_ms,
    },
  });
  expect(context[1]).toEqual({
    target_article: {
      literature_id: observation.article_id,
      identifier: target.identifier,
      version: target.version,
    },
  });
  expect(JSON.stringify(calls[0])).not.toContain("private-delivery-context");
  const metadataTarget = {
    ...target,
    title: "Target article",
    authors: ["A. Author"],
    identifiers: [{ namespace: "doi", value: "10.5555/target" }],
    abstract_excerpt: "A bounded abstract excerpt.",
    venue: "Journal of Fixtures",
    publisher: "Fixture Press",
    publication_year: 2026,
    document_type: "article",
  };
  await decide(observation, null, signal, [], metadataTarget);
  const metadataContext = calls
    .at(-1)!
    .messages[1]!.parts.filter((part) => part.media_type === "application/json")
    .at(-1);
  expect(
    metadataContext && metadataContext.media_type === "application/json"
      ? JSON.parse(metadataContext.text)
      : null,
  ).toEqual({
    target_article: {
      literature_id: observation.article_id,
      identifier: metadataTarget.identifier,
      version: metadataTarget.version,
      title: metadataTarget.title,
      authors: metadataTarget.authors,
      identifiers: metadataTarget.identifiers,
      abstract_excerpt: metadataTarget.abstract_excerpt,
      venue: metadataTarget.venue,
      publisher: metadataTarget.publisher,
      publication_year: metadataTarget.publication_year,
      document_type: metadataTarget.document_type,
    },
  });
  expect(JSON.stringify(metadataContext)).not.toContain("start_url");
  await decide(observation, null, signal, [], {
    ...target,
    identifier: "doi:10.5555/other",
  });
  await decide(observation, null, signal, [], {
    ...target,
    version: "preprint",
  });
  await decide(observation, null, signal, ["Use the PDF button"], target);
  expect(new Set(calls.map((call) => call.input_sha256)).size).toBe(5);
  await expect(
    decide(observation, null, signal, [], {
      ...target,
      literature_id: "other-article",
    }),
  ).rejects.toThrow("target does not match");
  expect(calls).toHaveLength(5);
});

it("keeps sensitive locators and credentials out of Agent stop diagnostics", () => {
  const url = browserAgentStopped(
    "no-viable-path",
    "Tried https://example.test/pdf?signature=private and found no usable alternative.",
  );
  expect(url.reason).not.toContain("private");
  expect(url.reason).not.toContain("https://");
  const secret = browserAgentStopped(
    "access-unavailable",
    "Authorization: Bearer private-value",
  );
  expect(secret.reason).not.toContain("private-value");
  expect(secret.code).toBe("browser-agent-access-unavailable");
});
