import { expect, it, vi } from "vitest";
import { archiveFixture } from "./archive-fixture.js";
import type {
  DraftOutcome,
  ParseDocumentReceipt,
} from "@sciretriever/contracts";
import { ParsingFailure } from "../src/parsing/ports.js";

interface ParseProgress {
  readonly run_id: string;
  readonly step: string;
  readonly phase: string;
  readonly status: string;
  readonly reason: string | null;
  readonly receipt?: ParseDocumentReceipt;
}
async function assertStepReceipt(
  e: Awaited<ReturnType<typeof archiveFixture>>,
  jobId: string,
  receipt: ParseDocumentReceipt,
) {
  const detail = (await e.app.database.review("task-run", {
    job_id: jobId,
  })) as {
    items: { steps: ParseProgress[]; archive: { steps: ParseProgress[] } }[];
  };
  expect(
    detail.items[0]!.steps.find((s) => s.step === "parse")!.receipt,
  ).toEqual(receipt);
  expect(
    detail.items[0]!.archive.steps.find((s) => s.step === "parse")!.receipt,
  ).toEqual(receipt);
}

it("parses first when needed, builds a durable archive, reuses the parse and model steps and records versions", async () => {
  const e = await archiveFixture();
  try {
    const { id, submit } = e;
    const drafts = vi.spyOn(e.app.draftDocuments, "publish");
    const parsing = vi.spyOn(e.app.documentProcessing, "parseDocuments");
    expect((await e.app.archive.status(id)).missing_step).toBe("raw-parse");
    // Archiving starts with parsing (Owner 2026-10-30).
    const first = await submit("archive-first");
    expect(e.parseCalls).toBe(1);
    expect(drafts).toHaveBeenCalledOnce();
    const draft: DraftOutcome = await drafts.mock.results[0]!.value;
    expect(draft).toMatchObject({
      status: "formed",
      default_changed: true,
      default_text_level: "draft",
    });
    const receipt: ParseDocumentReceipt = await parsing.mock.results[0]!.value;
    const progress = (first.archive.steps as ParseProgress[]).find(
      (s) => s.step === "parse",
    )!;
    expect(progress).toMatchObject({
      phase: "completed",
      status: "done",
      reason: null,
      receipt,
    });
    await assertStepReceipt(e, first.job.job_id, receipt);
    // A mismatched receipt cannot update either the step or its event.
    for (const invalid of [
      { ...receipt, literature_id: "00000000-0000-0000-0000-000000000999" },
      { ...receipt, asset_id: "00000000-0000-0000-0000-000000000999" },
      { ...receipt, asset_sha256: "f".repeat(64) },
    ]) {
      await expect(
        e.app.database.archive("parse", {
          run_id: progress.run_id,
          literature_id: id,
          asset_id: e.asset.asset_id,
          status: "done",
          reason: null,
          elapsed_ms: 9999,
          receipt: invalid,
        }),
      ).rejects.toMatchObject({ code: "archive-parse-receipt-invalid" });
      expect(
        (await e.app.processingTasks!.read(first.job.job_id)).archive.steps,
      ).toEqual(first.archive.steps);
    }
    expect(
      first.failures,
      JSON.stringify(await e.app.archive.status(id)),
    ).toEqual([]);
    const state = await e.app.archive.status(id);
    expect(state.status).toBe("READY");
    // arrange, proofread, render, translate, metadata, references, tags
    expect(
      state.parts[0]!.steps.filter((s) => s.status === "done"),
    ).toHaveLength(7);
    expect(state.parts[0]!.content_version).toMatch(/^[a-f0-9]{64}$/);
    expect(state.description_version).toMatch(/^[a-f0-9]{64}$/);
    const calls = e.modelCalls,
      parseCalls = e.parseCalls;
    const repeat = await submit("archive-repeat");
    expect(
      (repeat.archive.steps as ParseProgress[]).filter(
        (s) => s.step === "parse",
      ),
    ).toEqual([]);
    expect(e.modelCalls).toBe(calls);
    expect(e.parseCalls).toBe(parseCalls);
    const events = (await e.app.archive.query({
      operation: "events",
      request: { after: 0, limit: 100 },
    })) as { kind: string }[];
    expect(events.some((x) => x.kind === "content-version-changed")).toBe(true);
    expect(events.some((x) => x.kind === "description-version-changed")).toBe(
      true,
    );
    expect((await e.app.library.detail(id)).literature.status).toBe("READY");
    await e.reopen();
    expect(
      (await e.app.processingTasks!.read(first.job.job_id)).archive.steps,
    ).toEqual(first.archive.steps);
    await assertStepReceipt(e, first.job.job_id, receipt);
  } finally {
    await e.close();
  }
}, 0);

it("continues archiving when the separately committed parse draft fails", async () => {
  let inspections = 0;
  const e = await archiveFixture({
    offline: true,
    textLayer: (text) => {
      if (++inspections === 1)
        throw new Error("Synthetic page tools temporarily unavailable");
      return text;
    },
  });
  const drafts = vi.spyOn(e.app.draftDocuments, "publish");
  try {
    const result = await e.submit("archive-after-draft-failure");
    expect(result.failures).toEqual([]);
    expect(await drafts.mock.results[0]!.value).toMatchObject({
      status: "failed",
      failure_code: "page-tools-unavailable",
    });
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    expect(e.parseCalls).toBe(1);
    expect(await e.app.database.draftCurrent(e.asset.asset_id)).toBeNull();
    const receipt = (result.archive.steps as ParseProgress[]).find(
      (s) => s.step === "parse",
    )!.receipt!;
    expect(receipt.draft).toMatchObject({
      status: "failed",
      failure_code: "page-tools-unavailable",
    });
    await e.reopen();
    await assertStepReceipt(e, result.job.job_id, receipt);
  } finally {
    drafts.mockRestore();
    await e.close();
  }
}, 30_000);

