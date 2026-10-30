import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TRANSLATION_DEFAULT_LANGUAGE,
  TRANSLATION_MAX_CHARS,
  isTranslationLanguage,
  type TranslationCatalog,
  type TranslationLanguage,
  type TranslationResult,
} from "@sciretriever/contracts";
import { ApiError } from "../../../data/api.js";
import { preferences } from "../../../data/preferences.js";
import { useApi } from "../../../data/query.js";
import { record } from "../../../data/wire.js";

const SETTINGS_KEY = "sciretriever:translation:v1";
/** How long a selection must rest before it is translated; the popup shows at once. */
const SETTLE_MS = 150;

export interface TranslationSettings {
  /** A model from the catalog; null follows the service default. */
  readonly model: string | null;
  readonly language: TranslationLanguage;
  /** Translate a selection as soon as it settles. */
  readonly auto: boolean;
  /** Show the translation in a floating card beside the selection. */
  readonly popup: boolean;
}
export interface TranslationEntry {
  readonly text: string;
  readonly page: number | null;
  readonly status: "loading" | "done" | "error";
  readonly result?: TranslationResult;
  readonly error?: string;
}
function readSettings(): TranslationSettings {
  try {
    const v = JSON.parse(preferences.read(SETTINGS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    return {
      model: typeof v.model === "string" ? v.model : null,
      language: isTranslationLanguage(v.language)
        ? v.language
        : TRANSLATION_DEFAULT_LANGUAGE,
      auto: v.auto !== false,
      popup: v.popup !== false,
    };
  } catch {
    return {
      model: null,
      language: TRANSLATION_DEFAULT_LANGUAGE,
      auto: true,
      popup: true,
    };
  }
}
function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "translation-model-unavailable")
      return "所选模型不可用：换一个模型，或在设置中登记模型后重启服务。";
    if (error.code === "translation-unavailable")
      return "当前服务没有开启翻译。";
    if (error.code === "invalid-command")
      return `选中的文字过长或为空，一次最多 ${TRANSLATION_MAX_CHARS} 字。`;
  }
  return "翻译没有完成，请重试。";
}
const parseResult = (value: unknown): TranslationResult => {
  const r = record(value, "translation");
  if (
    typeof r.translation !== "string" ||
    typeof r.model !== "string" ||
    !isTranslationLanguage(r.target_language) ||
    typeof r.cached !== "boolean"
  )
    throw new Error("翻译回执无效");
  return {
    translation: r.translation,
    model: r.model,
    target_language: r.target_language,
    cached: r.cached,
  };
};

/**
 * Reader translation (ADR 0049, 0050): browser-only settings, the source text
 * the panel compares with its translation, one request per settled selection,
 * and the floating card's visibility and dragged position.
 */
export function useReaderTranslation(literatureId: string, enabled: boolean) {
  const api = useApi();
  const [settings, setSettingsState] = useState(readSettings);
  // The model list is read when the 翻译 tab opens or a translation starts, not with every reader.
  const [wanted, setWanted] = useState(false);
  const catalog = useQuery({
    queryKey: ["translation-catalog"],
    enabled: enabled && wanted,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const value = record(
        (await api.read("/api/translation", signal)).catalog,
        "catalog",
      );
      return value as unknown as TranslationCatalog;
    },
  });
  const [current, setCurrent] = useState<TranslationEntry | null>(null);
  const [source, setSource] = useState("");
  const [popupOpen, setPopupOpen] = useState(false);
  /** Where the reader dragged the card; it stays there until the reader closes it. */
  const [popupAt, setPopupAt] = useState<{ left: number; top: number } | null>(
    null,
  );
  const pending = useRef<{ timer: number; abort: AbortController } | null>(
    null,
  );
  useEffect(() => {
    setCurrent(null);
    setSource("");
    setPopupOpen(false);
  }, [literatureId]);
  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.abort.abort();
      }
    },
    [],
  );
  const setSettings = useCallback((patch: Partial<TranslationSettings>) => {
    setSettingsState((was) => {
      const next = { ...was, ...patch };
      preferences.write(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const models = catalog.data?.models ?? [];
  const model =
    settings.model && models.includes(settings.model)
      ? settings.model
      : (catalog.data?.default_model ?? null);
  const latest = useRef({ settings, model });
  latest.current = { settings, model };

  /** Translate now; a newer request cancels the one still running. */
  const run = useCallback(
    async (text: string, page: number | null, force = false) => {
      const trimmed = text.trim();
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.abort.abort();
        pending.current = null;
      }
      if (!trimmed) return;
      setWanted(true);
      if ([...trimmed].length > TRANSLATION_MAX_CHARS) {
        setCurrent({
          text: trimmed,
          page,
          status: "error",
          error: `选中的文字超过 ${TRANSLATION_MAX_CHARS} 字，请缩小选区。`,
        });
        return;
      }
      const abort = new AbortController();
      pending.current = { timer: 0, abort };
      setCurrent({ text: trimmed, page, status: "loading" });
      try {
        const value = await api.request(
          "/api/translation",
          {
            text: trimmed,
            target_language: latest.current.settings.language,
            model: latest.current.model,
            force,
          },
          abort.signal,
        );
        const entry: TranslationEntry = {
          text: trimmed,
          page,
          status: "done",
          result: parseResult(value.result),
        };
        if (abort.signal.aborted) return;
        setCurrent(entry);
      } catch (error) {
        if (abort.signal.aborted) return;
        setCurrent({
          text: trimmed,
          page,
          status: "error",
          error: message(error),
        });
      } finally {
        if (pending.current?.abort === abort) pending.current = null;
      }
    },
    [api],
  );
  /**
   * A selection in the reader fills the source box; with auto on it is
   * translated after a short rest, and the card shows "翻译中" at once.
   */
  const selected = useCallback(
    (text: string, page: number | null) => {
      const trimmed = text.trim();
      setSource(trimmed);
      if (!latest.current.settings.auto || !trimmed) return;
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.abort.abort();
      }
      setCurrent({ text: trimmed, page, status: "loading" });
      setPopupOpen(true);
      const abort = new AbortController();
      pending.current = {
        abort,
        timer: window.setTimeout(() => void run(trimmed, page), SETTLE_MS),
      };
    },
    [run],
  );
  /** The card goes away; the panel keeps the source and its translation. */
  const dismiss = useCallback(() => setPopupOpen(false), []);
  /** The card's × also forgets where it was dragged. */
  const close = useCallback(() => {
    setPopupOpen(false);
    setPopupAt(null);
  }, []);
  const load = useCallback(() => setWanted(true), []);
  return {
    load,
    settings,
    setSettings,
    catalog: catalog.data ?? null,
    catalogError: catalog.error,
    model,
    current,
    source,
    setSource,
    popupOpen,
    popupAt,
    setPopupAt,
    translate: run,
    selected,
    dismiss,
    close,
  };
}
export type ReaderTranslation = ReturnType<typeof useReaderTranslation>;
