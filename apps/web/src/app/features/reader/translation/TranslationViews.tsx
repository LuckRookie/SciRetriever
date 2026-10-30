import { useEffect } from "react";
import { createPortal } from "react-dom";
import { TRANSLATION_LANGUAGES } from "@sciretriever/contracts";
import {
  Button,
  EmptyState,
  Icon,
  Select,
  Switch,
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

function copy(text: string, notify: (message: string) => void) {
  void copyText(text)
    .then(() => notify("已复制译文"))
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

/** The translation of the current selection, under it; the mark bar sits above. */
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
  const place = useAnchored(
    anchor,
    scroller,
    { width: Math.min(420, innerWidth - 24), height: 180 },
    "below",
  );
  if (!entry) return null;
  return createPortal(
    <div
      className="translation-popover"
      role="status"
      aria-live="polite"
      aria-label="划词翻译"
      data-shown={!!place || undefined}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999 }}
      // Pressing here must keep the selection it translates.
      onPointerDown={(event) => event.preventDefault()}
    >
      <header>
        <span className="translation-language">
          {languageLabel(translation.settings.language)}
        </span>
        <Meta entry={entry} />
        <button
          type="button"
          className="translation-close"
          aria-label="关闭翻译"
          onClick={translation.dismiss}
        >
          <Icon name="close" />
        </button>
      </header>
      {entry.status === "loading" ? (
        <p className="translation-loading">翻译中…</p>
      ) : entry.status === "error" ? (
        <p className="translation-error">{entry.error}</p>
      ) : (
        <p className="translation-text">{entry.result!.translation}</p>
      )}
      {entry.status !== "loading" ? (
        <footer>
          {entry.result ? (
            <button
              type="button"
              onClick={() => copy(entry.result!.translation, notify)}
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

/** The 翻译 tab beside 信息 and 批注: settings first, then this paper's recent translations. */
export function TranslationPanel({
  translation,
  notify,
  onPage,
}: {
  translation: ReaderTranslation;
  notify: (message: string) => void;
  onPage?: (page: number) => void;
}) {
  const { settings, setSettings, catalog, model, recent, load } = translation;
  useEffect(load, [load]);
  return (
    <div className="translation-panel">
      <div className="translation-settings">
        <Select
          label="模型"
          value={model ?? ""}
          placeholder={catalog ? "没有可用的模型" : "正在读取模型…"}
          isDisabled={!catalog?.models.length}
          {...(catalog && !catalog.models.length
            ? { description: "先在设置中登记模型，重启服务后可选。" }
            : model
              ? { description: model }
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
        <Switch
          isSelected={settings.popup}
          onChange={(popup) => setSettings({ popup })}
        >
          划词翻译
        </Switch>
        <p className="ui-description">
          {settings.popup
            ? "用选择工具选中文字，旁边会出现译文；用高亮笔时不翻译。"
            : "选中文字后，点工具条上的“翻译”。"}
          同一句话第二次翻译直接取缓存，不再调用模型。
        </p>
      </div>
      <h3 className="translation-heading">最近的翻译</h3>
      {recent.length ? (
        <ol className="translation-list">
          {recent.map((entry) => (
            <li key={entry.text}>
              <p className="translation-source">{entry.text}</p>
              <p className="translation-text">{entry.result?.translation}</p>
              <div className="translation-row">
                <Meta entry={entry} />
                <span>
                  {entry.page && onPage ? (
                    <Button variant="text" onPress={() => onPage(entry.page!)}>
                      第 {entry.page} 页
                    </Button>
                  ) : null}
                  <Button
                    variant="text"
                    onPress={() =>
                      copy(entry.result?.translation ?? "", notify)
                    }
                  >
                    复制
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState
          title="还没有翻译"
          description="在正文里选中一段文字即可翻译。"
        />
      )}
    </div>
  );
}
