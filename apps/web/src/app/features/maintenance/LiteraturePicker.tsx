import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, RichTitle, SearchField } from "../../components/index.js";
import {
  emptyQuery,
  literatureChoice,
  readLiterature,
  searchLibrary,
  type LiteratureChoice,
} from "../../data/library.js";
import { useApi } from "../../data/query.js";
import { errorMessage } from "../../strings.js";

const LIMIT = 8;
const LITERATURE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The title on its own line, then “第一作者 · 年份” under it. */
export function ChoiceText({ choice }: { choice: LiteratureChoice }) {
  return (
    <>
      <span className="literature-picker-title">
        <RichTitle parts={choice.title} />
      </span>
      <span className="literature-picker-citation">
        {choice.author} · {choice.year ?? "年份未提供"}
      </span>
    </>
  );
}

/**
 * Searches the library by title or authors and lists the first eight papers,
 * instead of asking for a machine number (design core rule 8). A pasted
 * literature number still finds its paper, for people who carry one from the
 * CLI. ↓ from the search box moves into the results, ↑ and ↓ move between
 * them, Enter or Space picks one.
 *
 * Papers in `chosen` are marked as chosen; picking one again is left to the
 * caller (a list of many keeps each paper once).
 */
export function LiteratureSearch({
  label = "文献",
  onPick,
  chosen,
  isDisabled = false,
}: {
  label?: string;
  onPick: (choice: LiteratureChoice) => void;
  chosen?: ReadonlySet<string>;
  isDisabled?: boolean;
}) {
  const api = useApi(),
    list = useId();
  const [text, setText] = useState(""),
    [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ["library", "picker", term],
    enabled: !!term,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }): Promise<LiteratureChoice[]> => {
      if (LITERATURE_ID.test(term)) {
        const detail = await readLiterature(api, term.toLowerCase(), signal);
        return [literatureChoice(detail)];
      }
      const page = await searchLibrary(
        api,
        { ...emptyQuery(), text: term },
        "relevance",
        null,
        signal,
        LIMIT,
      );
      return page.items.slice(0, LIMIT).map(literatureChoice);
    },
  });
  const items = term ? (results.data ?? []) : [];
  const options = (from: HTMLElement) =>
    [
      ...(from
        .closest(".literature-search")
        ?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
    ] as HTMLElement[];
  // ↓ from the search box goes to the first result.
  const intoResults = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowDown" ||
      !(event.target instanceof HTMLInputElement)
    )
      return;
    const first = options(event.currentTarget)[0];
    if (first) {
      event.preventDefault();
      first.focus();
    }
  };
  const move = (
    event: ReactKeyboardEvent<HTMLLIElement>,
    choice: LiteratureChoice,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isDisabled) onPick(choice);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const all = options(event.currentTarget),
      at = all.indexOf(event.currentTarget),
      next = all[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) next.focus();
    else if (event.key === "ArrowUp")
      event.currentTarget
        .closest(".literature-search")
        ?.querySelector<HTMLInputElement>("input")
        ?.focus();
  };
  return (
    <div className="literature-search">
      <div onKeyDown={intoResults}>
        <SearchField
          label={label}
          value={text}
          onChange={setText}
          placeholder="按标题、作者搜索文献库"
          isDisabled={isDisabled}
        />
      </div>
      {results.isError && term ? (
        <p className="ui-error-text" role="alert">
          {errorMessage(results.error)}
        </p>
      ) : term && results.isSuccess && !items.length ? (
        <p className="literature-picker-empty">文献库里没有找到这篇。</p>
      ) : null}
      {items.length ? (
        <ul
          id={list}
          role="listbox"
          aria-label="文献候选"
          {...(chosen ? { "aria-multiselectable": true } : {})}
          className="literature-picker-list"
        >
          {items.map((item) => {
            const picked = chosen?.has(item.id) ?? false;
            return (
              <li
                key={item.id}
                role="option"
                aria-selected={picked}
                aria-disabled={isDisabled || undefined}
                tabIndex={0}
                onClick={() => {
                  if (!isDisabled) onPick(item);
                }}
                onKeyDown={(event) => move(event, item)}
              >
                <ChoiceText choice={item} />
                {picked ? (
                  <span className="literature-picker-mark">已选</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Picks one paper from the library (`LiteratureSearch`), then shows it. */
export function LiteraturePicker({
  value,
  onChange,
  isDisabled = false,
}: {
  value: string;
  onChange: (id: string) => void;
  isDisabled?: boolean;
}) {
  const [chosen, setChosen] = useState<LiteratureChoice | null>(null);
  if (value)
    return (
      <div className="literature-picker" data-chosen="true">
        <p className="literature-picker-chosen">
          {chosen?.id === value ? (
            <ChoiceText choice={chosen} />
          ) : (
            <span className="literature-picker-title">已选择的文献</span>
          )}
        </p>
        <Button
          variant="text"
          size="compact"
          isDisabled={isDisabled}
          onPress={() => {
            setChosen(null);
            onChange("");
          }}
        >
          换一篇
        </Button>
      </div>
    );
  return (
    <div className="literature-picker">
      <LiteratureSearch
        isDisabled={isDisabled}
        onPick={(choice) => {
          setChosen(choice);
          onChange(choice.id);
        }}
      />
    </div>
  );
}
