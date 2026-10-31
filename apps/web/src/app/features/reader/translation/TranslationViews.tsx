import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { TRANSLATION_LANGUAGES } from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  Icon,
  Select,
  TextArea,
} from "../../../components/index.js";
import { copyText } from "../../../../browser-platform.js";
import { useAnchored } from "../marks/MarkOverlays.js";
import type { ReaderTranslation, TranslationEntry } from "./use-translation.js";
import "./translation.css";

const languageLabel = (code: string) =>
  TRANSLATION_LANGUAGES.find((l) => l.code === code)?.label ?? code;
/** provider/model shows as the model name; the provider stays in the tooltip. */
const modelName = (reference: string) =>
  reference.slice(reference.indexOf("/") + 1);

function copy(text: string, what: string, notify: (message: string) => void) {
  if (!text.trim()) return notify(`没有可复制的${what}`);
  void copyText(text)
    .then(() => notify(`已复制${what}`))
    .catch(() => notify("浏览器未允许写入剪贴板。"));
}
function Meta({ entry }: { entry: TranslationEntry }) {
  if (!entry.result) return null;
  return (
    <span className="translation-meta" title={entry.result.model}>
      {modelName(entry.result.model)}
      {entry.result.cached ? <span> · 已缓存</span> : null}
    </span>
  );
}
function Result({ entry }: { entry: TranslationEntry }) {
  return entry.status === "loading" ? (
    <p className="translation-loading">
      <span className="translation-spinner" aria-hidden="true" />
      翻译中…
    </p>
  ) : entry.status === "error" ? (
    <p className="translation-error">{entry.error}</p>
  ) : (
    <p className="translation-text">{entry.result!.translation}</p>
  );
}

/**
 * The translation of the current selection. It opens under the selection; drag
 * its header to move it out of the way, and later translations open there too.
 */
export function TranslationPopover({
  translation,
  anchor,
  scroller,
  notify,
}: {
  translation: ReaderTranslation;
  anchor: () => DOMRect | null;
  scroller: HTMLElement | null;
  notify: (message: string) => void;
}) {
  const entry = translation.current;
  const card = useRef<HTMLDivElement>(null);
  const width = Math.min(420, innerWidth - 24);
  const anchored = useAnchored(
    anchor,
    scroller,
    { width, height: 180 },
    "below",
  );
  const { popupAt, setPopupAt } = translation;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const place = popupAt ?? anchored;
  const start = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const box = card.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
    };
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current,
      box = card.current?.getBoundingClientRect();
    if (!d || !box) return;
    setPopupAt({
      left: Math.max(
        8,
        Math.min(innerWidth - box.width - 8, event.clientX - d.dx),
      ),
      top: Math.max(
        8,
        Math.min(innerHeight - box.height - 8, event.clientY - d.dy),
      ),
    });
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  if (!entry) return null;
  return createPortal(
    <div
      ref={card}
      className="translation-popover"
      role="dialog"
      aria-label="划词翻译"
      data-shown={!!place || undefined}
      data-dragging={dragging || undefined}
      data-moved={!!popupAt || undefined}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999 }}
      // Pressing here must keep the selection it translates.
      onPointerDown={(event) => event.preventDefault()}
    >
      <header
        className="translation-handle"
        title="拖动可移开"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span className="translation-grip" aria-hidden="true" />
        <span className="translation-language">
          {languageLabel(translation.settings.language)}
        </span>
        <Meta entry={entry} />
        <button
          type="button"
          className="translation-close"
          aria-label="关闭翻译"
          onClick={translation.close}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="translation-body" aria-live="polite">
        <Result entry={entry} />
      </div>
      {entry.status !== "loading" ? (
        <footer>
          {entry.result ? (
            <button
              type="button"
              onClick={() => copy(entry.result!.translation, "译文", notify)}
            >
              <Icon name="copy" />
              复制
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              void translation.translate(entry.text, entry.page, true)
            }
          >
            <Icon name="refresh" />
            {entry.status === "error" ? "重试" : "重新翻译"}
          </button>
        </footer>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * The 翻译 tab beside 信息 and 批注: the source and its translation one above
 * the other, as in a translation side pane, with the selection options below.
 */
export function TranslationPanel({
  translation,
  notify,
}: {
  translation: ReaderTranslation;
  notify: (message: string) => void;
}) {
  const { settings, setSettings, catalog, model, current, source, load } =
    translation;
  useEffect(load, [load]);
  const result = current && current.text === source.trim() ? current : null;
  const output = result?.result?.translation ?? "";
  return (
    <div className="translation-panel">
      <div className="translation-bar">
        <Select
          label="模型"
          value={model ?? ""}
          placeholder={catalog ? "没有可用的模型" : "正在读取模型…"}
          isDisabled={!catalog?.models.length}
          {...(catalog && !catalog.models.length
            ? { description: "先在设置中登记模型，重启服务后可选。" }
            : {})}
          onChange={(value) => setSettings({ model: value })}
          options={(catalog?.models ?? []).map((reference) => ({
            value: reference,
            label:
              reference === catalog?.default_model
                ? `${modelName(reference)}（默认）`
                : modelName(reference),
          }))}
        />
        <Select
          label="译成"
          value={settings.language}
          onChange={(value) =>
            setSettings({ language: value as typeof settings.language })
          }
          options={TRANSLATION_LANGUAGES.map((l) => ({
            value: l.code,
            label: l.label,
          }))}
        />
      </div>
      <div className="translation-source">
        <TextArea
          label="原文"
          width="full"
          value={source}
          rows={6}
          maxLength={catalog?.max_chars ?? 4000}
          placeholder="在正文里选中文字，或在这里粘贴要翻译的内容"
          onChange={translation.setSource}
        />
        <Button
          variant="primary"
          isDisabled={!source.trim() || result?.status === "loading"}
          onPress={() => {
            // A translation asked for here shows here, not in the selection card.
            translation.dismiss();
            void translation.translate(source, null, !!result);
          }}
        >
          {result ? "重新翻译" : "翻译"}
        </Button>
      </div>
      <section
        className="translation-output"
        aria-label="译文"
        aria-live="polite"
      >
        {result ? (
          <>
            <Result entry={result} />
            <Meta entry={result} />
          </>
        ) : (
          <p className="translation-placeholder">译文会显示在这里。</p>
        )}
      </section>
      <div className="translation-options">
        <Checkbox
          isSelected={settings.auto}
          onChange={(auto) => setSettings({ auto })}
        >
          选中文字后自动翻译
        </Checkbox>
        <Checkbox
          isSelected={settings.popup}
          onChange={(popup) => setSettings({ popup })}
        >
          在选区旁显示划词翻译
        </Checkbox>
        <p className="ui-description">
          只在用选择工具选中文字时翻译，高亮笔不翻译。同一句话再次翻译直接取缓存。
        </p>
      </div>
      <div className="translation-copy" role="group" aria-label="复制">
        <span>复制</span>
        <Button onPress={() => copy(source, "原文", notify)}>原文</Button>
        <Button onPress={() => copy(output, "译文", notify)}>译文</Button>
        <Button
          onPress={() =>
            copy(
              output ? `${source.trim()}\n\n${output}` : "",
              "原文和译文",
              notify,
            )
          }
        >
          两者
        </Button>
      </div>
    </div>
  );
}
