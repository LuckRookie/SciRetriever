import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
import { expect, it, vi } from "vitest";
import type { BrowserPageHandle } from "../src/browser/host.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  parseLiteratureId,
  parseWorkbenchView,
  sha256,
  type DatabaseCompletionReport,
} from "@sciretriever/contracts";

const firstArticle = "00000000-0000-0000-0000-000000000001";
const secondArticle = "00000000-0000-0000-0000-000000000003";
function interruptedReport(articleId: string): DatabaseCompletionReport {
  const id = parseLiteratureId(articleId);
  return {
    kind: "database-completion",
    goal: "ASSET_READY",
    end: { kind: "interrupted" },
    completed: [],
    failed: [],
    skipped: [],
    notStarted: [],
    interrupted: [
      {
        target: { kind: "literature", literature_id: id },
        literature_id: id,
      },
    ],
    no_usable_content_literature_ids: [],
  };
}
function completedReport(articleId: string): DatabaseCompletionReport {
  const id = parseLiteratureId(articleId);
  return {
    kind: "database-completion",
    goal: "ASSET_READY",
    end: { kind: "finished" },
    completed: [
      { target: { kind: "literature", literature_id: id }, literature_id: id },
    ],
    failed: [],
    skipped: [],
    notStarted: [],
    interrupted: [],
    no_usable_content_literature_ids: [],
  };
}

const page: BrowserPageHandle = {
  id: "page-1",
  close: async () => {},
  title: async () => "Article",
  url: () => "http://127.0.0.1/article",
  snapshot: async () => ({
    document_generation: 1,
    url: "http://127.0.0.1/article",
    title: "Article",
    viewport: { width: 800, height: 600, device_scale_factor: 1 },
    screenshot: new Uint8Array([1]),
    elements: [],
  }),
  apply: vi.fn(async () => {}),
};

it("passes the current delivery identity to the workbench model decision", async () => {
  let decidedTarget: unknown;
  const session = new ProductionWorkbenchSession(
    firstArticle,
    async (_observation, _frame, _signal, _guidance, target) => {
      decidedTarget = target;
      return { kind: "stop", reason: "user" };
    },
  );
  const signal = new AbortController().signal;
  const target = {
    literature_id: firstArticle,
    identifier: "doi:10.5555/workbench-target",
    version: "accepted-manuscript",
  };
  try {
    const opened = await session.open(
      {
        ...target,
        start_url: "https://fixture.example.test/article",
        metadata_snapshot: {
          revision: 1,
          sha256: await sha256(new Uint8Array()),
        },
        signal,
      },
      { ...page, apply: vi.fn(async () => {}) },
      Date.now() + 60_000,
    );
    expect(await opened.step(signal)).toBe("stopped");
    expect(decidedTarget).toEqual(target);
    opened.close(false);
  } finally {
    await session.close();
  }
});

