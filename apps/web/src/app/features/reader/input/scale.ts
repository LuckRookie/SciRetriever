/**
 * The reading scale (reading-experience 1.8.1): the full text's reading size
 * and the PDF's zoom, and how the wheel, a touchpad pinch and the keys move
 * them. Pure arithmetic, so the rules can be checked without a browser
 * (spec 8.1 “阅读比例”).
 */

/** The full text: a reading size in whole px, 16–32 (80%–160% of 20 px). */
export const TEXT_SCALE = { min: 16, max: 32, base: 20 } as const;
/** The PDF: 50%–300% of its own size, or 适合宽度. */
export const PDF_SCALE = { min: 0.5, max: 3 } as const;
export type PdfZoom = "fit" | number;

/** One wheel notch: 100 px, 3 lines or one page (spec 1.8.1). */
const NOTCH = [100, 3, 1] as const;
/** Input stops for this long: the remainder and the pinch's fraction go. */
export const GESTURE_IDLE_MS = 300;
/** Never more than three steps from one wheel event. */
const MOST_STEPS = 3;

export interface WheelInput {
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (`WheelEvent.deltaMode`). */
  deltaMode: number;
  /** `ctrlKey` on the event: the Control key, or a pinch on a touchpad. */
  ctrlKey: boolean;
  metaKey: boolean;
}
/**
 * What a wheel event over the desk is: a step of the wheel, a pinch, or
 * nothing for the scale. A pinch carries `ctrlKey` while Control is not held;
 * a large delta without the key is still a wheel (spec 1.8.1).
 */
export function wheelKind(
  event: WheelInput,
  controlHeld: boolean,
  mac: boolean,
): "wheel" | "pinch" | null {
  if (mac && event.metaKey) return "wheel";
  if (!event.ctrlKey) return null;
  if (controlHeld || event.deltaMode !== 0 || Math.abs(event.deltaY) >= 50)
    return "wheel";
  return "pinch";
}

/** The wheel's running count of notches between steps. */
export interface WheelCount {
  rest: number;
  at: number;
}
export const wheelCount = (): WheelCount => ({ rest: 0, at: -Infinity });
/**
 * Steps from one wheel event, positive to enlarge (forward, `deltaY` < 0):
 * notches add up, every whole one is a step, the remainder stays until the
 * direction turns or 300 ms pass without input; at most three per event.
 */
export function wheelSteps(
  count: WheelCount,
  event: Pick<WheelInput, "deltaY" | "deltaMode">,
  now: number,
): number {
  const notch = NOTCH[event.deltaMode as 0 | 1 | 2] ?? NOTCH[0];
  const notches = -event.deltaY / notch;
  if (
    now - count.at > GESTURE_IDLE_MS ||
    (count.rest !== 0 && Math.sign(count.rest) !== Math.sign(notches))
  )
    count.rest = 0;
  count.at = now;
  const total = count.rest + notches;
  const whole = Math.trunc(total);
  count.rest = total - whole;
  return Math.max(-MOST_STEPS, Math.min(MOST_STEPS, whole)) || 0;
}

/** The pinch's factor for one frame's summed `deltaY`, never more than 1.25 either way. */
export function pinchFactor(deltaY: number): number {
  return Math.max(0.8, Math.min(1.25, Math.exp(-deltaY / 100)));
}

/** A reading size within 16–32 px; anything else read back is the default. */
export function textSize(value: unknown, fallback: number = TEXT_SCALE.base) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" &&
    Number.isInteger(n) &&
    n >= TEXT_SCALE.min &&
    n <= TEXT_SCALE.max
    ? n
    : fallback;
}
/** A stored PDF zoom: 适合宽度 or 0.50–3.00; anything else is 适合宽度. */
export function pdfZoom(value: unknown): PdfZoom {
  if (value === "fit") return "fit";
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= PDF_SCALE.min &&
    value <= PDF_SCALE.max
    ? Math.round(value * 100) / 100
    : "fit";
}
/** The full text one step on (1 px, 5 points), held at the ends. */
export function stepText(size: number, steps: number): number {
  return Math.max(
    TEXT_SCALE.min,
    Math.min(TEXT_SCALE.max, Math.round(size) + steps),
  );
}
/**
 * The PDF `steps` tens of points on from `actual` (the zoom drawn now, a
 * ratio). The first step from 适合宽度 or a pinched value off the grid goes
 * to the next ten in its direction; a value already outside the range comes
 * back to the edge only when moved towards it (spec 1.8.1).
 */
export function stepPdf(actual: number, steps: number): number {
  if (!steps) return actual;
  const points = Math.round(actual * 1000) / 10;
  const min = PDF_SCALE.min * 100,
    max = PDF_SCALE.max * 100;
  if (points > max) return steps < 0 ? PDF_SCALE.max : actual;
  if (points < min) return steps > 0 ? PDF_SCALE.min : actual;
  const first =
    steps > 0
      ? Math.floor(points / 10 + 1e-9) * 10 + 10
      : Math.ceil(points / 10 - 1e-9) * 10 - 10;
  const next = first + (steps - Math.sign(steps)) * 10;
  return Math.max(min, Math.min(max, next)) / 100;
}
/** A pinched full text: the exact size followed, the whole px shown. */
export function pinchText(exact: number, factor: number) {
  const next = Math.max(
    TEXT_SCALE.min,
    Math.min(TEXT_SCALE.max, exact * factor),
  );
  return { exact: next, size: Math.round(next) };
}
/** A pinched PDF: the exact zoom followed, whole points drawn. */
export function pinchPdf(exact: number, factor: number) {
  const next = Math.max(PDF_SCALE.min, Math.min(PDF_SCALE.max, exact * factor));
  return { exact: next, zoom: Math.round(next * 100) / 100 };
}
/** Whether a step that way can still change the scale (the ends stop it). */
export function canStepText(size: number, steps: number) {
  return stepText(size, steps) !== size;
}
export function canStepPdf(actual: number, steps: number) {
  return Math.abs(stepPdf(actual, steps) - actual) > 1e-6;
}
/** “110%”: the full text's size as a share of 20 px. */
export const textPercent = (size: number) =>
  `${Math.round((size / TEXT_SCALE.base) * 100)}%`;
export const pdfPercent = (zoom: PdfZoom) =>
  zoom === "fit" ? "适合宽度" : `${Math.round(zoom * 100)}%`;
