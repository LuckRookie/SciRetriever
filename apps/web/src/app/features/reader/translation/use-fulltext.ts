import { useCallback, useEffect, useRef, useState } from "react";
import type { FullTextPage, FullTextSummary } from "@sciretriever/contracts";
import { ApiError } from "../../../data/api.js";
import { useApi } from "../../../data/query.js";
import { record } from "../../../data/wire.js";
import type { FullTextMode } from "./fulltext-layer.js";
import type { ReaderTranslation } from "./use-translation.js";

/** Pages asked for at the same time (ADR 0051 §4). */
const PARALLEL = 3;
export interface FullTextProgress {
  readonly total: number;
  readonly done: number;
  readonly failed: readonly number[];
  readonly running: boolean;
}
function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "translation-not-archived")
      return "这篇文献还没有建档，建档后才能翻译全文。";
    if (error.code === "translation-model-unavailable")
      return "所选模型不可用：在翻译页换一个模型，或登记模型后重启服务。";
    if (error.code === "translation-unavailable")
      return "当前服务没有开启翻译。";
  }
  return "全文翻译没有完成，可以重试。";
}

/**
 * Full-text translation in the PDF view (ADR 0051): the view mode, the
 * translated pages by index, and a run that asks page by page, at most three
 * at once, showing each page as it comes back.
 */
export function useFullTextTranslation(
  literatureId: string,
  translation: ReaderTranslation,
  notify: (message: string) => void,
) {
  const api = useApi();
  const [mode, setMode] = useState<FullTextMode>("off");
  const [pages, setPages] = useState<ReadonlyMap<number, FullTextPage>>(
    () => new Map(),
  );
  const [progress, setProgress] = useState<FullTextProgress | null>(null);
  const [confirm, setConfirm] = useState<FullTextSummary | null>(null);
  const abort = useRef<AbortController | null>(null);
  const latest = useRef(translation);
  latest.current = translation;
  useEffect(() => {
    abort.current?.abort();
    setMode("off");
    setPages(new Map());
    setProgress(null);
    setConfirm(null);
  }, [literatureId]);
  useEffect(() => () => abort.current?.abort(), []);

  const request = useCallback(
    async (page: number, force: boolean, signal: AbortSignal) => {
      const value = await api.request(
        "/api/translation/fulltext/page",
        {
          literature_id: literatureId,
          page_index: page,
          target_language: latest.current.settings.language,
          model: latest.current.model,
          force,
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
    async (indexes: readonly number[], force = false) => {
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
              await request(page, force, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) return;
              failed.push(page);
              if (!failed.slice(0, -1).length) notify(message(error));
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
  /** Turn the view on; ask first when pages still need the model. */
  const open = useCallback(async () => {
    latest.current.load();
    setMode((m) => (m === "off" ? "pair" : m));
    try {
      const value = await api.read(
        `/api/translation/fulltext?literature_id=${encodeURIComponent(literatureId)}&target_language=${encodeURIComponent(latest.current.settings.language)}`,
      );
      const summary = record(
        value.summary,
        "summary",
      ) as unknown as FullTextSummary;
      const pending = summary.pages.filter((p) => !p.saved).length;
      if (pending) setConfirm(summary);
      else
        void run(
          summary.pages.filter((p) => p.blocks).map((p) => p.page_index),
        );
    } catch (error) {
      notify(message(error));
      setMode("off");
    }
  }, [api, literatureId, notify, run]);
  const start = useCallback(() => {
    const summary = confirm;
    setConfirm(null);
    if (summary)
      void run(summary.pages.filter((p) => p.blocks).map((p) => p.page_index));
  }, [confirm, run]);
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
    confirm,
    open,
    start,
    dismissConfirm: () => {
      setConfirm(null);
      setMode("off");
    },
    close,
    cancel,
    retry: (indexes: readonly number[]) => void run(indexes),
  };
}
export type ReaderFullText = ReturnType<typeof useFullTextTranslation>;
