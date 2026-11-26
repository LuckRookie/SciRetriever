import type { MenuOption } from "../../../components/index.js";

/**
 * The reader's operations, each registered once (reading-experience 1.8):
 * a name that starts with a verb, its keys, and at run time whether it can
 * act now and what it does. “更多”, “排版”, the context menus, the key
 * handling and the shortcut list all read this table, so one operation has
 * the same name and keys wherever it shows. What the paper or the deployment
 * lacks is left out of the run-time list; what cannot act right now is
 * disabled in place.
 */
export type CommandGroup =
  | "view"
  | "scroll"
  | "find"
  | "marks"
  | "tabs"
  | "other";
export const GROUP_LABELS: Record<CommandGroup, string> = {
  view: "视图与比例",
  scroll: "滚动与跳转",
  find: "查找",
  marks: "批注",
  tabs: "标签页",
  other: "其他",
};
/**
 * Where a key acts (spec 1.8.1, 1.8.4, 1.8.7):
 * - `text`: not inside a text field, an editable area or a dialog;
 * - `zoom`: nor in a menu, the navigation drawer, the command palette or the side panel;
 * - `scroll`: not in a field, an editable area, a dialog or a menu; on a
 *   button, a segmented control or a tab, space, Enter and arrows are the control's;
 * - `always`: everywhere on the reader page but a dialog.
 */
