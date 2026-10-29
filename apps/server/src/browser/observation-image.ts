import { createRequire } from "node:module";
// The native canvas takes most of a second to load; only load it once an
// image is drawn, so commands that never draw (most of the CLI) skip it.
let canvasModule: typeof import("@napi-rs/canvas") | undefined;
const nativeCanvas = () =>
  (canvasModule ??= createRequire(import.meta.url)(
    "@napi-rs/canvas",
  ) as typeof import("@napi-rs/canvas"));
import type { Page } from "playwright";

const sensitive = 'input[type="password"],input[autocomplete="one-time-code"]';
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
async function regions(page: Page): Promise<readonly Rect[]> {
  const result: Rect[] = [];
  let inspected = 0;
  for (const frame of page.frames()) {
    const controls = frame.locator(sensitive);
    const count = await controls.count();
    inspected += count;
    if (inspected > 128) throw new Error("Sensitive region bound exceeded");
    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      if (!(await control.isVisible())) continue;
      const rect = await control.boundingBox();
      if (rect) result.push(rect);
    }
  }
  return result;
}
/** Surface capture never mutates the DOM. Moving/undetectable sensitive regions fail closed. */
export async function captureObservationImage(
  page: Page,
): Promise<Uint8Array | null> {
  let cdp:
    | Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>
    | undefined;
  try {
    const before = await regions(page);
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    if (!viewport.width || !viewport.height) return null;
    cdp = await page.context().newCDPSession(page);
    const captured = await cdp.send("Page.captureScreenshot", {
      format: before.length ? "png" : "jpeg",
      ...(before.length ? {} : { quality: 65 }),
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const after = await regions(page);
    if (JSON.stringify(before) !== JSON.stringify(after)) return null;
    const bytes = Buffer.from(captured.data, "base64");
    if (bytes.length > 32 * 1024 * 1024) return null;
    if (!before.length) return new Uint8Array(bytes);
    const { createCanvas, loadImage } = nativeCanvas();
    const image = await loadImage(bytes);
    const surface = createCanvas(image.width, image.height);
    const context = surface.getContext("2d");
    context.drawImage(image, 0, 0);
    context.fillStyle = "#202020";
    const sx = image.width / viewport.width,
      sy = image.height / viewport.height;
    for (const rect of before)
      context.fillRect(
        Math.floor(rect.x * sx) - 4,
        Math.floor(rect.y * sy) - 4,
        Math.ceil(rect.width * sx) + 8,
        Math.ceil(rect.height * sy) + 8,
      );
    return new Uint8Array(await surface.encode("jpeg", 65));
  } catch {
    // A missing image is safer than emitting an unmasked observation.
    return null;
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
}
