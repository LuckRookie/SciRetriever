import { expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createMinerUProtocolTransport } from "../src/parsing/backends/mineru/protocol.js";
import { parseMinerUHealth } from "../src/parsing/backends/mineru/health.js";
import type { MinerUHttpTransport } from "../src/parsing/backends/mineru/http.js";

const health = {
  status: "healthy",
  version: "3.4.4",
  protocol_version: 2,
  queued_tasks: 1,
  processing_tasks: 0,
  max_concurrent_requests: 1,
  future_field: { ignored: true },
};
const input = { body: new Uint8Array([1, 2]), headers: {} };
const response = (value: unknown, status = 200) => ({
  status,
  headers: [["content-type", "application/json"]] as readonly (readonly [
    string,
    string,
  ])[],
  body: Buffer.from(JSON.stringify(value)),
});

it("shares an extensible health schema without accepting invalid required fields", () => {
  expect(parseMinerUHealth(Buffer.from(JSON.stringify(health)))).toEqual({
    status: "healthy",
    version: "3.4.4",
    protocol_version: 2,
    profile: null,
  });
  for (const value of [
    { ...health, status: "unhealthy" },
    { ...health, version: "3.5.0" },
    { ...health, protocol_version: "2" },
    { ...health, version: undefined },
    { ...health, profile: 1 },
  ])
    expect(() =>
      parseMinerUHealth(Buffer.from(JSON.stringify(value))),
    ).toThrow();
  expect(() =>
    parseMinerUHealth(
      Buffer.from(
        '{"status":"healthy","status":"healthy","version":"3.4.4","protocol_version":2}',
      ),
    ),
  ).toThrow();
});

function service(completeAfter = 1) {
  const calls: { url: string; method: string | undefined }[] = [];
  let polls = 0;
  const transport: MinerUHttpTransport = {
    request: async (url, options) => {
      calls.push({ url, method: options.method });
      if (url.endsWith("/health")) return response(health);
      if (url.endsWith("/tasks")) {
        expect(Buffer.from(options.body).toString()).toContain(
          'name="return_md"\r\n\r\ntrue',
        );
        return response(
          {
            task_id: "fixture-task",
            status: "pending",
            queued_ahead: 1,
            result_url: "https://untrusted.example.test/private",
          },
          202,
        );
      }
      if (url.endsWith("/result"))
        return {
          status: 200,
          headers: [["content-type", "application/zip"]],
          body: new Uint8Array([80, 75]),
        };
      polls++;
      return response({
        task_id: "fixture-task",
        status: polls >= completeAfter ? "completed" : "processing",
        error: null,
      });
    },
  };
  return { transport, calls };
}

it("waits for more than 120 polls within its deadline and keeps requests at the configured origin and prefix", async () => {
  const fake = service(125);
  const client = createMinerUProtocolTransport(fake.transport, {
    baseUrl: "https://parser.example.test/mineru",
    timeoutMs: 5000,
    pollIntervalMs: 1,
  });
  await expect(client.request("unused", input)).resolves.toMatchObject({
    status: 200,
  });
  expect(fake.calls).toHaveLength(128);
  expect(fake.calls[0]).toEqual({
    url: "https://parser.example.test/mineru/health",
    method: "GET",
  });
  expect(fake.calls[1]).toEqual({
    url: "https://parser.example.test/mineru/tasks",
    method: "POST",
  });
  expect(fake.calls.at(-1)).toEqual({
    url: "https://parser.example.test/mineru/tasks/fixture-task/result",
    method: "GET",
  });
  expect(
    fake.calls.every((c) =>
      c.url.startsWith("https://parser.example.test/mineru/"),
    ),
  ).toBe(true);
});

it("applies the real deadline while queued and never submits a duplicate task", async () => {
  const fake = service(Infinity);
  const client = createMinerUProtocolTransport(fake.transport, {
    baseUrl: "http://127.0.0.1:19001",
    timeoutMs: 50,
    pollIntervalMs: 5,
  });
  await expect(client.request("unused", input)).rejects.toMatchObject({
    code: "parser-unavailable",
  });
  const count = fake.calls.length;
  await delay(20);
  expect(fake.calls).toHaveLength(count);
  expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(fake.calls.some((c) => c.url.endsWith("/result"))).toBe(false);
});

it("honors the default cooldown and interrupts the waiting interval on cancellation", async () => {
  const fake = service();
  const abort = new AbortController();
  const client = createMinerUProtocolTransport(fake.transport, {
    baseUrl: "http://127.0.0.1:19001",
  });
  const rejected = expect(
    client.request("unused", { ...input, signal: abort.signal }),
  ).rejects.toMatchObject({ code: "parser-cancelled" });
  await delay(50);
  expect(fake.calls).toHaveLength(2);
  abort.abort();
  await rejected;
  expect(fake.calls).toHaveLength(2);
});

it("aborts an in-flight network request on the overall deadline", async () => {
  const client = createMinerUProtocolTransport(
    {
      request: async (_url, options) => {
        await delay(10000, undefined, { signal: options.signal });
        return response(health);
      },
    },
    { baseUrl: "http://127.0.0.1:19001", timeoutMs: 30 },
  );
  await expect(client.request("unused", input)).rejects.toMatchObject({
    code: "parser-unavailable",
  });
});

it("waits past the former default deadline until the operator cancels", async () => {
  vi.useFakeTimers();
  const fake = service(Infinity);
  const stop = new AbortController();
  const client = createMinerUProtocolTransport(fake.transport, {
    baseUrl: "http://127.0.0.1:19001",
  });
  let settled = false;
  const pending = client.request("unused", { ...input, signal: stop.signal });
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(181000);
    expect(settled).toBe(false);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
    stop.abort();
    await expect(pending).rejects.toMatchObject({ code: "parser-cancelled" });
    await observed;
  } finally {
    stop.abort();
    await observed;
    vi.useRealTimers();
  }
});
