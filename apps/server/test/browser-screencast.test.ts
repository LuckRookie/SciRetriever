import { EventEmitter } from "node:events";
import { createCanvas } from "@napi-rs/canvas";
import type { CDPSession, Page } from "playwright";
import { expect, it, vi } from "vitest";
import { ChromiumScreencastSource } from "../src/browser/screencast.js";
import { ScreencastBandwidthController } from "../src/workbench/screencast-relay.js";
function setup() {
  const events = new EventEmitter(),
    pageEvents = new EventEmitter(),
    calls: { method: string; params?: unknown }[] = [];
  const jpeg = createCanvas(32, 24).toBuffer("image/jpeg");
  let loader = "loader-1",
    failStart = false,
    failStop = false,
    produce = false;
  const emit = () =>
    events.emit("Page.screencastFrame", {
      data: jpeg.toString("base64"),
      sessionId: 1,
      metadata: {
        timestamp: Date.now() / 1000,
        deviceWidth: 1280,
        deviceHeight: 720,
        offsetTop: 0,
        pageScaleFactor: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });
  const send = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, ...(params ? { params } : {}) });
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { loaderId: loader } } };
    if (method === "Page.stopScreencast" && failStop)
      throw new Error("synthetic stop failure");
    if (method === "Page.startScreencast") {
      if (failStart) throw new Error("synthetic");
      if (produce) emit();
    }
    return {};
  });
  const detach = vi.fn(async () => {});
  const cdp = {
    send,
    on: events.on.bind(events),
    detach,
  } as unknown as CDPSession;
  const newCDP = vi.fn(async () => cdp);
  const page = {
    once: pageEvents.once.bind(pageEvents),
    isClosed: () => false,
    context: () => ({ newCDPSession: newCDP }),
    evaluate: async () => 1,
  } as unknown as Page;
  const source = new ChromiumScreencastSource(page, "page-1", (operation) =>
    operation(),
  );
  return {
    source,
    calls,
    newCDP,
    emit,
    navigate: () => {
      loader = "loader-2";
      events.emit("Page.frameNavigated", { frame: { loaderId: loader } });
    },
    produce: () => {
      produce = true;
    },
    failStart: () => {
      failStart = true;
    },
    failStop: () => {
      failStop = true;
    },
    detach,
  };
}
it("lazily starts one encoder with everyNthFrame=1, ACKs every CDP frame, and does not misreport the first synchronous frame as missing", async () => {
  vi.useFakeTimers();
  const f = setup();
  try {
    expect(f.newCDP).not.toHaveBeenCalled();
    f.produce();
    const frames = vi.fn(),
      status = vi.fn();
    const stop = await f.source.subscribe({ frame: frames, status });
    expect(frames).toHaveBeenCalledOnce();
    expect(f.calls).toContainEqual({
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 1080,
        everyNthFrame: 1,
      },
    });
    expect(f.calls).toContainEqual({
      method: "Page.screencastFrameAck",
      params: { sessionId: 1 },
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(status.mock.calls.some((c) => c[0] === "no-frame")).toBe(false);
    const stop2 = await f.source.subscribe({
      frame: () => {},
      status: () => {},
    });
    expect(f.newCDP).toHaveBeenCalledOnce();
    await stop();
    expect(
      f.calls.filter((c) => c.method === "Page.stopScreencast"),
    ).toHaveLength(0);
    await stop2();
    expect(
      f.calls.filter((c) => c.method === "Page.stopScreencast"),
    ).toHaveLength(1);
    f.emit();
    expect(frames).toHaveBeenCalledOnce();
    expect(
      f.calls.filter((c) => c.method === "Page.screencastFrameAck"),
    ).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
it("reports a real no-frame page and a failed start explicitly, with no screenshot fallback", async () => {
  vi.useFakeTimers();
  const f = setup(),
    status = vi.fn();
  try {
    const stop = await f.source.subscribe({ frame: () => {}, status });
    await vi.advanceTimersByTimeAsync(3000);
    expect(status).toHaveBeenCalledWith(
      "no-frame",
      "screencast-page-not-producing",
      "unknown",
    );
    f.navigate();
    expect(status).toHaveBeenCalledWith("reconnecting", undefined, "unknown");
    await stop();
    const failed = setup();
    failed.failStart();
    const stopped = await failed.source.subscribe({ frame: () => {}, status });
    expect(status).toHaveBeenCalledWith(
      "no-frame",
      "screencast-start-failed",
      "unknown",
    );
    expect(
      failed.calls.some((c) => c.method === "Page.captureScreenshot"),
    ).toBe(false);
    await stopped();
  } finally {
    vi.useRealTimers();
  }
});
it("adapts only after measured ACK throughput, with bounded profiles and slow upgrades", () => {
  let now = 0;
  const b = new ScreencastBandwidthController(() => now),
    down: number[] = [];
  for (let n = 0; n < 40; n++) {
    now += 400;
    const rank = b.ack(80000, 400);
    if (rank !== null) down.push(rank);
  }
  expect(down).toEqual([1, 2, 3]);
  // A static page and a long gap alone do not establish bandwidth.
  now += 30000;
  expect(b.ack(20000, 30)).toBeNull();
  const up: number[] = [];
  for (let n = 0; n < 32; n++) {
    now += 300;
    const rank = b.ack(20000, 30);
    if (rank !== null) up.push(rank);
  }
  expect(up).toEqual([2]);
});

it("retires the native session even if the stop command fails", async () => {
  const f = setup();
  f.produce();
  const stop = await f.source.subscribe({ frame: () => {}, status: () => {} });
  f.failStop();
  await expect(stop()).rejects.toThrow("Screencast native retirement failed");
  expect(f.detach).toHaveBeenCalledOnce();
});
