import glyphs from "virtual:interface-glyphs";

/**
 * The CJK faces are cut into unicode-range slices. Each slice that arrives
 * makes the browser re-shape the whole page, which made every first visit to
 * a section wait on layout. Interface copy needs about 20 slices per face:
 * load them once while the shell is idle.
 */
export function warmInterfaceFonts(): void {
  if (!glyphs || typeof document === "undefined" || !document.fonts) return;
  for (const font of ['15px "Noto Sans SC"', '600 28px "Noto Serif SC"'])
    void document.fonts.load(font, glyphs).catch(() => undefined);
}
