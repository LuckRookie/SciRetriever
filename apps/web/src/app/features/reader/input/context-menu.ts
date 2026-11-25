import type { CommandId } from "./commands.js";

/**
 * The reading area's context menu (reading-experience 1.8.2): what was
 * right-clicked, which operations its menu lists, and where it opens.
 */
export type MenuTarget =
  | { kind: "selection"; text: string; rect: DOMRect | null }
  | { kind: "mark"; id: string }
  | { kind: "link"; element: HTMLAnchorElement; internal: boolean }
  | { kind: "figure"; element: HTMLImageElement }
  | { kind: "table"; element: HTMLTableElement }
  | { kind: "formula"; element: HTMLElement; tex: string }
  | { kind: "block"; element: HTMLElement }
  | { kind: "pdf-page"; page: number; element: HTMLElement }
  | { kind: "blank" };

/** Where the browser keeps its own menu: fields and editable areas. */
const FIELDS =
  "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']";
/** Inside the desk: the sheet, PDF pages, the spine and the desk around them. */
export const DESK = ".reader-surface";
const LINK = "a[href]";
const BLOCK = "[data-byte-start]";

export interface TargetProbe {
  /** The element under the pointer, or the focused one for the keyboard. */
  element: Element | null;
  x: number;
  y: number;
  /** The selection's rectangles, when it lies in the reading area. */
  selection: { text: string; rects: readonly DOMRect[] } | null;
  /** The mark drawn under this point, if any. */
  markAt: (x: number, y: number) => string | null;
}
const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
/** The source text KaTeX rendered a formula from. */
export function formulaSource(element: Element): string {
  return (
    element
      .querySelector('annotation[encoding="application/x-tex"]')
      ?.textContent?.trim() ?? ""
  );
}
/**
 * Spec 1.8.2 “目标的判定顺序”: fields and anything outside the reading area
 * keep the browser's menu (null); within the selection, the selected text;
 * then a mark, a link, a figure, table or formula, any other block, a PDF
 * page; else the blank desk.
 */
export function menuTarget(probe: TargetProbe): MenuTarget | null {
  const el = probe.element;
  if (!el || el.closest(FIELDS) || !el.closest(DESK)) return null;
  if (
    probe.selection &&
    probe.selection.rects.some((r) => inside(r, probe.x, probe.y))
  )
    return {
      kind: "selection",
      text: probe.selection.text,
      rect: probe.selection.rects.at(-1) ?? null,
    };
  const markElement = el.closest<HTMLElement>(
    ".mark-note[data-id], .mark-region[data-id], .mark-highlight[data-id]",
  );
  const mark = markElement?.dataset.id ?? probe.markAt(probe.x, probe.y);
  if (mark) return { kind: "mark", id: mark };
  const link = el.closest<HTMLAnchorElement>(LINK);
  if (link)
    return {
      kind: "link",
      element: link,
      internal: link.hasAttribute("data-reading-fragment"),
    };
  const figure =
    el.tagName === "IMG"
      ? el
      : el.closest(".reading-resource")?.querySelector("img");
  if (figure) return { kind: "figure", element: figure as HTMLImageElement };
  const formula = el.closest<HTMLElement>(".katex");
  if (formula) {
    const tex = formulaSource(formula);
    if (tex) return { kind: "formula", element: formula, tex };
  }
  const table = el.closest("table");
  if (table) return { kind: "table", element: table as HTMLTableElement };
  const block = el.closest<HTMLElement>(BLOCK);
  if (block) return { kind: "block", element: block };
  const page = el.closest<HTMLElement>("[data-pdf-page]");
  if (page)
    return {
      kind: "pdf-page",
      page: Number(page.dataset.pdfPage),
      element: page,
    };
  return { kind: "blank" };
}

/** An entry of the menu: an operation, or a hairline between the parts. */
export type MenuEntry = CommandId | ObjectAction | "-";
/** Operations that belong to the object right-clicked, not to the reader's table. */
export type ObjectAction =
  | "copy"
  | "translate"
  | "find-selection"
  | "jump-link"
  | "open-link"
  | "copy-link"
  | "copy-block"
  | "cite-block"
  | "translate-block"
  | "zoom-image"
  | "copy-image"
  | "save-image"
  | "copy-table"
  | "copy-latex"
  | "other-view"
  | "scale";
