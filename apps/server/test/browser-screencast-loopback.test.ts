import { WorkbenchSession } from "../src/workbench/session.js";
import { expect, it, vi, describe } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ScreencastFrame } from "@sciretriever/contracts";
import type { PageScreencastFrame } from "../src/browser/screencast.js";
import { screencastLoopbackFixture } from "./screencast-loopback-fixture.js";
const wire = (frame: PageScreencastFrame): ScreencastFrame => {
  const { jpeg, ...facts } = frame;
  expect(jpeg.byteLength).toBeGreaterThan(0);
  return {
    ...facts,
    protocol_version: 1,
    subscription_id: "sub",
    frame_id: 1,
    session_id: "session-1",
    article_id: "article-1",
  };
};
const mouse = (
  frame: PageScreencastFrame,
  x: number,
  y: number,
  action: "down" | "up",
) => ({
  kind: "mouse" as const,
  action,
  x: (x * frame.width) / frame.viewport_width,
  y: (y * frame.height) / frame.viewport_height,
  button: "left" as const,
  buttons: action === "down" ? 1 : 0,
  click_count: 1,
  modifiers: 0,
});
async function pixel(bytes: Uint8Array, x: number, y: number) {
  const image = await loadImage(Buffer.from(bytes)),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(
    0,
    3,
  );
}
describe.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "Cloak production Host screencast on loopback",
  () => {
    it("produces a first frame on a static page on every fresh subscription and proves native stop leaves zero raw frames", async () => {
      const f = await screencastLoopbackFixture(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      try {
        let lastEpoch = 0;
        const firstFrameMs: number[] = [],
          stopMs: number[] = [],
          idleRaw: number[] = [];
        for (let cycle = 0; cycle < 8; cycle++) {
          let first: PageScreencastFrame | undefined;
          const started = performance.now();
          const stop = await f.page.screencast!.subscribe({
            frame: (frame) => {
              if (!first) {
                first = frame;
                firstFrameMs.push(performance.now() - started);
              }
            },
            status: () => {},
          });
          await vi.waitFor(() => expect(first).toBeDefined(), {
            timeout: 2500,
          });
          expect(first!.stream_epoch).toBeGreaterThan(lastEpoch);
          lastEpoch = first!.stream_epoch;
          const stopStarted = performance.now();
          await stop();
          stopMs.push(performance.now() - stopStarted);
          const raw = f.page.screencast!.diagnostics!().raw_frames;
          await new Promise((resolve) => setTimeout(resolve, 500));
          idleRaw.push(f.page.screencast!.diagnostics!().raw_frames - raw);
          expect(f.page.screencast!.diagnostics!().raw_frames).toBe(raw);
          expect(f.page.screencast!.diagnostics!().stops).toBe(cycle + 1);
        }
        console.info(
          "Static native screencast verification",
          JSON.stringify({
            first_frame_ms: firstFrameMs,
            stop_ack_ms: stopMs,
            idle_raw_frames_500ms: idleRaw,
          }),
        );
      } finally {
        await f.close();
      }
    }, 30000);
    it("gives B a first frame within 2.5 seconds while A controls a static page, and A keeps streaming on the same epoch", async () => {
      const f = await screencastLoopbackFixture(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
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
        undefined,
        "session-1",
      );
      const a = session.attach(),
        b = session.attach(),
        aFrames: PageScreencastFrame[] = [],
        bFrames: PageScreencastFrame[] = [];
      let stopA: (() => Promise<void>) | undefined,
        stopB: (() => Promise<void>) | undefined,
        firstBMs: number | undefined;
      try {
        stopA = await session.subscribeScreencast(a, {
          frame: (frame) => aFrames.push(frame),
          state: () => {},
        });
        await vi.waitFor(() => expect(aFrames.length).toBeGreaterThan(0), {
          timeout: 2500,
        });
        const first = aFrames.at(-1)!;
        await session.directInput(
          a,
          session.view().control.epoch,
          wire(first),
          mouse(first, 75, 105, "down"),
          true,
        );
        await session.directInput(
          a,
          session.view().control.epoch,
          wire(first),
          mouse(first, 75, 105, "up"),
          false,
        );
        await vi.waitFor(
          async () => {
            const frame = aFrames.at(-1)!;
            const p = await pixel(
              frame.jpeg,
              (40 * frame.width) / frame.viewport_width,
              (95 * frame.height) / frame.viewport_height,
            );
            expect(p[1]!).toBeGreaterThan(p[2]!);
          },
          { timeout: 2500 },
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        const raw = f.page.screencast!.diagnostics!().raw_frames;
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(f.page.screencast!.diagnostics!().raw_frames).toBe(raw);
        const current = aFrames.at(-1)!,
          aCount = aFrames.length,
          diagnostics = f.page.screencast!.diagnostics!();
        const started = performance.now();
        stopB = await session.subscribeScreencast(b, {
          frame: (frame) => {
            if (!bFrames.length) firstBMs = performance.now() - started;
            bFrames.push(frame);
          },
          state: () => {},
        });
        await vi.waitFor(() => expect(bFrames.length).toBeGreaterThan(0), {
          timeout: 2500,
        });
        expect(firstBMs!).toBeLessThan(2500);
        expect(bFrames[0]).toMatchObject({
          page_id: current.page_id,
          document_id: current.document_id,
          stream_epoch: current.stream_epoch,
          captured_at: current.captured_at,
        });
        expect(session.view().control.controller_id).toBe(a);
        expect(session.screencastState(b).control).toBe("taken-over");
        expect(aFrames).toHaveLength(aCount);
        expect(f.page.screencast!.diagnostics!()).toEqual(diagnostics);
        await session.directInput(
          a,
          session.view().control.epoch,
          wire(current),
          mouse(current, 75, 105, "down"),
          false,
        );
        await session.directInput(
          a,
          session.view().control.epoch,
          wire(current),
          mouse(current, 75, 105, "up"),
          false,
        );
        await vi.waitFor(
          () => {
            expect(aFrames.length).toBeGreaterThan(aCount);
            expect(bFrames.length).toBeGreaterThan(1);
          },
          { timeout: 2500 },
        );
        expect(aFrames.at(-1)!.stream_epoch).toBe(current.stream_epoch);
        console.info(
          "Late static viewer verification",
          JSON.stringify({
            first_frame_ms: firstBMs,
            raw_frames_while_idle_500ms: 0,
            encoder_restarted: false,
            control_unchanged: true,
            stream_epoch: current.stream_epoch,
          }),
        );
      } finally {
        await stopB?.();
        await stopA?.();
        await session.close();
        await f.close();
      }
    }, 20000);
    it("pushes a static change, masks only the observation image, stays subscribed across refresh/navigation and rebinds to a popup", async () => {
      const f = await screencastLoopbackFixture(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      const frames: PageScreencastFrame[] = [],
        statuses: string[] = [];
      let stop: (() => Promise<void>) | undefined;
      try {
        stop = await f.page.screencast!.subscribe({
          frame: (frame) => frames.push(frame),
          status: (status) => statuses.push(status),
        });
        await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), {
          timeout: 20_000,
        });
        const first = frames.at(-1)!;
        expect(first.quality).toBe(60);
        expect(first.width).toBeLessThanOrEqual(1280);
        await f.page.screencast!.input(
          mouse(first, 75, 105, "down"),
          wire(first),
          () => true,
          true,
        );
        await f.page.screencast!.input(
          mouse(first, 75, 105, "up"),
          wire(first),
          () => true,
          false,
        );
        await vi.waitFor(
          async () =>
            expect((await f.page.snapshot()).text).toContain("clicks 1"),
          { timeout: 20_000 },
        );
        await vi.waitFor(
          async () => {
            const latest = frames.at(-1)!;
            const p = await pixel(
              latest.jpeg,
              (40 * latest.width) / latest.viewport_width,
              (95 * latest.height) / latest.viewport_height,
            );
            expect(p[1]!).toBeGreaterThan(p[2]!);
          },
          { timeout: 20_000 },
        );
        const snapshot = await f.page.snapshot();
        expect(snapshot.screenshot).not.toBeNull();
        const image = await loadImage(Buffer.from(snapshot.screenshot!));
        // The page's sensitive inputs remain yellow in live frames. Only the Agent JPEG is opaque.
        for (const y of [180, 240]) {
          const p = await pixel(
            snapshot.screenshot!,
            (40 * image.width) / snapshot.viewport.width,
            (y * image.height) / snapshot.viewport.height,
          );
          expect(Math.max(...p)).toBeLessThan(50);
        }
        const latest = frames.at(-1)!;
        const visible = await pixel(
          latest.jpeg,
          (40 * latest.width) / latest.viewport_width,
          (180 * latest.height) / latest.viewport_height,
        );
        expect(visible[0]!).toBeGreaterThan(150);
        expect(visible[1]!).toBeGreaterThan(150);
        expect(snapshot.text).toContain("masks 0");
        for (let n = 0; n < 4; n++) await f.page.snapshot();
        for (const live of frames) {
          const sample = await pixel(
            live.jpeg,
            (40 * live.width) / live.viewport_width,
            (180 * live.height) / live.viewport_height,
          );
          expect(sample[0]!).toBeGreaterThan(150);
          expect(sample[1]!).toBeGreaterThan(150);
        }
        const controlFrame = frames.at(-1)!;
        await f.page.screencast!.input(
          mouse(controlFrame, 75, 300, "down"),
          wire(controlFrame),
          () => true,
          true,
        );
        await f.page.screencast!.input(
          mouse(controlFrame, 75, 300, "up"),
          wire(controlFrame),
          () => true,
          false,
        );
        await f.page.screencast!.input(
          { kind: "paste", text: "合成" },
          wire(controlFrame),
          () => true,
          false,
        );
        await f.page.screencast!.input(
          {
            kind: "composition",
            text: "ni",
            selection_start: 0,
            selection_end: 2,
          },
          wire(controlFrame),
          () => true,
          false,
        );
        await f.page.screencast!.input(
          { kind: "text", text: "你" },
          wire(controlFrame),
          () => true,
          false,
        );
        await vi.waitFor(
          async () =>
            expect((await f.page.snapshot()).text).toContain("keys 3"),
          { timeout: 20_000 },
        );
        await f.page.screencast!.input(
          {
            kind: "key",
            action: "down",
            key: "ArrowLeft",
            code: "ArrowLeft",
            key_code: 37,
            location: 0,
            auto_repeat: false,
            modifiers: 0,
          },
          wire(controlFrame),
          () => true,
          false,
        );
        await f.page.screencast!.reset();
        const wheelFrame = frames.at(-1)!;
        await f.page.screencast!.input(
          {
            kind: "wheel",
            x: (700 * wheelFrame.width) / wheelFrame.viewport_width,
            y: (600 * wheelFrame.height) / wheelFrame.viewport_height,
            delta_x: 0,
            delta_y: 120,
            modifiers: 0,
          },
          wire(wheelFrame),
          () => true,
          false,
        );
        await vi.waitFor(
          () => expect(frames.at(-1)!.scroll_y).toBeGreaterThan(0),
          { timeout: 20_000 },
        );
        const dragFrame = frames.at(-1)!;
        for (const [phase, x] of [
          ["start", 240],
          ["move", 270],
          ["end", 270],
        ] as const)
          await f.page.screencast!.input(
            {
              kind: "drag",
              phase,
              x: (x * dragFrame.width) / dragFrame.viewport_width,
              y: (360 * dragFrame.height) / dragFrame.viewport_height,
              modifiers: 0,
            },
            wire(dragFrame),
            () => true,
            false,
          );
        await vi.waitFor(
          async () =>
            expect((await f.page.snapshot()).text).toContain("drag 1"),
          { timeout: 20_000 },
        );
        await f.page.navigate!(f.origin + "/next");
        await vi.waitFor(
          () => expect(frames.at(-1)!.document_id).not.toBe(first.document_id),
          { timeout: 20_000 },
        );
        await expect(
          f.page.screencast!.input(
            mouse(first, 75, 105, "down"),
            wire(first),
            () => true,
            true,
          ),
        ).rejects.toMatchObject({ code: "screencast-document-replaced" });
        const second = frames.at(-1)!;
        await f.page.navigate!(f.origin + "/next");
        await vi.waitFor(
          () => expect(frames.at(-1)!.document_id).not.toBe(second.document_id),
          { timeout: 20_000 },
        );
        const reloaded = frames.at(-1)!;
        await f.page.screencast!.input(
          mouse(reloaded, 75, 360, "down"),
          wire(reloaded),
          () => true,
          true,
        );
        await f.page.screencast!.input(
          mouse(reloaded, 75, 360, "up"),
          wire(reloaded),
          () => true,
          false,
        );
        let popup: Awaited<ReturnType<NonNullable<typeof f.page.successor>>>;
        await vi.waitFor(
          async () => {
            popup = await f.page.successor!();
            expect(popup).not.toBeNull();
          },
          { timeout: 20_000 },
        );
        await stop();
        stop = undefined;
        const popupFrames: PageScreencastFrame[] = [];
        const stopPopup = await popup!.screencast!.subscribe({
          frame: (frame) => popupFrames.push(frame),
          status: () => {},
        });
        await vi.waitFor(() => expect(popupFrames.length).toBeGreaterThan(0), {
          timeout: 20_000,
        });
        expect(popupFrames[0]!.page_id).not.toBe(first.page_id);
        await stopPopup();
        expect(statuses).not.toContain("no-frame");
        expect(f.rejected()).toBe(0);
      } finally {
        await stop?.();
        await f.close();
      }
    }, 45000);
  },
);
