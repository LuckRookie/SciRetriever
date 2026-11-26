import { useEffect, useRef, type RefObject } from "react";
import {
  Dialog,
  Popover as AriaPopover,
  Radio,
  RadioGroup,
} from "react-aria-components";
import {
  Button,
  Icon,
  IconButton,
  SegmentedControl,
  Switch,
} from "../../components/index.js";
import { THEMES, type Theme } from "../../data/preferences.js";
import { layerStrings } from "../../strings.js";
import {
  LEADING_LABELS,
  MEASURE_LABELS,
  type Leading,
  type Measure,
} from "./input/reading-layout.js";

/** One step of the reading scale, as the panel offers it. */
export interface TypeScale {
  /** “字号” in the full text, “比例” in the PDF. */
  label: string;
  /** “110%”, “适合宽度”. */
  value: string;
  zoomIn: { enabled: boolean; keys?: string | undefined; run(): void };
  zoomOut: { enabled: boolean; keys?: string | undefined; run(): void };
  /** “恢复默认”, or in the PDF “适合宽度”, then “实际大小”. */
  resets: readonly {
    label: string;
    keys?: string | undefined;
    current?: boolean;
    run(): void;
  }[];
}

/** The rest of one press that closed the panel: it selects, marks and clicks nothing. */
const PRESS_REST = [
  "mousedown",
  "selectstart",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "contextmenu",
] as const;
function swallowRestOfPress() {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "click" || event.type === "contextmenu") done();
    if (event.type === "pointerup") setTimeout(done, 300);
  };
  const done = () => {
    for (const type of PRESS_REST)
      window.removeEventListener(type, swallow, true);
  };
  for (const type of PRESS_REST) window.addEventListener(type, swallow, true);
  // A press without a click (dragged off, cancelled) lets go all the same.
  setTimeout(done, 2000);
}

/**
 * “排版” (plan 25 block 30): the reading size or zoom, the line length and
 * spacing of the full text, the theme in place, and two switches. It opens
 * from its button in the top bar, or from “更多” where the bar folds it in.
 *
 * Non-modal: the panel is for setting while looking, so the page stays live
 * (it scrolls, and the effect of each choice shows). A press outside it, Esc
 * or its button again closes it; the press that closes it does nothing else
 * (no selection, no mark), and the focus goes back to its button.
 */
