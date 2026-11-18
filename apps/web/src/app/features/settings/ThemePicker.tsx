import { Radio, RadioGroup } from "react-aria-components";
import { Select } from "../../components/index.js";
import {
  THEMES,
  type Theme,
  type ThemeId,
  type ThemeTime,
} from "../../data/preferences.js";
import { useShell } from "../../shell/context.js";

const themeName = (id: ThemeId) => THEMES.find((t) => t.id === id)!.name;
const timeName: Readonly<Record<ThemeTime, string>> = {
  day: "白天",
  night: "夜里",
};

/**
 * A small picture of a theme (design core “主题”): its paper, side bar, one
 * literature line and a status badge, in the theme's own tokens.
 */
function Preview({ id, bare = false }: { id: ThemeId; bare?: boolean }) {
  return (
    <span className="theme-preview" data-theme-preview={id} aria-hidden="true">
      <span className="theme-preview-side">
        <i data-brand="" />
        <i />
        <i />
      </span>
      <span className="theme-preview-main">
        {bare ? (
          <>
            <i data-line="title" />
            <i data-line="meta" />
            <i data-line="badge" />
          </>
        ) : (
          <>
            <span className="theme-preview-title">文献</span>
            <i data-line="meta" />
            <span className="theme-preview-badge">已就绪</span>
          </>
        )}
      </span>
    </span>
  );
}

/**
 * “设置 → 外观”: one card per theme, “跟随系统” first; a click applies at
 * once.
 */
export function ThemePicker() {
  const shell = useShell(),
    { themes } = shell;
  return (
    <RadioGroup
      aria-label="主题"
      className="theme-cards"
      orientation="horizontal"
      value={themes.theme}
      onChange={(value) => shell.setTheme(value as Theme)}
    >
      <Radio value="system" className="theme-card" aria-label="跟随系统">
        <span className="theme-preview-pair">
          <Preview id={themes.day} bare />
          <Preview id={themes.night} bare />
        </span>
        <span className="theme-card-name">跟随系统</span>
        <span className="theme-card-time">
          {themeName(themes.day)} / {themeName(themes.night)}
        </span>
      </Radio>
      {THEMES.map((theme) => (
        <Radio
          key={theme.id}
          value={theme.id}
          className="theme-card"
          aria-label={theme.name}
        >
          <Preview id={theme.id} />
          <span className="theme-card-name">{theme.name}</span>
          <span className="theme-card-time">{timeName[theme.time]}</span>
        </Radio>
      ))}
    </RadioGroup>
  );
}

/**
 * Following the system uses the day theme in light mode and the night theme
 * in dark mode; each is chosen separately, from all seven.
 */
export function ThemeTimeSelect({ time }: { time: ThemeTime }) {
  const shell = useShell();
  return (
    <Select
      label={`${timeName[time]}用的主题`}
      value={shell.themes[time]}
      onChange={(value) => shell.setThemeTime(time, value as ThemeId)}
      options={THEMES.map((t) => ({ value: t.id, label: t.name }))}
    />
  );
}
