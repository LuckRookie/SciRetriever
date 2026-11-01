import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { LibraryQuery } from "@sciretriever/contracts";
import { Button } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { readLibraryFacets } from "../../data/intake-batches.js";

type TermField = "keywords" | "subject_terms";
const ROWS: readonly { field: TermField; label: string }[] = [
  { field: "keywords", label: "作者关键词" },
  { field: "subject_terms", label: "主题词" },
];
const SHORT = 8,
  LONG = 30;

/** The commonest terms in the current results; picking one narrows the filter. */
export function ScopeTerms({
  query,
  onPick,
}: {
  query: LibraryQuery;
  onPick: (field: TermField, value: string) => void;
}) {
  const api = useApi();
  const [more, setMore] = useState(false);
  const facets = useQuery({
    queryKey: ["library", "facets", query],
    queryFn: ({ signal }) => readLibraryFacets(api, query, LONG, signal),
    placeholderData: keepPreviousData,
  });
  const data = facets.data;
  if (!data || (!data.keywords.length && !data.subject_terms.length))
    return null;
  const picked = (field: TermField, value: string) =>
    query[field].some((v) => v.toLowerCase() === value.toLowerCase());
  const longer = ROWS.some(({ field }) => data[field].length > SHORT);
  return (
    <section
      className="scope-terms"
      aria-label="范围内的词"
      data-stale={facets.isPlaceholderData || undefined}
    >
      {ROWS.map(({ field, label }) =>
        data[field].length ? (
          <div key={field} className="scope-terms-row">
            <span className="scope-terms-label">{label}</span>
            <span className="scope-terms-values">
              {data[field].slice(0, more ? LONG : SHORT).map((term) => (
                <Button
                  key={term.value}
                  variant="text"
                  size="compact"
                  className="scope-term"
                  aria-pressed={picked(field, term.value)}
                  aria-label={`${label} ${term.value}，${term.count} 篇`}
                  onPress={() => onPick(field, term.value)}
                >
                  {term.value}
                  <span className="scope-term-count">
                    {term.count.toLocaleString()}
                  </span>
                </Button>
              ))}
            </span>
          </div>
        ) : null,
      )}
      {longer ? (
        <Button
          variant="text"
          size="compact"
          className="scope-terms-more"
          onPress={() => setMore(!more)}
        >
          {more ? "收起" : "更多"}
        </Button>
      ) : null}
    </section>
  );
}
