import { useEffect, type RefObject } from "react";
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

/**
 * “排版” (plan 25 block 30): the reading size or zoom, the line length and
 * spacing of the full text, the theme in place, and two switches. It opens
 * from its button in the top bar, or from “更多” where the bar folds it in.
 */
export function ReaderTypePanel({
  triggerRef,
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
  onKeySentences,
  sources,
  onSources,
}: {
  triggerRef: RefObject<Element | null>;
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
  onKeySentences: (value: boolean) => void;
  /** “显示核对依据”: null where there is nothing to check (outside the full text). */
  sources: boolean | null;
  onSources: (value: boolean) => void;
}) {
  // Esc closes it wherever the focus is: a step at the end of the scale is
  // disabled and lets go of the focus (as the shared Popover does).
  useEffect(() => {
    if (!isOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [isOpen, onOpenChange]);
  return (
    <AriaPopover
      className="ui-popover reader-type-popover"
      placement="bottom end"
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
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
            标出关键句
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