export type KeyScope = "text" | "zoom" | "scroll" | "always";
export interface KeyChord {
  /** `KeyboardEvent.key` values (letters compared in lower case). */
  keys?: readonly string[];
  /** `KeyboardEvent.code` values: the physical key (Alt with letters and digits). */
  codes?: readonly string[];
  /** Control, or ⌘ on macOS. */
  mod?: boolean;
  alt?: boolean;
  /** true or false must match; "any" ignores Shift. */
  shift?: boolean | "any";
  scope?: KeyScope;
  /** How the key is written, without its modifiers: “=”, “PageDown”. */
  label: string;
  /** Written in the shortcut list only, never handled here (the shell, a field). */
  shown?: boolean;
}
export interface CommandDefinition {
  group: CommandGroup;
  /** The names it takes, by state (“显示目录” / “收起目录”). */
  labels: readonly string[];
  keys: readonly KeyChord[];
  /** The keys as written in menus and the shortcut list, when not the first chord's. */
  hint?: string;
}
const letter = (key: string, scope: KeyScope = "text"): KeyChord => ({
  keys: [key.toLowerCase()],
  shift: false,
  scope,
  label: key.toUpperCase(),
});
const alt = (code: string, label: string, shift = false): KeyChord => ({
  codes: [code],
  alt: true,
  shift,
  scope: "always",
  label,
});
export const COMMANDS = {
  // 视图与比例
  "view-overview": {
    group: "view",
    labels: ["切换到概览"],
    keys: [alt("Digit1", "1")],
  },
  "view-outline": {
    group: "view",
    labels: ["切换到脉络"],
    keys: [alt("Digit2", "2")],
  },
  "view-doc": {
    group: "view",
    labels: ["切换到全文"],
    keys: [alt("Digit3", "3")],
  },
  "view-pdf": {
    group: "view",
    labels: ["切换到 PDF"],
    keys: [alt("Digit4", "4")],
  },
  "zoom-in": {
    group: "view",
    labels: ["放大"],
    keys: [
      { keys: ["=", "+"], mod: true, shift: "any", scope: "zoom", label: "=" },
      {
        codes: ["NumpadAdd"],
        mod: true,
        shift: "any",
        scope: "zoom",
        label: "+",
      },
    ],
  },
  "zoom-out": {
    group: "view",
    labels: ["缩小"],
    keys: [
      { keys: ["-", "_"], mod: true, shift: "any", scope: "zoom", label: "−" },
      {
        codes: ["NumpadSubtract"],
        mod: true,
        shift: "any",
        scope: "zoom",
        label: "−",
      },
    ],
  },
  "zoom-reset": {
    group: "view",
    labels: ["恢复默认", "适合宽度"],
    keys: [
      {
        keys: ["0"],
        codes: ["Digit0", "Numpad0"],
        mod: true,
        shift: false,
        scope: "zoom",
        label: "0",
      },
    ],
  },
  "zoom-actual": { group: "view", labels: ["实际大小"], keys: [] },
  focus: {
    group: "view",
    labels: ["进入专注模式", "退出专注模式"],
    keys: [letter("F")],
  },
  outline: {
    group: "view",
    labels: ["显示目录", "收起目录"],
    keys: [letter("O")],
  },
  // 滚动与跳转
  "page-down": {
    group: "scroll",
    labels: ["下翻一屏"],
    keys: [
      { keys: [" "], shift: false, scope: "scroll", label: "空格" },
      { keys: ["PageDown"], shift: false, scope: "scroll", label: "PageDown" },
    ],
  },
  "page-up": {
    group: "scroll",
    labels: ["上翻一屏"],
    keys: [
      { keys: [" "], shift: true, scope: "scroll", label: "空格" },
      { keys: ["PageUp"], shift: false, scope: "scroll", label: "PageUp" },
    ],
  },
  "line-down": {
    group: "scroll",
    labels: ["向下滚动"],
    keys: [{ keys: ["ArrowDown"], shift: false, scope: "scroll", label: "↓" }],
  },
  "line-up": {
    group: "scroll",
    labels: ["向上滚动"],
    keys: [{ keys: ["ArrowUp"], shift: false, scope: "scroll", label: "↑" }],
  },
  "line-right": {
    group: "scroll",
    labels: ["向右滚动"],
    keys: [{ keys: ["ArrowRight"], shift: false, scope: "scroll", label: "→" }],
  },
  "line-left": {
    group: "scroll",
    labels: ["向左滚动"],
    keys: [{ keys: ["ArrowLeft"], shift: false, scope: "scroll", label: "←" }],
  },
  start: {
    group: "scroll",
    labels: ["到开头"],
    keys: [{ keys: ["Home"], shift: false, scope: "scroll", label: "Home" }],
  },
  end: {
    group: "scroll",
    labels: ["到末尾"],
    keys: [{ keys: ["End"], shift: false, scope: "scroll", label: "End" }],
  },
  "next-part": {
    group: "scroll",
    labels: ["下一节", "下一页"],
    keys: [
      {
        keys: ["ArrowDown"],
        alt: true,
        shift: false,
        scope: "scroll",
        label: "↓",
      },
    ],
  },
  "previous-part": {
    group: "scroll",
    labels: ["上一节", "上一页"],
    keys: [
      {
        keys: ["ArrowUp"],
        alt: true,
        shift: false,
        scope: "scroll",
        label: "↑",
      },
    ],
  },
  "go-page": {
    group: "scroll",
    labels: ["跳到页码…"],
    keys: [letter("G")],
  },
  back: {
    group: "scroll",
    labels: ["返回上一位置"],
    keys: [
      {
        keys: ["ArrowLeft"],
        alt: true,
        shift: false,
        scope: "always",
        label: "←",
      },
    ],
  },
  forward: {
    group: "scroll",
    labels: ["前进到下一位置"],
    keys: [
      {
        keys: ["ArrowRight"],
        alt: true,
        shift: false,
        scope: "always",
        label: "→",
      },
    ],
  },
  // 查找
  find: {
    group: "find",
    labels: ["查找…"],
    keys: [{ keys: ["f"], mod: true, shift: false, scope: "text", label: "F" }],
  },
  "find-next": {
    group: "find",
    labels: ["下一处"],
    hint: "回车、F3、Ctrl+G",
    keys: [
      { keys: ["F3"], shift: false, scope: "always", label: "F3" },
      { keys: ["g"], mod: true, shift: false, scope: "always", label: "G" },
    ],
  },
  "find-previous": {
    group: "find",
    labels: ["上一处"],
    hint: "Shift+回车、Shift+F3、Ctrl+Shift+G",
    keys: [
      { keys: ["F3"], shift: true, scope: "always", label: "F3" },
      { keys: ["g"], mod: true, shift: true, scope: "always", label: "G" },
    ],
  },
  // 批注
  "tool-select": {
    group: "marks",
    labels: ["选择工具"],
    keys: [letter("V")],
  },
  "tool-pen": { group: "marks", labels: ["高亮笔"], keys: [letter("H")] },
  "tool-region": {
    group: "marks",
    labels: ["框选区域"],
    keys: [letter("R")],
  },
  "mark-color": {
    group: "marks",
    labels: ["批注颜色", "划线", "更改颜色", "笔颜色"],
    hint: "1–5",
    keys: [
      {
        keys: ["1", "2", "3", "4", "5"],
        shift: false,
        scope: "text",
        label: "1–5",
      },
    ],
  },
  note: {
    group: "marks",
    labels: ["写笔记", "编辑笔记"],
    keys: [letter("N")],
  },
  cite: {
    group: "marks",
    labels: ["复制为引用"],
    keys: [letter("C")],
  },
  "mark-previous": {
    group: "marks",
    labels: ["上一条批注"],
    keys: [{ keys: ["["], shift: false, scope: "text", label: "[" }],
  },
  "mark-next": {
    group: "marks",
    labels: ["下一条批注"],
    keys: [{ keys: ["]"], shift: false, scope: "text", label: "]" }],
  },
  "mark-delete": {
    group: "marks",
    labels: ["删除批注"],
    keys: [
      { keys: ["Delete"], shift: false, scope: "text", label: "Delete" },
      { keys: ["Backspace"], shift: false, scope: "text", label: "Backspace" },
    ],
  },
  // 标签页
  "tab-close": {
    group: "tabs",
    labels: ["关闭本文献", "关闭"],
    keys: [alt("KeyW", "W")],
  },
  "tab-reopen": {
    group: "tabs",
    labels: ["重新打开刚关闭的文献"],
    keys: [alt("KeyW", "W", true)],
  },
  "tab-next": {
    group: "tabs",
    labels: ["下一篇文献"],
    keys: [
      {
        keys: ["PageDown"],
        alt: true,
        shift: false,
        scope: "always",
        label: "PageDown",
      },
    ],
  },
  "tab-previous": {
    group: "tabs",
    labels: ["上一篇文献"],
    keys: [
      {
        keys: ["PageUp"],
        alt: true,
        shift: false,
        scope: "always",
        label: "PageUp",
      },
    ],
  },
  "tab-close-others": {
    group: "tabs",
    labels: ["关闭其他文献"],
    keys: [],
  },
  "tab-close-right": {
    group: "tabs",
    labels: ["关闭右侧文献"],
    keys: [],
  },
  "tab-close-all": {
    group: "tabs",
    labels: ["关闭所有文献"],
    keys: [],
  },
  // 其他
  "context-menu": {
    group: "other",
    labels: ["打开右键菜单"],
    keys: [
      { keys: ["F10"], shift: true, scope: "text", label: "F10" },
      { keys: ["ContextMenu"], shift: "any", scope: "text", label: "菜单键" },
    ],
  },
  shortcuts: {
    group: "other",
    labels: ["键盘快捷键"],
    keys: [{ keys: ["?"], shift: "any", scope: "text", label: "?" }],
  },
} satisfies Record<string, CommandDefinition>;
export type CommandId = keyof typeof COMMANDS;
export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

