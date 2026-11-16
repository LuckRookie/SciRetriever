/**
 * Spec “reading experience” 8.1, the reader's keyboard and mouse (1.8): the
 * reading scale's arithmetic, the context menu's target and parts, the table
 * of operations, and the paper tabs. No browser.
 */
import { describe, expect, it } from "vitest";
import {
  canStepPdf,
  pdfZoom,
  pinchFactor,
  pinchPdf,
  pinchText,
  stepPdf,
  stepText,
  textSize,
  wheelCount,
  wheelKind,
  wheelSteps,
} from "../src/app/features/reader/input/scale.js";
import {
  menuEntries,
  menuPosition,
  menuTarget,
  type MenuAbilities,
} from "../src/app/features/reader/input/context-menu.js";
import {
  COMMANDS,
  COMMAND_IDS,
  chordText,
  commandItem,
  commandKeys,
  commandTable,
  type CommandId,
  type KeyChord,
} from "../src/app/features/reader/input/commands.js";
import { shortcutRows } from "../src/app/features/reader/input/ShortcutsDialog.js";
import {
  CLOSED_LIMIT,
  currentAfterClose,
  cycleTab,
  keepUnsaved,
  loadTabs,
  recordClose,
  reopenTabs,
  saveTabs,
  tabsToClose,
  type PaperTab,
} from "../src/app/shell/paper-tabs.js";

describe("reading scale (spec 1.8.1)", () => {
  it("counts wheel notches by delta mode: 100 px, 3 lines, one page", () => {
    expect(wheelSteps(wheelCount(), { deltaY: -100, deltaMode: 0 }, 0)).toBe(1);
    expect(wheelSteps(wheelCount(), { deltaY: -3, deltaMode: 1 }, 0)).toBe(1);
    expect(wheelSteps(wheelCount(), { deltaY: 1, deltaMode: 2 }, 0)).toBe(-1);
  });
  it("adds notches up and keeps the remainder (Z5), at most three steps an event (Z4)", () => {
    const count = wheelCount();
    expect(
      [0, 10, 20, 30].map((t) =>
        wheelSteps(count, { deltaY: -30, deltaMode: 0 }, t),
      ),
    ).toEqual([0, 0, 0, 1]);
    expect(count.rest).toBeCloseTo(0.2);
    expect(wheelSteps(wheelCount(), { deltaY: -1200, deltaMode: 0 }, 0)).toBe(
      3,
    );
    expect(wheelSteps(wheelCount(), { deltaY: 1200, deltaMode: 0 }, 0)).toBe(
      -3,
    );
  });
  it("drops the remainder after 300 ms or when the direction turns (Z6)", () => {
    const count = wheelCount();
    expect(wheelSteps(count, { deltaY: -60, deltaMode: 0 }, 0)).toBe(0);
    expect(wheelSteps(count, { deltaY: -60, deltaMode: 0 }, 400)).toBe(0);
    const turned = wheelCount();
    wheelSteps(turned, { deltaY: -60, deltaMode: 0 }, 0);
    expect(wheelSteps(turned, { deltaY: 60, deltaMode: 0 }, 10)).toBe(0);
    expect(turned.rest).toBeCloseTo(-0.6);
  });
  it("tells a pinch from the wheel (Z12, Z14)", () => {
    const event = (deltaY: number, more = {}) => ({
      deltaY,
      deltaMode: 0,
      ctrlKey: true,
      metaKey: false,
      ...more,
    });
    expect(wheelKind(event(-1.8), false, false)).toBe("pinch");
    expect(wheelKind(event(-1.8), true, false)).toBe("wheel");
    expect(wheelKind(event(-100), false, false)).toBe("wheel");
    expect(wheelKind(event(-100, { ctrlKey: false }), false, false)).toBe(null);
    expect(
      wheelKind(event(-100, { ctrlKey: false, metaKey: true }), false, true),
    ).toBe("wheel");
  });
  it("follows a pinch by exp(−Δ/100), whole steps drawn, 1.25× a frame at most (Z12, Z13)", () => {
    expect(pinchFactor(-18.2)).toBeCloseTo(1.1996, 3);
    expect(pinchFactor(-1000)).toBe(1.25);
    expect(pinchFactor(1000)).toBe(0.8);
    expect(pinchPdf(1, pinchFactor(-18.2)).zoom).toBe(1.2);
    // Twenty small frames: the exact value carries, the size is whole.
    let exact = 20;
    const sizes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const next = pinchText(exact, pinchFactor(-18.2 / 20));
      exact = next.exact;
      sizes.push(next.size);
    }
    expect(sizes.at(-1)).toBe(24);
    expect(sizes.every(Number.isInteger)).toBe(true);
  });
  it("steps the full text by 1 px within 16–32 (Z3)", () => {
    expect(stepText(20, 1)).toBe(21);
    expect(stepText(32, 5)).toBe(32);
    expect(stepText(16, -5)).toBe(16);
  });
  it("aligns the PDF's first step to the tens, then steps by ten (Z7, Z8, Z9)", () => {
    expect(stepPdf(1.18, 1)).toBe(1.2);
    expect(stepPdf(1.2, 1)).toBe(1.3);
    expect(stepPdf(1.18, -1)).toBe(1.1);
    expect(stepPdf(1.2, -1)).toBe(1.1);
    expect(stepPdf(3, 1)).toBe(3);
    expect(stepPdf(0.5, -1)).toBe(0.5);
    expect(canStepPdf(3, 1)).toBe(false);
    expect(canStepPdf(0.5, -1)).toBe(false);
  });
  it("brings a fit outside the range back to its edge, never further out", () => {
    expect(stepPdf(3.4, -1)).toBe(3);
    expect(stepPdf(3.4, 1)).toBe(3.4);
    expect(stepPdf(0.4, 1)).toBe(0.5);
    expect(stepPdf(0.4, -1)).toBe(0.4);
  });
  it("reads stored values outside the range as the defaults (Z29)", () => {
    expect(textSize("99")).toBe(20);
    expect(textSize("24")).toBe(24);
    expect(textSize("18")).toBe(18);
    expect(textSize("x")).toBe(20);
    expect(pdfZoom(9)).toBe("fit");
    expect(pdfZoom(1.3)).toBe(1.3);
  });
});

