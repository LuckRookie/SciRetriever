import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, RichTitle, SearchField } from "../../components/index.js";
import {
  emptyQuery,
  paperAuthors,
  paperTitleParts,
  readLiterature,
  searchLibrary,
} from "../../data/library.js";
import { useApi } from "../../data/query.js";
import { errorMessage } from "../../strings.js";

const LIMIT = 8;
const LITERATURE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
interface Choice {
  id: string;
  title: ReturnType<typeof paperTitleParts>;
  authors: string;
  year: number | null;
}

/**
 * Picks one paper from the library by searching its title or authors, instead
 * of asking for a machine number (design core rule 8). A pasted literature
 * number still finds its paper, for people who carry one from the CLI.
 */
export function LiteraturePicker({
  value,
  onChange,
  isDisabled = false,
}: {
  value: string;
  onChange: (id: string) => void;
  isDisabled?: boolean;
}) {
  const api = useApi(),
    list = useId();
  const [text, setText] = useState(""),
    [term, setTerm] = useState(""),
    [chosen, setChosen] = useState<Choice | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ["library", "picker", term],
    enabled: !!term && !value,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }): Promise<Choice[]> => {
      if (LITERATURE_ID.test(term)) {
        const detail = await readLiterature(api, term.toLowerCase(), signal);
        return [
          {
            id: detail.literature.literature_id,
            title: paperTitleParts(detail),
            authors: paperAuthors(detail),
            year: detail.literature.metadata.publication_year ?? null,
          },
        ];
      }
      const page = await searchLibrary(
        api,
        { ...emptyQuery(), text: term },
        "relevance",
        null,
        signal,
        LIMIT,
      );
      return page.items.slice(0, LIMIT).map((item) => ({
        id: item.literature.literature_id,
        title: paperTitleParts(item),
        authors: paperAuthors(item),
        year: item.literature.metadata.publication_year ?? null,
      }));
    },
  });
  const pick = (choice: Choice) => {
    setChosen(choice);
    onChange(choice.id);
  };
  if (value)
    return (
      <div className="literature-picker" data-chosen="true">
        <p className="literature-picker-chosen">
          <span className="literature-picker-title">
            {chosen?.id === value ? (
              <RichTitle parts={chosen.title} />
            ) : (
              "已选择的文献"
            )}
          </span>
          {chosen?.id === value ? (
            <span className="literature-picker-citation">
              {chosen.authors} · {chosen.year ?? "年份未提供"}
            </span>
          ) : null}
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
  const items = term ? (results.data ?? []) : [];
  return (
    <div className="literature-picker">
      <SearchField
        label="文献"
        value={text}
        onChange={setText}
        placeholder="按标题、作者搜索文献库"
        isDisabled={isDisabled}
      />
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
          className="literature-picker-list"
        >
          {items.map((item) => (
            <li
              key={item.id}
              role="option"
              aria-selected={false}
              tabIndex={0}
              onClick={() => pick(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  pick(item);
                }
              }}
            >
              <span className="literature-picker-title">
                <RichTitle parts={item.title} />
              </span>
              <span className="literature-picker-citation">
                {item.authors} · {item.year ?? "年份未提供"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