/** One operation as the reader has it now. */
export interface ReaderCommand {
  id: CommandId;
  /** Which of the definition's names (by state); the first when absent. */
  label?: string;
  /** Present but unable to act now: shown disabled in place. */
  enabled?: boolean;
  checked?: boolean;
  /** A menu stays open after it (“放大”, “缩小” in “排版”). */
  keepOpen?: boolean;
  /** For a command with a choice (the five colours): opens these instead. */
  submenu?: readonly MenuOption[];
  /** The key event that ran it, when a key did; `false` lets the key go on. */
  run: (event?: KeyboardEvent) => void | boolean;
}
export type CommandTable = ReadonlyMap<CommandId, ReaderCommand>;
export function commandTable(list: readonly (ReaderCommand | null | false)[]) {
  const table = new Map<CommandId, ReaderCommand>();
  for (const command of list) if (command) table.set(command.id, command);
  return table as CommandTable;
}
export function commandLabel(command: ReaderCommand): string {
  const labels: readonly string[] = COMMANDS[command.id].labels;
  const label = command.label ?? labels[0]!;
  if (!labels.includes(label))
    throw new Error(`${command.id}: “${label}” is not one of its names`);
  return label;
}

export const isMac = () =>
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/iu.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform,
  );
/** A chord as written for this system: “Ctrl+=”, “Alt+Shift+W”, “⌘=”. */
export function chordText(chord: KeyChord, mac = isMac()): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (chord.alt) parts.push(mac ? "⌥" : "Alt");
  if (chord.shift === true) parts.push(mac ? "⇧" : "Shift");
  parts.push(chord.label);
  return mac ? parts.join("") : parts.join("+");
}
/** The keys of an operation as one menu or list shows them. */
export function commandKeys(id: CommandId, mac = isMac()): string | undefined {
  const definition: CommandDefinition = COMMANDS[id];
  if (definition.hint)
    return mac
      ? definition.hint.replace(/Ctrl\+/gu, "⌘").replace(/Shift\+/gu, "⇧")
      : definition.hint;
  const first = definition.keys[0];
  return first ? chordText(first, mac) : undefined;
}
/** A menu item for an operation: the same name and keys everywhere. */
export function commandItem(
  command: ReaderCommand,
  more: Partial<MenuOption> = {},
): MenuOption {
  const keys = commandKeys(command.id);
  return {
    id: command.id,
    label: commandLabel(command),
    ...(keys ? { shortcut: keys } : {}),
    ...(command.enabled === false ? { disabled: true } : {}),
    ...(command.checked !== undefined ? { checked: command.checked } : {}),
    ...(command.keepOpen ? { keepOpen: true } : {}),
    ...(command.submenu ? { submenu: command.submenu } : {}),
    onAction: () => {
      command.run();
    },
    ...more,
  };
}

