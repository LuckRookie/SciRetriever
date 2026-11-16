import { useEffect, useRef, useState } from "react";
import type { ReaderFrame, PdfControls } from "../../../../reading/contract.js";
import {
  GESTURE_IDLE_MS,
  TEXT_SCALE,
  canStepPdf,
  canStepText,
  pdfPercent,
  pinchFactor,
  pinchPdf,
  pinchText,
  stepPdf,
  stepText,
  textPercent,
  wheelCount,
  wheelKind,
  wheelSteps,
} from "./scale.js";
import { isMac } from "./commands.js";
import { readingFont } from "./reading-font.js";

export interface ScaleTarget {
  /** What the desk scales now; null when it cannot (still intercepted). */
  view: "doc" | "pdf" | null;
  /** The desk: Ctrl+wheel and pinches over it are the reader's. */
  desk: HTMLElement | null;
  frame: ReaderFrame | null;
  pdf: PdfControls | null;
  /** Applies a reading size at once, in this frame (the sheet and the text). */
  applyFont: (size: number) => void;
  /** The reading line's height on screen, for the keys and menus. */
  readingLine: () => number | null;
}
/**
 * The reading scale's input (reading-experience 1.8.1): Ctrl+wheel and
 * pinches over the desk, and the steps the keys and menus take. The point
 * under the pointer, or the reading line, stays where it is (spec 4.2); a
 * gesture measures it once, again after the pointer moves 8 px or 300 ms
 * pass. Returns the steps for the table of operations and what the page
 * header and the status line say.
 */
