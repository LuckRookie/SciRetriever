import { expect, it } from "vitest";
import { archiveFixture } from "./archive-fixture.js";
import { createProcessorRegistry } from "../src/analysis/processor-registry.js";
import { processorRuntime } from "../src/application/jobs/processors.js";
void processorRuntime;
it("runs only corrected declared roles and reuses a single-paper result after description edits", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    let supplied: string[] = [];
    e.setModel((input) => {
      const segments = input.segments as { segment_id: string; text: string }[];
      supplied = segments.map((s) => s.text);
      return {
        answer: "synthetic",
        source_ids: [segments[0]!.segment_id],
        reason: null,
      };
    });
    const request = {
      schema_version: 1,
      idempotency_key: "labels-initial",
      name: "Role-limited reading",
      processor: { id: "labels", version: "2" },
      spec: {
        question: "What is reported?",
        answer_type: "string",
        reads: { parts: "main", roles: ["abstract"] },
      },
      inputs: [{ kind: "literature", literature_id: e.id }],
    };
    const job = await e.app.processors!.submit(request);
    await e.app.processingTasks!.run(job.job_id);
    const run = await e.app.processingTasks!.read(job.job_id);
    expect(run.failures).toEqual([]);
    expect(supplied.join(" ")).toContain("spectroscopy");
    expect(supplied.join(" ")).not.toContain("complete synthetic study");
    const receipt = (run.results[0] as { result: { result_id: string } })
      .result;
    const first = await e.app.processorRead!.byId(receipt.result_id);
    expect(first!.result.invocation.inputs[0]!.kind).toBe("archive-document");
    expect(first!.result.value_checks).toEqual([
      expect.objectContaining({
        record_id: "answer",
        pointer: "/answer",
        status: "text-layer",
      }),
    ]);
    expect(first!.result.coverage[0]!.parts?.[0]!.outcome).toBe("extracted");
    const meta = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: meta.metadata_revision,
      set: [{ field: "title", value: "Changed description only" }],
      unlock: [],
    });
    const calls = e.modelCalls,
      next = await e.app.processors!.submit({
        ...request,
        idempotency_key: "labels-repeat",
      });
    await e.app.processingTasks!.run(next.job_id);
    expect(e.modelCalls).toBe(calls);
    expect(
      (await e.app.processingTasks!.read(next.job_id)).results[0],
    ).toMatchObject({ result: { result_id: receipt.result_id, reused: true } });
    expect(
      createProcessorRegistry()
        .list()
        .map((p) => p.id),
    ).toEqual(["summary", "knowledge-synthesis", "labels", "records"]);
  } finally {
    await e.close();
  }
});
it("distinguishes absent supplementary material and not-ready members without calling a model", async () => {
  const e = await archiveFixture();
  try {
    const request = {
      schema_version: 1,
      idempotency_key: "not-ready",
      name: "Unavailable inputs",
      processor: { id: "records", version: "2" },
      spec: {
        record_meaning: "Observation",
        fields: [
          { name: "value", description: "Reported text", type: "string" },
        ],
        reads: { parts: "supplementary", roles: "all" },
      },
      inputs: [{ kind: "literature", literature_id: e.id }],
    };
    const job = await e.app.processors!.submit(request);
    await e.app.processingTasks!.run(job.job_id);
    const initial = await e.app.processingTasks!.read(job.job_id);
    expect(initial.failures).toEqual([]);
    expect(e.modelCalls).toBe(0);
    const first = await e.app.processorRead!.byId(
      (initial.results[0] as { result: { result_id: string } }).result
        .result_id,
    );
    expect(first!.result.coverage[0]!.parts).toEqual([
      expect.objectContaining({ outcome: "incomplete", gaps: ["not-ready"] }),
    ]);
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("archive-ready");
    const calls = e.modelCalls;
    const next = await e.app.processors!.submit({
      ...request,
      idempotency_key: "part-absent",
    });
    await e.app.processingTasks!.run(next.job_id);
    const completed = await e.app.processingTasks!.read(next.job_id);
    expect(completed.failures).toEqual([]);
    expect(e.modelCalls).toBe(calls);
    const absent = await e.app.processorRead!.byId(
      (completed.results[0] as { result: { result_id: string } }).result
        .result_id,
    );
    expect(absent!.result.coverage[0]!.parts).toEqual([
      expect.objectContaining({ outcome: "part-absent", asset_id: null }),
    ]);
  } finally {
    await e.close();
  }
});
it("keeps not-reported distinct from incomplete reading", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    e.setModel(() => ({
      answer: null,
      source_ids: [],
      reason: "The selected text does not report this quantity.",
    }));
    const run = async (key: string, reading: object) => {
      const job = await e.app.processors!.submit({
        schema_version: 1,
        idempotency_key: key,
        name: key,
        processor: { id: "labels", version: "2" },
        spec: { question: "What quantity?", answer_type: "string", reading },
        inputs: [{ kind: "literature", literature_id: e.id }],
      });
      await e.app.processingTasks!.run(job.job_id);
      const result = await e.app.processingTasks!.read(job.job_id);
      expect(result.failures).toEqual([]);
      return (await e.app.processorRead!.byId(
        (result.results[0] as { result: { result_id: string } }).result
          .result_id,
      ))!.result;
    };
    const empty = await run("not-reported", { scope: "full" });
    expect(empty.status).toBe("empty");
    expect(empty.coverage[0]!.parts?.[0]!.outcome).toBe("not-reported");
    const partial = await run("not-read", {
      scope: "search",
      query: "no-such-word",
    });
    expect(partial.coverage[0]!.parts?.[0]!.outcome).toBe("incomplete");
  } finally {
    await e.close();
  }
});
