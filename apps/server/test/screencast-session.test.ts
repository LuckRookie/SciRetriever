import {
  BrowserArticleClock,
  type BrowserArticleExecution,
} from "../src/browser/article-session.js";
import { describe, expect, it, vi } from "vitest";
import {
  sha256,
  decodeScreencastFrame,
  type ScreencastFrame,
} from "@sciretriever/contracts";
import { ScreencastFramePump } from "../src/workbench/screencast-relay.js";
import { createSyntheticScreencastSession } from "../src/workbench/synthetic-screencast.js";
import type { WorkbenchScreencastState } from "../src/workbench/screencast-port.js";
import { WorkbenchSession } from "../src/workbench/session.js";
import { SyntheticScreencastSource } from "../src/workbench/synthetic-screencast.js";
import type { BrowserPageHandle } from "../src/browser/host.js";
const down = {
  kind: "mouse" as const,
  action: "down" as const,
  x: 40,
  y: 40,
  button: "left" as const,
  buttons: 1,
  click_count: 1,
  modifiers: 0,
};
async function attach() {
  const fixture = createSyntheticScreencastSession({ automatic: false }),
    client = fixture.session.attach();
  const frames: ScreencastFrame[] = [],
    states: WorkbenchScreencastState[] = [];
  const pump = new ScreencastFramePump(
    "subscription-1",
    fixture.session.id,
    fixture.session.articleId,
    1,
    (bytes) => frames.push(decodeScreencastFrame(bytes).frame),
  );
  const stop = await fixture.session.subscribeScreencast(client, {
    frame: (frame) => pump.offer(frame),
    state: (state) => states.push(state),
  });
  return { ...fixture, client, frames, states, stop, pump };
}
describe("screencast session and bounded frames", () => {
  it("has one latest pending slot with either one or two in flight, and sends a single static change", async () => {
    const f = await attach();
    try {
      expect(f.frames).toHaveLength(1);
      const sourceFrame = f.source.emit()!;
      for (const limit of [1, 2] as const) {
        let now = 0;
        const delivered: ScreencastFrame[] = [];
        const pump = new ScreencastFramePump(
          "sub",
          f.session.id,
          f.session.articleId,
          limit,
          (bytes) => delivered.push(decodeScreencastFrame(bytes).frame),
          () => {},
          () => now,
        );
        for (let n = 0; n < 100; n++) {
          now += 20;
          pump.offer(sourceFrame);
        }
        expect(pump.stats()).toMatchObject({
          in_flight: limit,
          pending: 1,
          dropped: 99 - limit,
        });
        pump.ack(1);
        expect(delivered.at(-1)!.frame_id).toBe(100);
        expect(pump.stats().pending).toBe(0);
        now = 20000;
        expect(pump.frame(1)).toBeUndefined();
        expect(pump.frame(100)).toBeDefined();
        expect(pump.stalled()).toBe(true);
        pump.clear();
        expect(pump.stats().metadata).toBe(0);
      }
    } finally {
      await f.stop();
      await f.session.close();
    }
  });
  it("ignores an old epoch ACK and discards its late frame after a profile restart", async () => {
    const f = await attach();
    try {
      const frame = f.source.emit()!,
        packets: ScreencastFrame[] = [];
      const pump = new ScreencastFramePump(
        "sub",
        f.session.id,
        f.session.articleId,
        1,
        (bytes) => packets.push(decodeScreencastFrame(bytes).frame),
      );
      pump.offer(frame);
      const old = packets[0]!;
      pump.advance(old.stream_epoch + 1);
      expect(pump.frame(old.frame_id)).toEqual(old);
      pump.offer({ ...frame, stream_epoch: old.stream_epoch + 1 });
      pump.offer({ ...frame, stream_epoch: old.stream_epoch + 1 });
      const count = packets.length;
      pump.ack(old.frame_id, old.stream_epoch);
      expect(packets).toHaveLength(count);
      expect(pump.stats().pending).toBe(1);
      pump.offer(frame);
      expect(packets).toHaveLength(count);
      pump.ack(packets.at(-1)!.frame_id, old.stream_epoch + 1);
      expect(packets).toHaveLength(count + 1);
    } finally {
      await f.stop();
      await f.session.close();
    }
  });
  it("encodes only while watched, shares one source, and explicitly exposes no-frame/reconnect", async () => {
    const f = createSyntheticScreencastSession({ automatic: false });
    expect(f.source.emit()).toBeNull();
    expect(f.source.encoded).toBe(0);
    const a = f.session.attach(),
      b = f.session.attach(),
      states: WorkbenchScreencastState[] = [];
    const sa = await f.session.subscribeScreencast(a, {
      frame: () => {},
      state: (s) => states.push(s),
    });
    const sb = await f.session.subscribeScreencast(b, {
      frame: () => {},
      state: () => {},
    });
    expect(f.source.starts).toBe(1);
    await sa();
    expect(f.source.stops).toBe(0);
    f.source.setStatus("no-frame");
    expect(f.session.screencastState(b)).toMatchObject({
      status: "no-frame",
      code: "screencast-page-not-producing",
    });
    f.source.setStatus("reconnecting");
    expect(f.session.screencastState(b).status).toBe("reconnecting");
    f.source.setStatus("live");
    expect(f.session.screencastState(b).status).toBe("live");
    await sb();
    expect(f.source.stops).toBe(1);
    expect(f.source.emit()).toBeNull();
    await f.session.close();
  });
  it("rejects a replaced document before input, accepts the same document after new observations, and reobserves on release", async () => {
    const f = await attach();
    try {
      const original = f.frames[0]!;
      await f.session.refresh();
      await f.session.refresh();
      await f.session.directInput(f.client, 0, original, down, true);
      expect(f.source.inputs).toBe(1);
      expect(f.session.screencastState(f.client)).toMatchObject({
        control: "controlling",
        agent_paused: true,
      });
      const epoch = f.session.view().control.epoch;
      await f.session.directInput(
        f.client,
        epoch,
        original,
        { kind: "text", text: "fixed synthetic" },
        false,
      );
      const snapshots = vi.spyOn(f.page, "snapshot");
      await f.session.releaseDirect(f.client, epoch);
      expect(snapshots).toHaveBeenCalledTimes(1);
      expect(f.session.screencastState(f.client)).toMatchObject({
        control: "watching",
        agent_paused: false,
      });
      f.source.navigate();
      await expect(
        f.session.directInput(
          f.client,
          f.session.view().control.epoch,
          original,
          down,
          true,
        ),
      ).rejects.toMatchObject({ code: "screencast-document-replaced" });
      expect(f.source.inputs).toBe(2);
    } finally {
      await f.stop();
      await f.session.close();
    }
  });
  it("uses epoch CAS across windows, revokes queued input, and pauses on a controlling disconnect", async () => {
    const f = await attach(),
      b = f.session.attach();
    try {
      const initial = f.frames[0]!,
        first = f.session.directInput(f.client, 0, initial, down, true);
      expect(() => f.session.directInput(b, 0, initial, down, true)).toThrow();
      f.session.takeover(b, f.session.view().control.epoch);
      await expect(first).rejects.toMatchObject({
        code: "screencast-control-stale",
      });
      expect(f.session.screencastState(f.client).control).toBe("taken-over");
      expect(f.source.inputs).toBe(0);
      await f.session.disconnectScreencast(b);
      expect(f.session.view().state).toBe("paused");
      expect(f.source.resets).toBeGreaterThan(0);
    } finally {
      await f.stop();
      await f.session.close();
    }
  });
  it("invalidates a pending Agent decision on the first direct input", async () => {
    let answer!: (value: unknown) => void;
    const f = createSyntheticScreencastSession({ automatic: false });
    const decide = vi.fn(
      async () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const session = new WorkbenchSession(
      "article-1",
      f.page,
      {
        max_actions: 10,
        max_model_calls: 10,
        max_retries: 1,
        max_bytes: 10000,
        deadline_ms: 60000,
      },
      decide,
      "session-1",
    );
    const human = session.attach();
    let frame: ScreencastFrame | undefined;
    const pump = new ScreencastFramePump(
      "sub",
      session.id,
      session.articleId,
      1,
      (bytes) => {
        frame = decodeScreencastFrame(bytes).frame;
      },
    );
    const stop = await session.subscribeScreencast(human, {
      frame: (f) => pump.offer(f),
      state: () => {},
    });
    await session.refresh();
    session.takeover(human, session.view().control.epoch);
    const epoch = session.view().control.epoch;
    const running = session.runAgent(human, epoch);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    await session.directInput(
      human,
      session.view().control.epoch,
      frame!,
      down,
      true,
    );
    answer({ kind: "go-back", revision: 1 });
    await running;
    expect(f.source.inputs).toBe(1);
    expect(session.view().state).not.toBe("agent-running");
    await stop();
    await session.close();
    await f.session.close();
  });
  it("rebinds an article to a successor page, without publishing old page frames", async () => {
    const f = await attach(),
      source = new SyntheticScreencastSource("popup-1", false);
    try {
      const page: BrowserPageHandle = {
        ...f.page,
        id: source.pageId,
        screencast: source,
      };
      await f.session.activatePage(page);
      await vi.waitFor(() => expect(source.starts).toBe(1));
      expect(f.source.stops).toBe(1);
      f.pump.ack(f.frames[0]!.frame_id);
      expect(f.frames.at(-1)!.page_id).toBe("popup-1");
      expect(f.source.emit()).toBeNull();
    } finally {
      await f.stop();
      await f.session.close();
    }
  });
  it("follows the production Agent observation hook to its popup and preserves article ownership", async () => {
    const fixture = createSyntheticScreencastSession({ automatic: false });
    const epochChanged = vi.fn();
    const execution: BrowserArticleExecution = {
      session_id: "production-session-1",
      identity: {
        session_id: "production-session-1",
        operation_id: "operation-1",
        generation: 1,
        literature_id: "article-1",
        metadata_snapshot: {
          revision: 1,
          sha256: await sha256(new TextEncoder().encode("synthetic-metadata")),
        },
      },
      clock: new BrowserArticleClock(),
      phase: () => "ready",
      step: async () => ({ kind: "waiting", reason: "page" }),
      changed: async () => {},
      transferStarted: () => {},
      transferCompleted: () => {},
      transferFailed: () => {},
      candidateReady: () => {},
      candidateRejected: () => {},
      setNetworkAccess: () => {},
      controlEpochChanged: epochChanged,
      cancel: () => {},
      rateLimited: () => {},
      close: async () => {},
    };
    const session = new WorkbenchSession(
      "article-1",
      fixture.page,
      {
        max_actions: 10,
        max_model_calls: 10,
        max_retries: 1,
        max_bytes: 10000,
        deadline_ms: 60000,
      },
      undefined,
      execution.session_id,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      execution,
    );
    const client = session.attach();
    let latest: ScreencastFrame | undefined;
    const pump = new ScreencastFramePump(
      "sub",
      session.id,
      session.articleId,
      1,
      (bytes) => {
        latest = decodeScreencastFrame(bytes).frame;
      },
    );
    const stop = await session.subscribeScreencast(client, {
      frame: (frame) => pump.offer(frame),
      state: () => {},
    });
    try {
      await session.refresh();
      const context = session.automaticContext();
      const source = new SyntheticScreencastSource("agent-popup", false),
        page = { ...fixture.page, id: source.pageId, screencast: source };
      context.onObservation!(
        {
          ...session.view().observation!,
          page_id: source.pageId,
          observation_revision: 2,
        },
        null,
        page,
      );
      await vi.waitFor(() => expect(source.starts).toBe(1));
      expect(fixture.source.stops).toBe(1);
      pump.ack(latest!.frame_id);
      expect(latest!.page_id).toBe(source.pageId);
      expect(() =>
        context.onObservation!(
          { ...session.view().observation!, article_id: "another-article" },
          null,
          page,
        ),
      ).toThrow();
      await session.directInput(
        client,
        session.view().control.epoch,
        latest!,
        down,
        true,
      );
      expect(context.canDecide!()).toBe(false);
      expect(epochChanged).toHaveBeenCalled();
      expect(source.inputs).toBe(1);
    } finally {
      await stop();
      await session.close();
      await fixture.session.close();
    }
  });
});