it("binds production control to each explicit article operation and cancels before Browser admission", async () => {
  const session = new ProductionWorkbenchSession(firstArticle, async () => ({
    kind: "stop",
    reason: "user",
  }));
  const pending: Array<{
    articleId: string;
    signal: AbortSignal;
    finish(): void;
  }> = [];
  session.bindOperation(async (articleId, signal, feedback) => {
    const id = parseLiteratureId(articleId);
    feedback.scope([{ kind: "literature", literature_id: id }]);
    feedback.progress({
      target: { kind: "literature", literature_id: id },
      literature_id: id,
      state: "started",
      failure: null,
    });
    if (articleId === secondArticle)
      await session.open(
        { literature_id: articleId } as Parameters<typeof session.open>[0],
        page,
        Date.now() + 120_000,
      );
    await new Promise<void>((resolve) => {
      pending.push({ articleId, signal, finish: resolve });
    });
    return interruptedReport(articleId);
  });
  const http = await startWorkbenchHttp({
    access: workbenchTestAccess,
    session,
    acquisition: session,
    assets: new Map([["/", { contentType: "text/html", body: "ok" }]]),
  });
  try {
    const authCookie = await workbenchLogin(http.origin);
    const home = await fetch(http.origin, { headers: { Cookie: authCookie } });
    const cookie = `${authCookie}; ${home.headers.get("set-cookie")!.split(";")[0]!}`;
    const create = await fetch(`${http.origin}/api/clients`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: http.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const client = (await create.json()) as { client_id: string; csrf: string };
    const post = async (path: string, value: unknown) => {
      const response = await fetch(
        `${http.origin}${path}?client_id=${client.client_id}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: http.origin,
            "Content-Type": "application/json",
            "X-Workbench-Csrf": client.csrf,
          },
          body: JSON.stringify(value),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    expect(
      (await post("/api/acquisition/start", { article_id: firstArticle }))
        .status,
    ).toBe(202);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const first = session.view();
    expect(first.observation).toBeNull();
    expect(first.operation_feedback?.targets).toMatchObject({
      total: 1,
      running: 1,
      not_started: 0,
    });
    expect(first.operation_feedback?.current_target).toBe(firstArticle);
    expect(
      (await post("/api/control", { kind: "cancel", control_epoch: 0 })).status,
    ).toBe(400);
    expect(
      (
        await post("/api/control", {
          kind: "cancel",
          control_epoch: 0,
          session_id: first.session_id,
          article_id: first.article_id,
        })
      ).status,
    ).toBe(200);
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(session.view().state).toBe("cancelled");
    pending[0]!.finish();
    expect((await session.waitForCompletion()).state).toBe("cancelled");
    expect(session.view().operation_feedback?.report?.interrupted).toHaveLength(
      1,
    );
    expect(session.view().operation_feedback?.targets).toMatchObject({
      total: 1,
      interrupted: 1,
      running: 0,
    });

    expect(
      (await post("/api/acquisition/start", { article_id: secondArticle }))
        .status,
    ).toBe(202);
    await vi.waitFor(() => expect(session.view().observation).not.toBeNull());
    const second = session.view();
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.control.epoch).toBe(first.control.epoch);
    expect(
      (
        await post("/api/control", {
          kind: "takeover",
          control_epoch: first.control.epoch,
          session_id: first.session_id,
          article_id: first.article_id,
        })
      ).status,
    ).toBe(409);
    expect(session.view().control.controller_id).toBeNull();
    expect(
      (
        await post("/api/guidance", {
          guidance_id: "old-guidance",
          session_id: first.session_id,
          article_id: first.article_id,
          control_epoch: first.control.epoch,
          text: "Old article hint",
        })
      ).status,
    ).toBe(409);
    expect(session.view().guidance).toEqual([]);
    const takeover = await post("/api/control", {
      kind: "takeover",
      control_epoch: second.control.epoch,
      session_id: second.session_id,
      article_id: second.article_id,
    });
    expect(takeover.status).toBe(200);
    const current = session.view();
    expect(
      (
        await post("/api/action", {
          session_id: first.session_id,
          page_id: current.observation!.page_id,
          document_generation: current.observation!.document_generation,
          observation_revision: current.observation!.observation_revision,
          viewport_revision: current.observation!.viewport_revision,
          control_epoch: current.control.epoch,
          request_id: "old-article-action",
          input: {
            kind: "go-back",
            revision: current.observation!.observation_revision,
          },
        })
      ).status,
    ).toBe(409);
    expect(page.apply).not.toHaveBeenCalled();
    expect(
      (
        await post("/api/control", {
          kind: "cancel",
          control_epoch: current.control.epoch,
          session_id: first.session_id,
          article_id: first.article_id,
        })
      ).status,
    ).toBe(409);
    expect(pending[1]!.signal.aborted).toBe(false);
    expect(
      (
        await post("/api/control", {
          kind: "cancel",
          control_epoch: current.control.epoch,
          session_id: second.session_id,
          article_id: second.article_id,
        })
      ).status,
    ).toBe(200);
    expect(pending[1]!.signal.aborted).toBe(true);
    expect(session.view().state).toBe("cancelled");
    pending[1]!.finish();
    expect((await session.waitForCompletion()).state).toBe("cancelled");
  } finally {
    for (const operation of pending) operation.finish();
    await http.close();
    await session.close();
  }
});

it("retains a stable failed report while showing a separately committed Library PDF", async () => {
  const id = parseLiteratureId(firstArticle);
  const failure = {
    code: "browser-flow-close-failed",
    reason: "The Browser page failed to close.",
    action: "Inspect the committed PDF before retrying.",
    retryable: true,
  };
  const session = new ProductionWorkbenchSession(id, async () => ({
    kind: "stop",
    reason: "user",
  }));
  session.bindOperation(
    async (articleId, _signal, feedback) => {
      feedback.scope([{ kind: "literature", literature_id: id }]);
      feedback.progress({
        target: { kind: "literature", literature_id: id },
        literature_id: id,
        state: "started",
        failure: null,
      });
      await session.open(
        { literature_id: articleId } as Parameters<typeof session.open>[0],
        page,
        Date.now() + 120_000,
      );
      session.captured(articleId, {
        transfer_id: "captured-pdf",
        sha256: "a".repeat(64),
        size_bytes: 2048,
        page_count: 2,
        disposition: "accepted",
        publication: null,
      });
      feedback.progress({
        target: { kind: "literature", literature_id: id },
        literature_id: id,
        state: "failed",
        failure,
      });
      return {
        kind: "database-completion",
        goal: "ASSET_READY",
        end: { kind: "failed", failure },
        completed: [],
        failed: [
          {
            target: { kind: "literature", literature_id: id },
            literature_id: id,
            stage: "acquisition",
            failure,
          },
        ],
        skipped: [],
        notStarted: [],
        interrupted: [],
        no_usable_content_literature_ids: [],
      };
    },
    async () => ({ sha256: "a".repeat(64), size_bytes: 2048 }),
  );
  session.start(id);
  const view = parseWorkbenchView(await session.waitForCompletion());
  expect(view.state).toBe("failed");
  expect(view.operation_feedback?.report?.failed[0]?.failure.code).toBe(
    "browser-flow-close-failed",
  );
  expect(view.operation_feedback?.primary_pdf?.sha256).toBe("a".repeat(64));
  expect(view.candidates[0]?.publication).toBeNull();
  expect(view.operation_feedback?.targets).toMatchObject({
    total: 1,
    failed: 1,
    running: 0,
  });
  await session.close();
});

it("keeps unstarted targets and classifies an unexpected exception without exposing its text", async () => {
  const id = parseLiteratureId(firstArticle);
  const notStarted = new ProductionWorkbenchSession(id, async () => ({
    kind: "stop",
    reason: "user",
  }));
  notStarted.bindOperation(async (_articleId, _signal, feedback) => {
    feedback.scope([{ kind: "literature", literature_id: id }]);
    return {
      kind: "database-completion",
      goal: "ASSET_READY",
      end: { kind: "interrupted" },
      completed: [],
      failed: [],
      skipped: [],
      notStarted: [{ target: { kind: "literature", literature_id: id } }],
      interrupted: [],
      no_usable_content_literature_ids: [],
    };
  });
  notStarted.start(id);
  const stopped = parseWorkbenchView(await notStarted.waitForCompletion());
  expect(stopped.operation_feedback?.targets).toMatchObject({
    total: 1,
    not_started: 1,
    running: 0,
  });
  expect(stopped.state).toBe("cancelled");
  await notStarted.close();

  const thrown = new Error("Bearer secret-should-not-appear");
  const failed = new ProductionWorkbenchSession(id, async () => ({
    kind: "stop",
    reason: "user",
  }));
  failed.bindOperation(async () => {
    throw thrown;
  });
  failed.start(id);
  const view = parseWorkbenchView(await failed.waitForCompletion());
  expect(view.state).toBe("failed");
  expect(view.operation_feedback?.failure?.code).toBe(
    "completion-system-failed",
  );
  expect(JSON.stringify(view)).not.toContain("secret-should-not-appear");
  expect(failed.operationFailure()?.cause).toBe(thrown);
  await failed.close();
});

it.each(["cancel", "close"] as const)(
  "holds a completed report in settling until Library verification and preserves its PDF after %s",
  async (stop) => {
    const id = parseLiteratureId(firstArticle);
    const session = new ProductionWorkbenchSession(id, async () => ({
      kind: "stop",
      reason: "user",
    }));
    let beginRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      beginRead = resolve;
    });
    let finishRead!: (value: { sha256: string; size_bytes: number }) => void;
    const result = new Promise<{ sha256: string; size_bytes: number }>(
      (resolve) => {
        finishRead = resolve;
      },
    );
    session.bindOperation(
      async () => completedReport(id),
      async () => {
        beginRead();
        return result;
      },
    );
    const client = session.attach();
    try {
      session.start(id);
      await reading;
      const settling = parseWorkbenchView(session.view());
      expect(settling.operation_feedback?.phase).toBe("settling");
      expect(settling.operation_feedback?.report?.completed).toHaveLength(1);
      expect(settling.state).toBe("agent-running");
      const closing = stop === "close" ? session.close() : undefined;
      if (stop === "cancel") session.cancel(client, 0);
      if (stop === "cancel") expect(session.view().state).toBe("cancelled");
      finishRead({ sha256: "a".repeat(64), size_bytes: 2048 });
      await closing;
      const ended = parseWorkbenchView(await session.waitForCompletion());
      expect(ended.state).toBe("cancelled");
      expect(ended.operation_feedback?.phase).toBe("ended");
      expect(ended.operation_feedback?.primary_pdf_status).toBe("verified");
      expect(ended.operation_feedback?.primary_pdf?.sha256).toBe(
        "a".repeat(64),
      );
    } finally {
      finishRead({ sha256: "a".repeat(64), size_bytes: 2048 });
      await session.close();
    }
  },
);

it("preserves both operation and Library verification causes without publishing either detail", async () => {
  const id = parseLiteratureId(firstArticle);
  const operationError = new Error("Bearer private-operation-detail");
  const readerError = new Error("Bearer private-library-detail");
  const session = new ProductionWorkbenchSession(id, async () => ({
    kind: "stop",
    reason: "user",
  }));
  session.bindOperation(
    async () => {
      throw operationError;
    },
    async () => {
      throw readerError;
    },
  );
  try {
    session.start(id);
    const view = parseWorkbenchView(await session.waitForCompletion());
    expect(view.state).toBe("failed");
    expect(view.operation_feedback?.primary_pdf_status).toBe("unreadable");
    expect(JSON.stringify(view)).not.toContain("private-operation-detail");
    expect(JSON.stringify(view)).not.toContain("private-library-detail");
    const cause = session.operationFailure();
    expect(cause).toBeInstanceOf(AggregateError);
    const errors = (cause as AggregateError).errors as Error[];
    expect(errors[0]?.cause).toBe(operationError);
    expect(errors[1]?.cause).toBe(readerError);
  } finally {
    await session.close();
  }
});