/** An element stand-in: `closest` answers from the selectors it is inside. */
function fake(
  inside: Record<string, unknown>,
  more: Partial<Record<"tagName" | "dataset", unknown>> = {},
): Element {
  return {
    tagName: "SPAN",
    dataset: {},
    closest: (selector: string) => {
      for (const [key, value] of Object.entries(inside))
        if (selector.split(",").some((part) => part.trim() === key))
          return value;
      return null;
    },
    querySelector: () => null,
    ...more,
  } as unknown as Element;
}
const desk = { ".reader-surface": {} };
const probe = (
  element: Element | null,
  over: Partial<Parameters<typeof menuTarget>[0]> = {},
) =>
  menuTarget({
    element,
    x: 10,
    y: 10,
    selection: null,
    markAt: () => null,
    ...over,
  });
describe("context menu (spec 1.8.2)", () => {
  it("leaves fields and anything outside the reading area to the browser", () => {
    expect(probe(fake({ ...desk, input: {} }))).toBeNull();
    expect(probe(fake({}))).toBeNull();
  });
  it("takes the selection first, then a mark, a link, a picture, a block, a page, the blank", () => {
    const rect = { left: 0, right: 20, top: 0, bottom: 20 } as DOMRect;
    const all = fake({
      ...desk,
      "a[href]": { hasAttribute: () => false },
      "[data-byte-start]": {},
      "[data-pdf-page]": { dataset: { pdfPage: "3" } },
    });
    expect(
      probe(all, { selection: { text: "abc", rects: [rect] } })?.kind,
    ).toBe("selection");
    // Outside the selection the selection is not the target.
    expect(
      probe(all, {
        selection: { text: "abc", rects: [rect] },
        x: 50,
        y: 50,
        markAt: () => "m1",
      }),
    ).toEqual({ kind: "mark", id: "m1" });
    expect(probe(all)?.kind).toBe("link");
    expect(
      probe(fake({ ...desk, "[data-byte-start]": {} }, { tagName: "IMG" }))
        ?.kind,
    ).toBe("figure");
    expect(
      probe(fake({ ...desk, table: {}, "[data-byte-start]": {} }))?.kind,
    ).toBe("table");
    expect(probe(fake({ ...desk, "[data-byte-start]": {} }))?.kind).toBe(
      "block",
    );
    expect(
      probe(
        fake({ ...desk, "[data-pdf-page]": { dataset: { pdfPage: "3" } } }),
      ),
    ).toMatchObject({ kind: "pdf-page", page: 3 });
    expect(probe(fake(desk))).toEqual({ kind: "blank" });
  });
  const can: MenuAbilities = {
    view: "doc",
    canMark: true,
    canTranslate: true,
    otherView: true,
    findable: true,
  };
  const paper = ["-", "tab-close", "tab-close-others", "tab-close-all"];
  const reading = ["back", "other-view", "find", "outline", "scale", "focus"];
  it("lists the object's part, then the reading part and the paper part", () => {
    expect(
      menuEntries({ kind: "block", element: {} as HTMLElement }, can),
    ).toEqual([
      "copy-block",
      "cite-block",
      "translate-block",
      "-",
      ...reading,
      ...paper,
    ]);
    expect(menuEntries({ kind: "blank" }, can)).toEqual([...reading, ...paper]);
    expect(
      menuEntries(
        { kind: "pdf-page", page: 1, element: {} as HTMLElement },
        {
          ...can,
          view: "pdf",
        },
      ),
    ).toEqual(["go-page", "tool-region", "-", ...reading, ...paper]);
  });
  it("gives selected text, marks and links their own part only", () => {
    expect(
      menuEntries({ kind: "selection", text: "x", rect: null }, can),
    ).toEqual([
      "copy",
      "cite",
      "mark-color",
      "note",
      "translate",
      "find-selection",
    ]);
    expect(menuEntries({ kind: "mark", id: "m" }, can)).toEqual([
      "note",
      "mark-color",
      "cite",
      "mark-delete",
    ]);
    expect(
      menuEntries(
        { kind: "link", element: {} as HTMLAnchorElement, internal: false },
        can,
      ),
    ).toEqual(["open-link", "copy-link"]);
  });
  it("leaves out what the paper or the deployment lacks (M13, M14)", () => {
    const lacking = {
      ...can,
      canMark: false,
      canTranslate: false,
      otherView: false,
      findable: false,
    };
    expect(
      menuEntries({ kind: "selection", text: "x", rect: null }, lacking),
    ).toEqual(["copy", "cite"]);
    expect(menuEntries({ kind: "blank" }, lacking)).not.toContain("other-view");
  });
  const viewport = { width: 1000, height: 800 };
  const size = { width: 240, height: 300 };
  it("opens down and right from the point, turned at the edges, 8 px in (M21, M22)", () => {
    expect(menuPosition({ x: 100, y: 100 }, size, viewport)).toEqual({
      left: 100,
      top: 100,
      maxHeight: 300,
    });
    // Near the right edge: to the left of the pointer.
    expect(menuPosition({ x: 960, y: 100 }, size, viewport).left).toBe(720);
    // Near the bottom: above the pointer.
    expect(menuPosition({ x: 100, y: 760 }, size, viewport).top).toBe(460);
    // Both corners at once.
    expect(menuPosition({ x: 960, y: 760 }, size, viewport)).toEqual({
      left: 720,
      top: 460,
      maxHeight: 300,
    });
    // Neither way fits: along the edges, scrolling inside.
    expect(
      menuPosition({ x: 100, y: 300 }, { width: 240, height: 900 }, viewport),
    ).toEqual({ left: 100, top: 8, maxHeight: 784 });
    // A narrow viewport: 8 px from both sides.
    expect(
      menuPosition({ x: 20, y: 10 }, size, { width: 250, height: 800 }).left,
    ).toBe(8);
  });
});