export function ReaderTypePanel({
  triggerRef,
  toggleRef,
  focusBack,
  isOpen,
  onOpenChange,
  scale,
  measure,
  leading,
  onMeasure,
  onLeading,
  theme,
  onTheme,
  keySentences,
  keyTerms = false,
  onKeySentences,
  sources,
  onSources,
}: {
  triggerRef: RefObject<Element | null>;
  /** The button that opens it and, pressed again, closes it (its own toggle). */
  toggleRef: RefObject<Element | null> | null;
  /** Puts the focus back on the button it was opened from. */
  focusBack: () => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  scale: TypeScale | null;
  /** Null outside the full text: the PDF keeps its own lines. */
  measure: Measure | null;
  leading: Leading | null;
  onMeasure: (value: Measure) => void;
  onLeading: (value: Leading) => void;
  theme: Theme;
  onTheme: (value: Theme) => void;
  keySentences: boolean;
  /** A paper with reading layers: the switch marks their key terms (spec 3.3.2). */
  keyTerms?: boolean;
  onKeySentences: (value: boolean) => void;
  /** “显示核对依据”: null where there is nothing to check (outside the full text). */
  sources: boolean | null;
  onSources: (value: boolean) => void;
}) {
  const popover = useRef<HTMLElement>(null);
  const latest = useRef({ onOpenChange, focusBack });
  latest.current = { onOpenChange, focusBack };
  useEffect(() => {
    if (!isOpen) return;
    const close = () => {
      latest.current.onOpenChange(false);
      requestAnimationFrame(() => latest.current.focusBack());
    };
    // Esc closes this layer only, wherever the focus is: a step at the end
    // of the scale is disabled and lets go of the focus (spec 1.8.6).
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    // Its button toggles it itself; any other press outside closes it.
    const press = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (popover.current?.contains(target) ||
          toggleRef?.current?.contains(target))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      swallowRestOfPress();
      close();
    };
    document.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", press, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", press, true);
    };
  }, [isOpen, toggleRef]);
  return (
    <AriaPopover
      ref={popover}
      className="ui-popover reader-type-popover"
      placement="bottom end"
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isNonModal
      // Focus moving to its own button is that button's toggle, not a leave.
      shouldCloseOnInteractOutside={(element) =>
        !toggleRef?.current?.contains(element)
      }
    >
      {/* A non-modal dialog named “排版”: the page around it stays reachable. */}
      <Dialog aria-label="排版" className="reader-type-panel">
        {scale ? (
          <div className="reader-type-row">
            <span className="reader-type-label">{scale.label}</span>
            <div className="reader-type-scale">
              <IconButton
                aria-label="缩小"
                shortcut={scale.zoomOut.keys}
                variant="text"
                size="compact"
                isDisabled={!scale.zoomOut.enabled}
                onPress={scale.zoomOut.run}
              >
                <Icon name="minus" />
              </IconButton>
              <span className="reader-type-scale-value" aria-live="polite">
                {scale.value}
              </span>
              <IconButton
                aria-label="放大"
                shortcut={scale.zoomIn.keys}
                variant="text"
                size="compact"
                isDisabled={!scale.zoomIn.enabled}
                onPress={scale.zoomIn.run}
              >
                <Icon name="plus" />
              </IconButton>
              {scale.resets.map((reset) => (
                <Button
                  key={reset.label}
                  variant="text"
                  size="compact"
                  {...(reset.current !== undefined
                    ? { "aria-pressed": reset.current }
                    : {})}
                  className="reader-type-reset"
                  onPress={reset.run}
                >
                  {reset.label}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {measure ? (
          <div className="reader-type-row">
            <span className="reader-type-label">行宽</span>
            <SegmentedControl
              label="行宽"
              value={measure}
              onChange={(value) => onMeasure(value as Measure)}
              items={(Object.keys(MEASURE_LABELS) as Measure[]).map((id) => ({
                id,
                label: MEASURE_LABELS[id],
              }))}
            />
          </div>
        ) : null}
        {leading ? (
          <div className="reader-type-row">
            <span className="reader-type-label">行距</span>
            <SegmentedControl
              label="行距"
              value={leading}
              onChange={(value) => onLeading(value as Leading)}
              items={(Object.keys(LEADING_LABELS) as Leading[]).map((id) => ({
                id,
                label: LEADING_LABELS[id],
              }))}
            />
          </div>
        ) : null}
        <div className="reader-type-row">
          <span className="reader-type-label">主题</span>
          {/* The same choice as “设置 → 外观”: a click puts it on at once. */}
          <RadioGroup
            aria-label="主题"
            className="reader-type-themes"
            orientation="horizontal"
            value={theme === "system" ? null : theme}
            onChange={(value) => onTheme(value as Theme)}
          >
            {THEMES.map((item) => (
              <Radio
                key={item.id}
                value={item.id}
                className="reader-theme-swatch"
                aria-label={item.name}
              >
                <span
                  className="reader-theme-swatch-paper"
                  data-theme-preview={item.id}
                  title={item.name}
                >
                  <i />
                </span>
              </Radio>
            ))}
          </RadioGroup>
        </div>
        <div className="reader-type-switches">
          <Switch isSelected={keySentences} onChange={onKeySentences}>
            {keyTerms ? layerStrings.keys : "标出关键句"}
          </Switch>
          {sources !== null ? (
            <Switch isSelected={sources} onChange={onSources}>
              显示核对依据
            </Switch>
          ) : null}
        </div>
      </Dialog>
    </AriaPopover>
  );
}
