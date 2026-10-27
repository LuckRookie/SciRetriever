import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  LiteratureSearchItem,
  LiteratureStatus,
} from "@sciretriever/contracts";

/** What a selection can be acted on for; each batch action takes only its own group. */
export type SelectionGroup = "no-pdf" | "unarchived" | "ready" | "other";
export const SELECTION_GROUPS: readonly {
  group: SelectionGroup;
  label: string;
}[] = [
  { group: "no-pdf", label: "无 PDF" },
  { group: "unarchived", label: "有 PDF 未建档" },
  { group: "ready", label: "已就绪" },
  { group: "other", label: "其他" },
];
const GROUP_OF: Readonly<Record<LiteratureStatus, SelectionGroup>> = {
  UNREVIEWED: "no-pdf",
  ASSET_READY: "unarchived",
  ARCHIVE_FAILED: "unarchived",
  READY: "ready",
  ARCHIVING: "other",
  EXCLUDED: "other",
};
/** Ids whose status is not known locally count as “other” and join no action. */
export function groupSelection(
  ids: ReadonlySet<string>,
  known: ReadonlyMap<string, LiteratureSearchItem>,
): Readonly<Record<SelectionGroup, string[]>> {
  const groups: Record<SelectionGroup, string[]> = {
    "no-pdf": [],
    unarchived: [],
    ready: [],
    other: [],
  };
  for (const id of ids) {
    const status = known.get(id)?.literature.status;
    groups[status ? GROUP_OF[status] : "other"].push(id);
  }
  return groups;
}

/** Edge band where a held drag scrolls the list, and its top speed per frame. */
const EDGE = 56,
  SPEED = 18;

/**
 * Pointer selection on the checkbox column: press and drag to select or clear
 * a run of rows, Shift+click to extend from the last row clicked. Keyboard
 * toggles still go through the checkbox itself.
 */
export function useRangeSelection({
  items,
  selected,
  setSelected,
}: {
  items: readonly LiteratureSearchItem[];
  selected: ReadonlySet<string>;
  setSelected: (next: Set<string>) => void;
}) {
  const latest = useRef({ items, selected, setSelected });
  latest.current = { items, selected, setSelected };
  const anchor = useRef<string | null>(null);
  const suppress = useRef(false);
  const drag = useRef<{
    start: number;
    current: number;
    mode: boolean;
    base: ReadonlySet<string>;
    scroller: HTMLElement | null;
    x: number;
    y: number;
    frame: number;
  } | null>(null);
  const apply = useCallback(
    (from: number, to: number, mode: boolean, base: ReadonlySet<string>) => {
      const { items, setSelected } = latest.current;
      const next = new Set(base);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        const id = items[i]?.literature.literature_id;
        if (!id) continue;
        if (mode) next.add(id);
        else next.delete(id);
      }
      setSelected(next);
    },
    [],
  );
  const rowAt = (x: number, y: number) => {
    const row = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".paper-row[data-index]");
    return row ? Number(row.dataset.index) : null;
  };
  const stop = useCallback(() => {
    const state = drag.current;
    if (!state) return;
    cancelAnimationFrame(state.frame);
    document.documentElement.classList.remove("library-range-selecting");
    drag.current = null;
  }, []);
  useEffect(() => {
    const release = () => {
      stop();
      // Clicks are dispatched after pointerup, before this timer.
      setTimeout(() => (suppress.current = false));
    };
    const move = (event: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      state.x = event.clientX;
      state.y = event.clientY;
      const index = rowAt(event.clientX, event.clientY);
      if (index !== null && index !== state.current) {
        state.current = index;
        apply(state.start, index, state.mode, state.base);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      stop();
    };
  }, [apply, stop]);
  /** Scroll while the pointer rests near the list edge, and keep extending the run. */
  const autoscroll = useCallback(() => {
    const state = drag.current;
    if (!state?.scroller) return;
    const box = state.scroller.getBoundingClientRect();
    const step =
      state.y < box.top + EDGE
        ? -Math.ceil(((box.top + EDGE - state.y) / EDGE) * SPEED)
        : state.y > box.bottom - EDGE
          ? Math.ceil(((state.y - (box.bottom - EDGE)) / EDGE) * SPEED)
          : 0;
    if (step) {
      state.scroller.scrollBy(0, step);
      const index = rowAt(
        state.x,
        Math.min(Math.max(state.y, box.top + 1), box.bottom - 1),
      );
      if (index !== null && index !== state.current) {
        state.current = index;
        apply(state.start, index, state.mode, state.base);
      }
    }
    state.frame = requestAnimationFrame(autoscroll);
  }, [apply]);
  const onPointerDown = useCallback(
    (index: number, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      const { items, selected } = latest.current;
      const id = items[index]?.literature.literature_id;
      if (!id) return;
      event.preventDefault();
      // The press already decided; the click that follows must not toggle again.
      suppress.current = true;
      const from = anchor.current
        ? items.findIndex(
            (item) => item.literature.literature_id === anchor.current,
          )
        : -1;
      if (event.shiftKey && from >= 0) {
        apply(from, index, !selected.has(id), selected);
        return;
      }
      anchor.current = id;
      const mode = !selected.has(id);
      drag.current = {
        start: index,
        current: index,
        mode,
        base: new Set(selected),
        scroller:
          event.currentTarget.closest<HTMLElement>(".workspace-content"),
        x: event.clientX,
        y: event.clientY,
        frame: 0,
      };
      document.documentElement.classList.add("library-range-selecting");
      apply(index, index, mode, selected);
      drag.current.frame = requestAnimationFrame(autoscroll);
    },
    [apply, autoscroll],
  );
  /** Clicks after a handled press are swallowed; keyboard toggles pass through. */
  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (suppress.current) event.preventDefault();
  }, []);
  /**
   * React still reports the checkbox change for a cancelled click, so the
   * toggle handler asks whether the press already decided this row.
   */
  const handledByPress = useCallback(() => suppress.current, []);
  const remember = useCallback((id: string) => {
    anchor.current = id;
  }, []);
  const dragging = useCallback(() => drag.current !== null, []);
  return { onPointerDown, onClickCapture, handledByPress, remember, dragging };
}