export function useReadingScale(target: ScaleTarget) {
  const now = useRef(target);
  now.current = target;
  const [recent, setRecent] = useState(false);
  const [spoken, setSpoken] = useState("");
  const timers = useRef<{
    recent?: ReturnType<typeof setTimeout>;
    speak?: ReturnType<typeof setTimeout>;
    release?: ReturnType<typeof setTimeout>;
  }>({});
  const gesture = useRef<{
    x: number;
    y: number;
    at: number;
    /** The pinch's exact value between whole steps. */
    exact: number | null;
  } | null>(null);
  const changedAt = useRef(-Infinity);
  const percent = () => {
    const t = now.current;
    return t.view === "pdf"
      ? t.pdf
        ? pdfPercent(t.pdf.now().zoom)
        : ""
      : textPercent(readingFont.get());
  };
  /** Shown 1.5 s after a change, spoken once 300 ms after it stops. */
  const changed = () => {
    changedAt.current = performance.now();
    setRecent(true);
    clearTimeout(timers.current.recent);
    timers.current.recent = setTimeout(() => setRecent(false), 1500);
    clearTimeout(timers.current.speak);
    timers.current.speak = setTimeout(
      () => setSpoken(`比例 ${percent()}`),
      300,
    );
  };
  /** Holds the point at (x, y) for this gesture; a new one when it moved or paused. */
  const hold = (point: { x: number; y: number }) => {
    const t = now.current,
      at = performance.now(),
      g = gesture.current;
    if (
      !g ||
      Math.hypot(point.x - g.x, point.y - g.y) > 8 ||
      at - g.at > GESTURE_IDLE_MS
    ) {
      t.frame?.holdPoint?.(null);
      t.frame?.holdPoint?.(point);
      gesture.current = { ...point, at, exact: null };
    } else g.at = at;
    clearTimeout(timers.current.release);
    timers.current.release = setTimeout(() => {
      gesture.current = null;
      // Done: the reading anchor is measured at the reading line again.
      now.current.frame?.holdPoint?.(null);
    }, GESTURE_IDLE_MS);
  };
  /**
   * The wheel and the pinch hold the point under the pointer (spec 1.8.1);
   * the keys and menus keep the block at the reading line, as every other
   * change of size does (spec 4.2).
   */
  const holdAt = (point: { x: number; y: number } | null) => {
    if (point) return hold(point);
    clearTimeout(timers.current.release);
    gesture.current = null;
    now.current.frame?.holdPoint?.(null);
  };
  const applyText = (size: number) => {
    if (size === readingFont.get()) return false;
    now.current.applyFont(size);
    readingFont.set(size);
    changed();
    return true;
  };
  const applyPdf = (zoom: PdfControls["zoom"]) => {
    const pdf = now.current.pdf;
    if (!pdf || zoom === pdf.now().zoom) return false;
    pdf.zoomTo(zoom);
    changed();
    return true;
  };
  const setText = (size: number, point: { x: number; y: number } | null) => {
    if (size === readingFont.get()) return false;
    holdAt(point);
    return applyText(size);
  };
  const setPdf = (
    zoom: PdfControls["zoom"],
    point: { x: number; y: number } | null,
  ) => {
    if (!now.current.pdf || zoom === now.current.pdf.now().zoom) return false;
    holdAt(point);
    return applyPdf(zoom);
  };
  /** Steps from the keys, the menus and the wheel; true when the scale changed. */
  const step = (
    steps: number,
    point: { x: number; y: number } | null = null,
  ) => {
    const t = now.current;
    if (t.view === "doc")
      return setText(stepText(readingFont.get(), steps), point);
    if (t.view === "pdf" && t.pdf)
      return setPdf(stepPdf(t.pdf.now().scale, steps), point);
    return false;
  };
  const reset = () => {
    const t = now.current;
    if (t.view === "doc") return setText(TEXT_SCALE.base, null);
    if (t.view === "pdf") return setPdf("fit", null);
    return false;
  };
  const actual = () => setPdf(1, null);
  const can = (steps: number) => {
    const t = now.current;
    if (t.view === "doc") return canStepText(readingFont.get(), steps);
    if (t.view === "pdf" && t.pdf) return canStepPdf(t.pdf.now().scale, steps);
    return false;
  };
  // The wheel and the pinch over the desk.
  useEffect(() => {
    const desk = target.desk;
    if (!desk) return;
    const mac = isMac();
    let control = false;
    const keys = (event: KeyboardEvent) => {
      control = event.ctrlKey;
    };
    const count = wheelCount();
    let pinch = { deltaY: 0, x: 0, y: 0, frame: 0 };
    const pinchStep = () => {
      pinch.frame = 0;
      const t = now.current,
        factor = pinchFactor(pinch.deltaY),
        point = { x: pinch.x, y: pinch.y };
      pinch.deltaY = 0;
      if (t.view !== "doc" && !(t.view === "pdf" && t.pdf)) return;
      // The pinch follows its exact value; only whole steps are drawn.
      hold(point);
      const g = gesture.current!;
      if (t.view === "doc") {
        const next = pinchText(g.exact ?? readingFont.get(), factor);
        g.exact = next.exact;
        applyText(next.size);
      } else {
        const next = pinchPdf(g.exact ?? t.pdf!.now().scale, factor);
        g.exact = next.exact;
        applyPdf(next.zoom);
      }
    };
    const wheel = (event: WheelEvent) => {
      const kind = wheelKind(event, control, mac);
      if (!kind) {
        // Just after a change, a plain wheel does not scroll (spec 1.8.1).
        if (performance.now() - changedAt.current < 150) event.preventDefault();
        return;
      }
      // A dialog open, or a view that has no scale: the browser's zoom, untouched.
      if (document.querySelector(".ui-overlay") || !now.current.view) return;
      event.preventDefault();
      if (kind === "pinch") {
        pinch.deltaY += event.deltaY;
        pinch.x = event.clientX;
        pinch.y = event.clientY;
        if (!pinch.frame) pinch.frame = requestAnimationFrame(pinchStep);
        return;
      }
      const steps = wheelSteps(count, event, performance.now());
      if (steps) step(steps, { x: event.clientX, y: event.clientY });
    };
    /**
     * An open menu or popover lies over the desk: Ctrl+wheel there closes it
     * and does not scale; nor does the browser zoom the page.
     */
    const over = (event: WheelEvent) => {
      if (!(event.ctrlKey || (mac && event.metaKey))) return;
      const popover = document.querySelector<HTMLElement>(".ui-popover");
      if (!popover || document.querySelector(".ui-overlay")) return;
      if (popover.contains(event.target as Node)) return;
      const box = desk.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      popover
        .querySelector("[role='menu'], [role='dialog'], [tabindex]")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    };
    desk.addEventListener("wheel", wheel, { passive: false });
    // Only while a menu or popover is open is a non-passive wheel listener on
    // the window (spec 1.8.1: otherwise the desk's alone, so scrolling the
    // page never waits on it). Popovers are portalled into <body>.
    let watching = false;
    const watch = () => {
      const open = !!document.querySelector(".ui-popover");
      if (open === watching) return;
      watching = open;
      if (open)
        addEventListener("wheel", over, { passive: false, capture: true });
      else removeEventListener("wheel", over, { capture: true });
    };
    const popovers = new MutationObserver(watch);
    popovers.observe(document.body, { childList: true });
    watch();
    addEventListener("keydown", keys, true);
    addEventListener("keyup", keys, true);
    return () => {
      cancelAnimationFrame(pinch.frame);
      pinch = { deltaY: 0, x: 0, y: 0, frame: 0 };
      desk.removeEventListener("wheel", wheel);
      popovers.disconnect();
      removeEventListener("wheel", over, { capture: true });
      removeEventListener("keydown", keys, true);
      removeEventListener("keyup", keys, true);
    };
    // `step` reads the latest target through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.desk]);
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.recent);
      clearTimeout(t.speak);
      clearTimeout(t.release);
    };
  }, []);
  return { step, reset, actual, can, recent, spoken, percent };
}
