import { describe, expect, it, vi } from "vitest";
import { WorkbenchSession } from "../src/workbench/session.js";
import type { BrowserPageHandle } from "../src/browser/host.js";
import {
  parseCandidatePublicationReceipt,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import { BrowserControlCoordinator } from "../src/browser/control.js";
const budget = {
  max_actions: 10,
  max_model_calls: 5,
  max_retries: 2,
  max_bytes: 10000,
  deadline_ms: 60000,
};
function setup(
  decide?: () => Promise<unknown>,
  publish?: ConstructorParameters<typeof WorkbenchSession>[6],
) {
  const apply = vi.fn<BrowserPageHandle["apply"]>(async () => {});
  let generation = 7;
  const page: BrowserPageHandle = {
    id: "page-1",
    close: vi.fn(async () => {}),
    title: async () => "Fixture",
    url: () => "http://127.0.0.1/article",
    snapshot: async () => ({
      document_generation: generation,
      url: "http://127.0.0.1/article?private=value",
      title: "Fixture",
      viewport: { width: 800, height: 600, device_scale_factor: 1 },
      screenshot: new Uint8Array([1, 2]),
      text: "Synthetic",
      elements: [],
    }),
    apply,
  };
  const session = new WorkbenchSession(
    "article-1",
    page,
    budget,
    decide,
    "session-1",
    () => page.close(),
    publish,
  );
  const a = session.attach(),
    b = session.attach();
  return {
    session,
    apply,
    a,
    b,
    navigate: () => {
      generation++;
    },
  };
}

it("binds publication to the controller and Candidate hash, and aborts validation after takeover", async () => {
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const publication = parseCandidatePublicationReceipt({
    receipt_id: "receipt-1",
    literature_id: "article-1",
    asset_id: "00000000-0000-0000-0000-000000000001",
    sha256: "a".repeat(64),
    reference: "objects/paper.pdf",
    created: true,
  });
  const publish = vi.fn(async (_candidate, abort: AbortSignal) => {
    signal = abort;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (abort.aborted) throw new Error("cancelled");
    return publication;
  });
  const { session, a, b } = setup(undefined, publish);
  session.candidateReady({
    transfer_id: "transfer-1",
    sha256: "a".repeat(64),
    size_bytes: 10,
    page_count: 1,
    disposition: "accepted",
    publication: null,
  });
  session.takeover(a, session.view().control.epoch);
  const command = {
    session_id: session.id,
    control_epoch: session.view().control.epoch,
    transfer_id: "transfer-1",
    sha256: "a".repeat(64),
  };
  await expect(session.acceptCandidate(b, command)).rejects.toThrow();
  await expect(
    session.acceptCandidate(a, { ...command, sha256: "b".repeat(64) }),
  ).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
  const pending = session.acceptCandidate(a, command);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  session.takeover(b, session.view().control.epoch);
  expect(signal?.aborted).toBe(true);
  finish!();
  await rejected;
  expect(session.view().candidates[0]?.publication).toBeNull();
  await session.close();
});

it("lets a human reacquire review control after cancelling page operations and preserves an already committed publication", async () => {
  const publication = parseCandidatePublicationReceipt({
    receipt_id: "receipt-1",
    literature_id: "article-1",
    asset_id: "00000000-0000-0000-0000-000000000001",
    sha256: "a".repeat(64),
    reference: "objects/paper.pdf",
    created: true,
  });
  const { session, a } = setup(undefined, async () => publication);
  session.candidateReady({
    transfer_id: "transfer-1",
    sha256: "a".repeat(64),
    size_bytes: 10,
    page_count: 1,
    disposition: "accepted",
    publication: null,
  });
  session.takeover(a, session.view().control.epoch);
  session.cancel(a, session.view().control.epoch);
  session.takeover(a, session.view().control.epoch);
  await session.acceptCandidate(a, {
    session_id: session.id,
    control_epoch: session.view().control.epoch,
    transfer_id: "transfer-1",
    sha256: "a".repeat(64),
  });
  expect(session.view().candidates[0]?.publication).toEqual(publication);
  expect(session.view().state).toBe("cancelled");
  await session.close();
});
function command(o: WorkbenchObservation, request_id = "request-1") {
  return {
    session_id: o.session_id,
    page_id: o.page_id,
    document_generation: o.document_generation,
    observation_revision: o.observation_revision,
    viewport_revision: o.viewport_revision,
    control_epoch: o.control_epoch,
    request_id,
    input: { kind: "go-back", revision: o.observation_revision },
  };
}
describe("workbench session", () => {
  it("projects Candidate capture progress through the current observation", async () => {
    const { session } = setup();
    session.transferStarted();
    await session.refresh();
    expect(session.view().observation?.capture_state).toBe("CANDIDATE");
    session.candidateReady({
      transfer_id: "capture-progress",
      sha256: "c".repeat(64),
      size_bytes: 12,
      page_count: 1,
      disposition: "uncertain",
      publication: null,
    });
    await session.refresh();
    expect(session.view().observation?.capture_state).toBe("CAPTURED");
    await session.close();
  });
  it("switches the Browser target only under the current operator lease", async () => {
    const navigate = vi.fn(async () => {});
    const page: BrowserPageHandle = {
      id: "target-page",
      close: async () => {},
      title: async () => "Fixture",
      url: () => "http://127.0.0.1/article",
      navigate,
      snapshot: async () => ({
        document_generation: 1,
        url: "http://127.0.0.1/article",
        title: "Fixture",
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot: null,
      }),
      apply: async () => {},
    };
    const switched = vi.fn(async () => {});
    const session = new WorkbenchSession(
      "article-1",
      page,
      budget,
      undefined,
      "target-session",
      async () => {},
      undefined,
      switched,
    );
    const client = session.attach();
    session.takeover(client, session.view().control.epoch);
    await session.selectTarget(
      client,
      session.view().control.epoch,
      "article-2",
    );
    expect(switched).toHaveBeenCalledWith("article-2");
    expect(navigate).not.toHaveBeenCalled();
    expect(session.view().article_id).toBe("article-2");
    await session.close();
  });
  it("maps native document generations, isolates viewers and rejects old controllers and replay collisions", async () => {
    const { session, a, b, apply, navigate } = setup();
    await session.refresh();
    session.takeover(a, session.view().control.epoch);
    const observation = session.view().observation!;
    expect(observation.document_generation).toBe(7);
    expect(observation.observation_revision).toBe(1);
    expect(observation.url).toBe("http://127.0.0.1/article");
    expect(session.view().control.viewers).toBe(2);
    await expect(session.command(b, command(observation))).rejects.toThrow();
    await expect(session.command(a, command(observation))).resolves.toBe(
      "applied",
    );
    await expect(session.command(a, command(observation))).resolves.toBe(
      "duplicate",
    );
    await expect(
      session.command(a, {
        ...command(observation),
        input: {
          kind: "press-key",
          key: "Tab",
          revision: observation.observation_revision,
        },
      }),
    ).rejects.toThrow();
    expect(apply).toHaveBeenCalledTimes(1);
    session.takeover(b, session.view().control.epoch);
    await expect(
      session.command(a, { ...command(observation), request_id: "old" }),
    ).rejects.toThrow();
    navigate();
    await session.refresh();
    expect(session.view().observation!.document_generation).toBe(8);
    await expect(
      session.command(b, {
        ...command(observation),
        control_epoch: session.view().control.epoch,
        request_id: "stale",
      }),
    ).rejects.toThrow();
    session.detach(b);
    expect(session.view().control.controller_id).toBeNull();
    expect(session.view().control.viewers).toBe(1);
    await session.close();
  });
  it("revokes in-flight input at takeover, preserves budget across pause, and keeps the last frame after cancel", async () => {
    const { session, a, b, apply } = setup();
    await session.refresh();
    session.takeover(a, session.view().control.epoch);
    let check: (() => boolean) | undefined, release!: () => void;
    apply.mockImplementation(async (_input, _generation, current) => {
      check = current;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const pending = session.command(a, command(session.view().observation!));
    await vi.waitFor(() => expect(check).toBeDefined());
    expect(check!()).toBe(true);
    session.takeover(b, session.view().control.epoch);
    expect(check!()).toBe(false);
    release();
    await pending;
    session.pause(b, session.view().control.epoch);
    const paused = session.view();
    expect(paused.state).toBe("paused");
    await expect(
      session.command(b, command(paused.observation!, "paused")),
    ).rejects.toThrow();
    session.resume(b, session.view().control.epoch);
    expect(session.view().observation!.remaining.actions).toBe(9);
    session.cancel(b, session.view().control.epoch);
    expect(session.view().state).toBe("cancelled");
    expect(session.frame(paused.observation!.frame_seq)).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(session.frame(999)).toBeNull();
    await expect(
      session.command(b, command(session.view().observation!, "after-cancel")),
    ).rejects.toThrow();
    await session.close();
  });
  it("drops a late Agent result after human takeover and rejects Agent-only identity escalation", async () => {
    let finish!: (value: unknown) => void;
    const { session, a, b, apply } = setup(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    await session.refresh();
    session.takeover(a, session.view().control.epoch);
    const pending = session.runAgent(a, session.view().control.epoch);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(session.view().state).toBe("agent-running");
    session.takeover(b, session.view().control.epoch);
    finish({ kind: "go-back", revision: 1 });
    await pending;
    expect(apply).not.toHaveBeenCalled();
    expect(session.view().control.controller_id).toBe(b);
    expect(session.view().observation!.remaining.model_calls).toBe(4);
    const control = new BrowserControlCoordinator("session-2");
    control.attach({
      workspace_id: "session-2",
      client_id: "agent",
      role: "agent",
    });
    expect(() =>
      control.attach({
        workspace_id: "session-2",
        client_id: "agent",
        role: "human",
      }),
    ).toThrow();
    const lease = control.takeover("agent");
    await expect(
      control.dispatchOperator(
        "agent",
        lease.epoch,
        { kind: "stop", reason: "user" },
        {} as never,
        async () => {},
      ),
    ).rejects.toThrow();
    await session.close();
  });
  it("executes one closed Agent action and makes model absence actionable", async () => {
    const { session, a, apply } = setup(async () => ({
      kind: "go-back",
      revision: 1,
    }));
    await session.refresh();
    session.takeover(a, session.view().control.epoch);
    await session.runAgent(a, session.view().control.epoch);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(session.view().control.controller_id).toBeNull();
    expect(session.view().state).toBe("watching");
    const missing = setup();
    await missing.session.refresh();
    missing.session.takeover(missing.a, 0);
    expect(() =>
      missing.session.runAgent(missing.a, missing.session.view().control.epoch),
    ).toThrow("workbench session operation failed");
    expect(missing.session.view().error).toBe("model-unavailable");
    await session.close();
    await missing.session.close();
  });
});
