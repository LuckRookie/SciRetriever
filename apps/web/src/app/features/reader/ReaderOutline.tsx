import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReaderOutlineEntry } from "../../../reading/contract.js";
import { Icon } from "../../components/index.js";
import { sectionRoleNames } from "../../strings.js";

/** A long outline opens on its first two levels; deeper ones fold under their parent. */
const FOLD_AFTER = 20;

/**
 * The document outline: one row per heading, indented by level, with the
 * section being read marked and kept in view. Deeper levels of a long outline
 * fold; the branch holding the reading position stays open.
 */
export function ReaderOutline({
  entries,
  position,
  empty,
  onDismiss,
}: {
  entries: readonly ReaderOutlineEntry[];
  /** UTF-8 offset of the first visible block, or null before the text paints. */
  position: number | null;
  empty: ReactNode;
  /** Closes the outline; used when it floats over the text. */
  onDismiss: () => void;
}) {
  const tree = useMemo(() => {
    const top = Math.min(...entries.map((e) => e.level));
    const parents: (number | null)[] = [],
      stack: number[] = [];
    entries.forEach((entry, index) => {
      while (
        stack.length &&
        entries[stack[stack.length - 1]!]!.level >= entry.level
      )
        stack.pop();
      parents.push(stack.length ? stack[stack.length - 1]! : null);
      stack.push(index);
    });
    const branches = new Set(parents.filter((p): p is number => p !== null));
    return {
      parents,
      branches,
      depth: entries.map((e) => Math.min(3, Math.max(0, e.level - top))),
    };
  }, [entries]);
  const [choice, setChoice] = useState(new Map<number, boolean>());
  const active = useMemo(() => {
    if (position === null) return -1;
    let found = -1;
    entries.forEach((entry, index) => {
      if (entry.start !== undefined && entry.start <= position) found = index;
    });
    return found;
  }, [entries, position]);
  const reading = useMemo(() => {
    const branch = new Set<number>();
    for (let at = tree.parents[active] ?? null; at !== null; )
      at = (branch.add(at), tree.parents[at] ?? null);
    return branch;
  }, [tree, active]);
  const fold = entries.length > FOLD_AFTER;
  const open = (index: number) =>
    reading.has(index) ||
    (choice.get(index) ?? !(fold && tree.depth[index]! >= 1));
  const shown = (index: number) => {
    for (
      let at = tree.parents[index] ?? null;
      at !== null;
      at = tree.parents[at] ?? null
    )
      if (!open(at)) return false;
    return true;
  };
  const list = useRef<HTMLDivElement>(null),
    pointing = useRef(false);
  // Follow the reading position, but leave the outline alone while the pointer is in it.
  useEffect(() => {
    if (active < 0 || pointing.current) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-outline-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const everyOpen = [...tree.branches].every(open);
  const nav = useRef<HTMLElement>(null);
  const floating = () =>
    !!nav.current && getComputedStyle(nav.current).position === "absolute";
  return (
    <nav
      ref={nav}
      className="reader-outline"
      aria-label="文档目录"
      onKeyDown={(event) => {
        if (event.key === "Escape" && floating()) onDismiss();
      }}
    >
      <header className="reader-outline-header">
        <h2>目录</h2>
        {tree.branches.size ? (
          <button
            type="button"
            className="reader-outline-all"
            onClick={() =>
              setChoice(new Map([...tree.branches].map((b) => [b, !everyOpen])))
            }
          >
            {everyOpen ? "全部收起" : "全部展开"}
          </button>
        ) : null}
      </header>
      <div
        ref={list}
        className="reader-outline-list"
        onPointerEnter={() => (pointing.current = true)}
        onPointerLeave={() => (pointing.current = false)}
      >
        {entries.length
          ? entries.map((entry, index) => {
              if (!shown(index)) return null;
              const title =
                entry.title ??
                (entry.role && sectionRoleNames[entry.role]) ??
                "未命名章节";
              const branch = tree.branches.has(index),
                expanded = branch && open(index);
              return (
                <div
                  key={index}
                  className="reader-outline-row"
                  data-depth={tree.depth[index]}
                  data-active={index === active || undefined}
                >
                  {branch ? (
                    <button
                      type="button"
                      className="reader-outline-toggle"
                      aria-label={`${expanded ? "收起" : "展开"}：${title}`}
                      aria-expanded={expanded}
                      onClick={() =>
                        setChoice((previous) =>
                          new Map(previous).set(index, !expanded),
                        )
                      }
                    >
                      <Icon name="chevron" />
                    </button>
                  ) : (
                    <span
                      className="reader-outline-toggle"
                      aria-hidden="true"
                    />
                  )}
                  <button
                    type="button"
                    className="reader-outline-entry"
                    data-outline-index={index}
                    data-untitled={entry.title === null || undefined}
                    title={title}
                    aria-current={index === active ? "location" : undefined}
                    onClick={() => {
                      void entry.activate();
                      if (floating()) onDismiss();
                    }}
                  >
                    {title}
                  </button>
                </div>
              );
            })
          : empty}
      </div>
    </nav>
  );
}