it("persists the parse failure receipt with its own step reason before stopping archiving", async () => {
  const e = await archiveFixture({ offline: true });
  try {
    e.setParseHook(async () => {
      throw new ParsingFailure("parser-unavailable");
    });
    const result = await e.submit("archive-raw-failure-receipt");
    const step = (result.archive.steps as ParseProgress[]).find(
      (s) => s.step === "parse",
    )!;
    expect(step).toMatchObject({
      phase: "stopped",
      status: "failed",
      reason: "parser-unavailable",
      receipt: {
        profiles: [{ status: "failed", failure_code: "parser-unavailable" }],
        draft: { status: "not-formed", reason: "raw-parse-failed" },
      },
    });
    expect(e.modelCalls).toBe(0);
    await e.reopen();
    await assertStepReceipt(e, result.job.job_id, step.receipt!);
  } finally {
    await e.close();
  }
}, 30_000);

it("accepts old parse progress without a receipt and never inherits an earlier attempt's receipt", async () => {
  const e = await archiveFixture({ offline: true });
  try {
    const result = await e.submit("archive-legacy-parse-progress");
    const step = (result.archive.steps as ParseProgress[]).find(
      (s) => s.step === "parse",
    )!;
    expect(step.receipt).toBeDefined();
    for (const status of ["running", "done"]) {
      await e.app.database.archive("parse", {
        run_id: step.run_id,
        literature_id: e.id,
        asset_id: e.asset.asset_id,
        status,
        reason: null,
        elapsed_ms: 0,
      });
      const history = await e.app.processingTasks!.read(result.job.job_id);
      expect(
        (history.archive.steps as ParseProgress[]).find(
          (s) => s.step === "parse",
        ),
      ).not.toHaveProperty("receipt");
      const detail = (await e.app.database.review("task-run", {
        job_id: result.job.job_id,
      })) as {
        items: {
          steps: ParseProgress[];
          archive: { steps: ParseProgress[] };
        }[];
      };
      expect(
        detail.items[0]!.steps.find((s) => s.step === "parse"),
      ).not.toHaveProperty("receipt");
      expect(
        detail.items[0]!.archive.steps.find((s) => s.step === "parse"),
      ).not.toHaveProperty("receipt");
    }
  } finally {
    await e.close();
  }
}, 30_000);

// Reached 2.2 s under Full (36/12) load, too close to the 5 s default.
it("records parser pages, per-step usage and batch consolidation independently", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("statistics");
    const stats = (await e.app.archive.query({
      operation: "stats",
      request: {},
    })) as {
      parsing: { profile: string; pages: number; elapsed_ms: number }[];
      steps: { step: string; calls: number; input_tokens: number }[];
      hooks: { state: string; count: number }[];
    };
    expect(stats.parsing).toHaveLength(2);
    expect(stats.parsing.every((s) => s.pages === 1 && s.elapsed_ms >= 0)).toBe(
      true,
    );
    expect(stats.steps.find((s) => s.step === "metadata")).toMatchObject({
      calls: 1,
      input_tokens: 100,
    });
    expect(stats.steps.find((s) => s.step === "tags")).toMatchObject({
      calls: 2,
      input_tokens: 200,
    });
    expect(stats.hooks).toContainEqual({ state: "done", count: 1 });
  } finally {
    await e.close();
  }
}, 30_000);

// Reached 2.1 s under Full (36/12) load, too close to the 5 s default.
it("does not roll back a ready archive when the once-per-batch consolidation hook fails", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const hook = vi
      .spyOn(e.app.tags, "consolidate")
      .mockRejectedValue(new Error("synthetic consolidation failure"));
    await e.submit("hook-failure");
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    expect(hook).toHaveBeenCalledTimes(1);
    await e.submit("hook-failure");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(
      await e.app.archive.query({ operation: "stats", request: {} }),
    ).toMatchObject({ hooks: [{ state: "failed", count: 1 }] });
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
}, 30_000);

// Reached 2.4 s under Full (36/12) load, too close to the 5 s default.
it("archives a single deployment-profile parse without references and reports the nonblocking gap", async () => {
  const e = await archiveFixture();
  try {
    e.setText(
      "# Abstract\n\nFixture Author studies synthetic spectroscopy.\n\n# Introduction\n\nA complete synthetic study.\n\n# Conclusion\n\nSpectroscopy is the main theme.\n",
    );
    await e.app.documentProcessing.parseDocuments({
      ...e.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    await e.submit("single-profile-without-references");
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    expect(state.parts[0]!.raw_profiles).toEqual(["vlm-engine"]);
    expect(state.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "references",
          reason: "references-missing",
          affects_readiness: false,
        }),
      ]),
    );
    expect(state.parts[0]!.steps.find((s) => s.step === "tags")?.status).toBe(
      "done",
    );
    expect(e.parseCalls).toBe(1);
  } finally {
    await e.close();
  }
}, 30_000);
