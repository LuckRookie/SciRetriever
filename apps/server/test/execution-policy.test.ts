import { describe, expect, it } from "vitest";
import {
  ExecutionPolicy,
  ExecutionPolicyError,
} from "../src/acquisition/execution-policy.js";
import {
  ExecutionLoop,
  ExecutionLoopError,
} from "../src/acquisition/execution-loop.js";

const observation = {
  article_id: "a",
  page_id: "p",
  revision: 2,
  document_version: 1,
  viewport_version: 1,
  url: "https://example.test/a",
  title: "a",
  viewport: { width: 10, height: 10, device_scale_factor: 1 },
  frame: null,
  frame_truncated: false,
  page_state: "NORMAL" as const,
  capture_state: "NONE" as const,
};

describe("frozen execution budgets", () => {
  it("keeps usage across pause/resume and distinguishes cancellation from exhaustion", () => {
    const policy = new ExecutionPolicy("browser", "v1", {
      max_actions: 1,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 10,
      deadline_ms: 10_000,
    });
    policy.pause();
    policy.resume();
    policy.consume("action");
    expect(policy.usage().actions).toBe(1);
    policy.cancel();
    expect(policy.state()).toBe("cancelled");
    expect(() => policy.consume("action")).toThrow(ExecutionPolicyError);
    const exhausted = new ExecutionPolicy("browser", "v1", {
      max_actions: 1,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 10,
      deadline_ms: 10_000,
    });
    exhausted.consume("action");
    expect(() => exhausted.consume("action")).toThrow(ExecutionPolicyError);
    expect(exhausted.state()).toBe("exhausted");
  });
  it("rejects stale actions before dispatch and makes duplicate requests idempotent", async () => {
    const policy = new ExecutionPolicy("browser", "v1", {
      max_actions: 2,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 10,
      deadline_ms: 10_000,
    });
    let epoch = 3;
    const loop = new ExecutionLoop(policy, () => epoch);
    const execute = async () => undefined;
    await expect(
      loop.apply(
        {
          request_id: "r1",
          client_id: "c",
          epoch: 3,
          observation,
          action: { kind: "go-back", revision: 1 },
        },
        execute,
      ),
    ).rejects.toThrow(ExecutionLoopError);
    const request = {
      request_id: "r1",
      client_id: "c",
      epoch: 3,
      observation,
      action: { kind: "go-back" as const, revision: 2 },
    };
    await expect(loop.apply(request, execute)).resolves.toBe("applied");
    await expect(loop.apply(request, execute)).resolves.toBe("duplicate");
    epoch = 4;
    await expect(
      loop.apply({ ...request, request_id: "r2" }, execute),
    ).rejects.toThrow(ExecutionLoopError);
  });
});

it("claims a request before async dispatch and preserves failure on replay", async () => {
  const policy = new ExecutionPolicy("browser", "v1", {
    max_actions: 10,
    max_model_calls: 1,
    max_retries: 1,
    max_bytes: 10,
    deadline_ms: 10000,
  });
  const loop = new ExecutionLoop(policy, () => 1);
  const request = {
    request_id: "same",
    client_id: "human",
    epoch: 1,
    observation,
    action: { kind: "go-back" as const, revision: 2 },
  };
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = async () => {
    calls++;
    await gate;
  };
  const first = loop.apply(request, execute);
  const second = loop.apply(request, execute);
  release();
  expect(await first).toBe("applied");
  expect(await second).toBe("duplicate");
  expect(calls).toBe(1);
  await expect(
    loop.apply(
      { ...request, action: { kind: "press-key", key: "Tab", revision: 2 } },
      execute,
    ),
  ).rejects.toThrow();
  const failed = { ...request, request_id: "failed" };
  await expect(
    loop.apply(failed, async () => {
      calls++;
      throw new Error("synthetic failure");
    }),
  ).rejects.toThrow("synthetic failure");
  await expect(loop.apply(failed, execute)).rejects.toThrow(
    "synthetic failure",
  );
  expect(calls).toBe(2);
  expect(policy.usage().actions).toBe(2);
});
