import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FullTextPage,
  FullTextSummary,
  TranslationLanguage,
} from "@sciretriever/contracts";
import { ApiError } from "../../../data/api.js";
import { useApi } from "../../../data/query.js";
import { record } from "../../../data/wire.js";
import { translationUnavailable } from "../../../strings.js";
import type { FullTextMode } from "./fulltext-layer.js";

/** Pages asked for at the same time (ADR 0051 §4). */
const PARALLEL = 3;
export interface FullTextProgress {
  readonly total: number;
  readonly done: number;
  readonly failed: readonly number[];
  readonly running: boolean;
}
function message(error: unknown, language: string): string {
  if (error instanceof ApiError) {
    if (error.code === "translation-not-archived")
      return translationUnavailable("none", language)!;
    if (error.code === "translation-unavailable")
      return "当前服务没有开启翻译。";
  }
  return "译文没有读完，可以重试。";
}

/**
 * The PDF view's side-by-side translation (ADR 0051, 0068): the view mode,
 * the translated pages by index, and a read that asks page by page, at most
 * three at once, showing each page as it comes back. The pages carry the
 * library's stored translation; no model is asked, so nothing is confirmed
 * first and nothing is translated again.
 */
export function useFullTextTranslation(
  literatureId: string,
  /** The stored translation's language (the deployment's), as describe gave it. */
  language: TranslationLanguage,
  notify: (message: string) => void,
) {
  const api = useApi();
  const [mode, setMode] = useState<FullTextMode>("off");
  const [pages, setPages] = useState<ReadonlyMap<number, FullTextPage>>(
    () => new Map(),
  );
  const [progress, setProgress] = useState<FullTextProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  const latest = useRef(language);
  latest.current = language;
  useEffect(() => {
    abort.current?.abort();
    setMode("off");
    setPages(new Map());
    setProgress(null);
  }, [literatureId]);
  useEffect(() => () => abort.current?.abort(), []);

  const request = useCallback(
    async (page: number, signal: AbortSignal) => {
      const value = await api.request(
        "/api/translation/fulltext/page",
        {
          literature_id: literatureId,
          page_index: page,
          target_language: latest.current,
          model: null,
          force: false,
        },
        signal,
      );
      const result = record(value.page, "page") as unknown as FullTextPage;
      setPages((was) => new Map(was).set(page, result));
      return result;
    },
    [api, literatureId],
  );
  const run = useCallback(
    async (indexes: readonly number[]) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const queue = [...indexes],
        failed: number[] = [];
      let done = 0;
      setProgress({ total: indexes.length, done, failed, running: true });
      await Promise.all(
        Array.from({ length: PARALLEL }, async () => {
          while (queue.length && !controller.signal.aborted) {
            const page = queue.shift()!;
            try {
              await request(page, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) return;
              failed.push(page);
              if (!failed.slice(0, -1).length)
                notify(message(error, latest.current));
            }
            done++;
            setProgress({
              total: indexes.length,
              done,
              failed: [...failed].sort((a, b) => a - b),
              running: true,
            });
          }
        }),
      );
      if (abort.current === controller)
        setProgress((p) => (p ? { ...p, running: false } : p));
    },
    [notify, request],
  );
  /** Turns the view on and reads the pages that have text to translate. */
  const open = useCallback(async () => {
    setMode((m) => (m === "off" ? "pair" : m));
    try {
      const value = await api.read(
        `/api/translation/fulltext?literature_id=${encodeURIComponent(literatureId)}&target_language=${encodeURIComponent(latest.current)}`,
      );
      const summary = record(
        value.summary,
        "summary",
      ) as unknown as FullTextSummary;
      const missing =
        summary.state === undefined
          ? null
          : translationUnavailable(summary.state, latest.current);
      if (missing) {
        notify(missing);
        setMode("off");
        return;
      }
      void run(summary.pages.filter((p) => p.blocks).map((p) => p.page_index));
    } catch (error) {
      notify(message(error, latest.current));
      setMode("off");
    }
  }, [api, literatureId, notify, run]);
  const close = useCallback(() => {
    abort.current?.abort();
    setProgress((p) => (p ? { ...p, running: false } : p));
    setMode("off");
  }, []);
  const cancel = useCallback(() => {
    abort.current?.abort();
    setProgress((p) => (p ? { ...p, running: false } : p));
  }, []);
  return {
    mode,
    setMode,
    pages,
    progress,
    open,
    close,
    cancel,
    retry: (indexes: readonly number[]) => void run(indexes),
  };
}
export type ReaderFullText = ReturnType<typeof useFullTextTranslation>;