export const OBJECT_LABELS: Record<ObjectAction, string> = {
  copy: "复制",
  translate: "翻译",
  "find-selection": "查找选中文字",
  "jump-link": "跳到此处",
  "open-link": "打开链接",
  "copy-link": "复制链接地址",
  "copy-block": "复制本段",
  "cite-block": "复制本段为引用",
  "translate-block": "翻译本段",
  "zoom-image": "放大查看",
  "copy-image": "复制图片",
  "save-image": "保存图片",
  "copy-table": "复制表格",
  "copy-latex": "复制 LaTeX",
  "other-view": "在 PDF 中查看此处",
  scale: "比例",
};
/** Keys written beside an object's operation, as the browser has them. */
export const OBJECT_KEYS: Partial<Record<ObjectAction, string>> = {
  copy: "Ctrl+C",
};
/** What the reader and the paper offer here; an absent one leaves its entry out. */
export interface MenuAbilities {
  view: "doc" | "pdf";
  /** The paper can be marked here (not from a fixed source). */
  canMark: boolean;
  canTranslate: boolean;
  /** “翻译本段”: a translation service, or the library's translation of the paper. */
  canTranslateBlock?: boolean;
  /** The other view exists (the paper has a PDF, or a full text). */
  otherView: boolean;
  /** The selection lies in one block and is at most 80 characters. */
  findable: boolean;
}
/** The three parts of spec 1.8.2: the object's, the reading part, the paper part. */
export function menuEntries(
  target: MenuTarget,
  can: MenuAbilities,
): MenuEntry[] {
  const object: MenuEntry[] = (() => {
    switch (target.kind) {
      case "selection":
        return [
          "copy",
          "cite",
          ...(can.canMark ? (["mark-color", "note"] as const) : []),
          ...(can.canTranslate ? (["translate"] as const) : []),
          ...(can.findable ? (["find-selection"] as const) : []),
        ];
      case "mark":
        return ["note", "mark-color", "cite", "mark-delete"];
      case "link":
        return target.internal ? ["jump-link"] : ["open-link", "copy-link"];
      case "figure":
        return ["zoom-image", "copy-image", "save-image"];
      case "table":
        return ["copy-table"];
      case "formula":
        return ["copy-latex"];
      case "block":
        return [
          "copy-block",
          "cite-block",
          ...((can.canTranslateBlock ?? can.canTranslate)
            ? (["translate-block"] as const)
            : []),
        ];
      case "pdf-page":
        return ["go-page", ...(can.canMark ? (["tool-region"] as const) : [])];
      case "blank":
        return [];
    }
  })();
  // Selected text, marks and links have their own part only.
  if (
    target.kind === "selection" ||
    target.kind === "mark" ||
    target.kind === "link"
  )
    return object;
  const reading: MenuEntry[] = [
    "back",
    ...(can.otherView ? (["other-view"] as const) : []),
    "find",
    "outline",
    "scale",
    "focus",
  ];
  const paper: MenuEntry[] = ["tab-close", "tab-close-others", "tab-close-all"];
  return [
    ...object,
    ...(object.length ? ["-" as const] : []),
    ...reading,
    "-",
    ...paper,
  ];
}

/** Spec 1.8.2 “位置”: down and right from the point, turned where it does not fit. */
export function menuPosition(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
) {
  let left = point.x;
  if (left + size.width > viewport.width - margin) left = point.x - size.width;
  left = Math.max(margin, Math.min(left, viewport.width - margin - size.width));
  let top = point.y,
    height = size.height;
  if (top + height > viewport.height - margin) {
    if (point.y - height >= margin) top = point.y - height;
    else {
      // Neither way fits: along the viewport's edges, scrolling inside.
      top = margin;
      height = Math.min(height, viewport.height - 2 * margin);
    }
  }
  return { left, top, maxHeight: height };
}
/** Carried text longer than 16 characters is cut with an ellipsis (spec 1.8.2). */
export const carried = (text: string) => {
  const chars = [...text.replace(/\s+/gu, " ").trim()];
  return chars.length > 16 ? `${chars.slice(0, 16).join("")}…` : chars.join("");
};
