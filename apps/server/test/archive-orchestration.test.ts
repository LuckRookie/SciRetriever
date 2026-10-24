import { expect, it, vi } from "vitest";
import { archiveFixture } from "./archive-fixture.js";

it("requires explicit parsing, builds a durable archive, reuses model steps and records versions", async () => {
  const e = await archiveFixture();
  try {
    const { id, submit } = e;
    expect((await e.app.archive.status(id)).missing_step).toBe("raw-parse");
    const blocked = await submit("archive-unparsed");
    expect(blocked.results[0]).toMatchObject({
      result: { outcome: "needs-parse" },
    });
    expect(e.parseCalls).toBe(0);
    expect(e.modelCalls).toBe(0);
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    expect((await e.app.archive.status(id)).missing_step).toBe("proofread");
    const first = await submit("archive-first");
    expect(
      first.failures,
      JSON.stringify(await e.app.archive.status(id)),
    ).toEqual([]);
    const state = await e.app.archive.status(id);
    expect(state.status).toBe("READY");
    expect(
      state.parts[0]!.steps.filter((s) => s.status === "done"),
    ).toHaveLength(6);
    expect(state.parts[0]!.content_version).toMatch(/^[a-f0-9]{64}$/);
    expect(state.description_version).toMatch(/^[a-f0-9]{64}$/);
    const calls = e.modelCalls,
      parseCalls = e.parseCalls;
    await submit("archive-repeat");
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
  } finally {
    await e.close();
  }
}, 0);

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
