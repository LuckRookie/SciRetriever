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
export interface TranslationSettings {
  /** A model from the catalog; null follows the service default. */
  readonly model: string | null;
  readonly language: TranslationLanguage;
  /** Kept from the earlier “选中文字后自动翻译”; a selection no longer translates by itself. */
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
/** What went wrong in the model call behind a failed translation. */
const FAILURES: Readonly<Record<string, string>> = {
  "agent-auth": "模型服务拒绝了 API key：在设置中检查这个模型的密钥。",
  "agent-credentials": "没有读到这个模型的 API key：在设置中填写后重试。",
  "agent-quota": "模型服务限流或额度已用完，稍后再试或检查账户余额。",
  "agent-request":
    "模型服务拒绝了这次请求：这个模型可能不支持结构化输出，换一个模型试试。",
  "agent-remote": "模型服务出错，稍后重试。",
  "agent-network": "连不上模型服务，请检查网络或服务地址。",
  "agent-timeout": "模型服务超时没有回应，稍后重试。",
  "agent-truncated": "译文超出模型的输出长度，请缩小选区。",
  "agent-refusal": "模型拒绝翻译这段文字。",
};
/** A failed model call by its reason; null when the error is something else. */
export function translationFailure(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== "translation-failed")
    return null;
  return (
    FAILURES[error.message] ??
    (error.message === error.code
      ? null
      : `模型的回复无法使用（${error.message}），可以重试或换一个模型。`)
  );
}
function message(error: unknown): string {
  const failure = translationFailure(error);
  if (failure) return failure;
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
  // Plan 25 block 30: the model list says whether translation is set up at
  // all, which decides whether “翻译” shows; read once a session.
  const [, setWanted] = useState(false);
  const catalog = useQuery({
    queryKey: ["translation-catalog"],
    enabled,
    staleTime: Infinity,
    // Not set up (503) or unreadable: “翻译” stays away, no retries.
    retry: false,
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
   * A selection in the reader fills the source box, and nothing more: a
   * translation shows only once “翻译” is pressed (plan 25 block 30).
   */
  const selected = useCallback((text: string) => {
    setSource(text.trim());
    // A card left open belongs to the selection before.
    setPopupOpen(false);
  }, []);
  /** “翻译” pressed on a selection: the card opens on it, “翻译中” at once. */
  const show = useCallback(
    (text: string, page: number | null) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setSource(trimmed);
      setPopupOpen(true);
      void run(trimmed, page);
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
  /**
   * Translation is set up: the service answers with at least one model. Null
   * while that is being read; false when it is not set up (503) or has no model.
   */
  const available = catalog.data
    ? catalog.data.models.length > 0
    : catalog.isError
      ? false
      : null;
  return {
    load,
    available,
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
    show,
    dismiss,
    close,
  };
}
export type ReaderTranslation = ReturnType<typeof useReaderTranslation>;
