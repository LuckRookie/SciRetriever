import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import {
  processorHttpAdapters,
  taskHttpAdapters,
} from "../src/bootstrap/workbench.js";
import {
  startWorkbenchHttp,
  startQueryOnlyHttp,
  type QueryOnlyHttpOptions,
} from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { queryProcessors } from "../src/entry/processor-operations.js";

async function workspace(submit?: QueryOnlyHttpOptions["submitProcessor"]) {
  const env = await coreProcessingFixture();
  await env.app.documentProcessing.parseDocuments(env.parseRequest);
  env.setModel((input) => ({
    answer: true,
    source_ids: [input.segments![0]!.segment_id],
    reason: null,
  }));
  const query = await createQueryApplication(env.home);
  const session = new ProductionWorkbenchSession(null, async () => {
    throw new Error("unexpected action");
  });
  const web = await startWorkbenchHttp({
    ...taskHttpAdapters(env.app),
    session,
    query: {
      application: query,
      maintenance: env.app.maintenance!,
      ...processorHttpAdapters(env.app),
      ...(submit ? { submitProcessor: submit } : {}),
    },
    assets: new Map([["/", { contentType: "text/html", body: "synthetic" }]]),
  });
  const home = await fetch(web.origin);
  const cookie = home.headers.get("set-cookie")!.split(";")[0]!;
  const attached = await fetch(`${web.origin}/api/clients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: web.origin,
      Cookie: cookie,
      "X-Workbench-Init": "1",
    },
    body: "{}",
  });
  const grant = (await attached.json()) as { client_id: string; csrf: string };
  const headers = {
    "Content-Type": "application/json",
    Origin: web.origin,
    Cookie: cookie,
    "X-Workbench-Csrf": grant.csrf,
    "X-Sciretriever-Protocol-Version": "1",
  };
  const post = (path: string, value: unknown, overrides: RequestInit = {}) =>
    fetch(`${web.origin}${path}?client_id=${grant.client_id}`, {
      method: "POST",
      headers,
      body: JSON.stringify(value),
      ...overrides,
    });
  const request = {
    schema_version: 1,
    idempotency_key: "web-labels",
    name: "Synthetic labels",
    processor: { id: "labels", version: "1" },
    spec: { question: "Is a finding reported?", answer_type: "boolean" },
    inputs: [
      { kind: "literature", literature_id: env.parseRequest.literature_id },
    ],
  };
  return {
    env,
    query,
    web,
    post,
    request,
    headers,
    close: async () => {
      await web.close();
      await session.close();
      await query.close();
      await env.close();
    },
  };
}

it("submits through the authenticated shared processor owner and reads results, evidence and exports without more model calls", async () => {
  const w = await workspace();
  try {
    const read = async (operation: string, request: unknown = {}) => {
      const response = await w.post("/api/v1/query/processors", {
        protocol_version: 1,
        operation,
        request,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: unknown };
      expect(body.result).toEqual(
        await queryProcessors(w.query, operation, request),
      );
      return body.result;
    };
    const registry = (await read("list")) as { id: string }[];
    expect(registry.map((p) => p.id)).toEqual(
      expect.arrayContaining(["labels", "records", "knowledge-synthesis"]),
    );
    expect(w.env.modelCalls).toBe(0);
    const submitted = await w.post("/api/v1/maintenance/processor-submit", {
      protocol_version: 1,
      request: w.request,
      start: true,
    });
    expect(submitted.status).toBe(202);
    const { task } = (await submitted.json()) as { task: { job_id: string } };
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(task.job_id)).job.status,
        { timeout: 10000 },
      )
      .toBe("completed");
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(task.job_id)).collections
            .length,
        { timeout: 10000 },
      )
      .toBe(1);
    const collection = (
      await w.env.app.processorRead!.collections(task.job_id)
    )[0]!;
    const saved = (await read("collection", {
      collection_id: collection.collection_id,
    })) as {
      members: { result: { result_id: string; content_sha256: string } }[];
    };
    const ref = saved.members[0]!.result;
    await read("read", { result_id: ref.result_id });
    await read("results");
    await read("collections");
    await read("evidence", {
      kind: "result",
      ...ref,
      record_id: "answer",
      pointer: "/answer",
    });
    await read("export", { result_id: ref.result_id, format: "json" });
    await read("export", { result_id: ref.result_id, format: "csv" });
    const calls = w.env.modelCalls;
    const duplicate = await w.post("/api/v1/maintenance/processor-submit", {
      protocol_version: 1,
      request: w.request,
      start: true,
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({
      task: { job_id: task.job_id },
    });
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    expect(w.env.modelCalls).toBe(calls);
    expect(w.env.parseCalls).toBe(1);
  } finally {
    await w.close();
  }
}, 30000);

it("propagates an HTTP reader disconnect into the fixed-result read", async () => {
  const w = await workspace();
  let entered = false,
    cancelled = false;
  const spy = vi.spyOn(w.query.processorRead!, "byId").mockImplementation(
    (_id, signal) =>
      new Promise((_resolve, reject) => {
        entered = true;
        const stop = () => {
          cancelled = true;
          reject(new Error("cancelled fixture read"));
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      }),
  );
  const stop = new AbortController();
  const response = w
    .post(
      "/api/v1/query/processors",
      {
        protocol_version: 1,
        operation: "transfer",
        request: {
          result_id: "00000000-0000-0000-0000-000000000001",
          content_sha256: "a".repeat(64),
          format: "result",
          max_bytes: 1024,
          continuation: null,
        },
      },
      { signal: stop.signal },
    )
    .catch((error: unknown) => error);
  try {
    await expect.poll(() => entered).toBe(true);
    stop.abort();
    await response;
    await expect.poll(() => cancelled).toBe(true);
    expect(w.env.modelCalls).toBe(0);
  } finally {
    stop.abort();
    spy.mockRestore();
    await w.close();
  }
}, 30000);

it("enforces authentication, exact requests and scoped sizes while retaining drafts larger than ordinary HTTP commands", async () => {
  const w = await workspace();
  try {
    const envelope = { protocol_version: 1, request: w.request, start: false };
    const submit = (value: unknown, overrides?: RequestInit) =>
      w.post("/api/v1/maintenance/processor-submit", value, overrides);
    expect(
      (
        await submit(envelope, {
          headers: { ...w.headers, "X-Workbench-Csrf": "invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await submit(envelope, {
          headers: { ...w.headers, Origin: "https://invalid.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await submit(envelope, { headers: { ...w.headers, Cookie: "" } }))
        .status,
    ).toBe(401);
    expect((await submit({ ...envelope, ignored: true })).status).toBe(400);
    expect(
      (await submit({ ...envelope, request: { ...w.request, ignored: true } }))
        .status,
    ).toBe(400);
    expect(
      (
        await submit(envelope, {
          body: JSON.stringify(envelope).replace(
            '"start":false',
            '"start":false,"start":true',
          ),
        })
      ).status,
    ).toBe(400);
    const invalid = await submit({
      ...envelope,
      request: { ...w.request, processor: { id: "unknown", version: "1" } },
    });
    expect(await invalid.json()).toMatchObject({ code: "processor-unknown" });
    expect(
      (
        await w.post("/api/v1/query/processors", {
          protocol_version: 1,
          operation: "list",
          request: { unexpected: true },
        })
      ).status,
    ).toBe(400);
    const unknownField = await w.post("/api/v1/query/processors", {
      protocol_version: 1,
      operation: "results",
      request: { unknown: 1 },
    });
    expect(await unknownField.json()).toMatchObject({
      code: "processor-query-invalid",
    });
    const large = {
      ...envelope,
      request: {
        ...w.request,
        idempotency_key: "large-records",
        processor: { id: "records", version: "1" },
        spec: {
          record_meaning: "Synthetic observations",
          fields: Array.from({ length: 34 }, (_, i) => ({
            name: `field${i}`,
            type: "string",
            description: "x".repeat(2000),
          })),
        },
      },
    };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(65536);
    expect((await submit(large)).status).toBe(202);
    const tooLarge = submit(envelope, {
      body: JSON.stringify({ ...envelope, padding: "x".repeat(1024 * 1024) }),
    });
    // The existing bounded body reader may terminate the oversized transport before returning JSON.
    await expect(
      tooLarge.then(
        (response) => response.status,
        () => 400,
      ),
    ).resolves.toBe(400);
    expect(w.env.modelCalls).toBe(0);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
  } finally {
    await w.close();
  }
}, 30000);

it("cancels input preparation on disconnect without acknowledging a task that was not saved", async () => {
  let observed: AbortSignal | undefined;
  let stopped = false;
  const w = await workspace(async (_request, _start, signal) => {
    observed = signal;
    await new Promise<void>((resolve) =>
      signal!.addEventListener(
        "abort",
        () => {
          stopped = true;
          resolve();
        },
        { once: true },
      ),
    );
    signal!.throwIfAborted();
    throw new Error("unexpected completion");
  });
  try {
    const controller = new AbortController();
    const pending = w
      .post(
        "/api/v1/maintenance/processor-submit",
        { protocol_version: 1, request: w.request, start: false },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    await expect.poll(() => !!observed).toBe(true);
    controller.abort();
    await pending;
    await expect.poll(() => stopped).toBe(true);
    expect(await w.env.app.jobs!.listJobs(10)).toEqual([]);
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 30000);

it("serves the offline registry on an old catalog, reports unsupported results and exposes no write operation", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-old-processor-web-"));
  const app = await createApplication(home);
  await app.close();
  const query = await createQueryApplication(home);
  const web = await startQueryOnlyHttp({ application: query });
  try {
    expect(query.readiness.schema_version).toBeLessThan(10);
    const post = (path: string, value: unknown) =>
      fetch(web.origin + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
    const list = await post("/api/v1/query/processors", {
      protocol_version: 1,
      operation: "list",
      request: {},
    });
    expect(list.status).toBe(200);
    const results = await post("/api/v1/query/processors", {
      protocol_version: 1,
      operation: "results",
      request: {},
    });
    expect(results.status).toBe(422);
    expect(await results.json()).toMatchObject({
      code: "catalog-v10-required",
    });
    expect(
      (await post("/api/v1/maintenance/processor-submit", {})).status,
    ).toBe(404);
  } finally {
    await web.close();
    await query.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