describe("table of operations (spec 1.8, 1.8.7)", () => {
  const all = commandTable(COMMAND_IDS.map((id) => ({ id, run: () => {} })));
  it("names an operation and its keys alike in menus and in the shortcut list (M31)", () => {
    const rows = shortcutRows(all, "pdf", true, false);
    for (const id of COMMAND_IDS) {
      const item = commandItem(all.get(id)!);
      expect(item.label).toBe(COMMANDS[id].labels[0]);
      expect(item.shortcut).toBe(commandKeys(id, false));
      if (item.shortcut)
        expect(rows).toContainEqual({
          group: COMMANDS[id].group,
          label: item.label,
          keys: item.shortcut,
        });
    }
  });
  it("writes the keys the system's way", () => {
    expect(commandKeys("zoom-in", false)).toBe("Ctrl+=");
    expect(commandKeys("zoom-in", true)).toBe("⌘=");
    expect(commandKeys("tab-reopen", false)).toBe("Alt+Shift+W");
    expect(commandKeys("view-pdf", false)).toBe("Alt+4");
    expect(commandKeys("find-previous", false)).toBe(
      "Shift+回车、Shift+F3、Ctrl+Shift+G",
    );
  });
  it("gives no key to two operations", () => {
    const chords = COMMAND_IDS.flatMap((id) =>
      (COMMANDS[id].keys as readonly KeyChord[]).map((chord) => ({
        id,
        chord,
      })),
    );
    const shifts = (c: KeyChord) =>
      c.shift === "any" ? [true, false] : [!!c.shift];
    const names = (c: KeyChord) => [
      ...(c.keys ?? []).map((k) => `key:${k}`),
      ...(c.codes ?? []).map((k) => `code:${k}`),
    ];
    const taken = new Map<string, CommandId>();
    for (const { id, chord } of chords)
      for (const shift of shifts(chord))
        for (const name of names(chord)) {
          const key = `${!!chord.mod}|${!!chord.alt}|${shift}|${name}`;
          const other = taken.get(key);
          if (other && other !== id)
            throw new Error(`${chordText(chord, false)}: ${other} and ${id}`);
          taken.set(key, id);
        }
  });
  it("leaves the browser's own keys alone (spec 1.8.7)", () => {
    const reserved = [
      { mod: true, key: "w" },
      { mod: true, key: "t" },
      { mod: true, key: "n" },
      { mod: true, key: "Tab" },
      { mod: true, key: "PageUp" },
      { mod: true, key: "PageDown" },
      { mod: true, key: "c" },
      { mod: true, key: "a" },
      { mod: true, key: "p" },
      { mod: true, key: "s" },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
        mod: true,
        key: String(n),
      })),
      { mod: false, key: "F5" },
      { mod: false, key: "F11" },
      { mod: false, key: "F12" },
    ];
    for (const id of COMMAND_IDS)
      for (const chord of COMMANDS[id].keys as readonly KeyChord[])
        for (const r of reserved)
          expect(
            !!chord.mod === r.mod && !chord.alt && chord.keys?.includes(r.key),
            `${id} takes ${r.key}`,
          ).toBeFalsy();
  });
});

