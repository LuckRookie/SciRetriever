import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export interface DesignControlAudit {
  tag: string;
  role: string;
  label: string;
  className: string;
  disabled: boolean;
  selected: boolean;
  pending: boolean;
  width: number;
  height: number;
  font: { family: string; size: string; weight: string; lineHeight: string };
  radius: readonly string[];
  border: {
    width: readonly string[];
    style: readonly string[];
    color: readonly string[];
    contrast: readonly (number | null)[];
  };
  padding: readonly string[];
  transition: { property: string; duration: string; timing: string };
  foreground: string;
  background: string;
  textContrast: number | null;
  contrastTarget: number;
  outline: {
    style: string;
    width: string;
    offset: string;
    color: string;
    contrast: number | null;
  };
  shadow: string;
  focusVisible: boolean;
}
export interface DesignAudit {
  page: string;
  viewport: { width: number; height: number };
  scrollWidth: number;
  theme: string;
  reducedMotion: boolean;
  platform: string;
  browser: string;
  runtimeStyleElements: number;
  fonts: { body: string; heading: string | null };
  fontFaces: readonly { family: string; status: string }[];
  sampled: number;
  truncated: boolean;
  controls: readonly DesignControlAudit[];
}
/** Reusable computed-style evidence for both DOM baseline and React pages. No interaction or writes. */
export async function collectDesignAudit(
  page: Page,
  options: { root?: string; limit?: number } = {},
): Promise<DesignAudit> {
  return page.evaluate(
    ({ root, limit }) => {
      type Color = [number, number, number, number];
      const rgba = (value: string): Color | null => {
        const match = /^rgba?\(([^)]+)\)$/u.exec(value);
        if (!match) return null;
        const channels = match[1]!
          .split(/[,\s/]+/u)
          .filter(Boolean)
          .map(Number);
        if (
          channels.length < 3 ||
          channels.some((value) => !Number.isFinite(value))
        )
          return null;
        return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1];
      };
      const over = (front: Color, back: Color): Color => [
        front[0] * front[3] + back[0] * (1 - front[3]),
        front[1] * front[3] + back[1] * (1 - front[3]),
        front[2] * front[3] + back[2] * (1 - front[3]),
        1,
      ];
      const luminance = (value: Color) =>
        value
          .slice(0, 3)
          .map((channel) => {
            const linear = channel / 255;
            return linear <= 0.04045
              ? linear / 12.92
              : ((linear + 0.055) / 1.055) ** 2.4;
          })
          .reduce(
            (total, value, index) =>
              total + value * [0.2126, 0.7152, 0.0722][index]!,
            0,
          );
      const contrast = (front: Color | null, back: Color | null) => {
        if (!front || !back) return null;
        const a = luminance(over(front, back)),
          b = luminance(back);
        return (
          Math.round(
            ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100,
          ) / 100
        );
      };
      const background = (element: Element): Color => {
        const colors: Color[] = [];
        let current: Element | null = element;
        while (current) {
          const value = rgba(getComputedStyle(current).backgroundColor);
          if (value) {
            colors.push(value);
            if (value[3] === 1) break;
          }
          current = current.parentElement;
        }
        return colors
          .reverse()
          .reduce((back, front) => over(front, back), [
            255, 255, 255, 1,
          ] as Color);
      };
      const host = root ? document.querySelector(root) : document.body;
      if (!host) throw new Error("Design audit root not found");
      const elements = [
        ...host.querySelectorAll<HTMLElement>(
          "button,input:not([type=hidden]),select,textarea,a[href],[role=button],[role=tab],[role=checkbox],[role=switch],[role=separator],[role=menuitem]",
        ),
      ].filter((element) => {
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0" &&
          !element.closest('[hidden],[inert],[aria-hidden="true"]')
        );
      });
      const controls = elements.slice(0, limit).map((element) => {
        const style = getComputedStyle(element),
          rect = element.getBoundingClientRect(),
          back = background(element),
          foreground = rgba(style.color);
        const labelled = (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/u)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
        const label =
          element.getAttribute("aria-label") ||
          labelled ||
          element.textContent ||
          element.getAttribute("placeholder") ||
          "";
        const large =
          parseFloat(style.fontSize) >= 24 ||
          (parseFloat(style.fontSize) >= 18.66 &&
            Number(style.fontWeight) >= 700);
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
          label: label.trim().replace(/\s+/gu, " ").slice(0, 160),
          className: element.className,
          disabled: element.matches(
            ":disabled,[aria-disabled=true],[data-disabled=true]",
          ),
          selected: element.matches(
            "[aria-selected=true],[data-selected=true],[aria-checked=true]",
          ),
          pending:
            element.hasAttribute("data-pending") ||
            element.getAttribute("aria-busy") === "true",
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
          font: {
            family: style.fontFamily,
            size: style.fontSize,
            weight: style.fontWeight,
            lineHeight: style.lineHeight,
          },
          radius: [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ],
          border: {
            width: [
              style.borderTopWidth,
              style.borderRightWidth,
              style.borderBottomWidth,
              style.borderLeftWidth,
            ],
            style: [
              style.borderTopStyle,
              style.borderRightStyle,
              style.borderBottomStyle,
              style.borderLeftStyle,
            ],
            color: [
              style.borderTopColor,
              style.borderRightColor,
              style.borderBottomColor,
              style.borderLeftColor,
            ],
            contrast: [
              [
                style.borderTopWidth,
                style.borderTopStyle,
                style.borderTopColor,
              ],
              [
                style.borderRightWidth,
                style.borderRightStyle,
                style.borderRightColor,
              ],
              [
                style.borderBottomWidth,
                style.borderBottomStyle,
                style.borderBottomColor,
              ],
              [
                style.borderLeftWidth,
                style.borderLeftStyle,
                style.borderLeftColor,
              ],
            ].map(([width, borderStyle, color]) => {
              const parsed = rgba(color!);
              return parseFloat(width!) > 0 &&
                borderStyle !== "none" &&
                parsed &&
                parsed[3] > 0
                ? contrast(parsed, background(element.parentElement ?? element))
                : null;
            }),
          },
          padding: [
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ],
          transition: {
            property: style.transitionProperty,
            duration: style.transitionDuration,
            timing: style.transitionTimingFunction,
          },
          foreground: style.color,
          background: `rgb(${back.slice(0, 3).map(Math.round).join(", ")})`,
          textContrast: contrast(foreground, back),
          contrastTarget: large ? 3 : 4.5,
          outline: {
            style: style.outlineStyle,
            width: style.outlineWidth,
            offset: style.outlineOffset,
            color: style.outlineColor,
            contrast:
              style.outlineStyle === "none"
                ? null
                : contrast(rgba(style.outlineColor), back),
          },
          shadow: style.boxShadow,
          focusVisible: element.matches(
            ":focus-visible,[data-focus-visible=true]",
          ),
        };
      });
      const heading = host.querySelector("h1,h2");
      return {
        page: location.pathname + location.search,
        viewport: { width: innerWidth, height: innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme ?? "light",
        reducedMotion:
          matchMedia("(prefers-reduced-motion: reduce)").matches ||
          document.documentElement.dataset.reducedMotion === "true",
        platform: navigator.platform,
        browser: navigator.userAgent,
        runtimeStyleElements: document.querySelectorAll("style").length,
        fonts: {
          body: getComputedStyle(document.body).fontFamily,
          heading: heading ? getComputedStyle(heading).fontFamily : null,
        },
        fontFaces: [...document.fonts].map((face) => ({
          family: face.family,
          status: face.status,
        })),
        sampled: controls.length,
        truncated: elements.length > limit,
        controls,
      };
    },
    { root: options.root ?? null, limit: options.limit ?? 350 },
  );
}
export async function writeDesignAudit(
  page: Page,
  directory: string,
  name: string,
  options: { root?: string; limit?: number } = {},
) {
  await mkdir(directory, { recursive: true });
  const audit = await collectDesignAudit(page, options);
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify(audit, null, 2) + "\n",
  );
  return audit;
}
/** Reports low contrast as review candidates; disabled controls are not contrast failures. */
export function designAuditFindings(audit: DesignAudit) {
  return {
    horizontalOverflow: audit.scrollWidth > audit.viewport.width,
    runtimeStyleElements: audit.runtimeStyleElements,
    lowTextContrast: audit.controls
      .filter(
        (control) =>
          !control.disabled &&
          control.textContrast !== null &&
          control.textContrast < control.contrastTarget,
      )
      .map((control) => ({
        label: control.label,
        contrast: control.textContrast,
        target: control.contrastTarget,
      })),
    lowFocusContrast: audit.controls
      .filter(
        (control) =>
          control.focusVisible &&
          control.outline.contrast !== null &&
          control.outline.contrast < 3,
      )
      .map((control) => ({
        label: control.label,
        contrast: control.outline.contrast,
      })),
    radii: [
      ...new Set(audit.controls.flatMap((control) => control.radius)),
    ].sort(),
    heights: [
      ...new Set(
        audit.controls
          .filter(
            (control) => control.tag === "button" || control.role === "button",
          )
          .map((control) => control.height),
      ),
    ].sort((a, b) => a - b),
  };
}