/** Where focus is, for the key scopes above. */
export function focusPlace(target: EventTarget | null) {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  const closest = (selector: string) => !!el?.closest(selector);
  return {
    field:
      closest(
        "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']",
      ) || !!(el as HTMLElement | null)?.isContentEditable,
    dialog: closest("[role='dialog'], [role='alertdialog']"),
    menu: closest("[role='menu'], .ui-popover"),
    side: closest(".reader-information"),
    control: closest(
      "button, [role='button'], [role='tab'], [role='radio'], [role='menuitem'], [role='checkbox'], [role='switch'], [role='separator'], [role='slider'], [role='option'], [role='row'], [role='treeitem'], a[href], summary",
    ),
  };
}
const scrollControlKeys = new Set([
  " ",
  "Enter",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
]);
export function chordMatches(
  chord: KeyChord,
  event: KeyboardEvent,
  mac = isMac(),
): boolean {
  if (chord.shown) return false;
  const mod = mac ? event.metaKey : event.ctrlKey;
  const otherMod = mac ? event.ctrlKey : event.metaKey;
  if (!!chord.mod !== mod || otherMod) return false;
  if (!!chord.alt !== event.altKey) return false;
  if (chord.shift !== "any" && !!chord.shift !== event.shiftKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  // Alt with a letter or a digit is read by the physical key (spec 1.8.7).
  if (chord.codes?.includes(event.code)) return true;
  if (chord.alt && chord.codes) return false;
  return !!chord.keys?.includes(key);
}
export function chordAllowed(
  chord: KeyChord,
  event: KeyboardEvent,
  place = focusPlace(event.target),
): boolean {
  const scope = chord.scope ?? "text";
  if (place.dialog) return false;
  if (scope === "always") return true;
  if (place.field) return false;
  if (scope === "text") return true;
  if (place.menu) return false;
  if (scope === "zoom") return !place.side;
  // scroll: a focused control keeps space, Enter and the arrows.
  return !(place.control && !event.altKey && scrollControlKeys.has(event.key));
}
/**
 * Runs the operation a key belongs to, if any can take it here; true when one
 * did (the key is then the reader's: default prevented by the caller).
 */
export function dispatchKey(
  table: CommandTable,
  event: KeyboardEvent,
  mac = isMac(),
): boolean {
  const place = focusPlace(event.target);
  for (const command of table.values()) {
    const chords: readonly KeyChord[] = COMMANDS[command.id].keys;
    const chord = chords.find((c) => chordMatches(c, event, mac));
    if (!chord || !chordAllowed(chord, event, place)) continue;
    // At an end of the scale the key is still the reader's: the browser must not zoom.
    if (command.enabled === false) return chord.scope === "zoom";
    return command.run(event) !== false;
  }
  return false;
}
