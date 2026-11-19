import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  MARK_COLORS,
  MARK_COLOR_LABELS,
  type MarkColor,
} from "@sciretriever/contracts";
import { Icon } from "../../../components/index.js";

/** Keeps a floating layer beside its anchor while the reader scrolls under it. */
export function useAnchored(
  anchor: () => DOMRect | null,
  scroller: HTMLElement | null,
  size: { width: number; height: number },
  prefer: "above" | "below",
) {
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    below: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const r = anchor();
      if (!r) return setPlace(null);
      const view =
        scroller?.getBoundingClientRect() ??
        new DOMRect(0, 0, innerWidth, innerHeight);
      let below = prefer === "below",
        top = below ? r.bottom + 10 : r.top - size.height - 10;
      if (!below && top < view.top + 6) {
        below = true;
        top = r.bottom + 10;
      }
      if (below && top + size.height > innerHeight - 8)
        top = Math.max(8, r.top - size.height - 10);
      const left = Math.max(
        12,
        Math.min(
          innerWidth - size.width - 12,
          r.left + r.width / 2 - size.width / 2,
        ),
      );
      setPlace({ left, top, below });
    };
    update();
    scroller?.addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    return () => {
      scroller?.removeEventListener("scroll", update);
      removeEventListener("resize", update);
    };
  }, [anchor, scroller, size.width, size.height, prefer]);
  return place;
}

/** The floating bar over a selection or a mark: colour, note, cite and the rest. */
export function MarkBar({
  anchor,
  scroller,
  current,
  onColor,
  onPreview,
  children,
  label,
}: {
  anchor: () => DOMRect | null;
  scroller: HTMLElement | null;
  current?: MarkColor;
  onColor: (color: MarkColor) => void;
  onPreview?: (color: MarkColor | null) => void;
  children: ReactNode;
  label: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 320, height: 40 });
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () =>
      setSize((was) =>
        was.width === el.offsetWidth && was.height === el.offsetHeight
          ? was
          : { width: el.offsetWidth, height: el.offsetHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const place = useAnchored(anchor, scroller, size, "above");
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return createPortal(
    <div
      ref={bar}
      className="mark-bar"
      role="toolbar"
      aria-label={label}
      data-shown={(shown && !!place) || undefined}
      data-below={place?.below || undefined}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999 }}
      // A press here must not clear the selection it acts on.
      onPointerDown={(event) => event.preventDefault()}
      onPointerLeave={() => onPreview?.(null)}
    >
      <span className="mark-bar-colors">
        {MARK_COLORS.map((color, index) => (
          <button
            key={color}
            type="button"
            className="mark-swatch"
            data-color={color}
            data-current={current === color || undefined}
            aria-label={`${MARK_COLOR_LABELS[color]}（${index + 1}）`}
            data-tip={`${MARK_COLOR_LABELS[color]} · ${index + 1}`}
            onPointerEnter={() => onPreview?.(color)}
            onClick={() => onColor(color)}
          >
            <i />
          </button>
        ))}
      </span>
      <span className="mark-bar-sep" aria-hidden="true" />
      {children}
    </div>,
    document.body,
  );
}
export function MarkBarButton({
  icon,
  label,
  shortcut,
  children,
  onPress,
  tone,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  shortcut?: string;
  children?: ReactNode;
  onPress: () => void;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      className="mark-bar-button"
      data-tone={tone}
      aria-label={label}
      data-tip={shortcut ? `${label} · ${shortcut}` : label}
      onClick={onPress}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
}

/** A note on a mark. ⌘/Ctrl+Enter saves; Esc closes without saving. */
export function NotePopover({
  anchor,
  scroller,
  color,
  quote,
  initial,
  onSave,
  onClose,
}: {
  anchor: () => DOMRect | null;
  scroller: HTMLElement | null;
  color: MarkColor;
  quote: string;
  initial: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  const place = useAnchored(
    anchor,
    scroller,
    { width: Math.min(360, innerWidth - 24), height: 236 },
    "below",
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => area.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return createPortal(
    <div
      className="mark-note-popover"
      role="dialog"
      aria-label="批注笔记"
      data-color={color}
      data-shown={!!place || undefined}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999 }}
    >
      <p className="mark-note-quote">{quote}</p>
      <textarea
        ref={area}
        value={text}
        maxLength={20000}
        placeholder="写下你的想法，用 #标签 归类"
        aria-label="笔记"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave(text.trim());
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="mark-note-actions">
        <span>
          <kbd>⌘</kbd> <kbd>↵</kbd> 保存
        </span>
        <button type="button" className="mark-note-cancel" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="mark-note-save"
          onClick={() => onSave(text.trim())}
        >
          保存
        </button>
      </div>
    </div>,
    document.body,
  );
}
