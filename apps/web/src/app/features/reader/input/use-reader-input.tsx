import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { copyText } from "../../../../browser-platform.js";
import type { MenuOption } from "../../../components/index.js";
import type { ReaderFrame, PdfControls } from "../../../../reading/contract.js";
import { readingArea, readingLine } from "../../../../reading/anchor.js";
import {
  MARK_COLORS,
  MARK_COLOR_LABELS,
  type MarkColor,
} from "@sciretriever/contracts";
import {
  chordText,
  commandItem,
  commandKeys,
  dispatchKey,
  focusPlace,
  type CommandId,
  type CommandTable,
  type ReaderCommand,
} from "./commands.js";
import {
  OBJECT_KEYS,
  OBJECT_LABELS,
  carried,
  menuEntries,
  menuTarget,
  type MenuAbilities,
  type MenuTarget,
  type ObjectAction,
} from "./context-menu.js";
import { ContextMenu, type ContextMenuRequest } from "./ContextMenu.js";
import { ShortcutsDialog } from "./ShortcutsDialog.js";

/** The marks' side of the context menu (`useReaderMarks().menu`). */
export interface MarksMenu {
  selection(): {
    quote: string;
    pdf: { page: number } | null;
    anchor: DOMRect;
  } | null;
  markAt(event: MouseEvent): string | null;
  choose(markId: string): void;
  mark(markId: string): { color: MarkColor; note: string } | undefined;
  highlight(color: MarkColor): unknown;
  noteOnSelection(): void;
  citeSelection(): void;
  citeMark(markId: string): void;
  note(markId: string): void;
  recolor(markId: string, color: MarkColor): void;
  remove(markId: string): void;
  setMenuOpen(open: boolean): void;
  /** Closes the note, the selection bar or the translation popup; false when none is open. */
  escape(): boolean;
}
export interface ReaderInputBindings {
  /** The reader's operations, as built on its latest render. */
  table: RefObject<CommandTable>;
  body: HTMLElement | null;
  desk: HTMLElement | null;
  header: HTMLElement | null;
  view: "doc" | "pdf" | null;
  frame: RefObject<ReaderFrame | null>;
  pdf: PdfControls | null;
  marks: MarksMenu | null;
  abilities: Omit<MenuAbilities, "view" | "findable">;
  /** A jump back exists (spec 4.4): “返回上一位置” shows. */
  canGoBack(): boolean;
  back(): boolean;
  forward(): boolean;
  /** Esc after the marks: the reader's own layers, top first (spec 1.8.6). */
  escape(): boolean;
  notify(message: string): void;
  cite(quote: string, page: number | null): void;
  translate(text: string, page: number | null): void;
  find(text: string): void;
  zoomImage(src: string, alt: string): void;
  /** Shows the other view at this point (spec 4.3), not a jump. */
  otherView(): void;
  animate(): boolean;
}

/**
 * The reader's keys, context menu and shortcut list (reading-experience
 * 1.8): one key handler reads the table of operations; the context menu
 * lists the operations of what was right-clicked; the keys scroll the
 * reading area without a click first.
 */
