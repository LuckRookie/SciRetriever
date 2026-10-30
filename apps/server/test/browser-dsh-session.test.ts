import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseLiteratureCurrentFacts } from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import type {
  BrowserAction,
  OperatorInput,
  WorkbenchObservation,
} from "@sciretriever/contracts";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type {
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "../src/agents/model-protocol.js";
import { createBrowserCapability } from "../src/browser/decision.js";
import type { BrowserAgentSession } from "../src/browser/decision.js";
import { BrowserArticleFlowDriver } from "../src/browser/article-flow.js";
import type { FlowPageHandle } from "../src/browser/article-flow.js";
import { BrowserObservationStore } from "../src/browser/observation.js";
import type { BrowserArticleSessionIdentity } from "../src/browser/article-session.js";
import type { BrowserPageApplyResult } from "../src/browser/page-runtime.js";
import type { BrowserPageHandle } from "../src/browser/host.js";
import { WorkbenchSession } from "../src/workbench/session.js";

const identity = (id: string): BrowserArticleSessionIdentity => ({
  session_id: `session-${id}`,
  literature_id: `article-${id}`,
  operation_id: "operation-fixture",
  generation: 0,
  metadata_snapshot: parseLiteratureCurrentFacts({
    literature: FIXTURE_LITERATURE,
    metadata_snapshot: { revision: 1, sha256: "a".repeat(64) },
    primary_asset: null,
  }).metadata_snapshot,
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function currentObservation(request: ModelRequest): WorkbenchObservation {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (!("text" in part)) continue;
      try {
        const value: unknown = JSON.parse(part.text);
        if (
          value &&
          typeof value === "object" &&
          "observation_revision" in value
        )
          return value as WorkbenchObservation;
      } catch {
        /* Other instruction parts are plain text. */
      }
    }
  }
  throw new Error("Fixture model received no Browser observation");
}

function tools(...actions: readonly BrowserAction[]): readonly ModelToolCall[] {
  return actions.map((action, index) => ({
    id: `action-${randomUUID()}-${index}`,
    name: "browser_action",
    arguments: { action },
  }));
}

async function fixture(
  script: (
    request: ModelRequest,
  ) => Promise<readonly ModelToolCall[]> | readonly ModelToolCall[],
  options: {
    context_window_tokens?: number;
    observation_text?: string;
    max_model_calls?: number;
  } = {},
) {
  const requests: ModelRequest[] = [];
  const models = new DshAgentRuntime([
    {
      role: "browser",
      provider: "fixture",
      model: "fixture-model",
      capabilities: ["image_input", "tool_decision"],
      reasoning: "default",
      stream: false,
      context_window_tokens: options.context_window_tokens ?? 128_000,
      max_output_tokens: 1024,
      adapter: {
        provider: "fixture",
        model: "fixture-model",
        execute: async () => {
          throw new Error("Single-call fallback is forbidden");
        },
        executeModel: async (
          request,
          _options,
          _signal,
          lifecycle,
        ): Promise<ModelResponse> => {
          lifecycle?.onDispatched();
          requests.push(request);
          if (request.tool_choice === "none")
            return {
              message: {
                role: "assistant",
                parts: [
                  {
                    media_type: "text/plain",
                    text: "The article goal is unchanged. Previous scrolling did not reveal an eligible PDF route. Continue from the current observation.",
                  },
                ],
              },
              stop_reason: "complete",
              provenance: {
                provider: "fixture",
                model: "fixture-model",
                usage: { input_tokens: 100, output_tokens: 25 },
              },
            };
          return {
            message: {
              role: "assistant",
              parts: [],
              tool_calls: await script(request),
            },
            stop_reason: "tool_calls",
            provenance: {
              provider: "fixture",
              model: "fixture-model",
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          };
        },
      },
    },
  ]);
  const runtime = models;
  const capability = createBrowserCapability(models);
  const drivers: BrowserArticleFlowDriver[] = [];
  return {
    requests,
    capability,
    async driver(
      id: string,
      onApply?: (
        input: OperatorInput,
        owner: BrowserArticleFlowDriver,
      ) => Promise<BrowserPageApplyResult | void>,
    ) {
      const ownerIdentity = identity(id);
      const agent = await capability.open(ownerIdentity);
      const applied: OperatorInput[] = [];
      let revision = 0;
      const page: FlowPageHandle = {
        snapshot: async () => ({
          url: `https://fixture.test/${id}`,
          title: `Article ${id}`,
          text: `${options.observation_text ?? "View"} ${revision}`,
          viewport: { width: 800, height: 600, device_scale_factor: 1 },
          screenshot: new Uint8Array([1, 2, revision]),
          document_generation: 1,
          elements: [
            {
              element_id: "download",
              role: "link",
              name: "Download PDF",
              editable: false,
            },
          ],
        }),
        apply: async (input, _generation, current) => {
          if (!current())
            throw Object.assign(new Error("Stale action"), {
              code: "browser-page-stale-action",
            });
          applied.push(input);
          const result = await onApply?.(input, driver);
          if (input.kind !== "wait-for-change") revision += 1;
          return result ?? { feedback: `Actual page result ${revision}` };
        },
      };
      const driver = new BrowserArticleFlowDriver({
        identity: ownerIdentity,
        agent,
        decide: undefined,
        page,
        article_id: ownerIdentity.literature_id,
        session_id: ownerIdentity.session_id,
        observations: new BrowserObservationStore(),
        signal: new AbortController().signal,
        max_model_calls: options.max_model_calls ?? 30,
        deadline_ms: 300_000,
        started_at: 0,
        action_cooldown_ms: 0,
        dispatch_tracking: "transport",
        awaitCandidate: async () => null,
      });
      drivers.push(driver);
      return { driver, applied, agent };
    },
    async close() {
      await Promise.all(
        drivers.map((driver) => driver.close({ kind: "cancelled" })),
      );
      await runtime.close();
      await models.close();
    },
  };
}

describe("Browser real DSH capability", () => {
  it("charges automatic compaction to the last model permit and classifies the denied next inference as a budget stop", async () => {
    const f = await fixture(
      (request) => {
        const observation = currentObservation(request);
        return tools({
          kind: "scroll-surface",
          delta_x: 0,
          delta_y: 100,
          revision: observation.observation_revision,
        });
      },
      {
        context_window_tokens: 2048,
        observation_text: "Original route observation. ".repeat(500),
        max_model_calls: 3,
      },
    );
    try {
      const { driver, applied } = await f.driver("compaction-budget");
      const result = await driver.run();
      expect(result.stopped_reason).toBe("budget");
      expect(f.requests).toHaveLength(3);
      expect(f.requests.map((request) => request.tool_choice)).toEqual([
        "required",
        "required",
        "none",
      ]);
      expect(f.requests[2]!.max_output_tokens).toBeGreaterThan(256);
      expect(driver.clock.snapshot()).toMatchObject({
        model_calls: 3,
        actions: 2,
      });
      expect(
        applied.filter((input) => input.kind === "scroll-surface"),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("closes a real DSH scope whose creation settles after Workbench shutdown has begun", async () => {
    const opened = gate();
    const f = await fixture(() => {
      throw new Error("A closed Workbench must not dispatch");
    });
    let scope: BrowserAgentSession | undefined;
    const page: BrowserPageHandle = {
      id: "closing-page",
      url: () => "https://fixture.test/closing",
      title: async () => "Closing fixture",
      close: async () => {},
      snapshot: async () => ({
        url: "https://fixture.test/closing",
        title: "Closing fixture",
        text: "Waiting for a model scope",
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot: null,
        document_generation: 1,
        elements: [],
      }),
      apply: async () => {
        throw new Error("A closed Workbench must not act");
      },
    };
    const session = new WorkbenchSession(
      "article-closing",
      page,
      {
        max_actions: 10,
        max_model_calls: 10,
        max_retries: 2,
        max_bytes: 100,
        deadline_ms: 60_000,
      },
      undefined,
      "session-closing",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      {
        open: async (identity, target) => {
          scope = await f.capability.open(identity, target);
          await opened.promise;
          return scope;
        },
      },
    );
    try {
      const client = session.attach();
      await session.refresh();
      const observation = session.view().observation!;
      session.takeover(client, session.view().control.epoch);
      const running = session.runAgent(client, session.view().control.epoch);
      await expect.poll(() => Boolean(scope)).toBe(true);
      const closing = session.close();
      opened.release();
      await Promise.all([running, closing]);
      await expect(
        scope!.run(
          {
            observation,
            frame: null,
            admitRequest: () => ({ onDispatched: () => {} }),
            executeAction: async () => ({
              status: "success",
              code: "not-called",
            }),
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "agent-session-closed" });
      expect(f.requests).toHaveLength(0);
    } finally {
      opened.release();
      await session.close();
      await f.close();
    }
  });

  it("charges exactly thirty real dispatches and lets the final action settle before the budget stop", async () => {
    const finalFeedback = gate();
    const feedbackEntered = gate();
    const f = await fixture((request) => {
      const observation = currentObservation(request);
      return tools({
        kind: "scroll-surface",
        delta_x: 0,
        delta_y: 100,
        revision: observation.observation_revision,
      });
    });
    try {
      const { driver, applied } = await f.driver(
        "budget",
        async (input, owner) => {
          if (
            input.kind === "wait-for-change" &&
            owner.clock.snapshot().model_calls === 30
          ) {
            feedbackEntered.release();
            await finalFeedback.promise;
          }
        },
      );
      const pending = driver.run();
      await Promise.race([
        feedbackEntered.promise,
        pending.then(() => {
          throw new Error("Article ended before its final page feedback began");
        }),
      ]);
      expect(f.requests).toHaveLength(30);
      expect(driver.clock.snapshot()).toMatchObject({
        model_calls: 30,
        actions: 30,
      });
      expect(driver.phase()).toBe("waiting");
      expect(await driver.step()).toMatchObject({ kind: "waiting" });
      finalFeedback.release();
      expect(await pending).toEqual({ actions: 30, stopped_reason: "budget" });
      expect(f.requests).toHaveLength(30);
      expect(
        applied.filter((input) => input.kind === "scroll-surface"),
      ).toHaveLength(30);
      expect(
        f.requests.every((request) => request.max_output_tokens === 256),
      ).toBe(true);
      expect(
        f.requests.every((request) => request.tool_choice === "required"),
      ).toBe(true);
    } finally {
      finalFeedback.release();
      await f.close();
    }
  });

  it("rejects mismatched, reentrant and closed article scopes before any additional model or page work", async () => {
    const model = gate();
    const f = await fixture(async (request) => {
      await model.promise;
      const observation = currentObservation(request);
      return tools({
        kind: "scroll-surface",
        delta_x: 0,
        delta_y: 100,
        revision: observation.observation_revision,
      });
    });
    try {
      const { driver, agent } = await f.driver("scope");
      const pending = driver.step();
      await expect.poll(() => f.requests.length).toBe(1);
      const observation = currentObservation(f.requests[0]!);
      const turn = {
        observation,
        frame: null,
        admitRequest: () => ({
          onDispatched: () => {
            throw new Error("Unexpected dispatch");
          },
        }),
        executeAction: async () => {
          throw new Error("Unexpected page action");
        },
      };
      await expect(
        agent.run(turn, new AbortController().signal),
      ).rejects.toMatchObject({ code: "agent-session-busy" });
      model.release();
      await pending;
      // Closing one owner is independent from sibling scopes and the shared runtime.
      await driver.close({ kind: "retained", code: "fixture-finished" });
      await expect(
        agent.run(turn, new AbortController().signal),
      ).rejects.toMatchObject({ code: "agent-session-closed" });
      const other = await f.driver("other");
      await expect(
        other.agent.run(turn, new AbortController().signal),
      ).rejects.toMatchObject({ code: "browser-agent-identity" });
      await other.driver.step();
      expect(f.requests).toHaveLength(2);
    } finally {
      model.release();
      await f.close();
    }
  });

  it("executes synthetic Workbench single steps inside the same DSH tools and preserves history", async () => {
    const f = await fixture((request) => {
      const observation = currentObservation(request);
      return tools(
        request.messages.some((message) => message.role === "tool")
          ? {
              kind: "stop",
              reason: "no-viable-path",
              explanation: "The current article has no further eligible route.",
            }
          : {
              kind: "scroll-surface",
              delta_x: 0,
              delta_y: 100,
              revision: observation.observation_revision,
            },
      );
    });
    const applied: OperatorInput[] = [];
    const page: BrowserPageHandle = {
      id: "manual-page",
      url: () => "https://fixture.test/manual",
      title: async () => "Manual article",
      close: async () => {},
      snapshot: async () => ({
        url: "https://fixture.test/manual",
        title: "Manual article",
        text: `Page after ${applied.length} inputs`,
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot: null,
        document_generation: 1,
        elements: [],
      }),
      apply: async (input, _generation, current) => {
        if (!current()) throw new Error("Revoked input");
        applied.push(input);
      },
    };
    const session = new WorkbenchSession(
      "article-manual",
      page,
      {
        max_actions: 10,
        max_model_calls: 10,
        max_retries: 2,
        max_bytes: 100,
        deadline_ms: 60_000,
      },
      undefined,
      "session-manual",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      f.capability,
    );
    try {
      const client = session.attach();
      await session.refresh();
      session.takeover(client, session.view().control.epoch);
      await session.runAgent(client, session.view().control.epoch);
      await session.refresh();
      session.takeover(client, session.view().control.epoch);
      await session.runAgent(client, session.view().control.epoch);
      expect(f.requests).toHaveLength(2);
      expect(
        f.requests[1]!.messages.find((message) => message.role === "tool"),
      ).toMatchObject({ status: "success" });
      expect(
        applied.filter((input) => input.kind === "scroll-surface"),
      ).toHaveLength(1);
      expect(session.view().state).toBe("finished");
    } finally {
      await session.close();
      await f.close();
    }
  }, 20_000);

  it("keeps more than six real action/result pairs and isolates sibling article history", async () => {
    const f = await fixture((request) => {
      const observation = currentObservation(request);
      const prior = request.messages.filter(
        (message) => message.role === "tool",
      ).length;
      return tools(
        prior === 8
          ? {
              kind: "stop",
              reason: "no-viable-path",
              explanation: "All visible article routes have been tried.",
            }
          : {
              kind: "scroll-surface",
              delta_x: 0,
              delta_y: 100 + prior,
              revision: observation.observation_revision,
            },
      );
    });
    try {
      const a = await f.driver("a");
      const b = await f.driver("b");
      await Promise.all([a.driver.run(), b.driver.run()]);
      expect(f.requests).toHaveLength(18);
      for (const id of ["a", "b"]) {
        const requests = f.requests.filter(
          (request) =>
            currentObservation(request).article_id === `article-${id}`,
        );
        const last = requests.at(-1)!;
        const results = last.messages.filter(
          (message) => message.role === "tool",
        );
        expect(results).toHaveLength(8);
        expect(results.every((message) => message.status === "success")).toBe(
          true,
        );
        expect(JSON.stringify(results)).toContain("Actual page result 1");
        expect(JSON.stringify(last)).not.toContain(
          `Article ${id === "a" ? "b" : "a"}`,
        );
        expect(
          last.messages
            .flatMap((message) => message.parts)
            .filter((part) => "data" in part),
        ).toHaveLength(1);
      }
      expect(
        a.applied.filter((input) => input.kind === "scroll-surface"),
      ).toHaveLength(8);
      expect(a.driver.clock.snapshot()).toMatchObject({
        model_calls: 9,
        actions: 9,
      });
    } finally {
      await f.close();
    }
  });

  it("records both batch outcomes and rejects stale revisions before executing the next legal tool", async () => {
    const f = await fixture((request) => {
      const observation = currentObservation(request);
      const results = request.messages.filter(
        (message) => message.role === "tool",
      );
      if (!results.length)
        return tools(
          {
            kind: "scroll-surface",
            delta_x: 0,
            delta_y: 100,
            revision: observation.observation_revision,
          },
          {
            kind: "scroll-surface",
            delta_x: 0,
            delta_y: 200,
            revision: observation.observation_revision,
          },
        );
      if (results.length === 2)
        return tools({
          kind: "click-point",
          x: 1,
          y: 1,
          revision: observation.observation_revision - 1,
          viewport_version: observation.viewport_revision,
        });
      return tools({
        kind: "stop",
        reason: "no-viable-path",
        explanation: "No additional article route is available.",
      });
    });
    try {
      const { driver, applied } = await f.driver("batch");
      await driver.run();
      const history = f.requests
        .at(-1)!
        .messages.filter((message) => message.role === "tool");
      expect(history.map((message) => message.status)).toEqual([
        "success",
        "rejected",
        "rejected",
      ]);
      expect(JSON.stringify(history)).toContain("browser-action-batch-limit");
      expect(JSON.stringify(history)).toContain(
        "browser-action-stale-observation",
      );
      expect(
        applied.filter((input) => input.kind !== "wait-for-change"),
      ).toHaveLength(1);
      expect(driver.clock.snapshot()).toMatchObject({
        model_calls: 3,
        actions: 2,
      });
    } finally {
      await f.close();
    }
  });

  it("releases the step while an actual wait is pending and closes the tool only after its page result", async () => {
    const wait = gate();
    const f = await fixture((request) => {
      const observation = currentObservation(request);
      return tools(
        request.messages.some((message) => message.role === "tool")
          ? {
              kind: "stop",
              reason: "no-viable-path",
              explanation: "The observed page has no eligible route.",
            }
          : {
              kind: "wait-for-change",
              timeout_ms: 100,
              revision: observation.observation_revision,
            },
      );
    });
    try {
      const { driver } = await f.driver("wait", async (input) => {
        if (input.kind === "wait-for-change") await wait.promise;
      });
      expect(await driver.step()).toMatchObject({
        kind: "waiting",
        reason: "page",
      });
      expect(driver.clock.snapshot()).toMatchObject({
        model_calls: 1,
        actions: 0,
      });
      expect(await driver.step()).toMatchObject({ kind: "waiting" });
      expect(f.requests).toHaveLength(1);
      wait.release();
      await driver.run();
      const result = f.requests[1]!.messages.find(
        (message) => message.role === "tool",
      );
      expect(result).toMatchObject({ status: "success" });
      expect(JSON.stringify(result)).toContain("browser-wait-completed");
    } finally {
      wait.release();
      await f.close();
    }
  });

  it("carries timeout counts and measured waiting into real DSH history and resets them after observed change", async () => {
    const outcomes = [
      "timeout",
      "timeout",
      "timeout",
      "changed",
      "timeout",
    ] as const;
    let calls = 0;
    let waits = 0;
    const f = await fixture((request) => {
      const observation = currentObservation(request);
      if (calls++ === outcomes.length)
        return tools({
          kind: "stop",
          reason: "no-viable-path",
          explanation:
            "Observed routes remained unavailable after repeated waits.",
        });
      return tools({
        kind: "wait-for-change",
        timeout_ms: 1000,
        revision: observation.observation_revision,
      });
    });
    try {
      const { driver } = await f.driver("wait-outcomes", async () => ({
        wait_outcome: outcomes[waits++]!,
        wait_elapsed_ms: 750,
      }));
      expect(await driver.run()).toMatchObject({
        stopped_reason: "no-viable-path",
      });
      const results = f.requests
        .at(-1)!
        .messages.filter((message) => message.role === "tool");
      expect(results).toHaveLength(5);
      expect(JSON.stringify(results[0])).toContain("browser-wait-timeout");
      expect(JSON.stringify(results[2])).toContain(
        "Consecutive unchanged waits: 3; measured waiting time: 2250 ms",
      );
      expect(JSON.stringify(results[3])).toContain("browser-wait-changed");
      expect(JSON.stringify(results[4])).toContain(
        "Consecutive unchanged waits: 1; measured waiting time: 750 ms",
      );
      const current = f.requests[3]!.messages.filter(
        (message) => message.role === "user",
      ).at(-1);
      expect(JSON.stringify(current)).toContain(
        "Consecutive unchanged waits: 3",
      );
      expect(driver.clock.snapshot().model_calls).toBe(6);
    } finally {
      await f.close();
    }
  });

  it("does not report a late completed wait as progress after its control epoch changes", async () => {
    const pending = gate();
    const f = await fixture((request) =>
      tools({
        kind: "wait-for-change",
        timeout_ms: 1000,
        revision: currentObservation(request).observation_revision,
      }),
    );
    try {
      const { driver } = await f.driver("late-wait", async () => {
        await pending.promise;
        return { wait_outcome: "changed", wait_elapsed_ms: 100 };
      });
      expect(await driver.step()).toMatchObject({
        kind: "waiting",
        reason: "page",
      });
      driver.controlEpochChanged();
      pending.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(driver.phase()).toBe("ready");
      expect(driver.clock.snapshot().actions).toBe(0);
      expect(f.requests).toHaveLength(1);
    } finally {
      pending.release();
      await f.close();
    }
  });

  it("keeps the real click result through transfer interruption and resumes the same scope with failure feedback", async () => {
    const apply = gate();
    const f = await fixture((request) => {
      const observation = currentObservation(request);
      return tools(
        request.messages.some((message) => message.role === "tool")
          ? {
              kind: "stop",
              reason: "no-viable-path",
              explanation:
                "The visible download route failed and no other route is available.",
            }
          : {
              kind: "click-element",
              element_id: "download",
              revision: observation.observation_revision,
            },
      );
    });
    try {
      const { driver } = await f.driver("transfer", async (input, owner) => {
        if (input.kind === "click-element") {
          owner.transferStarted("transfer-a");
          await apply.promise;
        }
      });
      expect(await driver.step()).toEqual({
        kind: "suspended",
        transfer_id: "transfer-a",
      });
      expect(f.requests).toHaveLength(1);
      driver.transferFailed("transfer-a", "browser-transfer-failed");
      driver.setNetworkAccess(true);
      expect(await driver.step()).toMatchObject({ kind: "waiting" });
      apply.release();
      await driver.run();
      expect(f.requests).toHaveLength(2);
      const next = f.requests[1]!;
      expect(
        next.messages.find((message) => message.role === "tool"),
      ).toMatchObject({ status: "success" });
      expect(JSON.stringify(next)).toContain("transfer-started");
      expect(JSON.stringify(next)).toContain("transfer-failed");
      expect(JSON.stringify(next)).toContain("Actual page result 1");
      expect(driver.clock.snapshot()).toMatchObject({
        model_calls: 2,
        actions: 2,
      });
    } finally {
      apply.release();
      await f.close();
    }
  });
});
