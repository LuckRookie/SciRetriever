import { expect, it } from "vitest";
import { processorFixture } from "./processor-fixture.js";
import {
  AgentTraceService,
  traceSummary,
} from "../src/application/agent-traces.js";

it(
  "keeps bounded, image-free tool history and expires ended sessions without deleting results",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    try {
      await e.build(e.parseRequest);
      await e.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "traces-summary",
        name: "Trace summary",
        processor: { id: "summary", version: "2" },
        spec: {},
        inputs: [
          { kind: "literature", literature_id: e.parseRequest.literature_id },
        ],
      });
      const results = await e.app.processorRead!.list(),
        id = String(results.items[0]!.result_id);
      const sessions = await e.app.database.review<{
        items: {
          session_id: string;
          status: string;
          calls: number;
          input_tokens: number;
        }[];
      }>("session-list", {});
      expect(sessions.items.length).toBeGreaterThan(0);
      const summary = sessions.items.find((s) => s.input_tokens === 100)!;
      expect(summary).toMatchObject({ status: "completed", calls: 2 });
      const history = await e.app.database.review<{
        events: { kind: string; value: Record<string, unknown> }[];
      }>("session-read", { session_id: summary.session_id });
      expect(
        history.events.some(
          (e) => e.kind === "tool-start" && e.value.name === "submit_result",
        ),
      ).toBe(true);
      const traces = new AgentTraceService(e.app.database);
      const sink = await traces.start({
        session_id: "bounded-session",
        role: "proofreading",
        provider: "fixture",
        model: "fake",
        context: {
          actor: "web-session:fixture",
          job_id: "trace-ttl-job",
          literature_id: e.parseRequest.literature_id,
        },
        subject: { asset_id: e.parseRequest.asset_id, page: 0 },
      });
      sink.event("tool-result", {
        parts: [{ media_type: "image/png", data: new Uint8Array([1, 2, 3]) }],
        password: "should-never-persist",
        auth: "secret-auth",
        token: "secret-token",
        nested: {
          text: '[{"token":"secret-json-token","reasoning_content":"hidden-reasoning"}]',
        },
        text: "Bearer forbidden-token",
        url: "https://example.org/pdf?api_key=secret",
      });
      for (let n = 0; n < 600; n++)
        sink.event("tool-result", { text: "x".repeat(4000) });
      sink.usage(4, 1000, 200);
      await sink.finish("completed");
      const bounded = await e.app.database.review<{
        session: { truncated: number; event_bytes: number; calls: number };
        events: unknown[];
      }>("session-read", { session_id: "bounded-session" });
      expect(bounded.session).toMatchObject({ truncated: 1, calls: 4 });
      expect(bounded.session.event_bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(JSON.stringify(bounded)).not.toMatch(
        /should-never-persist|forbidden-token|api_key=secret|1,2,3|secret-auth|secret-token|secret-json-token|hidden-reasoning/,
      );
      expect(
        JSON.stringify(
          traceSummary({
            parts: [
              { media_type: "image/png", data: new Uint8Array([1, 2, 3]) },
            ],
          }),
        ),
      ).not.toContain("1,2,3");
      const active = await traces.start({
        session_id: "active-session",
        role: "analysis",
        provider: "fixture",
        model: "fake",
        context: { actor: "cli:fixture" },
        subject: {},
      });
      const date = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
      await traces.cleanup(date);
      await traces.cleanup(date);
      expect(
        await e.app.database.review("session-read", {
          session_id: "bounded-session",
        }),
      ).toBeNull();
      expect(
        await e.app.database.review("session-read", {
          session_id: "active-session",
        }),
      ).not.toBeNull();
      expect(await e.app.processorRead!.byId(id)).not.toBeNull();
      const { DatabaseSync } = await import("node:sqlite");
      const { join } = await import("node:path");
      const db = new DatabaseSync(join(e.home, "catalog.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          db
            .prepare(
              "SELECT calls,input_tokens,output_tokens FROM task_model_usage WHERE job_id=?",
            )
            .get("trace-ttl-job"),
        ).toEqual({ calls: 4, input_tokens: 1000, output_tokens: 200 });
      } finally {
        db.close();
      }
      await active.finish("cancelled");
      await traces.close();
    } finally {
      await e.close();
    }
  },
);
