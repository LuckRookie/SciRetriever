import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import { captureObservationImage } from "../src/browser/observation-image.js";
function fixture(moving = false, broken = false, tooMany = false) {
  const canvas = createCanvas(200, 100),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffff00";
  ctx.fillRect(0, 0, 200, 100);
  let scan = 0;
  const frame = (x: number) => ({
    locator: () => ({
      count: async () => (tooMany ? 129 : 1),
      nth: () => ({
        isVisible: async () => true,
        boundingBox: async () => ({
          x: x + (moving && scan > 1 ? 5 : 0),
          y: 20,
          width: 40,
          height: 20,
        }),
      }),
    }),
  });
  const send = vi.fn(async () => ({
      data: canvas.toBuffer("image/png").toString("base64"),
    })),
    detach = vi.fn(async () => {});
  const page = {
    frames: () => {
      if (broken) throw Error("synthetic detection failure");
      scan++;
      return [frame(20), frame(120)];
    },
    evaluate: async () => ({ width: 200, height: 100 }),
    context: () => ({ newCDPSession: async () => ({ send, detach }) }),
  } as unknown as Page;
  return { page, send, detach };
}
it("covers main and subframe sensitive bounds on the image without any DOM overlay calls", async () => {
  const f = fixture(),
    bytes = await captureObservationImage(f.page);
  expect(bytes).not.toBeNull();
  const image = await loadImage(Buffer.from(bytes!)),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  for (const x of [30, 130])
    expect([...ctx.getImageData(x, 30, 1, 1).data].slice(0, 3)).toEqual([
      32, 32, 32,
    ]);
  const clear = ctx.getImageData(90, 30, 1, 1).data;
  expect(clear[0]).toBeGreaterThan(200);
  expect(clear[1]).toBeGreaterThan(200);
  expect(f.send).toHaveBeenCalledExactlyOnceWith("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  expect(f.detach).toHaveBeenCalledOnce();
});
it("fails closed if sensitive regions move, cannot be detected, or exceed the bounded scan", async () => {
  for (const f of [
    fixture(true),
    fixture(false, true),
    fixture(false, false, true),
  ])
    expect(await captureObservationImage(f.page)).toBeNull();
});