export function useReaderInput() {
  // Bound on each render once the reader has its paper (`bind`); read in handlers.
  const now = useRef<ReaderInputBindings>(null!);
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  const opened = useRef(false);
  opened.current = !!request;
  const [shortcuts, setShortcuts] = useState(false);
  const scrolling = useRef<{
    frame: number;
    top: number;
    left: number;
  } | null>(null);

  /** Scrolls the reading area; a held key goes straight there (spec 1.8.4). */
  const scrollBy = (dy: number, dx: number, repeat: boolean) => {
    const body = now.current.body;
    if (!body) return;
    const glide = scrolling.current;
    const top = Math.max(
        0,
        Math.min(
          body.scrollHeight - body.clientHeight,
          (glide?.top ?? body.scrollTop) + dy,
        ),
      ),
      left = Math.max(
        0,
        Math.min(
          body.scrollWidth - body.clientWidth,
          (glide?.left ?? body.scrollLeft) + dx,
        ),
      );
    if (glide) cancelAnimationFrame(glide.frame);
    scrolling.current = null;
    if (repeat || !now.current.animate()) {
      body.scrollTop = top;
      body.scrollLeft = left;
      return;
    }
    const fromTop = body.scrollTop,
      fromLeft = body.scrollLeft,
      start = performance.now(),
      ms =
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--dur-3",
          ),
        ) || 240;
    const tick = (time: number) => {
      const t = Math.min(1, (time - start) / ms),
        eased = 1 - (1 - t) ** 3;
      body.scrollTop = fromTop + (top - fromTop) * eased;
      body.scrollLeft = fromLeft + (left - fromLeft) * eased;
      if (t < 1 && scrolling.current)
        scrolling.current.frame = requestAnimationFrame(tick);
      else scrolling.current = null;
    };
    scrolling.current = { frame: requestAnimationFrame(tick), top, left };
  };
  const area = () => {
    const body = now.current.body;
    return body
      ? readingArea(body, now.current.header ?? undefined)
      : { top: 0, height: 0 };
  };
  /** One screen: 90% of the visible height below the page header's rule. */
  const screen = () => area().height * 0.9;
  const lastPart = useRef(0);
  const scroll = {
    page: (step: 1 | -1, repeat: boolean) =>
      scrollBy(step * screen(), 0, repeat),
    line: (step: 1 | -1, repeat: boolean) => scrollBy(step * 64, 0, repeat),
    side: (step: 1 | -1, repeat: boolean) => {
      const body = now.current.body;
      // Only a page column wider than the desk scrolls across.
      if (!body || body.scrollWidth <= body.clientWidth + 1) return false;
      scrollBy(0, step * 64, repeat);
    },
    /** Home and End are jumps (spec 4.4). */
    edge: (end: boolean) => {
      const t = now.current;
      t.frame.current?.beforeJump?.();
      if (t.view === "pdf" && t.pdf) {
        t.pdf.go(end ? t.pdf.total : 1);
        return;
      }
      const body = t.body;
      if (body) body.scrollTop = end ? body.scrollHeight : 0;
    },
    /**
     * Alt+↓/↑: the next or previous section's heading onto the reading line,
     * or the next page's top under the rule. Pressed in a row, one jump.
     */
    part: (step: 1 | -1) => {
      const t = now.current,
        at = performance.now();
      if (at - lastPart.current > 1500) t.frame.current?.beforeJump?.();
      lastPart.current = at;
      if (t.view === "pdf" && t.pdf) {
        const page = Math.max(1, Math.min(t.pdf.total, t.pdf.page + step));
        t.pdf.go(page);
        return;
      }
      const body = t.body;
      if (!body) return;
      const line = readingLine(area());
      const headings = [
        ...body.querySelectorAll<HTMLElement>(
          ".reader-engine:not([hidden]) .reader-view:not([hidden]) :is(h1, h2, h3, h4, h5, h6)",
        ),
      ];
      const tops = headings.map((h) => h.getBoundingClientRect().top);
      let index = -1;
      if (step > 0) index = tops.findIndex((top) => top > line + 1);
      else
        for (let i = tops.length - 1; i >= 0 && index < 0; i--)
          if (tops[i]! < line - 1) index = i;
      if (index >= 0) body.scrollTop += tops[index]! - line;
      else body.scrollTop = step > 0 ? body.scrollHeight : 0;
    },
  };

  // The reader's keys: one listener, the table decides (spec 1.8.7).
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const t = now.current;
      if (!t) return;
      if (
        event.key === "Escape" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        // Menus and popovers close themselves first; then one layer per Esc.
        if (opened.current && !focusPlace(event.target).menu) {
          event.preventDefault();
          close();
          return;
        }
        if (
          document.querySelector(".ui-popover, .ui-overlay") ||
          focusPlace(event.target).field
        )
          return;
        if (t.marks?.escape() || t.escape()) event.preventDefault();
        return;
      }
      const table = t.table.current;
      if (table && dispatchKey(table, event)) event.preventDefault();
    };
    // Capture: a focused control (a menu's button) must not swallow them.
    addEventListener("keydown", keys, true);
    return () => removeEventListener("keydown", keys, true);
  }, []);

  // The mouse's back and forward buttons (spec 1.8.4): a jump back or forward
  // when there is one; else the browser's. Not offered where it cannot be held.
  useEffect(() => {
    if (/firefox\//iu.test(navigator.userAgent)) return;
    let taken = false;
    const down = (event: MouseEvent) => {
      if ((event.button !== 3 && event.button !== 4) || !now.current) return;
      taken = event.button === 3 ? now.current.back() : now.current.forward();
      if (taken) event.preventDefault();
    };
    const up = (event: MouseEvent) => {
      if ((event.button === 3 || event.button === 4) && taken) {
        event.preventDefault();
        taken = false;
      }
    };
    addEventListener("mousedown", down, true);
    addEventListener("mouseup", up, true);
    addEventListener("auxclick", up, true);
    return () => {
      removeEventListener("mousedown", down, true);
      removeEventListener("mouseup", up, true);
      removeEventListener("auxclick", up, true);
    };
  }, []);

  /** The operation `id` with this menu's way of acting, when the reader has it. */
  const command = (
    id: CommandId,
    more: Partial<ReaderCommand> = {},
  ): ReaderCommand | null => {
    const found = now.current.table.current?.get(id);
    return found ? { ...found, ...more } : null;
  };
  const colours = (
    current: MarkColor | null,
    pick: (color: MarkColor) => void,
  ): MenuOption[] =>
    MARK_COLORS.map((color, index) => ({
      id: `color-${color}`,
      label: MARK_COLOR_LABELS[color],
      shortcut: String(index + 1),
      ...(current === color ? { checked: true } : {}),
      onAction: () => pick(color),
    }));
  const objectItem = (
    action: ObjectAction,
    target: MenuTarget,
    selectionPage: number | null,
  ): MenuOption | null => {
    const t = now.current;
    const done = (message: string) => () => t.notify(message);
    const failed = () => t.notify("浏览器未允许写入剪贴板。");
    const run = (): void => {
      switch (action) {
        case "copy":
          if (target.kind === "selection")
            void copyText(target.text).catch(failed);
          return;
        case "translate":
          if (target.kind === "selection")
            t.translate(target.text, selectionPage);
          return;
        case "find-selection":
          if (target.kind === "selection") t.find(target.text);
          return;
        case "jump-link":
          if (target.kind === "link") target.element.click();
          return;
        case "open-link":
          if (target.kind === "link")
            window.open(target.element.href, "_blank", "noopener,noreferrer");
          return;
        case "copy-link":
          if (target.kind === "link")
            void copyText(target.element.href)
              .then(done("已复制链接地址"))
              .catch(failed);
          return;
        case "copy-block":
        case "cite-block":
        case "translate-block": {
          if (target.kind !== "block") return;
          const text = (target.element.innerText || "").trim();
          const page = Number(target.element.dataset.page) || null;
          if (action === "copy-block")
            void copyText(text).then(done("已复制本段")).catch(failed);
          else if (action === "cite-block") t.cite(text, page);
          else t.translate(text, page);
          return;
        }
        case "zoom-image":
          if (target.kind === "figure")
            t.zoomImage(target.element.src, target.element.alt);
          return;
        case "copy-image":
          if (target.kind === "figure")
            void copyImage(target.element)
              .then(done("已复制图片"))
              .catch(failed);
          return;
        case "save-image":
          if (target.kind === "figure") saveImage(target.element);
          return;
        case "copy-table":
          if (target.kind === "table")
            void copyTable(target.element)
              .then(done("已复制表格"))
              .catch(failed);
          return;
        case "copy-latex":
          if (target.kind === "formula")
            void copyText(target.tex).then(done("已复制 LaTeX")).catch(failed);
          return;
        case "other-view":
          placeAtLine(target);
          t.otherView();
          return;
        case "scale":
          return;
      }
    };
    if (action === "scale") {
      const items = (["zoom-in", "zoom-out", "zoom-reset"] as const).flatMap(
        (id) => {
          const c = command(id);
          return c ? [commandItem(c)] : [];
        },
      );
      return items.length
        ? {
            id: "scale",
            label: OBJECT_LABELS.scale,
            onAction: () => {},
            submenu: items,
          }
        : null;
    }
    const label =
      action === "other-view"
        ? t.view === "pdf"
          ? "在原文中查看此处"
          : "在 PDF 中查看此处"
        : OBJECT_LABELS[action];
    // The browser's own copy key, as this system writes it.
    const keys =
      action === "copy"
        ? chordText({ mod: true, label: "C" })
        : OBJECT_KEYS[action];
    return {
      id: action,
      label,
      ...(keys ? { shortcut: keys } : {}),
      onAction: run,
    };
  };
  /** Puts the right-clicked block or page point on the reading line, then measures there. */
  const placeAtLine = (target: MenuTarget) => {
    const t = now.current,
      body = t.body,
      frame = t.frame.current;
    if (!body || !frame) return;
    const line = readingLine(area());
    const top =
      target.kind === "block"
        ? target.element.getBoundingClientRect().top
        : target.kind === "pdf-page"
          ? (request?.y ?? line)
          : line;
    body.scrollTop += top - line;
    frame.holdPoint?.({ x: 0, y: line });
    frame.holdPoint?.(null);
  };
  /** The menu for `target`: its object's part, then the reading and paper parts. */
  const itemsFor = (target: MenuTarget): MenuOption[] => {
    const t = now.current,
      marks = t.marks;
    const selection = target.kind === "selection" ? marks?.selection() : null;
    const findable =
      target.kind === "selection" &&
      [...target.text].length <= 80 &&
      !/\n/u.test(target.text.trim());
    const entries = menuEntries(target, {
      ...t.abilities,
      view: t.view ?? "doc",
      findable,
    });
    const items: MenuOption[] = [];
    let divider = false;
    for (const entry of entries) {
      if (entry === "-") {
        divider = items.length > 0;
        continue;
      }
      let item: MenuOption | null = null;
      if (entry in OBJECT_LABELS)
        item = objectItem(
          entry as ObjectAction,
          target,
          selection?.pdf?.page ?? null,
        );
      else {
        const id = entry as CommandId;
        const markId = target.kind === "mark" ? target.id : null;
        const mark = markId ? marks?.mark(markId) : undefined;
        let c: ReaderCommand | null = null;
        if (id === "back") c = t.canGoBack() ? command(id) : null;
        else if (id === "note" && marks)
          c = command(id, {
            enabled: true,
            label: mark?.note.trim() ? "编辑笔记" : "写笔记",
            run: () => (markId ? marks.note(markId) : marks.noteOnSelection()),
          });
        else if (id === "cite" && marks)
          c = command(id, {
            enabled: true,
            run: () =>
              markId ? marks.citeMark(markId) : marks.citeSelection(),
          });
        else if (id === "mark-color" && marks)
          c = command(id, {
            label: markId ? "更改颜色" : "划线",
            submenu: colours(mark?.color ?? null, (color) =>
              markId ? marks.recolor(markId, color) : marks.highlight(color),
            ),
          });
        else if (id === "mark-delete" && marks && markId)
          c = command(id, { enabled: true, run: () => marks.remove(markId) });
        else c = command(id);
        if (c) item = commandItem(c);
      }
      if (!item) continue;
      if (divider) item = { ...item, divider: true };
      divider = false;
      items.push(item);
    }
    return items;
  };
  const open = (
    target: MenuTarget,
    x: number,
    y: number,
    keyboard: boolean,
  ) => {
    const items = itemsFor(target);
    if (!items.length) return;
    now.current.marks?.setMenuOpen(true);
    setRequest({ x, y, keyboard, label: "阅读区菜单", items });
  };
  /** The selection in the reading area, if any (spec 1.8.2). */
  const readSelection = () => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return null;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el?.closest(".reader-surface")) return null;
    return {
      text: selection.toString(),
      rects: [...range.getClientRects()],
    };
  };
  const probe = (event: MouseEvent, element: Element | null) => {
    const t = now.current;
    const target = menuTarget({
      element,
      x: event.clientX,
      y: event.clientY,
      selection: readSelection(),
      markAt: () => t.marks?.markAt(event) ?? null,
    });
    if (target?.kind === "mark") t.marks?.choose(target.id);
    return target;
  };
  /** A right-click in the reading area (spec 1.8.2); Shift+right-click is the browser's. */
  const onContextMenu = (event: ReactMouseEvent) => {
    if (event.shiftKey) return;
    const target = probe(event.nativeEvent, event.target as Element);
    if (!target) return;
    event.preventDefault();
    open(target, event.clientX, event.clientY, false);
  };
  /** Shift+F10 or the menu key: the tab, the selection, the focused object, or the reading line. */
  const openByKeyboard = (tabs: {
    openMenu(on: string, x: number, y: number, keyboard: boolean): void;
  }) => {
    const focused = document.activeElement;
    const tab = focused?.closest<HTMLElement>("[data-paper-tab]");
    if (tab?.dataset.paperTab) {
      const r = tab.getBoundingClientRect();
      tabs.openMenu(tab.dataset.paperTab, r.left, r.bottom + 4, true);
      return;
    }
    const selection = readSelection();
    if (selection?.rects.length) {
      const last = selection.rects.at(-1)!;
      open(
        { kind: "selection", text: selection.text, rect: last },
        last.left,
        last.bottom + 4,
        true,
      );
      return;
    }
    if (focused && focused.closest(".reader-surface")) {
      const target = menuTarget({
        element: focused,
        x: -1,
        y: -1,
        selection: null,
        markAt: () => null,
      });
      if (target && target.kind !== "blank" && "element" in target) {
        const r = target.element.getBoundingClientRect();
        open(target, r.left, r.bottom + 4, true);
        return;
      }
    }
    const t = now.current,
      body = t.body;
    if (!body) return;
    const line = readingLine(area());
    const column = body.querySelector<HTMLElement>(
      ".reader-engine:not([hidden]) .reader-view:not([hidden]) :is(.reading-article, .reading-pdf-pages)",
    );
    const left =
      column?.getBoundingClientRect().left ?? body.getBoundingClientRect().left;
    const element =
      document
        .elementsFromPoint(left + 24, line)
        .find((el) => el.closest(".reader-surface")) ?? null;
    const target =
      menuTarget({
        element,
        x: left + 24,
        y: line,
        selection: null,
        markAt: () => null,
      }) ?? ({ kind: "blank" } as const);
    open(target, left, line, true);
  };
  const close = () => {
    setRequest(null);
    now.current?.marks?.setMenuOpen(false);
  };
  const contextMenu: ReactNode = (
    <ContextMenu
      request={request}
      onClose={close}
      onRetarget={(event, element) => {
        const target = probe(event, element);
        if (!target) return close();
        open(target, event.clientX, event.clientY, false);
      }}
    />
  );
  const shortcutsDialog: ReactNode = (
    <ShortcutsDialog
      isOpen={shortcuts && !!now.current}
      onClose={() => setShortcuts(false)}
      table={now.current?.table.current ?? null}
      view={now.current?.view ?? null}
      canMark={!!now.current?.abilities.canMark}
    />
  );
  return {
    /** The reader's current state, set on every render that has a paper. */
    bind: (b: ReaderInputBindings) => {
      now.current = b;
    },
    scroll,
    contextMenu,
    shortcutsDialog,
    onContextMenu,
    openByKeyboard,
    closeMenu: close,
    menuOpen: !!request,
    openShortcuts: () => setShortcuts(true),
    keysOf: commandKeys,
    carried,
  };
}

async function copyImage(image: HTMLImageElement) {
  // The verified picture already shown: its object URL, not a new download.
  const blob = await (await fetch(image.src)).blob();
  let png = blob;
  if (blob.type !== "image/png") {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("image"))),
        "image/png",
      ),
    );
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
function saveImage(image: HTMLImageElement) {
  const a = document.createElement("a");
  a.href = image.src;
  const name = (image.alt || "image").replace(/[\\/:*?"<>|]+/gu, " ").trim();
  a.download = name || "image";
  a.click();
}
/** Tab-separated text and the table itself (spec 1.8.2). */
export function tableText(table: HTMLTableElement): string {
  return [...table.rows]
    .map((row) =>
      [...row.cells]
        .map((cell) =>
          (cell.innerText || cell.textContent || "")
            .replace(/\s+/gu, " ")
            .trim(),
        )
        .join("\t"),
    )
    .join("\n");
}
async function copyTable(table: HTMLTableElement) {
  const text = tableText(table);
  if (typeof ClipboardItem === "undefined") return copyText(text);
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([table.outerHTML], { type: "text/html" }),
    }),
  ]);
}
