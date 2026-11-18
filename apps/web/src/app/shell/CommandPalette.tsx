import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Dialog as AriaDialog,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import type { LiteratureSearchItem } from "@sciretriever/contracts";
import { AnimatedPanel } from "../motion/index.js";
import { RichTitle, literatureTone } from "../components/index.js";
import { useApi } from "../data/query.js";
import { navigate } from "../data/url.js";
import {
  emptyQuery,
  paperAuthors,
  paperTitle,
  paperTitleParts,
  searchLibrary,
} from "../data/library.js";
import { statusLabels } from "../strings.js";
import { useShell } from "./context.js";
import { Icon } from "./icon.js";

const LIMIT = 8;

/** ⌘K: find a paper by title, author or journal and open it, without leaving the page. */
export function CommandPalette({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModalOverlay
      className="ui-overlay command-overlay"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
    >
      <Modal className="command-modal">
        <AriaDialog className="command-dialog" aria-label="搜索文献">
          <AnimatedPanel preset="dialog">
            <Palette onClose={() => onOpenChange(false)} />
          </AnimatedPanel>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const api = useApi(),
    shell = useShell(),
    list = useId();
  const [text, setText] = useState(""),
    [term, setTerm] = useState(""),
    [active, setActive] = useState(0);
  // Search after a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), 150);
    return () => clearTimeout(timer);
  }, [text]);
  // Starting a search aborts the previous one if it is still in flight.
  const pending = useRef<AbortController | null>(null);
  const results = useQuery({
    queryKey: ["library", "palette", term],
    queryFn: ({ signal }) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      signal.addEventListener("abort", () => controller.abort());
      return searchLibrary(
        api,
        term
          ? { ...emptyQuery(), text: term }
          : { ...emptyQuery(), recently_opened: true },
        term ? "relevance" : "opened-desc",
        null,
        controller.signal,
        LIMIT,
      );
    },
    retry: false,
    placeholderData: keepPreviousData,
    enabled: api.workspace.readiness === "ready",
  });
  const items = results.data?.items.slice(0, LIMIT) ?? [];
  useEffect(() => setActive(0), [term]);
  const open = (item: LiteratureSearchItem) => {
    // The reader picks the view (spec 6.4).
    shell.openPaper(
      item.literature.literature_id,
      undefined,
      undefined,
      paperTitle(item),
    );
    onClose();
  };
  const showAll = () => {
    navigate(
      {
        view: "lib",
        literature: null,
        query: JSON.stringify({ ...emptyQuery(), text: text.trim() || null }),
      },
      { clearSource: true },
    );
    onClose();
  };
  const selected = items[Math.min(active, items.length - 1)];
  return (
    <div className="command-palette">
      <div className="command-input">
        <Icon name="search" />
        <input
          autoFocus
          type="search"
          role="combobox"
          aria-label="搜索文献"
          aria-expanded={items.length > 0}
          aria-controls={list}
          aria-activedescendant={
            selected
              ? `${list}-${selected.literature.literature_id}`
              : undefined
          }
          aria-autocomplete="list"
          placeholder="搜索标题、作者、期刊"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!items.length) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                (index) => (index + step + items.length) % items.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (event.metaKey || event.ctrlKey || !selected) showAll();
              else open(selected);
            }
          }}
        />
      </div>
      <p className="command-heading" aria-live="polite">
        {term ? null : "最近阅读"}
      </p>
      <ul id={list} role="listbox" aria-label="文献" className="command-list">
        {items.map((item, index) => (
          <li
            key={item.literature.literature_id}
            id={`${list}-${item.literature.literature_id}`}
            role="option"
            aria-selected={index === active}
            onPointerMove={() => setActive(index)}
            onClick={() => open(item)}
          >
            <span className="command-title">
              <RichTitle parts={paperTitleParts(item)} />
            </span>
            <span className="command-citation">
              {paperAuthors(item)} ·{" "}
              {item.literature.metadata.venue ?? "期刊未提供"} ·{" "}
              {item.literature.metadata.publication_year ?? "年份未提供"}
            </span>
            {item.literature.status === "UNREVIEWED" &&
            !item.needs_manual_pdf ? null : (
              <span
                className="paper-status"
                data-state={
                  item.needs_manual_pdf ? "UNAVAILABLE" : item.literature.status
                }
                data-tone={literatureTone(
                  item.needs_manual_pdf
                    ? "UNAVAILABLE"
                    : item.literature.status,
                )}
              >
                {item.needs_manual_pdf
                  ? statusLabels.UNAVAILABLE
                  : statusLabels[item.literature.status]}
              </span>
            )}
          </li>
        ))}
      </ul>
      {results.isError ? (
        <p className="command-empty" role="status">
          暂时无法搜索，请稍后重试。
        </p>
      ) : results.data && !items.length ? (
        <p className="command-empty" role="status">
          {term ? "没有找到匹配的文献。" : "还没有最近阅读的文献。"}
        </p>
      ) : null}
      <footer className="command-footer">
        <button type="button" onClick={showAll}>
          {term && results.data
            ? `在文献库中查看全部 ${results.data.total.toLocaleString()} 条`
            : "在文献库中查看全部"}
        </button>
        <span aria-hidden="true">
          <kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 打开 <kbd>⌘↵</kbd> 查看全部
        </span>
      </footer>
    </div>
  );
}
