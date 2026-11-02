import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { LibraryFacets, LibraryQuery } from "@sciretriever/contracts";
import { Button, Icon } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { readLibraryFacets } from "../../data/intake-batches.js";

type TermField = "keywords" | "subject_terms";
type Layer = "tags" | TermField;
const LABELS: Record<Layer, string> = {
  tags: "标签",
  keywords: "作者关键词",
  subject_terms: "主题词",
};
const SHORT = 8,
  LONG = 30;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const has = (values: readonly string[], value: string) =>
  values.some((v) => same(v, value));
function toggle(values: readonly string[], value: string) {
  return has(values, value)
    ? values.filter((v) => !same(v, value))
    : [...values, value];
}
function withTags(query: LibraryQuery, ids: readonly string[]): LibraryQuery {
  return { ...query, tags: { ids, mode: query.tags?.mode ?? "any" } };
}

/**
 * The commonest terms in the current results, tags first; picking one narrows
 * the filter. Each layer states how many results it covers, since a layer's
 * counts only compare within that layer.
 */
export function ScopeTerms({
  query,
  onChange,
}: {
  query: LibraryQuery;
  onChange: (query: LibraryQuery) => void;
}) {
  const api = useApi();
  const [more, setMore] = useState(false),
    [subjects, setSubjects] = useState(false);
  const facets = useQuery({
    queryKey: ["library", "facets", query],
    queryFn: ({ signal }) => readLibraryFacets(api, query, LONG, signal),
    placeholderData: keepPreviousData,
  });
  const data = facets.data;
  if (
    !data ||
    (!data.tags.length && !data.keywords.length && !data.subject_terms.length)
  )
    return null;
  const tagIds = query.tags?.ids ?? [];
  // Once most results carry tags, the source's subjects step back.
  const folded =
    data.coverage.tags > 0 &&
    data.coverage.tags * 2 >= data.total &&
    !subjects &&
    !query.subject_terms.length;
  const shown = more ? LONG : SHORT;
  const longer = (["tags", "keywords", "subject_terms"] as const).some(
    (layer) =>
      data[layer].length > SHORT && !(layer === "subject_terms" && folded),
  );
  // A picked keyword that names a tag can be swapped for the tag itself.
  const swaps = data.keywords.filter(
    (k) =>
      k.tag && has(query.keywords, k.value) && !tagIds.includes(k.tag.tag_id),
  );
  return (
    <section
      className="scope-terms"
      aria-label="范围内的词"
      data-stale={facets.isPlaceholderData || undefined}
    >
      {data.tags.length ? (
        <Row layer="tags" data={data}>
          {data.tags.slice(0, shown).map((tag) => (
            <Term
              key={tag.tag_id}
              layer="tags"
              value={tag.value}
              count={tag.count}
              pressed={tagIds.includes(tag.tag_id)}
              onPress={() =>
                onChange(
                  withTags(
                    query,
                    tagIds.includes(tag.tag_id)
                      ? tagIds.filter((id) => id !== tag.tag_id)
                      : [...tagIds, tag.tag_id],
                  ),
                )
              }
            />
          ))}
        </Row>
      ) : null}
      {data.keywords.length ? (
        <Row layer="keywords" data={data}>
          {data.keywords.slice(0, shown).map((term) => (
            <Term
              key={term.value}
              layer="keywords"
              value={term.value}
              count={term.count}
              tag={term.tag?.name ?? null}
              pressed={has(query.keywords, term.value)}
              onPress={() =>
                onChange({
                  ...query,
                  keywords: toggle(query.keywords, term.value),
                })
              }
            />
          ))}
        </Row>
      ) : null}
      {data.subject_terms.length ? (
        <Row layer="subject_terms" data={data}>
          {folded ? (
            <Button
              variant="text"
              size="compact"
              className="scope-terms-unfold"
              onPress={() => setSubjects(true)}
            >
              展开
            </Button>
          ) : (
            data.subject_terms.slice(0, shown).map((term) => (
              <Term
                key={term.value}
                layer="subject_terms"
                value={term.value}
                count={term.count}
                pressed={has(query.subject_terms, term.value)}
                onPress={() =>
                  onChange({
                    ...query,
                    subject_terms: toggle(query.subject_terms, term.value),
                  })
                }
              />
            ))
          )}
        </Row>
      ) : null}
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
      {swaps.map((k) => (
        <p key={k.value} className="scope-terms-hint">
          “{k.value}”对应标签“{k.tag!.name}”
          <Button
            variant="text"
            size="compact"
            onPress={() =>
              onChange(
                withTags(
                  {
                    ...query,
                    keywords: query.keywords.filter((v) => !same(v, k.value)),
                  },
                  [...tagIds, k.tag!.tag_id],
                ),
              )
            }
          >
            改用标签筛选
          </Button>
        </p>
      ))}
    </section>
  );
}

function Row({
  layer,
  data,
  children,
}: {
  layer: Layer;
  data: LibraryFacets;
  children: ReactNode;
}) {
  return (
    <div className="scope-terms-row" data-layer={layer}>
      <span className="scope-terms-label">
        {LABELS[layer]}
        <span
          className="scope-terms-coverage"
          title={`当前结果 ${data.total.toLocaleString()} 篇中，${data.coverage[layer].toLocaleString()} 篇有${LABELS[layer]}`}
        >
          {data.coverage[layer].toLocaleString()} /{" "}
          {data.total.toLocaleString()} 篇
        </span>
      </span>
      <span className="scope-terms-values">{children}</span>
    </div>
  );
}

function Term({
  layer,
  value,
  count,
  tag = null,
  pressed,
  onPress,
}: {
  layer: Layer;
  value: string;
  count: number;
  tag?: string | null;
  pressed: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant="text"
      size="compact"
      className="scope-term"
      aria-pressed={pressed}
      aria-label={`${LABELS[layer]} ${value}，${count} 篇${tag ? `，对应标签 ${tag}` : ""}`}
      onPress={onPress}
    >
      {value}
      {tag ? <Icon name="tag" className="scope-term-tag" /> : null}
      <span className="scope-term-count">{count.toLocaleString()}</span>
    </Button>
  );
}
