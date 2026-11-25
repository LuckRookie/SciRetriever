import { useId, useState } from "react";
import { Menu, SegmentedControl } from "../../../components/index.js";
import type { DocumentTextMode } from "../../../../reading/contract.js";
import { fullTextStrings as t } from "../../../strings.js";
import "./translation.css";

const MODES: readonly DocumentTextMode[] = [
  "original",
  "translation",
  "bilingual",
];

/**
 * The full text's three readings (reading-experience 9), right of the view
 * switch and styled as it is. Without a translation only 原文 can be chosen;
 * the other two are disabled and, under the pointer, say why.
 */
export function TextModeControl({
  value,
  reason,
  pending,
  narrow,
  onChange,
}: {
  value: DocumentTextMode;
  /** Why 译文 and 对照 cannot be chosen; null when they can. */
  reason: string | null;
  /** Whether this paper has a translation is still being read. */
  pending: boolean;
  /** The top bar is narrower than 640 px: one button with the others in its menu. */
  narrow: boolean;
  onChange: (mode: DocumentTextMode) => void;
}) {
  const tipId = useId();
  const [tip, setTip] = useState(false);
  const disabled = (mode: DocumentTextMode) =>
    mode !== "original" && (!!reason || pending);
  if (narrow)
    return (
      <Menu
        label={`${t.readings}：${t.reading[value]}`}
        variant="text"
        indicator
        className="reader-text-mode-menu"
        items={MODES.filter((mode) => mode !== value).map((mode) => ({
          id: mode,
          label: t.reading[mode],
          disabled: disabled(mode),
          ...(disabled(mode) && reason ? { description: reason } : {}),
          onAction: () => onChange(mode),
        }))}
      />
    );
  return (
    <div
      className="reader-text-mode"
      {...(reason ? { "aria-describedby": tipId } : {})}
      // The reason shows under a disabled reading, as a hint does.
      onPointerOver={(event) =>
        setTip(
          !!reason &&
            !!(event.target as Element).closest(".ui-tab[data-disabled]"),
        )
      }
      onPointerLeave={() => setTip(false)}
    >
      <SegmentedControl
        label={t.readings}
        value={value}
        onChange={(mode) => onChange(mode as DocumentTextMode)}
        items={MODES.map((mode) => ({
          id: mode,
          label: t.reading[mode],
          disabled: disabled(mode),
        }))}
      />
      {reason ? (
        <span
          id={tipId}
          role="tooltip"
          className="reader-text-mode-tip"
          data-shown={tip || undefined}
        >
          {reason}
        </span>
      ) : null}
    </div>
  );
}