describe("paper tabs (spec 1.8.3)", () => {
  const tab = (id: string): PaperTab => ({
    id,
    title: id,
    mode: "doc",
    source: {},
  });
  const abc = ["a", "b", "c"].map(tab);
  it("closes from the tab asked on", () => {
    expect(tabsToClose(abc, "one", "b")).toEqual(["b"]);
    expect(tabsToClose(abc, "others", "b")).toEqual(["a", "c"]);
    expect(tabsToClose(abc, "right", "a")).toEqual(["b", "c"]);
    expect(tabsToClose(abc, "all", "a")).toEqual(["a", "b", "c"]);
  });
  it("leaves tabs with unsaved edits out of a batch close (T11)", () => {
    expect(keepUnsaved("others", ["a", "b"], new Set(["b"]))).toEqual({
      closing: ["a"],
      kept: ["b"],
    });
    expect(keepUnsaved("one", ["b"], new Set(["b"]))).toEqual({
      closing: ["b"],
      kept: [],
    });
  });
  it("shows the tab last used after the current one closes, else its neighbours (T3)", () => {
    expect(currentAfterClose(abc, ["a", "c"], new Set(["c"]), "c")).toBe("a");
    expect(currentAfterClose(abc, [], new Set(["b"]), "b")).toBe("c");
    expect(currentAfterClose(abc, [], new Set(["c"]), "c")).toBe("b");
    expect(currentAfterClose(abc, ["b"], new Set(["a"]), "b")).toBe("b");
    expect(
      currentAfterClose(abc, [], new Set(["a", "b", "c"]), "a"),
    ).toBeNull();
  });
  it("keeps ten closes and opens the last again in its places (T4, T7)", () => {
    let records = [] as ReturnType<typeof recordClose>;
    for (let i = 0; i < 12; i++)
      records = recordClose(records, {
        tabs: [{ tab: tab(`t${i}`), index: 0 }],
        current: null,
      });
    expect(records).toHaveLength(CLOSED_LIMIT);
    expect(records[0]!.tabs[0]!.tab.id).toBe("t2");
    const reopened = reopenTabs([tab("b")], {
      tabs: [
        { tab: tab("a"), index: 0 },
        { tab: tab("c"), index: 2 },
      ],
      current: "b",
    });
    expect(reopened.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
  it("goes round the row with Alt+PageDown and Alt+PageUp (T10)", () => {
    expect(cycleTab(abc, "a", 1)).toBe("b");
    expect(cycleTab(abc, "c", 1)).toBe("a");
    expect(cycleTab(abc, "a", -1)).toBe("c");
  });
  it("keeps the open tabs in session storage and reads back only what is valid (T14)", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    } as unknown as Storage;
    saveTabs(abc, storage);
    expect(loadTabs(storage)).toEqual(abc);
    store.set(
      "sciretriever:reader:tabs:v1",
      '[{"id":1},{"id":"x","title":"X"}]',
    );
    expect(loadTabs(storage)).toEqual([
      { id: "x", title: "X", mode: undefined, source: {} },
    ]);
  });
});
