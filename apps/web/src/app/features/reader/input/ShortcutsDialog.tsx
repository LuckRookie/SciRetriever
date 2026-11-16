import { Dialog } from "../../../components/index.js";
import {
  COMMANDS,
  GROUP_LABELS,
  commandKeys,
  commandLabel,
  isMac,
  type CommandGroup,
  type CommandTable,
} from "./commands.js";

/** Keys that are not operations of the table: gestures and the shell's (spec 1.8.7). */
function extraRows(
  view: "doc" | "pdf" | null,
  canMark: boolean,
  mac: boolean,
): { group: CommandGroup; label: string; keys: string }[] {
  const mod = mac ? "⌘" : "Ctrl+";
  return [
    { group: "view", label: "改变阅读比例", keys: `${mod}滚轮、触控板捏合` },
    ...(canMark
      ? [
          {
            group: "marks" as const,
            label: "扩展选区",
            keys: mac ? "⇧方向键" : "Shift+方向键",
          },
          ...(view === "pdf"
            ? [
                {
                  group: "marks" as const,
                  label: "框选区域",
                  keys: mac ? "⌥拖动" : "Alt+拖动",
                },
              ]
            : []),
        ]
      : []),
    { group: "tabs", label: "关闭这一篇", keys: "中键点击标签页" },
    { group: "other", label: "逐层关闭", keys: "Esc" },
    { group: "other", label: "命令面板", keys: mac ? "⌘K" : "Ctrl+K" },
  ];
}
/** The list's rows: each operation that has keys, then the gestures (spec 1.8.7). */
export function shortcutRows(
  table: CommandTable,
  view: "doc" | "pdf" | null,
  canMark: boolean,
  mac: boolean,
) {
  return [
    ...[...table.values()].flatMap((command) => {
      const keys = commandKeys(command.id, mac);
      return keys
        ? [
            {
              group: COMMANDS[command.id].group,
              label: commandLabel(command),
              keys,
            },
          ]
        : [];
    }),
    ...extraRows(view, canMark, mac),
  ];
}
const ORDER: readonly CommandGroup[] = [
  "view",
  "scroll",
  "find",
  "marks",
  "tabs",
  "other",
];
/**
 * “键盘快捷键” (reading-experience 1.8.7): from the table of operations, the
 * ones this paper and this deployment have, by group, with the system's
 * modifier keys; and the two closing sentences.
 */
export function ShortcutsDialog({
  isOpen,
  onClose,
  table,
  view,
  canMark,
}: {
  isOpen: boolean;
  onClose: () => void;
  table: CommandTable | null;
  view: "doc" | "pdf" | null;
  canMark: boolean;
}) {
  if (!isOpen || !table) return null;
  const rows = shortcutRows(table, view, canMark, isMac());
  return (
    <Dialog
      title="键盘快捷键"
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="reader-shortcuts"
    >
      {ORDER.map((group) => {
        const list = rows.filter((row) => row.group === group);
        return list.length ? (
          <section key={group} className="reader-shortcuts-group">
            <h3>{GROUP_LABELS[group]}</h3>
            <dl>
              {list.map((row) => (
                <div key={`${row.label}:${row.keys}`}>
                  <dt>{row.label}</dt>
                  <dd>
                    <kbd>{row.keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null;
      })}
      <p className="ui-description">Shift+右键打开浏览器菜单。</p>
      <p className="ui-description">调整整个界面的大小，请用浏览器的缩放。</p>
    </Dialog>
  );
}
